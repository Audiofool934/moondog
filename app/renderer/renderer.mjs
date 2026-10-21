// The window's page: conversations on the left, the conversation in the middle, and what is
// playing on the right. The core process does the listening work; this page only draws it.
import { languageTag, windowLocale, windowStrings } from "../strings.mjs";
import { renderMarkdown } from "./markdown.mjs";
import { createPalette } from "./palette.mjs";
import { createPreviews } from "./previews.mjs";
import { createSettings } from "./settings.mjs";
import { createSidebar } from "./sidebar.mjs";
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
const tr = () => t;
// Spotify's state is unknown (null) until the core first reads it. turns and streaming belong to the
// conversation on screen; other conversations keep answering in the core and come back when opened.
const state = { sessions: [], folders: [], running: [], current: null, turns: [], model: null, spotify: null, spotifyAccount: null,
  playbackService: "spotify", locale, locales: [], player: null, streaming: null, ready: false, waiting: null };
const store = {
  get: (key) => { try { return localStorage.getItem(key); } catch { return null; } },
  set: (key, value) => { try { localStorage.setItem(key, value); } catch { /* A private window keeps the default. */ } },
};

// The main process sends the port that reaches the core process. The page draws and takes typing
// before it arrives; messages wait in the outbox until then.
const portReady = new Promise((resolve) => {
  window.addEventListener("message", function receive(event) {
    if (event.source !== window || event.data !== "moondog-room") return;
    window.removeEventListener("message", receive);
    resolve(event.ports[0]);
  });
});
let port = null;
const outbox = [];
const send = (message) => (port ? port.postMessage(message) : outbox.push(message));
const previews = createPreviews({ send, onChange: () => renderInspector() });
const settings = createSettings({ state, send, t: tr, prettyModel: (model) => prettyModel(model) });
const sidebar = createSidebar({ root: $("sessions"), state, send, t: tr, open: (id) => openSession(id), store, menuPoint: (event) => menuPoint(event) });
// A native menu opens at the pointer, or under its control when the keyboard pressed it.
function menuPoint(event) {
  const control = event.currentTarget;
  if (event.type !== "click" || event.detail !== 0 || !control?.getBoundingClientRect) return { x: event.clientX, y: event.clientY };
  const box = control.getBoundingClientRect();
  return { x: box.left, y: box.bottom + 4 };
}

// Words
function applyLanguage(next) {
  locale = next;
  state.locale = next;
  t = windowStrings(locale);
  document.documentElement.lang = languageTag(locale);
  $("new-label").textContent = t("newConversation");
  $("input").placeholder = t("placeholder");
  $("toggle-sidebar").setAttribute("aria-label", t("conversations"));
  $("toggle-inspector").setAttribute("aria-label", t("player"));
  $("settings-button").setAttribute("aria-label", t("settings"));
  $("now-label").textContent = t("nowPlaying");
  $("next-label").textContent = t("upNext");
  $("previous").setAttribute("aria-label", t("previous"));
  $("next").setAttribute("aria-label", t("next"));
  $("drop-hint").textContent = t("dropToImport");
  window.moondogApp?.setLanguage?.(locale);
  renderSessions();
  renderConversation();
}

// Conversations
function renderSessions() {
  sidebar.render();
  renderTitle();
}
function renderTitle() {
  const session = state.sessions.find((entry) => entry.id === state.current);
  const first = state.turns.find((entry) => entry.role === "user")?.text;
  const title = session?.title || first || "";
  $("title").textContent = title.replace(/\s+/gu, " ").trim();
  document.title = title ? `${title.slice(0, 60)} - Moondog` : "Moondog";
}
// Another conversation can open while this one is still answering; it keeps going in the core.
function openSession(id) {
  if (id && id === state.current) return;
  send(id ? { type: "open", id } : { type: "new" });
}

