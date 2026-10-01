import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createModels, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { MoondogApplication } from '../../src/core/moondog-application.mjs';
import { createSyntheticDomainServices } from '../../src/core/synthetic-domain-services.mjs';
import { openLocalMemoryStore } from '../../src/memory/local-memory-store.mjs';
import { PiAgentRuntime } from '../../src/runtime/pi/agent-runtime.mjs';
import { createSpotifyWebApiClient } from '../../src/integrations/spotify/web-api-client.mjs';
import { createSpotifyService } from '../../src/integrations/spotify/service.mjs';

const answer = text => fauxAssistantMessage([fauxText(text)]);
const tool = (name, args = {}) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' });
const messageText = message => typeof message.content === 'string' ? message.content : message.content.map(block => block.text ?? '').join('');
async function fixture(t, { persistent = true, spotify = false, delayedWrite = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'moondog-rewind-'));
  const databasePath = path.join(root, 'memory.sqlite');
  let store; let application; let runtime;
  const writes = [];
  const writeStarted = Promise.withResolvers(); const writeGate = Promise.withResolvers();
  const client = createSpotifyWebApiClient({ tokenProvider: async () => 'fictional', fetchImpl: async (url, init) => {
    const endpoint = new URL(url).pathname;
    if (init.method !== 'GET') { writes.push(endpoint); writeStarted.resolve(); if (delayedWrite) await writeGate.promise; return new Response(null, { status: 204 }); }
    if (endpoint === '/v1/search') return Response.json({ tracks: { items: [{ id: 'fictionalone', type: 'track', uri: 'spotify:track:fictionalone', name: 'Fictional Stars', artists: [{ name: 'Mara Vale' }], album: { name: 'Fictional Record' } }] } });
    if (endpoint === '/v1/me/player') return Response.json({ is_playing: true, item: { type: 'track', uri: 'spotify:track:fictionalone', name: 'Fictional Stars', artists: [{ name: 'Mara Vale' }] } });
    throw new Error('Unexpected fixture endpoint');
  } });
  const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
  const open = async () => {
    store = persistent ? await openLocalMemoryStore({ databasePath }) : null;
    application = new MoondogApplication({ memoryStore: store, importsRoot: path.join(root, 'missing'),
      domainServices: createSyntheticDomainServices({ subjectScope: { subjectId: 'fictional-rewind' } }),
      ...(spotify ? { spotifyConnection: { ready: () => true, missingScopes: () => [], publicStatus: () => ({ provider: 'spotify', state: 'ready' }), service: createSpotifyService({ client }) } } : {}) });
    runtime = new PiAgentRuntime({ application, models, model: faux.getModel(), provider: 'faux', modelId: 'faux-1' });
  };
  await open();
  t.after(async () => { writeGate.resolve(); application.close(); await rm(root, { recursive: true, force: true }); });
  return { get application() { return application; }, get runtime() { return runtime; }, get store() { return store; },
    faux, writes, writeStarted, writeGate, databasePath,
    async reopen() { application.close(); await open(); },
    async say(user, reply) { faux.setResponses([answer(reply)]); return runtime.prompt(user); },
  };
}

for (const persistent of [true, false]) {
  test(`rewind preserves the original and supports repeated branching: persistent=${persistent}`, async t => {
    const f = await fixture(t, { persistent });
    await f.say('First fictional request', 'First reply');
    const edited = 'Second request\n带有中文和 “引号”';
    await f.say(edited, 'Second reply');
    await f.say('DISCARDED_FUTURE_SENTINEL', 'DISCARDED_ANSWER_SENTINEL');
    const originalId = f.application.ensureMemorySession().session_id;
    const entries = f.application.conversationEntries();
    const branch = await f.runtime.rewindTo(entries[1].entry_id);
    assert.equal(branch.draft, edited);
    assert.equal(branch.parent_session_id, originalId);
    assert.deepEqual(f.runtime.agent.state.messages.map(messageText), ['First fictional request', 'First reply']);
    assert.equal(f.application.conversationPending().draft, edited);
    f.faux.setResponses([context => {
      assert.doesNotMatch(JSON.stringify(context), /DISCARDED_FUTURE|DISCARDED_ANSWER|Second reply/u);
      return answer('Different branch reply');
    }]);
    await f.runtime.prompt('Replacement request');
    const secondBranch = await f.runtime.rewindTo(f.application.conversationEntries()[1].entry_id);
    assert.equal(secondBranch.draft, 'Replacement request');
    assert.equal(f.application.listSavedSessions().length, 3);
    f.application.resumeSession(originalId); f.runtime.restoreSession();
    assert.equal(f.application.conversationEntries().length, 3);
    assert.match(JSON.stringify(f.runtime.agent.state.messages), /DISCARDED_ANSWER_SENTINEL/u);
  });
}

