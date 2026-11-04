// A development stand-in for the core, on the same message protocol, so every state the window can
// draw can be drawn on demand: no model, no music service, and none of the listener's own data.
// Not packaged (pack.mjs names the files it ships). Run it with `npm run harness` from app/.

const channel = new MessageChannel();
const core = channel.port1;
// The page keeps the port from the first "moondog-room" message. Module scripts run before
// DOMContentLoaded, so announcing then lands after the page listens.
const announce = () => window.postMessage("moondog-room", "*", [channel.port2]);
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", announce, { once: true });
else announce();
// One run must not inherit another's panel widths or folded panels.
try { localStorage.clear(); } catch { /* A private window starts empty anyway. */ }
// Previews play through an Audio element; this one plays silence, 30 seconds long, so the preview player can be seen.
class FakeAudio extends EventTarget {
  constructor() { super(); this.paused = true; this.currentTime = 0; this.duration = 30; this.ended = false; this.preload = "auto"; this.src = ""; }
  play() { this.paused = false; this.currentTime = 11; queueMicrotask(() => this.dispatchEvent(new Event("playing"))); return Promise.resolve(); }
  pause() { this.paused = true; this.dispatchEvent(new Event("pause")); }
  load() {}
  removeAttribute(name) { if (name === "src") this.src = ""; }
}
window.Audio = FakeAudio;
// The real preload's bridge, minus what needs the main process: menus and dialogs answer "nothing".
window.moondogApp = { pathForFile: () => null, onCommand() {}, setLanguage() {}, setBusy() {}, setPlayback() {}, showMenu: async () => null,
  confirm: async () => false, ask: async () => ({ confirmed: false, checked: false }), chooseFile: async () => null, version: async () => "0.2.0-beta.1" };
// A newer Moondog, as the main process reports one; the states below push it.
const updateListeners = [];
const setUpdate = (update) => updateListeners.forEach((listener) => listener(update));
Object.assign(window.moondogApp, { updateState: async () => null, onUpdate: (listener) => updateListeners.push(listener), installUpdate() {} });
// The update channel as the main process keeps it, and what a check from Settings finds.
const updateChannel = { enabled: true, beta: false, finds: "current" };
Object.assign(window.moondogApp, {
  updateChannel: async () => ({ enabled: updateChannel.enabled, beta: updateChannel.beta }),
  setUpdateChannel: async (beta) => { updateChannel.beta = beta; return { enabled: true, beta }; },
  checkUpdate: async () => updateChannel.finds,
});
// The window's look as the main process keeps it. The harness sets the theme itself, so a choice here only shows.
let appearance = { theme: "system", icon: "light" };
Object.assign(window.moondogApp, { appearance: async () => appearance, setAppearance: async (choice) => (appearance = { ...appearance, ...choice }) });
// A stand-in for the Apple Music helper. It says it can play whole songs only in the state that asks
// it to, as the real one does once MusicKit is enabled for the app, and plays them silently.
const music = { whole: false, listeners: [], playing: null };
const WHOLE = ["Pink Moon", "Place to Be", "Road"];
const musicState = () => music.listeners.forEach((listener) => listener({ type: "state", token: music.playing.token, status: music.playing.status, positionMs: music.playing.positionMs,
  index: music.playing.index, song: { title: WHOLE[music.playing.index], artist: "Nick Drake", album: "Pink Moon", durationMs: 124_000 } }));
window.moondogApp.appleMusic = async (command) => {
  if (command.type === "check" || command.type === "authorize") return music.whole ? { authorization: "authorized", canPlay: true } : { authorization: "notDetermined", canPlay: false };
  if (!music.whole) return { error: "unavailable" };
  if (command.type === "play") music.playing = { index: command.start ?? 0, status: "playing", positionMs: 47_000, token: command.token };
  if (!music.playing) return {};
  if (command.type === "pause") music.playing.status = "paused";
  if (command.type === "resume") music.playing.status = "playing";
  if (command.type === "next") music.playing = { ...music.playing, index: Math.min(WHOLE.length - 1, music.playing.index + 1), positionMs: 0 };
  if (command.type === "seek") music.playing.positionMs = command.ms;
  if (command.type === "stop") music.playing.status = "stopped";
  setTimeout(musicState, 30);
  return {};
};
window.moondogApp.onAppleMusic = (listener) => music.listeners.push(listener);

// Covers are drawn, not fetched: the page allows data: images and the harness needs no network.
const cover = ([a, b, c], shape) => `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><defs>` +
  `<linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>` +
  `<rect width="600" height="600" fill="url(#g)"/>${shape(c)}</svg>`)}`;
const COVERS = [
  cover(["#0f1d33", "#3d5a80", "#e0b45c"], (c) => `<circle cx="420" cy="170" r="92" fill="${c}" opacity=".92"/><rect y="430" width="600" height="170" fill="#08111f" opacity=".55"/>`),
  cover(["#1b3a4b", "#65909a", "#f2efe6"], (c) => `<rect x="70" y="70" width="460" height="460" fill="none" stroke="${c}" stroke-width="3" opacity=".6"/><text x="80" y="520" font-family="Helvetica" font-size="44" fill="${c}">kind of blue</text>`),
  cover(["#5b2a1d", "#d1813f", "#fbe3c4"], (c) => `<circle cx="300" cy="300" r="190" fill="none" stroke="${c}" stroke-width="40" opacity=".5"/><circle cx="300" cy="300" r="60" fill="${c}"/>`),
  cover(["#20172e", "#6b4f8c", "#f6c6d6"], (c) => `<path d="M0 420 Q150 300 300 420 T600 420 V600 H0Z" fill="${c}" opacity=".7"/>`),
  cover(["#2f3a1f", "#8a9a5b", "#f4f1de"], (c) => `<rect x="160" y="120" width="280" height="360" fill="${c}" opacity=".85"/><rect x="200" y="160" width="200" height="200" fill="#2f3a1f"/>`),
  cover(["#111111", "#3a3a3a", "#d8d2c4"], (c) => `<circle cx="300" cy="300" r="210" fill="none" stroke="${c}" stroke-width="2"/><circle cx="300" cy="300" r="170" fill="none" stroke="${c}" stroke-width="2"/><circle cx="300" cy="300" r="130" fill="none" stroke="${c}" stroke-width="2"/>`),
];
const TRACKS = [
  { title: "Moondance", artists: ["Van Morrison"], album: "Moondance", durationMs: 273_000 },
  { title: "Blue in Green", artists: ["Miles Davis", "Bill Evans"], album: "Kind of Blue", durationMs: 337_000 },
  { title: "Harvest Moon", artists: ["Neil Young"], album: "Harvest Moon", durationMs: 303_000 },
  { title: "Pink Moon", artists: ["Nick Drake"], album: "Pink Moon", durationMs: 124_000 },
  { title: "Moonlight Mile", artists: ["The Rolling Stones"], album: "Sticky Fingers", durationMs: 356_000 },
  { title: "Clair de lune", artists: ["Claude Debussy", "Alexis Weissenberg"], album: "Suite bergamasque", durationMs: 301_000 },
].map((track, index) => ({ ...track, image: COVERS[index], link: `https://open.spotify.com/track/harness${index}` }));