// Notices are short and go away on their own.
let noticeTimer = 0;
function notice(text) {
  const node = $("notice");
  node.textContent = text;
  node.hidden = !text;
  clearTimeout(noticeTimer);
  if (text) noticeTimer = setTimeout(() => { node.hidden = true; }, 6000);
}
const NOTICES = { too_many_running: "noticeTooMany", model_unknown: "noticeModelUnknown", waiting_for_import: "noticeWaitingForImport", delete_running: "noticeDeleteRunning", delete_open_elsewhere: "noticeDeleteElsewhere",
  delete_failed: "noticeDeleteFailed", transfer_failed: "noticeTransferFailed" };

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
  [/^moondog_music_/u, "catalog"],
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
  const reply = make("div", `reply${turn.streaming ? " streaming" : ""}${turn.failed ? " failed" : ""}${turn.local ? " local" : ""}`);
  const played = turn.streaming ? null : playedLine(turn);
  if (played) reply.append(played);
  // What Moondog is doing shows while it works; the reply says what it did.
  if (turn.streaming && (turn.activity?.length || turn.retrying)) {
    const line = make("p", "activity");
    // One entry per kind of work, in the order it started; a failure marks only that kind.
    const kinds = new Map();
    for (const call of turn.activity) {
      const kind = kindOf(call.tool, call.args);
      const previous = kinds.get(kind);
      kinds.set(kind, previous === "running" || call.state === "running" ? "running" : call.state === "failed" && previous !== "done" ? "failed" : "done");
    }
    for (const [kind, status] of kinds) line.append(make("span", status, t(`activity.${kind}`)));
    if (turn.retrying) line.append(make("span", "running", t("retrying")));
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
let drawn = undefined;
const nearBottom = (scroll) => scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
function renderConversation() {
  const column = $("column");
  const scroll = $("scroll");
  // Another conversation opens at its latest turn; the same one keeps where the listener scrolled.
  const opened = drawn !== state.current;
  drawn = state.current;
  const pinned = opened || nearBottom(scroll) || !column.childElementCount;
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
const prettyModel = (model) => {
  const pretty = String(model ?? "").match(/^claude-(opus|sonnet|haiku|fable)-(\d+)-(\d+)/u);
  return pretty ? `${pretty[1][0].toUpperCase()}${pretty[1].slice(1)} ${pretty[2]}.${pretty[3]}` : String(model ?? "");
};
function renderComposer() {
  const button = $("send");
  const streaming = Boolean(state.streaming);
  button.disabled = !streaming && !input.value.trim();
  button.setAttribute("aria-label", streaming ? t("stop") : t("send"));
  button.querySelector("use").setAttribute("href", streaming ? "#i-stop" : "#i-up");
  $("model").textContent = state.model?.model ? prettyModel(state.model.model) : state.model ? t("chooseModel") : "";
  $("device").textContent = state.player?.now?.device ?? "";
}
const grow = () => {
  input.style.height = "auto";
  const limit = innerHeight * 0.4;
  input.style.height = `${Math.min(input.scrollHeight, limit)}px`;
  input.style.overflowY = input.scrollHeight > limit ? "auto" : "hidden";
};
function clearComposer() {
  input.value = "";
  grow();
}
function localNote(markdown) {
  state.turns.push({ role: "assistant", text: markdown, local: true });
  renderConversation();
}
function submit() {
  if (state.streaming) { send({ type: "cancel" }); return; }
  const text = input.value.trim();
  if (!text) return;
  // A message typed while the core starts waits for it, shown as sent.
  if (!state.ready) {
    // One message waits for the core; more stay in the composer until it is ready.
    if (state.waiting) return;
    state.waiting = text;
    state.turns.push({ role: "user", text, waiting: true });
    clearComposer();
    renderConversation();
    return;
  }
  if (state.model?.state !== "configured") {
    state.turns.push({ role: "user", text }, { role: "assistant", text: t("offline"), failed: true });
    clearComposer();
    renderConversation();
    return;
  }
  send({ type: "prompt", text });
  clearComposer();
  renderComposer();
}
$("form").addEventListener("submit", (event) => { event.preventDefault(); submit(); });
input.addEventListener("input", () => { grow(); renderComposer(); });
input.addEventListener("keydown", (event) => {
  // Enter sends; while a reply runs it does nothing, so a typed follow-up waits instead of stopping the reply.
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); if (!state.streaming) submit(); }
  if (event.key === "Escape" && state.streaming) { event.preventDefault(); send({ type: "cancel" }); }
});

