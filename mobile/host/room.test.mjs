import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import { MoondogApplication } from '../../src/core/moondog-application.mjs';
import {
  createAppleMusicCatalog,
  createAppleMusicCatalogClient,
} from '../../src/integrations/apple-music/catalog.mjs';
import { PiAgentRuntime } from '../../src/runtime/pi/agent-runtime.mjs';
import { createPhoneRoom } from './room.mjs';
import { listen } from './server.mjs';
import { privateHost } from './address.mjs';

const token = 'fictional-phone-key';
function phone(url) {
  return new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
}
function receive(client, matches) {
  return new Promise((resolve) => {
    function listener(bytes) {
      const message = JSON.parse(bytes);
      if (matches(message)) {
        client.off('message', listener);
        resolve(message);
      }
    }
    client.on('message', listener);
  });
}

test(
  'a phone turn goes through Pi, waits for actual playback, and reconnects without replaying',
  { timeout: 12000 },
  async (t) => {
    for (const host of ['0.0.0.0', '203.0.113.1', '100.128.0.1', '100.64.0.999'])
      assert.equal(privateHost(host), false);
    const room = createPhoneRoom();
    const track = {
      wrapperType: 'track',
      kind: 'song',
      trackId: 42,
      trackName: 'Night Walk',
      artistName: 'Test Trio',
      collectionName: 'First Light',
    };
    const catalog = createAppleMusicCatalog({
      fullSongs: true,
      client: createAppleMusicCatalogClient({
        fullSongs: true,
        fetchImpl: async () => Response.json({ results: [track] }),
      }),
    });
    const app = new MoondogApplication({
      musicCatalog: catalog,
      musicPreviewPlayer: room.player,
      playbackService: 'apple_music',
    });
    const faux = fauxProvider(),
      models = createModels();
    models.setProvider(faux.provider);
    room.configure(
      new PiAgentRuntime({
        application: app,
        models,
        model: faux.getModel(),
        provider: 'faux',
        modelId: 'faux-1',
      }),
    );
    const server = await listen({ room, token, host: '127.0.0.1', port: 0 });
    t.after(async () => {
      await server.close();
      app.close();
    });
    const url = `ws://127.0.0.1:${server.address.port}/room`;
    const stranger = new WebSocket(url);
    assert.match((await once(stranger, 'error'))[0].message, /401/);
    const client = phone(url);
    await receive(client, (m) => m.type === 'room');
    const post = (msg) => client.send(JSON.stringify(msg));
    post({ type: 'access', ready: true, storefront: 'US' });
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('moondog_music_preview', {
            tracks: [{ title: 'Night Walk', artist: 'Test Trio' }],
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      (context) => {
        const result = context.messages.find((m) => m.role === 'toolResult');
        assert.equal(JSON.parse(result.content[0].text).plays, 'whole_songs');
        return fauxAssistantMessage([fauxText('Night Walk is playing.')]);
      },
    ]);
    const command = receive(client, (m) => m.type === 'play');
    post({ type: 'prompt', text: 'Play Night Walk by Test Trio.' });
    const play = await command;
    assert.deepEqual(play.ids, ['42']);
    assert.equal(room.player.nowPlaying(), null);
    const finished = receive(
      client,
      (m) => m.type === 'room' && m.turn === null && m.messages?.length === 2,
    );
    post({
      type: 'receipt',
      id: play.id,
      state: {
        queueID: play.id,
        status: 'playing',
        index: 0,
        tracks: [{ id: '42', title: 'Night Walk', artist: 'Test Trio' }],
      },
    });
    assert.match((await finished).messages[1].text, /Night Walk is playing/);
    assert.equal((await app.listeningNow()).sources[0].song.title, 'Night Walk');
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('moondog_player_control', { action: 'pause' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage([fauxText('Paused.')]),
    ]);
    const paused = receive(
      client,
      (m) => m.type === 'room' && m.turn === null && m.messages?.length === 4,
    );
    const control = receive(client, (m) => m.type === 'control');
    post({ type: 'prompt', text: 'Pause the music.' });
    const action = await control;
    assert.equal(action.action, 'pause');
    post({
      type: 'receipt',
      id: action.id,
      state: {
        queueID: play.id,
        status: 'paused',
        index: 0,
        tracks: [{ title: 'Night Walk', artist: 'Test Trio' }],
      },
    });
    await paused;
    assert.equal(room.player.nowPlaying().state, 'paused');
    const rejected = room.player.play([{ catalog_id: '43' }]);
    const next = await receive(client, (m) => m.type === 'play');
    post({ type: 'receipt', id: next.id, error: 'Unavailable in this region.' });
    await assert.rejects(rejected, /Unavailable/);
    client.close();
    await once(client, 'close');
    const reconnected = phone(url);
    assert.equal((await receive(reconnected, (m) => m.type === 'room')).messages.length, 4);
    assert.equal(room.player.nowPlaying(), null);
    // Away from the app, a song waits for the listener and starts when they are back.
    const again = (msg) => reconnected.send(JSON.stringify(msg));
    again({ type: 'access', ready: true, storefront: 'US' });
    again({ type: 'presence', active: false });
    await new Promise((done) => setTimeout(done, 20));
    await room.player.play([{ catalog_id: '44', title: 'Low Tide', artist_credit: 'Test Trio' }]);
    const held = receive(reconnected, (m) => m.type === 'play');
    again({ type: 'presence', active: true });
    assert.deepEqual((await held).ids, ['44']);
    reconnected.close();
    await once(reconnected, 'close');
  },
);
