import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPhonePort } from './phone-port.mjs';
import { listen } from './server.mjs';

test('made tracks reach the paired phone only, in byte ranges', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'moondog-media-'));
  const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
  await mkdir(join(folder, id));
  await writeFile(join(folder, id, 'track.wav'), Buffer.from('0123456789'));
  const token = 'k'.repeat(32);
  const server = await listen({ host: '127.0.0.1', port: 0, token, room: createPhonePort(), generated: folder });
  const base = `http://127.0.0.1:${server.address.port}/media/generated/`;
  const paired = { authorization: `Bearer ${token}` };
  try {
    const whole = await fetch(base + id, { headers: paired });
    assert.equal(whole.status, 200);
    assert.equal(await whole.text(), '0123456789');
    const part = await fetch(base + id, { headers: { ...paired, range: 'bytes=2-5' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), 'bytes 2-5/10');
    assert.equal(await part.text(), '2345');
    assert.equal((await fetch(base + id)).status, 404);
    assert.equal((await fetch(base + 'not-an-id', { headers: paired })).status, 404);
    assert.equal((await fetch(base + '..%2F..%2Fsecret', { headers: paired })).status, 404);
  } finally {
    await server.close();
    await rm(folder, { recursive: true, force: true });
  }
});
