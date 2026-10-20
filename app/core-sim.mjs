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
import { createWindowPreviewPlayer } from "./preview-player.mjs";
import { runWindowRoom } from "./window-room.mjs";

const port = await new Promise((resolve) => {
  process.parentPort.once("message", ({ ports: [roomPort] }) => resolve(roomPort));
});
const send = (message) => port.postMessage(message);
const state = await mkdtemp(path.join(tmpdir(), "moondog-window-simulated-"));
const environment = { ...process.env, MOONDOG_STATE_HOME: state, MOONDOG_UPDATE_CHECK: "off", MOONDOG_LYRICS: "off" };
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
const application = new MoondogApplication({ importsRoot: path.join(state, "imports"), locale: await resolveListenerLocale(environment),
  domainServices: createSyntheticDomainServices({ subjectScope: { subjectId: "window-simulated" } }),
  musicPreviewPlayer: createWindowPreviewPlayer(port),
  spotifyConnection: { service: shown, ready: () => true, missingScopes: () => [], publicStatus: () => ({ provider: "spotify", state: "ready" }) } });
const runtime = await createConfiguredRuntime(application, environment);
await runWindowRoom({ application, runtime }, { port, send });
application.close();
port.close();
process.exit(0);