test('rewind drafts, original history and explicit preferences survive restart without recalling discarded futures', async t => {
  const f = await fixture(t);
  await f.say('Before branch', 'Before response');
  await f.say('Discard this future', 'Future response');
  f.application.rememberMemory({ text: 'I prefer concise replies', kind: 'preference' });
  const originalId = f.application.ensureMemorySession().session_id;
  const entry = f.application.conversationEntries()[0];
  f.application.conversationPending({ draft: 'Unsent original draft', queued: ['Queued original draft'] });
  const branch = await f.runtime.rewindTo(entry.entry_id);
  await f.reopen();
  assert.equal(f.application.ensureMemorySession().session_id, branch.session_id);
  assert.deepEqual(f.application.conversationPending(), { draft: 'Before branch', queued: [] });
  assert.deepEqual(f.runtime.agent.state.messages, []);
  const context = f.application.memoryContext();
  assert.doesNotMatch(JSON.stringify(context.recent_episodes), /Discard this future/u);
  assert.doesNotMatch(JSON.stringify(context.recent_sessions), /Future response/u);
  assert.match(JSON.stringify(context.durable_memories), /I prefer concise replies/u);
  assert.ok(f.application.listSavedSessions().some(row => row.session_id === branch.session_id && row.turn_count === 0));
  f.application.resumeSession(originalId); f.runtime.restoreSession();
  assert.deepEqual(f.application.conversationPending(), { draft: 'Unsent original draft', queued: ['Queued original draft'] });
  assert.equal(f.application.conversationEntries().length, 2);
  if (process.platform !== 'win32') assert.equal((await stat(f.databasePath)).mode & 0o777, 0o600);
});

test('live Spotify conversation and receipts resume only as history, with no generic-memory promotion or reusable authority', async t => {
  const f = await fixture(t, { spotify: true });
  let trackRef;
  f.faux.setResponses([tool('moondog_spotify_search', { query: 'Fictional Stars Mara Vale' }), context => {
    const result = context.messages.find(message => message.role === 'toolResult' && message.toolName === 'moondog_spotify_search');
    trackRef = JSON.parse(result.content[0].text).items[0].track_ref_id;
    return tool('moondog_spotify_player_control', { action: 'resume', track_refs: [trackRef] });
  }, fauxAssistantMessage([], { stopReason: 'error', errorMessage: 'Fictional later model failure' })]);
  const accepted = await f.runtime.prompt('Play Fictional Stars by Mara Vale');
  assert.equal(accepted.status, 'interrupted');
  await f.say('Follow up without an action', 'Fictional follow-up');
  const originalId = f.application.ensureMemorySession().session_id;
  const entries = f.application.conversationEntries();
  assert.match(entries[0].assistant_text, /Spotify accepted/u);
  assert.equal(entries[0].transient, true);
  assert.deepEqual(f.application.currentSessionTurns(), []);
  assert.equal(f.store.status().episodes, 0);
  f.application.pendingSpotifyPlaylist = { fictional: true };
  f.application.pendingSpotifyPlaylistEdit = { fictional: true };
  const branch = await f.runtime.rewindTo(entries[1].entry_id);
  assert.equal(f.application.pendingSpotifyPlaylist, null);
  assert.equal(f.application.pendingSpotifyPlaylistEdit, null);
  assert.deepEqual(f.application.spotifyReadContext(), []);
  assert.deepEqual(f.application.spotifyQuickEditContext, { playlist: null, track: null });
  await f.reopen();
  assert.equal(f.application.ensureMemorySession().session_id, branch.session_id);
  assert.equal(f.runtime.transientSpotifyContext, true);
  assert.match(JSON.stringify(f.runtime.agent.state.messages), /Spotify accepted/u);
  assert.ok(f.runtime.agent.state.messages.every(message => ['user', 'assistant'].includes(message.role)));
  f.faux.setResponses([tool('moondog_spotify_player_control', { action: 'resume', track_refs: [trackRef] }), answer('No fresh selection.')]);
  await f.runtime.prompt('Play the old selection again');
  assert.equal(f.writes.length, 1);
  assert.deepEqual(f.application.currentSessionTurns(), []);
  assert.equal(f.store.status().episodes, 0);
  f.application.resumeSession(originalId); f.runtime.restoreSession();
  assert.equal(f.application.conversationEntries().length, 2);
  assert.equal(f.writes.length, 1);
});

