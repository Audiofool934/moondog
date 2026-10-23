// For development only: the window on a simulated Spotify (src/evaluation/simulated-spotify.mjs)
// with drawn stand-in covers, so the whole app can be tried and checked without touching a
// Spotify account. The model is the one your settings choose; nothing else is read or kept.
//   cd app && npm run simulated
import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MoondogApplication } from "../src/core/moondog-application.mjs";
import { createSyntheticDomainServices } from "../src/core/synthetic-domain-services.mjs";
import { createSimulatedSpotify } from "../src/evaluation/simulated-spotify.mjs";
import { createSpotifyService } from "../src/integrations/spotify/service.mjs";
import { createSpotifyWebApiClient } from "../src/integrations/spotify/web-api-client.mjs";
import { resolveListenerLocale } from "../src/i18n/preferences.mjs";
import { createConfiguredRuntime } from "../src/runtime/pi/configured-runtime.mjs";
import { createModelSettings } from "../src/runtime/pi/model-settings.mjs";
import { createWindowPreviewPlayer } from "./preview-player.mjs";
import { runWindowRoom } from "./window-room.mjs";
import { createSimulatedNetease } from "../src/evaluation/simulated-netease.mjs";
import { openListeningHistoryStore } from "../src/profile/listening-history-store.mjs";
import { createWindowNeteasePlayer } from "./netease-player.mjs";

const port = await new Promise((resolve) => {
  process.parentPort.once("message", ({ ports: [roomPort] }) => resolve(roomPort));
});
const send = (message) => port.postMessage(message);
const quit = new AbortController();
const focus = new EventTarget();
process.parentPort.on("message", ({ data }) => {
  if (data?.type === "quit") quit.abort();
  if (data?.type === "focus") focus.dispatchEvent(new Event("focus"));
});
const state = await mkdtemp(path.join(tmpdir(), "moondog-window-simulated-"));
const environment = { ...process.env, MOONDOG_STATE_HOME: state, MOONDOG_CONFIG_HOME: path.join(state, "config"), MOONDOG_UPDATE_CHECK: "off", MOONDOG_LYRICS: "off" };
// Quitting the app stops this process; its simulated state goes with it.
const forget = () => rmSync(state, { recursive: true, force: true });
process.once("SIGTERM", () => { forget(); process.exit(0); });
process.once("exit", forget);

// Each album gets its own drawn cover: two colors and a ring, because the window itself has none.
const hues = new Map();
const cover = (album) => {
  if (!hues.has(album)) hues.set(album, [...album].reduce((sum, character) => (sum * 31 + character.codePointAt(0)) % 360, 7));
  const hue = hues.get(album);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><radialGradient id="g" cx=".38" cy=".34" r=".9">` +
    `<stop offset="0" stop-color="hsl(${(hue + 40) % 360} 62% 66%)"/><stop offset="1" stop-color="hsl(${hue} 48% 18%)"/></radialGradient></defs>` +
    `<rect width="100" height="100" fill="url(#g)"/><circle cx="62" cy="58" r="26" fill="none" stroke="hsl(${(hue + 40) % 360} 70% 88%)" stroke-opacity=".35"/>` +
    `<circle cx="62" cy="58" r="3" fill="hsl(${(hue + 40) % 360} 70% 92%)"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
};
const drawn = (item) => (item?.album ? { ...item, image: cover(item.album) } : item);

const spotify = createSimulatedSpotify({ devices: [{ id: "simMac", name: "Fictional MacBook Pro", type: "Computer" }, { id: "simPC", name: "PC", type: "Computer" }] });
const client = createSpotifyWebApiClient({ tokenProvider: async () => "SIMULATED", fetchImpl: spotify.fetchImpl });
const service = createSpotifyService({ client, thisComputerName: "Fictional MacBook Pro" });
const shown = Object.freeze({ ...service,
  currentPlayer: async (options) => { const player = await service.currentPlayer(options); return { ...player, item: drawn(player.item) }; },
  queue: async (options) => { const queue = await service.queue(options); return { ...queue, queue: queue.queue.map(drawn) }; } });
const domainServices = createSyntheticDomainServices({ subjectScope: { subjectId: "window-simulated" } });
const shared = { importsRoot: path.join(state, "imports"), musicPreviewPlayer: createWindowPreviewPlayer(port),
  spotifyConnection: { service: shown, ready: () => true, missingScopes: () => [], publicStatus: () => ({ provider: "spotify", state: "ready" }) } };
const application = new MoondogApplication({ ...shared, locale: await resolveListenerLocale(environment), domainServices });
const runtime = await createConfiguredRuntime(application, environment);

// As in the real app, each conversation the window runs beside the main one has its own
// application on the same Spotify and player, with a fork of the domain services.
const conversations = new Set();
async function openConversation({ sessionId = null, reason = "user_new" } = {}) {
  const bound = [application, ...[...conversations].map((conversation) => conversation.application)];
  if (sessionId && bound.some((candidate) => candidate.memorySession?.session_id === sessionId)) {
    throw new Error("That conversation is already open.");
  }
  const conversationApplication = new MoondogApplication({ ...shared, locale: application.locale, playbackService: application.playbackService,
    domainServices: domainServices.fork(), ownsServices: false });
  // There is no memory store here: sessions live in the main application, and every conversation shares them.
  conversationApplication.localConversations = application.localConversations;
  const conversation = { application: conversationApplication, runtime: null,
    close() { conversations.delete(conversation); conversationApplication.close(); } };
  conversations.add(conversation);
  try {
    if (sessionId) conversationApplication.resumeSession(sessionId);
    else conversationApplication.startNewSession(reason);
    conversation.runtime = await createConfiguredRuntime(conversationApplication, environment);
    return conversation;
  } catch (error) {
    conversation.close();
    throw error;
  }
}

// Models are listed from your settings, but nothing is saved: a choice lasts until the window
// closes, and signing in or out happens in the real app or the terminal.
const settings = createModelSettings({ environment });
const readOnly = () => { throw Object.assign(new Error("The simulated window doesn't change sign-ins."), { code: "auth_login_failed" }); };
const modelSettings = Object.freeze({ ...settings, signIn: readOnly, signOut: readOnly });
const rebuildRuntime = (selection, target = application) => createConfiguredRuntime(target, environment, selection ? { selection } : {});

// The music service choice also lasts only until the window closes.
const savePlaybackService = async (service) => {
  for (const target of [application, ...[...conversations].map((conversation) => conversation.application)]) target.setPlaybackService(service);
  return service;
};

const neteaseLibrary = createSimulatedNetease({ environment });
const neteasePlayer = createWindowNeteasePlayer({ library: neteaseLibrary, port });
application.neteasePlayer = neteasePlayer;
const history = await openListeningHistoryStore({ environment });
await runWindowRoom({ application, runtime, openConversation, modelSettings, rebuildRuntime, savePlaybackService,
  neteaseLibrary, loginNetease: (controls) => neteaseLibrary.login(async () => "MUSIC_U=fictional-desktop-test", controls),
  prepareNeteaseImport: async (id, controls) => {
    const prepared = await neteaseLibrary.prepareImport(id, { subjectId: history.localSubjectId({ create: true }), ...controls });
    return { preview: prepared.preview, commit: async () => history.ingestImport(prepared.bundle), close() {} };
  },
}, { port, send, quit: quit.signal, focus });
history.close();
for (const conversation of conversations) conversation.close();
application.close();
port.close();
process.exit(0);
