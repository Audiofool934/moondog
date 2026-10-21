// The window's side of the listening room. It drives the same application and agent the
// terminal uses, with messages from the window instead of keystrokes: a turn streams back
// as text and activity, and Spotify's player state arrives whenever it may have changed.
// Several conversations can answer at once, each in its own slot; settings, sign-in,
// devices and imports go through the same services the terminal uses.
import { randomUUID } from "node:crypto";
import { LOCALES, normalizeLocale, screenTranslator } from "../src/i18n/index.mjs";
import { formatLocalResult } from "../src/surfaces/cli/format-output.mjs";
import { HistoryImportView } from "../src/surfaces/cli/history-import-view.mjs";

const PLAYER_POLL_MS = { visible: 4_000, hidden: 30_000 };
// Tools whose results can change what Spotify is playing or what comes next.
const PLAYER_TOOLS = /^moondog_spotify_(?:player_control|queue_add|queue_batch|queue_similar|device_transfer|playlist_write)$/u;
// At most this many conversations hold an agent at once; idle ones are reused first.
const MAX_SLOTS = 4;

const coverOf = (item) => (typeof item?.image === "string" ? item.image : null);
// Spotify pads the queue of a one-song play with that same song, and lists a repeated song once per
// repeat; up next shows what actually comes next, each song once in a row.
export function upNext(queue, current) {
  const uri = (item) => (typeof item?.uri === "string" ? item.uri : null);
  return queue.filter((item, index) => !uri(item) || (uri(item) !== uri(current) && uri(item) !== uri(queue[index - 1])));
}

const trackOf = (item) => item && {
  title: item.name ?? "",
  artists: item.artists ?? (item.publisher ? [item.publisher] : []),
  album: item.album ?? null,
  image: coverOf(item),
  durationMs: Number.isInteger(item.duration_ms) ? item.duration_ms : null,
};
const errorText = (error) => String(error?.message ?? error ?? "").slice(0, 400);