// Slash commands
const COMMANDS = [
  { name: "new", description: "cmdNew", run: () => openSession(null) },
  { name: "model", description: "cmdModel", run: () => settings.show("model") },
  { name: "effort", description: "cmdEffort", run: () => settings.show("model") },
  { name: "language", description: "cmdLanguage", run: () => settings.show("general") },
  { name: "service", description: "cmdService", run: () => settings.show("playback") },
  { name: "device", description: "cmdDevice", run: () => settings.show("playback") },
  { name: "import", description: "cmdImport", run: () => settings.show("library") },
  { name: "memory", description: "cmdMemory", run: () => settings.show("memory") },
  { name: "remember", description: "cmdRemember", argument: "cmdRememberArgument", run: (text) => {
    if (!text) return;
    send({ type: "remember", text });
    notice(t("remembered"));
  } },
  { name: "folder", description: "cmdFolder", run: () => {
    if (!shown("sidebar")) togglePanel("sidebar");
    sidebar.startNewFolder();
  } },
  { name: "settings", description: "cmdSettings", run: () => settings.show() },
  { name: "help", description: "cmdHelp", run: () => settings.show("about") },
];
createPalette({ input, anchor: $("form"), t: tr, commands: () => COMMANDS });

// Pickers: the model, the device and the music service open as native menus where they show.
const providerModels = new Map();
let providers = [];
async function pickModel(event) {
  const at = menuPoint(event);
  const model = state.model ?? {};
  const signedIn = providers.filter((provider) => provider.signedIn);
  // A long catalog shows its first models here and the rest in settings.
  const items = signedIn.map((provider) => {
    const models = providerModels.get(provider.id) ?? [];
    const shown = models.slice(0, 24);
    const chosen = models.find((entry) => provider.id === model.provider && entry.id === model.model);
    if (chosen && !shown.includes(chosen)) shown.unshift(chosen);
    const submenu = shown.map((entry) => ({ id: `model:${provider.id}:${entry.id}`, label: entry.name ?? entry.id,
      checked: provider.id === model.provider && entry.id === model.model }));
    if (models.length > 24) submenu.push({ type: "separator" }, { id: "settings", label: t("moreModels") });
    return { id: `provider:${provider.id}`, label: provider.name, submenu };
  }).filter((item) => item.submenu.length);
  if (model.effortLevels?.length) {
    items.push({ type: "separator" }, { id: "effort", label: t("effort"), submenu: ["default", ...model.effortLevels].map((level) => ({ id: `effort:${level}`,
      label: level === "default" ? t("effortDefault") : t(`effort.${level}`) === `effort.${level}` ? level : t(`effort.${level}`), checked: (model.effort ?? "default") === level })) });
  }
  items.push({ type: "separator" }, { id: "settings", label: t("modelSettings") });
  const chosen = await window.moondogApp?.showMenu?.(items, at);
  if (!chosen) return;
  if (chosen === "settings") return settings.show("model");
  if (chosen.startsWith("effort:")) return send({ type: "effort", effort: chosen.slice(7) });
  const [, provider, ...rest] = chosen.split(":");
  if (chosen.startsWith("model:")) send({ type: "model", provider, model: rest.join(":") });
}
let devicePicker = null;
function pickDevice(event) {
  devicePicker = menuPoint(event);
  send({ type: "devices" });
}
async function showDevices(devices) {
  const at = devicePicker;
  devicePicker = null;
  const items = devices.map((device) => ({ id: `device:${device.ref}`, label: device.name, checked: device.active, enabled: !device.restricted }));
  if (!items.length) items.push({ id: "none", label: t("noDevices"), enabled: false });
  items.push({ type: "separator" }, { id: "settings", label: t("playbackSettings") });
  const chosen = await window.moondogApp?.showMenu?.(items, at);
  if (chosen === "settings") settings.show("playback");
  else if (chosen?.startsWith("device:")) send({ type: "transfer", ref: chosen.slice(7) });
}
async function pickService(event) {
  const at = menuPoint(event);
  const chosen = await window.moondogApp?.showMenu?.([
    { id: "spotify", label: "Spotify", checked: state.playbackService === "spotify" },
    { id: "apple_music", label: "Apple Music", checked: state.playbackService === "apple_music" },
    { type: "separator" }, { id: "settings", label: t("playbackSettings") },
  ], at);
  if (chosen === "settings") settings.show("playback");
  else if (chosen) send({ type: "music-service", service: chosen });
}
$("model").addEventListener("click", (event) => void pickModel(event));
$("device").addEventListener("click", (event) => pickDevice(event));
$("device-row").addEventListener("click", (event) => pickDevice(event));
$("status-button").addEventListener("click", (event) => void pickService(event));
$("settings-button").addEventListener("click", () => settings.show());

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
const serviceName = () => (state.playbackService === "apple_music" ? "Apple Music" : "Spotify");
const fullSong = make("a");
fullSong.target = "_blank";
let drawnQueue = "";
function queueItem(track) {
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
  const ready = state.playbackService === "apple_music" || state.spotify === "ready";
  $("artist").textContent = now ? now.artists.join(", ") : ready ? t("nothingHint") : state.spotify ? t("spotifyOff") : "";
  // The inspector redraws several times a second while music plays, so its nodes change only when their content does.
  const album = $("album");
  if (now?.preview && now.link) {
    if (fullSong.getAttribute("href") !== now.link) fullSong.href = now.link;
    if (fullSong.textContent !== t("fullSong")) fullSong.textContent = t("fullSong");
    if (album.firstChild !== fullSong) album.replaceChildren(fullSong);
  } else if (album.firstChild === fullSong || album.textContent !== (now?.album ?? "")) album.textContent = now?.album ?? "";
  $("progress").hidden = !now?.durationMs;
  if (now?.durationMs) {
    $("bar").style.width = `${Math.min(100, (now.progressMs / now.durationMs) * 100)}%`;
    $("elapsed").textContent = clock(now.progressMs);
    $("duration").textContent = clock(now.durationMs);
  }
  $("device-row").hidden = !now?.device;
  $("device-name").textContent = now?.device ?? "";
  $("repeat").hidden = now?.repeat !== "track";
  $("repeat").textContent = t("repeatOne");
  const next = now?.next ?? [];
  $("next-panel").hidden = !next.length;
  const shownQueue = JSON.stringify(next.map((track) => [track.title, track.artists, track.image]));
  if (shownQueue !== drawnQueue) {
    drawnQueue = shownQueue;
    $("queue").replaceChildren(...next.map(queueItem));
  }
  const on = state.playbackService === "apple_music" || state.spotify === "ready";
  $("spotify-dot").classList.toggle("on", on);
  $("status").textContent = state.spotify === null ? "" : on ? serviceName() : t("spotifyOff").split(/[.。]/u)[0];
  renderComposer();
}
setInterval(() => { if (nowPlaying()?.playing) renderInspector(); }, 500);

