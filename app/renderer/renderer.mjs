// The window's page: conversations on the left, the conversation in the middle, and what is
// playing on the right. The core process does the listening work; this page only draws it.
import { languageTag, timeOfDay, windowLocale, windowStrings } from "../strings.mjs";
import { renderMarkdown } from "./markdown.mjs";
import { createFirstRun } from "./first-run.mjs";
import { createPalette } from "./palette.mjs";
import { createPreviews } from "./previews.mjs";
import { coverPalette, grooveColours, moodColours } from "./mood.mjs";
import { createMark, scratchMark } from "./mark.mjs";
import { mountRecord } from "./record.mjs";
import { createSettings, EFFORTS } from "./settings.mjs";
import { createSidebar } from "./sidebar.mjs";
import { isMac, platform, shortcuts } from "./platform.mjs";
import { coverUrl, createLibrary } from "./library.mjs";
import { createMentions } from "./mentions.mjs";
import { createShelf } from "./shelf.mjs";
import { createTaste } from "./taste.mjs";
import { createTasteList } from "./taste-list.mjs";
import { createSidebarViews } from "./views.mjs";
import { discButton } from "./disc.mjs";
import { icon, make, marquee, name, scrollbar, setIcon, tooltips } from "./ui.mjs";
import "./style.css";

const $ = (selector) => document.querySelector(`[data-${selector}]`);
document.documentElement.dataset.platform = platform;

let locale = windowLocale(navigator.languages);
let t = windowStrings(locale);
const tr = () => t;
// Spotify's state is unknown (null) until the core first reads it, and so is the first run. turns and
// streaming belong to the conversation on screen; other conversations keep answering in the core and
// come back when opened. streaming is a reply being written; onAir is Moondog's own channel.
const state = { sessions: [], folders: [], running: [], current: null, turns: [], model: null, spotify: null, spotifyAccount: null,
  playbackService: "spotify", locale, locales: [], player: null, streaming: null, ready: false, waiting: null, update: { phase: "idle" }, firstRun: null,
  onAir: null,
  // The listener's library, and the playlist open in the room in the conversation's place ({ id, playlist }, or none).
  library: { folders: [], playlists: [] }, shelf: null,
  // The listener's taste: the core's latest page of it, for the taste view and the page, and the page open in the
  // room in the conversation's place ({} while open, or none).
  tasteData: null, taste: null };
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
// The composer's send button and the player's play button are record buttons (disc.mjs), as the playlist's play button is.
const sendDisc = discButton($("send"), { size: 26, glyph: "send" });
const playerDisc = discButton($("toggle"), { size: 46, glyph: "pause", fill: true });
const settings = createSettings({ state, send, t: tr,
  appleMusic: { status: () => previews.fullStatus(), check: (command) => previews.check(command) }, onHide: () => firstRun.update() });
// The one-time first run asks for a music service, then a model, in the Settings sheet (first-run.mjs).
const firstRun = createFirstRun({ settings, send, read: () => ({ run: state.firstRun, modelReady: state.model?.state === "configured" }) });
const sidebar = createSidebar({ root: $("sessions"), state, send, t: tr, open: (id) => openSession(id), store, menuPoint: (event) => menuPoint(event) });
const library = createLibrary({ root: $("library"), state, send, t: tr, open: (id) => openPlaylist(id), store, menuPoint: (event) => menuPoint(event),
  onBusy: (value) => views.setBusy("library", value),
  onExport: (playlist) => exportPlaylist(playlist) });
const shelf = createShelf({ root: $("shelf"), state, send, t: tr, menuPoint: (event) => menuPoint(event), onClose: () => closePlaylist(),
  onExport: (playlist) => exportPlaylist(playlist) });
const taste = createTaste({ root: $("taste"), state, send, t: tr, onClose: () => closeTaste() });
// The taste view in the sidebar: a row unfolded there opens the page and lights that artist across its record.
const tasteList = createTasteList({ root: $("taste-list"), state, send, t: tr, onAsk: (text) => askFromTaste(text),
  onSelect: (name) => { if (name && !state.taste) openTaste({ fromView: true }); taste.pin(name); } });
const tips = tooltips();
// Native menus open as macOS opens them. A control's own menu, by a click, Enter or Space, drops below the
// control, as a pull-down button's does (a row's ⋯, a view's +). A right-click opens at the pointer, and the
// context menu key or Shift+F10 under the focused item. A handler that awaited has lost the event's
// currentTarget, so the control is also found from the target.
function menuPoint(event) {
  if (!event) return undefined;
  const control = event.type === "click" ? event.currentTarget ?? event.target?.closest?.("button, [role=button]")
    : event.type === "keydown" ? event.currentTarget ?? event.target : null;
  if (control?.getBoundingClientRect) return below(control);
  return { x: event.clientX, y: event.clientY };
}
const below = (control) => { const box = control.getBoundingClientRect(); return { x: box.left, y: box.bottom + 4 }; };
// A menu that chooses what its control shows, such as a split header's switcher or the composer's model, opens as
// a native pop-up button does: over the control, its current choice set on the control's words. The menu's text
// sits past its check column, so the menu starts that far before the words. Electron sets the choice there only
// on macOS (positioningItem), so elsewhere the menu drops below the control.
const MENU_TEXT_INSET = 21;
const MENU_ROW = 22;
function menuAt(event, anchor) {
  const words = anchor?.element;
  if (!words?.getBoundingClientRect) return menuPoint(event);
  if (!isMac) return below(anchor.control ?? words);
  const box = words.getBoundingClientRect();
  return { x: box.left - MENU_TEXT_INSET, y: box.top + box.height / 2 - MENU_ROW / 2,
    ...(Number.isInteger(anchor.selected) && anchor.selected >= 0 ? { positioningItem: anchor.selected } : {}) };
}
// A picker's pop-up: its words, or its mark when it shows only that, and the item checked in its menu.
function popUp(control, items) {
  const words = control.querySelector("span");
  return { control, element: words?.textContent ? words : control.querySelector(".icon") ?? control,
    selected: Math.max(0, items.findIndex((item) => item.checked)) };
}
const menu = (items, event, anchor) => window.moondogApp?.showMenu?.(items, menuAt(event, anchor));

// Words
function applyLanguage(next) {
  locale = next;
  state.locale = next;
  t = windowStrings(locale);
  document.documentElement.lang = languageTag(locale);
  renderPlaceholder();
  name($("library-add"), t("libraryAdd"), "@");
  name($("toggle-sidebar"), t("conversations"), shortcuts.sidebar);
  name($("toggle-inspector"), t("player"), shortcuts.player);
  name($("new"), t("newConversation"), shortcuts.new);
  renderSidebarMode();
  name($("keep"), t("saveToSaved"));
  // These self-explanatory controls keep accessible names without floating labels over the record.
  for (const [node, key] of [[recordButton, "foldRecord"], [barRecord, "showRecord"], [$("expand"), "immerse"], [$("pin"), "keepOnTop"], [$("immersive"), "restore"]]) {
    node.setAttribute("aria-label", t(key));
  }
  name($("settings-button"), t("settings"), shortcuts.settings);
  renderUpdate();
  name($("previous"), t("previous"), shortcuts.previous);
  name($("next"), t("next"), shortcuts.next);
  name($("mini-next"), t("next"), shortcuts.next);
  $("device-row").dataset.tip = t("devices");
  $("track").setAttribute("aria-label", t("position"));
  name($("jump"), t("latest"));
  name($("repeat"), t("repeatOne"));
  name($("stop-previews"), t("stopPreviews"));
  // The song link names itself for the service it opens; clearing it makes the next draw name it again.
  $("external").removeAttribute("href");
  $("now").setAttribute("aria-label", t("nowPlaying"));
  $("next-label").textContent = t("upNext");
  $("drop-hint").textContent = t("dropToImport");
  $("connect").textContent = t("connectSpotify");
  $("connect-player").textContent = t("connectSpotify");
  window.moondogApp?.setLanguage?.(locale);
  palette?.refresh();
  renderSessions();
  renderConversation({ redraw: true });
  renderInspector();
}

// Conversations
function renderSessions() {
  sidebar.render();
  renderTitle();
}
// The open conversation's name sits in the bar only when the list that already shows it is folded away.
function renderTitle() {
  const session = state.sessions.find((entry) => entry.id === state.current);
  const first = state.turns.find((entry) => entry.role === "user")?.text;
  const title = (session?.title || first || "").replace(/\s+/gu, " ").trim();
  $("title").textContent = shown("sidebar") ? "" : title;
  document.title = title ? `${title.slice(0, 60)} - Moondog` : "Moondog";
  // The folded record sits before the title, so it moves when the title does.
  placeSoon();
}
// The sidebar's views, conversations and the library, as tabs or split (views.mjs). The bar's own switch only shows
// and hides the sidebar; which view shows is the sidebar's business, so the two never fight.
const views = createSidebarViews({ root: $("sidebar"), store, t: tr, menu: (items, event, anchor) => menu(items, event, anchor), onShow: (view) => {
  // Back to the conversations as the one tab is back to the conversation, so a playlist open in the room closes.
  if (view === "conversations" && views?.layout.mode === "tabs" && state.shelf) closePlaylist();
  if (views?.showing("library")) library.render();
  // The taste view asks the core for the profile; as the one tab, it brings the taste page into the room, and
  // turning to another tab takes the page away, as the conversations take a playlist away.
  if (view === "taste") { send({ type: "taste" }); tasteList.render(); if (views?.layout.mode === "tabs") openTaste({ fromView: true }); }
  else if (views?.layout.mode === "tabs" && state.taste) closeTaste();
},
// Each view's +: a folder for the conversations, and the library's menu (playlist, folder, import).
onAdd: (view, event) => {
  if (view === "library") void library.newMenu(event);
  else sidebar.startNewFolder();
},
addLabel: (view) => (view === "library" ? (library?.importing ? t("readingPlaylist") : t("libraryNew")) : t("newFolder")) });
function renderSidebarMode() {
  // A core without a library (the project page's scene) shows only the conversations.
  views.setEnabled(state.libraryReady === true);
  // Taste is a view of its own beside the library, on the same core; the project page's scene has neither.
  views.enable("taste", state.libraryReady === true);
  views.render();
  if (views.showing("library")) library.render();
  if (views.showing("taste")) tasteList.render();
}
// ⌥⌘L and the palette: the library's view, with the sidebar shown if it was folded away.
function toggleLibrary() {
  if (!shown("sidebar")) togglePanel("sidebar");
  views.toggleLibrary();
  (views.showing("library") && views.layout.active === "library" ? $("library") : $("sessions"))
    .querySelector("[aria-current='true'] button, .row button")?.focus({ preventScroll: true });
}
// A playlist opens in the room in the conversation's place, and the conversation comes back when it closes.
function openPlaylist(id) {
  if (state.shelf?.id === id) { shelf.focus(); return; }
  if (state.taste) closeTaste({ quiet: true });
  state.shelf = { id, playlist: null };
  shelf.reset();
  send({ type: "library-open", id });
  renderShelf();
}
function closePlaylist() {
  if (!state.shelf) return;
  state.shelf = null;
  send({ type: "library-open", id: null });
  renderShelf();
  input.focus();
}
// The name a message from the open playlist goes by, as the sidebar shows it.
function shelfName() {
  if (!state.shelf) return null;
  const open = state.shelf.playlist ?? state.library.playlists.find((each) => each.id === state.shelf.id);
  return open ? (open.saved ? t("saved") : open.name) : null;
}
function renderPlaceholder() {
  const about = shelfName();
  input.placeholder = about ? t("askAbout", { name: about }) : t("placeholder");
}
function renderShelf() {
  room.classList.toggle("shelving", Boolean(state.shelf || state.taste));
  renderPlaceholder();
  shelf.render();
  taste.render();
  library.render();
  if (!state.shelf && !state.taste) { renderConversation({ redraw: true }); placeSoon(); }
}
// The taste page opens in the room as a playlist does, and asks the core for the profile each time it opens.
// Opened from anywhere but its own view, it turns the sidebar to the taste view first, so the two show together.
function openTaste({ fromView = false } = {}) {
  if (!fromView && state.libraryReady === true && !views.showing("taste")) { views.show("taste"); if (state.taste) return; }
  if (state.shelf) { state.shelf = null; send({ type: "library-open", id: null }); }
  if (!state.taste) { state.taste = {}; taste.reset(); }
  send({ type: "taste" });
  renderShelf();
}
function closeTaste({ quiet = false } = {}) {
  if (!state.taste) return;
  state.taste = null;
  if (quiet) return;
  renderShelf();
  input.focus();
}
const toggleTaste = () => (state.taste ? closeTaste() : openTaste());
// Find more like this: the request waits in the composer with the track named, for the listener to edit and send.
function askFromTaste(text) {
  closeTaste();
  input.value = text;
  renderComposer();
  input.focus();
  input.setSelectionRange(0, text.indexOf("\n") < 0 ? text.length : text.indexOf("\n"));
}
// Another conversation can open while this one is still answering; it keeps going in the core.
function openSession(id) {
  // Opening a conversation, or a new one, puts the conversation back in the room.
  if (state.shelf) closePlaylist();
  if (state.taste) closeTaste();
  if (id && id === state.current) return;
  // An empty new conversation is already the new conversation.
  if (!id && !state.turns.length && !state.streaming) { input.focus(); return; }
  send(id ? { type: "open", id } : { type: "new" });
}

// Notices are short and go away on their own.
let noticeTimer = 0;
function notice(text) {
  const node = $("notice");
  node.textContent = text;
  node.hidden = !text;
  clearTimeout(noticeTimer);
  if (text) noticeTimer = setTimeout(() => { node.hidden = true; }, 5000);
}
const NOTICES = { too_many_running: "noticeTooMany", model_unknown: "noticeModelUnknown", waiting_for_import: "noticeWaitingForImport", message_busy: "noticeMessageBusy",
  delete_running: "noticeDeleteRunning", delete_open_elsewhere: "noticeDeleteElsewhere", delete_failed: "noticeDeleteFailed", transfer_failed: "noticeTransferFailed",
  rewind_busy: "waitForReply", rewind_failed: "noticeFailed",
  library_nothing_playing: "noticeNothingToSave", library_too_deep: "noticeTooDeep", library_folder_cycle: "noticeFailed", library_full: "noticePlaylistFull",
  library_playlist_not_found: "noticePlaylistGone", made_track_audio_not_kept: "receiptOnly", made_track_not_found: "receiptOnly",
  spotify_not_ready: "noticeSpotifyNotReady", library_no_player: "noticePlaybackFailed", library_not_ready: "noticeFailed",
  playlist_link_missing: "noticePlaylistLink", playlist_link_unsupported: "noticePlaylistLink", playlist_unavailable: "noticePlaylistUnavailable",
  spotify_playlist_unavailable: "noticePlaylistUnavailable", playlist_unreachable: "noticePlaylistUnreachable", playlist_empty: "noticePlaylistUnavailable",
  playlist_too_large: "noticePlaylistFull", playlist_preview_gone: "noticePlaylistLink" };

// ── The conversation ─────────────────────────────────────────────────────────────────────────
const KINDS = [
  [/^moondog_spotify_player_control$/u, (args) => ({ pause: "pause", next: "skip", previous: "skip" })[args?.action] ?? "play"],
  [/^moondog_spotify_(?:search|discover|resolve_tracks|catalog_items)$/u, "search"],
  [/^moondog_spotify_queue_(?:add|batch|similar)$/u, "queue"],
  [/^moondog_spotify_devices$/u, "devices"],
  [/^moondog_spotify_device_transfer$/u, "move"],
  [/^moondog_spotify_(?:player_status|now_playing|queue_status)$/u, "status"],
  [/^moondog_web_/u, "web"],
  [/^moondog_(?:playlist_plan|spotify_playlist_)/u, "playlist"],
  [/^moondog_playlist_save$/u, "keep"],
  [/^moondog_music_preview$/u, "previews"],
  [/^moondog_make_track$/u, "make"],
  [/^moondog_play_made_track$/u, "play"],
  [/^moondog_start_stream$/u, "make"],
  [/^moondog_stop_stream$/u, "pause"],
  [/^moondog_netease_control$/u, (args) => ({ pause: "pause", stop: "pause", next: "skip", previous: "skip" })[args?.action] ?? "play"],
  [/^moondog_netease_play$/u, (args) => (args?.mode === "queue" ? "queue" : "play")],
  [/^moondog_netease_search$/u, "search"],
  [/^moondog_netease_now_playing$/u, "status"],
  [/^moondog_listening_now$/u, "status"],
  [/^moondog_collection_play$/u, "play"],
  [/^moondog_collection_(?:save|edit)$/u, "keep"],
  [/^moondog_collection_list$/u, "shelf"],
  [/^moondog_music_app_control$/u, (args) => ({ pause: "pause", next: "skip", previous: "skip" })[args?.action] ?? "play"],
  [/^moondog_(?:memory_|taste_choice$)/u, "memory"],
  [/^moondog_music_/u, "search"],
  [/^moondog_(?:profile_|library_|rediscovery|historical_return|time_capsule|back_to_back|spotify_top|spotify_history|spotify_library)/u, "profile"],
];
const kindOf = (tool, args) => {
  const found = KINDS.find(([pattern]) => pattern.test(tool));
  return found ? (typeof found[1] === "function" ? found[1](args) : found[1]) : "other";
};
// While the model thinks, the host's own line from behind the decks: a different one each time it
// stops to think in a turn, the same one on every redraw of that stretch.
const THINKING_LINES = 8;
function thinkingLine(turn) {
  const seed = [...String(turn.id ?? "")].reduce((sum, char) => (sum * 31 + char.codePointAt(0)) >>> 0, 0);
  return t(`thinking.${((seed + (turn.activity?.length ?? 0)) % THINKING_LINES) + 1}`);
}
// The step Moondog is on: the latest kind of work still running, a retry, or thinking before the first word.
function stepOf(turn) {
  if (!turn.streaming) return null;
  if (turn.retrying) return t("retrying");
  const running = [...(turn.activity ?? [])].reverse().find((call) => call.state === "running");
  if (running) return t(`activity.${kindOf(running.tool, running.args)}`);
  return turn.text ? null : thinkingLine(turn);
}