test('rewind waits for an active write and times out without changing branches or replaying it', async t => {
  const f = await fixture(t, { spotify: true, delayedWrite: true });
  f.faux.setResponses([tool('moondog_spotify_player_control', { action: 'next' })]);
  const pending = f.runtime.prompt('Skip one track');
  await f.writeStarted.promise;
  const originalId = f.application.ensureMemorySession().session_id;
  const entry = f.application.conversationEntries()[0];
  await assert.rejects(f.runtime.rewindTo(entry.entry_id, { timeoutMs: 10 }), /still stopping; no rewind/u);
  assert.equal(f.application.ensureMemorySession().session_id, originalId);
  assert.equal(f.runtime.promptInFlight, true);
  assert.throws(() => f.application.rewindConversation(entry.entry_id), /Wait for the current turn/u);
  f.writeGate.resolve();
  const outcome = await pending;
  assert.equal(outcome.status, 'aborted');
  assert.equal(f.writes.length, 1);
  assert.match(f.application.conversationEntries()[0].assistant_text, /Spotify/u);
  const branch = await f.runtime.rewindTo(entry.entry_id);
  assert.equal(branch.draft, 'Skip one track');
  assert.equal(f.runtime.agent.state.messages.length, 0);
  assert.equal(f.writes.length, 1);
});

test('rewind rejects stale/cross-session entry identifiers and never restores Pi follow-up queues', async t => {
  const f = await fixture(t);
  await f.say('Original', 'Original response');
  const oldEntry = f.application.conversationEntries()[0].entry_id;
  const branch = await f.runtime.rewindTo(oldEntry);
  await f.say('New branch', 'New branch response');
  await assert.rejects(f.runtime.rewindTo(oldEntry), /no longer available/u);
  assert.equal(f.application.ensureMemorySession().session_id, branch.session_id);
  f.runtime.agent.steer({ role: 'user', content: 'STALE_STEERING', timestamp: 0 });
  f.runtime.agent.followUp({ role: 'user', content: 'STALE_FOLLOWUP', timestamp: 0 });
  await f.runtime.rewindTo(f.application.conversationEntries()[0].entry_id);
  assert.equal(f.runtime.agent.hasQueuedMessages(), false);
  assert.deepEqual(f.runtime.agent.state.messages, []);
});

test('legacy generic transcripts can be rewound without rewriting their stored history', async t => {
  const f = await fixture(t);
  // A source-version-two transcript has no corresponding journal entries.
  const legacy = f.store.rotateSession('legacy:route');
  f.store.appendCompletedTurn(legacy.session_id, { user: 'Legacy first', assistant: 'Legacy answer' });
  f.store.appendCompletedTurn(legacy.session_id, { user: 'Legacy next', assistant: 'Legacy later' });
  const before = f.store.readSessionTurns(legacy.session_id);
  const entries = f.store.readConversationEntries(legacy.session_id);
  assert.equal(entries.length, 2);
  assert.throws(() => f.store.forkConversation(legacy.session_id, entries[0].entry_id), /no longer active/u);
  const branch = f.store.forkConversation(legacy.session_id, entries[1].entry_id, { routeKey: 'legacy:route' });
  assert.equal(f.store.readConversationEntries(branch.session_id).length, 1);
  assert.deepEqual(f.store.readSessionTurns(legacy.session_id), before);
});

test('rewind of a running turn waits for settlement, retains its receipt in the original and makes no second request', async t => {
  const f = await fixture(t, { spotify: true, delayedWrite: true });
  f.faux.setResponses([tool('moondog_spotify_player_control', { action: 'next' })]);
  const pending = f.runtime.prompt('Skip one track once');
  await f.writeStarted.promise;
  const originalId = f.application.ensureMemorySession().session_id;
  const rewind = f.runtime.rewindTo(f.application.conversationEntries()[0].entry_id);
  await assert.rejects(f.runtime.prompt('Do not permit overlapping prompts'), /already in progress/u);
  assert.equal(f.application.ensureMemorySession().session_id, originalId);
  f.writeGate.resolve();
  await pending;
  const branch = await rewind;
  assert.notEqual(branch.session_id, originalId);
  assert.equal(f.writes.length, 1);
  assert.match(f.store.readConversationEntries(originalId)[0].assistant_text, /Spotify/u);
  assert.equal(f.application.conversationEntries().length, 0);
});
