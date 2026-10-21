import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { MoondogApplication } from "../../src/core/moondog-application.mjs";
import { openLocalMemoryStore } from "../../src/memory/local-memory-store.mjs";

async function withApplication(callback) {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-session-switch-"));
  let application;
  let candidateResets = 0;
  try {
    const memoryStore = await openLocalMemoryStore({ databasePath: path.join(root, "memory.sqlite") });
    application = new MoondogApplication({
      memoryStore,
      memoryRouteKey: "tui:session-test",
      domainServices: { resetCandidateSets() { candidateResets += 1; } },
    });
    return await callback({ application, memoryStore, candidateResets: () => candidateResets });
  } finally {
    application?.close();
    await rm(root, { recursive: true, force: true });
  }
}

function seedPendingState(application) {
  application.pendingSpotifyPlaylist = { plan: { intent: "Previous conversation" } };
  application.pendingSpotifyPlaylistEdit = { confirmable: true };
  application.pendingPlaylistRevisionCandidateSet = { candidate_set_id: "old-candidates" };
  application.promptDiscoverySources = [{ provider: "previous-prompt" }];
  application.pendingPlaylistPromptTransaction = {
    pendingSpotifyPlaylist: { plan: { intent: "Do not restore this draft" } },
    pendingSpotifyPlaylistEdit: { confirmable: true },
    externalized: false,
  };
  application.validatedPlaylistTrackRefs = ["previous-track"];
  application.spotifyResolutions.set("previous-track", { spotify_track_id: "old-track" });
  application.spotifyPlaylistTargets.set("previous-playlist", { playlistId: "old-playlist" });
  application.spotifyPlaylistItems.set("previous-item", { itemId: "old-item" });
  application.spotifyPlaylistSnapshots.set("previous-snapshot", { snapshotId: "old-snapshot" });
}

function assertPendingStateCleared(application) {
  assert.deepEqual(application.pendingSpotifyPlaylistStatus(), { state: "none" });
  assert.deepEqual(application.pendingSpotifyPlaylistEditStatus(), { state: "none" });
  assert.equal(application.pendingPlaylistRevisionCandidateSet, null);
  assert.deepEqual(application.promptDiscoverySources, []);
  assert.equal(application.validatedPlaylistTrackRefs, null);
  assert.equal(application.spotifyResolutions.size, 0);
  assert.equal(application.spotifyPlaylistTargets.size, 0);
  assert.equal(application.spotifyPlaylistItems.size, 0);
  assert.equal(application.spotifyPlaylistSnapshots.size, 0);
  assert.deepEqual(application.rollbackPendingPlaylistPrompt(), { rolled_back_pending_playlist_prompt: false });
}

test("application lists its route without starting a session and resumes with pending actions cleared", async () => {
  await withApplication(async ({ application, memoryStore, candidateResets }) => {
    assert.deepEqual(application.listSavedSessions(), []);
    assert.equal(memoryStore.status().sessions, 0);
    assert.equal(application.memorySession, null);

    const first = application.ensureMemorySession();
    application.recordCompletedTurn("Continue this first conversation.", "First reply.");
    const second = application.startNewSession();
    application.recordCompletedTurn("A separate conversation.", "Second reply.");
    const other = memoryStore.startSession();
    memoryStore.appendCompletedTurn(other.session_id, { user: "Another route.", assistant: "Separate." });
    const saved = application.listSavedSessions();
    assert.equal(saved.length, 2);
    assert.ok(saved.some((session) => session.session_id === first.session_id));
    assert.ok(saved.some((session) => session.session_id === second.session_id));
    assert.equal(application.listSavedSessions({ limit: 1 }).length, 1);

    seedPendingState(application);
    const resetsBeforeResume = candidateResets();
    const resumed = application.resumeSession(first.session_id);
    assert.equal(resumed.session_id, first.session_id);
    assert.equal(candidateResets(), resetsBeforeResume + 1);
    assertPendingStateCleared(application);
    assert.deepEqual(application.currentSessionTurns().map((turn) => turn.text), [
      "Continue this first conversation.", "First reply.",
    ]);
    assert.equal(memoryStore.resumeOrStartSession().session_id, other.session_id);
    resumed.session_id = "caller-cannot-change-the-active-session";
    assert.equal(application.ensureMemorySession().session_id, first.session_id);

    seedPendingState(application);
    const fresh = application.startNewSession();
    assert.notEqual(fresh.session_id, first.session_id);
    assertPendingStateCleared(application);
    assert.deepEqual(application.currentSessionTurns(), []);
    assert.equal(application.listSavedSessions().length, 2);
    assert.equal(memoryStore.readSessionTurns(second.session_id).length, 2);
  });
});

