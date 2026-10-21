// The window's page: conversations on the left, the conversation in the middle, and what is
// playing on the right. The core process does the listening work; this page only draws it.
import { languageTag, windowLocale, windowStrings } from "../strings.mjs";
import { renderMarkdown } from "./markdown.mjs";
import { createPreviews } from "./previews.mjs";
import "./style.css";

const $ = (selector) => document.querySelector(`[data-${selector}]`);
const make = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

let locale = windowLocale(navigator.languages);
let t = windowStrings(locale);
// Spotify's state is unknown (null) until the core first reads it.
const state = { sessions: [], current: null, turns: [], model: null, spotify: null, player: null, streaming: null, ready: false, waiting: null };
const store = {
  get: (key) => { try { return localStorage.getItem(key); } catch { return null; } },
  set: (key, value) => { try { localStorage.setItem(key, value); } catch { /* A private window keeps the default. */ } },
};

// The main process sends the port that reaches the core process.
const port = await new Promise((resolve) => {
  window.addEventListener("message", function receive(event) {
    if (event.source !== window || event.data !== "moondog-room") return;
    window.removeEventListener("message", receive);
    resolve(event.ports[0]);
  });
});
const send = (message) => port.postMessage(message);
const previews = createPreviews({ send, onChange: () => renderInspector() });

// Words
function applyLanguage(next) {
  locale = next;
  t = windowStrings(locale);
  document.documentElement.lang = languageTag(locale);
  $("new-label").textContent = t("newConversation");
  $("input").placeholder = t("placeholder");
  $("toggle-sidebar").setAttribute("aria-label", t("conversations"));
  $("toggle-inspector").setAttribute("aria-label", t("player"));
  $("now-label").textContent = t("nowPlaying");
  $("next-label").textContent = t("upNext");
  $("previous").setAttribute("aria-label", t("previous"));
  $("next").setAttribute("aria-label", t("next"));
}

