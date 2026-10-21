import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { MOONDOG_MEMORY_SCHEMA_VERSION, openLocalMemoryStore } from "../../src/memory/local-memory-store.mjs";

async function withMemoryStore(callback, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-memory-"));
  const databasePath = path.join(root, "private", "memory.sqlite");
  let store;
  try {
    store = await openLocalMemoryStore({ databasePath, clock: options.clock });
    return await callback({ store, databasePath, reopen: async () => {
      store.close();
      store = await openLocalMemoryStore({
        databasePath,
        clock: options.clock,
      });
      return store;
    } });
  } finally {
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("explicit mutations without a transcript commit together and roll back together", async () => {
  await withMemoryStore(async ({ store }) => {
    const session = store.startSession();
    const old = store.remember({ text: "I prefer short answers", kind: "preference", sourceSessionId: session.session_id });
    const remember = store.prepareRemember({ text: "I prefer examples", kind: "preference", sourceSessionId: session.session_id });
    const forget = store.prepareForget(old.memory_id, { sourceSessionId: session.session_id });
    assert.throws(() => store.commitMemoryMutations([forget.mutation, remember.mutation, { type: "invalid" }]));
    assert.deepEqual(store.listMemories().map((memory) => memory.memory_id), [old.memory_id]);
    const result = store.commitMemoryMutations([forget.mutation, remember.mutation]);
    assert.equal(result[1].memory_id, remember.result.memory_id);
    assert.deepEqual(store.listMemories().map((memory) => memory.text), ["I prefer examples"]);
    assert.deepEqual(store.readSessionTurns(session.session_id), []);
  });
});

test("local memory persists completed sessions and explicit durable memories", async () => {
  await withMemoryStore(async ({ store, reopen }) => {
    const first = store.startSession();
    store.appendCompletedTurn(first.session_id, {
      user: "Remember that I prefer concise explanations.",
      assistant: "I will remember that preference.",
    });
    const saved = store.remember({
      text: "Prefers concise explanations",
      kind: "preference",
      sourceSessionId: first.session_id,
    });
    store = await reopen();
    const resumed = store.resumeOrStartSession();
    assert.equal(resumed.session_id, first.session_id);
    assert.deepEqual(
      store.readSessionTurns(resumed.session_id).map((turn) => turn.role),
      ["user", "assistant"],
    );

    const second = store.rotateSession("local:main", "new_session");
    const context = store.context({
      query: "Should the explanation be concise?",
      currentSessionId: second.session_id,
    });

    assert.equal(context.durable_memories[0].memory_id, saved.memory_id);
    assert.equal(context.durable_memories[0].kind, "preference");
    assert.deepEqual(
      context.durable_memories[0].evidence_episode_ids,
      saved.evidence_episode_ids,
    );
    assert.equal(context.recent_sessions.length, 1);
    assert.deepEqual(
      context.recent_sessions[0].turns.map((turn) => turn.role),
      ["user", "assistant"],
    );
    assert.deepEqual(store.status(), {
      state: "ready",
      sessions: 2,
      turns: 2,
      episodes: 2,
      active_memories: 1,
    });
  });
});

test("saved session summaries exclude empty routes and preserve conversations across reopen and resume", async () => {
  let now = "2026-09-10T09:00:00.000Z";
  await withMemoryStore(async ({ store, reopen }) => {
    assert.deepEqual(store.listSessions(), []);
    const first = store.startSession();
    assert.deepEqual(store.listSessions(), []);
    now = "2026-09-10T09:01:00.000Z";
    store.appendCompletedTurn(first.session_id, {
      user: "Find a quiet record for tonight.",
      assistant: "Try this piano record.",
    });
    now = "2026-09-10T09:02:00.000Z";
    const second = store.rotateSession();
    now = "2026-09-10T09:03:00.000Z";
    store.appendCompletedTurn(second.session_id, {
      user: "Make a walking playlist.",
      assistant: "Here is a steady-paced selection.",
    });
    now = "2026-09-10T09:04:00.000Z";
    const empty = store.rotateSession();
    const otherRoute = store.startSession({ routeKey: "local:other" });
    store.appendCompletedTurn(otherRoute.session_id, {
      user: "This belongs to another route.",
      assistant: "Kept separate.",
    });
    store = await reopen();

    const summaries = store.listSessions();
    assert.deepEqual(summaries, [
      {
        session_id: second.session_id,
        started_at: "2026-09-10T09:02:00.000Z",
        updated_at: "2026-09-10T09:03:00.000Z",
        turn_count: 2,
        title: "Make a walking playlist.",
        custom_title: false,
        pinned_at: null,
        folder_id: null,
      },
      {
        session_id: first.session_id,
        started_at: "2026-09-10T09:00:00.000Z",
        updated_at: "2026-09-10T09:01:00.000Z",
        turn_count: 2,
        title: "Find a quiet record for tonight.",
        custom_title: false,
        pinned_at: null,
        folder_id: null,
      },
    ]);
    assert.deepEqual(store.listSessions({ limit: 1 }), [summaries[0]]);
    assert.equal(store.listSessions({ routeKey: "local:other" })[0].session_id, otherRoute.session_id);
    assert.equal(store.resumeOrStartSession().session_id, empty.session_id);

    now = "2026-09-10T09:05:00.000Z";
    assert.deepEqual(store.resumeSession(first.session_id), first);
    assert.deepEqual(store.listSessions(), summaries, "opening a session does not invent new activity");
    store = await reopen();
    assert.equal(store.resumeOrStartSession().session_id, first.session_id);
    now = "2026-09-10T09:06:00.000Z";
    store.appendCompletedTurn(first.session_id, {
      user: "Something with a little more rhythm?",
      assistant: "This trio keeps the same calm mood.",
    });
    store = await reopen();
    assert.deepEqual(store.listSessions()[0], {
      ...summaries[1],
      updated_at: "2026-09-10T09:06:00.000Z",
      turn_count: 4,
    });
    assert.deepEqual(store.readSessionTurns(first.session_id).map((turn) => turn.text), [
      "Find a quiet record for tonight.",
      "Try this piano record.",
      "Something with a little more rhythm?",
      "This trio keeps the same calm mood.",
    ]);
    store.resumeSession(second.session_id);
    assert.deepEqual(store.readSessionTurns(second.session_id).map((turn) => turn.text), [
      "Make a walking playlist.",
      "Here is a steady-paced selection.",
    ]);
    assert.equal(store.listSessions().length, 2);
    assert.equal(store.status().sessions, 4);
  }, { clock: () => new Date(now) });
});

test("resuming requires an exact session ID on the requested route and is idempotent when already active", async () => {
  await withMemoryStore(async ({ store, databasePath }) => {
    const saved = store.startSession();
    store.appendCompletedTurn(saved.session_id, { user: "Keep this conversation.", assistant: "Saved." });
    const active = store.rotateSession();
    const other = store.startSession({ routeKey: "local:other" });
    const { DatabaseSync } = await import("node:sqlite");
    const inspection = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const readSessions = () => inspection.prepare("SELECT * FROM sessions ORDER BY session_id").all();
      const before = readSessions();
      for (const [id, options] of [
        ["unknown-session", undefined],
        [saved.session_id.slice(0, 8), undefined],
        [` ${saved.session_id}`, undefined],
        [other.session_id, undefined],
        [saved.session_id, { routeKey: "local:other" }],
      ]) {
        assert.throws(() => store.resumeSession(id, options), /not found for this route/);
        assert.deepEqual(readSessions(), before);
      }
      assert.throws(() => store.resumeSession(null), /Session ID is invalid/);
      assert.deepEqual(readSessions(), before);
      assert.deepEqual(store.resumeSession(active.session_id), active);
      assert.deepEqual(readSessions(), before);
      store.resumeSession(saved.session_id);
      const reopened = readSessions().find((row) => row.session_id === saved.session_id);
      assert.equal(reopened.status, "active");
      assert.equal(reopened.ended_at, null);
      assert.equal(reopened.close_reason, null);
      assert.equal(reopened.started_at, saved.started_at);
      const closed = readSessions().find((row) => row.session_id === active.session_id);
      assert.equal(closed.status, "closed");
      assert.equal(closed.close_reason, "resume_session");
      assert.equal(store.resumeOrStartSession("local:other").session_id, other.session_id);
    } finally {
      inspection.close();
    }
  });
});

test("resuming rolls back the active session closure if the target cannot reopen", async () => {
  await withMemoryStore(async ({ store, databasePath }) => {
    const saved = store.startSession();
    const active = store.rotateSession();
    const { DatabaseSync } = await import("node:sqlite");
    const inspection = new DatabaseSync(databasePath);
    try {
      const readSessions = () => inspection.prepare("SELECT * FROM sessions ORDER BY session_id").all();
      const before = readSessions();
      inspection.exec(`
        CREATE TRIGGER fail_session_reopen
        BEFORE UPDATE OF status ON sessions
        WHEN NEW.status = 'active'
        BEGIN
          SELECT RAISE(ABORT, 'test session reopen failure');
        END;
      `);
      assert.throws(() => store.resumeSession(saved.session_id), /test session reopen failure/);
      assert.deepEqual(readSessions(), before);
      assert.equal(store.resumeOrStartSession().session_id, active.session_id);
    } finally {
      inspection.close();
    }
  });
});

test("deleting a root conversation keeps its durable memories and re-roots its branches", async () => {
  let now = Date.parse("2026-10-20T09:00:00.000Z");
  await withMemoryStore(async ({ store, databasePath }) => {
    const root = store.startSession();
    store.appendCompletedTurn(root.session_id, { user: "I always want vinyl-first suggestions.", assistant: "Noted." });
    store.appendCompletedTurn(root.session_id, { user: "Something for a slow Sunday.", assistant: "Try this quiet trio." });
    const explicit = store.remember({ text: "Prefers vinyl-first suggestions", kind: "preference", sourceSessionId: root.session_id });
    // Reflection promotes one dialogue episode, so a memory cites raw text from this conversation.
    const run = store.beginReflection({ provider: "faux", model: "faux-1" });
    const [stated, mood] = run.episodes;
    store.completeReflection({ runId: run.run_id, leaseToken: run.lease_token, proposals: [
      { action: "candidate_memory", assertion_mode: "explicit", confidence: 0.95, episode_ids: [stated.episode_id],
        kind: "preference", rationale: "A direct statement.", statement: "Wants vinyl-first suggestions" },
      { action: "ignore", episode_ids: [mood.episode_id], reason: "A one-off mood." },
    ] });
    const reflected = store.listMemories().find((memory) => memory.text === "Wants vinyl-first suggestions");

    const rootEntries = store.readConversationEntries(root.session_id);
    const child = store.forkConversation(root.session_id, rootEntries[1].entry_id);
    const entry = store.beginConversationEntry(child.session_id, "Something for a slow Saturday.");
    store.finishConversationEntry(child.session_id, entry, { text: "Try this warm record.", status: "completed" });
    const grandchild = store.forkConversation(child.session_id, store.readConversationEntries(child.session_id)[1].entry_id);
    store.rotateSession();

    assert.deepEqual(store.deleteConversation(root.session_id), { deleted: true, session_id: root.session_id, reparented: 1 });

    const { DatabaseSync } = await import("node:sqlite");
    const inspection = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.deepEqual(inspection.prepare("PRAGMA foreign_key_check").all(), []);
      for (const table of ["sessions", "turns", "conversation_entries", "conversation_branches", "episodes"]) {
        assert.equal(inspection.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE session_id = ?`).get(root.session_id).count, 0, table);
      }
      assert.equal(inspection.prepare("SELECT COUNT(*) AS count FROM episodes WHERE kind = 'dialogue'").get().count, 0);
      assert.deepEqual(inspection.prepare("SELECT session_id, root_session_id, parent_session_id FROM conversation_branches ORDER BY rowid")
        .all().map((row) => ({ ...row })), [
        { session_id: child.session_id, root_session_id: child.session_id, parent_session_id: null },
        { session_id: grandchild.session_id, root_session_id: child.session_id, parent_session_id: child.session_id },
      ]);
    } finally {
      inspection.close();
    }

    const memories = store.listMemories();
    assert.deepEqual(memories.map((memory) => memory.text).sort(), ["Prefers vinyl-first suggestions", "Wants vinyl-first suggestions"]);
    assert.deepEqual(memories.find((memory) => memory.memory_id === explicit.memory_id).evidence_episode_ids, explicit.evidence_episode_ids);
    assert.deepEqual(memories.find((memory) => memory.memory_id === reflected.memory_id).evidence_episode_ids, []);
    const fresh = store.resumeOrStartSession();
    const recall = store.context({ query: "slow Sunday vinyl", currentSessionId: fresh.session_id });
    assert.deepEqual(recall.recent_episodes.map((episode) => episode.summary), ["Prefers vinyl-first suggestions"]);
    assert.deepEqual(recall.recent_sessions, []);

    const listed = store.listSessions();
    assert.deepEqual(listed.map((session) => session.session_id).sort(), [child.session_id, grandchild.session_id].sort());
    assert.equal(listed.find((session) => session.session_id === child.session_id).parent_session_id, undefined);
    assert.deepEqual(store.readConversationEntries(child.session_id).map((row) => row.user_text),
      ["I always want vinyl-first suggestions.", "Something for a slow Saturday."]);
    assert.throws(() => store.deleteConversation(root.session_id), /not found for this route/);
  }, { clock: () => new Date(now += 1_000) });
});

test("deleting refuses an open conversation and one on another route, and changes nothing", async () => {
  await withMemoryStore(async ({ store, databasePath }) => {
    const open = store.startSession();
    store.appendCompletedTurn(open.session_id, { user: "Still open somewhere else.", assistant: "Kept." });
    const other = store.startSession({ routeKey: "local:other" });
    store.appendCompletedTurn(other.session_id, { user: "Another route.", assistant: "Kept too." });
    store.closeSession(other.session_id);
    const { DatabaseSync } = await import("node:sqlite");
    const inspection = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const snapshot = () => ["sessions", "turns", "episodes"].map((table) => inspection.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
      const before = snapshot();
      assert.throws(() => store.deleteConversation(open.session_id), /open in another Moondog window or terminal/);
      assert.throws(() => store.deleteConversation(other.session_id), /not found for this route/);
      assert.throws(() => store.deleteConversation(null), /Session ID is invalid/);
      assert.deepEqual(snapshot(), before);
      assert.equal(store.sessionExists(open.session_id), true);
      assert.equal(store.sessionExists("unknown-session"), false);
    } finally {
      inspection.close();
    }
  });
});

test("renamed, pinned and filed conversations round trip through the saved list", async () => {
  let now = Date.parse("2026-10-20T10:00:00.000Z");
  await withMemoryStore(async ({ store, reopen }) => {
    const sessions = [];
    for (const user of ["Find a quiet record.", "Make a walking playlist.", "Play something bright."]) {
      const session = store.rotateSession();
      store.appendCompletedTurn(session.session_id, { user, assistant: "Here you go." });
      sessions.push(session.session_id);
    }
    const [quiet, walking, bright] = sessions;
    const order = () => store.listSessions().map((session) => session.session_id);
    assert.deepEqual(order(), [bright, walking, quiet]);

    assert.deepEqual(store.labelConversation(quiet, { title: "  Sunday \n records " }),
      { session_id: quiet, title: "Sunday records", pinned_at: null, folder_id: null });
    const pinned = store.labelConversation(walking, { pinned: true });
    assert.equal(store.labelConversation(walking, { pinned: true }).pinned_at, pinned.pinned_at, "pinning again keeps the first pin time");
    assert.deepEqual(order(), [walking, bright, quiet]);

    const evenings = store.saveConversationFolder({ name: "Evenings" });
    const walks = store.saveConversationFolder({ name: "Walks" });
    assert.deepEqual([evenings.position, walks.position], [0, 1]);
    assert.deepEqual(store.saveConversationFolder({ folderId: evenings.folder_id, name: "Late evenings" }),
      { ...evenings, name: "Late evenings" });
    assert.throws(() => store.saveConversationFolder({ folderId: "missing-folder", name: "Nope" }), /folder not found/);
    assert.throws(() => store.saveConversationFolder({ name: " " }), /Folder name must not be empty/);
    store.labelConversation(quiet, { folderId: evenings.folder_id });
    assert.throws(() => store.labelConversation(bright, { folderId: "missing-folder" }), /folder not found/);
    assert.throws(() => store.labelConversation(bright, { title: "Elsewhere" }, { routeKey: "local:other" }), /not found for this route/);
    assert.throws(() => store.labelConversation(bright, { color: "red" }), /Conversation label is invalid/);
    assert.throws(() => store.labelConversation(bright, { pinned: "yes" }), /Conversation pin is invalid/);

    store = await reopen();
    const listed = store.listSessions();
    assert.deepEqual(listed.map(({ session_id, title, custom_title, pinned_at, folder_id }) => ({ session_id, title, custom_title, pinned_at, folder_id })), [
      { session_id: walking, title: "Make a walking playlist.", custom_title: false, pinned_at: pinned.pinned_at, folder_id: null },
      { session_id: bright, title: "Play something bright.", custom_title: false, pinned_at: null, folder_id: null },
      { session_id: quiet, title: "Sunday records", custom_title: true, pinned_at: null, folder_id: evenings.folder_id },
    ]);
    assert.deepEqual(store.listConversationFolders().map((folder) => folder.name), ["Late evenings", "Walks"]);

    assert.deepEqual(store.labelConversation(quiet, { title: "" }),
      { session_id: quiet, title: null, pinned_at: null, folder_id: evenings.folder_id });
    assert.equal(store.listSessions().at(-1).title, "Find a quiet record.");
    assert.deepEqual(store.deleteConversationFolder(evenings.folder_id), { deleted: true, folder_id: evenings.folder_id, unfiled: 1 });
    assert.equal(store.listSessions().at(-1).folder_id, null);
    assert.deepEqual(store.listConversationFolders().map((folder) => folder.folder_id), [walks.folder_id]);
    store.labelConversation(walking, { pinned: false });
    assert.deepEqual(order(), [bright, walking, quiet]);
  }, { clock: () => new Date(now += 1_000) });
});

test("a database from an older core gains the label tables and keeps its schema version", async () => {
  await withMemoryStore(async ({ store, databasePath, reopen }) => {
    const saved = store.startSession();
    store.appendCompletedTurn(saved.session_id, { user: "Keep this one.", assistant: "Kept." });
    store.close();
    const { DatabaseSync } = await import("node:sqlite");
    const older = new DatabaseSync(databasePath);
    older.exec("DROP TABLE conversation_labels; DROP TABLE conversation_folders;");
    older.close();

    store = await reopen();
    const folder = store.saveConversationFolder({ name: "Kept" });
    store.labelConversation(saved.session_id, { title: "Renamed", folderId: folder.folder_id });
    assert.equal(store.listSessions()[0].title, "Renamed");
    store.close();
    // Older cores open only schema versions 0 to 3, so the new tables must not bump it.
    const inspection = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(MOONDOG_MEMORY_SCHEMA_VERSION, 3);
      assert.equal(inspection.prepare("PRAGMA user_version").get().user_version, 3);
    } finally {
      inspection.close();
    }
  });
});

test("prompt-local mutations commit with the completed exchange", async () => {
  await withMemoryStore(async ({ store }) => {
    const session = store.startSession();
    const prepared = store.prepareRemember({
      text: "默认用中文回答",
      kind: "preference",
      sourceSessionId: session.session_id,
    });

    assert.deepEqual(store.listMemories(), []);
    store.commitCompletedPrompt(session.session_id, {
      user: "记住以后默认用中文回答。",
      assistant: "好，我会记住。",
      memoryMutations: [prepared.mutation],
    });

    assert.equal(store.listMemories({ query: "请用中文" }).length, 1);
    assert.equal(store.status().episodes, 2);
  });
});

test("uncommitted mutations and expired episodes stay out of recall", async () => {
  await withMemoryStore(async ({ store }) => {
    const session = store.startSession();
    store.prepareRemember({
      text: "This was staged before an abort",
      kind: "fact",
      sourceSessionId: session.session_id,
    });
    store.recordEpisode({
      sessionId: session.session_id,
      kind: "situational_context",
      sourceKind: "manual",
      summary: "Tonight only, keep the volume low",
      occurredAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-02T00:00:00.000Z",
    });

    assert.deepEqual(store.listMemories(), []);
    assert.deepEqual(
      store.recentEpisodes({ query: "volume", now: "2026-01-03T00:00:00.000Z" }),
      [],
    );
  });
});

test("explicit memories deduplicate and can be forgotten", async () => {
  await withMemoryStore(async ({ store }) => {
    const session = store.startSession();
    const first = store.remember({
      text: "Avoid live recordings",
      kind: "constraint",
      sourceSessionId: session.session_id,
    });
    const duplicate = store.remember({
      text: "  avoid LIVE recordings  ",
      kind: "constraint",
      sourceSessionId: session.session_id,
    });

    assert.equal(first.created, true);
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.memory_id, first.memory_id);
    assert.equal(store.forget(first.memory_id).forgotten, true);
    assert.deepEqual(store.listMemories(), []);
  });
});

test("memory reflection atomically promotes, queues, and rejects an exact episode batch", async () => {
  await withMemoryStore(async ({ store }) => {
    const session = store.startSession();
    const explicit = store.recordEpisode({
      sessionId: session.session_id,
      kind: "dialogue",
      sourceKind: "turn",
      summary: "User says they prefer concise answers.",
    });
    const music = store.recordEpisode({
      sessionId: session.session_id,
      kind: "dialogue",
      sourceKind: "turn",
      summary: "User asks for more early ambient techno.",
    });
    const transient = store.recordEpisode({
      sessionId: session.session_id,
      kind: "dialogue",
      sourceKind: "turn",
      summary: "Assistant says hello.",
    });

    const run = store.beginReflection({
      provider: "faux",
      model: "faux-1",
    });
    assert.equal(run.state, "started");
    assert.equal(
      store.beginReflection({ provider: "faux", model: "faux-1" }).state,
      "busy",
    );

    const completed = store.completeReflection({
      runId: run.run_id,
      leaseToken: run.lease_token,
      proposals: [
        {
          action: "candidate_memory",
          assertion_mode: "explicit",
          confidence: 0.97,
          episode_ids: [explicit.episode_id],
          kind: "preference",
          rationale: "The user directly stated a stable response preference.",
          statement: "Prefers concise answers",
        },
        {
          action: "candidate_music_profile",
          confidence: 0.82,
          dimension: "style",
          direction: "positive",
          episode_ids: [music.episode_id],
          rationale: "This is music-specific taste evidence.",
          value: "early ambient techno",
        },
        {
          action: "ignore",
          episode_ids: [transient.episode_id],
          reason: "An assistant greeting is not user memory.",
        },
      ],
    });

    assert.equal(completed.state, "completed");
    assert.deepEqual(completed.counts, {
      proposals: 3,
      promoted_memories: 1,
      created_memories: 1,
      candidate_episodes: 1,
      ignored_episodes: 1,
    });
    const memories = store.listMemories();
    assert.equal(memories.length, 1);
    assert.equal(memories[0].text, "Prefers concise answers");
    assert.deepEqual(memories[0].evidence_episode_ids, [explicit.episode_id]);
    const reflectionStatus = store.reflectionStatus();
    assert.equal(reflectionStatus.state, "ready");
    assert.equal(reflectionStatus.pending_episodes, 0);
    assert.equal(reflectionStatus.candidate_episodes, 1);
    assert.equal(reflectionStatus.last_run.run_id, run.run_id);
    assert.equal(reflectionStatus.last_run.status, "completed");
    assert.equal(reflectionStatus.last_run.episode_count, 3);
    assert.deepEqual(reflectionStatus.last_run.counts, completed.counts);
  });
});

test("failed and dry-run reflections leave episodes available", async () => {
  await withMemoryStore(async ({ store }) => {
    const episode = store.recordEpisode({
      kind: "situational_context",
      sourceKind: "manual",
      summary: "Keep this batch available for another attempt.",
    });
    const failed = store.beginReflection({
      provider: "faux",
      model: "faux-1",
    });
    assert.throws(
      () =>
        store.completeReflection({
          runId: failed.run_id,
          leaseToken: failed.lease_token,
          proposals: [
            {
              action: "ignore",
              episode_ids: ["not-the-selected-episode"],
              reason: "Invalid coverage.",
            },
          ],
        }),
      /exact episode batch/iu,
    );
    assert.equal(
      store.failReflection(failed.run_id, failed.lease_token, "invalid_output")
        .failed,
      true,
    );

    const dryRun = store.beginReflection({
      provider: "faux",
      model: "faux-1",
    });
    const preview = store.completeReflection({
      runId: dryRun.run_id,
      leaseToken: dryRun.lease_token,
      proposals: [
        {
          action: "ignore",
          episode_ids: [episode.episode_id],
          reason: "Preview only.",
        },
      ],
      dryRun: true,
    });
    assert.equal(preview.state, "dry_run");
    assert.equal(preview.counts.ignored_episodes, 1);
    assert.deepEqual(
      store.pendingReflectionEpisodes().map((entry) => entry.episode_id),
      [episode.episode_id],
    );
  });
});

test("schema version one upgrades additively to the reflection schema", async () => {
  await withMemoryStore(async ({ store, databasePath, reopen }) => {
    store.close();
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(databasePath);
    database.exec("DROP TABLE reflection_runs");
    database.exec("PRAGMA user_version = 1");
    database.close();

    store = await reopen();
    assert.deepEqual(store.reflectionStatus(), {
      state: "ready",
      pending_episodes: 0,
      candidate_episodes: 0,
      last_run: null,
    });
  });
});

test("memory reflection cannot resurrect an explicitly forgotten claim", async () => {
  await withMemoryStore(async ({ store }) => {
    const session = store.startSession();
    const olderEpisode = store.recordEpisode({
      sessionId: session.session_id,
      kind: "dialogue",
      sourceKind: "turn",
      summary: "User says to avoid live recordings.",
    });
    const remembered = store.remember({
      text: "Avoid live recordings",
      kind: "constraint",
      sourceSessionId: session.session_id,
    });
    store.forget(remembered.memory_id, {
      sourceSessionId: session.session_id,
    });

    const run = store.beginReflection({
      provider: "faux",
      model: "faux-1",
    });
    assert.deepEqual(
      run.episodes.map((episode) => episode.episode_id),
      [olderEpisode.episode_id],
    );
    const completed = store.completeReflection({
      runId: run.run_id,
      leaseToken: run.lease_token,
      proposals: [
        {
          action: "candidate_memory",
          assertion_mode: "explicit",
          confidence: 0.99,
          episode_ids: [olderEpisode.episode_id],
          kind: "constraint",
          rationale: "The older dialogue directly states the claim.",
          statement: "Avoid live recordings",
        },
      ],
    });

    assert.deepEqual(store.listMemories(), []);
    assert.equal(completed.counts.promoted_memories, 0);
    assert.equal(completed.counts.created_memories, 0);
    assert.equal(completed.counts.candidate_episodes, 1);
  });
});

test("memory reflection cannot promote an episode that expires during the model call", async () => {
  let now = "2026-08-26T00:00:00.000Z";
  await withMemoryStore(async ({ store }) => {
    const episode = store.recordEpisode({
      kind: "situational_context",
      sourceKind: "manual",
      summary: "For the next minute, prefer quiet music.",
      expiresAt: "2026-08-26T00:01:00.000Z",
    });
    const run = store.beginReflection({
      provider: "faux",
      model: "faux-1",
    });
    now = "2026-08-26T00:02:00.000Z";

    assert.throws(
      () =>
        store.completeReflection({
          runId: run.run_id,
          leaseToken: run.lease_token,
          proposals: [
            {
              action: "candidate_memory",
              assertion_mode: "explicit",
              confidence: 0.99,
              episode_ids: [episode.episode_id],
              kind: "preference",
              rationale: "The user directly stated it.",
              statement: "Prefers quiet music",
            },
          ],
        }),
      /expired or changed/iu,
    );
    assert.deepEqual(store.listMemories(), []);
    assert.equal(
      store.failReflection(run.run_id, run.lease_token, "episode_expired")
        .failed,
      true,
    );
    assert.deepEqual(store.pendingReflectionEpisodes(), []);
  }, { clock: () => new Date(now) });
});

test("memory reflection keeps still-valid time-bounded evidence out of persistent claims", async () => {
  await withMemoryStore(async ({ store }) => {
    const episode = store.recordEpisode({
      kind: "situational_context",
      sourceKind: "manual",
      summary: "For today, prefer quiet music.",
      expiresAt: "2026-08-27T00:00:00.000Z",
    });
    const run = store.beginReflection({
      provider: "faux",
      model: "faux-1",
    });
    const completed = store.completeReflection({
      runId: run.run_id,
      leaseToken: run.lease_token,
      proposals: [
        {
          action: "candidate_memory",
          assertion_mode: "explicit",
          confidence: 0.99,
          episode_ids: [episode.episode_id],
          kind: "preference",
          rationale: "The user directly stated it.",
          statement: "Prefers quiet music",
        },
      ],
    });

    assert.deepEqual(store.listMemories(), []);
    assert.equal(completed.counts.promoted_memories, 0);
    assert.equal(completed.counts.candidate_episodes, 1);
  }, { clock: () => new Date("2026-08-26T00:00:00.000Z") });
});

test("reflection coverage compares episode IDs without delimiter ambiguity", async () => {
  await withMemoryStore(async ({ store }) => {
    for (const [index, episodeId] of ["a", "b,c", "a,b", "c"].entries()) {
      store.recordEpisode({
        episodeId,
        kind: "dialogue",
        sourceKind: "turn",
        summary: `Episode ${episodeId}`,
        occurredAt: new Date(Date.UTC(2026, 7, 26, 0, index)).toISOString(),
      });
    }
    const run = store.beginReflection({
      provider: "faux",
      model: "faux-1",
      limit: 2,
    });
    assert.deepEqual(
      run.episodes.map((episode) => episode.episode_id),
      ["a", "b,c"],
    );

    assert.throws(
      () =>
        store.completeReflection({
          runId: run.run_id,
          leaseToken: run.lease_token,
          proposals: [
            {
              action: "ignore",
              episode_ids: ["a,b", "c"],
              reason: "Wrong episodes with the same comma-joined string.",
            },
          ],
        }),
      /exact episode batch/iu,
    );
    assert.equal(store.pendingReflectionEpisodes().length, 4);
  });
});

test("an expired reflection lease cannot commit model output", async () => {
  let now = "2026-08-26T00:00:00.000Z";
  await withMemoryStore(async ({ store }) => {
    const episode = store.recordEpisode({
      kind: "dialogue",
      sourceKind: "turn",
      summary: "A pending episode.",
    });
    const run = store.beginReflection({
      provider: "faux",
      model: "faux-1",
      leaseMs: 30_000,
    });
    now = "2026-08-26T00:00:31.000Z";

    assert.equal(store.reflectionStatus().state, "stale");

    assert.throws(
      () =>
        store.completeReflection({
          runId: run.run_id,
          leaseToken: run.lease_token,
          proposals: [
            {
              action: "ignore",
              episode_ids: [episode.episode_id],
              reason: "The result arrived too late.",
            },
          ],
        }),
      /lease was lost/iu,
    );
    assert.equal(
      store.failReflection(run.run_id, run.lease_token, "lease_expired").failed,
      true,
    );
    assert.equal(store.pendingReflectionEpisodes().length, 1);
  }, { clock: () => new Date(now) });
});

test("reflection does not relabel an exact-text memory with an incompatible kind", async () => {
  await withMemoryStore(async ({ store }) => {
    const session = store.startSession();
    const pending = store.recordEpisode({
      sessionId: session.session_id,
      kind: "dialogue",
      sourceKind: "turn",
      summary: "User says to avoid live recordings.",
    });
    const existing = store.remember({
      text: "Avoid live recordings",
      kind: "fact",
      horizon: "recent",
      sourceSessionId: session.session_id,
    });
    const run = store.beginReflection({
      provider: "faux",
      model: "faux-1",
    });
    const completed = store.completeReflection({
      runId: run.run_id,
      leaseToken: run.lease_token,
      proposals: [
        {
          action: "candidate_memory",
          assertion_mode: "explicit",
          confidence: 0.99,
          episode_ids: [pending.episode_id],
          kind: "constraint",
          rationale: "The user directly stated a constraint.",
          statement: "Avoid live recordings",
        },
      ],
    });

    const memories = store.listMemories();
    assert.equal(memories.length, 1);
    assert.equal(memories[0].memory_id, existing.memory_id);
    assert.equal(memories[0].kind, "fact");
    assert.equal(memories[0].horizon, "recent");
    assert.ok(!memories[0].evidence_episode_ids.includes(pending.episode_id));
    assert.equal(completed.counts.promoted_memories, 0);
    assert.equal(completed.counts.candidate_episodes, 1);
  });
});