test("application keeps the current conversation and pending state when resume is rejected", async () => {
  await withApplication(async ({ application, memoryStore, candidateResets }) => {
    const active = application.ensureMemorySession();
    application.recordCompletedTurn("Keep the current conversation active.", "Okay.");
    const other = memoryStore.startSession();
    seedPendingState(application);
    const draft = application.pendingSpotifyPlaylist;
    const edit = application.pendingSpotifyPlaylistEdit;
    const transaction = application.pendingPlaylistPromptTransaction;
    for (const id of ["unknown-session", other.session_id]) {
      assert.throws(() => application.resumeSession(id), /not found for this route/);
      assert.equal(application.memorySession.session_id, active.session_id);
      assert.equal(application.pendingSpotifyPlaylist, draft);
      assert.equal(application.pendingSpotifyPlaylistEdit, edit);
      assert.equal(application.pendingPlaylistPromptTransaction, transaction);
      assert.equal(application.spotifyPlaylistTargets.size, 1);
      assert.equal(candidateResets(), 0);
    }
  });
});

test("application session controls remain useful without persistent memory", () => {
  const application = new MoondogApplication();
  try {
    assert.deepEqual(application.listSavedSessions(), []);
    assert.throws(() => application.resumeSession("unknown-session"), /Saved conversation not found/);
    seedPendingState(application);
    const first = application.startNewSession();
    assert.ok(first.session_id);
    assertPendingStateCleared(application);
    application.recordCompletedTurn("A process-local request", "A process-local answer");
    application.startNewSession();
    application.resumeSession(first.session_id);
    assert.deepEqual(application.currentConversationTurns().map(turn => turn.text), ["A process-local request", "A process-local answer"]);
    assert.deepEqual(application.currentSessionTurns(), []);
  } finally {
    application.close();
  }
});

test("application renames, pins, files and deletes saved conversations through the store", async () => {
  await withApplication(async ({ application }) => {
    const first = application.ensureMemorySession();
    application.recordCompletedTurn("A first listening request.", "First reply.");
    const second = application.startNewSession();
    application.recordCompletedTurn("A second listening request.", "Second reply.");
    const folder = application.saveConversationFolder({ name: "Mornings" });
    assert.deepEqual(application.listConversationFolders(), [folder]);
    application.labelSavedSession(first.session_id, { title: "Morning records", pinned: true, folderId: folder.folder_id });
    const [pinned] = application.listSavedSessions();
    assert.equal(pinned.session_id, first.session_id);
    assert.equal(pinned.title, "Morning records");
    assert.equal(pinned.custom_title, true);
    assert.equal(pinned.folder_id, folder.folder_id);
    assert.ok(pinned.pinned_at);
    assert.deepEqual(application.deleteConversationFolder(folder.folder_id), { deleted: true, folder_id: folder.folder_id, unfiled: 1 });

    assert.deepEqual(application.deleteSavedSession(first.session_id),
      { deleted: true, session_id: first.session_id, reparented: 0, started_new_session: false });
    assert.equal(application.ensureMemorySession().session_id, second.session_id);

    application.beginConversationEntry("A turn in progress.");
    assert.throws(() => application.deleteSavedSession(second.session_id), /Wait for the current conversation turn/);
    application.finishConversationEntry({ status: "completed", text: "Done." });

    seedPendingState(application);
    assert.equal(application.deleteSavedSession(second.session_id).started_new_session, true);
    assert.notEqual(application.ensureMemorySession().session_id, second.session_id);
    assertPendingStateCleared(application);
    assert.deepEqual(application.listSavedSessions(), []);
  });
});

