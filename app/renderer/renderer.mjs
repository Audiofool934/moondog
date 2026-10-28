// The window's page: conversations on the left, the conversation in the middle, and what is
// playing on the right. The core process does the listening work; this page only draws it.
import { languageTag, timeOfDay, windowLocale, windowStrings } from "../strings.mjs";
import { renderMarkdown } from "./markdown.mjs";
import { createPalette } from "./palette.mjs";
import { createPreviews } from "./previews.mjs";
import { coverPalette, grooveColours, moodColours } from "./mood.mjs";
import { createMark, scratchMark } from "./mark.mjs";
import { mountRecord } from "./record.mjs";
import { createSettings } from "./settings.mjs";
import { createSidebar } from "./sidebar.mjs";
import { icon, make, marquee, name, scrollbar, setIcon, tooltips } from "./ui.mjs";
import "./style.css";

const $ = (selector) => document.querySelector(`[data-${selector}]`);

let locale = windowLocale(navigator.languages);
let t = windowStrings(locale);
const tr = () => t;
// Spotify's state is unknown (null) until the core first reads it. turns and streaming belong to the
// conversation on screen; other conversations keep answering in the core and come back when opened.
const state = { sessions: [], folders: [], running: [], current: null, turns: [], model: null, spotify: null, spotifyAccount: null,
  playbackService: "spotify", locale, locales: [], player: null, streaming: null, ready: false, waiting: null, update: { phase: "idle" } };
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
const settings = createSettings({ state, send, t: tr, prettyModel: (model) => prettyModel(model),
  appleMusic: { status: () => previews.fullStatus(), check: (command) => previews.check(command) } });
const sidebar = createSidebar({ root: $("sessions"), state, send, t: tr, open: (id) => openSession(id), store, menuPoint: (event) => menuPoint(event) });
const tips = tooltips();
// A native menu opens at the pointer, or under its control when the keyboard pressed it.
function menuPoint(event) {
  const control = event?.currentTarget;
  if (((event?.type === "click" && event.detail === 0) || event?.type === "keydown") && control?.getBoundingClientRect) {
    const box = control.getBoundingClientRect();
    return { x: box.left, y: box.bottom + 4 };
  }
  return event ? { x: event.clientX, y: event.clientY } : undefined;
}
const menu = (items, event) => window.moondogApp?.showMenu?.(items, menuPoint(event));