export function runWindowRoom(services, { port, send }) {
  const { application: base, rebuildRuntime, toolTrace = null, openConversation, modelSettings, saveLanguage, savePlaybackService,
    prepareImport, prepareRecentImport, refreshImportedData, lastfm, runSpotify } = services;
  // Slot 0 is the core's own application and agent. The core closes every conversation after the room ends.
  const slots = [{ application: base, runtime: services.runtime, turn: null, live: null, stale: null, close: null }];
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
  const listed = () => {
    const saved = sessions();
    const ids = new Set(saved.map((session) => session.id));
    const fresh = slots.filter((slot) => slot.live && !ids.has(sessionOf(slot))).map((slot) => ({ id: sessionOf(slot),
      title: slot.live.user.replace(/\s+/gu, " ").trim().slice(0, 80), updatedAt: new Date().toISOString(), branch: false, pinned: false, folderId: null, customTitle: false }));
    return [...saved.filter((session) => session.pinned), ...fresh, ...saved.filter((session) => !session.pinned)];
  };
  const folders = () => (base.listConversationFolders?.() ?? []).map((folder) => ({ id: folder.folder_id ?? folder.id, name: folder.name, position: folder.position ?? 0 }));
  const sendSessions = () => send({ type: "sessions", sessions: listed(), folders: folders(), current: sessionOf(current),
    running: slots.filter((slot) => slot.turn).map(sessionOf) });

  // A running turn is kept live in its slot; the saved entry for it is still "running", so the
  // transcript leaves it out and the window draws the live version instead.
  function transcript(slot) {
    const turns = (slot.application.currentConversationTurns?.({ limit: 80 }) ?? [])
      .filter((entry) => entry.role === "user" || entry.role === "assistant").map((entry) => ({ role: entry.role, text: entry.text }));
    if (slot.live) {
      const last = turns.findLastIndex((entry) => entry.role === "user");
      if (last >= 0 && turns[last].text === slot.live.user) turns.splice(last);
    }
    return turns;
  }
  const sendSession = (slot) => send({ type: "session", current: sessionOf(slot), transcript: transcript(slot),
    live: slot.live ? structuredClone(slot.live) : null });

  function status() {
    const model = current.runtime.publicStatus?.() ?? {};
    const spotify = base.spotifyStatus?.() ?? {};
    return {
      locale: base.locale,
      locales: Object.entries(LOCALES).map(([code, value]) => ({ code, name: value.name, nativeName: value.nativeName })),
      model: { state: model.state ?? "offline", provider: model.provider ?? null, model: model.model ?? null,
        effort: model.effort ?? null, effortLevels: model.effort_levels ?? [], reason: model.reason ?? null },
      spotify: base.spotifyReady?.() === true ? "ready" : "unavailable",
      spotifyAccount: { state: spotify.state ?? "unavailable", clientId: spotify.client_id_configured === true },
      playbackService: base.playbackService ?? "spotify",
      memory: base.memoryStatus?.().state ?? "unavailable",
    };
  }
  const sendStatus = () => send({ type: "status", ...status() });

  // Player
  async function readPlayer() {
    const service = base.spotifyConnection?.service;
    if (base.spotifyReady?.() !== true || !service) return { type: "player", spotify: "unavailable", now: null, next: [] };
    const [player, queue] = await Promise.all([service.currentPlayer(), service.queue?.().catch(() => null)]);
    const item = player?.state === "available" ? player.item : null;
    notePlayer(player, item);
    return { type: "player", spotify: "ready",
      now: item ? { ...trackOf(item), playing: player.is_playing === true, progressMs: player.progress_ms ?? 0,
        device: player.device?.name ?? null, repeat: player.repeat_state ?? "off", shuffle: player.shuffle_state === true, observedAt: Date.now() } : null,
      next: upNext(queue?.queue ?? [], item).slice(0, 8).map(trackOf) };
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
        ended: !playing && expected !== null && Number.isInteger(last.durationMs) && expected >= last.durationMs - PLAYER_POLL_MS.visible });
    }
    last = { playing, at: now, progressMs: player?.progress_ms ?? null, durationMs: item?.duration_ms ?? null };
  }
  // One read at a time; a request while one runs reads again right after it.
  let again = false;
  async function refreshPlayer() {
    if (closed) return;
    if (polling) { again = true; return polling; }
    polling = readPlayer().then(send, (error) => send({ type: "player", spotify: "error", message: errorText(error), now: null, next: [] }))
      .finally(() => {
        polling = null;
        if (again) { again = false; void refreshPlayer(); }
      });
    return polling;
  }
  const schedulePlayer = () => {
    clearTimeout(pollTimer);
    if (closed) return;
    pollTimer = setTimeout(async () => { await refreshPlayer(); schedulePlayer(); }, visible ? PLAYER_POLL_MS.visible : PLAYER_POLL_MS.hidden);
  };

  async function control(action, via) {
    const service = base.spotifyConnection?.service;
    if (!service || base.spotifyReady?.() !== true || !["pause", "resume", "next", "previous"].includes(action)) return;
    toolTrace?.record({ source: "window", tool: "player_control", state: "start", args: { action, via: via ?? "button" } });
    try {
      await service[action]({});
    } catch (error) {
      send({ type: "player-error", action, message: errorText(error) });
    }
    // Spotify takes a moment to report a skip.
    await refreshPlayer();
    setTimeout(() => void refreshPlayer(), 900);
  }

  // Devices keep their Spotify ids here; the window sees only a reference.
  let deviceIds = new Map();
  async function devices() {
    const service = base.spotifyConnection?.service;
    if (!service || base.spotifyReady?.() !== true) return send({ type: "devices", devices: [] });
    const listed = (await service.devices()).devices ?? [];
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
    }
    await refreshPlayer();
    setTimeout(() => void refreshPlayer(), 1200);
  }

  // Conversations
  async function slotForOpening(id) {
    const reusable = (!current.turn && current) || slots.find((slot) => !slot.turn);
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
    const slot = { application: opened.application, runtime: opened.runtime, turn: null, live: null, stale: null, close: opened.close };
    slots.push(slot);
    return slot;
  }
  async function openSession(id) {
    if (id && sessionOf(current) === id) return sendSession(current);
    const existing = id ? slotFor(id) : null;
    const slot = existing ?? await slotForOpening(id);
    if (!slot) return send({ type: "notice", code: "too_many_running" });
    current = slot;
    sendSession(slot);
    sendSessions();
    sendStatus();
  }

  async function prompt(text) {
    const slot = current;
    if (slot.turn || typeof text !== "string" || !text.trim()) return;
    const id = randomUUID();
    const session = sessionOf(slot);
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
        if (PLAYER_TOOLS.test(event.toolName)) void refreshPlayer();
      }
    }) ?? (() => {});
    try {
      const result = await slot.runtime.prompt(text, {
        onTextDelta: (delta) => { if (slot.live) slot.live.text += delta; send({ type: "text", session, id, delta }); },
        onTextReplace: (replacement) => { if (slot.live) slot.live.text = replacement; send({ type: "text", session, id, replace: replacement }); },
        onModelRetry: ({ attempt, maxRetries }) => send({ type: "retry", session, id, attempt, maxRetries }),
      });
      send({ type: "turn", session, id, state: "end", status: result.status, text: result.text ?? "",
        receipts: (result.spotify_write_receipts ?? []).map((receipt) => ({ action: receipt.action, state: receipt.state,
          targets: receipt.targets ?? [], device: receipt.device?.name ?? null })) });
    } catch (error) {
      send({ type: "turn", session, id, state: "error", message: errorText(error), connection: error?.code === "model_connection_failed" });
    } finally {
      unsubscribe();
      slot.turn = null;
      slot.live = null;
      settled.resolve();
      // A model or service change made while this turn ran applies now.
      if (slot.stale) await rebuild(slot, slot.stale.selection).catch(() => {});
      sendSessions();
      void refreshPlayer();
    }
  }

  // A rebuilt agent keeps the conversation so far; the selection is saved once by the core.
  async function rebuild(slot, selection) {
    slot.stale = null;
    const previous = slot.runtime;
    const next = slot === slots[0] ? await rebuildRuntime(selection) : await rebuildRuntime(selection, slot.application);
    next.restoreSession?.();
    slot.runtime = next;
    try { previous.reset?.(); } catch { /* A finished agent has nothing left to clear. */ }
  }
  async function rebuildAll(selection) {
    if (typeof rebuildRuntime !== "function") return;
    for (const slot of slots) {
      if (slot.turn) slot.stale = { selection };
      else await rebuild(slot, selection);
    }
    sendStatus();
  }

  async function deleteSession(id) {
    const holder = slotFor(id);
    if (holder?.turn) return send({ type: "notice", code: "delete_running" });
    // The core refuses a delete while its own turn runs, so an idle slot does it: the one holding the
    // conversation, which then moves to a new one, or any other.
    const doer = holder ?? slots.find((slot) => !slot.turn) ?? slots[0];
    try {
      const result = doer.application.deleteSavedSession(id);
      if (result?.started_new_session) doer.runtime.reset?.();
    } catch (error) {
      send({ type: "notice", code: /another Moondog/u.test(errorText(error)) ? "delete_open_elsewhere" : "delete_failed", message: errorText(error) });
    }
    if (holder === current) sendSession(current);
    sendSessions();
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
  async function startSignIn(provider) {
    if (!modelSettings || signIn) return;
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
      signIn = null;
      await sendModels().catch(() => {});
    }
  }

  // Spotify sign-in prints its address on stderr, as in a terminal; the window opens it.
  async function connectSpotify(clientId) {
    if (typeof runSpotify !== "function") return;
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
      signIn = null;
      await rebuildAll(undefined).catch(() => {});
      await refreshPlayer();
    }
  }

  // Import: one prepared import at a time, nothing saved until the listener adds it.
  let importing = null;
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
    if (!["spotify", "apple_music"].includes(service) || typeof savePlaybackService !== "function") return;
    // The core saves it and sets it on every conversation; each agent's tools change when it is rebuilt.
    await savePlaybackService(service);
    await rebuildAll(undefined);
    await refreshPlayer();
  }
  function memories() {
    const summary = base.memorySummary?.({ limit: 100 });
    send({ type: "memories", state: summary?.state ?? "unavailable", memories: (summary?.memories ?? []).map((memory) => ({
      id: memory.memory_id, text: memory.text, kind: memory.kind, updatedAt: memory.updated_at })) });
  }

  const handlers = {
    prompt: (data) => prompt(String(data.text ?? "")),
    cancel: () => { if (current.turn) current.runtime.abort?.(); },
    new: () => openSession(null),
    open: (data) => openSession(String(data.id ?? "")),
    control: (data) => control(String(data.action ?? ""), data.via),
    visible: (data) => { visible = data.visible !== false; if (visible) void refreshPlayer(); schedulePlayer(); },
    // Conversations: rename, pin, file, delete, and folders.
    label: (data) => { base.labelSavedSession?.(String(data.id), data.patch ?? {}); sendSessions(); },
    delete: (data) => deleteSession(String(data.id ?? "")),
    "folder-save": (data) => { const folder = base.saveConversationFolder?.({ folderId: data.id ?? undefined, name: String(data.name ?? "").trim() });
      if (data.moveSession && folder) base.labelSavedSession?.(String(data.moveSession), { folderId: folder.folder_id ?? folder.id });
      sendSessions(); },
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
      const model = current.runtime.publicStatus?.() ?? {};
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
    language: (data) => setLanguage(String(data.locale ?? "")),
    "music-service": (data) => setMusicService(String(data.service ?? "")),
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

  return new Promise((resolve) => {
    port.on("message", async ({ data }) => {
      if (!data?.type) return;
      try {
        if (data.type === "quit") {
          closed = true;
          clearTimeout(pollTimer);
          // Stopped turns settle before the core closes each conversation after the room ends.
          const settling = slots.filter((slot) => slot.turn).map((slot) => { slot.runtime.abort?.(); return slot.turn.settled; });
          signIn?.controller.abort();
          closeImport();
          await Promise.race([Promise.allSettled(settling), new Promise((done) => setTimeout(done, 2000))]);
          resolve({});
          return;
        }
        await handlers[data.type]?.(data);
      } catch (error) {
        send({ type: "notice", code: data.type, message: errorText(error) });
      }
    });
    port.start();
    // Each launch opens a new conversation, as the terminal does; earlier ones wait in the sidebar.
    base.startNewSession?.("app_start");
    slots[0].runtime.reset?.();
    send({ type: "ready", ...status(), sessions: sessions(), folders: folders(), current: sessionOf(current), running: [], transcript: [] });
    void refreshPlayer();
    schedulePlayer();
  });
}
