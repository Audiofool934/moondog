import { timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';

const generatedTrackId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

// A track Moondog made on this Mac, as the desktop window gets it from moondog-media: (app/main.mjs):
// by its id only, never a path, with byte ranges so the phone's player can stream and seek it.
async function serveGenerated(folder, id, request, response) {
  if (!folder || !generatedTrackId.test(id)) return void response.writeHead(404).end();
  const file = join(folder, id, 'track.wav');
  let size;
  try {
    const info = await stat(file);
    if (!info.isFile()) return void response.writeHead(404).end();
    size = info.size;
  } catch {
    return void response.writeHead(404).end();
  }
  const range = /^bytes=(\d*)-(\d*)$/u.exec(request.headers.range ?? '');
  let start = 0;
  let end = size - 1;
  if (range && (range[1] || range[2])) {
    start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) return void response.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
  }
  response.writeHead(range ? 206 : 200, {
    'Content-Type': 'audio/wav',
    'Content-Length': String(end - start + 1),
    'Accept-Ranges': 'bytes',
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
  });
  if (request.method === 'HEAD') return void response.end();
  createReadStream(file, { start, end }).pipe(response);
}

// room: the phone's port (phone-port.mjs). generated: the folder of made tracks, served at
// /media/generated/<id> to the paired phone only.
export async function listen({ host, port, token, room, generated = null }) {
  const endpoint = new WebSocketServer({
    noServer: true,
    maxPayload: 128 * 1024,
    perMessageDeflate: false,
  });
  const expected = Buffer.from(`Bearer ${token}`);
  const paired = (request) => {
    const provided = Buffer.from(request.headers.authorization || '');
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  };
  const server = createServer((request, response) => {
    const media = /^\/media\/generated\/([^/?]+)$/u.exec(request.url ?? '');
    if (!media || !['GET', 'HEAD'].includes(request.method) || !paired(request)) return void response.writeHead(404).end();
    void serveGenerated(generated, media[1], request, response).catch(() => response.destroy());
  });
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/room' || !paired(request)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    endpoint.handleUpgrade(request, socket, head, (client) => {
      let responsive = true;
      const timer = setInterval(() => {
        if (!responsive) {
          client.terminate();
          return;
        }
        responsive = false;
        client.ping();
      }, 20000);
      client.on('pong', () => {
        responsive = true;
      });
      client.once('close', () => clearInterval(timer));
      room.attach(client);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', (error) =>
      reject(
        error.code === 'EADDRINUSE'
          ? new Error(`Another Moondog host is already listening on ${host}:${port}. Stop it (Ctrl-C in its terminal), then start this one again.`)
          : error,
      ),
    );
    server.listen(port, host, resolve);
  });
  return {
    address: server.address(),
    async close() {
      for (const client of endpoint.clients) client.terminate();
      room.close();
      endpoint.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
