// The paired iPhone as the window's message port. The desktop core talks to its window over Electron's
// MessagePortMain (app/core-process.mjs); here the same room (app/window-room.mjs) and player
// (app/preview-player.mjs) talk to the phone over its WebSocket, through an object of the same shape:
// on("message"), removeListener, postMessage, start, close.
//
// The phone comes and goes. What the room last said about its state is kept and sent again when it
// connects, so it draws the room at once; music sent while it was away waits for it.

// The room's state messages; the latest of each draws the room on a phone that connects.
const KEPT = new Set([
  'ready', 'status', 'sessions', 'session', 'library', 'library-playlist', 'model-list', 'on-air', 'generation-setup',
]);
// The player's messages, held while no phone is connected; music older than this is not started late.
const MUSIC = new Set(['preview', 'preview-enqueue', 'preview-control']);
const MUSIC_KEPT_MS = 10 * 60_000;

export function createPhonePort({ note = () => {} } = {}) {
  const listeners = new Set();
  const kept = new Map();
  // Music the phone missed: { at, messages } for the queue sent last, or null.
  let missed = null;
  let socket = null;
  let closed = false;

  const deliver = (data) => {
    for (const listener of [...listeners]) listener({ data });
  };
  const write = (message) => {
    if (socket?.readyState !== 1) return false;
    socket.send(JSON.stringify(message));
    return true;
  };
  const songs = (message) => (message.tracks ?? [message.track]).filter(Boolean).map((track) => track.title).join(', ');

  return {
    on(event, listener) {
      if (event === 'message') listeners.add(listener);
      return this;
    },
    removeListener(event, listener) {
      if (event === 'message') listeners.delete(listener);
      return this;
    },
    start() {},
    postMessage(message) {
      if (closed || !message?.type) return;
      if (KEPT.has(message.type)) {
        // A newer state replaces the older one, and goes to the end of the replay.
        kept.delete(message.type);
        kept.set(message.type, message);
      }
      if (message.type === 'preview') note(`play ${songs(message)}`);
      if (write(message) || !MUSIC.has(message.type)) return;
      if (message.type === 'preview') {
        missed = { at: Date.now(), messages: [message] };
        note('the phone is away; it gets this when it connects');
      } else if (missed?.messages[0].id === message.id) missed.messages.push(message);
    },
    // A phone connected; the newest one replaces any other.
    attach(client) {
      if (socket && socket !== client) socket.terminate?.();
      socket = client;
      note('connected');
      for (const message of kept.values()) write(message);
      // Music the room sent meanwhile, if it is still recent.
      if (missed && Date.now() - missed.at < MUSIC_KEPT_MS) for (const message of missed.messages) write(message);
      missed = null;
      client.on('message', (raw) => {
        let data;
        try {
          data = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (!data || typeof data.type !== 'string') return;
        if (data.type === 'log') {
          if (typeof data.text === 'string') note(data.text.slice(0, 400));
          return;
        }
        if (data.type === 'visible') note(data.visible === false ? 'Moondog left' : 'Moondog open');
        if (data.type === 'preview-event' && data.event?.type === 'failed') note(`a song failed on the phone${data.event.message ? `: ${String(data.event.message).slice(0, 300)}` : ''}`);
        deliver(data);
      });
      client.once('close', () => {
        if (socket !== client) return;
        socket = null;
        note('disconnected');
        // A phone that is gone shows nothing; the room stops reading players for it.
        deliver({ type: 'visible', visible: false });
      });
    },
    connected: () => socket !== null,
    close() {
      closed = true;
      listeners.clear();
      socket?.terminate?.();
      socket = null;
    },
  };
}