const day = (days, hour) => new Date(new Date().setHours(hour, 0, 0, 0) - days * 86_400_000).toISOString();
const SESSIONS = [
  { id: "s1", title: "Records for a late train home", updatedAt: day(0, 9), pinned: true, folderId: null },
  { id: "s2", title: "Something quiet for a long mix", updatedAt: day(0, 8), pinned: false, folderId: null },
  { id: "s3", title: "What did I play in March?", updatedAt: day(1, 21), pinned: false, folderId: "f1" },
  { id: "s4", title: "Brass that doesn't shout", updatedAt: day(2, 14), pinned: false, folderId: "f1" },
  { id: "s5", title: "A walk home in the rain", updatedAt: day(3, 19), pinned: false, folderId: null },
  { id: "s6", title: "给我来一首，灰色轨迹", updatedAt: day(4, 11), pinned: false, folderId: null },
  { id: "s7", title: "Songs with a dog in them", updatedAt: day(12, 11), pinned: false, folderId: null },
  { id: "s8", title: "Play John Denver's original recordings", updatedAt: day(20, 11), pinned: false, folderId: null },
  { id: "s9", title: "Country roads, but not that one", updatedAt: day(31, 11), pinned: false, folderId: null },
];
const FOLDERS = [{ id: "f1", name: "Archive questions", position: 0 }];
const LOCALES = [["en", "English", "English"], ["zh", "Chinese (Simplified)", "简体中文"], ["zh-Hant", "Chinese (Traditional)", "繁體中文"],
  ["ja", "Japanese", "日本語"], ["ko", "Korean", "한국어"], ["es", "Spanish", "Español"], ["fr", "French", "Français"], ["de", "German", "Deutsch"],
  ["pt", "Portuguese (Brazil)", "Português (Brasil)"], ["it", "Italian", "Italiano"]].map(([code, name, nativeName]) => ({ code, name, nativeName }));
const LOCALE = new URLSearchParams(location.search).get("locale") || "en";
const STATUS = {
  locale: LOCALE, locales: LOCALES,
  model: { state: "configured", provider: "anthropic", model: "claude-sonnet-5-5", effort: "medium", thinking: "medium", effortLevels: ["low", "medium", "high", "xhigh", "max"], reason: null },
  spotify: "ready", spotifyAccount: { state: "ready", clientId: true }, playbackService: "spotify", memory: "ready", firstRun: null,
  generation: null,
  onAir: null,
};
// Stable Audio 3's downloads as the core's setup reports them: Medium on this Mac and in use, unless a
// state says otherwise. Sizes are the real ones, the shared text encoder counted in each model.
const MANAGED = "/Users/example/Library/Application Support/Moondog/stable-audio-3/mlx";
const MODEL_BYTES = { medium: 5_179_055_990, "small-music": 1_704_727_702 };
const models = (medium, small, partial = 0.31) => Object.fromEntries([["medium", medium], ["small-music", small]].map(([id, state]) =>
  [id, { state, bytes: state === "ready" ? MODEL_BYTES[id] : state === "partial" ? Math.round(MODEL_BYTES[id] * partial) : 0, total: MODEL_BYTES[id] }]));
const setupOf = ({ medium = "ready", small = "absent", accepted = true, job = null, partial } = {}) => ({ supported: true,
  root: "/Users/example/Library/Application Support/Moondog/stable-audio-3", licenses: { accepted, at: accepted ? "2026-10-30T09:00:00.000Z" : null },
  job, models: models(medium, small, partial), base: { uv: "ready", code: "ready", python: "ready" } });
const generationOf = ({ setup = setupOf(), enabled = true, model = "medium" } = {}) => {
  const install = setup.models[model]?.state === "ready" ? "ready" : "missing";
  return { state: !enabled ? "off" : install, enabled, install, missing: null, path: MANAGED, source: "managed", model, managed: true, setup };
};
STATUS.generation = generationOf();
// Nothing downloaded yet and the licenses not agreed to; the default folder is empty too.
const NONE = () => ({ ...generationOf({ setup: setupOf({ medium: "absent", accepted: false }) }), source: "default", managed: false,
  path: "/Users/example/Developer/stable-audio-3/optimized/mlx" });
const OFFLINE = { ...STATUS, model: { state: "offline", provider: null, model: null, effort: null, effortLevels: [], reason: null },
  spotify: "unavailable", spotifyAccount: { state: "unavailable", clientId: true } };
// The one-time first run, as the core reports it: over once a service is saved and a model answers.
const over = (run) => (run?.needed && run.service && run.model ? { ...run, needed: false } : run);

const REPLY = [
  "Three from the stretch you keep coming back to, and one that returned after a long quiet.",
  "",
  "Your last month leans on **late-night records made in one room**, with the tape hiss left in. You played *Kind of Blue* four times, always after eleven.",
  "",
  "- **Blue in Green**: the one you replay at 1:12",
  "- **Harvest Moon**: twice back to back on the 14th",
  "- **Pink Moon**: back after seven quiet months",
  "",
  "I read that as an appetite for space more than for a genre. That is my reading, not something your history says outright.",
].join("\n");
const SHORT = "Starting *Moondance* now, then Blue in Green and Harvest Moon in the queue.";
// What an imported profile reads like: the longest reply the room has to hold under the record.
const PROFILE = [
  "Here is how your listening reads after the import: **41,208 plays from 2014 to 2026**.",
  "",
  "**What lasts.** Late-night records made in one room: Van Morrison, Nick Drake, Miles Davis. They come back every autumn, and you rarely skip them.",
  "",
  "**What you are into now.** Since August, more piano and fewer voices: Bill Evans, Keith Jarrett, and two Ryuichi Sakamoto albums you played start to finish.",
  "",
  "**What your collection holds.** 3,114 artists. A long tail of Cantonese classics, mostly on Sunday mornings, and folk from the early seventies.",
  "",
  "- **Most returned to**: *Kind of Blue*, *Pink Moon*, *Astral Weeks*",
  "- **Played once and kept**: *Hejira*, *Spirit of Eden*",
  "- **Time of day**: two thirds after nine in the evening",
  "",
  "What I can't tell from history: why these records matter to you, or where you listen. That stays unknown until you tell me.",
].join("\n");
// A reply that searched the web: the source list the core appends, with plain http:// pages among https:// ones.
const SOURCES = [
  "*Pink Moon* was recorded in two late-night sessions: Nick Drake, his guitar, and one piano overdub.",
  "",
  "### Public web sources (Brave Search)",
  "",
  "- [Pink Moon at fifty: the night sessions](<https://example.org/pink-moon-at-fifty>) - source date: 2022-02-25 - retrieved: 2026-10-26",
  "- [\\[Interview\\] The engineer who recorded Pink Moon](<http://example.com/s?__biz=MzY4MTI0NjU5MA==&mid=2247483923&idx=1>) - source date: 2026-09-02 - retrieved: 2026-10-26",
  "- [Nick Drake - millions of lossless tracks, new songs and hits every day!](<http://example.net/n/singer/0003yiXu3FA4pc>) - retrieved: 2026-10-26",
].join("\n");
// Scrolls the conversation up from the latest words by `by` points (or to the top), once it is drawn.
function scrollUp(by) {
  setTimeout(() => {
    const scroll = document.querySelector("[data-scroll]");
    scroll.scrollTop = by === "top" ? 0 : scroll.scrollHeight - scroll.clientHeight - by;
  }, 150);
}
const LONG_TURNS = [
  ["Play something for a late train home", SHORT],
  ["Why that one?", "It sits where your night listening lives: warm, unhurried, a voice close to the microphone. You played Van Morrison eleven times this autumn, mostly after ten."],
  ["What did I play most in March?", REPLY],
  ["Make it quieter", "Moving to *Pink Moon*. Nick Drake keeps the warmth with almost no drums.\n\n> Saturday sun came early one morning\n\nThat line is the whole record in one breath."],
  ["Remember that I don't like live recordings", "Got it. I'll leave live recordings out from now on, unless you ask for one."],
  ["Queue three more like this", "Queued:\n\n1. **Clair de lune**: Alexis Weissenberg\n2. **Moonlight Mile**: The Rolling Stones\n3. **Harvest Moon**: Neil Young\n\nThe mix: 2 you know well, 1 new to you."],
];

