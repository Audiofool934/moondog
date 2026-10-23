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
  confirm: async () => false, chooseFile: async () => null, version: async () => "0.2.0-beta.1" };
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
  model: { state: "configured", provider: "anthropic", model: "claude-sonnet-5-5", effort: null, effortLevels: ["low", "medium", "high", "xhigh"], reason: null },
  spotify: "ready", spotifyAccount: { state: "ready", clientId: true }, playbackService: "spotify", memory: "ready",
};
const OFFLINE = { ...STATUS, model: { state: "offline", provider: null, model: null, effort: null, effortLevels: [], reason: null },
  spotify: "unavailable", spotifyAccount: { state: "unavailable", clientId: true } };

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
  ["Queue three more like this", "Queued:\n\n1. **Clair de lune**: Alexis Weissenberg\n2. **Moonlight Mile**: The Rolling Stones\n3. **Harvest Moon**: Neil Young"],
];

// The status the stand-in core last announced, so a settings refresh answers with the same one.
let status = STATUS;
const send = (message) => {
  if (message.type === "ready" || message.type === "status") status = { ...status, ...Object.fromEntries(Object.keys(STATUS).map((key) => [key, message[key] ?? status[key]])) };
  core.postMessage(message);
};
function ready(extra = {}) {
  send({ type: "ready", ...STATUS, sessions: SESSIONS, folders: FOLDERS, current: "s1", running: [], transcript: [], ...extra });
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
const played = (index) => [{ action: "playback.resume", state: "accepted", targets: [{ title: TRACKS[index].title, artist_credit: TRACKS[index].artists.join(", ") }] }];
const conversation = (pairs) => pairs.flatMap(([user, reply], index) => [{ role: "user", text: user },
  { role: "assistant", id: `t${index}`, text: reply, receipts: index === 0 ? played(0) : [] }]);
// Opens a settings section the way a listener can: a slash command typed into the composer.
function slash(command) {
  const input = document.querySelector("[data-input]");
  input.focus();
  input.value = `/${command}`;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
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
  // The record above the words: halfway folded, folded into the bar, folded by hand, and over a long reply.
  history() { STATES.long(); scrollUp(120); },
  "history-top"() { STATES.long(); scrollUp("top"); },
  folded() { STATES.long(); setTimeout(() => document.querySelector("[data-record-button]").click(), 150); },
  profile() { ready({ transcript: conversation([["Import my Spotify history", PROFILE]]) }); player({ index: 1 }); },
  // Where the music plays and which model answers, beside the send button: asked on a first launch,
  // with and without a model, named in their tooltips, each service by its mark, and NetEase's setup.
  "first-launch"() { ready({ sessions: [], folders: [] }); silent(); },
  "first-launch-offline"() { send({ type: "ready", ...OFFLINE, sessions: [], folders: [], current: null, running: [], transcript: [] }); silent(); },
  "service-tip"() { STATES.reply(); return { hover: "[data-service]" }; },
  "model-tip"() { STATES.reply(); return { hover: "[data-model]" }; },
  "picks-apple"() { ready({ playbackService: "apple_music", transcript: conversation([["Something for the morning", SHORT]]) }); silent(); return { hover: "[data-service]" }; },
  "picks-netease"() { STATES.netease(); return { hover: "[data-service]" }; },
  "settings-netease-setup"() {
    ready({ netease: "missing" });
    player();
    window.moondogApp.showMenu = async () => "sign-in:netease";
    setTimeout(() => document.querySelector("[data-service]").click(), 150);
  },
  streaming() {
    ready({ running: ["s1", "s2"], transcript: conversation([["Play something for a late train home", SHORT]]),
      live: { id: "t9", user: "Find me something that sounds like a streetlamp at 2am", text: "Two candidates so far. The first is a record you have never played, from a session",
        activity: [{ call: 1, tool: "moondog_spotify_search", args: {}, state: "done" }, { call: 2, tool: "moondog_profile_evidence", args: {}, state: "done" },
          { call: 3, tool: "moondog_spotify_queue_add", args: {}, state: "running" }] } });
    player({ index: 0, fraction: 0.2 });
  },
  thinking() {
    ready({ transcript: [], live: { id: "t9", user: "Something for cooking dinner, not too slow", text: "", activity: [{ call: 1, tool: "moondog_profile_summary", args: {}, state: "running" }] } });
    player({ index: 2, fraction: 0.55 });
  },
  failed() {
    ready({ transcript: [{ role: "user", text: "Play something new" }] });
    send({ type: "turn", state: "start", id: "f1", text: "Play it on the kitchen speaker", session: "s1" });
    send({ type: "turn", state: "error", id: "f1", connection: true, session: "s1" });
    player({ playing: false });
  },
  paused() { ready({ transcript: conversation([["Play something for a late train home", SHORT]]) }); player({ playing: false, fraction: 0.62 }); },
  palette() {
    STATES.reply();
    // Typed once the page has the core's language, as a listener would.
    setTimeout(() => { const input = document.querySelector("[data-input]"); input.focus(); input.value = "/"; input.dispatchEvent(new Event("input", { bubbles: true })); }, 50);
  },
  typing() { STATES.reply(); const input = document.querySelector("[data-input]"); input.focus(); input.value = "Something like this but with more piano, and nothing from before 1970"; input.dispatchEvent(new Event("input", { bubbles: true })); },
  "settings-general"() { STATES.reply(); slash("language"); },
  "settings-model"() { STATES.reply(); slash("model"); },
  "settings-playback"() { STATES.reply(); slash("service"); },
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

core.onmessage = ({ data }) => {
  if (!data?.type) return;
  if (data.type === "models") send({ type: "models", providers: [
    { id: "anthropic", name: "Anthropic", signedIn: true, signIn: "api_key", source: "saved" },
    { id: "openai-codex", name: "ChatGPT", signedIn: false, signIn: "oauth" },
    { id: "deepseek", name: "DeepSeek", signedIn: true, signIn: "api_key", source: "saved" },
    { id: "openrouter", name: "OpenRouter", signedIn: false, signIn: "environment_only" },
  ] });
  if (data.type === "provider-models") send({ type: "provider-models", provider: data.provider, models: data.provider === "deepseek"
    ? [{ id: "deepseek-chat", name: "DeepSeek V4" }, { id: "deepseek-reasoner", name: "DeepSeek V4 Reasoner" }]
    : [{ id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" }, { id: "claude-opus-5-5", name: "Claude Opus 5.5" }, { id: "claude-haiku-5-5", name: "Claude Haiku 5.5" }] });
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
  if (data.type === "music-service") send({ type: "status", ...status, playbackService: data.service });
  if (data.type === "netease-check") send({ type: "status", ...status, netease: "ready" });
  if (data.type === "model") send({ type: "status", ...status, model: { ...status.model, state: "configured", provider: data.provider, model: data.model } });
  if (data.type === "effort") send({ type: "status", ...status, model: { ...status.model, effort: data.effort === "default" ? null : data.effort } });
  if (data.type === "prompt") {
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
    return state() ?? null;
  },
  send,
  player,
};
