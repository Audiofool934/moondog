// The window's side of the listening room. It drives the same application and agent the
// terminal uses, with messages from the window instead of keystrokes: a turn streams back
// as text and activity, and Spotify's player state arrives whenever it may have changed.
// Several conversations can answer at once, each in its own slot; settings, sign-in,
// devices and imports go through the same services the terminal uses.
import { randomUUID } from "node:crypto";
import { LOCALES, normalizeLocale, screenTranslator } from "../src/i18n/index.mjs";
import { formatLocalResult } from "../src/surfaces/cli/format-output.mjs";
import { HistoryImportView } from "../src/surfaces/cli/history-import-view.mjs";
import { setAppleMusicStorefront } from "../src/integrations/apple-music/storefront.mjs";
import { shortConversationTitle } from "../src/memory/local-memory-store.mjs";
import { runtimeBehindSelection } from "../src/runtime/pi/runtime-selection.mjs";

// Every Spotify read counts against the listener's app quota, and a used-up quota blocks player reads
// for hours. The window's clock runs on its own between reads, so a showing window reads just after
// the song should end, and otherwise only often enough to notice a change made elsewhere, such as a
// pause on the phone. Up next is read when the song changes, after a tool or control, or this often.
const PLAYER_POLL_MS = { showing: 30_000, hidden: 60_000 };
const SONG_END_SLACK_MS = 1_500;
const QUEUE_READ_MS = 120_000;
// NetEase is read through ncm-cli on this Mac and costs no quota, and so is the Music app.
const NETEASE_POLL_MS = 5_000;
const MUSIC_APP_POLL_MS = 5_000;
// After a press on the player, the window keeps the player pressed this long, even if another one
// plays meanwhile, so a second press acts on the same music.
const CONTROL_HOLD_MS = 30_000;
// A song that stops this close to its end ended, rather than being paused.
const ENDED_WITHIN_MS = 5_000;
// Coming back to the window reads Spotify once, at most this often, to show a change made elsewhere.
const FOCUS_READ_MS = 10_000;
// How often a showing window looks for what the terminal or another window changed, and how often
// while one of them answers in the conversation shown here.
const LOOK_MS = { idle: 2_000, answering: 300 };
// Tools whose results can change what Spotify or the Music app is playing, or what comes next.
const PLAYER_TOOLS = /^moondog_(?:spotify_(?:player_control|queue_add|queue_batch|queue_similar|device_transfer|playlist_write)|music_app_control)$/u;
// At most this many conversations hold an agent at once; idle ones are reused first.
const MAX_SLOTS = 4;

const coverOf = (item) => (typeof item?.image === "string" ? item.image : null);
// Spotify pads the queue of a one-song play with that same song, and lists a repeated song once per
// repeat; up next shows what actually comes next, each song once in a row.
export function upNext(queue, current) {
  const uri = (item) => (typeof item?.uri === "string" ? item.uri : null);
  return queue.filter((item, index) => !uri(item) || (uri(item) !== uri(current) && uri(item) !== uri(queue[index - 1])));
}

// A song's page in Spotify, where the listener can save it or add it to a playlist.
const spotifyLink = (uri) => {
  const [, kind, id] = String(uri ?? "").match(/^spotify:(track|episode):([A-Za-z0-9]+)$/u) ?? [];
  return kind ? `https://open.spotify.com/${kind}/${id}` : null;
};
const trackOf = (item) => item && {
  title: item.name ?? "",
  link: spotifyLink(item.uri),
  artists: item.artists ?? (item.publisher ? [item.publisher] : []),
  album: item.album ?? null,
  image: coverOf(item),
  durationMs: Number.isInteger(item.duration_ms) ? item.duration_ms : null,
};
const errorText = (error) => String(error?.message ?? error ?? "").slice(0, 400);