// The status the stand-in core last announced, so a settings refresh answers with the same one.
let status = STATUS;
// Models: where they come from, what each offers, and the menu's list with its default.
const PROVIDERS = [
  { id: "openai", name: "OpenAI", signedIn: false, signIn: "api_key", chatgpt: true },
  { id: "anthropic", name: "Anthropic", signedIn: true, signIn: "api_key", source: "saved" },
  { id: "google", name: "Google", signedIn: false, signIn: "api_key" },
  { id: "xai", name: "xAI", signedIn: false, signIn: "api_key" },
  { id: "deepseek", name: "DeepSeek", signedIn: true, signIn: "api_key", source: "saved" },
  { id: "endpoint-home", name: "Home server", signedIn: true, signIn: "endpoint", source: "saved",
    endpoint: { format: "openai", baseUrl: "http://localhost:11434/v1", keySaved: false, models: ["qwen3:32b", "gemma-4-31b-it"] } },
];
const PROVIDER_MODELS = {
  anthropic: [["claude-opus-5-5", "Claude Opus 5.5"], ["claude-sonnet-5-5", "Claude Sonnet 5.5"], ["claude-haiku-5-5", "Claude Haiku 5.5"]],
  deepseek: [["deepseek-flash", "DeepSeek V4.1 Flash"], ["deepseek-v4-pro", "DeepSeek V4 Pro"]],
  "endpoint-home": [["qwen3:32b", "qwen3:32b"], ["gemma-4-31b-it", "Gemma 4 31B IT"]],
};
// A first-run state signs out of them all, and then signs in to them for real.
let providers = PROVIDERS;
let signingIn = null;
const providerName = (id) => PROVIDERS.find((provider) => provider.id === id)?.name ?? id;
const modelName = (provider, model) => PROVIDER_MODELS[provider]?.find(([id]) => id === model)?.[1] ?? model;
let listed = [["anthropic", "claude-sonnet-5-5"], ["anthropic", "claude-opus-5-5"], ["deepseek", "deepseek-flash"], ["endpoint-home", "qwen3:32b"]];
let defaultModel = { provider: "anthropic", model: "claude-sonnet-5-5", effort: "medium" };
const sendList = () => send({ type: "model-list",
  models: listed.map(([provider, model]) => ({ provider, model, name: modelName(provider, model), providerName: providerName(provider), ready: true, reasoning: provider !== "endpoint-home" })),
  default: { ...defaultModel, effort: defaultModel.effort ?? null, reasoning: true, thinking: defaultModel.provider === "deepseek" && defaultModel.effort === "medium" ? "low" : defaultModel.effort ?? null } });
// What Check again finds: NetEase ready, unless a state says otherwise.
let neteaseCheck = { netease: "ready" };
const send = (message) => {
  if (message.type === "ready" || message.type === "status") status = { ...status, ...Object.fromEntries(Object.keys(STATUS).map((key) => [key, message[key] ?? status[key]])) };
  core.postMessage(message);
};
// The conversation on screen, so Branch can go on from one of its replies.
let shown = [];
function ready(extra = {}) {
  shown = extra.transcript ?? [];
  send({ type: "ready", ...STATUS, sessions: SESSIONS, folders: FOLDERS, current: "s1", running: [], transcript: [], ...extra });
  sendLibrary();
}

// The listener's library, as the room sends it: Saved, folders inside folders, and playlists that hold songs
// and Moondog's tracks side by side. Edits change it as the core would, so the sidebar and the room can be tried.
const MADE_IDS = ["6f1c1b2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b", "7a2d3c4e-5f60-4a71-9b82-1c2d3e4f5a6b", "8b3e4d5f-6a71-4b82-8c93-2d3e4f5a6b7c"];
const song = (index, id) => ({ id, kind: "song", title: TRACKS[index].title, artist_credit: TRACKS[index].artists.join(", "), album: TRACKS[index].album,
  refs: { artwork_url: COVERS[index] }, added_by: "listener", added_at: "2026-11-02T21:00:00.000Z" });
const made = (index, id, title, kept = true) => ({ id, kind: "made", title, artist_credit: "Moondog", made_id: MADE_IDS[index], refs: {}, audio_kept: kept,
  added_by: "listener", added_at: "2026-11-02T21:00:00.000Z" });
