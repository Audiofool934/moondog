// A host for trying the iPhone app in Simulator without your profile, a model, or a key:
// fictional songs and a scripted host on 127.0.0.1. Not for use with a phone.
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { MoondogApplication } from '../../src/core/moondog-application.mjs';
import { createAppleMusicCatalog, createAppleMusicCatalogClient } from '../../src/integrations/apple-music/catalog.mjs';
import { PiAgentRuntime } from '../../src/runtime/pi/agent-runtime.mjs';
import { createPhoneRoom } from './room.mjs';
import { listen } from './server.mjs';

const songs = [
  ['Night Walk', 'Test Trio', 'First Light'],
  ['Low Tide', 'Harbor Lights', 'Salt'],
  ['Paper Moon Radio', 'The Fictional Quartet', 'On Air'],
  ['Slow Signal', 'Test Trio', 'First Light'],
].map(([trackName, artistName, collectionName], index) => ({
  wrapperType: 'track', kind: 'song', trackId: 900 + index, trackName, artistName, collectionName,
}));
const room = createPhoneRoom();
const catalog = createAppleMusicCatalog({
  fullSongs: true,
  client: createAppleMusicCatalogClient({
    fullSongs: true,
    fetchImpl: async (url) => {
      const term = new URL(url).searchParams.get('term')?.toLowerCase() ?? '';
      return Response.json({ results: songs.filter((s) => term.includes(s.trackName.toLowerCase())) });
    },
  }),
});
const app = new MoondogApplication({ musicCatalog: catalog, musicPreviewPlayer: room.player, playbackService: 'apple_music' });
const faux = fauxProvider(), models = createModels();
models.setProvider(faux.provider);
const runtime = new PiAgentRuntime({ application: app, models, model: faux.getModel(), provider: 'faux', modelId: 'faux-1' });
const prompt = runtime.prompt.bind(runtime);
runtime.prompt = async (text, options) => {
  await new Promise((r) => setTimeout(r, 1800));
  faux.setResponses(/pause|stop/i.test(text)
    ? [fauxAssistantMessage([fauxToolCall('moondog_player_control', { action: 'pause' })], { stopReason: 'toolUse' }),
       fauxAssistantMessage([fauxText('Paused. The record waits where you left it.')])]
    : [fauxAssistantMessage([fauxToolCall('moondog_music_preview', { tracks: songs.slice(0, 3).map((s) => ({ title: s.trackName, artist: s.artistName })) })], { stopReason: 'toolUse' }),
       fauxAssistantMessage([fauxText('Starting quiet: **Night Walk** by Test Trio, a late walk with brushed drums. Then *Low Tide* lets the room breathe, and Paper Moon Radio brings it back up. All three are made up for this demo.')])]);
  return prompt(text, options);
};
room.configure(runtime);
const token = 'demo-key-for-simulator-only-0000';
await listen({ room, token, host: '127.0.0.1', port: 47831 });
console.log(`moondog://pair?host=127.0.0.1&key=${token}`);