export function runWindowRoom(services, { port, send, quit = null, focus = null }) {
  const { application: base, rebuildRuntime, saveRuntimeSelection, toolTrace = null, openConversation, modelSettings, saveLanguage, savePlaybackService,
    prepareImport, prepareRecentImport, refreshImportedData, lastfm, runSpotify, watchModelSettings, firstRun } = services;
  // Slot 0 is the core's own application and agent. The core closes every conversation after the room ends.
  const slots = [{ application: base, runtime: services.runtime, turn: null, live: null, stale: null, rebuilding: null, waiting: false, close: null }];
  let current = slots[0];
  let visible = true;
  let pollTimer = null;
  let polling = null;
  let closed = false;

  const sessionOf = (slot) => slot.application.ensureMemorySession?.()?.session_id ?? null;
  const slotFor = (sessionId) => slots.find((slot) => sessionOf(slot) === sessionId) ?? null;
  const busy = () => slots.some((slot) => slot.turn);
  const sessions = () => (base.listSavedSessions?.({ limit: 200 }) ?? []).map((session) => ({
    id: session.session_id, title: String(session.title ?? "").replace(/\s+/gu, " ").trim(),
    updatedAt: session.updated_at ?? session.started_at, branch: Boolean(session.parent_session_id),
    pinned: Boolean(session.pinned_at), folderId: session.folder_id ?? null, customTitle: session.custom_title === true,
  }));
  // A conversation on its first reply has nothing saved yet, so the list shows it from the live turn.
  const listed = (saved = sessions()) => {
    const ids = new Set(saved.map((session) => session.id));
    const fresh = slots.filter((slot) => slot.live && !ids.has(sessionOf(slot))).map((slot) => ({ id: sessionOf(slot),
      title: shortConversationTitle(slot.live.user), updatedAt: new Date().toISOString(), branch: false, pinned: false, folderId: null, customTitle: false }));
    return [...saved.filter((session) => session.pinned), ...fresh, ...saved.filter((session) => !session.pinned)];
  };
  const folders = () => (base.listConversationFolders?.() ?? []).map((folder) => ({ id: folder.folder_id ?? folder.id, name: folder.name, position: folder.position ?? 0 }));
  // The saved list and folders the window last got, so a look that finds nothing new sends nothing.
  let shown = null;
  const sendSessions = () => {
    const saved = sessions();
    const folderList = folders();
    shown = JSON.stringify([saved, folderList]);
    send({ type: "sessions", sessions: listed(saved), folders: folderList, current: sessionOf(current),
      running: slots.filter((slot) => slot.turn).map(sessionOf) });
  };
  // The terminal and the window show the same conversation: the one either opened last. Both save to the
  // same memory store. While the window shows, SQLite's data version says whether another connection
  // committed since the last look.
  let seen = null;
  let sessionsTimer = null;
  // A reply the terminal or another window is writing in the conversation shown here: { session, live }.
  let remote = null;
  // The saved transcript the window last got, so a look that finds nothing new sends nothing.
  let drawn = null;
  function lookForChanges() {
    try {
      follow();
      const version = base.memoryStore?.dataVersion?.();
      if (version === undefined || version === seen) return;
      seen = version;
      if (JSON.stringify([sessions(), folders()]) !== shown) sendSessions();
      showReplyElsewhere();
    } catch { /* A busy or closing store; the next look tries again. */ }
  }
  const scheduleSessions = () => {
    clearTimeout(sessionsTimer);
    if (closed || !visible) return;
    sessionsTimer = setTimeout(() => { lookForChanges(); scheduleSessions(); }, remote ? LOOK_MS.answering : LOOK_MS.idle);
  };
  // Moves the window to the conversation the terminal or another window opened. A slot that holds it shows
  // it; otherwise an idle slot takes it over. With every slot answering, the next look tries again.
  function follow() {
    const id = base.activeConversationId?.();
    if (!id || id === sessionOf(current)) return;
    let slot = slotFor(id);
    if (!slot) {
      slot = (!current.turn && !current.waiting && current) || slots.find((candidate) => !candidate.turn && !candidate.waiting);
      if (!slot?.application.followActiveConversation?.()) return;
      slot.runtime.restoreSession?.();
    }
    current = slot;
    remote = null;
    sendSession(slot);
    sendSessions();
    sendStatus();
  }
  // Draws a reply that runs elsewhere as it grows, and the saved conversation once it ends.
  function showReplyElsewhere() {
    const slot = current;
    if (slot.turn) return;
    const session = sessionOf(slot);
    const reply = slot.application.replyElsewhere?.() ?? null;
    if (reply && remote?.session === session && remote.live.id === reply.entry_id) {
      if (reply.assistant_text !== remote.live.text) {
        remote.live.text = reply.assistant_text;
        send({ type: "text", session, id: reply.entry_id, replace: reply.assistant_text });
      }
      return;
    }
    const ended = remote !== null;
    remote = reply ? { session, live: { id: reply.entry_id, user: reply.user_text, text: reply.assistant_text, activity: [] } } : null;
    if (reply || ended || JSON.stringify([session, transcript(slot)]) !== drawn) sendSession(slot);
  }

  // A running turn is kept live in its slot; the saved entry for it is still "running", so the
  // transcript leaves it out and the window draws the live version instead. A reply running in the
  // terminal is drawn the same way.
  const liveOf = (slot) => slot.live ?? (slot === current && remote?.session === sessionOf(slot) ? remote.live : null);
  // Each message carries the saved entry it belongs to, so the window can edit a message in place or
  // branch from a reply.
  function transcript(slot) {
    const { application } = slot;
    const saved = typeof application.conversationEntries === "function" && typeof application.conversationEntryTurns === "function"
      ? application.conversationEntries({ limit: 40 }).flatMap((entry) => application.conversationEntryTurns(entry)
        .map((turn) => ({ ...turn, entry: entry.entry_id }))).slice(-80)
      : application.currentConversationTurns?.({ limit: 80 }) ?? [];
    const turns = saved.filter((entry) => entry.role === "user" || entry.role === "assistant")
      .map((entry) => ({ role: entry.role, text: entry.text, ...(entry.entry ? { entry: entry.entry } : {}) }));
    const live = liveOf(slot);
    if (live) {
      const last = turns.findLastIndex((entry) => entry.role === "user");
      if (last >= 0 && turns[last].text === live.user) turns.splice(last);
    }
    return turns;
  }
  const sendSession = (slot) => {
    const turns = transcript(slot);
    if (slot === current) drawn = JSON.stringify([sessionOf(slot), turns]);
    const live = liveOf(slot);
    send({ type: "session", current: sessionOf(slot), transcript: turns, live: live ? structuredClone(live) : null });
  };

  // A model chosen while the shown conversation answers applies when its reply ends; the window shows it already.
  function modelOf(slot) {
    const running = slot.runtime.publicStatus?.() ?? {};
    const chosen = slot.stale?.selection;
    return chosen ? { ...running, state: "configured", provider: chosen.provider, model: chosen.model, effort: chosen.effort ?? null,
      effort_levels: chosen.provider === running.provider && chosen.model === running.model ? running.effort_levels : [] } : running;
  }
  function status() {
    const model = modelOf(current);
    const spotify = base.spotifyStatus?.() ?? {};
    return {
      locale: base.locale,
      locales: Object.entries(LOCALES).map(([code, value]) => ({ code, name: value.name, nativeName: value.nativeName })),
      model: { state: model.state ?? "offline", provider: model.provider ?? null, model: model.model ?? null,
        effort: model.effort ?? null, effortLevels: model.effort_levels ?? [], reason: model.reason ?? null },
      spotify: base.spotifyReady?.() === true ? "ready" : "unavailable",
      spotifyAccount: { state: spotify.state ?? "unavailable", clientId: spotify.client_id_configured === true },
      playbackService: base.playbackService ?? "spotify",
      // NetEase Cloud Music is offered once ncm-cli is installed and signed in.
      netease: base.neteasePlayer?.status?.().state ?? "unavailable",
      memory: base.memoryStatus?.().state ?? "unavailable",
      // { needed, service, model } once read, null before; see refreshFirstRun.
      firstRun: firstRunState,
    };
  }
  const sendStatus = () => {
    send({ type: "status", ...status() });
    // Until the first run is over, any change of model or music service may end it.
    if (firstRun && firstRunState?.needed !== false) void refreshFirstRun();
  };

  // The one-time music service and model setup. The window asks while `needed`; the terminal shares
  // first-run.json, so finishing or skipping on either side ends it on both. Once over it stays over.
  let firstRunState = null;
  async function refreshFirstRun() {
    if (!firstRun || closed) return;
    const next = await firstRun.state({ modelReady: modelOf(current).state === "configured" }).catch(() => null);
    if (!next || closed || JSON.stringify(next) === JSON.stringify(firstRunState)) return;
    firstRunState = next;
    sendStatus();
  }

  // A model chosen or a sign-in made in the terminal. An agent behind it is rebuilt from the saved
  // settings; one answering is rebuilt when its turn ends, as it would be for a choice made here.
  async function followModel(selection) {
    const behind = slots.filter((slot) => !slot.stale && runtimeBehindSelection(slot.runtime.publicStatus?.(), selection));
    if (closed || !behind.length) return;
    for (const slot of behind) {
      if (slot.turn) slot.stale = { selection: undefined };
      else await rebuild(slot, undefined);
    }
    sendStatus();
    await sendModels();
  }

  // Player
  // NetEase plays through ncm-cli on this Mac; the core keeps the songs it queued there.
  async function readNetease() {
    const spotify = base.spotifyReady?.() === true ? "ready" : "unavailable";
    if (base.neteaseReady?.() !== true) return { type: "player", spotify, now: null, next: [] };
    const now = await base.neteasePlayer.nowPlaying();
    const track = (song) => ({ title: song.title, link: null, artists: song.artists, album: song.album, image: song.image, durationMs: song.duration_ms });
    return { type: "player", spotify,
      now: now.song ? { ...track(now.song), service: "netease", playing: now.state === "playing", progressMs: now.position_ms,
        device: null, deviceType: "computer", repeat: "off", shuffle: false, disallows: [], observedAt: Date.now() } : null,
      next: now.next.slice(0, 8).map(track) };
  }
  // While Spotify has asked Moondog to wait, the window reads nothing from it and says until when.
  let spotifyLimitedUntil = 0;
  const limited = () => ({ type: "player", spotify: "limited", resumeAt: spotifyLimitedUntil, now: null, next: [] });
  const noteLimit = (error) => {
    if (error?.code !== "spotify_quota_exceeded") return false;
    spotifyLimitedUntil = Date.now() + (error.retryAfterSeconds ?? 60) * 1000;
    return true;
  };
  let queueRead = { uri: null, at: 0, queue: null };
  let queueStale = true;
  let playingNow = false;
  // The chosen service's player: Spotify's active device, or NetEase.
  async function readChosen() {
    if (base.playbackService === "netease") return readNetease();
    const service = base.spotifyConnection?.service;
    if (base.spotifyReady?.() !== true || !service) return { type: "player", spotify: "unavailable", now: null, next: [] };
    if (spotifyLimitedUntil > Date.now()) return limited();
    let player;
    try {
      player = await service.currentPlayer();
    } catch (error) {
      if (noteLimit(error)) return limited();
      throw error;
    }
    spotifyLimitedUntil = 0;
    const item = player?.state === "available" ? player.item : null;
    playingNow = player?.is_playing === true && Boolean(item);
    if (item && (queueStale || item.uri !== queueRead.uri || Date.now() - queueRead.at >= QUEUE_READ_MS)) {
      queueStale = false;
      queueRead = { uri: item.uri, at: Date.now(), queue: await service.queue?.().catch(() => null) };
    }
    const queue = item ? queueRead.queue : null;
    notePlayer(player, item);
    return { type: "player", spotify: "ready",
      now: item ? { ...trackOf(item), playing: player.is_playing === true, progressMs: player.progress_ms ?? 0,
        device: player.device?.name ?? null, deviceType: player.device?.type ?? null, repeat: player.repeat_state ?? "off", shuffle: player.shuffle_state === true,
        // What Spotify won't do right now, such as skip on a free account, so the window can say so before a press fails.
        disallows: player.disallowed_actions ?? [], observedAt: Date.now() } : null,
      next: upNext(queue?.queue ?? [], item).slice(0, 8).map(trackOf) };
  }
  // The Music app on this Mac, which the listener plays themselves. A new song reads its cover and,
  // without shuffle, the songs after it in its playlist.
  let musicAppRunning = false;
  let musicAppPlaying = false;
  let musicAppSong = { id: null, image: null, next: [] };
  async function readMusicApp() {
    const player = base.musicApp;
    if (player?.available !== true) return null;
    const now = await player.nowPlaying().catch(() => null);
    musicAppRunning = Boolean(now) && now.state !== "not_running";
    // Music the listener starts in the Music app stops Moondog's own player, so one thing plays at a time.
    if (now?.state === "playing" && !musicAppPlaying) base.musicPreviewPlayer?.stop?.();
    musicAppPlaying = now?.state === "playing";
    if (!now?.song) return null;
    const id = `${now.song.id ?? now.song.title}\n${now.playlist?.id ?? ""}\n${now.shuffle}`;
    if (id !== musicAppSong.id) {
      const [full, image] = await Promise.all([player.nowPlaying({ tracks: true }).catch(() => null), player.cover(now.song)]);
      const playlist = full?.playlist;
      const next = !now.shuffle && playlist?.tracks && playlist.position ? playlist.tracks.slice(playlist.position - playlist.first_position + 1, playlist.position - playlist.first_position + 9) : [];
      const shown = musicAppSong = { id, image, next };
      // The songs after it get their covers one at a time in the background; the next read shows them.
      void (async () => {
        for (const song of next) {
          if (closed || musicAppSong !== shown) return;
          song.image = await player.cover(song).catch(() => null);
        }
      })();
    }
    const track = (song) => ({ title: song.title, link: null, artists: song.artists, album: song.album, image: song.image ?? null, durationMs: song.duration_ms });
    return {
      now: { ...track(now.song), image: musicAppSong.image, service: "apple_music", playing: now.state === "playing", progressMs: now.position_ms,
        device: "Apple Music", deviceType: "computer", repeat: now.repeat, shuffle: now.shuffle, disallows: [], observedAt: Date.now() },
      next: musicAppSong.next.slice(0, 8).map(track),
    };
  }
  // What the window shows: a song that plays wins over a paused one; between the two players, the
  // chosen service's first, and the Music app first when Apple Music is the chosen service.
  // A press on the player keeps the player pressed shown for a while (CONTROL_HOLD_MS).
  // Spotify is read only when its own time comes; the Music app on every pass.
  let chosenLast = null;
  let chosenReadAt = 0;
  let shownSource = null;
  let hold = { source: null, until: 0 };
  async function readPlayer({ chosen = true } = {}) {
    const music = await readMusicApp();
    let own = chosenLast;
    if (chosen || !own) {
      try {
        own = chosenLast = await readChosen();
        chosenReadAt = Date.now();
      } catch (error) {
        if (!music) throw error;
      }
    }
    const musicFirst = base.playbackService === "apple_music";
    const rank = (now, first) => (now?.playing ? 0 : now ? 2 : 4) + (first ? 0 : 1);
    const holding = Date.now() < hold.until;
    const showMusic = Boolean(music) && (holding && hold.source === "apple_music" ? true
      : holding && hold.source === "chosen" && own?.now ? false
        : rank(music.now, musicFirst) < rank(own?.now, !musicFirst));
    shownSource = showMusic ? "apple_music" : "chosen";
    return showMusic ? { type: "player", spotify: own?.spotify ?? "unavailable", ...(own?.resumeAt ? { resumeAt: own.resumeAt } : {}), ...music } : own;
  }
  // The local trace keeps each change between playing and stopped, with the song, position and device,
  // so a pause nobody asked for can be told apart from the end of a song or another device.
  let last = null;
  function notePlayer(player, item) {
    const playing = player?.state === "available" && player.is_playing === true;
    const now = Date.now();
    if (last && playing !== last.playing) {
      const expected = last.progressMs === null ? null : last.progressMs + (last.playing ? now - last.at : 0);
      toolTrace?.record({ source: "player", state: playing ? "playing" : "stopped", title: item?.name ?? null, uri: item?.uri ?? null,
        progressMs: player?.progress_ms ?? null, durationMs: item?.duration_ms ?? null, previousProgressMs: last.progressMs,
        msSinceLastRead: now - last.at, device: player?.device?.name ?? null, repeat: player?.repeat_state ?? null,
        context: player?.context?.type ?? null,
        ended: !playing && expected !== null && Number.isInteger(last.durationMs) && expected >= last.durationMs - ENDED_WITHIN_MS });
    }
    last = { playing, at: now, progressMs: player?.progress_ms ?? null, durationMs: item?.duration_ms ?? null };
  }
  // One read at a time; a request while one runs reads again right after it.
  let again = false;
  // A refresh after something that can change up next (a tool, a control) reads the queue too.
  async function refreshPlayer({ queue = false, chosen = true } = {}) {
    if (closed) return;
    if (queue) queueStale = true;
    if (polling) { again = true; return polling; }
    polling = readPlayer({ chosen: chosen || queue }).then(send, (error) => send({ type: "player", spotify: "error", message: errorText(error), now: null, next: [] }))
      .finally(() => {
        polling = null;
        // Each read sets the next one, so a skip, a pause or a new song moves the time of that read.
        if (again) { again = false; void refreshPlayer(); } else schedulePlayer();
      });
    return polling;
  }
  const schedulePlayer = () => {
    clearTimeout(pollTimer);
    if (closed) return;
    // Spotify waits as long as it asked. A showing window reads again when the playing song should
    // have ended, if that comes before the next regular read.
    const now = Date.now();
    const netease = base.playbackService === "netease";
    const songLeftMs = playingNow && last?.durationMs ? last.durationMs - (last.progressMs ?? 0) - (now - last.at) : Infinity;
    const chosenDue = netease ? chosenReadAt + (visible ? NETEASE_POLL_MS : PLAYER_POLL_MS.hidden)
      : spotifyLimitedUntil > now ? spotifyLimitedUntil + 1000
        : !visible ? chosenReadAt + PLAYER_POLL_MS.hidden
          : Math.max(now + 1_000, Math.min(chosenReadAt + PLAYER_POLL_MS.showing, now + songLeftMs + SONG_END_SLACK_MS));
    // While the Music app runs, it is read more often than Spotify; it is local and costs no quota.
    const musicDue = musicAppRunning ? now + (visible ? MUSIC_APP_POLL_MS : PLAYER_POLL_MS.hidden) : Infinity;
    pollTimer = setTimeout(() => void refreshPlayer({ chosen: Date.now() >= chosenDue - 500 }), Math.max(0, Math.min(chosenDue, musicDue) - now));
  };

  async function control(action, via, positionMs) {
    // The buttons act on the player the window shows.
    const musicApp = shownSource === "apple_music";
    const netease = !musicApp && base.playbackService === "netease";
    const service = musicApp ? base.musicApp : netease ? base.neteasePlayer : base.spotifyConnection?.service;
    const ready = musicApp || (netease ? base.neteaseReady?.() === true : base.spotifyReady?.() === true);
    if (!service || !ready || !["pause", "resume", "next", "previous", "seek"].includes(action)) return;
    toolTrace?.record({ source: "window", tool: "player_control", state: "start", args: { action, via: via ?? "button" } });
    hold = { source: shownSource, until: Date.now() + CONTROL_HOLD_MS };
    try {
      if (action === "resume") await base.quietOtherPlayers?.(musicApp ? "music_app" : netease ? "netease" : "spotify");
      // A seek is a click on the song's progress; the rest are the transport buttons and the menu.
      if (action === "seek") await service.seek({ positionMs: Math.max(0, Math.round(Number(positionMs) || 0)) });
      else await service[action]({});
    } catch (error) {
      if (noteLimit(error)) { send(limited()); schedulePlayer(); return; }
      send({ type: "player-error", action, message: errorText(error) });
    }
    // Spotify takes a moment to report a skip.
    await refreshPlayer({ chosen: !musicApp });
    setTimeout(() => void refreshPlayer({ chosen: !musicApp }), 900);
  }

  // Devices keep their Spotify ids here; the window sees only a reference.
  let deviceIds = new Map();
  async function devices() {
    const service = base.spotifyConnection?.service;
    if (!service || base.spotifyReady?.() !== true) return send({ type: "devices", devices: [] });
    if (spotifyLimitedUntil > Date.now()) return send({ type: "devices", devices: [], error: "limited", resumeAt: spotifyLimitedUntil });
    let listed;
    try {
      listed = (await service.devices()).devices ?? [];
    } catch (error) {
      // Devices and the player share Spotify's quota, so a limit on one rests the other too.
      if (noteLimit(error)) { send(limited()); schedulePlayer(); return send({ type: "devices", devices: [], error: "limited", resumeAt: spotifyLimitedUntil }); }
      return send({ type: "devices", devices: [], error: errorText(error) });
    }
    deviceIds = new Map(listed.map((device, index) => [String(index), device.id]));
    send({ type: "devices", devices: listed.map((device, index) => ({ ref: String(index), name: device.name, type: device.type ?? "unknown",
      active: device.is_active === true, restricted: device.is_restricted === true })) });
  }
  async function transfer(ref) {
    const service = base.spotifyConnection?.service;
    const deviceId = deviceIds.get(String(ref));
    if (!service || !deviceId) return;
    toolTrace?.record({ source: "window", tool: "device_transfer", state: "start", args: { ref } });
    try {
      await service.transfer({ deviceId });
    } catch (error) {
      send({ type: "notice", code: "transfer_failed", message: errorText(error) });
      await devices();
      await refreshPlayer();
      return;
    }
    // Spotify reports the new device late. An immediate list still marks the old one, and would
    // replace the check the window already moved. Read the list with the delayed player refresh.
    await refreshPlayer();
    setTimeout(() => { void refreshPlayer(); void devices(); }, 1200);
  }

  // Conversations
  async function slotForOpening(id) {
    // A slot holding a message that waits for an import or a rebuild is not free. Reusing it would
    // send that message in the conversation opened meanwhile.
    const reusable = (!current.turn && !current.waiting && current) || slots.find((slot) => !slot.turn && !slot.waiting);
    if (reusable) {
      if (id) {
        reusable.application.resumeSession(id);
        reusable.runtime.restoreSession?.();
      } else {
        reusable.application.startNewSession?.("user_new");
        reusable.runtime.reset?.();
      }
      return reusable;
    }
    if (typeof openConversation !== "function" || slots.length >= MAX_SLOTS) return null;
    const opened = await openConversation(id ? { sessionId: id } : { reason: "user_new" });
    const slot = { application: opened.application, runtime: opened.runtime, turn: null, live: null, stale: null, rebuilding: null, waiting: false, close: opened.close };
    slots.push(slot);
    // A model chosen while every agent was answering is not saved yet, so this one would start without it.
    if (pending) await rebuild(slot, pending);
    return slot;
  }
  async function openSession(id) {
    if (id && sessionOf(current) === id) return sendSession(current);
    const existing = id ? slotFor(id) : null;
    // The terminal follows the conversation the window shows, even one still answering in its slot.
    existing?.application.claimActiveConversation?.();
    const slot = existing ?? await slotForOpening(id);
    if (!slot) return send({ type: "notice", code: "too_many_running" });
    current = slot;
    sendSession(slot);
    sendSessions();
    sendStatus();
  }

  async function prompt(text) {
    const slot = current;
    if (typeof text !== "string" || !text.trim()) return;
    // A second message cannot start while the first is in a turn or waiting to start. The window
    // put the text back in the composer; dropping it here would lose it.
    if (slot.turn || slot.waiting) return send({ type: "notice", code: "message_busy", text });
    // The terminal is answering in this conversation; one reply at a time.
    if (slot.application.replyElsewhere?.()) return send({ type: "notice", code: "message_busy", text });
    const session = sessionOf(slot);
    // A new agent being built, or an import replacing the profile under every agent, finishes first.
    // The slot stays reserved for this conversation until the message starts.
    if (saving || slot.rebuilding) {
      slot.waiting = true;
      if (saving) send({ type: "notice", code: "waiting_for_import" });
      while (slot.rebuilding || saving) await (slot.rebuilding ?? saving).catch(() => {});
      if (closed || sessionOf(slot) !== session || slot.turn) {
        slot.waiting = false;
        if (!closed) send({ type: "notice", code: "message_busy", text, session });
        return;
      }
    }
    slot.waiting = false;
    const id = randomUUID();
    const settled = Promise.withResolvers();
    slot.turn = { id, settled: settled.promise };
    slot.live = { id, user: text, text: "", activity: [] };
    send({ type: "turn", session, id, state: "start", text });
    sendSessions();
    const unsubscribe = slot.runtime.agent?.subscribe?.((event) => {
      if (event.type === "tool_execution_start") {
        const call = { call: event.toolCallId, tool: event.toolName, args: event.args ?? {}, state: "running" };
        slot.live?.activity.push(call);
        send({ type: "activity", session, id, ...call });
      }
      if (event.type === "tool_execution_end") {
        const state = event.isError ? "failed" : "done";
        const call = slot.live?.activity.find((entry) => entry.call === event.toolCallId);
        if (call) call.state = state;
        send({ type: "activity", session, id, call: event.toolCallId, tool: event.toolName, state });
        if (PLAYER_TOOLS.test(event.toolName)) void refreshPlayer({ queue: true });
      }
    }) ?? (() => {});
    try {
      const result = await slot.runtime.prompt(text, {
        onTextDelta: (delta) => { if (slot.live) slot.live.text += delta; send({ type: "text", session, id, delta }); },
        onTextReplace: (replacement) => { if (slot.live) slot.live.text = replacement; send({ type: "text", session, id, replace: replacement }); },
        onModelRetry: ({ attempt, maxRetries }) => send({ type: "retry", session, id, attempt, maxRetries }),
        // The model names a new conversation after its first reply. This process saved the name, so the
        // look for another process's changes would not notice it.
        onConversationNamed: () => { if (!closed) sendSessions(); },
      });
      send({ type: "turn", session, id, state: "end", status: result.status, text: result.text ?? "", entry: latestEntry(slot),
        receipts: (result.spotify_write_receipts ?? []).map((receipt) => ({ action: receipt.action, state: receipt.state,
          targets: receipt.targets ?? [], device: receipt.device?.name ?? null })) });
    } catch (error) {
      send({ type: "turn", session, id, state: "error", message: errorText(error), connection: error?.code === "model_connection_failed", entry: latestEntry(slot) });
    } finally {
      unsubscribe();
      slot.turn = null;
      slot.live = null;
      // The window already drew this reply from the turn's own messages.
      if (slot === current) { try { drawn = JSON.stringify([session, transcript(slot)]); } catch { /* The next look redraws. */ } }
      settled.resolve();
      // A model or service change made while this turn ran applies now.
      if (slot.stale) await rebuild(slot, slot.stale.selection).catch(() => {});
      if (slot === current) sendStatus();
      sendSessions();
      void refreshPlayer();
    }
  }

  // A rebuilt agent keeps the conversation so far; the core saves a selection when it builds with one.
  // A choice made while every agent answers waits in `pending` until one of them is rebuilt.
  let pending = null;
  async function rebuild(slot, selection) {
    const earlier = slot.rebuilding;
    let finish = () => {};
    const work = new Promise((resolve) => { finish = resolve; });
    // Set before any await, so a prompt in this turn waits for this rebuild and not an older one.
    slot.rebuilding = work;
    try {
      if (earlier) await earlier.catch(() => {});
      // A newer choice queued behind this one does the swap. This one must not finish last and replace it.
      if (slot.rebuilding !== work) return;
      slot.stale = null;
      const previous = slot.runtime;
      const next = slot === slots[0] ? await rebuildRuntime(selection) : await rebuildRuntime(selection, slot.application);
      if (slot.rebuilding !== work) {
        try { next.reset?.(); } catch { /* The newer rebuild owns the slot. */ }
        return;
      }
      next.restoreSession?.();
      slot.runtime = next;
      if (selection && selection === pending) pending = null;
      try { previous.reset?.(); } catch { /* A finished agent has nothing left to clear. */ }
    } finally {
      finish();
      if (slot.rebuilding === work) slot.rebuilding = null;
    }
  }
  async function rebuildAll(selection) {
    if (typeof rebuildRuntime !== "function") return;
    if (selection) {
      pending = selection;
      // Save before the reply ends. The rebuild that applies it can still be waiting on that reply.
      await saveRuntimeSelection?.(selection).catch(() => {});
    }
    for (const slot of slots) {
      const chosen = selection ?? pending ?? slot.stale?.selection;
      if (slot.turn) slot.stale = { selection: chosen };
      else await rebuild(slot, chosen ?? undefined);
    }
    sendStatus();
  }

  // Several conversations can go at once, from a selection in the sidebar. Each one that can go does;
  // the first refusal is the one the window shows.
  async function deleteSessions(ids) {
    let refusal = null;
    let shown = false;
    for (const id of ids) {
      const holder = slotFor(id);
      if (holder?.turn) { refusal ??= { code: "delete_running" }; continue; }
      // The core refuses a delete while its own turn runs, so an idle slot does it: the one holding the
      // conversation, which then moves to a new one, or any other.
      const doer = (holder && !holder.waiting ? holder : null) ?? slots.find((slot) => !slot.turn && !slot.waiting) ?? null;
      try {
        if (doer) {
          const result = doer.application.deleteSavedSession(id);
          if (result?.started_new_session) doer.runtime.reset?.();
          // A slot in the background moved to a new conversation; the shown one stays the one both show.
          if (result?.started_new_session && doer !== current) current.application.claimActiveConversation?.();
        } else if (base.memoryStore) {
          // Every agent is answering and none holds this conversation, so the store deletes it directly.
          base.memoryStore.deleteConversation(id, { routeKey: base.memoryRouteKey });
        } else slots[0].application.deleteSavedSession(id);
      } catch (error) {
        refusal ??= { code: /another Moondog/u.test(errorText(error)) ? "delete_open_elsewhere" : "delete_failed", message: errorText(error) };
      }
      if (holder === current) shown = true;
    }
    if (refusal) send({ type: "notice", ...refusal });
    if (shown) sendSession(current);
    sendSessions();
  }
  // One label for one conversation or a selection of them; a refusal for one leaves the others labelled.
  function labelSessions(ids, patch) {
    let failure = null;
    for (const id of ids) {
      try { base.labelSavedSession?.(id, patch); } catch (error) { failure ??= error; }
    }
    sendSessions();
    if (failure) throw failure;
  }

  // Model and sign-in
  let signIn = null;
  const prompts = new Map();
  async function sendModels() {
    if (!modelSettings) return send({ type: "models", providers: [] });
    // The running provider comes first, as in the terminal's /model. A credential folder with unsafe
    // permissions refuses the whole list; its fixed message says what to fix.
    try {
      send({ type: "models", providers: await modelSettings.providers({ current: current.runtime.publicStatus?.().provider ?? undefined }) });
    } catch (error) {
      send({ type: "models", providers: [], error: errorText(error) });
    }
  }
  async function sendProviderModels(provider, force = false) {
    if (!modelSettings) return;
    const result = await modelSettings.models(provider, { force });
    send({ type: "provider-models", provider, models: result.models ?? result, refresh: result.refresh ?? null });
  }
  // One sign-in at a time; each clears only its own when it ends.
  async function startSignIn(provider) {
    if (!modelSettings) return;
    if (signIn) return send({ type: "sign-in", provider, state: "error", code: "sign_in_busy" });
    const controller = new AbortController();
    signIn = { provider, controller };
    const interaction = {
      signal: controller.signal,
      prompt: (request) => new Promise((resolve, reject) => {
        const id = randomUUID();
        prompts.set(id, { resolve, reject });
        request.signal?.addEventListener("abort", () => { prompts.delete(id); send({ type: "auth-prompt-closed", id }); reject(request.signal.reason); }, { once: true });
        send({ type: "auth-prompt", id, provider, kind: request.type, message: request.message, placeholder: request.placeholder ?? null,
          options: request.type === "select" ? request.options.map((option) => ({ id: option.id, label: option.label, description: option.description ?? null })) : null });
      }),
      notify: (event) => {
        if (event.type === "auth_url" && /^https:\/\//u.test(event.url)) send({ type: "auth-event", provider, kind: "auth_url", url: event.url, message: event.instructions ?? null });
        else if (event.type === "device_code") send({ type: "auth-event", provider, kind: "device_code", userCode: event.userCode, url: event.verificationUri });
        else if (event.type === "info" || event.type === "progress") send({ type: "auth-event", provider, kind: event.type, message: event.message });
      },
    };
    try {
      await modelSettings.signIn(provider, interaction);
      send({ type: "sign-in", provider, state: "done" });
      // The saved selection now has a key to use; each agent is rebuilt from it, as /auth does.
      await rebuildAll(undefined);
    } catch (error) {
      send({ type: "sign-in", provider, state: controller.signal.aborted ? "cancelled" : "error", message: errorText(error) });
    } finally {
      for (const pending of prompts.values()) pending.reject(new Error("closed"));
      prompts.clear();
      if (signIn?.controller === controller) signIn = null;
      await sendModels().catch(() => {});
    }
  }

  // Spotify sign-in prints its address on stderr, as in a terminal; the window opens it.
  async function connectSpotify(clientId) {
    if (typeof runSpotify !== "function") return;
    // Connecting replaces every conversation's Spotify reads, so it waits for running replies.
    if (busy()) return send({ type: "sign-in", provider: "spotify", state: "error", code: "connect_while_answering" });
    if (signIn) return send({ type: "sign-in", provider: "spotify", state: "error", code: "sign_in_busy" });
    const controller = new AbortController();
    signIn = { provider: "spotify", controller };
    const sink = { write: (text) => {
      // The sign-in opens the browser itself; the window shows the address in case it did not.
      const url = String(text).match(/https:\/\/accounts\.spotify\.com\/[^\s"'<>]+/u)?.[0];
      if (url) send({ type: "auth-event", provider: "spotify", kind: "auth_url", url, opened: true });
    } };
    try {
      if (clientId) await runSpotify(["configure", clientId], { signal: controller.signal, stderr: sink });
      await runSpotify(["login"], { signal: controller.signal, stderr: sink });
      send({ type: "sign-in", provider: "spotify", state: "done" });
    } catch (error) {
      send({ type: "sign-in", provider: "spotify", state: controller.signal.aborted ? "cancelled" : "error", message: errorText(error) });
    } finally {
      if (signIn?.controller === controller) signIn = null;
      await rebuildAll(undefined).catch(() => {});
      await refreshPlayer();
    }
  }

  // Import: one prepared import at a time, nothing saved until the listener adds it. While one is
  // saved, `saving` holds new replies back, because the profile under every agent is replaced.
  let importing = null;
  let saving = null;
  const closeImport = () => { try { importing?.prepared?.close?.(); } catch { /* Already closed. */ } importing = null; };
  // The terminal's import view writes the preview's words; the window shows the same ones, in the listener's language.
  const previewOf = (prepared, kind) => {
    const preview = prepared.preview ?? {};
    const view = new HistoryImportView({ tui: { requestRender() {} }, getTheme: () => ({}), getRows: () => 40, getText: () => screenTranslator(base.locale) });
    view.setState({ page: "preview", preview, origin: kind === "spotify" ? "quick" : kind });
    const { title, notice, paragraphs } = view.pageContent();
    return { title, notice, paragraphs, empty: !preview.listeningEvents && !preview.tracks && !preview.profileEvidence && !preview.library };
  };
  async function prepare(kind, value) {
    if (importing?.working) return;
    closeImport();
    const controller = new AbortController();
    importing = { working: true, controller, prepared: null };
    send({ type: "import", stage: "reading", kind });
    const onProgress = (event) => send({ type: "import", stage: "progress", count: event?.count ?? null, total: event?.total ?? null, step: event?.stage ?? null });
    try {
      const prepared = kind === "spotify" ? await prepareRecentImport({ onProgress, signal: controller.signal })
        : kind === "lastfm" ? await prepareImport(value, { provider: "lastfm", onProgress, signal: controller.signal })
          : await prepareImport(value, {});
      if (controller.signal.aborted) { prepared?.close?.(); importing = null; return send({ type: "import", stage: "cancelled" }); }
      importing = { working: false, controller, prepared };
      send({ type: "import", stage: "preview", preview: previewOf(prepared, kind) });
    } catch (error) {
      importing = null;
      send({ type: "import", stage: controller.signal.aborted ? "cancelled" : "error", code: error?.code ?? null, message: errorText(error) });
    }
  }
  async function commitImport() {
    if (!importing?.prepared || importing.working) return;
    if (busy()) return send({ type: "import", stage: "error", code: "import_while_answering" });
    importing.working = true;
    send({ type: "import", stage: "saving" });
    const saved = Promise.withResolvers();
    saving = saved.promise;
    try {
      const receipt = await importing.prepared.commit();
      closeImport();
      let report = null;
      try {
        await refreshImportedData?.(receipt);
        await rebuildAll(undefined);
        const tr = screenTranslator(base.locale);
        if (base.profileServicesReady?.()) report = formatLocalResult("taste", await base.runLocalCommand("taste", current.runtime.publicStatus?.()), tr);
      } catch (error) {
        send({ type: "import", stage: "refresh-failed", message: errorText(error) });
      }
      send({ type: "import", stage: "done", receipt: { plays: receipt.inserted_events ?? null, duplicates: receipt.duplicate_events ?? null,
        tracks: receipt.library_tracks ?? null, evidence: receipt.inserted_profile_evidence ?? null, already: receipt.already_imported === true } });
      if (report) send({ type: "local", session: sessionOf(current), markdown: report });
    } catch (error) {
      if (importing) importing.working = false;
      send({ type: "import", stage: "error", code: error?.code ?? null, message: errorText(error) });
    } finally {
      saving = null;
      saved.resolve();
    }
  }

  async function setLanguage(code) {
    const locale = normalizeLocale(code);
    if (!locale) return;
    for (const slot of slots) { slot.application.locale = locale; slot.application.conversationLocale = locale; }
    await saveLanguage?.(locale);
    sendStatus();
  }
  async function setMusicService(service) {
    if (!["spotify", "apple_music", "netease"].includes(service) || typeof savePlaybackService !== "function") return;
    // The picker and the agent publish the same saved change, without replacing a running agent.
    await savePlaybackService(service);
    playbackChanged();
  }
  // The entry a turn just saved, so its message in the window can be edited without a redraw.
  function latestEntry(slot) {
    try { return slot.application.conversationEntries?.({ limit: 1 }).at(-1)?.entry_id ?? null; } catch { return null; }
  }
  // Edit, from the window: as /rewind in the terminal, the message and everything after it leave this
  // conversation, and the changed words go in its place as a new message. The window already shows them.
  async function edit(entryId, text) {
    const slot = current;
    if (!entryId || !text.trim()) return;
    if (slot.turn || slot.waiting || slot.application.replyElsewhere?.()) {
      send({ type: "notice", code: "rewind_busy" });
      return sendSession(slot);
    }
    try {
      if (typeof slot.runtime.rewindTo === "function") await slot.runtime.rewindTo(entryId);
      else { slot.application.rewindConversation(entryId); slot.runtime.restoreSession?.(); }
    } catch (error) {
      send({ type: "notice", code: "rewind_failed", message: errorText(error) });
      return sendSession(slot);
    }
    await prompt(text);
  }
  // Branch, from a reply: a new conversation goes on from it with everything up to it, and the original
  // stays among the conversations. The terminal follows, as it does a conversation opened here.
  function branch(entryId) {
    const slot = current;
    if (!entryId) return;
    if (slot.turn || slot.waiting || slot.application.replyElsewhere?.()) return send({ type: "notice", code: "rewind_busy" });
    try {
      slot.application.branchConversation(entryId);
      slot.runtime.restoreSession?.();
    } catch (error) {
      return send({ type: "notice", code: "rewind_failed", message: errorText(error) });
    }
    sendSession(slot);
    sendSessions();
    sendStatus();
    send({ type: "branched", session: sessionOf(slot) });
  }
  function memories() {
    const summary = base.memorySummary?.({ limit: 100 });
    send({ type: "memories", state: summary?.state ?? "unavailable", memories: (summary?.memories ?? []).map((memory) => ({
      id: memory.memory_id, text: memory.text, kind: memory.kind, updatedAt: memory.updated_at })) });
  }

  const idsOf = (data) => (Array.isArray(data.ids) ? data.ids : [data.id ?? ""]).map(String);
  const handlers = {
    prompt: (data) => prompt(String(data.text ?? "")),
    cancel: () => { if (current.turn) current.runtime.abort?.(); },
    new: () => openSession(null),
    open: (data) => openSession(String(data.id ?? "")),
    edit: (data) => edit(String(data.entry ?? ""), String(data.text ?? "")),
    branch: (data) => branch(String(data.entry ?? "")),
    control: (data) => control(String(data.action ?? ""), data.via, data.positionMs),
    storefront: (data) => { setAppleMusicStorefront(data.code); },
    visible: (data) => {
      visible = data.visible !== false;
      if (visible) { void refreshPlayer(); lookForChanges(); }
      schedulePlayer();
      scheduleSessions();
    },
    // Conversations: rename, pin, file, delete, and folders. A selection sends its ids together.
    label: (data) => labelSessions(idsOf(data), data.patch ?? {}),
    delete: (data) => deleteSessions(idsOf(data)),
    "folder-save": (data) => { const folder = base.saveConversationFolder?.({ folderId: data.id ?? undefined, name: String(data.name ?? "").trim() });
      if (folder && data.moveSessions?.length) labelSessions(data.moveSessions.map(String), { folderId: folder.folder_id ?? folder.id });
      else sendSessions(); },
    "folder-delete": (data) => { base.deleteConversationFolder?.(String(data.id)); sendSessions(); },
    // Settings
    settings: () => { sendStatus(); memories(); },
    models: () => sendModels(),
    "provider-models": (data) => sendProviderModels(String(data.provider ?? ""), data.force === true),
    model: async (data) => {
      const selection = { provider: String(data.provider ?? ""), model: String(data.model ?? ""), ...(data.effort ? { effort: String(data.effort) } : {}) };
      // The rebuild saves the selection before it checks it, so the model is checked against the catalog first.
      const listed = (await modelSettings?.models(selection.provider))?.models ?? [];
      if (!listed.some((entry) => entry.id === selection.model)) return send({ type: "notice", code: "model_unknown" });
      await rebuildAll(selection);
    },
    effort: async (data) => {
      const model = current.stale?.selection ?? pending ?? current.runtime.publicStatus?.() ?? {};
      if (!model.provider || !model.model) return;
      await rebuildAll({ provider: model.provider, model: model.model, ...(data.effort && data.effort !== "default" ? { effort: String(data.effort) } : {}) });
    },
    "sign-in": (data) => (data.provider === "spotify" ? connectSpotify(data.clientId ? String(data.clientId) : null) : startSignIn(String(data.provider ?? ""))),
    "sign-in-cancel": () => signIn?.controller.abort(),
    "auth-answer": (data) => { const pending = prompts.get(String(data.id)); prompts.delete(String(data.id)); pending?.resolve(String(data.value ?? "")); },
    "sign-out": async (data) => {
      if (data.provider === "spotify") await runSpotify?.(["logout"], { stderr: { write() {} } });
      else await modelSettings?.signOut?.(String(data.provider ?? ""));
      await rebuildAll(undefined);
      await sendModels();
      await refreshPlayer();
    },
    // The listener skipped the rest of the first run, or finished its last step.
    "first-run-done": async (data) => { await firstRun?.finish({ skipped: data.skipped === true }); await refreshFirstRun(); },
    language: (data) => setLanguage(String(data.locale ?? "")),
    "music-service": (data) => setMusicService(String(data.service ?? "")),
    // After ncm-cli is set up in Terminal, the window asks again instead of waiting for the next launch.
    "netease-check": async () => { await base.neteasePlayer?.check?.(); sendStatus(); },
    devices: () => devices(),
    transfer: (data) => transfer(data.ref),
    memories: () => memories(),
    remember: (data) => { const text = String(data.text ?? "").trim(); if (text) base.rememberMemory?.({ text, kind: "fact" }); memories(); },
    forget: (data) => { base.forgetMemory?.(String(data.id ?? "")); memories(); },
    "import-file": (data) => prepare("file", String(data.path ?? "")),
    "import-lastfm": (data) => prepare("lastfm", String(data.username ?? "").trim()),
    "import-spotify": () => prepare("spotify"),
    "import-cancel": () => { importing?.controller?.abort(); if (!importing?.working) { closeImport(); send({ type: "import", stage: "cancelled" }); } },
    "import-commit": () => commitImport(),
    "lastfm-key": async (data) => { await lastfm?.save?.(String(data.key ?? "").trim()); send({ type: "import", stage: "lastfm-key-saved" }); },
  };

  // A service chosen in the picker, by an agent or in the terminal. Each agent picks up its new
  // tools before its next model request, so none is rebuilt; the window shows the choice now.
  let shownPlaybackService = base.playbackService;
  function playbackChanged() {
    if (closed || base.playbackService === shownPlaybackService) return;
    shownPlaybackService = base.playbackService;
    sendStatus();
    void refreshPlayer({ queue: true });
    schedulePlayer();
  }
  const unsubscribePlayback = base.onPlaybackServiceChange?.(playbackChanged);
  const unwatchModel = watchModelSettings?.((selection) => { void followModel(selection).catch(() => {}); });
  const unwatchFirstRun = firstRun?.watch(() => { void refreshFirstRun(); });

  return new Promise((resolve) => {
    // Quitting stops running replies and lets them settle, so each is saved as interrupted with what it
    // did; the core then closes every conversation. The app asks through `quit`.
    let stopping = null;
    const stop = () => stopping ??= (async () => {
      closed = true;
      unsubscribePlayback?.();
      unwatchModel?.();
      unwatchFirstRun?.();
      clearTimeout(pollTimer);
      clearTimeout(sessionsTimer);
      const settling = slots.filter((slot) => slot.turn).map((slot) => { slot.runtime.abort?.(); return slot.turn.settled; });
      signIn?.controller.abort();
      closeImport();
      await Promise.race([Promise.allSettled(settling), new Promise((done) => setTimeout(done, 2000))]);
      resolve({});
    })();
    // A quit that came while the core was still starting has already happened.
    if (quit?.aborted) void stop();
    else quit?.addEventListener("abort", () => void stop(), { once: true });
    let focusReadAt = -Infinity;
    focus?.addEventListener("focus", () => {
      if (Date.now() - focusReadAt < FOCUS_READ_MS) return;
      focusReadAt = Date.now();
      void refreshPlayer();
    });
    port.on("message", async ({ data }) => {
      if (!data?.type) return;
      try {
        if (data.type === "quit") return void await stop();
        await handlers[data.type]?.(data);
      } catch (error) {
        send({ type: "notice", code: data.type, message: errorText(error) });
      }
    });
    port.start();
    // Whether the pickers can offer NetEase: one check at launch, unless the core already made it.
    if (base.neteasePlayer?.status?.().state === "unknown") void base.neteasePlayer.check().then(sendStatus, () => {});
    // Each launch opens a new conversation, as the terminal does; earlier ones wait in the sidebar.
    base.startNewSession?.("app_start");
    slots[0].runtime.reset?.();
    const saved = sessions();
    const folderList = folders();
    shown = JSON.stringify([saved, folderList]);
    drawn = JSON.stringify([sessionOf(current), transcript(current)]);
    send({ type: "ready", ...status(), sessions: saved, folders: folderList, current: sessionOf(current), running: [], transcript: [] });
    void refreshFirstRun();
    void refreshPlayer();
    schedulePlayer();
    scheduleSessions();
  });
}