const LIBRARY = {
  folders: [
    { id: "lf1", parentId: null, name: "Moods", position: 0 },
    { id: "lf2", parentId: "lf1", name: "After dark", position: 1 },
    { id: "lf3", parentId: null, name: "Work", position: 2 },
  ],
  playlists: {
    saved: { id: "saved", folderId: null, name: "Saved", origin: "listener", saved: true, position: -1,
      entries: [made(0, "e1", "Late window light"), song(3, "e2"), song(1, "e3"), song(5, "e4")] },
    lp1: { id: "lp1", folderId: "lf2", name: "Rainy Tuesday", origin: "listener", position: 0,
      entries: [song(1, "e5"), made(1, "e6", "Tide glass"), song(3, "e7"), song(0, "e8"), made(2, "e9", "Paper lanterns", false), song(4, "e10")] },
    lp2: { id: "lp2", folderId: "lf1", name: "Sunday kitchen", origin: "moondog", position: 0, entries: [song(0, "e11"), song(2, "e12"), song(4, "e13")] },
    lp3: { id: "lp3", folderId: "lf3", name: "Deep focus", origin: "listener", position: 0, entries: [song(5, "e14"), made(1, "e15", "Tide glass")] },
    lp4: { id: "lp4", folderId: null, name: "Records Moondog cut for me", origin: "moondog", position: 3, entries: [made(0, "e16", "Late window light"), made(1, "e17", "Tide glass")] },
    lp5: { id: "lp5", folderId: null, name: "Road trip, someday", origin: "listener", position: 4, entries: [] },
  },
};
let libraryOpen = null;
let entryCount = 100;
const coverOf = (playlist) => {
  for (const entry of playlist.entries) {
    if (entry.made_id) return { made_id: entry.made_id };
    if (entry.refs?.artwork_url) return { artwork_url: entry.refs.artwork_url };
  }
  return null;
};
function sendLibrary() {
  send({ type: "library", folders: LIBRARY.folders, playlists: Object.values(LIBRARY.playlists).map(({ entries, ...playlist }) => ({
    ...playlist, count: entries.length, made: entries.filter((entry) => entry.kind === "made").length, cover: coverOf({ entries }), updatedAt: "2026-11-02T21:00:00.000Z" })) });
  if (libraryOpen) send({ type: "library-playlist", id: libraryOpen, playlist: LIBRARY.playlists[libraryOpen] ?? null });
}
// Places a folder or playlist in a parent before a sibling, renumbering the parent as the store does.
function place(kind, id, parentId, beforeId) {
  const nodes = [...LIBRARY.folders.filter((folder) => folder.parentId === parentId).map((node) => ["folder", node]),
    ...Object.values(LIBRARY.playlists).filter((playlist) => !playlist.saved && playlist.folderId === parentId).map((node) => ["playlist", node])]
    .sort((a, b) => a[1].position - b[1].position).filter(([, node]) => node.id !== id);
  const node = kind === "folder" ? LIBRARY.folders.find((folder) => folder.id === id) : LIBRARY.playlists[id];
  if (kind === "folder") node.parentId = parentId; else node.folderId = parentId;
  const at = beforeId ? nodes.findIndex(([, each]) => each.id === beforeId) : -1;
  nodes.splice(at < 0 ? nodes.length : at, 0, [kind, node]);
  nodes.forEach(([, each], index) => { each.position = index; });
}
function library(data) {
  if (data.type === "library-open") libraryOpen = data.id ?? null;
  if (data.type === "library-folder-save") {
    if (!data.id) { const id = `lf${LIBRARY.folders.length + 10}`; LIBRARY.folders.push({ id, parentId: data.parentId ?? null, name: data.name, position: 0 }); place("folder", id, data.parentId ?? null, LIBRARY.folders.find((folder) => (folder.parentId ?? null) === (data.parentId ?? null))?.id); }
    else {
      const folder = LIBRARY.folders.find((each) => each.id === data.id);
      if (data.name) folder.name = data.name;
      if (data.parentId !== undefined || data.beforeId !== undefined) place("folder", data.id, data.parentId === undefined ? folder.parentId : data.parentId, data.beforeId ?? null);
    }
  }
  if (data.type === "library-folder-delete") {
    const folder = LIBRARY.folders.find((each) => each.id === data.id);
    for (const each of LIBRARY.folders) if (each.parentId === data.id) each.parentId = folder.parentId;
    for (const each of Object.values(LIBRARY.playlists)) if (each.folderId === data.id) each.folderId = folder.parentId;
    LIBRARY.folders.splice(LIBRARY.folders.indexOf(folder), 1);
  }
  if (data.type === "library-playlist-save") {
    if (!data.id) {
      const id = `lp${Object.keys(LIBRARY.playlists).length + 10}`;
      LIBRARY.playlists[id] = { id, folderId: data.folderId ?? null, name: data.name, origin: "listener", position: 0, entries: [] };
      place("playlist", id, data.folderId ?? null, null);
      send({ type: "library-made", id });
    } else {
      const playlist = LIBRARY.playlists[data.id];
      if (data.name) playlist.name = data.name;
      if (data.folderId !== undefined || data.beforeId !== undefined) place("playlist", data.id, data.folderId === undefined ? playlist.folderId : data.folderId, data.beforeId ?? null);
    }
  }
  if (data.type === "library-playlist-delete") delete LIBRARY.playlists[data.id];
  const playlist = LIBRARY.playlists[data.playlistId];
  if (data.type === "library-entries-remove" && playlist) playlist.entries = playlist.entries.filter((entry) => !data.ids.includes(entry.id));
  if (data.type === "library-entries-move" && playlist) {
    const moving = playlist.entries.filter((entry) => data.ids.includes(entry.id));
    const rest = playlist.entries.filter((entry) => !data.ids.includes(entry.id));
    const at = data.beforeId ? rest.findIndex((entry) => entry.id === data.beforeId) : -1;
    rest.splice(at < 0 ? rest.length : at, 0, ...moving);
    playlist.entries = rest;
  }
  if (data.type === "library-entries-copy" && playlist) {
    const from = LIBRARY.playlists[data.fromPlaylistId];
    playlist.entries.push(...from.entries.filter((entry) => data.ids.includes(entry.id)).map((entry) => ({ ...entry, id: `e${entryCount += 1}` })));
  }
  if (data.type === "library-save") {
    const target = LIBRARY.playlists[data.playlistId ?? "saved"];
    target.entries.unshift({ ...song(last.index, `e${entryCount += 1}`) });
    send({ type: "library-saved", playlist: { id: target.id, name: target.name, ...(target.saved ? { saved: true } : {}) }, added: 1, already: 0 });
  }
  if (data.type === "library-play") {
    send({ type: "library-played", state: "playing", player: "spotify", playlist: { id: data.playlistId }, playing: 4, left_out_made: 2 });
    player({ index: 1, fraction: 0.05, playing: true });
  }
  sendLibrary();
}
// The last song the stand-in played, so pause, skip and seek answer about that song.
let last = { fraction: 0.38, playing: true, index: 0, device: "Mac mini", queue: 5 };
function player(options = {}) {
  last = { ...last, ...options };
  const { fraction, playing, index, device, queue } = last;
  const now = TRACKS[index];
  send({ type: "player", spotify: "ready",
    now: { ...now, playing, progressMs: Math.round(now.durationMs * fraction), device, deviceType: "Computer", repeat: "off", shuffle: false, disallows: [], observedAt: Date.now() },
    next: [...TRACKS.slice(index + 1), ...TRACKS.slice(0, index)].slice(0, queue) });
}
const silent = () => send({ type: "player", spotify: "ready", now: null, next: [] });
// On Air: the stream the stand-in core runs, as the window room reports it, and the tracks it made,
// which play in the window as Moondog's own records do.
let onAir = null;
let onAirNext = false;
let airTurn = null;
const AIR_QUEUE = "air";
const MADE = [
  { title: "Late window light · 1", media_url: "moondog-media://generated/6f1c1b2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b" },
  { title: "Late window light · 2", media_url: "moondog-media://generated/7a2d3c4e-5f60-4a71-9b82-1c2d3e4f5a6b" },
].map((track) => ({ ...track, artist_credit: "", generated: true, duration_seconds: 150 }));
const stream = (phase, tracks) => ({ phase, tracks, startedAt: new Date(Date.now() - 6 * 60_000).toISOString(), endsAt: new Date(Date.now() + 41 * 60_000).toISOString() });
function setOnAir(next, ended = null) {
  onAir = next;
  status = { ...status, onAir };
  send({ type: "on-air", onAir, ended });
}
const ON_AIR = [{ role: "user", text: "Go on air: make new music for right now and keep it going", entry: "e0" }, { role: "assistant", id: "t0", entry: "e0",
  text: "On air. Warm, unhurried keys with the tape hiss left in, out of the late records you keep coming back to. I'll cut the next one while this one plays." }];
const played = (index) => [{ action: "playback.resume", state: "accepted", targets: [{ title: TRACKS[index].title, artist_credit: TRACKS[index].artists.join(", ") }] }];
const conversation = (pairs) => pairs.flatMap(([user, reply], index) => [{ role: "user", text: user, entry: `e${index}` },
  { role: "assistant", id: `t${index}`, text: reply, entry: `e${index}`, receipts: index === 0 ? played(0) : [] }]);
// Opens a settings section the way a listener can: a slash command typed into the composer.
function slash(command) {
  const input = document.querySelector("[data-input]");
  input.focus();
  input.value = `/${command}`;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
}

