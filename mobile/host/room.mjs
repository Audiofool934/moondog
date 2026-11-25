import { randomUUID } from 'node:crypto';
import { setAppleMusicStorefront } from '../../src/integrations/apple-music/storefront.mjs';

// One listener and one physical player. Playback completes only after the phone replies.
export function createPhoneRoom() {
  let socket, runtime, readHistory, turn, pending, playback;
  let access = false;
  let running;
  const messages = [];
  const send = (message) => {
    if (socket?.readyState === 1) socket.send(JSON.stringify(message));
  };
  const snapshot = () => send({ type: 'room', messages, turn: turn ?? null });
  function settle(error) {
    if (!pending) return;
    clearTimeout(pending.timer);
    const request = pending;
    pending = null;
    if (error) request.reject(new Error(error));
    else request.resolve();
  }
  function observe(value) {
    if (
      !Array.isArray(value?.tracks) ||
      value.tracks.length > 100 ||
      !['playing', 'paused', 'stopped'].includes(value.status)
    )
      return;
    const tracks = value.tracks.map((t) => ({
      title: String(t?.title ?? '').slice(0, 512),
      artist_credit: String(t?.artist ?? '').slice(0, 512),
    }));
    const index = value.index;
    playback =
      value.status !== 'stopped' && Number.isInteger(index) && tracks[index]?.title
        ? {
            state: value.status,
            song: tracks[index],
            position: index + 1,
            count: tracks.length,
            next: tracks.slice(index + 1, index + 11),
          }
        : null;
  }
  function refreshHistory(connecting) {
    if (!readHistory || turn) return;
    const saved = readHistory(connecting);
    messages.splice(0, messages.length, ...saved.slice(-80));
  }
  async function prompt(text) {
    refreshHistory(false);
    turn = { user: text, assistant: '' };
    snapshot();
    try {
      const result = await runtime.prompt(text, {
        onTextDelta(delta) {
          turn.assistant += delta;
          send({ type: 'delta', text: delta });
        },
        onTextReplace(text) {
          turn.assistant = text;
          send({ type: 'reply', text });
        },
      });
      messages.push(
        { role: 'user', text },
        { role: 'assistant', text: result.text || turn.assistant || result.status },
      );
    } catch (error) {
      messages.push({ role: 'user', text }, { role: 'notice', text: error.message });
    } finally {
      if (messages.length > 80) messages.splice(0, messages.length - 80);
      turn = null;
      snapshot();
    }
  }
  async function command(value) {
    if (!socket || !access) throw new Error('Connect the iPhone and enable Apple Music there first.');
    if (pending) throw new Error('The iPhone is completing another playback command.');
    const id = randomUUID();
    await new Promise((resolve, reject) => {
      pending = {
        id,
        type: value.type,
        resolve,
        reject,
        timer: setTimeout(() => settle('Playback was not confirmed by the iPhone.'), 25000),
      };
      send({ ...value, id, expires: Date.now() + 25000 });
    });
  }
  const player = {
    nowPlaying: () => playback ?? null,
    wholeSongs: () => access,
    async play(tracks) {
      const ids = tracks.map((track) => track.catalog_id);
      if (!ids.length || ids.some((id) => !/^\d+$/.test(id ?? '')))
        throw new Error('The selection has no playable Apple Music catalog ID.');
      // The titles let Simulator, which cannot play Apple Music, act out the queue.
      const names = tracks.map((track) => ({ title: track.title, artist: track.artist_credit }));
      await command({ type: 'play', ids, tracks: names });
    },
    async control(action) {
      if (!playback) throw new Error('The iPhone has no active queue.');
      if (!['pause', 'resume', 'next', 'previous'].includes(action))
        throw new Error('Unknown playback command.');
      await command({ type: 'control', action });
    },
  };
  return {
    player,
    configure(agent, history) {
      runtime = agent;
      readHistory = history;
    },
    attach(client) {
      if (socket) {
        client.close(1008, 'A phone is already connected');
        return;
      }
      socket = client;
      refreshHistory(true);
      snapshot();
      client.on('message', (bytes) => {
        let msg;
        try {
          msg = JSON.parse(bytes.toString());
        } catch {
          client.close(1007, 'Invalid JSON');
          return;
        }
        if (!msg || typeof msg !== 'object') return;
        switch (msg.type) {
          case 'access':
            access = msg.ready === true;
            if (access) setAppleMusicStorefront(msg.storefront);
            break;
          case 'state':
            observe(msg.state);
            break;
          case 'receipt':
            if (pending && pending.id === msg.id) {
              if (msg.state) observe(msg.state);
              const confirmed =
                !msg.error &&
                (pending.type === 'play'
                  ? msg.state?.queueID === msg.id && msg.state?.status === 'playing'
                  : ['paused', 'playing', 'stopped'].includes(msg.state?.status));
              settle(
                confirmed
                  ? null
                  : String(msg.error || 'The phone did not confirm playback.').slice(0, 400),
              );
            }
            break;
          case 'prompt': {
            const text = typeof msg.text === 'string' ? msg.text.trim() : '';
            if (!text || text.length > 8000 || turn) {
              send({
                type: 'notice',
                text: 'Wait for the current reply or send a message of up to 8,000 characters.',
              });
              break;
            }
            running = prompt(text);
            break;
          }
          case 'cancel':
            if (turn) runtime.abort();
            break;
        }
      });
      client.on('error', () => client.terminate());
      client.once('close', () => {
        socket = null;
        playback = null;
        access = false;
        settle('The iPhone disconnected before confirming playback.');
      });
    },
    async close() {
      socket?.terminate();
      settle('The Mac host stopped.');
      runtime?.abort();
      await running;
    },
  };
}