test("a conversation deleted by another process moves this one to a new conversation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-session-deleted-"));
  const databasePath = path.join(root, "memory.sqlite");
  const routeKey = "local:main";
  let application;
  let other;
  try {
    application = new MoondogApplication({ memoryStore: await openLocalMemoryStore({ databasePath }) });
    other = await openLocalMemoryStore({ databasePath });
    // The other process opens its own conversation, which closes this one, then deletes it.
    const deleteElsewhere = (sessionId) => {
      other.rotateSession(routeKey, "app_start");
      other.deleteConversation(sessionId, { routeKey });
    };
    const deleted = application.ensureMemorySession().session_id;
    application.recordCompletedTurn("Deleted from the window.", "Gone.");
    deleteElsewhere(deleted);
    application.recordCompletedTurn("A request after the delete.", "Still here.");
    const next = application.ensureMemorySession().session_id;
    assert.notEqual(next, deleted);
    assert.deepEqual(application.currentConversationTurns().map((turn) => turn.text), ["A request after the delete.", "Still here."]);

    deleteElsewhere(next);
    assert.deepEqual(application.conversationEntries(), []);
    assert.notEqual(application.ensureMemorySession().session_id, next);
    assert.deepEqual(application.conversationPending({ draft: "A draft", queued: [] }), { draft: "A draft", queued: [] });

    // Remembering after a delete elsewhere keeps the memory in a new conversation.
    const third = application.ensureMemorySession().session_id;
    deleteElsewhere(third);
    assert.equal(application.rememberMemory({ text: "Quiet records in the morning.", kind: "preference" }).text, "Quiet records in the morning.");
    assert.notEqual(application.ensureMemorySession().session_id, third);
  } finally {
    other?.close();
    application?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("conversation labels, folders and deletes work without persistent memory", () => {
  const application = new MoondogApplication();
  try {
    const rootSession = application.startNewSession();
    application.recordCompletedTurn("First process-local request", "First answer");
    application.recordCompletedTurn("Second process-local request", "Second answer");
    const [, second] = application.conversationEntries();
    const branch = application.rewindConversation(second.entry_id);
    assert.equal(application.listSavedSessions().find((session) => session.session_id === branch.session_id).parent_session_id,
      rootSession.session_id);

    const folder = application.saveConversationFolder({ name: "Process-local" });
    assert.deepEqual(application.saveConversationFolder({ folderId: folder.folder_id, name: "Renamed", position: 4 }),
      { ...folder, name: "Renamed", position: 4 });
    assert.throws(() => application.labelSavedSession(rootSession.session_id, { folderId: "missing-folder" }), /folder not found/);
    const label = application.labelSavedSession(rootSession.session_id, { title: "Original", pinned: true, folderId: folder.folder_id });
    assert.equal(label.title, "Original");
    assert.ok(label.pinned_at);
    const [pinned, other] = application.listSavedSessions();
    assert.deepEqual({ ...pinned, updated_at: undefined, started_at: undefined }, {
      session_id: rootSession.session_id, started_at: undefined, updated_at: undefined, turn_count: 4, title: "Original",
      custom_title: true, pinned_at: label.pinned_at, folder_id: folder.folder_id,
    });
    assert.equal(other.session_id, branch.session_id);
    assert.equal(other.custom_title, false);
    assert.equal(other.pinned_at, null);
    assert.deepEqual(application.deleteConversationFolder(folder.folder_id), { deleted: true, folder_id: folder.folder_id, unfiled: 1 });
    assert.deepEqual(application.listConversationFolders(), []);
    assert.equal(application.listSavedSessions()[0].folder_id, null);

    assert.deepEqual(application.deleteSavedSession(rootSession.session_id),
      { deleted: true, session_id: rootSession.session_id, reparented: 1, started_new_session: false });
    const [orphan] = application.listSavedSessions();
    assert.equal(orphan.session_id, branch.session_id);
    assert.equal(orphan.parent_session_id, undefined);
    assert.equal(application.deleteSavedSession(branch.session_id).started_new_session, true);
    assert.deepEqual(application.listSavedSessions(), []);
    assert.throws(() => application.deleteSavedSession(branch.session_id), /Saved conversation not found/);
  } finally {
    application.close();
  }
});

test("a conversation that shares its services closes only its own domain-services fork", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-shared-services-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const closes = [];
  const service = (name) => ({ resetCandidateSets() {}, close() { closes.push(name); } });
  const memoryStore = await openLocalMemoryStore({ databasePath: path.join(root, "memory.sqlite") });
  const shared = { memoryStore, memoryRouteKey: "tui:shared-test", musicCatalog: service("catalog"),
    musicSimilarity: service("similarity"), musicPreviewPlayer: service("player"), webResearch: service("web") };
  const application = new MoondogApplication({ ...shared, domainServices: service("main") });
  const conversation = new MoondogApplication({ ...shared, domainServices: service("fork"), ownsServices: false });
  try {
    const session = conversation.startNewSession("user_new");
    conversation.recordCompletedTurn("A turn in the second conversation.", "Its reply.");
    seedPendingState(conversation);
    conversation.close();
    assert.deepEqual(closes, ["fork"]);
    assert.equal(conversation.memorySession, null);
    assert.deepEqual(conversation.pendingSpotifyPlaylistStatus(), { state: "none" });
    // A reply that finishes after the close can't bind to whichever conversation is active now.
    assert.throws(() => conversation.ensureMemorySession(), /This conversation is closed/);
    assert.throws(() => conversation.recordCompletedTurn("Too late.", "Nowhere to go."), /This conversation is closed/);

    // The main application still reads and writes the shared store.
    assert.ok(application.listSavedSessions().some((saved) => saved.session_id === session.session_id));
    application.resumeSession(session.session_id);
    assert.deepEqual(application.currentConversationTurns().map((turn) => turn.text), ["A turn in the second conversation.", "Its reply."]);
    application.recordCompletedTurn("Back in the main application.", "Still open.");
    assert.equal(application.currentConversationTurns().length, 4);
  } finally {
    application.close();
  }
  assert.deepEqual(closes, ["fork", "main", "catalog", "similarity", "player", "web"]);
  assert.throws(() => memoryStore.status());
});