// Playback with music generation unfolded, as the given status has it, before the harness aims the pointer.
function unfoldGeneration(generation) {
  ready({ generation });
  player();
  slash("service");
  setTimeout(unfoldShown, 60);
}
// Its row clicked open and scrolled to the top of the sheet, under Spotify's open devices.
function unfoldShown() {
  const row = document.querySelector('[data-key="generation:stable-audio"]');
  row.click();
  document.querySelector('.sheet [data-key="generation:stable-audio"]').closest(".group").scrollIntoView({ block: "start" });
}
// A download the stand-in core runs: a few steps of progress, then the model on this Mac and in use.
let downloading = null;
function setupSent(setup) {
  status = { ...status, generation: { ...status.generation, setup } };
  core.postMessage({ type: "generation-setup", setup });
}
function download(model) {
  clearInterval(downloading);
  const total = MODEL_BYTES[model];
  let received = 0;
  const step = () => {
    const setup = status.generation.setup;
    received = Math.min(total, received + total / 12);
    if (received < total) return setupSent({ ...setup, licenses: { accepted: true, at: new Date().toISOString() },
      job: { model, step: "weights", running: true, received, total }, models: { ...setup.models, [model]: { state: "partial", bytes: received, total } } });
    clearInterval(downloading);
    downloading = null;
    const next = { ...setup, job: null, models: { ...setup.models, [model]: { state: "ready", bytes: total, total } } };
    setupSent(next);
    send({ type: "status", ...status, generation: status.generation.install === "ready" ? { ...status.generation, setup: next } : generationOf({ setup: next, model }) });
  };
  step();
  downloading = setInterval(step, 400);
}

