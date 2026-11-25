import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createPhonePort } from './phone-port.mjs';

function phone() {
  const socket = new EventEmitter();
  socket.readyState = 1;
  socket.sent = [];
  socket.send = (text) => socket.sent.push(JSON.parse(text));
  socket.terminate = () => { socket.readyState = 3; socket.emit('close'); };
  socket.say = (message) => socket.emit('message', Buffer.from(JSON.stringify(message)));
  return socket;
}

test('a phone that connects gets the room as it stands, newest state last', () => {
  const port = createPhonePort();
  port.postMessage({ type: 'ready', sessions: [] });
  port.postMessage({ type: 'status', model: 'a' });
  port.postMessage({ type: 'turn', state: 'start' });
  port.postMessage({ type: 'status', model: 'b' });
  const socket = phone();
  port.attach(socket);
  assert.deepEqual(socket.sent.map((m) => [m.type, m.model]), [['ready', undefined], ['status', 'b']]);
});

test('messages pass both ways, and the phone\'s log stays on the Mac', () => {
  const lines = [];
  const port = createPhonePort({ note: (text) => lines.push(text) });
  const heard = [];
  port.on('message', ({ data }) => heard.push(data.type));
  const socket = phone();
  port.attach(socket);
  socket.say({ type: 'prompt', text: 'hi' });
  socket.say({ type: 'log', text: 'queue set' });
  port.postMessage({ type: 'text', delta: 'hello' });
  assert.deepEqual(heard, ['prompt']);
  assert.ok(lines.includes('queue set'));
  assert.equal(socket.sent.at(-1).delta, 'hello');
});

test('music sent while the phone is away reaches it when it connects, once', () => {
  const port = createPhonePort();
  port.postMessage({ type: 'preview', id: 1, tracks: [{ title: 'A' }] });
  port.postMessage({ type: 'preview-enqueue', id: 1, track: { title: 'B' } });
  const socket = phone();
  port.attach(socket);
  assert.deepEqual(socket.sent.filter((m) => m.type.startsWith('preview')).map((m) => m.type), ['preview', 'preview-enqueue']);
  socket.terminate();
  const again = phone();
  port.attach(again);
  assert.equal(again.sent.filter((m) => m.type.startsWith('preview')).length, 0);
});

test('a phone that leaves tells the room it shows nothing', () => {
  const port = createPhonePort();
  const heard = [];
  port.on('message', ({ data }) => heard.push(data));
  const socket = phone();
  port.attach(socket);
  socket.terminate();
  assert.deepEqual(heard, [{ type: 'visible', visible: false }]);
});