// Conversations
const dayStart = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
function groupOf(updatedAt) {
  const days = Math.round((dayStart(new Date()) - dayStart(new Date(updatedAt))) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : days < 7 ? "previous7" : "older";
}
function renderSessions() {
  const nav = $("sessions");
  nav.replaceChildren();
  let group = null;
  for (const session of state.sessions) {
    const name = groupOf(session.updatedAt);
    if (name !== group) { nav.append(make("h2", "", t(name))); group = name; }
    const row = make("button", "", session.title || t("untitled"));
    row.type = "button";
    row.title = session.title || t("untitled");
    row.dataset.session = session.id;
    if (session.id === state.current) row.setAttribute("aria-current", "true");
    row.addEventListener("click", () => openSession(session.id));
    nav.append(row);
  }
  renderTitle();
}
function renderTitle() {
  const session = state.sessions.find((entry) => entry.id === state.current);
  const first = state.turns.find((entry) => entry.role === "user")?.text;
  const title = session?.title || first || "";
  $("title").textContent = title.replace(/\s+/gu, " ").trim();
  document.title = title ? `${title.slice(0, 60)} - Moondog` : "Moondog";
}
function openSession(id) {
  if (state.streaming || id === state.current) return;
  send(id ? { type: "open", id } : { type: "new" });
}

// The conversation
const KINDS = [
  [/^moondog_spotify_player_control$/u, (args) => ({ pause: "pause", next: "skip", previous: "skip" })[args?.action] ?? "play"],
  [/^moondog_spotify_(?:search|discover|resolve_tracks|catalog_items)$/u, "search"],
  [/^moondog_spotify_queue_(?:add|batch|similar)$/u, "queue"],
  [/^moondog_spotify_devices$/u, "devices"],
  [/^moondog_spotify_device_transfer$/u, "move"],
  [/^moondog_spotify_(?:player_status|now_playing|queue_status)$/u, "status"],
  [/^moondog_web_/u, "web"],
  [/^moondog_(?:playlist_plan|spotify_playlist_)/u, "playlist"],
  [/^moondog_music_preview$/u, "previews"],
  [/^moondog_memory_/u, "memory"],
  [/^moondog_music_/u, "search"],
  [/^moondog_(?:profile_|library_|rediscovery|historical_return|time_capsule|back_to_back|spotify_top|spotify_history|spotify_library)/u, "profile"],
];
const kindOf = (tool, args) => {
  const found = KINDS.find(([pattern]) => pattern.test(tool));
  return found ? (typeof found[1] === "function" ? found[1](args) : found[1]) : "other";
};

// After a turn, a song it started shows as one quiet line with its cover. Covers are kept by
// title as the player reports them, because the player's next read can arrive after the turn.
const covers = new Map();
const playedTarget = (turn) => (turn.receipts ?? []).find((receipt) => receipt.action === "playback.resume" && receipt.state === "accepted")?.targets?.[0];
function playedLine(turn) {
  const target = playedTarget(turn);
  if (!target?.title) return null;
  const line = make("p", "played");
  if (covers.has(target.title)) {
    const image = make("img");
    image.src = covers.get(target.title);
    image.alt = "";
    line.append(image);
  }
  line.append(make("span", "", target.title), make("span", "by", target.artist_credit ?? ""));
  return line;
}

function replyNode(turn) {
  const reply = make("div", `reply${turn.streaming ? " streaming" : ""}${turn.failed ? " failed" : ""}`);
  const played = turn.streaming ? null : playedLine(turn);
  if (played) reply.append(played);
  // What Moondog is doing shows while it works; the reply says what it did.
  if (turn.streaming && turn.activity?.length) {
    const line = make("p", "activity");
    // One entry per kind of work, in the order it started; a failure marks only that kind.
    const kinds = new Map();
    for (const call of turn.activity) {
      const kind = kindOf(call.tool, call.args);
      const previous = kinds.get(kind);
      kinds.set(kind, previous === "running" || call.state === "running" ? "running" : call.state === "failed" && previous !== "done" ? "failed" : "done");
    }
    for (const [kind, status] of kinds) line.append(make("span", status, t(`activity.${kind}`)));
    reply.append(line);
  }
  const text = make("div", "text");
  if (turn.text) text.append(renderMarkdown(turn.text));
  else if (turn.streaming) text.append(make("p", "", ""));
  reply.append(text);
  return reply;
}
// The streaming reply redraws on its own; the rest of the conversation stays put.
let liveNode = null;
const nearBottom = (scroll) => scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
function renderConversation() {
  const column = $("column");
  const scroll = $("scroll");
  const pinned = nearBottom(scroll) || !column.childElementCount;
  liveNode = null;
  column.replaceChildren();
  if (!state.turns.length) {
    const empty = make("div", "empty");
    empty.append(make("p", "", t("empty")));
    column.append(empty);
    column.style.height = "100%";
  } else column.style.height = "";
  for (const turn of state.turns) {
    if (turn.role === "user") {
      const you = make("div", "you");
      you.append(make("p", "", turn.text));
      column.append(you);
    } else {
      const node = replyNode(turn);
      if (turn.streaming && turn.id === state.streaming) liveNode = node;
      column.append(node);
    }
  }
  if (pinned) scroll.scrollTop = scroll.scrollHeight;
  renderTitle();
  renderComposer();
}
function renderLive() {
  const turn = state.turns.find((entry) => entry.role === "assistant" && entry.id === state.streaming);
  if (!turn || !liveNode?.isConnected) { renderConversation(); return; }
  const scroll = $("scroll");
  const pinned = nearBottom(scroll);
  const next = replyNode(turn);
  liveNode.replaceWith(next);
  liveNode = next;
  if (pinned) scroll.scrollTop = scroll.scrollHeight;
}
let frame = 0;
const renderSoon = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; (state.streaming ? renderLive : renderConversation)(); }); };