// Each state leaves the page settled; the main process captures after the entrances finish.
// A state may return actions for the main process: { hover: selector } moves the real pointer there.
// Set by the Spotify-limited states, so the devices answer the same way the core does.
let limitedUntil = 0;
const STATES = {
  empty() { ready(); player(); },
  "empty-silent"() { ready(); silent(); },
  offline() { send({ type: "ready", ...OFFLINE, sessions: SESSIONS, folders: FOLDERS, current: "s1", running: [], transcript: [] }); send({ type: "player", spotify: "unavailable", now: null, next: [] }); },
  reply() { ready({ transcript: conversation([["What have I been playing at night?", REPLY]]) }); player({ index: 1 }); },
  long() { ready({ transcript: conversation(LONG_TURNS) }); player({ index: 0, fraction: 0.71 }); },
  // The record above the words: shrinking, shrunk to half its size, folded by hand, and over a long reply.
  history() { STATES.long(); scrollUp(120); },
  "history-top"() { STATES.long(); scrollUp("top"); },
  folded() { STATES.long(); setTimeout(() => document.querySelector("[data-record-button]").click(), 150); },
  "record-hover"() { STATES.long(); return { hover: "[data-record-frame]" }; },
  record() { STATES.long(); setTimeout(() => document.querySelector("[data-expand]").click(), 150); },
  "record-pinned"() { STATES.record(); setTimeout(() => document.querySelector("[data-pin]").click(), 300); },
  profile() { ready({ transcript: conversation([["Import my Spotify history", PROFILE]]) }); player({ index: 1 }); },
  sources() { ready({ transcript: conversation([["How was Pink Moon recorded?", SOURCES]]) }); player({ index: 1 }); },
  // The one-time first run: the music service, then the model, on a fresh install with nothing signed
  // in; the model alone when the terminal already saved a service; NetEase among the services once it is
  // ready; the model's sign-in by key and in the browser; and the close button that skips the rest.
  "first-run"(run = { needed: true, service: null, model: false }, extra = {}) {
    providers = PROVIDERS.map((provider) => ({ ...provider, signedIn: false, source: undefined }));
    // As the core does: unknown in "ready", then read.
    send({ type: "ready", ...OFFLINE, sessions: [], folders: [], current: null, running: [], transcript: [], ...extra });
    silent();
    setTimeout(() => send({ type: "status", ...status, firstRun: run }), 60);
  },
  "first-run-netease"() { STATES["first-run"](undefined, { netease: "ready" }); },
  // The library in the sidebar's place, a playlist open in the room, Saved, and a playlist with nothing in it yet.
  library() { STATES.reply(); setTimeout(() => document.querySelector("[data-toggle-library]").click(), 120); },
  playlist(id = "lp1") {
    STATES.library();
    setTimeout(() => document.querySelector(`[data-library] .row[data-id="${id}"] .open`)?.click(), 260);
  },
  "playlist-saved"() { STATES.playlist("saved"); },
  "playlist-empty"() { STATES.playlist("lp5"); },
  // The heart beside the song in the player, after a click kept it.
  "keep-song"() { STATES.reply(); setTimeout(() => document.querySelector("[data-toggle-inspector]")?.click(), 150); setTimeout(() => document.querySelector("[data-keep]")?.click(), 450); },
  "first-run-model"() { STATES["first-run"](); setTimeout(() => document.querySelector('[data-key="service:apple_music"]').click(), 400); },
  "first-run-model-only"() { STATES["first-run"]({ needed: true, service: "spotify", model: false }); },
  "first-run-key"() { STATES["first-run-model-only"](); setTimeout(() => document.querySelector('[data-key="sign-in:anthropic:api_key"]').click(), 500); },
  "first-run-browser"() {
    STATES["first-run-model-only"]();
    setTimeout(() => document.querySelector('[data-key="provider:openai"]').click(), 450);
    setTimeout(() => document.querySelector('[data-key="sign-in:openai:oauth"]').click(), 550);
  },
  "first-run-skip-tip"() { STATES["first-run"](); return { hover: ".sheet-close" }; },
  // The composer's own words for what isn't chosen yet: the model, and the service while the first run still asks for it.
  "first-launch-offline"() { send({ type: "ready", ...OFFLINE, sessions: [], folders: [], current: null, running: [], transcript: [] }); silent(); },
  "service-tip"() { STATES.reply(); return { hover: "[data-service]" }; },
  "model-tip"() { STATES.reply(); return { hover: "[data-model]" }; },
  "picks-apple"() { ready({ playbackService: "apple_music", transcript: conversation([["Something for the morning", SHORT]]) }); silent(); return { hover: "[data-service]" }; },
  "picks-netease"() { STATES.netease(); return { hover: "[data-service]" }; },
  // Settings › Playback with NetEase not installed yet, its row opened to the setup; installed but
  // signed out; and a Check again that still finds it missing.
  "settings-netease-setup"() {
    ready({ netease: "missing" });
    player();
    slash("service");
    setTimeout(() => document.querySelector('[data-key="service:netease"]').click(), 300);
  },
  "settings-netease-signed-out"() {
    ready({ netease: "signed_out" });
    player();
    slash("service");
    setTimeout(() => document.querySelector('[data-key="service:netease"]').click(), 300);
  },
  // The pointer on a service's row: the switch of one that can play, Set up on one that can't yet.
  "settings-service-switch"() { STATES["settings-playback"](); return { hover: '.sheet [data-key="service:apple_music"]' }; },
  "settings-service-set-up"() {
    ready({ netease: "missing" });
    player();
    slash("service");
    return { hover: '.sheet [data-key="service:netease"]' };
  },
  "settings-netease-still-missing"() {
    neteaseCheck = { netease: "missing" };
    STATES["settings-netease-setup"]();
    setTimeout(() => document.querySelector('[data-key="netease:check"]').click(), 600);
  },
  streaming() {
    ready({ running: ["s1", "s2"], transcript: conversation([["Play something for a late train home", SHORT]]),
      live: { id: "t9", user: "Find me something that sounds like a streetlamp at 2am", text: "Two candidates so far. The first is a record you have never played, from a session",
        activity: [{ call: 1, tool: "moondog_spotify_search", args: {}, state: "done" }, { call: 2, tool: "moondog_profile_evidence", args: {}, state: "done" },
          { call: 3, tool: "moondog_spotify_queue_add", args: {}, state: "running" }] } });
    player({ index: 0, fraction: 0.2 });
  },
  thinking() {
    ready({ transcript: [], live: { id: "t9", user: "Something for cooking dinner, not too slow", text: "", activity: [] } });
    player({ index: 2, fraction: 0.55 });
  },
  failed() {
    ready({ transcript: [{ role: "user", text: "Play something new" }] });
    send({ type: "turn", state: "start", id: "f1", text: "Play it on the kitchen speaker", session: "s1" });
    send({ type: "turn", state: "error", id: "f1", connection: true, session: "s1" });
    player({ playing: false });
  },
  // A Like or Avoid said in chat: the host's own line under the reply, and the save step while it runs.
  "taste-choice"() {
    ready({ transcript: conversation([["Never play The Paper Comets again", "Understood. Staying with the quiet side tonight: *Pink Moon*, then Bill Evans.\n\nSaved: I'll keep The Paper Comets out of what I play and suggest. Tell me any time to change it."]]),
      live: { id: "t9", user: "I love this one, keep it coming", text: "",
        activity: [{ call: 1, tool: "moondog_listening_now", args: {}, state: "done" }, { call: 2, tool: "moondog_taste_choice", args: {}, state: "running" }] } });
    player({ index: 0, fraction: 0.4 });
  },
  paused() { ready({ transcript: conversation([["Play something for a late train home", SHORT]]) }); player({ playing: false, fraction: 0.62 }); },
  palette() {
    STATES.reply();
    // Typed once the page has the core's language, as a listener would.
    setTimeout(() => { const input = document.querySelector("[data-input]"); input.focus(); input.value = "/"; input.dispatchEvent(new Event("input", { bubbles: true })); }, 50);
  },
  typing() { STATES.reply(); const input = document.querySelector("[data-input]"); input.focus(); input.value = "Something like this but with more piano, and nothing from before 1970"; input.dispatchEvent(new Event("input", { bubbles: true })); },
  "settings-general"() { STATES.reply(); slash("language"); },
  "settings-about"() { STATES.reply(); slash("help"); },
  "settings-about-beta"() { updateChannel.beta = true; STATES["settings-about"](); },
  "settings-about-current"() {
    STATES["settings-about"]();
    setTimeout(() => document.querySelector('.sheet [data-key="update-check"]')?.click(), 300);
  },
  "settings-about-available"() {
    updateChannel.beta = true;
    updateChannel.finds = "available";
    window.moondogApp.updateState = async () => ({ phase: "available", version: "0.3.0-beta.5" });
    STATES["settings-about"]();
    setTimeout(() => document.querySelector('.sheet [data-key="update-check"]')?.click(), 300);
  },
  "settings-appearance"() { STATES.reply(); slash("appearance"); },
  "settings-model"() { STATES.reply(); slash("model"); },
  // A provider open to its models, each ticked when the menu offers it.
  "settings-model-provider"() {
    STATES.reply(); slash("model");
    setTimeout(() => document.querySelector('[data-key="provider:anthropic"]')?.click(), 200);
  },
  "settings-model-openai"() {
    STATES.reply(); slash("model");
    setTimeout(() => document.querySelector('[data-key="provider:openai"]')?.click(), 200);
  },
  "settings-endpoint"() {
    STATES.reply(); slash("model");
    setTimeout(() => document.querySelector('[data-key="endpoint:edit:endpoint-home"]')?.click(), 200);
  },
  "settings-playback"() { STATES.reply(); slash("service"); },
  // Music generation beside the music services: on, with the pointer on its row; off with the install
  // found; and not found, its row opened to the folder and Check again.
  "settings-generation"() { STATES["settings-playback"](); return { hover: '.sheet [data-key="generation:stable-audio"]' }; },
  "settings-generation-off"() {
    ready({ generation: { ...STATUS.generation, state: "off", enabled: false } });
    player();
    slash("service");
    return { hover: '.sheet [data-key="generation:stable-audio"]' };
  },
  "settings-generation-setup"() {
    ready({ generation: NONE() });
    player();
    slash("service");
    setTimeout(unfoldShown, 300);
  },
  // One-click Stable Audio 3, unfolded under its row: nothing downloaded, with the pointer on Medium; the
  // licenses asked for at the first Download; Medium downloading; Medium in use, the pointer on Small
  // Music; both on this Mac; and a download that stopped for want of space.
  "generation-setup-none"() {
    unfoldGeneration(NONE());
    return { hover: '.sheet [data-key="generation:download:medium"]' };
  },
  "generation-setup-agreement"() {
    unfoldGeneration(NONE());
    setTimeout(() => document.querySelector('[data-key="generation:download:medium"]').click(), 120);
  },
  "generation-setup-downloading"() {
    const job = { model: "medium", step: "weights", running: true, received: Math.round(MODEL_BYTES.medium * 0.42), total: MODEL_BYTES.medium };
    unfoldGeneration(generationOf({ setup: setupOf({ medium: "partial", job, partial: 0.42 }) }));
    return { hover: '.sheet [data-key="generation:cancel:medium"]' };
  },
  "generation-setup-installed"() {
    unfoldGeneration(generationOf());
    return { hover: '.sheet [data-key="generation:download:small-music"]' };
  },
  "generation-setup-both"() {
    unfoldGeneration(generationOf({ setup: setupOf({ small: "ready" }) }));
    return { hover: '.sheet [data-key="generation:use:small-music"]' };
  },
  "generation-setup-error"() {
    unfoldGeneration(generationOf({ setup: setupOf({ medium: "partial", job: { model: "medium", step: "weights", running: false, received: 0, total: MODEL_BYTES.medium,
      error: { code: "setup_disk_full", message: "Not enough free space." } } }), enabled: false }));
  },
  // A track Moondog made, playing in the window under the reply that made it.
  generated() {
    ready({ playbackService: "apple_music", transcript: [{ role: "user", text: "Make me something for late tonight" }, { role: "assistant", id: "t0",
      text: "Something unhurried for the last hour of the day, out of the hushed dream pop you keep coming back to.\n\nMade on this Mac with Stable Audio 3: \"Unhurried dream pop\" (2:00, seed 1234)." }] });
    silent();
    send({ type: "preview", id: "g1", album: null, tracks: [{ title: "Unhurried dream pop", artist_credit: "", generated: true,
      media_url: "moondog-media://generated/6f1c1b2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b", duration_seconds: 120 }] });
  },
  // On Air, Moondog's own channel: offered in the bar while music making and a model are ready, and named
  // in its tooltip; lit after a click, while the reply makes the stream's first track; on air with a made
  // track, the next one queued and the one after it being cut; and in the dry gap, where the record being
  // cut shows instead of the paused Spotify song. Never "streaming", which means a reply here.
  "on-air-available"() { ready(); silent(); },
  "on-air-tip"() { STATES["on-air-available"](); return { hover: "[data-on-air]" }; },
  "on-air-starting"() {
    STATES["on-air-available"]();
    onAirNext = true;
    setTimeout(() => document.querySelector("[data-on-air]").click(), 150);
  },
  "on-air-playing"() {
    ready({ transcript: ON_AIR });
    player({ playing: false, fraction: 0.62 });
    setOnAir(stream("making", 2));
    send({ type: "preview", id: AIR_QUEUE, album: null, tracks: [MADE[0]] });
    send({ type: "preview-enqueue", id: AIR_QUEUE, track: MADE[1] });
    setTimeout(() => document.querySelector("[data-toggle-inspector]").click(), 150);
  },
  "on-air-waiting"() {
    ready({ transcript: ON_AIR });
    player({ playing: false, fraction: 0.62 });
    setOnAir(stream("waiting", 2));
    setTimeout(() => document.querySelector("[data-toggle-inspector]").click(), 150);
  },
  "settings-import"() { STATES.reply(); slash("import"); },
  "settings-memory"() { STATES.reply(); slash("memory"); },
  "settings-about"() { STATES.reply(); slash("help"); },
  "settings-offline"() { STATES.offline(); slash("service"); },
  // NetEase Cloud Music chosen and signed in, playing another artist's recording of a song.
  netease() {
    ready({ transcript: conversation([["放一首周杰伦的稻香", "网易云上周杰伦的原版这里放不了，多半是版权原因。现在放的是 Jay 翻唱的《稻香》。"]]), playbackService: "netease", netease: "ready" });
    send({ type: "player", spotify: "ready", next: TRACKS.slice(2, 4),
      now: { ...TRACKS[1], service: "netease", link: null, playing: true, progressMs: 61_000, device: null, deviceType: "computer", repeat: "off", shuffle: false, disallows: [], observedAt: Date.now() } });
  },
  "settings-netease"() { STATES.netease(); slash("service"); },
  // Apple Music chosen, before the listener allowed whole songs: only then does its row ask.
  "settings-apple"() { STATES.preview(); slash("service"); },
  // Spotify used up the app's quota: still connected, with nothing to read until the time it gave.
  "spotify-limited"() { limitedUntil = Date.now() + 4 * 3600_000; ready(); send({ type: "player", spotify: "limited", resumeAt: limitedUntil, now: null, next: [] }); },
  "settings-limited"() { STATES["spotify-limited"](); slash("service"); },
  "import-preview"() {
    STATES.reply();
    send({ type: "import", stage: "preview", preview: { title: "Spotify extended streaming history", notice: "Nothing is saved until you add it.",
      paragraphs: ["41,208 plays from March 2014 to October 2026", "3,114 artists, 9,870 songs", "Most played: Van Morrison, Nick Drake, Miles Davis"] } });
  },
  "hover-track"() { STATES.reply(); return { hover: "[data-track]" }; },
  "hover-row"() { STATES.long(); return { hover: ".loose .row" }; },
  tooltip() { STATES.reply(); return { hover: "[data-new]" }; },
  "turn-tip"() { STATES.long(); return { hover: ".turns button:nth-child(2)" }; },
  narrow() { STATES.reply(); },
  // A newer Moondog at the top right: offered, downloading after the click, ready, and named in its tooltip.
  "update-available"() { STATES.reply(); setUpdate({ phase: "available", version: "0.2.0-beta.4" }); },
  "update-downloading"() { STATES.reply(); setUpdate({ phase: "downloading", version: "0.2.0-beta.4", progress: 0.4, installing: true }); },
  "update-ready"() { STATES.reply(); setUpdate({ phase: "ready", version: "0.2.0-beta.4" }); },
  // Copy and Edit under a message, and Copy and Branch under a reply, while the pointer is on them.
  "message-tools"() { STATES.reply(); return { hover: ".you p" }; },
  "reply-tools"() { STATES.reply(); return { hover: ".reply .text" }; },
  "branch-tip"() { STATES.reply(); return { hover: ".reply .message-tools .tool:nth-child(2)" }; },
  // Edit opens the message in its own place; Branch moves to a new conversation that ends with that reply.
  editing() {
    ready({ transcript: conversation([["What have I been playing at night?", SHORT], ["Something slower for the walk home, nothing with drums", REPLY]]) });
    player({ index: 1 });
    setTimeout(() => document.querySelectorAll(".you .message-tools .tool:nth-child(2)")[1].click(), 150);
  },
  branched() {
    ready({ transcript: conversation([["What have I been playing at night?", REPLY], ["Something slower for the walk home", SHORT]]) });
    player({ index: 1 });
    setTimeout(() => document.querySelector(".reply .message-tools .tool:nth-child(2)").click(), 150);
  },
  // A message sent with a reply that outgrows the window: the message stays in view under the record.
  hold() {
    STATES.long();
    setTimeout(() => {
      const input = document.querySelector("[data-input]");
      input.value = "Something slower for the walk home";
      document.querySelector("[data-form]").requestSubmit();
    }, 300);
  },
  "update-tip"() { STATES["update-available"](); return { hover: "[data-update]" }; },
  // Whole Apple Music songs through the helper, once Apple allows them.
  whole() {
    music.whole = true;
    ready({ transcript: [{ role: "user", text: "Play Pink Moon, the whole album" }, { role: "assistant", id: "t0", text: "Starting *Pink Moon* from the top." }], playbackService: "apple_music" });
    silent();
    setTimeout(() => send({ type: "preview", id: "p2", tracks: WHOLE.map((title, index) => ({ title, artist_credit: "Nick Drake",
      preview_url: "https://audio-ssl.itunes.apple.com/harness.m4a", catalog_url: `https://music.apple.com/album/harness?i=14408412${65 + index}` })) }), 200);
  },
  preview() {
    ready({ transcript: [{ role: "user", text: "Play me a few previews of Nick Drake" }, { role: "assistant", id: "t0", text: "Here are three previews from *Pink Moon*." }], playbackService: "apple_music" });
    silent();
    const art = "https://is1-ssl.mzstatic.com/image/thumb/Music/harness/600x600bb.jpg";
    send({ type: "preview", id: "p1", album: { artwork_url: art }, tracks: ["Pink Moon", "Place to Be", "Road"].map((title) => ({ title, artist_credit: "Nick Drake",
      preview_url: "https://audio-ssl.itunes.apple.com/harness.m4a", catalog_url: "https://music.apple.com/album/harness", artwork_url: art })) });
  },
};

