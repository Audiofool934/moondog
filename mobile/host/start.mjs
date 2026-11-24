import { networkInterfaces } from 'node:os';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { privateHost } from '../address.mjs';
import { createPhoneRoom } from './room.mjs';
import { listen } from './server.mjs';
import { MoondogApplication } from '../../src/core/moondog-application.mjs';
import { loadDomainServices } from '../../src/core/open-domain-services.mjs';
import { openLocalMemoryStore } from '../../src/memory/local-memory-store.mjs';
import { openLibraryStore } from '../../src/core/library-store.mjs';
import { createConfiguredRuntime } from '../../src/runtime/pi/configured-runtime.mjs';
import { resolveMoondogAuthFile } from '../../src/runtime/pi/persistent-credential-store.mjs';
import { createAppleMusicCatalog } from '../../src/integrations/apple-music/catalog.mjs';
import {
  createOpenMusicSimilarity,
  createWikidataArtistResolver,
} from '../../src/integrations/open-music-similarity/artist-radio.mjs';
import { createWebResearch } from '../../src/integrations/web/web-research.mjs';
import { resolveListenerLocale } from '../../src/i18n/preferences.mjs';

const folder = dirname(resolveMoondogAuthFile());
await mkdir(folder, { recursive: true, mode: 0o700 });
const keyFile = join(folder, 'iphone-pairing-key');
try {
  await writeFile(keyFile, randomBytes(24).toString('base64url'), { flag: 'wx', mode: 0o600 });
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
}
const token = (await readFile(keyFile, 'utf8')).trim();
if (!/^[A-Za-z0-9_-]{32}$/.test(token)) throw new Error('Invalid iPhone pairing key file.');
if (process.argv.includes('--show-key')) {
  console.log(token);
  process.exit(0);
}
function tailscaleAddress() {
  // The GUI install on macOS need not add its CLI to PATH.
  for (const cli of ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']) {
    try {
      return execFileSync(cli, ['ip', '-4'], {
        encoding: 'utf8',
        timeout: 4000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch (error) {
      if (error.code !== 'ENOENT') break;
    }
  }
  return null;
}
const host = process.env.MOONDOG_PHONE_HOST || tailscaleAddress();
const assigned = Object.values(networkInterfaces())
  .flat()
  .some((address) => address?.address === host);
if (!privateHost(host) || !assigned) {
  throw new Error(
    'Connect Tailscale on this Mac, or set MOONDOG_PHONE_HOST to its Tailscale IPv4 address. Use 127.0.0.1 for Simulator.',
  );
}
const room = createPhoneRoom();
const artistIdentityResolver = createWikidataArtistResolver();
const application = new MoondogApplication({
  ...(await loadDomainServices()),
  memoryStore: await openLocalMemoryStore(),
  libraryStore: await openLibraryStore(),
  locale: await resolveListenerLocale(),
  musicCatalog: createAppleMusicCatalog({ fullSongs: true }),
  musicSimilarity: createOpenMusicSimilarity({ identityResolver: artistIdentityResolver }),
  artistIdentityResolver,
  webResearch: await createWebResearch(),
  musicPreviewPlayer: room.player,
  playbackService: 'apple_music',
  agentHostNotes: [
    'The listener uses the native iPhone room. Apple Music plays on the phone. Use moondog_listening_now for its reported queue.',
  ],
});
try {
  const runtime = await createConfiguredRuntime(application, process.env);
  room.configure(runtime, (connecting) => {
    if (connecting && application.followActiveConversation()) runtime.restoreSession();
    return application.currentConversationTurns({ limit: 40 }).map(({ role, text }) => ({ role, text }));
  });
  const server = await listen({ host, port: 47831, token, room });
  console.log(
    `Moondog for iPhone is listening on ${host}:47831. Run npm run --silent host -- --show-key to view the pairing key.`,
  );
  await new Promise((done) => {
    process.once('SIGTERM', done);
    process.once('SIGINT', done);
  });
  await server.close();
} finally {
  application.close();
}