function control(action, via = "button") {
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
    send({ type: "control", action: now.playing ? "pause" : "resume", via });
    state.player.now = { ...now, playing: !now.playing, progressMs: nowPlaying().progressMs, observedAt: Date.now() };
    renderInspector();
  } else send({ type: "control", action, via });
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

// A music history file dropped anywhere goes to import, which shows what it read before saving.
let dragDepth = 0;
const hasFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes("Files");
window.addEventListener("dragenter", (event) => { if (!hasFiles(event)) return; dragDepth += 1; $("drop").hidden = false; });
window.addEventListener("dragleave", (event) => { if (!hasFiles(event)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $("drop").hidden = true; });
window.addEventListener("dragover", (event) => { if (hasFiles(event)) event.preventDefault(); });
window.addEventListener("drop", (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth = 0;
  $("drop").hidden = true;
  const file = event.dataTransfer.files[0];
  const path = file ? window.moondogApp?.pathForFile?.(file) : null;
  if (path) { send({ type: "import-file", path }); settings.show("library"); }
});

// Keys: typing anywhere goes to the composer. No key here plays, pauses or skips: a chat window is
// typed in all the time, and the keyboard's media keys already control the music.
document.addEventListener("keydown", (event) => {
  if (settings.open) return;
  if (event.target === input || event.target.closest?.("input, textarea")) return;
  if (event.key === " " && event.target.closest?.("button, a, select, [role=button]")) return;
  if (event.key === "Escape" && state.streaming) { send({ type: "cancel" }); return; }
  if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) input.focus();
});
// Commands from the menu bar.
window.moondogApp?.onCommand?.((command) => {
  if (command === "new") openSession(null);
  if (command === "stop" && state.streaming) send({ type: "cancel" });
  if (command === "settings") settings.show();
  if (command === "toggle-playback") control("toggle", "menu");
  if (command === "next") control("next", "menu");
  if (command === "previous") control("previous", "menu");
  if (command === "toggle-sidebar") togglePanel("sidebar");
  if (command === "toggle-inspector") togglePanel("inspector");
});
document.addEventListener("visibilitychange", () => send({ type: "visible", visible: !document.hidden }));
window.addEventListener("focus", () => { if (!settings.open && !getSelection()?.toString() && !document.activeElement?.closest?.(".rename")) input.focus(); });