// Conversations change as the core would change them, so the sidebar's menus, drags and selections can be tried.
function relabel(data) {
  const ids = data.ids ?? [data.id];
  if (data.type === "label") for (const session of SESSIONS) if (ids.includes(session.id)) Object.assign(session, data.patch);
  if (data.type === "delete") SESSIONS.splice(0, SESSIONS.length, ...SESSIONS.filter((session) => !ids.includes(session.id)));
  if (data.type === "folder-save" && !data.id) {
    const folder = { id: `f${FOLDERS.length + 1}`, name: data.name, position: FOLDERS.length };
    FOLDERS.push(folder);
    for (const session of SESSIONS) if (data.moveSessions?.includes(session.id)) session.folderId = folder.id;
  }
  send({ type: "sessions", sessions: SESSIONS, folders: FOLDERS, current: "s1", running: [] });
}

core.onmessage = ({ data }) => {
  if (!data?.type) return;
  window.__harness?.sent.push(data);
  // The request On Air sends, while a state waits for it: a reply that starts the stream and is still
  // making its first track.
  if (data.type === "prompt" && onAirNext) {
    onAirNext = false;
    airTurn = "air-turn";
    send({ type: "turn", state: "start", id: airTurn, text: data.text, session: null });
    send({ type: "activity", id: airTurn, call: 1, tool: "moondog_start_stream", args: {}, state: "running", session: null });
    setTimeout(() => setOnAir(stream("starting", 0)), 250);
    return;
  }
  // Off air: the stream ends and its record stops; the reply starting it, if any, stops too.
  if (data.type === "on-air-stop" && onAir) {
    setOnAir(null, "asked");
    send({ type: "preview-control", id: AIR_QUEUE, action: "stop" });
  }
  if (data.type === "cancel" && airTurn) {
    send({ type: "turn", state: "end", id: airTurn, text: "", status: "aborted", receipts: [], session: null });
    airTurn = null;
  }
  if (data.type === "new") { shown = []; send({ type: "session", current: null, transcript: [] }); }
  if (["label", "delete", "folder-save"].includes(data.type)) relabel(data);
  if (data.type.startsWith("library-")) library(data);
  if (data.type === "models") send({ type: "models", providers });
  if (data.type === "provider-models") send({ type: "provider-models", provider: data.provider,
    models: (PROVIDER_MODELS[data.provider] ?? []).map(([id, name]) => ({ id, name })) });
  if (data.type === "model-list") sendList();
  if (data.type === "list-model") {
    listed = listed.filter(([provider, model]) => provider !== data.provider || model !== data.model);
    if (data.listed) listed.push([data.provider, data.model]);
    sendList();
  }
  // A new default answers at once, which ends the first run's model step.
  if (data.type === "default-model") {
    defaultModel = { ...defaultModel, provider: data.provider, model: data.model };
    if (!listed.some(([provider, model]) => provider === data.provider && model === data.model)) listed.push([data.provider, data.model]);
    sendList();
    send({ type: "status", ...status, model: { ...status.model, state: "configured", provider: data.provider, model: data.model }, firstRun: over(status.firstRun && { ...status.firstRun, model: true }) });
  }
  if (data.type === "default-effort") { defaultModel = { ...defaultModel, effort: data.effort === "default" ? undefined : data.effort }; sendList(); }
  if (data.type === "endpoint-save") setTimeout(() => send({ type: "endpoint", state: "error", code: "endpoint_models_unavailable" }), 300);
  // A model sign-in: a key pasted into the sheet, or ChatGPT's page opened in the browser. The provider
  // then opens to its models.
  if (data.type === "sign-in" && data.provider !== "spotify") {
    signingIn = data.provider;
    const provider = providers.find((entry) => entry.id === data.provider);
    if (data.method === "oauth") send({ type: "auth-event", provider: data.provider, kind: "auth_url", url: "https://auth.example.com/sign-in", opened: true });
    else send({ type: "auth-prompt", id: "key", provider: data.provider, kind: "secret", message: `Paste your ${provider?.name ?? "provider"} API key.`, placeholder: "sk-…" });
  }
  if (data.type === "sign-in-cancel") send({ type: "sign-in", provider: null, state: "cancelled" });
  if (data.type === "auth-answer") {
    const provider = providers.find((entry) => entry.id === signingIn);
    providers = providers.map((entry) => (entry === provider ? { ...entry, signedIn: true, source: "saved", method: "api_key" } : entry));
    send({ type: "sign-in", provider: provider.id, state: "done" });
  }
  if (data.type === "first-run-done") send({ type: "status", ...status, firstRun: { ...status.firstRun, needed: false } });
  if (data.type === "devices" && limitedUntil) send({ type: "devices", devices: [], error: "limited", resumeAt: limitedUntil });
  else if (data.type === "devices") send({ type: "devices", devices: [
    { ref: "0", name: "Mac mini", type: "Computer", active: true, restricted: false },
    { ref: "1", name: "Kitchen", type: "Speaker", active: false, restricted: false },
    { ref: "2", name: "Pixel 9", type: "Smartphone", active: false, restricted: false } ] });
  if (data.type === "memories" || data.type === "settings") send({ type: "memories", state: "ready", memories: [
    { id: "m1", text: "Prefers records with the room noise left in.", kind: "preference" },
    { id: "m2", text: "Doesn't like live recordings unless asked.", kind: "preference" },
    { id: "m3", text: "Listens to Cantonese classics on Sunday mornings.", kind: "fact" } ] });
  if (data.type === "settings") send({ type: "status", ...status });
  if (data.type === "control") {
    if (data.action === "pause" || data.action === "resume") player({ playing: data.action === "resume" });
    if (data.action === "next") player({ index: (last.index + 1) % TRACKS.length, fraction: 0, playing: true });
    if (data.action === "previous") player({ fraction: 0 });
    if (data.action === "seek") player({ fraction: data.positionMs / TRACKS[last.index].durationMs });
  }
  // Choices made in Settings stick, as the core would keep them.
  if (data.type === "language") send({ type: "status", ...status, locale: data.locale });
  if (data.type === "music-service") send({ type: "status", ...status, playbackService: data.service, firstRun: over(status.firstRun && { ...status.firstRun, service: data.service }) });
  if (data.type === "netease-check") { send({ type: "status", ...status, ...neteaseCheck }); send({ type: "netease-checked" }); }
  if (data.type === "generation") {
    const generation = { ...status.generation, enabled: data.enabled === true, ...(data.path ? { path: data.path } : {}) };
    send({ type: "status", ...status, generation: { ...generation, state: generation.enabled ? generation.install : "off" } });
    send({ type: "generation-checked" });
  }
  if (data.type === "generation-check") { send({ type: "status", ...status }); send({ type: "generation-checked" }); }
  if (data.type === "generation-install") download(data.model);
  if (data.type === "generation-cancel") {
    clearInterval(downloading);
    downloading = null;
    setupSent({ ...status.generation.setup, job: null });
  }
  if (data.type === "generation-remove") {
    const setup = status.generation.setup;
    const next = { ...setup, models: { ...setup.models, [data.model]: { state: "absent", bytes: 0, total: MODEL_BYTES[data.model] } } };
    setupSent(next);
    const other = Object.keys(next.models).find((id) => next.models[id].state === "ready");
    send({ type: "status", ...status, generation: status.generation.model === data.model ? generationOf({ setup: next, model: other ?? data.model, enabled: Boolean(other) && status.generation.enabled }) : { ...status.generation, setup: next } });
  }
  if (data.type === "generation-model") send({ type: "status", ...status, generation: generationOf({ setup: status.generation.setup, model: data.model, enabled: status.generation.enabled }) });
  if (data.type === "model") {
    send({ type: "status", ...status, model: { ...status.model, state: "configured", provider: data.provider, model: data.model }, firstRun: over(status.firstRun && { ...status.firstRun, model: true }) });
  }
  if (data.type === "effort") send({ type: "status", ...status, model: { ...status.model, effort: data.effort === "default" ? null : data.effort } });
  if (data.type === "branch") {
    const end = shown.findLastIndex((turn) => turn.role === "assistant" && turn.entry === data.entry);
    shown = shown.slice(0, end + 1);
    send({ type: "session", current: "s1-branch", transcript: shown });
    send({ type: "branched", session: "s1-branch" });
  }
  if (data.type === "prompt" || data.type === "edit") {
    // A reply arriving word by word, so streaming can be watched rather than posed.
    const id = `live-${Math.random().toString(36).slice(2)}`;
    send({ type: "turn", state: "start", id, text: data.text, session: null });
    send({ type: "activity", id, call: 1, tool: "moondog_spotify_search", args: {}, state: "running", session: null });
    const words = REPLY.split(" ");
    let sent = 0;
    const timer = setInterval(() => {
      if (sent === 9) send({ type: "activity", id, call: 1, tool: "moondog_spotify_search", args: {}, state: "done", session: null });
      send({ type: "text", id, delta: `${words.slice(sent, sent + 3).join(" ")} `, session: null });
      sent += 3;
      if (sent >= words.length) {
        clearInterval(timer);
        send({ type: "turn", state: "end", id, text: REPLY, status: "complete", receipts: played(1), session: null });
      }
    }, 60);
  }
};

window.__harness = {
  states: Object.keys(STATES),
  setState(name) {
    const state = STATES[name];
    if (!state) throw new Error(`No harness state called ${name}`);
    // A check script reads which state it runs in.
    window.__harness.state = name;
    return state() ?? null;
  },
  state: null,
  send,
  player,
  // What the window sent the stand-in core, for checks.
  sent: [],
};
