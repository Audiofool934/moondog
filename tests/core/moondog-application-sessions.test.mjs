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
    assert.throws(() => application.resumeSession("unknown-session"), /Persistent memory is unavailable/);
    seedPendingState(application);
    assert.equal(application.startNewSession(), null);
    assertPendingStateCleared(application);
  } finally {
    application.close();
  }
});
