// A host for trying the iPhone app in Simulator without your profile, a model, or a key: the desktop's
// window room (app/window-room.mjs) on made-up songs, in-memory conversations and library, and a
// scripted model, on 127.0.0.1. Nothing is read from or kept in your Moondog folders.
import { rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { MoondogApplication } from '../../src/core/moondog-application.mjs';
import { openLibraryStore } from '../../src/core/library-store.mjs';
import { createPlaybackSelection } from '../../src/core/playback-preferences.mjs';
import { createAppleMusicCatalog, createAppleMusicCatalogClient } from '../../src/integrations/apple-music/catalog.mjs';
import { PiAgentRuntime } from '../../src/runtime/pi/agent-runtime.mjs';
import { createWindowPreviewPlayer } from '../../app/preview-player.mjs';
import { runWindowRoom } from '../../app/window-room.mjs';
import { createPhonePort } from './phone-port.mjs';
import { listen } from './server.mjs';

const state = await mkdtemp(join(tmpdir(), 'moondog-iphone-demo-'));
process.env.MOONDOG_STATE_HOME = state;
const forget = () => rmSync(state, { recursive: true, force: true });
process.once('exit', forget);

const songs = [
  ['Night Walk', 'Test Trio', 'First Light'],
  ['Low Tide', 'Harbor Lights', 'Salt'],
  ['Paper Moon Radio', 'The Fictional Quartet', 'On Air'],
  ['Slow Signal', 'Test Trio', 'First Light'],
].map(([trackName, artistName, collectionName], index) => ({
  wrapperType: 'track', kind: 'song', trackId: 900 + index, trackName, artistName, collectionName,
  trackViewUrl: `https://music.apple.com/us/album/demo/${800 + index}?i=${900 + index}`,
  previewUrl: `https://audio-ssl.itunes.apple.com/demo/${900 + index}.m4a`,
}));
const musicCatalog = createAppleMusicCatalog({
  client: createAppleMusicCatalogClient({
    fetchImpl: async (url) => {
      const term = new URL(url).searchParams.get('term')?.toLowerCase() ?? '';
      return Response.json({ results: songs.filter((s) => term.includes(s.trackName.toLowerCase())) });
    },
  }),
});

const port = createPhonePort({ note: (text) => console.log(`iPhone: ${text}`) });
const libraryStore = await openLibraryStore({ databasePath: ':memory:' });
const shared = {
  musicCatalog, libraryStore, musicPreviewPlayer: createWindowPreviewPlayer(port),
  playbackService: 'apple_music', playbackSelection: createPlaybackSelection({ service: 'apple_music' }),
};
const application = new MoondogApplication(shared);

// Two made-up models, so the model menu has a choice; both answer from the same script.
const MODELS = [
  { provider: 'faux', model: 'demo-quick', name: 'Demo Quick', providerName: 'Demo', ready: true, reasoning: false, vision: false },
  { provider: 'faux', model: 'demo-deep', name: 'Demo Deep', providerName: 'Demo', ready: true, reasoning: true, vision: false },
];
function scripted(target, modelId = MODELS[0].model) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const runtime = new PiAgentRuntime({ application: target, models, model: faux.getModel(), provider: 'faux', modelId });
  const prompt = runtime.prompt.bind(runtime);
  runtime.prompt = async (text, options) => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('moondog_music_preview', { tracks: songs.slice(0, 3).map((s) => ({ title: s.trackName, artist: s.artistName })) })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxText(`Starting quiet: **Night Walk** by Test Trio, then *Low Tide* and Paper Moon Radio. All made up for this demo, answered by ${modelId}.`)]),
    ]);
    return prompt(text, options);
  };
  return runtime;
}

const conversations = new Set();
async function openConversation({ sessionId = null, reason = 'user_new' } = {}) {
  const conversationApplication = new MoondogApplication({ ...shared, ownsServices: false });
  conversationApplication.localConversations = application.localConversations;
  const conversation = { application: conversationApplication, runtime: null,
    close() { conversations.delete(conversation); conversationApplication.close(); } };
  conversations.add(conversation);
  if (sessionId) conversationApplication.resumeSession(sessionId);
  else conversationApplication.startNewSession(reason);
  conversation.runtime = scripted(conversationApplication);
  return conversation;
}
let chosen = null;
const modelSettings = {
  list: async () => ({ models: MODELS, default: { ...MODELS[0], effort: null, thinking: null } }),
  models: async (provider) => ({ models: MODELS.filter((m) => m.provider === provider).map((m) => ({ id: m.model })) }),
  current: async () => ({ provider: 'faux', model: MODELS[0].model }),
  conversationModels: async () => ({}),
  setConversationModel: async () => {},
};
const rebuildRuntime = async (selection, target = application) => {
  chosen = selection ?? null;
  return scripted(target, chosen?.model ?? MODELS[0].model);
};

const token = 'demo-key-for-simulator-only-0000';
const server = await listen({ room: port, token, host: '127.0.0.1', port: 47831, generated: join(state, 'generated') });
console.log(`moondog://pair?host=127.0.0.1&key=${token}`);
const quit = new AbortController();
process.once('SIGINT', () => quit.abort());
process.once('SIGTERM', () => quit.abort());
await runWindowRoom({ application, runtime: scripted(application), openConversation, modelSettings, rebuildRuntime },
  { port, send: (message) => port.postMessage(message), quit: quit.signal });
for (const conversation of conversations) conversation.close();
application.close();
await server.close();
process.exit(0);