// After a turn, a song it started shows once with its cover. Covers are kept by title as the
// player reports them, because the player's next read can arrive after the turn.
const covers = new Map();
const playedTarget = (turn) => (turn.receipts ?? []).find((receipt) => receipt.action === "playback.resume" && receipt.state === "accepted")?.targets?.[0];
function playedLine(turn) {
  const target = playedTarget(turn);
  if (!target?.title) return null;
  const line = make("p", "played");
  line.append(thumb(covers.get(target.title)));
  line.append(make("strong", "", target.title));
  if (target.artist_credit) line.append(make("span", "", target.artist_credit));
  return line;
}

// Streaming words redraw block by block: finished paragraphs stay as they are, only the growing one is redrawn.
function patchText(host, memo, text) {
  const blocks = text ? text.replace(/\r\n?/gu, "\n").split(/\n[ \t]*\n/u) : [];
  let same = 0;
  while (same < blocks.length - 1 && same < memo.blocks.length && memo.blocks[same] === blocks[same]) same += 1;
  for (const group of memo.nodes.splice(same)) for (const node of group) node.remove();
  memo.blocks.length = same;
  for (let at = same; at < blocks.length; at += 1) {
    const fragment = renderMarkdown(blocks[at]);
    memo.nodes.push([...fragment.childNodes]);
    memo.blocks.push(blocks[at]);
    host.append(fragment);
  }
}
// One slot at the top of a reply holds the step Moondog is on, then the song it started, so the
// words below never jump when one gives way to the other. An empty slot folds away smoothly.
function drawStatus(node, turn) {
  const parts = node.parts;
  const step = stepOf(turn);
  const target = turn.streaming ? null : playedTarget(turn);
  const key = step !== null ? `step|${step}` : target?.title ? `played|${target.title}|${covers.get(target.title) ?? ""}` : "";
  if (parts.status === key) return;
  const wasStep = parts.status?.startsWith("step|");
  parts.status = key;
  if (!key) {
    const slot = parts.slot;
    parts.slot = null;
    if (!slot) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) { slot.remove(); return; }
    slot.animate([{ height: `${slot.offsetHeight}px`, marginBottom: "10px", opacity: 1 }, { height: "0px", marginBottom: "0px", opacity: 0 }],
      { duration: 200, easing: "cubic-bezier(0.4, 0, 0.2, 1)" }).finished.then(() => slot.remove(), () => slot.remove());
    return;
  }
  if (!parts.slot) {
    parts.slot = make("div", "status");
    parts.slot.setAttribute("aria-live", "polite");
    node.prepend(parts.slot);
  }
  let content;
  if (step !== null) {
    content = make("span", "activity");
    content.append(scratchMark());
    if (step) content.append(make("span", "", step));
    // The same kind of step keeps its line; a new step rolls in over the last.
    if (!wasStep) content.classList.add("still");
  } else content = playedLine(turn);
  parts.slot.replaceChildren(content);
}
// A reply updates in place: the words redraw as they arrive, the status changes only when it changes.
function drawReply(node, turn, index) {
  const className = `turn reply${turn.streaming ? " streaming" : ""}${turn.failed ? " failed" : ""}${turn.local ? " local" : ""}`;
  if (node.className.replace(" arrive", "") !== className) node.className = `${className}${node.classList.contains("arrive") ? " arrive" : ""}`;
  const parts = node.parts ??= { memo: { blocks: [], nodes: [] } };
  drawStatus(node, turn);
  if (!parts.text) { parts.text = make("div", "text"); node.append(parts.text); }
  if (parts.words !== turn.text) {
    // A replaced reply (the core rewrote it) starts over; an appended one keeps its finished blocks.
    if (!turn.text?.startsWith(parts.words ?? "")) { parts.text.replaceChildren(); parts.memo = { blocks: [], nodes: [] }; }
    patchText(parts.text, parts.memo, turn.text ?? "");
    parts.words = turn.text;
  }
  messageTools(node, turn);
  // A reply that failed or stopped offers the one thing to do next.
  const action = turn.offline ? "model" : turn.failed && !turn.local && index === state.turns.length - 1 && previousUser(index) ? "retry" : null;
  if (parts.action !== action) {
    parts.actions?.remove();
    parts.actions = null;
    if (action) {
      parts.actions = make("div", "actions");
      const button = make("button", "button small", action === "model" ? t("chooseModel") : t("tryAgain"));
      button.type = "button";
      button.addEventListener("click", (event) => (action === "model" ? void pickModel(event) : retry(index)));
      parts.actions.append(button);
      node.append(parts.actions);
    }
    parts.action = action;
  }
}
// Under each message, shown while the pointer is on it: Copy; on your own saved messages Edit, which
// changes the message in place; and on a saved reply Branch, which goes on from it in a new conversation.
function messageTools(node, turn) {
  let tools = node.tools;
  if (!tools) {
    tools = node.tools = make("div", "message-tools");
    const copy = make("button", "tool");
    copy.type = "button";
    copy.dataset.tipAt = "below";
    copy.append(icon("copy"));
    copy.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(node.turn?.text ?? ""); } catch { return notice(t("noticeFailed")); }
      setIcon(copy, "check");
      name(copy, t("copied"));
      clearTimeout(copy.timer);
      copy.timer = setTimeout(() => { setIcon(copy, "copy"); name(copy, t("copy")); }, 1400);
    });
    tools.copy = copy;
    tools.append(copy);
    if (turn.role === "user") {
      const change = make("button", "tool");
      change.type = "button";
      change.dataset.tipAt = "below";
      change.append(icon("edit"));
      change.addEventListener("click", () => editMessage(node));
      tools.change = change;
      tools.append(change);
    } else {
      const branch = make("button", "tool");
      branch.type = "button";
      branch.dataset.tipAt = "below";
      branch.append(icon("branch"));
      branch.addEventListener("click", () => {
        if (state.streaming) return notice(t("waitForReply"));
        if (node.turn?.entry) send({ type: "branch", entry: node.turn.entry });
      });
      tools.branch = branch;
      tools.append(branch);
    }
    node.append(tools);
  }
  node.turn = turn;
  if (!tools.copy.timer) name(tools.copy, t("copy"));
  if (tools.change) { name(tools.change, t("editMessage")); tools.change.hidden = !turn.entry; }
  if (tools.branch) { name(tools.branch, t("branchReply")); tools.branch.hidden = !turn.entry || Boolean(turn.failed || turn.local); }
  tools.hidden = !turn.text || Boolean(turn.streaming || turn.pending || turn.waiting || node.editing);
}
// Edit: the message opens as a field in its own place. Enter sends the new words there and the replies
// after it go, as /rewind does in the terminal; Escape leaves everything as it was.
function editMessage(node) {
  const turn = node.turn;
  if (!turn?.entry || node.editing) return;
  if (state.streaming) return notice(t("waitForReply"));
  const words = node.querySelector(":scope > p");
  const field = make("textarea", "edit");
  field.value = turn.text;
  field.rows = 1;
  field.setAttribute("aria-label", t("editMessage"));
  const bar = make("div", "message-tools edit-tools");
  const button = (glyph, label, keys) => {
    const control = make("button", "tool");
    control.type = "button";
    control.dataset.tipAt = "below";
    control.append(icon(glyph));
    name(control, label, keys);
    bar.append(control);
    return control;
  };
  const cancel = button("close", t("cancel"), "esc");
  const done = button("up", t("send"), "↩");
  node.editing = true;
  node.classList.add("editing");
  words.hidden = true;
  words.after(field, bar);
  messageTools(node, turn);
  // A message under the record comes down into the words to be edited.
  field.focus({ preventScroll: true });
  field.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  field.setSelectionRange(field.value.length, field.value.length);
  const close = () => {
    field.remove();
    bar.remove();
    words.hidden = false;
    node.editing = false;
    node.classList.remove("editing");
    messageTools(node, node.turn);
  };
  const commit = () => {
    const text = field.value.trim();
    if (!text) return;
    if (state.streaming) return notice(t("waitForReply"));
    if (state.model?.state !== "configured") return notice(t("offline"));
    const index = state.turns.indexOf(turn);
    close();
    if (index < 0) return;
    // The new words show at once in the old one's place; the core's start of the turn adopts them.
    state.turns.splice(index, state.turns.length - index, { role: "user", text, pending: true });
    rest();
    renderConversation();
    send({ type: "edit", entry: turn.entry, text });
    input.focus();
  };
  cancel.addEventListener("click", () => { close(); input.focus(); });
  done.addEventListener("click", commit);
  field.addEventListener("input", () => { done.disabled = !field.value.trim(); });
  field.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); close(); input.focus(); }
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); commit(); }
  });
}
const previousUser = (index) => state.turns.slice(0, index).findLast((entry) => entry.role === "user")?.text ?? null;
function retry(index) {
  const text = previousUser(index);
  if (!text || state.streaming) return;
  state.turns.splice(index - 1, 2);
  rest();
  renderConversation();
  submitText(text);
}

const scroller = $("scroll");
const column = $("column");
const room = $("room");
let nodes = [];
let drawn = undefined;
let record = null;
let frame = 0;
// The view rests at one of two places while the conversation changes under it: home, where the
// latest exchange starts (its message just under the record, or the end when everything after it
// fits), and the end, where a reply that outgrew the window is still being written. A message sent
// or a conversation opened rests at home; scrolling or jumping to the end rests there. Only a hand on
// the scroll lets go, so the window never pulls the view back from under it.
let anchor = "home";
// The scroll position the window itself set last, so its own moves are not taken for a hand's.
let own = -1;
let lastTop = 0;
const gap = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
const end = () => Math.max(0, scroller.scrollHeight - scroller.clientHeight);
const selecting = () => { const selection = getSelection(); return selection && !selection.isCollapsed && column.contains(selection.anchorNode); };
const HOLD_GAP = 14;
// Home, measured from layout rather than the screen, so a message still easing in counts where it settles.
function home() {
  const asked = nodes.findLast((entry, index) => state.turns[index]?.role === "user")?.node;
  if (!asked?.isConnected) return end();
  return Math.min(end(), Math.max(0, asked.offsetTop - homeVeil() - HOLD_GAP));
}
const anchorTop = () => (anchor === "end" ? end() : home());
function anchorTo(place) {
  anchor = place;
  scroller.dataset.following = "true";
  keep();
}
function letGo() {
  if (!anchor) return;
  anchor = null;
  scroller.dataset.following = "false";
  renderJump();
}
// Rests the view at home from the next keep(), which the change that follows (a message sent, a
// conversation drawn) brings.
function rest() {
  anchor = "home";
  scroller.dataset.following = "true";
}
// Holds the view at its anchor as the words change. A view that had to travel eases the record to its
// new size instead of snapping it there.
function keep() {
  if (anchor && !gliding && !selecting()) {
    const before = scroller.scrollTop;
    const top = anchorTop();
    if (Math.abs(before - top) > 0.5) scroller.scrollTop = top;
    own = scroller.scrollTop;
    if (Math.abs(own - before) > 2) refold();
  }
  renderJump();
}