// Words
function applyLanguage(next) {
  locale = next;
  state.locale = next;
  t = windowStrings(locale);
  document.documentElement.lang = languageTag(locale);
  input.placeholder = t("placeholder");
  name($("toggle-sidebar"), t("conversations"), "⌥⌘S");
  name($("toggle-inspector"), t("player"), "⌥⌘P");
  name($("new"), t("newConversation"), "⌘N");
  // These self-explanatory controls keep accessible names without floating labels over the record.
  for (const [node, key] of [[recordButton, "foldRecord"], [barRecord, "showRecord"], [$("expand"), "immerse"], [$("pin"), "keepOnTop"], [$("immersive"), "restore"]]) {
    node.setAttribute("aria-label", t(key));
  }
  name($("settings-button"), t("settings"), "⌘,");
  renderUpdate();
  name($("previous"), t("previous"), "⌃⌘←");
  name($("next"), t("next"), "⌃⌘→");
  name($("mini-next"), t("next"), "⌃⌘→");
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
// Another conversation can open while this one is still answering; it keeps going in the core.
function openSession(id) {
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
  rewind_busy: "waitForReply", rewind_failed: "noticeFailed" };

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
  [/^moondog_music_preview$/u, "previews"],
  [/^moondog_netease_control$/u, (args) => ({ pause: "pause", stop: "pause", next: "skip", previous: "skip" })[args?.action] ?? "play"],
  [/^moondog_netease_play$/u, (args) => (args?.mode === "queue" ? "queue" : "play")],
  [/^moondog_netease_search$/u, "search"],
  [/^moondog_netease_now_playing$/u, "status"],
  [/^moondog_listening_now$/u, "status"],
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
// Growing back from half to full size under the hand takes at least this long.
const GROW_MS = 600;
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
let placedAt = 0;
function placeRecord() {
  placing = 0;
  placeTitle();
  if (!talking() || immersed()) return;
  const size = recordSize();
  const where = measure();
  let at = foldWanted(size);
  const now = performance.now();
  const lapse = Math.min(50, now - placedAt);
  placedAt = now;
  if (glided) {
    // A glide takes the record from its size where it began to its size where it ends, never through
    // the sizes on the way, so passing home on the way doesn't swell it.
    const arrive = shrinkAt(Math.abs(Math.min(glided.to(), end()) - home()), size);
    at = { ...at, shrink: lerp(glided.shrink, arrive, glided.eased) };
  } else if (!tween && !reduced.matches && at.shrink < fold.shrink - lapse / GROW_MS) {
    // Shrinking follows the hand; growing back takes its time, so a quick pass by home doesn't
    // flash the record full, and it catches up once the hand slows.
    at = { ...at, shrink: fold.shrink - lapse / GROW_MS };
    placeSoon();
  }
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
// While it waits, the arm still keeps its clicks, so another click neither asks again nor folds the record.
const onArm = (target, event) => (armReady() || Boolean(cue)) && target?.hit(event.clientX, event.clientY) === "arm";
const nearArm = (target, event) => (armReady() ? target?.near(event.clientX, event.clientY) : target?.near(null));
// The arm rests on the record while the music plays, whatever started or stopped it, and while it
// waits for the song it asked for; the record turns only with the music.
const armDown = (now) => Boolean(now?.playing) || cueing(now);
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
// Whether the arm still waits on the record for the song it asked for. A reply that ends without
// music, or none started within 15 seconds, lifts the arm once the grace runs out.
function cueing(now) {
  if (!cue) return false;
  clearTimeout(cue.timer);
  if (now?.playing) { cue = null; return false; }
  if (state.streaming) cue.seen = true;
  else if (cue.seen || Date.now() - cue.at > 15_000) cue.ended ||= Date.now();
  if (cue.ended && Date.now() - cue.ended >= CUE_GRACE_MS) { cue = null; return false; }
  // The arm looks again when its wait could run out; a reply's end looks for itself.
  if (!state.streaming) cue.timer = setTimeout(renderInspector, (cue.ended ? cue.ended + CUE_GRACE_MS : cue.at + 15_000) - Date.now() + 20);
  return true;
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
    const key = turn.role === "user" ? `u|${turn.text}` : `a|${turn.id ?? index}|${turn.local ? "l" : ""}`;
    let entry = nodes[index];
    if (!entry || entry.key !== key) {
      const node = turn.role === "user" ? make("div", "you") : make("div", "turn reply");
      if (turn.role === "user") node.append(make("p", "", turn.text));
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
const providerModels = new Map();
let providers = [];
// Claude models read as their family and version; others by the name their provider gives them.
// A model goes by the name its account lists it under, the same here, in Settings and in the menu.
function prettyModel(model, provider = state.model?.provider) {
  const named = providerModels.get(provider)?.find((entry) => entry.id === model)?.name;
  if (named) return named;
  const claude = String(model ?? "").match(/^claude-(opus|sonnet|haiku|fable)-(\d+)-(\d+)/u);
  return claude ? `Claude ${claude[1][0].toUpperCase()}${claude[1].slice(1)} ${claude[2]}.${claude[3]}` : String(model ?? "");
}
// The menu greys out what would do nothing: transport without a song, Stop Response without a reply.
function syncMenu() {
  window.moondogApp?.setPlayback?.({ controllable: Boolean(nowPlaying()), streaming: Boolean(state.streaming) });
}
function renderComposer() {
  const button = $("send");
  const streaming = Boolean(state.streaming);
  button.disabled = !streaming && (!input.value.trim() || Boolean(state.waiting && !state.ready));
  name(button, streaming ? t("stop") : t("send"), streaming ? "⌘." : "↩");
  setIcon(button, streaming ? "stop" : "up");
  renderPicks();
  syncMenu();
}
// Beside the send button: where the music plays and which model answers, each by its mark, with its
// name in the tooltip and the menu. One not chosen yet reads as the words that choose it: a model,
// without which Moondog can't answer, and on a first launch the music service the listener uses.
const SERVICE_MARKS = { spotify: "spotify", apple_music: "apple-music", netease: "netease" };
// A model shows its maker's mark: by the account it comes through, or for OpenRouter by the maker its
// model id begins with (anthropic/…, x-ai/…); a maker without a mark here shows OpenRouter's, or the model glyph.
const MAKER_MARKS = { anthropic: "claude", openai: "openai", "openai-codex": "openai", google: "gemini", deepseek: "deepseek",
  moonshotai: "kimi", "moonshotai-cn": "kimi", xai: "grok", zai: "zai", openrouter: "openrouter" };
const ROUTED_MARKS = { anthropic: "claude", openai: "openai", google: "gemini", deepseek: "deepseek", moonshotai: "kimi", "x-ai": "grok", "z-ai": "zai" };
const makerMark = (model) => (model.provider === "openrouter" ? ROUTED_MARKS[String(model.model ?? "").split("/")[0]] ?? "openrouter" : MAKER_MARKS[model.provider] ?? "model");
const serviceName = (service) => (service === "netease" ? t("netease") : service === "apple_music" ? "Apple Music" : "Spotify");
const effortName = (level) => (level === "default" ? t("effortDefault") : t(`effort.${level}`) === `effort.${level}` ? level : t(`effort.${level}`));
const asking = () => state.ready && !state.sessions.length && !store.get("moondog.source");
function drawPick(button, { mark, label, words }) {
  button.classList.toggle("needed", Boolean(words));
  set(button.lastChild, "textContent", words ?? "");
  button.querySelector("svg").setAttribute("class", mark === "model" ? "icon" : "icon fill");
  setIcon(button, mark);
  if (words) { delete button.dataset.tip; button.setAttribute("aria-label", words); } else name(button, label);
}
function renderPicks() {
  const service = sourceWanted ?? state.playbackService ?? "spotify";
  drawPick($("service"), { mark: SERVICE_MARKS[service] ?? "spotify", label: serviceName(service), words: asking() ? t("chooseService") : null });
  const model = state.model;
  set($("model"), "hidden", !model);
  if (!model) return;
  const label = [prettyModel(model.model), model.effort ? effortName(model.effort) : ""].filter(Boolean).join(" · ");
  drawPick($("model"), { mark: makerMark(model), label, words: model.model ? null : t("chooseModel") });
}
// The composer grows with its words up to 40% of the window (field-sizing in style.css), then scrolls.
function clearComposer() {
  input.value = "";
}
function submitText(text) {
  // A message typed while the core starts waits for it, shown as sent; more stay in the composer.
  if (!state.ready) {
    if (state.waiting) return false;
    state.waiting = text;
    state.turns.push({ role: "user", text, waiting: true });
    renderConversation();
    return true;
  }
  if (state.model?.state !== "configured") {
    state.turns.push({ role: "user", text }, { role: "assistant", text: t("offline"), failed: true, offline: true, local: true });
    renderConversation();
    return true;
  }
  // The words show at once; the core's start of the turn adopts them.
  state.turns.push({ role: "user", text, pending: true });
  renderConversation();
  send({ type: "prompt", text });
  return true;
}
function submit() {
  if (state.streaming) { send({ type: "cancel" }); return; }
  const text = input.value.trim();
  if (!text) return;
  // A mistyped command stays in the composer instead of going to Moondog as a message.
  const command = text.match(/^\/([A-Za-z]+)$/u)?.[1];
  if (command && !COMMANDS.some((entry) => entry.name === command.toLowerCase())) { notice(t("unknownCommand", { name: command })); return; }
  rest();
  if (submitText(text)) clearComposer();
  renderComposer();
}
$("form").addEventListener("submit", (event) => { event.preventDefault(); submit(); });
input.addEventListener("input", () => renderComposer());
input.addEventListener("keydown", (event) => {
  // Enter sends; while a reply runs it does nothing, so a typed follow-up waits instead of stopping the reply.
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); if (!state.streaming) submit(); }
  if (event.key === "Escape" && state.streaming) { event.preventDefault(); send({ type: "cancel" }); }
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
  { name: "memory", label: "memory", run: () => settings.show("memory") },
  { name: "remember", label: "remember", argument: "cmdRememberArgument", run: (text) => { if (text) { send({ type: "remember", text }); notice(t("remembered")); } } },
  { name: "folder", label: "newFolder", run: () => {
    if (!shown("sidebar")) togglePanel("sidebar");
    sidebar.startNewFolder();
  } },
  { name: "settings", label: "settings", run: () => settings.show() },
  { name: "help", label: "shortcuts", run: () => settings.show("about") },
];
const palette = createPalette({ input, anchor: $("form"), t: tr, commands: () => COMMANDS });

// Pickers open as native menus where they show. The model's button shows only its maker's mark, so
// its menu names what answers: the maker in use over its models, the chosen one checked, each other
// signed-in maker's models in a submenu, then the thinking, with the level it is at.
async function pickModel(event) {
  const model = state.model ?? {};
  const signedIn = providers.filter((provider) => provider.signedIn);
  // A long catalog shows its first models here and the rest in settings.
  const entries = (provider, limit) => {
    const models = providerModels.get(provider.id) ?? [];
    const shown = models.slice(0, limit);
    const chosen = models.find((entry) => provider.id === model.provider && entry.id === model.model);
    if (chosen && !shown.includes(chosen)) shown.unshift(chosen);
    const list = shown.map((entry) => ({ id: `model:${provider.id}:${entry.id}`, label: entry.name ?? entry.id,
      checked: provider.id === model.provider && entry.id === model.model }));
    if (models.length > limit) list.push({ id: "settings", label: t("moreModels") });
    return list;
  };
  const current = signedIn.find((provider) => provider.id === model.provider);
  const items = current ? [{ type: "header", label: current.name }, ...entries(current, 12)] : [];
  const others = signedIn.filter((provider) => provider !== current)
    .map((provider) => ({ id: `provider:${provider.id}`, label: provider.name, submenu: entries(provider, 24) })).filter((item) => item.submenu.length);
  if (others.length) items.push(...(items.length ? [{ type: "separator" }] : []), ...others);
  if (model.effortLevels?.length) {
    items.push({ type: "separator" }, { id: "effort", label: `${t("effort")} · ${effortName(model.effort ?? "default")}`,
      submenu: ["default", ...model.effortLevels].map((level) => ({ id: `effort:${level}`, label: effortName(level), checked: (model.effort ?? "default") === level })) });
  }
  items.push(...(items.length ? [{ type: "separator" }] : []), { id: "settings", label: t("modelSettings") });
  const chosen = await menu(items, event);
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
  const chosen = await menu(items, event);
  if (!chosen) return;
  store.set("moondog.source", "chosen");
  if (chosen === "settings") settings.show("playback");
  else chooseService(chosen.slice(8));
  renderComposer();
}
function chooseService(service) {
  if (service === (sourceWanted ?? state.playbackService)) return;
  if (previews.active() && service === "spotify") previews.stop();
  sourceWanted = service;
  clearTimeout(wantedTimer);
  wantedTimer = setTimeout(() => { sourceWanted = null; renderComposer(); }, 10_000);
  send({ type: "music-service", service });
}
// Where music plays: Spotify's devices, then the service itself. The menu opens once the devices are read.
let devicePicker = null;
function pickDevice(event) {
  devicePicker = { at: menuPoint(event) ?? anchorPoint() };
  if (state.playbackService === "spotify" && state.spotify === "ready") send({ type: "devices" });
  else void showDevices([]);
}
const anchorPoint = () => { const box = $("form").getBoundingClientRect(); return { x: box.left + 12, y: box.top - 8 }; };
async function showDevices(devices) {
  const at = devicePicker?.at;
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
  const chosen = await window.moondogApp?.showMenu?.(items, at);
  if (chosen === "settings") settings.show("playback");
  else if (chosen?.startsWith("device:")) send({ type: "transfer", ref: chosen.slice(7) });
  else if (chosen?.startsWith("service:") && chosen.slice(8) !== state.playbackService) {
    if (previews.active() && chosen === "service:spotify") previews.stop();
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

// ── What is playing ──────────────────────────────────────────────────────────────────────────
const clock = (ms) => {
  const seconds = Math.max(0, Math.floor((ms ?? 0) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};
// A preview in the window shows while it plays, or while Spotify has nothing playing; a paused
// preview never hides the song Spotify is playing.
function nowPlaying() {
  const preview = previews.state();
  const now = state.player?.now;
  // local: it plays in the window (whole songs or previews); preview: it is a 30-second preview.
  if (preview && (preview.playing || !now?.playing)) return { ...preview, local: true, preview: !preview.full };
  if (!now) return null;
  const progressMs = now.playing ? now.progressMs + (Date.now() - now.observedAt) : now.progressMs;
  return { ...now, progressMs: now.durationMs ? Math.min(progressMs, now.durationMs) : progressMs, next: state.player.next ?? [] };
}
const can = (now, action) => Boolean(now) && (now.local || !(now.disallows ?? []).includes(action));
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
  if (!src) { old.forEach((node) => node.remove()); return; }
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
function queueItem(track) {
  const item = make("li");
  item.append(thumb(track.image, true));
  const words = make("div");
  words.append(make("strong", "", track.title), make("span", "", track.artists.join(", ")));
  item.append(words);
  return item;
}
// The player's buttons and the bar's follow one rule: what the service won't do now is dimmed.
function drawControls(now, toggle, next) {
  name(toggle, now.playing ? t("pause") : t("play"), "⌃⌘P");
  setIcon(toggle, now.playing ? "pause" : "play");
  set(toggle, "disabled", !can(now, now.playing ? "pausing" : "resuming"));
  set(next, "disabled", !can(now, "skipping_next"));
}
function renderInspector() {
  const now = nowPlaying();
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
  set($("artist"), "textContent", now ? now.artists.join(", ") : "");
  set($("album"), "textContent", now?.album ?? "");
  renderProgress(now);

  set($("transport"), "hidden", !now);
  deep?.turn(immersed() && Boolean(now?.playing));
  if (now) {
    drawControls(now, $("toggle"), $("next"));
    set($("previous"), "disabled", !can(now, "skipping_prev"));
  }
  // Where the music plays opens the choice of device and service: Spotify's device, Apple Music
  // playing in the window, or NetEase playing through ncm-cli on this Mac.
  const neteaseNow = now?.service === "netease";
  const spotifyNow = now && !now.local && !neteaseNow;
  const appleNow = now?.local && state.playbackService === "apple_music";
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
  set($("next-panel"), "hidden", !next.length);
  const shownQueue = JSON.stringify(next.map((track) => [track.title, track.artists, track.image]));
  if (shownQueue !== drawnQueue) {
    drawnQueue = shownQueue;
    $("queue").replaceChildren(...next.map(queueItem));
  }
  // With the player folded away, the song and its two most used controls stay in the bar.
  const mini = $("mini");
  set(mini, "hidden", !now || shown("inspector"));
  if (now && !shown("inspector")) {
    const cover = $("mini-cover");
    if (now.image && cover.getAttribute("src") !== now.image) cover.src = now.image;
    if (!now.image) cover.removeAttribute("src");
    cover.onerror = () => cover.removeAttribute("src");
    set($("mini-song"), "textContent", [now.title, now.artists[0]].filter(Boolean).join(" · "));
    // The song reads as itself and opens the player; a tooltip gives the whole line only when it is cut off.
    const song = $("mini-song");
    if (song.scrollWidth > song.clientWidth) $("mini-open").dataset.tip = song.textContent; else delete $("mini-open").dataset.tip;
    drawControls(now, $("mini-toggle"), $("mini-next"));
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
$("stop-previews").addEventListener("click", () => previews.stop());

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
scrollbar($("sessions"));
scrollbar($("inspector-scroll"));
// Long conversation names and long song lines roll into view under the pointer. A conversation's
// name keeps clear of the ⋯ button that floats over its end; a branch's number already steps aside.
marquee($("sessions"), ".row, .folder-head", {
  find: (row) => row.querySelector(".name .base") ?? row.querySelector(".name"),
  tail: (line) => (line.closest(".row") && !line.classList.contains("base") ? 34 : 0),
});
marquee($("now"), ".song h2, .song p", { tail: () => 16 });

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

// Keys: typing anywhere goes to the composer. No plain key plays, pauses or skips, because a chat
// window is typed in all the time; ⌃⌘P, ⌃⌘→ and ⌃⌘← in the Playback menu do.
document.addEventListener("keydown", (event) => {
  // Escape that just closed Settings is spent; it must not also stop the reply behind it.
  if (settings.open || event.defaultPrevented) return;
  if (immersed()) { if (event.key === "Escape" && !pinned) immerse(false); return; }
  if (event.target === input || event.target.closest?.("input, textarea")) return;
  if (event.key === " " && event.target.closest?.("button, a, select, [role=button]")) return;
  if (event.key === "Escape" && state.streaming) { send({ type: "cancel" }); return; }
  if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) input.focus();
});
// Commands from the menu bar.
window.moondogApp?.onCommand?.((command) => {
  if (settings.open && !["settings", "stop", "toggle-playback", "next", "previous"].includes(command)) return;
  // A command that shows the conversation, a panel or Settings first brings the window back from the record alone.
  if (immersed() && ["new", "settings", "toggle-sidebar", "toggle-inspector", "toggle-record"].includes(command)) immerse(false);
  if (command === "new") openSession(null);
  if (command === "stop" && state.streaming) send({ type: "cancel" });
  if (command === "settings") settings.show();
  if (command === "toggle-playback") control("toggle", "menu");
  if (command === "next") control("next", "menu");
  if (command === "previous") control("previous", "menu");
  if (command === "toggle-sidebar") togglePanel("sidebar");
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
const SETTINGS_MESSAGES = new Set(["models", "provider-models", "devices", "memories", "auth-prompt", "auth-prompt-closed", "auth-event", "sign-in", "import", "notice", "netease-checked"]);
function receive({ data }) {
  if (!data?.type) return;
  if (data.type === "preview" || data.type === "preview-control") { previews.receive(data); renderInspector(); return; }
  if (SETTINGS_MESSAGES.has(data.type)) settings.receive(data);
  if (data.type === "models") {
    providers = data.providers ?? [];
    for (const provider of providers) if (provider.signedIn && !providerModels.has(provider.id)) send({ type: "provider-models", provider: provider.id });
  }
  if (data.type === "provider-models") { providerModels.set(data.provider, data.models ?? []); renderComposer(); }
  if (data.type === "devices" && devicePicker) {
    if (data.error) { devicePicker = null; notice(data.error === "limited" ? spotifyLimited(data.resumeAt) : t("noticeDevicesFailed")); }
    else void showDevices(data.devices ?? []);
  }
  if (data.type === "player-error") notice(t("noticePlaybackFailed"));
  // The sheet shows its own sign-in errors. sign_in_busy is the exception: the sheet keeps the running panel.
  if (data.type === "sign-in" && data.state === "error" && !(settings.open && data.code !== "sign_in_busy")) notice(SIGN_IN_ERRORS[data.code] ? t(SIGN_IN_ERRORS[data.code]) : t("signInFailed"));
  if (data.type === "import" && data.stage === "refresh-failed") notice(t("importRefreshFailed"));
  if (data.type === "notice") {
    // The core did not take this message. Put it back so the listener can send it again.
    const pending = state.turns.findLastIndex((turn) => turn.pending && (!data.text || turn.text === data.text));
    if ((data.code === "message_busy" || data.code === "prompt") && pending >= 0) {
      const [turn] = state.turns.splice(pending, 1);
      renderConversation();
      if (!input.value.trim()) { input.value = turn.text; renderComposer(); }
    }
    if (data.message) console.warn(`[moondog] ${data.code}: ${data.message}`);
    // A refused switch leaves the open conversation marked as open.
    if (data.code === "too_many_running") renderSessions();
    notice(t(NOTICES[data.code] ?? "noticeFailed"));
  }
  if (data.type === "ready" || data.type === "status") {
    if (data.locale && data.locale !== locale) applyLanguage(data.locale);
    const before = state.playbackService;
    for (const key of ["model", "spotify", "spotifyAccount", "playbackService", "netease", "neteaseMessage", "locales"]) if (data[key] !== undefined) state[key] = data[key];
    // A service chosen anywhere, here, in Settings or in the player, answers a first launch's question.
    if (data.type === "status" && data.playbackService && data.playbackService !== before) store.set("moondog.source", "chosen");
    if (sourceWanted === state.playbackService) sourceWanted = null;
    // With Apple Music chosen, the window learns once whether it can play whole songs.
    if (state.playbackService === "apple_music" && !previews.fullStatus()) void previews.check();
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
    renderComposer();
  }
  if (data.type === "ready" || data.type === "session") {
    // A message waiting for the core stays on screen until the core takes it.
    const waiting = data.type === "ready" ? state.turns.filter((turn) => turn.waiting) : [];
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
    // Only now is it known whether this is a first launch, the one that asks which service the listener uses.
    renderComposer();
    send({ type: "models" });
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
      // The reply to the arm's request has begun, so its end can lift the arm.
      if (cue) cue.seen = true;
      const pending = state.turns.findLastIndex((turn) => turn.pending && turn.text === data.text);
      if (pending >= 0) state.turns.splice(pending, 1);
      state.turns.push({ role: "user", text: data.text }, { role: "assistant", id: data.id, text: "", activity: [], streaming: true });
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