// The composer
const input = $("input");
function renderComposer() {
  const button = $("send");
  const streaming = Boolean(state.streaming);
  button.disabled = !streaming && !input.value.trim();
  button.setAttribute("aria-label", streaming ? t("stop") : t("send"));
  button.querySelector("use").setAttribute("href", streaming ? "#i-stop" : "#i-up");
  const model = state.model?.model ?? "";
  const pretty = model.match(/^claude-(opus|sonnet|haiku|fable)-(\d+)-(\d+)/u);
  $("model").textContent = pretty ? `${pretty[1][0].toUpperCase()}${pretty[1].slice(1)} ${pretty[2]}.${pretty[3]}` : model;
  $("device").textContent = state.player?.now?.device ?? "";
}
const grow = () => {
  input.style.height = "auto";
  const limit = innerHeight * 0.4;
  input.style.height = `${Math.min(input.scrollHeight, limit)}px`;
  input.style.overflowY = input.scrollHeight > limit ? "auto" : "hidden";
};
function submit() {
  if (state.streaming) { send({ type: "cancel" }); return; }
  const text = input.value.trim();
  if (!text) return;
  // A message typed while the core starts waits for it, shown as sent.
  if (!state.ready) {
    state.waiting = text;
    state.turns.push({ role: "user", text, waiting: true });
    input.value = "";
    grow();
    renderConversation();
    return;
  }
  if (state.model?.state !== "configured") {
    state.turns.push({ role: "user", text }, { role: "assistant", text: t("offline"), failed: true });
    input.value = "";
    grow();
    renderConversation();
    return;
  }
  send({ type: "prompt", text });
  input.value = "";
  grow();
  renderComposer();
}
$("form").addEventListener("submit", (event) => { event.preventDefault(); submit(); });
input.addEventListener("input", () => { grow(); renderComposer(); });
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); submit(); }
  if (event.key === "Escape" && state.streaming) { event.preventDefault(); send({ type: "cancel" }); }
});