// Messages from the core
function streamingTurn(id) {
  return state.turns.find((turn) => turn.role === "assistant" && turn.id === id);
}
const onScreen = (data) => !data.session || data.session === state.current;
const SIGN_IN_ERRORS = { connect_while_answering: "connectWhileAnswering", sign_in_busy: "signInBusy" };
const SETTINGS_MESSAGES = new Set(["models", "provider-models", "devices", "memories", "auth-prompt", "auth-prompt-closed", "auth-event", "sign-in", "import"]);
function receive({ data }) {
  if (!data?.type) return;
  if (data.type === "preview" || data.type === "preview-control") { previews.receive(data); renderInspector(); return; }
  if (SETTINGS_MESSAGES.has(data.type)) settings.receive(data);
  if (data.type === "models") {
    providers = data.providers ?? [];
    for (const provider of providers) if (provider.signedIn && !providerModels.has(provider.id)) send({ type: "provider-models", provider: provider.id });
  }
  if (data.type === "provider-models") providerModels.set(data.provider, data.models ?? []);
  if (data.type === "devices" && devicePicker) {
    if (data.error) { devicePicker = null; notice(t("noticeDevicesFailed")); } else void showDevices(data.devices ?? []);
  }
  if (data.type === "player-error") notice(t("noticePlaybackFailed"));
  if (data.type === "sign-in" && data.state === "error") notice(SIGN_IN_ERRORS[data.code] ? t(SIGN_IN_ERRORS[data.code]) : data.message || t("signInFailed"));
  if (data.type === "import" && data.stage === "refresh-failed") notice(t("importRefreshFailed"));
  if (data.type === "notice") notice(t(NOTICES[data.code] ?? "noticeFailed") + (NOTICES[data.code] ? "" : data.message ? `: ${data.message}` : ""));
  if (data.type === "ready" || data.type === "status") {
    if (data.locale && data.locale !== locale) applyLanguage(data.locale);
    for (const key of ["model", "spotify", "spotifyAccount", "playbackService", "locales"]) if (data[key] !== undefined) state[key] = data[key];
    renderComposer();
    renderInspector();
    settings.render();
  }
  if (data.type === "ready" || data.type === "sessions") {
    state.sessions = data.sessions ?? [];
    state.folders = data.folders ?? [];
    state.running = data.running ?? [];
    state.current = data.current ?? state.current;
    window.moondogApp?.setBusy?.(state.running.length > 0);
    renderSessions();
  }
  if (data.type === "ready" || data.type === "session") {
    state.current = data.current ?? null;
    state.turns = (data.transcript ?? []).map((turn) => ({ ...turn }));
    state.streaming = null;
    if (data.live) {
      state.turns.push({ role: "user", text: data.live.user },
        { role: "assistant", id: data.live.id, text: data.live.text, activity: data.live.activity ?? [], streaming: true });
      state.streaming = data.live.id;
    }
    renderSessions();
    renderConversation();
    if (!settings.open) input.focus();
  }
  if (data.type === "ready") {
    state.ready = true;
    send({ type: "models" });
    const waiting = state.waiting;
    state.waiting = null;
    if (waiting && state.model?.state === "configured") send({ type: "prompt", text: waiting });
    else if (waiting) {
      state.turns.push({ role: "user", text: waiting }, { role: "assistant", text: t("offline"), failed: true });
      renderConversation();
    }
  }
  if (data.type === "local" && onScreen(data)) localNote(data.markdown);
  if (data.type === "turn" && onScreen(data)) {
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
      if (state.streaming === data.id) state.streaming = null;
    }
    renderConversation();
  }
  if (data.type === "retry" && onScreen(data)) {
    const turn = streamingTurn(data.id);
    if (turn) { turn.retrying = true; renderSoon(); }
  }
  if (data.type === "text" && onScreen(data)) {
    const turn = streamingTurn(data.id);
    if (turn) {
      turn.retrying = false;
      turn.text = data.replace !== undefined ? data.replace : `${turn.text}${data.delta ?? ""}`;
      renderSoon();
    }
  }
  if (data.type === "activity" && onScreen(data)) {
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
}

applyLanguage(locale);
renderPanels();
renderConversation();
renderInspector();
send({ type: "visible", visible: !document.hidden });
input.focus();

// The core's port arrives last; what was sent before it waits in the outbox.
port = await portReady;
port.onmessage = receive;
for (const message of outbox.splice(0)) port.postMessage(message);