// ── The record ───────────────────────────────────────────────────────────────────────────────
// Before anything is said the record stands alone over the composer. In a conversation it stays
// above the words: full size at home, and smaller as the view moves away from home, up into history
// or down a long reply, to half its size. Its size follows where the view is and nothing else, so it
// never jumps, and it is the same size whenever the view rests at the same place. Folded by hand, it
// goes into the title bar and stays there until it is opened by hand.
const stage = $("stage");
const recordFrame = $("record-frame");
const recordButton = $("record-button");
const barRecord = $("bar-record");
const expand = $("expand");
const lead = $("lead");
const mark = createMark();
barRecord.append(mark.node);
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
const BAR = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--bar")) || 44;
const RECORD_GAP = 4;
// As large as an 800-point window can give it and still leave the words most of the room.
const recordSize = () => Math.round(Math.min(280, Math.max(140, innerHeight * 0.35)));
// Moving away from home shrinks the record to half its size and no smaller, so it stays a record,
// never a smudge. The shrink takes this many record heights of distance, eased at both ends, so it
// happens gradually over a few scrolls instead of all at once.
const SMALLEST = 0.5;
const SHRINK_SPAN = 1.5;
const shrinkAt = (distance, size = recordSize()) => {
  const x = Math.min(1, Math.max(0, distance / ((size + RECORD_GAP) * SHRINK_SPAN)));
  return x * x * (3 - 2 * x);
};
// A fold by hand, or opening again, takes this long, quick at first and settling at the end.
const FOLD_MS = 300;
let foldedByHand = store.get("moondog.record") === "folded";
// The record as drawn: shrink, 0 full size to 1 half size above the words; dock, 0 above the words to 1 in the title bar.
let fold = { shrink: 0, dock: 0 };
let tween = null;
let placing = 0;
let leadHeight = 0;
// Whether the pointer was put on the record, rather than the record moving under a still pointer.
let aimed = false;
const talking = () => Boolean(record) && !room.classList.contains("empty");
const lerp = (from, to, at) => from + (to - from) * at;
// Folded by hand, or as far as the view is from home, either way.
function foldWanted(size) {
  return { shrink: shrinkAt(Math.abs(scroller.scrollTop - home()), size), dock: foldedByHand ? 1 : 0 };
}
// A jump in what the room wants (a click, a view that had to travel) eases there instead of snapping.
function refold() {
  if (!talking()) return;
  tween = { from: { ...fold }, start: performance.now() };
  placeSoon();
}
const placeSoon = () => { if (!placing) placing = requestAnimationFrame(placeRecord); };
// The middle of the bar holds the folded record alone, centered on the conversation. The open
// conversation's name follows the new-conversation button and shortens before it reaches the record
// or the controls at the end. Where the middle has no room, the record folds away instead of into the bar.
let titled = "";
function placeTitle() {
  const host = barRecord.parentElement.getBoundingClientRect();
  const name = $("title");
  const start = $("new").getBoundingClientRect().right;
  const first = [...$("mini").parentElement.children].find((node) => !node.hidden);
  const end = (first ? first.getBoundingClientRect().left : host.right) - 12;
  const middle = host.left + host.width / 2;
  const half = barRecord.offsetWidth / 2 || 14;
  const cramped = middle - half < start + 12 || middle + half > end;
  const stop = $("window").classList.contains("talking") && !cramped ? middle - half - 16 : end;
  const room = Math.round(stop - start - 8);
  const key = `${room}|${cramped}`;
  if (key === titled) return;
  titled = key;
  name.style.maxWidth = `${Math.max(0, room)}px`;
  name.classList.toggle("tight", room < 60);
  barRecord.classList.toggle("cramped", cramped);
}
// Finish the travel before the crossfade, so the two drawings occupy the same box during handoff.
const HANDOFF = 0.94;
// The room and the mark in the bar, read once for each placing.
function measure() {
  const box = room.getBoundingClientRect();
  const dock = mark.node.getBoundingClientRect();
  return { width: box.width, left: dock.left - box.left, top: dock.top - box.top, size: dock.width };
}
// Where the record is drawn at a fold, in the room's coordinates: centered under the bar, as large as
// the scroll leaves it, and from there to the mark in the bar as it docks. Its top stays put as it shrinks.
function recordBox(at, size = recordSize(), where = measure()) {
  const open = size * lerp(1, SMALLEST, at.shrink);
  const travel = Math.min(1, at.dock / HANDOFF);
  return { x: lerp(where.width / 2 - open / 2 + open * 0.035, where.left, travel), y: lerp(BAR + RECORD_GAP, where.top, travel),
    size: lerp(open, where.size, travel) };
}
// Where the words fade with the record at home: just under it at full size, or under the bar when it
// is folded there.
function homeVeil(where = measure()) {
  if (!talking()) return BAR;
  const box = recordBox({ shrink: 0, dock: fold.dock }, recordSize(), where);
  return Math.max(BAR, box.y + box.size + 10);
}
// The room above the first words is what the record takes at the top of the conversation, so the
// first words sit just under it there. The record's size at the top depends on how far the top is
// from home, and home moves with that room, so the room that agrees with itself is found by halving.
// It changes as the conversation does, never with the scroll, so the words never move under the hand.
function leadFor(size, dock, where) {
  const reach = (shrink) => { const box = recordBox({ shrink, dock }, size, where); return Math.max(0, box.y + box.size - BAR); };
  const asked = nodes.findLast((entry, index) => state.turns[index]?.role === "user")?.node;
  // Home and the end without any room above the words.
  const below = scroller.scrollHeight - leadHeight - scroller.clientHeight;
  const after = asked?.isConnected ? asked.offsetTop - leadHeight - homeVeil(where) - HOLD_GAP : Infinity;
  const homeWith = (room) => Math.max(0, room + Math.min(after, below));
  let [low, high] = [reach(1), reach(0)];
  for (let step = 0; step < 16; step += 1) {
    const middle = (low + high) / 2;
    if (reach(shrinkAt(homeWith(middle), size)) > middle) low = middle; else high = middle;
  }
  return Math.round(low + high) / 2;
}
// Glides so `node` sits just under the record as the record will be there. The record's size there
// depends on how far the place is from home, and the place on that size; a few rounds settle it,
// since the record changes more slowly than the scroll.
function scrollToNode(node) {
  const size = recordSize();
  const where = measure();
  const dock = foldedByHand ? 1 : 0;
  const from = home();
  const veil = (top) => {
    const box = recordBox({ shrink: shrinkAt(Math.abs(top - from), size), dock }, size, where);
    return Math.max(BAR, box.y + box.size + 10);
  };
  let top = scroller.scrollTop;
  for (let round = 0; round < 8; round += 1) top = node.offsetTop - veil(top) - 20;
  glideTo(() => Math.max(0, top));
}
// Glides the view to where `to` says, asked again each frame, so a place that moves on the way (the
// end of a reply still being written) is still where the glide ends. A hand on the scroll stops it.
let gliding = false;
let glide = 0;
// The glide under way: the record's shrink where it began, where it goes, and how far along it is.
let glided = null;
function glideTo(to) {
  stopGlide();
  stopHanding();
  const from = scroller.scrollTop;
  const start = performance.now();
  const duration = reduced.matches ? 0 : Math.min(600, 260 + Math.abs(to() - from) * 0.1);
  gliding = true;
  glided = { shrink: fold.shrink, to, eased: 0 };
  const step = (now) => {
    const progress = duration ? Math.min(1, Math.max(0, (now - start) / duration)) : 1;
    const eased = progress < 0.5 ? 4 * progress ** 3 : 1 - (2 - 2 * progress) ** 3 / 2;
    glided.eased = eased;
    scroller.scrollTop = from + (Math.min(to(), end()) - from) * eased;
    own = scroller.scrollTop;
    if (progress < 1) { glide = requestAnimationFrame(step); return; }
    glide = 0;
    gliding = false;
    glided = null;
    keep();
  };
  glide = requestAnimationFrame(step);
}
function stopGlide() {
  if (!gliding) return;
  cancelAnimationFrame(glide);
  glide = 0;
  gliding = false;
  glided = null;
}
let placed = "";
function placeRecord() {
  placing = 0;
  placeTitle();
  if (!talking() || immersed()) return;
  const size = recordSize();
  const where = measure();
  let at = foldWanted(size);
  if (glided) {
    // A glide takes the record from its size where it began to its size where it ends, never through
    // the sizes on the way, so passing home on the way doesn't swell it.
    const arrive = shrinkAt(Math.abs(Math.min(glided.to(), end()) - home()), size);
    at = { ...at, shrink: lerp(glided.shrink, arrive, glided.eased) };
  }
  // A hand on the scroll sets the size in both directions. Only an explicit glide or fold eases
  // between sizes; a second catch-up animation would leave the record behind the moving words.
  if (tween) {
    const progress = reduced.matches ? 1 : Math.min(1, (performance.now() - tween.start) / FOLD_MS);
    const eased = 1 - (1 - progress) ** 4;
    at = { shrink: lerp(tween.from.shrink, at.shrink, eased), dock: lerp(tween.from.dock, at.dock, eased) };
    if (progress >= 1) tween = null; else placeSoon();
  }
  fold = at;
  // Reads first, then writes, so a frame lays out once. The record travels from its place above the
  // words to the mark in the bar, and the last stretch hands the drawing over to the mark. Its
  // place snaps to the screen's pixels, so its dots land on them the same way wherever it stops.
  const { x, y, size: drawnSize } = recordBox(at, size, where);
  const reach = leadFor(size, at.dock, where);
  const pixel = 1 / (devicePixelRatio || 1);
  const [left, top] = [Math.round(x / pixel) * pixel, Math.round(y / pixel) * pixel];
  const handoff = Math.min(1, Math.max(0, (at.dock - HANDOFF) / (1 - HANDOFF)));
  const away = at.dock > 0.6;
  const bottom = y + drawnSize;
  const key = [size, left, top, drawnSize.toFixed(2), handoff.toFixed(3)].join("|");
  if (key !== placed) {
    placed = key;
    // A record that moves under a still pointer was not put there by it.
    aimed = false;
    room.style.setProperty("--record", `${size}px`);
    recordFrame.style.transform = `translate(${left}px, ${top}px) scale(${(drawnSize / size).toFixed(4)})`;
    recordFrame.style.setProperty("--shown", (drawnSize / size).toFixed(4));
    record.shown(drawnSize / size);
    recordButton.style.opacity = (1 - handoff).toFixed(3);
    barRecord.style.opacity = handoff.toFixed(3);
    recordButton.classList.toggle("away", away);
    expand.tabIndex = away ? -1 : 0;
    recordButton.tabIndex = away ? -1 : 0;
    const docked = at.dock > 0.9 && !barRecord.classList.contains("cramped");
    barRecord.classList.toggle("docked", docked);
    barRecord.tabIndex = docked ? 0 : -1;
    // The words fade out just under the record.
    scroller.style.setProperty("--veil", `${Math.max(BAR, bottom + 10).toFixed(1)}px`);
  }
  record.turn(nowPlaying()?.playing && at.dock < 1 && !immersed());
  // A room that changed (the conversation did, or the record folded) keeps an anchored view at its
  // place; a view in hand stays on the same words, held there by the browser.
  if (leadHeight !== reach) { leadHeight = reach; lead.style.height = `${reach}px`; keep(); }
}
// The round button: to the end of the words, which then stays in view as a reply grows there.
function toLatest() {
  chosen = null;
  anchor = "end";
  scroller.dataset.following = "true";
  glideTo(end);
}
// To home, where the record is at its fullest.
function toHome() {
  chosen = null;
  rest();
  if (Math.abs(scroller.scrollTop - home()) > 2) glideTo(home); else keep();
}
function foldRecord(on) {
  if (!talking()) return;
  foldedByHand = on;
  store.set("moondog.record", on ? "folded" : "open");
  refold();
  if (!on) toHome();
}
// The record's own button folds it; the mark in the bar opens it, or brings the view home under it.
function toggleRecord() {
  if (fold.dock < 0.5) foldRecord(true);
  else if (foldedByHand) foldRecord(false);
  else toHome();
}
// The tonearm plays and pauses, as on a turntable: a click lifts it off the record and the music
// stops; another sets it down and the music plays. A pointer near it lights it in its own dots, most
// where the pointer is, and more the closer it comes. A click anywhere else on the record folds it into the bar. Before anything is said, the
// record folds nowhere, so only its arm answers a click.
// With nothing loaded on any player, a click on the arm asks Moondog for a song, as the words
// "Play something for right now" would, in the conversation that is open. The arm goes down at once
// and waits on the still record, cued; the record turns when the music plays. While it waits, until a
// few seconds after a reply that starts no music, it asks nothing more, and then it lifts. A paused
// song is still loaded, so the arm resumes it instead.
const CUE_GRACE_MS = 4000;
let cue = null;
const armReady = () => {
  const now = nowPlaying();
  return now ? can(now, now.playing ? "pausing" : "resuming") : !cueing(now) && state.ready && !state.streaming;
};
// While it waits, the arm still keeps its clicks, so another click neither asks again nor folds the
// record; so does an arm resting on the record On Air is cutting.
const onArm = (target, event) => (armReady() || Boolean(cue) || Boolean(nowPlaying()?.making)) && target?.hit(event.clientX, event.clientY) === "arm";
const nearArm = (target, event) => (armReady() ? target?.near(event.clientX, event.clientY) : target?.near(null));
// The arm rests on the record while the music plays, whatever started or stopped it, while it waits for
// the song it asked for, and while On Air cuts its next record; the record turns only with the music.
// Its wait ends when the music plays, so a later pause lifts it at once.
const armDown = (now) => cueing(now) || Boolean(now?.playing) || Boolean(now?.making);
function setArm() {
  if (nowPlaying()) { control("toggle", "record"); return; }
  if (cueing(null) || !state.ready || state.streaming) return;
  rest();
  if (!submitText(t("armPrompt"))) return;
  if (state.model?.state === "configured") cue = { at: Date.now(), seen: false, ended: 0 };
  // The arm has nothing more to offer a click until the music plays, so it stops answering the pointer.
  record?.near(null);
  deep?.near(null);
  renderInspector();
}
// Whether a request still waits for what it asked for: the arm for its song, On Air for its stream.
// It ends once `done`; a reply that ends without it, or none started within 15 seconds, ends it once
// the grace runs out.
function waits(ask, done) {
  clearTimeout(ask.timer);
  if (done) return false;
  if (state.streaming) ask.seen = true;
  else if (ask.seen || Date.now() - ask.at > 15_000) ask.ended ||= Date.now();
  if (ask.ended && Date.now() - ask.ended >= CUE_GRACE_MS) return false;
  // The window looks again when the wait could run out; a reply's end looks for itself.
  if (!state.streaming) ask.timer = setTimeout(renderInspector, (ask.ended ? ask.ended + CUE_GRACE_MS : ask.at + 15_000) - Date.now() + 20);
  return true;
}
// Whether the arm still waits on the record for the song it asked for.
function cueing(now) {
  if (cue && !waits(cue, now?.playing)) cue = null;
  return Boolean(cue);
}
recordFrame.addEventListener("click", (event) => {
  if (event.target.closest("[data-expand]")) return;
  // A key on the focused record has no place to point at; it folds.
  if (event.detail && onArm(record, event)) setArm();
  else if (event.target.closest("[data-record-button]")) foldRecord(true);
});
// The pointer is put on the record by a move that lands there; a move reported again at the same
// place, as after a scroll, puts it nowhere.
let pointerAt = "";
document.addEventListener("pointermove", (event) => {
  const at = `${event.clientX},${event.clientY}`;
  if (at === pointerAt) return;
  pointerAt = at;
  aimed = recordFrame.contains(event.target);
}, { capture: true, passive: true });
recordFrame.addEventListener("pointermove", (event) => nearArm(record, event));
recordFrame.addEventListener("pointerleave", () => { aimed = false; record?.near(null); });
// A turn of the wheel belongs to what it starts on until the wheel rests; the browser already keeps
// one that starts on the words there, even as the record grows under the pointer. One that starts on
// the record turns it when the song can move and the pointer was put on the disc or its arm. A record
// that grew or moved under a still pointer, its square's empty corners, and a song that can't move
// leave the wheel to the words under the record.
const WHEEL_REST_MS = 240;
let wheeling = { owner: null, at: -Infinity };
recordFrame.addEventListener("wheel", (event) => {
  if (event.timeStamp - wheeling.at > WHEEL_REST_MS) {
    const now = nowPlaying();
    const turns = aimed && Boolean(record?.hit(event.clientX, event.clientY)) && Boolean(now?.durationMs) && can(now, "seeking");
    wheeling.owner = turns ? "record" : "words";
  }
  wheeling.at = event.timeStamp;
  if (wheeling.owner === "record") { scratchWith(record, event); return; }
  // Left uncancelled, the browser keeps the rest of the turn on the record, which scrolls nothing
  // itself, so every step reaches the words through here and none twice.
  const by = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroller.clientHeight : 1);
  handScroll(by);
  handOn(by);
}, { passive: false });
// The words take the wheel the record hands on as they take it anywhere else: a trackpad's small
// steps at once, a mouse wheel's notches eased over a few frames.
let handing = 0;
let handedTo = 0;
function handOn(by) {
  if (!handing && Math.abs(by) < 40) { scroller.scrollTop += by; return; }
  handedTo = Math.min(end(), Math.max(0, (handing ? handedTo : scroller.scrollTop) + by));
  if (handing) return;
  let last = 0;
  const step = (now) => {
    const before = scroller.scrollTop;
    const left = handedTo - before;
    // A frame's time can come before this call; the first step counts as one frame.
    const lapse = last ? now - last : 16;
    scroller.scrollTop = Math.abs(left) < 1 ? handedTo : before + left * (1 - Math.exp(-lapse / 60));
    last = now;
    handing = Math.abs(left) >= 1 && scroller.scrollTop !== before ? requestAnimationFrame(step) : 0;
  };
  handing = requestAnimationFrame(step);
}
function stopHanding() {
  cancelAnimationFrame(handing);
  handing = 0;
}
barRecord.addEventListener("click", toggleRecord);

// The record alone: the window holds only the record, drawn large in the same mosaic, over the
// cover's light. A click anywhere else, or Esc, brings the conversation back, and a drag moves the
// window. A pin keeps the window above the others and locks it on the record: clicks and Esc leave it
// there until the pin is clicked again. The pin shows while the pointer is over the window.
const immersive = $("immersive");
let deep = null;
let pinned = false;
let pinChange = 0;
const immersed = () => !immersive.hidden;
function renderPin() {
  $("pin").setAttribute("aria-pressed", String(pinned));
  setIcon($("pin"), pinned ? "pin-filled" : "pin");
}
function immerse(on) {
  if (on === immersed()) return;
  immersive.hidden = !on;
  layout.classList.toggle("immersed", on);
  window.moondogApp?.setImmersive?.(on);
  pinChange += 1;
  pinned = false;
  renderPin();
  if (on) {
    record?.turn(false);
    if (!deep) {
      deep = mountRecord($("immersive-record"), { across: 160 });
      deep.needle(armDown(nowPlaying()), true);
    }
    deep.tint(grooveColours(moodPalette, dark.matches), true);
    immersive.classList.add("hovered");
    immersive.focus({ preventScroll: true });
  } else {
    immersive.classList.remove("hovered");
    // Reconcile the conversation once, at the final width, rather than lay it out behind each live resize.
    renderPanels();
    renderInspector();
    placeSoon();
    input.focus({ preventScroll: true });
  }
  deep?.turn(on && Boolean(nowPlaying()?.playing));
}
expand.addEventListener("click", () => immerse(true));
// The main process moves the window while the button is held; a press that barely moved is a click.
// A press on the arm stays with the arm, which plays and pauses here as it does above the words,
// and the wheel anywhere scratches the record.
immersive.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || event.target.closest("button") || onArm(deep, event)) return;
  try { immersive.setPointerCapture(event.pointerId); } catch { /* A synthetic press has no pointer to capture. */ }
  const started = window.moondogApp?.dragWindow?.("start");
  immersive.addEventListener("pointerup", async () => {
    await started;
    const moved = (await window.moondogApp?.dragWindow?.("end")) ?? 0;
    if (moved < 4 && !pinned) immerse(false);
  }, { once: true });
});
immersive.addEventListener("click", (event) => { if (event.detail && onArm(deep, event)) setArm(); });
immersive.addEventListener("pointermove", (event) => nearArm(deep, event));
immersive.addEventListener("wheel", (event) => scratchWith(deep, event), { passive: false });
$("pin").addEventListener("click", async () => {
  const change = ++pinChange;
  const before = pinned;
  const want = !pinned;
  pinned = want;
  renderPin();
  try {
    const actual = (await window.moondogApp?.setPinned?.(want)) ?? want;
    if (change === pinChange) { pinned = actual; renderPin(); }
  } catch {
    if (change === pinChange) { pinned = before; renderPin(); }
  }
});
window.moondogApp?.onHover?.((inside) => immersive.classList.toggle("hovered", inside));