// What is playing
const clock = (ms) => {
  const seconds = Math.max(0, Math.floor((ms ?? 0) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};
function nowPlaying() {
  const preview = previews.state();
  if (preview) return { ...preview, preview: true };
  const now = state.player?.now;
  if (!now) return null;
  const progressMs = now.playing ? now.progressMs + (Date.now() - now.observedAt) : now.progressMs;
  return { ...now, progressMs: now.durationMs ? Math.min(progressMs, now.durationMs) : progressMs, next: state.player.next ?? [] };
}
function renderInspector() {
  const now = nowPlaying();
  const cover = $("cover");
  cover.hidden = !now?.image;
  if (now?.image && cover.getAttribute("src") !== now.image) cover.src = now.image;
  $("blank").hidden = Boolean(now?.image);
  $("art").classList.toggle("unplayed", !now?.image);
  $("controls").hidden = !now;
  const toggle = $("toggle");
  toggle.setAttribute("aria-label", now?.playing ? t("pause") : t("play"));
  toggle.querySelector("use").setAttribute("href", now?.playing ? "#i-pause" : "#i-play");
  const badge = $("badge");
  badge.hidden = !now?.preview;
  badge.textContent = t("preview");
  $("song").textContent = now ? now.title : t("nothingPlaying");
  $("artist").textContent = now ? now.artists.join(", ") : state.spotify === "ready" ? t("nothingHint") : state.spotify ? t("spotifyOff") : "";
  const album = $("album");
  album.replaceChildren();
  if (now?.preview && now.link) {
    const link = make("a", "", t("fullSong"));
    link.href = now.link;
    link.target = "_blank";
    album.append(link);
  } else if (now?.album) album.textContent = now.album;
  $("progress").hidden = !now?.durationMs;
  if (now?.durationMs) {
    $("bar").style.width = `${Math.min(100, (now.progressMs / now.durationMs) * 100)}%`;
    $("elapsed").textContent = clock(now.progressMs);
    $("duration").textContent = clock(now.durationMs);
  }
  $("device-row").hidden = !now?.device;
  $("device-name").textContent = now?.device ?? "";
  const next = now?.next ?? [];
  $("next-panel").hidden = !next.length;
  $("queue").replaceChildren(...next.map((track) => {
    const item = make("li");
    if (track.image) {
      const image = make("img");
      image.src = track.image;
      image.alt = "";
      item.append(image);
    } else item.append(make("span", "thumb"));
    const words = make("div");
    words.append(make("strong", "", track.title), make("span", "", track.artists.join(", ")));
    item.append(words);
    return item;
  }));
  $("spotify-dot").classList.toggle("on", state.spotify === "ready");
  $("status").textContent = state.spotify === "ready" ? "Spotify" : state.spotify ? t("spotifyOff").split(/[.。]/u)[0] : "";
  renderComposer();
}
setInterval(() => { if (nowPlaying()?.playing) renderInspector(); }, 500);

function control(action) {
  if (previews.active()) {
    if (action === "toggle") previews.toggle();
    if (action === "next") previews.next();
    if (action === "previous") previews.previous();
    return;
  }
  const now = state.player?.now;
  if (!now) return;
  if (action === "toggle") {
    // The cover answers at once; the next read from Spotify confirms it.
    send({ type: "control", action: now.playing ? "pause" : "resume" });
    state.player.now = { ...now, playing: !now.playing, progressMs: nowPlaying().progressMs, observedAt: Date.now() };
    renderInspector();
  } else send({ type: "control", action });
}
$("toggle").addEventListener("click", () => control("toggle"));
$("next").addEventListener("click", () => control("next"));
$("previous").addEventListener("click", () => control("previous"));

// Panels: a narrow window folds the player, then the conversations; a click always wins.
const layout = $("window");
const panels = { sidebar: store.get("moondog.sidebar") !== "hidden", inspector: store.get("moondog.inspector") !== "hidden" };
const room = { sidebar: 820, inspector: 1080 };
const forced = { sidebar: false, inspector: false };
const shown = (name) => panels[name] && (forced[name] || innerWidth >= room[name]);
function renderPanels() {
  layout.classList.toggle("no-sidebar", !shown("sidebar"));
  layout.classList.toggle("no-inspector", !shown("inspector"));
}
function togglePanel(name) {
  const visible = shown(name);
  panels[name] = !visible;
  forced[name] = !visible;
  store.set(`moondog.${name}`, panels[name] ? "shown" : "hidden");
  renderPanels();
}
addEventListener("resize", renderPanels);

// Dragging a panel's inner edge sets its width; a double-click restores the default.
const widths = { sidebar: [200, 440], inspector: [260, 480] };
for (const name of ["sidebar", "inspector"]) {
  const property = `--${name}-width`;
  const saved = Number(store.get(`moondog.${name}.width`));
  if (saved >= widths[name][0] && saved <= widths[name][1]) layout.style.setProperty(property, `${saved}px`);
  const grip = document.querySelector(`[data-grip="${name}"]`);
  grip.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    grip.setPointerCapture(event.pointerId);
    grip.classList.add("dragging");
    layout.classList.add("resizing");
    const move = (moved) => {
      const width = name === "sidebar" ? moved.clientX : innerWidth - moved.clientX;
      const clamped = Math.round(Math.min(widths[name][1], Math.max(widths[name][0], width)));
      layout.style.setProperty(property, `${clamped}px`);
    };
    const up = () => {
      grip.removeEventListener("pointermove", move);
      grip.classList.remove("dragging");
      layout.classList.remove("resizing");
      store.set(`moondog.${name}.width`, String(parseInt(getComputedStyle(layout).getPropertyValue(property), 10) || ""));
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up, { once: true });
    grip.addEventListener("pointercancel", up, { once: true });
  });
  grip.addEventListener("dblclick", () => {
    layout.style.removeProperty(property);
    store.set(`moondog.${name}.width`, "");
  });
}
$("toggle-sidebar").addEventListener("click", () => togglePanel("sidebar"));
$("toggle-inspector").addEventListener("click", () => togglePanel("inspector"));
$("new").addEventListener("click", () => openSession(null));

