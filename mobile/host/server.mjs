import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

export async function listen({ host, port, token, room }) {
  const endpoint = new WebSocketServer({
    noServer: true,
    maxPayload: 128 * 1024,
    perMessageDeflate: false,
  });
  const server = createServer((_request, response) => {
    response.writeHead(404).end();
  });
  const expected = Buffer.from(`Bearer ${token}`);
  server.on('upgrade', (request, socket, head) => {
    const provided = Buffer.from(request.headers.authorization || '');
    if (
      request.url !== '/room' ||
      provided.length !== expected.length ||
      !timingSafeEqual(provided, expected)
    ) {
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
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return {
    address: server.address(),
    async close() {
      for (const client of endpoint.clients) client.terminate();
      await room.close();
      endpoint.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
