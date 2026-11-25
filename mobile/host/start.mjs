// The Mac side of Moondog for iPhone. It runs Moondog's core, the `moondog` command, as the desktop
// app does (app/core-process.mjs), with the paired phone as its window: the same conversations,
// models, library and On Air, through the window's own room (app/window-room.mjs) and player
// (app/preview-player.mjs), over a private WebSocket on this Mac's Tailscale address.
import { networkInterfaces } from 'node:os';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { privateHost } from './address.mjs';
import { qrLines } from './qr.mjs';
import { createPhonePort } from './phone-port.mjs';
import { listen } from './server.mjs';
import { createWindowPreviewPlayer } from '../../app/preview-player.mjs';
import { runWindowRoom } from '../../app/window-room.mjs';
import { resolveMoondogAuthFile } from '../../src/runtime/pi/persistent-credential-store.mjs';
import { resolveMoondogStateDirectory } from '../../src/core/state-directory.mjs';

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
const link = `moondog://pair?host=${host}&key=${token}`;
if (process.argv.includes('--qr')) {
  // The iPhone's Camera, or the app's own scanner, opens this link in Moondog and pairs.
  console.log(['', ...qrLines(link), ''].join('\n'));
  console.log('Scan this code with your iPhone to pair it with Moondog.');
}
if (process.argv.includes('--copy')) {
  // The phone's Paste button reads this link through Universal Clipboard.
  execFileSync('pbcopy', { input: link });
  console.log('Copied the pairing link. Paste it in Moondog on your iPhone.');
}
const time = () => new Date().toLocaleTimeString();
const port = createPhonePort({ note: (text) => console.log(`${time()} iPhone: ${text}`) });
const server = await listen({ host, port: 47831, token, room: port, generated: join(resolveMoondogStateDirectory(), 'generated') });
console.log(
  `Moondog for iPhone is listening on ${host}:47831. Run npm run --silent host -- --show-key to view the pairing key.`,
);
// Ctrl-C lets running replies stop and be saved before the core closes, as quitting the desktop app does.
const quit = new AbortController();
process.once('SIGINT', () => quit.abort());
process.once('SIGTERM', () => quit.abort());

globalThis[Symbol.for('moondog.host')] = {
  runRoom: (services) => runWindowRoom(services, { port, send: (message) => port.postMessage(message), quit: quit.signal }),
  musicPreviewPlayer: createWindowPreviewPlayer(port),
  // Songs play on the phone through Apple Music, whatever this Mac plays on.
  playbackService: 'apple_music',
  agentNotes: [
    'The listener is on the Moondog iPhone app. Apple Music plays whole songs on the phone, not on this Mac, and the tracks you make play there too.',
  ],
  closed: async () => {
    await server.close();
    process.exit(process.exitCode ?? 0);
  },
};

// The core is the `moondog` command with no arguments.
process.argv.splice(2);
await import('../../scripts/moondog.mjs');