// Keys: typing anywhere goes to the composer. No key here plays, pauses or skips: a chat window is
// typed in all the time, and the keyboard's media keys already control the music.
document.addEventListener("keydown", (event) => {
  if (event.target === input || event.target.closest?.("input, textarea")) return;
  if (event.key === "Escape" && state.streaming) { send({ type: "cancel" }); return; }
  if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) input.focus();
});
// Commands from the menu bar.
window.moondogApp?.onCommand?.((command) => {
  if (command === "new") openSession(null);
  if (command === "stop" && state.streaming) send({ type: "cancel" });
  if (command === "toggle-playback") control("toggle");
  if (command === "next") control("next");
  if (command === "previous") control("previous");
  if (command === "toggle-sidebar") togglePanel("sidebar");
  if (command === "toggle-inspector") togglePanel("inspector");
});
document.addEventListener("visibilitychange", () => send({ type: "visible", visible: !document.hidden }));
window.addEventListener("focus", () => { if (!getSelection()?.toString()) input.focus(); });

// Messages from the core
function streamingTurn(id) {
  return state.turns.find((turn) => turn.role === "assistant" && turn.id === id);
}
port.onmessage = ({ data }) => {
  if (!data?.type) return;
  if (data.type === "preview" || data.type === "preview-control") { previews.receive(data); renderInspector(); return; }
  if (data.type === "ready" || data.type === "status") {
    if (data.locale) applyLanguage(data.locale);
    state.model = data.model ?? state.model;
    state.spotify = data.spotify ?? state.spotify;
    window.moondogApp?.setLanguage?.(locale);
  }
  if (data.type === "ready" || data.type === "sessions") {
    state.sessions = data.sessions ?? [];
    state.current = data.current ?? state.current;
    renderSessions();
  }
  if (data.type === "ready" || data.type === "session") {
    state.current = data.current ?? null;
    state.turns = (data.transcript ?? []).map((turn) => ({ ...turn }));
    renderSessions();
    renderConversation();
    input.focus();
  }
  if (data.type === "ready") {
    state.ready = true;
    const waiting = state.waiting;
    state.waiting = null;
    if (waiting) { input.value = waiting; submit(); }
  }
  if (data.type === "turn") {
    window.moondogApp?.setBusy?.(data.state === "start");
    if (data.state === "start") {
      state.streaming = data.id;
      state.turns.push({ role: "user", text: data.text }, { role: "assistant", id: data.id, text: "", activity: [], streaming: true });
    } else {
      const turn = streamingTurn(data.id);
      if (turn) {
        turn.streaming = false;
        if (data.state === "end") {
          turn.receipts = data.receipts ?? [];
          turn.text = data.text || turn.text || (data.status === "aborted" ? t("stopped") : "");
          if (data.status === "aborted" && !data.text) turn.failed = true;
        } else {
          turn.text = data.connection ? t("unreachable") : data.message;
          turn.failed = true;
        }
      }
      state.streaming = null;
    }
    renderConversation();
  }
  if (data.type === "text") {
    const turn = streamingTurn(data.id);
    if (turn) {
      turn.text = data.replace !== undefined ? data.replace : `${turn.text}${data.delta ?? ""}`;
      renderSoon();
    }
  }
  if (data.type === "activity") {
    const turn = streamingTurn(data.id);
    if (turn) {
      const existing = turn.activity.find((call) => call.call === data.call);
      if (existing) existing.state = data.state;
      else turn.activity.push({ call: data.call, tool: data.tool, args: data.args, state: data.state });
      renderSoon();
    }
  }
  if (data.type === "player") {
    // A read that fails, such as a network blip, keeps the last known player on screen.
    if (data.spotify === "error") return;
    state.spotify = data.spotify === "ready" ? "ready" : "unavailable";
    state.player = { now: data.now, next: data.next ?? [] };
    let learned = false;
    for (const track of [data.now, ...(data.next ?? [])]) {
      if (track?.image && covers.get(track.title) !== track.image) { covers.set(track.title, track.image); learned = true; }
    }
    // Redraw the conversation only when a played line just got its cover.
    if (learned && !state.streaming && state.turns.some((turn) => { const target = playedTarget(turn); return target && covers.has(target.title); })) renderSoon();
    renderInspector();
  }
};

applyLanguage(locale);
renderPanels();
renderConversation();
renderInspector();
send({ type: "visible", visible: !document.hidden });
input.focus();