// The room before anything is said: the record alone over the composer. Leaving it, the record
// moves to its place above the words and the composer glides down to its own, instead of jumping.
function renderEmpty(empty) {
  if (record && room.classList.contains("empty") === empty) return;
  const composer = $("composer");
  const before = composer.getBoundingClientRect().top;
  const from = record ? recordButton.getBoundingClientRect() : null;
  room.classList.toggle("empty", empty);
  layout.classList.toggle("talking", !empty);
  if (!record) {
    record = mountRecord($("record"));
    record.tint(grooveColours(moodPalette, dark.matches), true);
    record.needle(Boolean(nowPlaying()?.playing), true);
  }
  tween = null;
  placed = "";
  if (empty) {
    recordFrame.style.removeProperty("transform");
    recordFrame.style.removeProperty("--shown");
    record.shown(1);
    recordButton.style.removeProperty("opacity");
    room.style.removeProperty("--record");
    recordButton.classList.remove("away");
    recordButton.tabIndex = -1;
    expand.tabIndex = 0;
    leadHeight = 0;
    lead.style.height = "";
    scroller.style.removeProperty("--veil");
    record.turn(nowPlaying()?.playing);
  } else placeRecord();
  const to = recordButton.getBoundingClientRect();
  if (from?.width && to.width && !reduced.matches) {
    const host = stage.getBoundingClientRect();
    const origin = `${to.left - host.left}px ${to.top - host.top}px`;
    stage.animate([{ transformOrigin: origin, transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width})` },
      { transformOrigin: origin, transform: "none" }], { duration: 520, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
  }
  const after = composer.getBoundingClientRect().top;
  if (!empty && before !== after && !reduced.matches) {
    composer.animate([{ transform: `translateY(${before - after}px)` }, { transform: "none" }], { duration: 420, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
    column.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, delay: 80, easing: "ease-out", fill: "backwards" });
  }
}

function renderConversation({ redraw = false } = {}) {
  if (frame) { cancelAnimationFrame(frame); frame = 0; }
  const opened = drawn !== state.current || redraw;
  drawn = state.current;
  if (opened) { column.replaceChildren(); nodes = []; drawnAsks = null; chosen = null; rest(); }
  renderEmpty(!state.turns.length);
  state.turns.forEach((turn, index) => {
    const key = turn.role === "user" ? `u|${turn.text}|${turn.images?.length ?? 0}` : `a|${turn.id ?? index}|${turn.local ? "l" : ""}`;
    let entry = nodes[index];
    if (!entry || entry.key !== key) {
      const node = turn.role === "user" ? make("div", "you") : make("div", "turn reply");
      // A message's images sit above its words, as they were attached.
      if (turn.role === "user" && turn.images?.length) {
        const pictures = make("div", "you-images");
        for (const image of turn.images) pictures.append(imageButton(image, "you-image"));
        node.append(pictures);
      }
      if (turn.role === "user" && turn.text) node.append(wordsOf(turn.text));
      // Only what just arrived moves; a conversation opened or redrawn stays still.
      if (!opened) node.classList.add("arrive");
      if (entry) entry.node.replaceWith(node); else column.append(node);
      entry = nodes[index] = { key, node };
    }
    if (turn.role !== "user") drawReply(entry.node, turn, index); else messageTools(entry.node, turn);
  });
  for (const extra of nodes.splice(state.turns.length)) extra.node.remove();
  keep();
  renderTurns();
  renderTitle();
  renderComposer();
}
const renderSoon = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; renderConversation(); }); };

// New words, a cover arriving, a reply settling or a taller composer change the room's height; an
// anchored view stays at its place, and a view in hand stays on its words.
const keeping = new ResizeObserver(() => keep());
keeping.observe(column);
keeping.observe(scroller);
// A hand on the scroll stops a glide and lets go of the anchor; pushing on at the end stays there.
function handScroll(by) {
  chosen = null;
  stopGlide();
  if (by > 0 && gap() < 2) { if (anchor !== "end") anchorTo("end"); } else if (by) letGo();
}
scroller.addEventListener("wheel", (event) => { stopHanding(); handScroll(event.deltaY); }, { passive: true });
let scrollFrame = 0;
scroller.addEventListener("scroll", () => {
  if (!gliding) {
    // A view moved off its place by anything but the window (keys on a link, a drag past the edge)
    // lets go as well; one that comes down to the end rests there, so a reply still being written
    // stays in view. One just leaving the end upward is not pulled back.
    if (anchor && scroller.scrollTop !== own && Math.abs(scroller.scrollTop - anchorTop()) > 2) letGo();
    if (!anchor && gap() < 2 && scroller.scrollTop >= lastTop) anchorTo("end");
  }
  lastTop = scroller.scrollTop;
  if (!scrollFrame) scrollFrame = requestAnimationFrame(() => { scrollFrame = 0; renderJump(); markTurn(); placeRecord(); });
}, { passive: true });
function renderJump() { const jump = $("jump"); const hide = anchor === "end" || gap() < 120; if (jump.hidden !== hide) jump.hidden = hide; }
$("jump").addEventListener("click", toLatest);
scrollbar(scroller, { inset: 50, onGrab: () => { chosen = null; stopGlide(); stopHanding(); letGo(); }, onRelease: () => { if (gap() < 2) anchorTo("end"); } });

// Requests along the right edge of the conversation: hover one to read it, click to go back to it.
const turnRail = make("nav", "turns");
scroller.parentElement.append(turnRail);
let drawnAsks = "";
// A mark clicked stays the marked one until the listener scrolls by hand.
let chosen = null;
function renderTurns() {
  const asks = nodes.filter((entry, index) => state.turns[index]?.role === "user");
  const key = asks.length < 3 ? "" : asks.map((entry) => entry.key).join("\n");
  if (key === drawnAsks) { markTurn(); return; }
  drawnAsks = key;
  turnRail.hidden = !key;
  turnRail.replaceChildren(...(key ? asks : []).map((entry) => {
    const mark = make("button");
    mark.type = "button";
    const words = entry.node.textContent.replace(/\s+/gu, " ").trim();
    name(mark, words.length > 90 ? `${words.slice(0, 88)}…` : words);
    mark.dataset.tipAt = "left";
    mark.addEventListener("click", () => {
      letGo();
      chosen = mark;
      markTurn();
      scrollToNode(entry.node);
    });
    mark.target = entry.node;
    // One mark is in the Tab order; the arrow keys walk the rest.
    mark.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const to = event.key === "ArrowDown" ? mark.nextElementSibling : mark.previousElementSibling;
      to?.focus();
      to?.click();
    });
    return mark;
  }));
  markTurn();
}
function markTurn() {
  if (turnRail.hidden) return;
  const line = scroller.scrollTop + scroller.clientHeight * 0.35;
  let here = null;
  for (const mark of turnRail.children) if (mark.target.offsetTop <= line) here = mark;
  if (gap() < 2) here = turnRail.lastChild;
  if (chosen?.isConnected) here = chosen;
  here ??= turnRail.firstChild;
  for (const mark of turnRail.children) { mark.classList.toggle("here", mark === here); mark.tabIndex = mark === here ? 0 : -1; }
}

// ── The composer ─────────────────────────────────────────────────────────────────────────────
const input = $("input");
// The models the menu offers, as Settings keeps them, and the default among them.
let modelList = { models: [], default: null };
// Claude models read as their family and version; others by the name their provider gives them.
// A model goes by the name its provider lists it under, the same here, in Settings and in the menu.
function prettyModel(model, provider = state.model?.provider) {
  const named = modelList.models.find((entry) => entry.provider === provider && entry.model === model)?.name;
  if (named) return named;
  const claude = String(model ?? "").match(/^claude-(opus|sonnet|haiku|fable)-(\d+)-(\d+)/u);
  return claude ? `Claude ${claude[1][0].toUpperCase()}${claude[1].slice(1)} ${claude[2]}.${claude[3]}` : String(model ?? "");
}
// The menu greys out what would do nothing: transport without a song (or with only the record On Air
// is cutting), Stop Response without a reply, On Air where it can't start; and it checks On Air while on.
function syncMenu() {
  const now = nowPlaying();
  window.moondogApp?.setPlayback?.({ controllable: Boolean(now) && !now.making, streaming: Boolean(state.streaming),
    onAir: { available: onAirAvailable(), on: Boolean(state.onAir) } });
}
// ── Images on the next message ──
// Pasted or dropped images wait above the composer and go with the next message. The core routes
// them to a model that sees, or to the vision model chosen in Settings (Auxiliary models). Large ones
// are scaled down here first, so a phone screenshot or a camera photo stays a reasonable request.
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const IMAGE_LIMIT = 4;
const IMAGE_SIDE = 2048;
const IMAGE_KEEP_BYTES = 1_500_000;
let attachments = [];
const dataOf = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.addEventListener("load", () => resolve(String(reader.result).split(",")[1] ?? ""), { once: true });
  reader.addEventListener("error", () => reject(reader.error), { once: true });
  reader.readAsDataURL(blob);
});
async function readImage(file) {
  let blob = file;
  let mimeType = file.type;
  // A GIF may move, so it goes as it is; a large still is drawn again at most 2048 pixels on its long side.
  if (mimeType !== "image/gif") {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
    if (scale < 1 || file.size > IMAGE_KEEP_BYTES) {
      const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
      canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.88 });
      mimeType = "image/jpeg";
    }
    bitmap.close();
  }
  const data = await dataOf(blob);
  // The window's content policy shows data: images, not blob: ones.
  return { data, mimeType, name: file.name || t("image"), url: `data:${mimeType};base64,${data}` };
}
async function attachImages(files) {
  const images = [...files].filter((file) => IMAGE_TYPES.has(file.type));
  for (const file of images) {
    if (attachments.length >= IMAGE_LIMIT) { notice(t("noticeImageLimit", { count: IMAGE_LIMIT })); break; }
    try { attachments.push(await readImage(file)); } catch { notice(t("noticeImageUnreadable")); }
  }
  renderAttachments();
  renderComposer();
  input.focus();
}
// ── The library in the composer ──
// What @ and the + offer: Saved, the playlists, then the folders, by the names the sidebar shows.
function libraryItems() {
  const { playlists, folders } = state.library;
  const named = playlists.map((each) => ({ kind: "playlist", id: each.id, name: each.saved ? t("saved") : each.name, saved: each.saved, cover: each.cover,
    note: each.count === 1 ? t("oneEntry") : t("entries", { count: each.count }) }));
  const byName = (a, b) => a.name.localeCompare(b.name);
  return [...named.filter((each) => each.saved), ...named.filter((each) => !each.saved).sort(byName),
    ...folders.map((each) => ({ kind: "folder", id: each.id, name: each.name })).sort(byName)];
}
const mentions = createMentions({ input, anchor: $("form"), items: libraryItems, coverOf: (item) => coverUrl(item.cover) });
// The + beside the words: the library as the sidebar lays it out, a folder opening onto what it holds.
function libraryMenu(parent = null) {
  const { playlists, folders } = state.library;
  const here = [...folders.filter((each) => each.parentId === parent).map((each) => ({ folder: each, position: each.position })),
    ...playlists.filter((each) => !each.saved && each.folderId === parent).map((each) => ({ playlist: each, position: each.position }))]
    .sort((a, b) => a.position - b.position);
  return here.map(({ folder, playlist }) => (playlist ? { id: `@${playlist.name}`, label: playlist.name } : { label: folder.name, submenu: [
    { id: `@${folder.name}`, label: t("wholeFolder") }, { type: "separator" }, ...libraryMenu(folder.id)] }));
}
$("library-add").addEventListener("click", async (event) => {
  const chosen = await menu([{ id: `@${t("saved")}`, label: t("saved") }, ...libraryMenu()], event, $("library-add"));
  if (chosen?.startsWith("@")) mentions.insert(chosen.slice(1));
});
// A message's words, with what it names from the library in the words: a playlist opens from there.
function wordsOf(text) {
  const words = make("p");
  const items = text.includes("@") ? libraryItems().sort((a, b) => b.name.length - a.name.length) : [];
  let rest = text;
  while (rest) {
    const found = items.flatMap((item) => { const at = rest.indexOf(`@${item.name}`); return at < 0 ? [] : [{ item, at }]; })
      .sort((a, b) => a.at - b.at)[0];
    if (!found) { words.append(rest); break; }
    words.append(rest.slice(0, found.at));
    const label = `@${found.item.name}`;
    if (found.item.kind === "playlist") {
      const open = make("button", "mention", label);
      open.type = "button";
      open.addEventListener("click", () => openPlaylist(found.item.id));
      words.append(open);
    } else words.append(make("span", "mention", label));
    rest = rest.slice(found.at + label.length);
  }
  return words;
}
// A picture that opens at full size over the window; a click anywhere or Escape closes it.
function imageButton(image, className) {
  const button = make("button", className);
  button.type = "button";
  const picture = make("img");
  picture.alt = image.name ?? "";
  picture.src = image.url;
  button.append(picture);
  name(button, t("viewImage"));
  button.addEventListener("click", () => showImage(image));
  return button;
}
let imageOpener = null;
function showImage(image) {
  const box = $("lightbox");
  const picture = box.querySelector("img");
  picture.src = image.url;
  picture.alt = image.name ?? "";
  imageOpener = document.activeElement;
  box.hidden = false;
}
function closeImage() {
  const box = $("lightbox");
  if (box.hidden) return false;
  box.hidden = true;
  box.querySelector("img").removeAttribute("src");
  imageOpener?.focus?.();
  imageOpener = null;
  return true;
}
$("lightbox").addEventListener("click", () => closeImage());
// Escape closes the picture first, before it could stop a reply or close anything behind it.
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && closeImage()) { event.preventDefault(); event.stopImmediatePropagation(); }
}, true);
function renderAttachments() {
  const tray = $("attachments");
  tray.hidden = !attachments.length;
  tray.replaceChildren(...attachments.map((image, index) => {
    const item = make("div", "attachment");
    const picture = imageButton(image, "attachment-open");
    const remove = make("button", "attachment-remove");
    remove.type = "button";
    remove.append(icon("close"));
    name(remove, t("removeImage"));
    remove.addEventListener("click", () => {
      attachments = attachments.filter((_, kept) => kept !== index);
      renderAttachments();
      renderComposer();
      input.focus();
    });
    item.append(picture, remove);
    return item;
  }));
}
function renderComposer() {
  const button = $("send");
  const streaming = Boolean(state.streaming);
  // An empty field leaves the button drawn as it is; sending nothing does nothing.
  button.disabled = !streaming && Boolean(state.waiting && !state.ready);
  name(button, streaming ? t("stop") : t("send"), streaming ? shortcuts.stop : "↩");
  setIcon(button, streaming ? "stop" : "send");
  // While Moondog writes its reply, the send button's glints turn, as the record's do while music plays.
  sendDisc.setTurning(streaming);
  renderPicks();
  syncMenu();
}
// Beside the send button: where the music plays and which model answers, each by its mark, with its
// name in the tooltip and the menu. One not chosen yet reads as the words that choose it: a model,
// without which Moondog can't answer, and while the first run still asks, the music service.
const SERVICE_MARKS = { spotify: "spotify", apple_music: "apple-music", netease: "netease" };
// A model shows its maker's mark: by the account it comes through, or for OpenRouter by the maker its
// model id begins with (anthropic/…, x-ai/…); a maker without a mark here shows OpenRouter's, or the model glyph.
const MAKER_MARKS = { anthropic: "claude", openai: "openai", google: "gemini", deepseek: "deepseek",
  moonshotai: "kimi", "moonshotai-cn": "kimi", xai: "grok", zai: "zai", openrouter: "openrouter" };
const ROUTED_MARKS = { anthropic: "claude", openai: "openai", google: "gemini", deepseek: "deepseek", moonshotai: "kimi", "x-ai": "grok", "z-ai": "zai" };
// An endpoint's model shows its maker's mark when its id names one, as most do.
const NAMED_MARKS = [[/^claude/u, "claude"], [/^(?:gpt|chatgpt|o\d)/u, "openai"], [/^(?:gemini|gemma)/u, "gemini"], [/^deepseek/u, "deepseek"],
  [/^(?:kimi|moonshot)/u, "kimi"], [/^grok/u, "grok"], [/^glm/u, "zai"]];
function makerMark(model) {
  const id = String(model.model ?? "").toLowerCase();
  if (model.provider === "openrouter") return ROUTED_MARKS[id.split("/")[0]] ?? "openrouter";
  if (!String(model.provider ?? "").startsWith("endpoint-")) return MAKER_MARKS[model.provider] ?? "model";
  const [maker, rest] = id.includes("/") ? id.split("/") : [null, id];
  return ROUTED_MARKS[maker] ?? NAMED_MARKS.find(([pattern]) => pattern.test(rest))?.[1] ?? "model";
}
const serviceName = (service) => (service === "netease" ? t("netease") : service === "apple_music" ? "Apple Music" : "Spotify");
const effortName = (level) => (level === "default" ? t("effortDefault") : t(`effort.${level}`) === `effort.${level}` ? level : t(`effort.${level}`));
// The level asked for, and the one the model gets when it lacks that one.
const effortSaid = (model) => (model.thinking && model.thinking !== model.effort ? `${effortName(model.effort)} → ${effortName(model.thinking)}` : effortName(model.effort));
const serviceAsked = () => state.firstRun?.needed === true && !state.firstRun.service;
function drawPick(button, { mark, label, words }) {
  button.classList.toggle("needed", Boolean(words));
  set(button.lastChild, "textContent", words ?? "");
  button.querySelector("svg").setAttribute("class", mark === "model" ? "icon" : "icon fill");
  setIcon(button, mark);
  if (words) { delete button.dataset.tip; button.setAttribute("aria-label", words); } else name(button, label);
}
function renderPicks() {
  const service = sourceWanted ?? state.playbackService ?? "spotify";
  drawPick($("service"), { mark: SERVICE_MARKS[service] ?? "spotify", label: serviceName(service), words: serviceAsked() && !sourceWanted ? t("chooseService") : null });
  const model = state.model;
  set($("model"), "hidden", !model);
  if (!model) return;
  const label = [prettyModel(model.model), model.effort ? effortSaid(model) : ""].filter(Boolean).join(" · ");
  drawPick($("model"), { mark: makerMark(model), label, words: model.model ? null : t("chooseModel") });
}
// The composer grows with its words up to 40% of the window (field-sizing in style.css), then scrolls.
function clearComposer() {
  input.value = "";
  // The sent message's bubble keeps its own copy of each picture.
  attachments = [];
  renderAttachments();
}
// A message's images as the core takes them, and as its bubble shows them.
const imagesFor = (images) => (images.length ? { images: images.map(({ url, name: label }) => ({ url, name: label })),
  attachments: images } : {});
function submitText(text, images = [], { about = null } = {}) {
  // A message typed while the core starts waits for it, shown as sent; more stay in the composer.
  // Images wait in the composer until the core is ready.
  if (!state.ready) {
    if (state.waiting || images.length) return false;
    state.waiting = text;
    state.turns.push({ role: "user", text, waiting: true });
    renderConversation();
    return true;
  }
  if (state.model?.state !== "configured") {
    state.turns.push({ role: "user", text, ...imagesFor(images) }, { role: "assistant", text: t("offline"), failed: true, offline: true, local: true });
    renderConversation();
    return true;
  }
  // Written from an open playlist, it asks about that playlist in a conversation of its own; a conversation with
  // nothing in it yet is already one.
  const fresh = Boolean(about && state.turns.length);
  if (fresh) state.turns = [];
  // A message sent while a playlist or the taste page is open brings the conversation back to show the reply.
  if (state.shelf) closePlaylist();
  if (state.taste) closeTaste();
  // The words show at once; the core's start of the turn adopts them.
  state.turns.push({ role: "user", text, pending: true, ...(fresh ? { fresh } : {}), ...imagesFor(images) });
  renderConversation();
  send({ type: "prompt", text, ...(fresh ? { fresh } : {}), ...(images.length ? { images: images.map(({ data, mimeType, name: label }) => ({ data, mimeType, name: label })) } : {}) });
  return true;
}
function submit() {
  if (state.streaming) { send({ type: "cancel" }); return; }
  const text = input.value.trim();
  if (!text && !attachments.length) return;
  // A mistyped command stays in the composer instead of going to Moondog as a message.
  const command = text.match(/^\/([A-Za-z]+)$/u)?.[1];
  if (command && !COMMANDS.some((entry) => entry.name === command.toLowerCase())) { notice(t("unknownCommand", { name: command })); return; }
  rest();
  const about = shelfName();
  const said = about && !text.includes(`@${about}`) ? `@${about} ${text}`.trim() : text;
  if (submitText(said, attachments, { about })) clearComposer();
  renderComposer();
}
$("form").addEventListener("submit", (event) => { event.preventDefault(); submit(); });
input.addEventListener("input", () => renderComposer());
// A pasted image waits above the composer; words pasted with it still go into the composer.
input.addEventListener("paste", (event) => {
  const files = [...(event.clipboardData?.files ?? [])].filter((file) => IMAGE_TYPES.has(file.type));
  if (!files.length) return;
  if (!event.clipboardData.types.includes("text/plain")) event.preventDefault();
  void attachImages(files);
});
input.addEventListener("keydown", (event) => {
  // Enter sends; while a reply runs it does nothing, so a typed follow-up waits instead of stopping the reply.
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); if (!state.streaming) submit(); }
  if (event.key === "Escape" && state.streaming) { event.preventDefault(); send({ type: "cancel" }); }
  else if (event.key === "Escape" && state.shelf && !input.value) { event.preventDefault(); closePlaylist(); }
  else if (event.key === "Escape" && state.taste && !input.value) { event.preventDefault(); closeTaste(); }
  // The conversation scrolls from the composer, so reading back never needs the mouse.
  if (event.key === "PageUp" || event.key === "PageDown") {
    event.preventDefault();
    const by = (event.key === "PageUp" ? -1 : 1) * scroller.clientHeight * 0.85;
    stopHanding();
    handScroll(by);
    scroller.scrollBy({ top: by, behavior: "smooth" });
  }
});

// Slash commands: each one is named by what it opens, with its command beside it.
const COMMANDS = [
  { name: "new", label: "newConversation", run: () => openSession(null) },
  { name: "model", label: "section.model", run: () => settings.show("model") },
  { name: "language", label: "language", run: () => settings.show("general") },
  // The window's look belongs to the Mac app, so the project page's window has no command for it.
  ...(window.moondogApp?.setAppearance ? [{ name: "appearance", label: "section.appearance", run: () => settings.show("appearance") }] : []),
  { name: "service", label: "musicService", run: () => settings.show("playback") },
  { name: "device", label: "devices", run: () => pickDevice(null) },
  { name: "import", label: "importHistory", run: () => settings.show("library") },
  { name: "taste", label: "taste", run: () => openTaste() },
  { name: "profile", label: "taste", run: () => openTaste() },
  { name: "memory", label: "memory", run: () => settings.show("memory") },
  { name: "remember", label: "remember", argument: "cmdRememberArgument", run: (text) => { if (text) { send({ type: "remember", text }); notice(t("remembered")); } } },
  { name: "folder", label: "newFolder", run: () => {
    if (!shown("sidebar")) togglePanel("sidebar");
    if (views.showing("library") && views.layout.active === "library") library.startNew("folder", null); else sidebar.startNewFolder();
  } },
  { name: "library", label: "library", run: () => toggleLibrary() },
  { name: "playlist", label: "newPlaylist", run: () => {
    if (!views.showing("library")) toggleLibrary();
    else if (!shown("sidebar")) togglePanel("sidebar");
    library.startNew("playlist", null);
  } },
  { name: "settings", label: "settings", run: () => settings.show() },
  { name: "help", label: "shortcuts", run: () => settings.show("about") },
];
const palette = createPalette({ input, anchor: $("form"), t: tr, commands: () => COMMANDS });

// Pickers open as native menus where they show. The model's button shows only its maker's mark, so
// its menu names what answers: the models kept in Settings, flat, the one this conversation uses
// checked, then how hard it thinks. A choice here is this conversation's; Settings sets the default.
async function pickModel(event) {
  const model = state.model ?? {};
  const same = (entry) => entry.provider === model.provider && entry.model === model.model;
  const entries = modelList.models.filter((entry) => entry.ready || same(entry));
  if (model.model && !entries.some(same)) entries.unshift({ provider: model.provider, model: model.model, name: prettyModel(model.model) });
  // Two models of one name, such as GPT through ChatGPT and through the API, say where each comes from.
  const named = (entry) => entries.filter((other) => other.name === entry.name).length > 1 && entry.providerName ? `${entry.name} · ${entry.providerName}` : entry.name;
  const items = entries.map((entry) => ({ id: `model:${entry.provider}:${entry.model}`, label: named(entry), checked: same(entry) }));
  if (model.effortLevels?.length > 1) {
    const asked = model.effort ?? "default";
    items.push(...(items.length ? [{ type: "separator" }] : []), { id: "effort", label: `${t("effort")} · ${model.effort ? effortSaid(model) : effortName("default")}`,
      submenu: ["default", ...EFFORTS].map((level) => ({ id: `effort:${level}`, label: effortName(level), checked: asked === level })) });
  }
  items.push(...(items.length ? [{ type: "separator" }] : []), { id: "settings", label: t("modelSettings") });
  const chosen = await menu(items, event, popUp($("model"), items));
  if (!chosen) return;
  if (chosen === "settings") return settings.show("model");
  if (chosen.startsWith("effort:")) return send({ type: "effort", effort: chosen.slice(7) });
  const [, provider, ...rest] = chosen.split(":");
  if (chosen.startsWith("model:")) send({ type: "model", provider, model: rest.join(":") });
}
// The services that can play now, and the one in use: Apple Music always, Spotify once connected and
// NetEase once ncm-cli is signed in. Connecting or setting one up happens in Settings › Playback.
const playableServices = (now) => ["spotify", "apple_music", "netease"].filter((service) => service === now || service === "apple_music"
  || (service === "spotify" ? state.spotify === "ready" : state.netease === "ready"));
// The music service's menu: the services that can play, the one in use checked, then the settings.
// A choice shows at once and the core's status confirms it; every conversation's agent follows it.
let sourceWanted = null;
let wantedTimer = 0;
async function pickService(event) {
  const now = sourceWanted ?? state.playbackService ?? "spotify";
  const items = playableServices(now).map((service) => ({ id: `service:${service}`, label: serviceName(service), checked: service === now }));
  items.push({ type: "separator" }, { id: "settings", label: t("playbackSettings") });
  const chosen = await menu(items, event, popUp($("service"), items));
  if (!chosen) return;
  if (chosen === "settings") settings.show("playback");
  else chooseService(chosen.slice(8));
  renderComposer();
}
// Leaving Apple Music stops its songs in the window's player, never a track Moondog made: On Air and
// Moondog's own records are no music service's.
const holdsSongs = () => previews.active() && !previews.state()?.generated;
function chooseService(service) {
  if (service === (sourceWanted ?? state.playbackService)) return;
  if (holdsSongs() && service === "spotify") previews.stop();
  sourceWanted = service;
  clearTimeout(wantedTimer);
  wantedTimer = setTimeout(() => { sourceWanted = null; renderComposer(); }, 10_000);
  send({ type: "music-service", service });
}
// Where music plays: Spotify's devices, then the service itself. The menu opens once the devices are read.
let devicePicker = null;
function pickDevice(event) {
  devicePicker = { event };
  if (state.playbackService === "spotify" && state.spotify === "ready") send({ type: "devices" });
  else void showDevices([]);
}
// It opens as the device row's pop-up, the device or service in use set on the row's words.
async function showDevices(devices) {
  const event = devicePicker?.event;
  devicePicker = null;
  const items = [];
  if (state.playbackService === "spotify" && state.spotify === "ready") {
    items.push(...devices.map((device) => ({ id: `device:${device.ref}`, label: device.name, checked: device.active, enabled: !device.restricted })));
    if (!devices.length) items.push({ id: "none", label: t("noDevices"), enabled: false });
    items.push({ type: "separator" });
  }
  const now = state.playbackService ?? "spotify";
  items.push(...playableServices(now).map((service) => ({ id: `service:${service}`, label: serviceName(service), checked: service === now })));
  items.push({ type: "separator" }, { id: "settings", label: t("playbackSettings") });
  const chosen = await menu(items, event, popUp($("device-row"), items));
  if (chosen === "settings") settings.show("playback");
  else if (chosen?.startsWith("device:")) send({ type: "transfer", ref: chosen.slice(7) });
  else if (chosen?.startsWith("service:") && chosen.slice(8) !== state.playbackService) {
    if (holdsSongs() && chosen === "service:spotify") previews.stop();
    send({ type: "music-service", service: chosen.slice(8) });
  }
}
$("model").addEventListener("click", (event) => void pickModel(event));
$("service").addEventListener("click", (event) => void pickService(event));
$("device-row").addEventListener("click", (event) => pickDevice(event));
$("settings-button").addEventListener("click", () => settings.show());

// A newer Moondog, from the main process. Offered, the button beside Settings is an inverted disc; a click
// downloads it, the ring around the button fills as it arrives, and Moondog restarts into it when it ends.
function renderUpdate() {
  const button = $("update");
  const { phase, version, progress, installing } = state.update;
  button.hidden = phase === "idle";
  if (button.hidden) return;
  button.classList.toggle("solid", phase === "available" || phase === "ready");
  $("update-done").setAttribute("stroke-dasharray", `${Math.round((progress ?? 0) * 100)} 100`);
  const words = installing ? "updating" : { available: "updateAvailable", ready: "updateReady" }[phase] ?? "updateDownloading";
  name(button, t(words, { version }));
  button.setAttribute("aria-disabled", String(installing === true));
}
const takeUpdate = (next) => {
  state.update = next?.phase ? next : { phase: "idle" };
  renderUpdate();
};
window.moondogApp?.onUpdate?.(takeUpdate);
void window.moondogApp?.updateState?.().then(takeUpdate, () => {});
$("update").addEventListener("click", () => {
  if (state.update.installing) return;
  takeUpdate({ ...state.update, installing: true });
  window.moondogApp?.installUpdate?.();
});
$("connect").addEventListener("click", () => settings.show("playback"));
$("connect-player").addEventListener("click", () => settings.show("playback"));

// ── On Air ───────────────────────────────────────────────────────────────────────────────────
// Moondog's own channel, beside the music in the bar. A click asks for it in the open conversation, in
// the listener's words, as the arm asks for a song; the agent starts the stream from the listener's
// taste and the moment. Another click, its key or the menu takes it off the air, and nothing resumes. The
// mark lights in ink, with no fill of its own, from the click on; while it waits for a record it dips
// once every few seconds.
const onAirButton = $("on-air");
const onAirAvailable = () => state.ready && state.generation?.state === "ready" && state.model?.state === "configured";
// The click that asked, until the stream appears, or the grace after a reply that started none runs out.
let onAirAsk = null;
// The arm's cue that click set, so taking it off the air lifts the arm at once.
let onAirCue = null;
function onAirPending() {
  if (onAirAsk && !waits(onAirAsk, Boolean(state.onAir))) onAirAsk = null;
  return Boolean(onAirAsk);
}
let onAirDrawn = "";
function renderOnAir() {
  const phase = state.onAir?.phase ?? (onAirPending() ? "pending" : null);
  const waiting = phase === "pending" || phase === "starting" || phase === "waiting";
  // A running stream can always be stopped; a disabled button would get no tooltip, so it hides instead.
  const hidden = !state.onAir && !onAirAvailable();
  // The end is an upper bound, so it reads as a clock, never a countdown.
  const label = !phase ? t("goOnAir") : phase === "waiting" ? t("onAirMaking") : waiting ? t("goingOnAir")
    : t("onAirUntil", { time: timeOfDay(state.onAir.endsAt, state.locale, { day: false }) });
  const key = [hidden, phase, label].join("|");
  if (key !== onAirDrawn) {
    onAirDrawn = key;
    onAirButton.hidden = hidden;
    onAirButton.classList.toggle("lit", Boolean(phase));
    setIcon(onAirButton, phase ? "on-air-lit" : "on-air");
    onAirButton.setAttribute("aria-pressed", String(Boolean(state.onAir)));
    name(onAirButton, label, shortcuts.onAir);
  }
  pulse(waiting && !hidden);
}
// One 400 ms dip every 5 seconds, added by a timer, so nothing loops on its own; it rests while the
// window is hidden and never runs with reduced motion.
const PULSE_MS = 5_000;
let pulseTimer = 0;
function pulse(on) {
  if (on && !document.hidden && !reduced.matches) { pulseTimer ||= setInterval(() => onAirButton.classList.add("pulse"), PULSE_MS); return; }
  clearInterval(pulseTimer);
  pulseTimer = 0;
  onAirButton.classList.remove("pulse");
}
onAirButton.addEventListener("animationend", (event) => { if (event.animationName === "on-air-dip") onAirButton.classList.remove("pulse"); });
document.addEventListener("visibilitychange", renderOnAir);
function toggleOnAir() {
  if (state.onAir) { stopOnAir(); return; }
  // Asked and not on air yet: the request is taken back, with the reply making it.
  if (onAirPending()) {
    // Only the reply to the click, in the conversation it was sent in, is stopped.
    if (state.streaming && state.current === onAirAsk.session) send({ type: "cancel" });
    dropOnAirAsk();
    liftOnAirCue();
    renderInspector();
    return;
  }
  if (!onAirAvailable()) return;
  if (state.streaming) { notice(t("waitForReply")); return; }
  rest();
  if (!submitText(t("onAirPrompt"))) return;
  onAirAsk = { at: Date.now(), seen: false, ended: 0, session: state.current };
  // With nothing loaded on any player, the arm goes down on the still record too: music is coming.
  if (!nowPlaying() && state.model?.state === "configured") {
    cue = onAirCue = { at: Date.now(), seen: false, ended: 0 };
    record?.near(null);
    deep?.near(null);
  }
  renderInspector();
}
// Off air. A reply still starting the stream stops with it, so its agent never takes the stop for a
// failure to try again.
function stopOnAir() {
  send({ type: "on-air-stop" });
  if (state.onAir?.phase === "starting" && startingHere()) send({ type: "cancel" });
  dropOnAirAsk();
  liftOnAirCue();
  renderInspector();
}
// Whether the reply on screen is the one starting the stream; a reply in another conversation may be.
const startingHere = () => Boolean(streamingTurn(state.streaming)?.activity?.some((call) => call.tool === "moondog_start_stream" && call.state === "running"));
// The click's wait is over once the stream appears or the listener takes it back, so a stream that
// ends later never falls back to looking asked for.
function dropOnAirAsk() {
  if (onAirAsk) clearTimeout(onAirAsk.timer);
  onAirAsk = null;
}
function liftOnAirCue() {
  if (cue && cue === onAirCue) { clearTimeout(cue.timer); cue = null; }
  onAirCue = null;
}
onAirButton.addEventListener("click", toggleOnAir);

// ── What is playing ──────────────────────────────────────────────────────────────────────────
const clock = (ms) => {
  const seconds = Math.max(0, Math.floor((ms ?? 0) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};
// A preview in the window shows while it plays, or while Spotify has nothing playing; a paused
// preview never hides the song Spotify is playing. On air, once its first track plays, the stream owns
// the display: its track shows even paused, and in its dry gap the record being cut, which nothing plays.
function nowPlaying() {
  const preview = previews.state();
  const now = state.player?.now;
  if (state.onAir && state.onAir.phase !== "starting") {
    if (preview?.generated) return { ...preview, local: true, preview: false };
    // In the dry gap, and from a skip or an ended track until the core says so, nothing of it is loaded.
    if (state.onAir.phase === "waiting" || (state.onAir.phase === "making" && !preview)) {
      return { title: t("makingNext"), artists: [], generated: true, local: true, making: true, playing: false, progressMs: 0, durationMs: null, next: [] };
    }
  }
  // local: it plays in the window (whole songs or previews); preview: it is a 30-second preview.
  // A track Moondog made is its own record, never a preview.
  if (preview && (preview.playing || !now?.playing)) return { ...preview, local: true, preview: !preview.full && !preview.generated };
  if (!now) return null;
  const progressMs = now.playing ? now.progressMs + (Date.now() - now.observedAt) : now.progressMs;
  return { ...now, progressMs: now.durationMs ? Math.min(progressMs, now.durationMs) : progressMs, next: state.player.next ?? [] };
}
const can = (now, action) => Boolean(now) && !now.making && (now.local || !(now.disallows ?? []).includes(action));
const spotifyLimited = (at) => t("spotifyLimited", { time: timeOfDay(at, state.locale) });
const DEVICE_ICONS = { computer: "laptop", smartphone: "phone", tablet: "phone", speaker: "speaker", tv: "tv", castvideo: "tv", castaudio: "speaker", avr: "speaker", stb: "tv" };
// The inspector redraws several times a second while music plays, so a node changes only when its content does.
const set = (node, key, value) => { if (node[key] !== value) node[key] = value; };

// A new cover fades in over the last, and lights the panel behind it.
function showCover(frameNode, src, className) {
  const live = [...frameNode.querySelectorAll(`img.${className}:not(.leaving)`)];
  if ((live.at(-1)?.getAttribute("src") ?? null) === (src ?? null)) return;
  // A cover still loading is replaced, not faded over.
  for (const node of live) if (!node.classList.contains("on")) node.remove();
  const old = [...frameNode.querySelectorAll(`img.${className}`)];
  // With nothing loaded, the cover goes at once, and its light fades as slowly as it came.
  if (!src) {
    for (const node of old) {
      if (className !== "glow") { node.remove(); continue; }
      node.classList.add("leaving");
      node.classList.remove("on");
      setTimeout(() => node.remove(), 1700);
    }
    return;
  }
  const image = make("img", className);
  image.alt = "";
  image.decoding = "async";
  image.addEventListener("load", () => {
    image.classList.add("on");
    if (className === "cover" && old.length) image.classList.add("entering");
    for (const node of old) {
      node.classList.add("leaving");
      setTimeout(() => node.remove(), className === "glow" ? 900 : 420);
    }
  }, { once: true });
  image.addEventListener("error", () => image.remove(), { once: true });
  image.src = src;
  frameNode.append(image);
}

// The progress line moves on the compositor: one custom property per tick, eased over the second
// it covers, and set without easing when the song jumps (a seek, a new song).
// The cover's colours light the window; a new song's colours drift in as the last ones fade.
const moodNode = $("mood");
const dark = matchMedia("(prefers-color-scheme: dark)");
let moodSource = undefined;
let moodPalette = null;
// The record's grooves and the folded mark's rings take the same colours, deeper; a theme change repaints them at once.
function paintMood(event) {
  moodColours(moodPalette, dark.matches).forEach((colour, index) => moodNode.style.setProperty(`--mood-${index + 1}`, colour));
  const rings = grooveColours(moodPalette, dark.matches);
  record?.tint(rings, Boolean(event));
  deep?.tint(rings, Boolean(event));
  for (let index = 0; index < 3; index += 1) {
    if (rings) layout.style.setProperty(`--groove-${index + 1}`, `rgb(${rings[index].join(" ")})`); else layout.style.removeProperty(`--groove-${index + 1}`);
  }
}
function renderMood(now) {
  moodNode.classList.toggle("playing", Boolean(now?.playing));
  const source = now?.image ?? null;
  if (source === moodSource) return;
  moodSource = source;
  void coverPalette(source).then((palette) => {
    if (moodSource !== source) return;
    moodPalette = palette;
    paintMood();
  });
}
dark.addEventListener("change", paintMood);

let seeking = null;
let drawnSong = "";
function renderProgress(now, { jump = false } = {}) {
  const progress = $("progress");
  set(progress, "hidden", !now?.durationMs);
  if (!now?.durationMs) return;
  const track = $("track");
  track.classList.toggle("seekable", can(now, "seeking"));
  const fraction = Math.min(1, Math.max(0, seeking ? seeking.fraction : now.progressMs / now.durationMs));
  const song = `${now.title}|${now.durationMs}|${now.local ? "w" : "s"}`;
  const still = jump || seeking || song !== drawnSong || !now.playing;
  drawnSong = song;
  track.classList.toggle("still", Boolean(still));
  track.style.setProperty("--f", fraction.toFixed(4));
  set($("elapsed"), "textContent", clock(fraction * now.durationMs));
  set($("duration"), "textContent", clock(now.durationMs));
  track.setAttribute("aria-valuemax", String(Math.round(now.durationMs / 1000)));
  track.setAttribute("aria-valuenow", String(Math.round(fraction * now.durationMs / 1000)));
  track.setAttribute("aria-valuetext", `${clock(fraction * now.durationMs)} / ${clock(now.durationMs)}`);
  track.setAttribute("aria-disabled", String(!can(now, "seeking")));
  set($("badge"), "hidden", !now.preview);
  set($("badge"), "textContent", t("preview"));
}
// The clock ticks on the second, so the digits change in step with the music.
let tickTimer = 0;
function tick() {
  clearTimeout(tickTimer);
  const now = nowPlaying();
  if (!now?.playing || document.hidden) return;
  if (!seeking) renderProgress(now);
  tickTimer = setTimeout(tick, 1000 - (now.progressMs % 1000) + 4);
}
document.addEventListener("visibilitychange", tick);
let drawnQueue = "";
// A small cover that can't load gives way to a plain sleeve, never a broken-image mark.
function thumb(src, lazy = false) {
  if (!src) return make("span", "thumb");
  const image = make("img");
  image.alt = "";
  if (lazy) image.loading = "lazy";
  image.addEventListener("error", () => image.replaceWith(make("span", "thumb")), { once: true });
  image.src = src;
  return image;
}
function queueItem(track, at) {
  const item = make("li");
  item.dataset.at = String(at);
  item.tabIndex = at === 0 ? 0 : -1;
  item.append(thumb(track.image, true));
  const words = make("div");
  words.append(make("strong", "", track.title), make("span", "", track.generated ? t("madeByMoondog") : track.artists.join(", ")));
  item.append(words);
  return item;
}
// A song in Up next plays at once: in the window by its place in the queue, elsewhere by how many skips reach it.
// Only queues Moondog keeps can let one go; Spotify's and the Music app's can't, so they never offer it.
const queueSongs = () => nowPlaying()?.next ?? [];
const canJump = (now) => Boolean(now) && !now.making && (now.local || can(now, "skipping_next"));
const canRemove = (now, track) => Boolean(now) && !now.making && (now.local ? !(state.onAir && track?.generated) : now.service === "netease");
function jumpTo(at) {
  const now = nowPlaying();
  const track = now?.next?.[at];
  if (!track || !canJump(now)) return;
  if (now.local) { previews.jump(track.position); return; }
  if (!Number.isInteger(track.ahead)) return;
  send({ type: "control", action: "jump", ahead: track.ahead, via: "queue" });
  // The song shows at once; the next read from the player confirms it.
  const rest = state.player.next.slice(at + 1).map((each) => (Number.isInteger(each.ahead) ? { ...each, ahead: each.ahead - track.ahead } : each));
  state.player = { now: { ...state.player.now, ...track, playing: true, progressMs: 0, observedAt: Date.now() }, next: rest };
  renderInspector();
  renderProgress(nowPlaying(), { jump: true });
}
function removeAt(at) {
  const now = nowPlaying();
  const track = now?.next?.[at];
  if (!track || !canRemove(now, track)) return;
  if (now.local) { previews.remove(track.position); return; }
  send({ type: "control", action: "remove", ahead: track.ahead, via: "queue" });
  state.player.next = state.player.next.filter((_, each) => each !== at).map((each, index) => (index >= at && Number.isInteger(each.ahead) ? { ...each, ahead: each.ahead - 1 } : each));
  renderInspector();
}
// The rows of Up next: the songs queued, then the host's picks.
const QUEUE_ROWS = "li[data-at], li[data-ref]";
const queueRow = (event) => event.target.closest?.(`[data-queue] :is(${QUEUE_ROWS})`);
$("queue").addEventListener("click", (event) => { const row = queueRow(event); if (row?.dataset.ref) addProposal(row.dataset.ref); });
$("queue").addEventListener("dblclick", (event) => { const row = queueRow(event); if (row?.dataset.at) jumpTo(Number(row.dataset.at)); });
$("queue").addEventListener("contextmenu", async (event) => {
  const row = queueRow(event);
  if (!row) return;
  event.preventDefault();
  row.focus();
  if (row.dataset.ref) {
    if (await menu([{ id: "add", label: t("addToUpNext") }], event) === "add") addProposal(row.dataset.ref);
    return;
  }
  const at = Number(row.dataset.at);
  const now = nowPlaying();
  const track = now?.next?.[at];
  if (!track) return;
  const chosen = await menu([{ id: "play", label: t("playNow"), enabled: canJump(now) },
    ...(canRemove(now, track) ? [{ id: "remove", label: t("removeFromQueue") }] : [])], event);
  if (chosen === "play") jumpTo(at);
  if (chosen === "remove") removeAt(at);
});
// Up and down move between the rows; Return plays a queued song or adds a pick; Delete takes a song out where the queue allows.
$("queue").addEventListener("keydown", (event) => {
  const row = queueRow(event);
  if (!row || event.metaKey || event.ctrlKey || event.altKey) return;
  const rows = [...$("queue").querySelectorAll(QUEUE_ROWS)];
  const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
  if (step) {
    event.preventDefault();
    const to = rows[Math.max(0, Math.min(rows.length - 1, rows.indexOf(row) + step))];
    for (const each of rows) each.tabIndex = each === to ? 0 : -1;
    to.focus();
  } else if (event.key === "Enter") {
    event.preventDefault();
    if (row.dataset.ref) addProposal(row.dataset.ref);
    else jumpTo(Number(row.dataset.at));
  } else if ((event.key === "Delete" || event.key === "Backspace") && row.dataset.at) {
    event.preventDefault();
    removeAt(Number(row.dataset.at));
  }
});
// Up next's picks: when the songs queued run low, the host offers what could come next, after them and quieter.
// A click or Return adds one to the queue. The window asks once for each song that plays, so a pick added never
// asks again; only the player Moondog can queue on is asked for, never the Music app the listener plays.
let proposals = { key: null, songs: [] };
let askedKey = null;
const offered = [];
const proposalWhere = (now) => (!now || now.making || now.generated || state.onAir ? null
  : now.local ? (state.playbackService === "apple_music" ? "moondog" : null)
    : now.service === "netease" ? "netease" : now.service === "apple_music" ? null : "spotify");
const proposalKey = (now, where) => JSON.stringify([where, now.title, now.artists ?? []]);
function askProposals(now, next) {
  const where = proposalWhere(now);
  if (!where || next.length > 2 || !shown("inspector") || document.hidden) return;
  const key = proposalKey(now, where);
  if (key === askedKey) return;
  askedKey = key;
  send({ type: "up-next-proposals", key, where, playing: { title: now.title, artists: now.artists ?? [] },
    next: next.map((track) => ({ title: track.title, artists: track.artists ?? [] })), offered: offered.slice(-20) });
}
// The picks still worth offering: for the song playing now, and not queued already.
function shownProposals(now, next) {
  const where = proposalWhere(now);
  if (!where || proposals.key !== proposalKey(now, where)) return [];
  const queued = new Set(next.map((track) => track.title.toLowerCase()));
  return proposals.songs.filter((song) => !queued.has(song.title.toLowerCase()));
}
function proposalItem(song) {
  const item = make("li", "proposal");
  item.dataset.ref = song.ref;
  item.tabIndex = -1;
  item.append(thumb(song.image, true));
  const words = make("div");
  words.append(make("strong", "", song.title), make("span", "", song.artists.join(", ")));
  item.append(words);
  item.dataset.tip = t("addToUpNext");
  return item;
}
function addProposal(ref) {
  const song = proposals.songs.find((each) => each.ref === ref);
  if (!song) return;
  proposals = { ...proposals, songs: proposals.songs.filter((each) => each !== song) };
  send({ type: "up-next-queue", ref });
  // Spotify and NetEase show it queued at once; the next read confirms it. The window's own player adds it itself.
  if (!nowPlaying()?.local && state.player) state.player.next = [...(state.player.next ?? []), { title: song.title, artists: song.artists, image: song.image }];
  renderInspector();
}
// The record On Air is cutting, after what is queued: a blank sleeve, quieter than a real one.
function cuttingItem() {
  const item = make("li", "making");
  item.append(thumb(null));
  const words = make("div");
  words.append(make("strong", "", t("makingNext")));
  item.append(words);
  return item;
}
// The player's buttons and the bar's follow one rule: what the service won't do now is dimmed.
function drawControls(now, toggle, next) {
  name(toggle, now.playing ? t("pause") : t("play"), shortcuts.play);
  // The player's own button is a record button: its play glyph is the one drawn for the label, and its glints turn
  // while the music plays.
  const disc = toggle === $("toggle");
  setIcon(toggle, now.playing ? "pause" : disc ? "play-disc" : "play");
  if (disc) playerDisc.setTurning(now.playing);
  set(toggle, "disabled", !can(now, now.playing ? "pausing" : "resuming"));
  set(next, "disabled", !can(now, "skipping_next"));
}
const SERVICE_OF_PLAYLIST = { spotify: "Spotify", apple_music: "Apple Music", netease: "netease", qq_music: "qqMusic" };
async function askImport(preview) {
  const service = SERVICE_OF_PLAYLIST[preview.provider] ?? "";
  const from = service === "netease" || service === "qqMusic" ? t(service) : service;
  const count = preview.total && preview.total > preview.read ? t("importReadOf", { read: preview.read, total: preview.total }) : t("entries", { count: preview.read });
  const answer = await window.moondogApp?.ask?.({ message: t("importQuestion", { name: preview.name }), detail: `${count} · ${from}\n${preview.sample.join("\n")}`,
    confirm: t("importConfirm"), cancel: t("cancel"), checkbox: t("importShapesTaste"), checked: preview.owned === true });
  if (!answer?.confirmed) { library.importDone(); return; }
  send({ type: "library-import", token: preview.token, taste: answer.checked === true, folderId: preview.folderId ?? null });
}
function exportPlaylist(playlist) {
  notice(t("exportSending"));
  send({ type: "library-export", playlistId: playlist.id });
}
// A playlist sent to Spotify. A copy changed there since the last export is replaced only when the listener says so.
async function exported(data) {
  const name = data.playlist?.saved ? t("saved") : data.playlist?.name ?? "";
  if (data.state === "changed_on_service") {
    const confirmed = await window.moondogApp?.confirm?.({ message: t("exportChangedQuestion", { name }), detail: t("exportChangedDetail"),
      confirm: t("exportReplace"), cancel: t("cancel") });
    if (confirmed) { notice(t("exportSending")); send({ type: "library-export", playlistId: data.playlist.id, replace: true }); }
    else notice("");
    return;
  }
  if (data.state !== "created" && data.state !== "updated") { notice(t(data.state === "empty" ? "playlistEmpty" : "noticeNothingFound")); return; }
  notice([t(data.state === "updated" ? "exportUpdated" : "exportedPlaylist", { name }), data.not_found ? t("notFoundSome") : ""].filter(Boolean).join(" "));
}
// The song the heart last kept, by title and artists, so its heart shows filled while it plays.
let keptNow = null;
const songKey = (now) => `${now.title}\u0000${now.generated ? "moondog" : (now.artists ?? []).join(",")}`;
function renderInspector() {
  const now = nowPlaying();
  renderOnAir();
  shelf.syncPlaying(now);
  const art = $("art");
  showCover(art, now?.image ?? null, "cover");
  showCover($("ambient"), now?.image ?? null, "glow");
  set($("blank"), "hidden", Boolean(now));
  art.classList.toggle("unplayed", !now);
  const limitedUntil = state.playbackService === "spotify" && state.spotifyLimitedUntil > Date.now() ? state.spotifyLimitedUntil : null;
  // With nothing playing and nothing to say, the player folds; a song starting never opens it.
  if (idle !== (!now && !limitedUntil)) {
    idle = !idle;
    if (idle && panels.inspector) {
      panels.inspector = false;
      forced.inspector = false;
      slidePanels();
    }
  }
  set($("blank"), "textContent", limitedUntil ? spotifyLimited(limitedUntil) : t("nothingPlaying"));
  set($("song"), "textContent", now?.title ?? "");
  set($("artist"), "textContent", now ? (now.generated ? t("madeByMoondog") : now.artists.join(", ")) : "");
  set($("album"), "textContent", now?.album ?? "");
  // The heart keeps what plays now; it fills once this song is kept, until another one plays.
  const keep = $("keep");
  set(keep, "hidden", !now || Boolean(now.making) || !state.libraryReady || (!now.generated && !now.artists?.length));
  setIcon(keep, now && keptNow === songKey(now) ? "saved-fill" : "saved");
  keep.setAttribute("aria-pressed", String(Boolean(now) && keptNow === songKey(now)));
  renderProgress(now);

  // The record On Air is cutting can't be played, paused or skipped, so it offers no transport.
  set($("transport"), "hidden", !now || Boolean(now.making));
  deep?.turn(immersed() && Boolean(now?.playing));
  if (now && !now.making) {
    drawControls(now, $("toggle"), $("next"));
    set($("previous"), "disabled", !can(now, "skipping_prev"));
  }
  // Where the music plays opens the choice of device and service: Spotify's device, Apple Music
  // playing in the window, or NetEase playing through ncm-cli on this Mac.
  const neteaseNow = now?.service === "netease";
  const spotifyNow = now && !now.local && !neteaseNow;
  const appleNow = now?.local && !now.generated && state.playbackService === "apple_music";
  set($("where"), "hidden", !(spotifyNow ? now.device || now.link : now?.local || neteaseNow));
  set($("device-row"), "hidden", spotifyNow ? !now.device : !(appleNow || neteaseNow));
  if (spotifyNow) {
    set($("device-name"), "textContent", now.device ?? "");
    setIcon($("device-row"), DEVICE_ICONS[String(now.deviceType ?? "").toLowerCase()] ?? "speaker");
  } else if (appleNow || neteaseNow) {
    set($("device-name"), "textContent", appleNow ? "Apple Music" : t("netease"));
    setIcon($("device-row"), "laptop");
  }
  set($("repeat"), "hidden", !spotifyNow || now.repeat !== "track");
  set($("stop-previews"), "hidden", !now?.local);
  name($("stop-previews"), now?.preview ? t("stopPreviews") : t("stop"));
  // The song's own page: Apple Music for a preview, Spotify for a song Spotify plays.
  const external = $("external");
  set(external, "hidden", !now?.link);
  if (now?.link && external.getAttribute("href") !== now.link) {
    external.href = now.link;
    name(external, now.local ? t("fullSong") : t("openInSpotify"));
  }
  // Spotify not connected: the panel offers the one thing that fixes it instead of explaining.
  const offline = state.playbackService === "spotify" && state.spotify === "unavailable" && !now;
  set($("connect-player"), "hidden", !offline);
  set($("connect"), "hidden", !offline || shown("inspector"));

  const next = now?.next ?? [];
  // While On Air cuts its next record behind the one playing, that record waits at the end of Up next.
  const cutting = state.onAir?.phase === "making" && Boolean(now?.generated) && !now.making;
  askProposals(now, next);
  const picks = now ? shownProposals(now, next) : [];
  set($("next-panel"), "hidden", !next.length && !cutting && !picks.length);
  const shownQueue = JSON.stringify([next.map((track) => [track.title, track.artists, track.image]), cutting && t("makingNext"), picks.map((song) => song.ref)]);
  if (shownQueue !== drawnQueue) {
    drawnQueue = shownQueue;
    // A row chosen from the keyboard keeps the focus, or the row now in its place.
    const before = [...$("queue").querySelectorAll(QUEUE_ROWS)];
    const at = before.indexOf(document.activeElement?.closest?.(QUEUE_ROWS));
    $("queue").replaceChildren(...next.map(queueItem), ...(cutting ? [cuttingItem()] : []), ...picks.map(proposalItem));
    const rows = [...$("queue").querySelectorAll(QUEUE_ROWS)];
    const to = at >= 0 ? rows[Math.min(at, rows.length - 1)] : rows[0];
    for (const each of rows) each.tabIndex = each === to ? 0 : -1;
    if (at >= 0) to?.focus();
  }
  // With the player folded away, the song and its two most used controls stay in the bar.
  const mini = $("mini");
  set(mini, "hidden", !now || shown("inspector"));
  if (now && !shown("inspector")) {
    const cover = $("mini-cover");
    if (now.image && cover.getAttribute("src") !== now.image) cover.src = now.image;
    if (!now.image) cover.removeAttribute("src");
    cover.onerror = () => cover.removeAttribute("src");
    set($("mini-song"), "textContent", [now.title, now.generated ? t("madeByMoondog") : now.artists[0]].filter(Boolean).join(" · "));
    // The song reads as itself and opens the player; a tooltip gives the whole line only when it is cut off.
    const song = $("mini-song");
    if (song.scrollWidth > song.clientWidth) $("mini-open").dataset.tip = song.textContent; else delete $("mini-open").dataset.tip;
    set($("mini-toggle"), "hidden", Boolean(now.making));
    set($("mini-next"), "hidden", Boolean(now.making));
    if (!now.making) drawControls(now, $("mini-toggle"), $("mini-next"));
  }
  placeTitle();
  record?.turn(now?.playing && (!talking() || fold.dock < 1));
  const down = armDown(now);
  record?.needle(down);
  deep?.needle(down);
  mark.playing(now?.playing);
  renderMood(now);
  tick();
  syncMenu();
}

// The play or pause the listener just pressed, which outranks reads already on their way for two seconds.
let toggled = null;
function control(action, via = "button") {
  const now = nowPlaying();
  // Nothing plays yet while On Air cuts its next record.
  if (now?.making) return;
  if (now?.local) {
    if (action === "toggle") previews.toggle();
    if (action === "next") previews.next();
    if (action === "previous") previews.previous();
    return;
  }
  const playing = state.player?.now;
  if (!playing) return;
  // The menu and the Dock follow the same rules as the buttons: what Spotify won't do is not tried.
  const rule = { toggle: playing.playing ? "pausing" : "resuming", next: "skipping_next", previous: "skipping_prev" }[action];
  if (!can(now, rule)) return;
  const at = { observedAt: Date.now() };
  if (action === "toggle") {
    // The button answers at once; the next read from Spotify confirms it.
    send({ type: "control", action: playing.playing ? "pause" : "resume", via });
    toggled = { playing: !playing.playing, until: Date.now() + 2000 };
    state.player.now = { ...playing, playing: !playing.playing, progressMs: now.progressMs, ...at };
  } else {
    send({ type: "control", action, via });
    // Next shows the song that comes next at once; previous restarts the song, as Spotify does after its first seconds.
    const [upcoming, ...rest] = state.player.next ?? [];
    if (action === "next" && upcoming) {
      state.player = { now: { ...playing, ...upcoming, playing: true, progressMs: 0, ...at }, next: rest };
    } else if (action === "previous" && now.progressMs > 3000) state.player.now = { ...playing, progressMs: 0, ...at };
    else return;
  }
  renderInspector();
  renderProgress(nowPlaying(), { jump: true });
}
$("toggle").addEventListener("click", () => control("toggle"));
$("next").addEventListener("click", () => control("next"));
$("previous").addEventListener("click", () => control("previous"));
$("mini-open").addEventListener("click", () => togglePanel("inspector"));
$("mini-toggle").addEventListener("click", () => control("toggle"));
$("mini-next").addEventListener("click", () => control("next"));
// On air, the stop under a made track, or under the record being cut, takes the stream off the air too.
$("stop-previews").addEventListener("click", () => {
  if (state.onAir && nowPlaying()?.generated) stopOnAir();
  previews.stop();
});

// Taking hold of the progress line moves the song there when you let go; the arrow keys move it by
// five seconds (fifteen with Shift), Home and End to either end.
let seekedAt = 0;
function seekTo(positionMs, via) {
  seekedAt = Date.now();
  const now = nowPlaying();
  if (!now?.durationMs || !can(now, "seeking")) return;
  const position = Math.round(Math.min(now.durationMs - 1000, Math.max(0, positionMs)));
  if (now.local) previews.seek(position);
  else if (state.player?.now) {
    send({ type: "control", action: "seek", positionMs: position, via });
    state.player.now = { ...state.player.now, progressMs: position, observedAt: Date.now() };
  }
  renderInspector();
  renderProgress(nowPlaying(), { jump: true });
}
$("track").addEventListener("pointerdown", (event) => {
  const now = nowPlaying();
  const track = event.currentTarget;
  if (!now?.durationMs || !can(now, "seeking") || event.button !== 0) return;
  event.preventDefault();
  track.setPointerCapture(event.pointerId);
  track.classList.add("dragging");
  const drag = new AbortController();
  const at = (moved) => {
    const box = track.getBoundingClientRect();
    seeking = { fraction: Math.min(1, Math.max(0, (moved.clientX - box.left) / box.width)) };
    renderProgress(nowPlaying());
  };
  at(event);
  // Letting go seeks; a cancelled drag (the pointer captured elsewhere) puts the line back.
  const end = (commit) => () => {
    drag.abort();
    track.classList.remove("dragging");
    const fraction = seeking?.fraction;
    seeking = null;
    if (commit && fraction !== undefined) seekTo(fraction * now.durationMs);
    else renderInspector();
  };
  track.addEventListener("pointermove", at, { signal: drag.signal });
  track.addEventListener("pointerup", end(true), { signal: drag.signal });
  track.addEventListener("pointercancel", end(false), { signal: drag.signal });
});
// Held or repeated keys move the line at once and send one seek when the keys rest, so Spotify
// gets one request instead of a burst, and a late read can't pull the line back mid-way.
let keySeek = null;
$("track").addEventListener("keydown", (event) => {
  const now = nowPlaying();
  if (!now?.durationMs || !can(now, "seeking")) return;
  const step = event.shiftKey ? 15_000 : 5_000;
  const from = keySeek?.ms ?? now.progressMs;
  const to = { ArrowLeft: from - step, ArrowRight: from + step, Home: 0, End: now.durationMs - 1000 }[event.key];
  if (to === undefined) return;
  event.preventDefault();
  clearTimeout(keySeek?.timer);
  const ms = Math.min(now.durationMs - 1000, Math.max(0, to));
  keySeek = { ms, timer: setTimeout(() => { keySeek = null; seekTo(ms); }, 250) };
  seeking = { fraction: ms / now.durationMs };
  renderProgress(now, { jump: true });
  seeking = null;
});

// The wheel over the record turns it by hand, as a DJ moves a record: the record follows the travel
// along its rim, and the song's place moves with it, in a quiet clock just above the record and on
// the player's progress line. The music goes there once the wheel rests, in one seek, so Spotify
// gets one request. A slow hand moves finely; a quick one covers more of the song, up to eight
// times as much. At either end of the song the record stops with it.
const SCRATCH_MS = 15;
const SCRATCH_GAIN = 8;
const SCRATCH_REST_MS = 240;
const scratchClock = $("scratch");
let scratch = null;
let scratchFade = 0;
function scratchWith(target, event) {
  const now = nowPlaying();
  if (!target || !now?.durationMs || !can(now, "seeking")) return;
  event.preventDefault();
  const lines = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? innerHeight : 1;
  const travel = (Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY) * lines;
  if (!travel) return;
  const song = `${now.title}|${now.durationMs}`;
  if (scratch?.song !== song) { clearTimeout(scratch?.timer); scratch = { song, ms: keySeek?.ms ?? now.progressMs, at: event.timeStamp, speed: 0 }; }
  // The hand's speed in pixels a millisecond, smoothed over a few events.
  const gap = Math.min(120, Math.max(8, event.timeStamp - scratch.at));
  scratch.speed = scratch.speed * 0.6 + Math.abs(travel) / gap * 0.4;
  scratch.at = event.timeStamp;
  const wanted = travel * SCRATCH_MS * Math.min(SCRATCH_GAIN, 1 + scratch.speed ** 2);
  const to = Math.min(now.durationMs - 1000, Math.max(0, scratch.ms + wanted));
  target.spin(travel * (to - scratch.ms) / wanted);
  scratch.ms = to;
  seeking = { fraction: to / now.durationMs };
  renderProgress(now, { jump: true });
  showScratch(target, to, now.durationMs);
  clearTimeout(scratch.timer);
  scratch.timer = setTimeout(() => {
    const { ms, song: scratched } = scratch;
    scratch = null;
    seeking = null;
    const playing = nowPlaying();
    if (playing && `${playing.title}|${playing.durationMs}` === scratched) seekTo(ms, "record"); else renderInspector();
    clearTimeout(scratchFade);
    scratchFade = setTimeout(() => scratchClock.classList.remove("on"), 700);
  }, SCRATCH_REST_MS);
}
// The clock sits centered just above the disc being turned, inside the window.
function showScratch(target, ms, durationMs) {
  clearTimeout(scratchFade);
  const place = target.place();
  if (!place) return;
  scratchClock.textContent = `${clock(ms)} / ${clock(durationMs)}`;
  scratchClock.style.translate = `${Math.round(place.x)}px ${Math.round(Math.max(28, place.y - place.radius - 8))}px`;
  scratchClock.classList.add("on");
}

// ── Panels ───────────────────────────────────────────────────────────────────────────────────
// A narrow window folds the player, then the conversations; a click always wins. The conversations
// open as the listener last left them. The player opens only by hand: it starts folded, already in the
// markup so it never shows before this runs, and folds again when nothing is left to play.
const layout = $("window");
const panels = { sidebar: store.get("moondog.sidebar") !== "hidden", inspector: false };
const roomFor = { sidebar: 820, inspector: 1060 };
const forced = { sidebar: false, inspector: false };
// Nothing playing: the player has nothing to hold.
let idle = true;
function shown(panel) {
  return panels[panel] && (forced[panel] || innerWidth >= roomFor[panel]);
}
function renderPanels() {
  layout.classList.toggle("no-sidebar", !shown("sidebar"));
  layout.classList.toggle("no-inspector", !shown("inspector"));
  $("toggle-sidebar").setAttribute("aria-pressed", String(shown("sidebar")));
  $("toggle-inspector").setAttribute("aria-pressed", String(shown("inspector")));
  renderTitle();
}
let settleTimer = 0;
// The room keeps at least this much width; opening one panel folds the other when both won't fit.
const ROOM_MIN = 440;
const widthOf = (panel) => parseInt(getComputedStyle(layout).getPropertyValue(`--${panel}-width`), 10) || (panel === "sidebar" ? 248 : 320);
function makeRoom(opened) {
  const other = opened === "sidebar" ? "inspector" : "sidebar";
  if (shown(opened) && shown(other) && innerWidth - widthOf(opened) - widthOf(other) < ROOM_MIN) { panels[other] = false; forced[other] = false; }
}
function togglePanel(panel) {
  const visible = shown(panel);
  panels[panel] = !visible;
  // A click overrides the width rule only where the width rule would hide the panel.
  forced[panel] = !visible && innerWidth < roomFor[panel];
  if (!visible) makeRoom(panel);
  if (panel === "sidebar") store.set("moondog.sidebar", panels.sidebar ? "shown" : "hidden");
  slidePanels();
  renderInspector();
}
// The columns slide only for a deliberate move or a song starting or ending; dragging a grip stays exact.
function slidePanels() {
  layout.classList.add("animating");
  renderPanels();
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => layout.classList.remove("animating"), 300);
  // The record stays centered on the conversation while the columns slide.
  const until = performance.now() + 320;
  const track = () => { placeRecord(); if (performance.now() < until) requestAnimationFrame(track); };
  requestAnimationFrame(track);
}
addEventListener("resize", () => {
  if (immersed()) return;
  for (const panel of ["inspector", "sidebar"]) if (forced[panel]) makeRoom(panel);
  renderPanels();
  renderInspector();
  placeSoon();
});

// Dragging a panel's inner edge sets its width; a double-click restores the default.
const widths = { sidebar: [200, 420], inspector: [272, 460] };
for (const panel of ["sidebar", "inspector"]) {
  const property = `--${panel}-width`;
  const saved = Number(store.get(`moondog.${panel}.width`));
  if (saved >= widths[panel][0] && saved <= widths[panel][1]) layout.style.setProperty(property, `${saved}px`);
  const grip = document.querySelector(`[data-grip="${panel}"]`);
  grip.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    grip.setPointerCapture(event.pointerId);
    grip.classList.add("dragging");
    layout.classList.add("resizing");
    const move = (moved) => {
      const width = panel === "sidebar" ? moved.clientX : innerWidth - moved.clientX;
      layout.style.setProperty(property, `${Math.round(Math.min(widths[panel][1], Math.max(widths[panel][0], width)))}px`);
    };
    const up = () => {
      grip.removeEventListener("pointermove", move);
      grip.classList.remove("dragging");
      layout.classList.remove("resizing");
      store.set(`moondog.${panel}.width`, String(parseInt(getComputedStyle(layout).getPropertyValue(property), 10) || ""));
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up, { once: true });
    grip.addEventListener("pointercancel", up, { once: true });
  });
  grip.addEventListener("dblclick", () => {
    layout.style.removeProperty(property);
    store.set(`moondog.${panel}.width`, "");
  });
}
$("toggle-sidebar").addEventListener("click", () => togglePanel("sidebar"));
$("toggle-inspector").addEventListener("click", () => togglePanel("inspector"));
$("new").addEventListener("click", () => openSession(null));
// The heart beside the song keeps it in Saved; a right-click offers the listener's playlists, or a new one.
$("keep").addEventListener("click", () => send({ type: "library-save", ...keepArtwork() }));
$("keep").addEventListener("contextmenu", async (event) => {
  event.preventDefault();
  const playlists = state.library.playlists.filter((each) => !each.saved).sort((a, b) => a.name.localeCompare(b.name));
  const chosen = await menu([{ id: "saved", label: t("saved") }, ...(playlists.length ? [{ type: "separator" }] : []),
    ...playlists.map((each) => ({ id: `to:${each.id}`, label: each.name }))], event);
  if (chosen === "saved") send({ type: "library-save", ...keepArtwork() });
  if (chosen?.startsWith("to:")) send({ type: "library-save", playlistId: chosen.slice(3), ...keepArtwork() });
});
const keepArtwork = () => { const image = nowPlaying()?.image; return typeof image === "string" && image.startsWith("https://") ? { artwork: image } : {}; };
scrollbar($("sessions"));
scrollbar($("library"));
scrollbar($("shelf").querySelector(".shelf-scroll"));
scrollbar($("inspector-scroll"));
// Long conversation names and long song lines roll into view under the pointer. A conversation's
// name keeps clear of the ⋯ button that floats over its end; a branch's number already steps aside.
marquee($("library"), ".row, .folder-head", { find: (row) => row.querySelector(".name"), tail: (line) => (line.closest(".row") ? 34 : 0) });
marquee($("sessions"), ".row, .folder-head", {
  find: (row) => row.querySelector(".name .base") ?? row.querySelector(".name"),
  tail: (line) => (line.closest(".row") && !line.classList.contains("base") ? 34 : 0),
});
marquee($("now"), ".song h2, .song p", { tail: () => 16 });

// A music history file dropped anywhere goes to import, which shows what it read before saving.
// Images go with the next message instead, and the hint says which will happen.
let dragDepth = 0;
const hasFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes("Files");
const onlyImages = (list) => list.length > 0 && [...list].every((entry) => IMAGE_TYPES.has(entry.type));
const hideDrops = () => { $("drop").hidden = true; };
window.addEventListener("dragenter", (event) => {
  if (!hasFiles(event)) return;
  dragDepth += 1;
  const images = onlyImages(event.dataTransfer.items ?? []);
  $("drop-hint").textContent = t(images ? "dropToAttach" : "dropToImport");
  setIcon($("drop"), images ? "plus" : "record");
  $("drop").hidden = false;
});
window.addEventListener("dragleave", (event) => { if (!hasFiles(event)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) hideDrops(); });
window.addEventListener("dragover", (event) => { if (hasFiles(event)) event.preventDefault(); });
window.addEventListener("drop", (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth = 0;
  hideDrops();
  if (onlyImages(event.dataTransfer.files)) { void attachImages(event.dataTransfer.files); return; }
  const file = event.dataTransfer.files[0];
  const path = file ? window.moondogApp?.pathForFile?.(file) : null;
  if (path) { send({ type: "import-file", path }); settings.show("library"); }
});

// Keys: typing anywhere goes to the composer. No plain key plays, pauses or skips, because a chat
// window is typed in all the time; the Playback menu's keys do (app/platform.mjs).
document.addEventListener("keydown", (event) => {
  // Escape that just closed Settings is spent; it must not also stop the reply behind it.
  if (settings.open || event.defaultPrevented) return;
  if (immersed()) { if (event.key === "Escape" && !pinned) immerse(false); return; }
  if (event.target === input || event.target.closest?.("input, textarea")) return;
  if (event.key === " " && event.target.closest?.("button, a, select, [role=button]")) return;
  if (event.key === "Escape" && state.streaming) { send({ type: "cancel" }); return; }
  if (event.key === "Escape" && state.shelf) { closePlaylist(); return; }
  if (event.key === "Escape" && state.taste) { closeTaste(); return; }
  if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) input.focus();
});
// Commands from the menu bar.
window.moondogApp?.onCommand?.((command) => {
  if (settings.open && !["settings", "stop", "toggle-playback", "next", "previous", "on-air"].includes(command)) return;
  // A command that shows the conversation, a panel or Settings first brings the window back from the record alone.
  if (immersed() && ["new", "settings", "toggle-sidebar", "toggle-library", "toggle-taste", "toggle-inspector", "toggle-record"].includes(command)) immerse(false);
  if (command === "new") openSession(null);
  if (command === "stop" && state.streaming) send({ type: "cancel" });
  if (command === "settings") settings.show();
  if (command === "toggle-playback") control("toggle", "menu");
  if (command === "next") control("next", "menu");
  if (command === "previous") control("previous", "menu");
  if (command === "on-air") toggleOnAir();
  if (command === "toggle-sidebar") togglePanel("sidebar");
  if (command === "toggle-library") toggleLibrary();
  if (command === "toggle-taste") toggleTaste();
  if (command === "toggle-inspector") togglePanel("inspector");
  if (command === "toggle-record") toggleRecord();
});
document.addEventListener("visibilitychange", () => send({ type: "visible", visible: !document.hidden }));
window.addEventListener("focus", () => { if (!settings.open && !getSelection()?.toString() && !document.activeElement?.closest?.(".rename, .edit")) input.focus(); });

// ── Messages from the core ───────────────────────────────────────────────────────────────────
function streamingTurn(id) {
  return state.turns.find((turn) => turn.role === "assistant" && turn.id === id);
}
const onScreen = (data) => !data.session || data.session === state.current;
const SIGN_IN_ERRORS = { connect_while_answering: "waitForReply", sign_in_busy: "signInBusy" };
const SETTINGS_MESSAGES = new Set(["models", "provider-models", "model-list", "model-roles", "endpoint", "devices", "memories", "auth-prompt", "auth-prompt-closed", "auth-event", "sign-in", "import", "notice", "netease-checked", "generation-checked", "generation-setup"]);
function receive({ data }) {
  if (!data?.type) return;
  if (data.type === "preview" || data.type === "preview-control" || data.type === "preview-enqueue") { previews.receive(data); renderInspector(); return; }
  if (SETTINGS_MESSAGES.has(data.type)) settings.receive(data);
  if (data.type === "model-list" && !data.error) { modelList = { models: data.models ?? [], default: data.default ?? null }; renderComposer(); }
  if (data.type === "devices" && devicePicker) {
    if (data.error) { devicePicker = null; notice(data.error === "limited" ? spotifyLimited(data.resumeAt) : t("noticeDevicesFailed")); }
    else void showDevices(data.devices ?? []);
  }
  if (data.type === "player-error") notice(t("noticePlaybackFailed"));
  // The host's picks for the song playing now; a pick that couldn't be added says so.
  if (data.type === "up-next-proposals") {
    proposals = { key: data.key, songs: Array.isArray(data.songs) ? data.songs : [] };
    for (const song of proposals.songs) offered.push({ title: song.title, artists: song.artists });
    offered.splice(0, Math.max(0, offered.length - 20));
    renderInspector();
  }
  if (data.type === "up-next-queued" && ["failed", "not_found", "not_playing"].includes(data.state)) notice(t("noticeAddToUpNextFailed"));
  if (data.type === "library") {
    state.library = { folders: data.folders ?? [], playlists: data.playlists ?? [] };
    // A message's @ names are drawn from the library, which comes after the conversation at launch.
    if (!state.libraryReady) { state.libraryReady = true; renderSidebarMode(); renderInspector(); if (!state.shelf && !state.taste) renderConversation({ redraw: true }); }
    set($("library-add"), "hidden", false);
    renderPlaceholder();
    library.render();
    shelf.render();
  }
  if (data.type === "library-playlist" && state.shelf?.id === data.id) {
    // A playlist deleted here, in the terminal or by Moondog closes, and the conversation comes back.
    if (!data.playlist) closePlaylist();
    else { state.shelf.playlist = data.playlist; shelf.render(); renderPlaceholder(); }
  }
  if (data.type === "library-made" && data.id) openPlaylist(data.id);
  // A playlist link read: one question, with whether it shapes the listener's taste beside it. A playlist they made
  // starts checked; one a service or someone else made starts unchecked.
  if (data.type === "library-import-preview") void askImport(data);
  if (data.type === "library-imported") {
    library.importDone();
    if (data.playlist?.id) openPlaylist(data.playlist.id);
    notice(data.taste === "added" ? t("importedWithTaste", { name: data.playlist?.name ?? "" }) : data.taste === "failed" ? t("importedTasteFailed")
      : t("importedPlaylist", { name: data.playlist?.name ?? "" }));
  }
  if (data.type === "notice") library.importDone();
  if (data.type === "library-saved") {
    const now = nowPlaying();
    if (now && data.playlist?.saved) keptNow = songKey(now);
    const where = data.playlist?.saved ? t("saved") : data.playlist?.name ?? "";
    notice(data.added ? (data.playlist?.saved ? t("keptInSaved") : t("savedTo", { name: where })) : t("alreadyIn", { name: where }));
    renderInspector();
  }
  if (data.type === "library-exported") void exported(data);
  if (data.type === "library-played") {
    if (data.state === "not_found" || data.state === "empty") notice(t(data.state === "empty" ? "playlistEmpty" : "noticeNothingFound"));
    else if (data.left_out_made) notice(t("madeLeftOut"));
    else if (data.not_found) notice(t("notFoundSome"));
  }
  // The sheet shows its own sign-in errors. sign_in_busy is the exception: the sheet keeps the running panel.
  if (data.type === "sign-in" && data.state === "error" && !(settings.open && data.code !== "sign_in_busy")) notice(SIGN_IN_ERRORS[data.code] ? t(SIGN_IN_ERRORS[data.code]) : t("signInFailed"));
  if (data.type === "import" && data.stage === "refresh-failed") notice(t("importRefreshFailed"));
  // The taste view and page show the core's profile; they ask again after an import or a reply, which can change it.
  if (data.type === "taste") { state.tasteData = data; tasteList.render(); if (state.taste) taste.render(); }
  if (data.type === "taste-why" || (data.type === "notice" && String(data.code).startsWith("taste"))) tasteList.receive(data);
  if ((state.taste || views.showing("taste")) && ((data.type === "import" && data.stage === "done") || (data.type === "turn" && data.state !== "start"))) send({ type: "taste" });
  if (data.type === "notice") {
    // The core did not take this message. Put it back so the listener can send it again.
    const pending = state.turns.findLastIndex((turn) => turn.pending && (!data.text || turn.text === data.text));
    if ((data.code === "message_busy" || data.code === "prompt") && pending >= 0) {
      const [turn] = state.turns.splice(pending, 1);
      renderConversation();
      if (!input.value.trim()) { input.value = turn.text; renderComposer(); }
      // Its images go back above the composer too.
      if (turn.attachments?.length && !attachments.length) { attachments = turn.attachments; renderAttachments(); renderComposer(); }
    }
    if (data.message) console.warn(`[moondog] ${data.code}: ${data.message}`);
    // A refused switch leaves the open conversation marked as open.
    if (data.code === "too_many_running") renderSessions();
    notice(t(NOTICES[data.code] ?? "noticeFailed"));
  }
  if (data.type === "ready" || data.type === "status") {
    if (data.locale && data.locale !== locale) applyLanguage(data.locale);
    for (const key of ["model", "spotify", "spotifyAccount", "playbackService", "netease", "neteaseMessage", "generation", "locales", "firstRun", "onAir"]) if (data[key] !== undefined) state[key] = data[key];
    if (state.onAir) dropOnAirAsk();
    if (sourceWanted === state.playbackService) sourceWanted = null;
    // With Apple Music chosen, the window learns once whether it can play whole songs.
    if (state.playbackService === "apple_music" && !previews.fullStatus()) void previews.check();
    renderComposer();
    renderInspector();
    settings.render();
    // The first run asks while the core says it is needed, and steps aside once it is over here or in the terminal.
    firstRun.update();
  }
  if (data.type === "ready" || data.type === "sessions") {
    state.sessions = data.sessions ?? [];
    state.folders = data.folders ?? [];
    state.running = data.running ?? [];
    state.current = data.current ?? state.current;
    window.moondogApp?.setBusy?.(state.running.length > 0);
    renderSessions();
    renderComposer();
  }
  if (data.type === "ready" || data.type === "session") {
    // A message waiting for the core stays on screen until the core takes it.
    // So does a message starting its own conversation, until that conversation's turn starts.
    const waiting = state.turns.filter((turn) => (data.type === "ready" && turn.waiting) || (data.type === "session" && turn.pending && turn.fresh));
    state.current = data.current ?? null;
    state.turns = [...(data.transcript ?? []).map((turn) => ({ ...turn })), ...waiting];
    state.streaming = null;
    if (data.live) {
      state.turns.push({ role: "user", text: data.live.user },
        { role: "assistant", id: data.live.id, text: data.live.text, activity: data.live.activity ?? [], streaming: true });
      state.streaming = data.live.id;
    }
    renderSessions();
    renderConversation({ redraw: true });
    syncMenu();
    if (!settings.open) input.focus();
  }
  if (data.type === "ready") {
    state.ready = true;
    // A message typed while the core started can be sent now, and On Air can be asked for.
    renderComposer();
    renderInspector();
    send({ type: "model-list" });
    const waiting = state.waiting;
    state.waiting = null;
    if (waiting) {
      state.turns = state.turns.filter((turn) => !turn.waiting);
      renderConversation({ redraw: true });
      submitText(waiting);
    }
  }
  // Branch moved the window to a new conversation that looks like the old one up to that reply.
  if (data.type === "branched" && onScreen(data)) {
    input.focus();
    notice(t("branched"));
  }
  if (data.type === "local" && onScreen(data)) {
    state.turns.push({ role: "assistant", text: data.markdown, local: true });
    renderConversation();
  }
  if (data.type === "turn" && onScreen(data)) {
    if (data.state === "start") {
      state.streaming = data.id;
      // The reply to the arm's or On Air's request has begun, so its end can lift the arm and the mark.
      if (cue) cue.seen = true;
      if (onAirAsk) onAirAsk.seen = true;
      const pending = state.turns.findLastIndex((turn) => turn.pending && turn.text === data.text);
      // The bubble keeps the images the listener attached.
      const [sent] = pending >= 0 ? state.turns.splice(pending, 1) : [];
      state.turns.push({ role: "user", text: data.text, ...(sent?.images ? { images: sent.images } : {}) },
        { role: "assistant", id: data.id, text: "", activity: [], streaming: true });
    } else {
      const turn = streamingTurn(data.id);
      if (turn) {
        turn.streaming = false;
        // The message and its reply are saved now, so the message can be edited and the reply branched from.
        const asked = state.turns[state.turns.indexOf(turn) - 1];
        if (data.entry && asked?.role === "user") { asked.entry = data.entry; turn.entry = data.entry; }
        if (data.state === "end") {
          turn.receipts = data.receipts ?? [];
          turn.text = data.text || turn.text || (data.status === "aborted" ? t("stopped") : "");
          if (data.status === "aborted" && !data.text) turn.failed = true;
        } else {
          if (data.message) console.warn(`[moondog] turn failed: ${data.message}`);
          turn.text = data.connection ? t("unreachable") : t("noticeFailed");
          turn.failed = true;
        }
      }
      if (state.streaming === data.id) state.streaming = null;
    }
    renderConversation();
    renderInspector();
  }
  // On Air's stream changed: it started, moved to another phase, made a track, or ended. A stream that
  // ends by itself goes dark silently; only one that couldn't make its next record says so.
  if (data.type === "on-air") {
    state.onAir = data.onAir ?? null;
    if (state.onAir) dropOnAirAsk();
    if (data.ended === "failed") notice(t("onAirFailed"));
    renderInspector();
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
      // A tool starting means the retried model call went through, so "Trying again" does not stay up.
      turn.retrying = false;
      renderSoon();
    }
  }
  if (data.type === "player") {
    // A read that fails, such as a network blip, keeps the last known player on screen.
    if (data.spotify === "error") return;
    // Spotify asked Moondog to wait: still connected, with nothing to read until then.
    state.spotifyLimitedUntil = data.spotify === "limited" ? data.resumeAt : null;
    state.spotify = data.spotify === "ready" || data.spotify === "limited" ? "ready" : "unavailable";
    // Spotify's position arrives a little late. On the same playing song, a small step backwards is
    // that delay, not the music, so the clock keeps going instead of ticking back.
    const before = state.player?.now;
    let now = data.now;
    // Right after a seek, a read that was already on its way still has the old position; right after
    // a press of play or pause, it can still have the old state, and Spotify reports a pause late.
    if (now && before && before.title === now.title && toggled && Date.now() < toggled.until && now.playing !== toggled.playing) {
      now = { ...now, playing: toggled.playing, progressMs: before.progressMs, observedAt: before.observedAt };
    } else if (now && before && before.title === now.title && Date.now() - seekedAt < 1500) now = { ...now, progressMs: before.progressMs, observedAt: before.observedAt };
    else if (now?.playing && before?.playing && before.title === now.title && before.durationMs === now.durationMs) {
      const expected = before.progressMs + (now.observedAt - before.observedAt);
      if (now.progressMs < expected && expected - now.progressMs < 1500) now = { ...now, progressMs: before.progressMs, observedAt: before.observedAt };
    }
    state.player = { now, next: data.next ?? [] };
    let learned = false;
    for (const track of [data.now, ...(data.next ?? [])]) {
      if (track?.image && covers.get(track.title) !== track.image) { covers.set(track.title, track.image); learned = true; }
    }
    // Redraw the conversation only when a played line just got its cover.
    if (learned && state.turns.some((turn) => { const target = playedTarget(turn); return target && covers.has(target.title); })) renderSoon();
    renderInspector();
  }
}

applyLanguage(locale);
renderPanels();
send({ type: "visible", visible: !document.hidden });
input.focus();
void tips;

// The core's port arrives last; what was sent before it waits in the outbox.
port = await portReady;
port.onmessage = receive;
for (const message of outbox.splice(0)) port.postMessage(message);
