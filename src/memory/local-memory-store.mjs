import { randomUUID } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const MOONDOG_MEMORY_SCHEMA_VERSION = 2;
export function resolveMoondogMemoryPath(environment = process.env) {
  const configuredState = environment.MOONDOG_STATE_HOME?.trim();
  if (configuredState) {
    if (!path.isAbsolute(configuredState)) {
      throw new TypeError("MOONDOG_STATE_HOME must be an absolute path");
    }
    return path.join(path.resolve(configuredState), "memory.sqlite");
  }

  const configuredConfig = environment.MOONDOG_CONFIG_HOME?.trim();
  if (configuredConfig) {
    if (!path.isAbsolute(configuredConfig)) {
      throw new TypeError("MOONDOG_CONFIG_HOME must be an absolute path");
    }
    return path.join(path.resolve(configuredConfig), "memory.sqlite");
  }

  const xdgState = environment.XDG_STATE_HOME?.trim();
  if (xdgState && path.isAbsolute(xdgState)) {
    return path.join(path.resolve(xdgState), "moondog", "memory.sqlite");
  }

  return path.join(homedir(), ".local", "state", "moondog", "memory.sqlite");
}

export const defaultMoondogMemoryPath = resolveMoondogMemoryPath();

const memoryKinds = new Set(["fact", "preference", "constraint", "goal"]);
const memoryHorizons = new Set(["recent", "persistent"]);
const episodeKinds = new Set([
  "dialogue",
  "session_summary",
  "listening_activity",
  "situational_context",
  "explicit_assertion",
  "memory_retraction",
]);
const episodeSourceKinds = new Set([
  "turn",
  "listening_event",
  "taste_event",
  "session",
  "manual",
]);
const promotionStates = new Set(["none", "candidate", "promoted", "rejected"]);
const reflectionTriggers = new Set([
  "manual",
  "schedule",
  "session_end",
  "import",
]);
const reflectionActions = new Set([
  "candidate_memory",
  "candidate_music_profile",
  "ignore",
]);

const schema = `
  PRAGMA foreign_keys = ON;
  PRAGMA trusted_schema = OFF;

  CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY NOT NULL,
    route_key TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    close_reason TEXT,
    status TEXT NOT NULL CHECK (status IN ('active', 'closed'))
  ) STRICT;

  CREATE UNIQUE INDEX IF NOT EXISTS sessions_one_active_route
    ON sessions(route_key)
    WHERE status = 'active';

  CREATE TABLE IF NOT EXISTS turns (
    turn_id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 1),
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (session_id, position),
    FOREIGN KEY (session_id) REFERENCES sessions(session_id)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS turns_session_position
    ON turns(session_id, position);

  CREATE TABLE IF NOT EXISTS memory_claims (
    memory_id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('fact', 'preference', 'constraint', 'goal')),
    horizon TEXT NOT NULL CHECK (horizon IN ('recent', 'persistent')),
    content TEXT NOT NULL,
    normalized_content TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'forgotten', 'superseded')),
    origin TEXT NOT NULL,
    source_session_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    supersedes_memory_id TEXT,
    recall_count INTEGER NOT NULL DEFAULT 0 CHECK (recall_count >= 0),
    last_recalled_at TEXT,
    FOREIGN KEY (source_session_id) REFERENCES sessions(session_id),
    FOREIGN KEY (supersedes_memory_id) REFERENCES memory_claims(memory_id)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS memory_claims_active_recent
    ON memory_claims(status, updated_at DESC);

  CREATE UNIQUE INDEX IF NOT EXISTS memory_claims_one_active_text
    ON memory_claims(normalized_content)
    WHERE status = 'active';

  CREATE TABLE IF NOT EXISTS episodes (
    episode_id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT,
    kind TEXT NOT NULL CHECK (kind IN (
      'dialogue',
      'session_summary',
      'listening_activity',
      'situational_context',
      'explicit_assertion',
      'memory_retraction'
    )),
    source_kind TEXT NOT NULL CHECK (source_kind IN (
      'turn',
      'listening_event',
      'taste_event',
      'session',
      'manual'
    )),
    source_id TEXT,
    summary TEXT NOT NULL,
    details_json TEXT,
    occurred_at TEXT NOT NULL,
    expires_at TEXT,
    importance INTEGER NOT NULL DEFAULT 1 CHECK (importance BETWEEN 0 AND 3),
    promotion_state TEXT NOT NULL CHECK (
      promotion_state IN ('none', 'candidate', 'promoted', 'rejected')
    ),
    status TEXT NOT NULL CHECK (status IN ('active', 'retracted')),
    created_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(session_id)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS episodes_recent_active
    ON episodes(status, occurred_at DESC);

  CREATE TABLE IF NOT EXISTS claim_episode_refs (
    memory_id TEXT NOT NULL,
    episode_id TEXT NOT NULL,
    relation TEXT NOT NULL CHECK (relation IN ('supports', 'contradicts')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (memory_id, episode_id, relation),
    FOREIGN KEY (memory_id) REFERENCES memory_claims(memory_id),
    FOREIGN KEY (episode_id) REFERENCES episodes(episode_id)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS reflection_runs (
    run_id TEXT PRIMARY KEY NOT NULL,
    trigger_kind TEXT NOT NULL CHECK (
      trigger_kind IN ('manual', 'schedule', 'session_end', 'import')
    ),
    worker_version TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
      status IN ('started', 'completed', 'dry_run', 'failed')
    ),
    episode_ids_json TEXT NOT NULL,
    proposals_json TEXT,
    counts_json TEXT,
    error_code TEXT,
    lease_token TEXT NOT NULL,
    lease_expires_at TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT
  ) STRICT;

  CREATE UNIQUE INDEX IF NOT EXISTS reflection_runs_one_active
    ON reflection_runs(status)
    WHERE status = 'started';

  CREATE INDEX IF NOT EXISTS reflection_runs_recent
    ON reflection_runs(started_at DESC);
`;

let databaseConstructorPromise;

async function databaseConstructor() {
  databaseConstructorPromise ??= import("node:sqlite").then(
    ({ DatabaseSync }) => DatabaseSync,
  );
  return databaseConstructorPromise;
}

function isoTimestamp(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("Memory clock is invalid");
  return date.toISOString();
}

function cleanText(value, maximum, label) {
  if (typeof value !== "string") throw new TypeError(`${label} must be text`);
  const cleaned = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .replace(/[\u202a-\u202e\u2066-\u2069]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (!cleaned) throw new TypeError(`${label} must not be empty`);
  return Array.from(cleaned).slice(0, maximum).join("");
}

function cleanKind(value) {
  const kind = value ?? "fact";
  if (!memoryKinds.has(kind)) throw new TypeError("Memory kind is invalid");
  return kind;
}

function cleanHorizon(value) {
  const horizon = value ?? "persistent";
  if (!memoryHorizons.has(horizon)) {
    throw new TypeError("Memory horizon is invalid");
  }
  return horizon;
}

function cleanEpisodeKind(value) {
  if (!episodeKinds.has(value)) throw new TypeError("Episode kind is invalid");
  return value;
}

function cleanEpisodeSourceKind(value) {
  if (!episodeSourceKinds.has(value)) {
    throw new TypeError("Episode source kind is invalid");
  }
  return value;
}

function cleanOptionalText(value, maximum, label) {
  if (value === undefined || value === null || value === "") return null;
  return cleanText(value, maximum, label);
}

function cleanTimestamp(value, label) {
  if (value === undefined || value === null || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`${label} is invalid`);
  return date.toISOString();
}

function cleanImportance(value = 1) {
  const importance = Number(value);
  if (!Number.isInteger(importance) || importance < 0 || importance > 3) {
    throw new TypeError("Episode importance is invalid");
  }
  return importance;
}

function cleanPromotionState(value = "none") {
  if (!promotionStates.has(value)) {
    throw new TypeError("Episode promotion state is invalid");
  }
  return value;
}

function cleanReflectionTrigger(value = "manual") {
  if (!reflectionTriggers.has(value)) {
    throw new TypeError("Memory reflection trigger is invalid");
  }
  return value;
}

function cleanConfidence(value) {
  const confidence = Number(value);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new TypeError("Memory reflection confidence is invalid");
  }
  return confidence;
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort().join(",");
  if (actual !== [...expected].sort().join(",")) {
    throw new TypeError(`${label} has an unsupported shape`);
  }
}

function cleanEpisodeIds(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 24) {
    throw new TypeError("Memory reflection episode IDs are invalid");
  }
  const ids = value.map((episodeId) =>
    cleanText(episodeId, 128, "Memory reflection episode ID"),
  );
  if (new Set(ids).size !== ids.length) {
    throw new TypeError("Memory reflection episode IDs must be unique");
  }
  return ids;
}

function normalizeReflectionProposal(value) {
  if (!reflectionActions.has(value?.action)) {
    throw new TypeError("Memory reflection action is invalid");
  }
  if (value.action === "candidate_memory") {
    exactKeys(
      value,
      [
        "action",
        "assertion_mode",
        "confidence",
        "episode_ids",
        "kind",
        "rationale",
        "statement",
      ],
      "Memory proposal",
    );
    if (!new Set(["explicit", "inferred"]).has(value.assertion_mode)) {
      throw new TypeError("Memory proposal assertion mode is invalid");
    }
    return {
      action: value.action,
      assertion_mode: value.assertion_mode,
      confidence: cleanConfidence(value.confidence),
      episode_ids: cleanEpisodeIds(value.episode_ids),
      kind: cleanKind(value.kind),
      rationale: cleanText(value.rationale, 500, "Memory proposal rationale"),
      statement: cleanText(value.statement, 1_000, "Memory proposal statement"),
    };
  }
  if (value.action === "candidate_music_profile") {
    exactKeys(
      value,
      [
        "action",
        "confidence",
        "dimension",
        "direction",
        "episode_ids",
        "rationale",
        "value",
      ],
      "Music profile proposal",
    );
    if (!new Set(["positive", "negative", "contextual"]).has(value.direction)) {
      throw new TypeError("Music profile proposal direction is invalid");
    }
    return {
      action: value.action,
      confidence: cleanConfidence(value.confidence),
      dimension: cleanText(value.dimension, 128, "Music profile dimension"),
      direction: value.direction,
      episode_ids: cleanEpisodeIds(value.episode_ids),
      rationale: cleanText(
        value.rationale,
        500,
        "Music profile proposal rationale",
      ),
      value: cleanText(value.value, 1_000, "Music profile value"),
    };
  }
  exactKeys(value, ["action", "episode_ids", "reason"], "Ignore proposal");
  return {
    action: value.action,
    episode_ids: cleanEpisodeIds(value.episode_ids),
    reason: cleanText(value.reason, 500, "Ignore proposal reason"),
  };
}

function normalizeReflectionProposals(value, expectedEpisodeIds) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 24) {
    throw new TypeError("Memory reflection proposals are invalid");
  }
  const proposals = value.map(normalizeReflectionProposal);
  const covered = proposals.flatMap((proposal) => proposal.episode_ids);
  if (new Set(covered).size !== covered.length) {
    throw new TypeError("Each episode must appear in one reflection proposal");
  }
  const expected = [...expectedEpisodeIds].sort();
  const actual = [...covered].sort();
  if (
    actual.length !== expected.length ||
    actual.some((episodeId, index) => episodeId !== expected[index])
  ) {
    throw new TypeError("Reflection proposals must cover the exact episode batch");
  }
  return proposals;
}

function cleanDetailsJson(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Episode details must be an object");
  }
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > 8_000) {
    throw new TypeError("Episode details are too large");
  }
  return serialized;
}

function publicMemory(row) {
  return {
    memory_id: row.memory_id,
    kind: row.kind,
    horizon: row.horizon,
    text: row.content,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function publicEpisode(row) {
  return {
    episode_id: row.episode_id,
    kind: row.kind,
    summary: row.summary,
    occurred_at: row.occurred_at,
    expires_at: row.expires_at,
    importance: row.importance,
    promotion_state: row.promotion_state,
  };
}

function reflectionEpisode(row) {
  return {
    episode_id: row.episode_id,
    session_id: row.session_id,
    kind: row.kind,
    source_kind: row.source_kind,
    summary: row.summary,
    occurred_at: row.occurred_at,
    expires_at: row.expires_at,
    importance: row.importance,
  };
}

function publicReflectionRun(row) {
  if (!row) return null;
  const counts = row.counts_json ? JSON.parse(row.counts_json) : null;
  return {
    run_id: row.run_id,
    trigger: row.trigger_kind,
    worker_version: row.worker_version,
    provider: row.provider,
    model: row.model,
    status: row.status,
    episode_count: JSON.parse(row.episode_ids_json).length,
    ...(counts ? { counts } : {}),
    ...(row.error_code ? { error_code: row.error_code } : {}),
    started_at: row.started_at,
    completed_at: row.completed_at,
  };
}

function normalized(value) {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

function queryTerms(value) {
  if (typeof value !== "string") return [];
  const text = normalized(value);
  const segments = text.match(/\p{Script=Han}+|[\p{L}\p{N}]+/gu) ?? [];
  const terms = [];
  for (const segment of segments) {
    if (/^\p{Script=Han}+$/u.test(segment)) {
      const characters = Array.from(segment);
      if (characters.length === 1) terms.push(characters[0]);
      for (let index = 0; index < characters.length - 1; index += 1) {
        terms.push(`${characters[index]}${characters[index + 1]}`);
      }
    } else if (Array.from(segment).length >= 2) {
      terms.push(segment);
    }
  }
  return [...new Set(terms)].slice(0, 24);
}

function relevanceScore(memory, terms) {
  if (terms.length === 0) return 0;
  const content = normalized(memory.content);
  return terms.reduce(
    (score, term) => score + (content.includes(term) ? term.length : 0),
    0,
  );
}

export class LocalMemoryStore {
  #database;
  #clock;
  #closed = false;

  constructor(database, { clock = () => new Date() } = {}) {
    this.#database = database;
    this.#clock = clock;
  }

  #assertOpen() {
    if (this.#closed) throw new Error("Memory store is closed");
  }

  #insertEpisode({
    episodeId = randomUUID(),
    sessionId,
    kind,
    sourceKind,
    sourceId,
    summary,
    details,
    occurredAt,
    expiresAt,
    importance = 1,
    promotionState = "none",
    timestamp = isoTimestamp(this.#clock),
  }) {
    const occurred =
      cleanTimestamp(occurredAt, "Episode occurrence") ?? timestamp;
    const expires = cleanTimestamp(expiresAt, "Episode expiration");
    const cleanedEpisodeId = cleanText(episodeId, 128, "Episode ID");
    if (expires && expires <= occurred) {
      throw new TypeError("Episode expiration must follow its occurrence");
    }
    this.#database
      .prepare(`
        INSERT INTO episodes(
          episode_id,
          session_id,
          kind,
          source_kind,
          source_id,
          summary,
          details_json,
          occurred_at,
          expires_at,
          importance,
          promotion_state,
          status,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
      `)
      .run(
        cleanedEpisodeId,
        sessionId ?? null,
        cleanEpisodeKind(kind),
        cleanEpisodeSourceKind(sourceKind),
        cleanOptionalText(sourceId, 128, "Episode source ID"),
        cleanText(summary, 2_000, "Episode summary"),
        cleanDetailsJson(details),
        occurred,
        expires,
        cleanImportance(importance),
        cleanPromotionState(promotionState),
        timestamp,
      );
    return this.#database
      .prepare("SELECT * FROM episodes WHERE episode_id = ?")
      .get(cleanedEpisodeId);
  }

  #applyPreparedRemember(mutation, { sourceId, timestamp }) {
    const episode = this.#insertEpisode({
      episodeId: mutation.episodeId,
      sessionId: mutation.sourceSessionId,
      kind: "explicit_assertion",
      sourceKind: sourceId ? "turn" : "manual",
      sourceId,
      summary: mutation.content,
      importance: 3,
      promotionState: "promoted",
      timestamp,
    });
    const inserted = this.#database
      .prepare(`
        INSERT OR IGNORE INTO memory_claims(
          memory_id,
          kind,
          horizon,
          content,
          normalized_content,
          status,
          origin,
          source_session_id,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
      `)
      .run(
        mutation.memoryId,
        mutation.kind,
        mutation.horizon,
        mutation.content,
        mutation.normalizedContent,
        mutation.origin,
        mutation.sourceSessionId,
        timestamp,
        timestamp,
      );
    const row = this.#database
      .prepare(`
        SELECT *
        FROM memory_claims
        WHERE status = 'active' AND normalized_content = ?
      `)
      .get(mutation.normalizedContent);
    this.#database
      .prepare(`
        INSERT OR IGNORE INTO claim_episode_refs(
          memory_id, episode_id, relation, created_at
        ) VALUES (?, ?, 'supports', ?)
      `)
      .run(row.memory_id, episode.episode_id, timestamp);
    return {
      ...publicMemory(row),
      created: inserted.changes === 1,
      evidence_episode_ids: [episode.episode_id],
    };
  }

  #applyPreparedForget(mutation, { sourceId, timestamp }) {
    const row = this.#database
      .prepare(`
        SELECT * FROM memory_claims
        WHERE memory_id = ? AND status = 'active'
      `)
      .get(mutation.memoryId);
    if (!row) return { forgotten: false, memory_id: mutation.memoryId };
    const episode = this.#insertEpisode({
      episodeId: mutation.episodeId,
      sessionId: mutation.sourceSessionId,
      kind: "memory_retraction",
      sourceKind: sourceId ? "turn" : "manual",
      sourceId,
      summary: "The user retracted a stored memory.",
      importance: 3,
      promotionState: "promoted",
      timestamp,
    });
    const result = this.#database
      .prepare(`
        UPDATE memory_claims
        SET status = 'forgotten', updated_at = ?
        WHERE memory_id = ? AND status = 'active'
      `)
      .run(timestamp, mutation.memoryId);
    this.#database
      .prepare(`
        INSERT OR IGNORE INTO claim_episode_refs(
          memory_id, episode_id, relation, created_at
        ) VALUES (?, ?, 'contradicts', ?)
      `)
      .run(mutation.memoryId, episode.episode_id, timestamp);
    return {
      forgotten: result.changes === 1,
      memory_id: mutation.memoryId,
      evidence_episode_ids: [episode.episode_id],
    };
  }

  #applyReflectionMemoryProposal(proposal, timestamp) {
    const normalizedContent = normalized(proposal.statement);
    const timeBoundedEvidence = this.#database
      .prepare(`
        SELECT episode_id
        FROM episodes
        WHERE episode_id IN (${proposal.episode_ids.map(() => "?").join(", ")})
          AND expires_at IS NOT NULL
        LIMIT 1
      `)
      .get(...proposal.episode_ids);
    if (timeBoundedEvidence) {
      return {
        memory_id: null,
        created: false,
        blocked_by_conflict: false,
        blocked_by_expiry: true,
        blocked_by_retraction: false,
      };
    }
    const existing = this.#database
      .prepare(`
        SELECT *
        FROM memory_claims
        WHERE status = 'active' AND normalized_content = ?
      `)
      .get(normalizedContent);
    if (
      existing &&
      (existing.kind !== proposal.kind || existing.horizon !== "persistent")
    ) {
      return {
        memory_id: existing.memory_id,
        created: false,
        blocked_by_conflict: true,
        blocked_by_expiry: false,
        blocked_by_retraction: false,
      };
    }
    let row = existing;
    let created = false;
    if (!row) {
      const priorRetraction = this.#database
        .prepare(`
          SELECT memory_id
          FROM memory_claims
          WHERE normalized_content = ?
            AND status IN ('forgotten', 'superseded')
          ORDER BY updated_at DESC, memory_id ASC
          LIMIT 1
        `)
        .get(normalizedContent);
      if (priorRetraction) {
        return {
          memory_id: priorRetraction.memory_id,
          created: false,
          blocked_by_conflict: false,
          blocked_by_expiry: false,
          blocked_by_retraction: true,
        };
      }
      const sourceSessions = this.#database
        .prepare(`
          SELECT DISTINCT session_id
          FROM episodes
          WHERE episode_id IN (${proposal.episode_ids.map(() => "?").join(", ")})
            AND session_id IS NOT NULL
        `)
        .all(...proposal.episode_ids);
      const sourceSessionId =
        sourceSessions.length === 1 ? sourceSessions[0].session_id : null;
      const memoryId = randomUUID();
      this.#database
        .prepare(`
          INSERT INTO memory_claims(
            memory_id,
            kind,
            horizon,
            content,
            normalized_content,
            status,
            origin,
            source_session_id,
            created_at,
            updated_at
          ) VALUES (?, ?, 'persistent', ?, ?, 'active', ?, ?, ?, ?)
        `)
        .run(
          memoryId,
          proposal.kind,
          proposal.statement,
          normalizedContent,
          "memory_agent_explicit",
          sourceSessionId,
          timestamp,
          timestamp,
        );
      row = this.#database
        .prepare("SELECT * FROM memory_claims WHERE memory_id = ?")
        .get(memoryId);
      created = true;
    }
    const link = this.#database.prepare(`
      INSERT OR IGNORE INTO claim_episode_refs(
        memory_id, episode_id, relation, created_at
      ) VALUES (?, ?, 'supports', ?)
    `);
    for (const episodeId of proposal.episode_ids) {
      link.run(row.memory_id, episodeId, timestamp);
    }
    return {
      memory_id: row.memory_id,
      created,
      blocked_by_conflict: false,
      blocked_by_expiry: false,
      blocked_by_retraction: false,
    };
  }

  startSession({ routeKey = "local:main" } = {}) {
    this.#assertOpen();
    const sessionId = randomUUID();
    const startedAt = isoTimestamp(this.#clock);
    const route = cleanText(routeKey, 128, "Session route");
    this.#database
      .prepare(`
        INSERT INTO sessions(session_id, route_key, started_at, status)
        VALUES (?, ?, ?, 'active')
      `)
      .run(sessionId, route, startedAt);
    return { session_id: sessionId, route_key: route, started_at: startedAt };
  }

  resumeOrStartSession(routeKey = "local:main") {
    this.#assertOpen();
    const route = cleanText(routeKey, 128, "Session route");
    const existing = this.#database
      .prepare(`
        SELECT session_id, route_key, started_at
        FROM sessions
        WHERE route_key = ? AND status = 'active'
      `)
      .get(route);
    return existing ?? this.startSession({ routeKey: route });
  }

  listSessions({ routeKey = "local:main", limit = 200 } = {}) {
    this.#assertOpen();
    const route = cleanText(routeKey, 128, "Session route");
    const requestedLimit = Number(limit);
    const bounded = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(Math.trunc(requestedLimit), 200))
      : 200;
    return this.#database
      .prepare(`
        SELECT
          s.session_id,
          s.started_at,
          MAX(t.created_at) AS updated_at,
          COUNT(t.turn_id) AS turn_count,
          COALESCE((
            SELECT first_turn.content
            FROM turns first_turn
            WHERE first_turn.session_id = s.session_id AND first_turn.role = 'user'
            ORDER BY first_turn.position ASC
            LIMIT 1
          ), '') AS title
        FROM sessions s
        JOIN turns t ON t.session_id = s.session_id
        WHERE s.route_key = ?
        GROUP BY s.session_id
        ORDER BY updated_at DESC, s.started_at DESC, s.rowid DESC
        LIMIT ?
      `)
      .all(route, bounded)
      .map((session) => ({
        session_id: session.session_id,
        started_at: session.started_at,
        updated_at: session.updated_at,
        turn_count: session.turn_count,
        title: session.title,
      }));
  }

  resumeSession(sessionId, { routeKey = "local:main" } = {}) {
    this.#assertOpen();
    if (typeof sessionId !== "string" || !sessionId || sessionId.length > 128) {
      throw new TypeError("Session ID is invalid");
    }
    const route = cleanText(routeKey, 128, "Session route");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const session = this.#database
        .prepare(`
          SELECT session_id, route_key, started_at, status
          FROM sessions
          WHERE session_id = ? AND route_key = ?
        `)
        .get(sessionId, route);
      if (!session) throw new Error("Saved conversation not found for this route.");
      if (session.status !== "active") {
        const timestamp = isoTimestamp(this.#clock);
        this.#database
          .prepare(`
            UPDATE sessions
            SET ended_at = ?, close_reason = 'resume_session', status = 'closed'
            WHERE route_key = ? AND status = 'active'
          `)
          .run(timestamp, route);
        this.#database
          .prepare(`
            UPDATE sessions
            SET ended_at = NULL, close_reason = NULL, status = 'active'
            WHERE session_id = ? AND route_key = ?
          `)
          .run(sessionId, route);
      }
      this.#database.exec("COMMIT");
      return {
        session_id: session.session_id,
        route_key: session.route_key,
        started_at: session.started_at,
      };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  rotateSession(routeKey = "local:main", reason = "new_session") {
    this.#assertOpen();
    const route = cleanText(routeKey, 128, "Session route");
    const closeReason = cleanText(reason, 64, "Session close reason");
    const timestamp = isoTimestamp(this.#clock);
    const sessionId = randomUUID();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database
        .prepare(`
          UPDATE sessions
          SET ended_at = ?, close_reason = ?, status = 'closed'
          WHERE route_key = ? AND status = 'active'
        `)
        .run(timestamp, closeReason, route);
      this.#database
        .prepare(`
          INSERT INTO sessions(session_id, route_key, started_at, status)
          VALUES (?, ?, ?, 'active')
        `)
        .run(sessionId, route, timestamp);
      this.#database.exec("COMMIT");
      return {
        session_id: sessionId,
        route_key: route,
        started_at: timestamp,
      };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  closeSession(sessionId, reason = "closed") {
    this.#assertOpen();
    const endedAt = isoTimestamp(this.#clock);
    const result = this.#database
      .prepare(`
        UPDATE sessions
        SET ended_at = ?, close_reason = ?, status = 'closed'
        WHERE session_id = ? AND status = 'active'
      `)
      .run(endedAt, cleanText(reason, 64, "Session close reason"), sessionId);
    return { closed: result.changes === 1, ended_at: endedAt };
  }

  appendCompletedTurn(sessionId, { user, assistant }) {
    return this.commitCompletedPrompt(sessionId, { user, assistant });
  }

  commitCompletedPrompt(
    sessionId,
    { user, assistant, memoryMutations = [] },
  ) {
    this.#assertOpen();
    const userText = cleanText(user, 8_000, "User turn");
    const assistantText = cleanText(assistant, 20_000, "Assistant turn");
    const createdAt = isoTimestamp(this.#clock);
    const insert = this.#database.prepare(`
      INSERT INTO turns(turn_id, session_id, position, role, content, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.#database
        .prepare(`
          SELECT COALESCE(MAX(position), 0) AS position
          FROM turns
          WHERE session_id = ?
        `)
        .get(sessionId);
      const userTurnId = randomUUID();
      insert.run(
        userTurnId,
        sessionId,
        current.position + 1,
        "user",
        userText,
        createdAt,
      );
      insert.run(
        randomUUID(),
        sessionId,
        current.position + 2,
        "assistant",
        assistantText,
        createdAt,
      );
      this.#insertEpisode({
        sessionId,
        kind: "dialogue",
        sourceKind: "turn",
        sourceId: userTurnId,
        summary: userText,
        occurredAt: createdAt,
        importance: 1,
        promotionState: "none",
        timestamp: createdAt,
      });
      const memoryResults = [];
      for (const mutation of memoryMutations) {
        if (mutation?.type === "remember") {
          memoryResults.push(
            this.#applyPreparedRemember(mutation, {
              sourceId: userTurnId,
              timestamp: createdAt,
            }),
          );
        } else if (mutation?.type === "forget") {
          memoryResults.push(
            this.#applyPreparedForget(mutation, {
              sourceId: userTurnId,
              timestamp: createdAt,
            }),
          );
        } else {
          throw new TypeError("Memory mutation is invalid");
        }
      }
      this.#database.exec("COMMIT");
      return {
        recorded: true,
        turns: 2,
        episodes: 1 + memoryResults.length,
        memory_results: memoryResults,
      };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  readSessionTurns(sessionId, { limit = 40 } = {}) {
    this.#assertOpen();
    const bounded = Math.max(1, Math.min(Number(limit) || 40, 100));
    return this.#database
      .prepare(`
        SELECT role, content, created_at
        FROM turns
        WHERE session_id = ?
        ORDER BY position DESC
        LIMIT ?
      `)
      .all(sessionId, bounded)
      .reverse()
      .map((turn) => ({
        role: turn.role,
        text: turn.content,
        created_at: turn.created_at,
      }));
  }

  prepareRemember({
    text,
    kind = "fact",
    horizon = "persistent",
    origin = "explicit_user",
    sourceSessionId,
  }) {
    this.#assertOpen();
    const content = cleanText(text, 2_000, "Memory");
    const normalizedContent = normalized(content);
    const existing = this.#database
      .prepare(`
        SELECT *
        FROM memory_claims
        WHERE status = 'active' AND normalized_content = ?
      `)
      .get(normalizedContent);
    const timestamp = isoTimestamp(this.#clock);
    const memoryId = existing?.memory_id ?? randomUUID();
    const cleanedKind = cleanKind(kind);
    const cleanedHorizon = cleanHorizon(horizon);
    const mutation = Object.freeze({
      type: "remember",
      memoryId,
      episodeId: randomUUID(),
      kind: cleanedKind,
      horizon: cleanedHorizon,
      content,
      normalizedContent,
      origin: cleanText(origin, 64, "Memory origin"),
      sourceSessionId: sourceSessionId ?? null,
    });
    const result = existing
      ? { ...publicMemory(existing), created: false }
      : {
          memory_id: memoryId,
          kind: cleanedKind,
          horizon: cleanedHorizon,
          text: content,
          created_at: timestamp,
          updated_at: timestamp,
          created: true,
        };
    return { mutation, result };
  }

  prepareForget(memoryId, { sourceSessionId } = {}) {
    this.#assertOpen();
    const cleanedId = cleanText(memoryId, 128, "Memory ID");
    const existing = this.#database
      .prepare(`
        SELECT memory_id FROM memory_claims
        WHERE memory_id = ? AND status = 'active'
      `)
      .get(cleanedId);
    return {
      mutation: existing
        ? Object.freeze({
            type: "forget",
            memoryId: cleanedId,
            episodeId: randomUUID(),
            sourceSessionId: sourceSessionId ?? null,
          })
        : null,
      result: { forgotten: existing !== undefined, memory_id: cleanedId },
    };
  }

  remember(input) {
    this.#assertOpen();
    const prepared = this.prepareRemember(input);
    const timestamp = isoTimestamp(this.#clock);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.#applyPreparedRemember(prepared.mutation, {
        timestamp,
      });
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  forget(memoryId, options = {}) {
    this.#assertOpen();
    const prepared = this.prepareForget(memoryId, options);
    if (!prepared.mutation) return prepared.result;
    const timestamp = isoTimestamp(this.#clock);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.#applyPreparedForget(prepared.mutation, {
        timestamp,
      });
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  recordEpisode(input) {
    this.#assertOpen();
    const timestamp = isoTimestamp(this.#clock);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#insertEpisode({ ...input, timestamp });
      this.#database.exec("COMMIT");
      return publicEpisode(row);
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  pendingReflectionEpisodes({ limit = 24, now = this.#clock() } = {}) {
    this.#assertOpen();
    const bounded = Math.max(1, Math.min(Number(limit) || 24, 24));
    const nowTimestamp = cleanTimestamp(now, "Memory reflection time");
    return this.#database
      .prepare(`
        SELECT *
        FROM episodes
        WHERE status = 'active'
          AND promotion_state = 'none'
          AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY occurred_at ASC, episode_id ASC
        LIMIT ?
      `)
      .all(nowTimestamp, bounded)
      .map(reflectionEpisode);
  }

  beginReflection({
    trigger = "manual",
    workerVersion = "memory-agent/1",
    provider,
    model,
    limit = 24,
    leaseMs = 10 * 60 * 1_000,
  }) {
    this.#assertOpen();
    const triggerKind = cleanReflectionTrigger(trigger);
    const cleanedWorkerVersion = cleanText(
      workerVersion,
      64,
      "Memory worker version",
    );
    const cleanedProvider = cleanText(provider, 128, "Memory worker provider");
    const cleanedModel = cleanText(model, 256, "Memory worker model");
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 24, 24));
    const boundedLeaseMs = Math.max(
      30_000,
      Math.min(Number(leaseMs) || 10 * 60 * 1_000, 60 * 60 * 1_000),
    );
    const startedAt = isoTimestamp(this.#clock);
    const leaseExpiresAt = new Date(
      Date.parse(startedAt) + boundedLeaseMs,
    ).toISOString();

    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const active = this.#database
        .prepare(`
          SELECT *
          FROM reflection_runs
          WHERE status = 'started'
          LIMIT 1
        `)
        .get();
      if (active && active.lease_expires_at > startedAt) {
        this.#database.exec("COMMIT");
        return { state: "busy", active_run: publicReflectionRun(active) };
      }
      if (active) {
        this.#database
          .prepare(`
            UPDATE reflection_runs
            SET status = 'failed', error_code = 'lease_expired', completed_at = ?
            WHERE run_id = ? AND status = 'started'
          `)
          .run(startedAt, active.run_id);
      }
      const episodes = this.#database
        .prepare(`
          SELECT *
          FROM episodes
          WHERE status = 'active'
            AND promotion_state = 'none'
            AND (expires_at IS NULL OR expires_at > ?)
          ORDER BY occurred_at ASC, episode_id ASC
          LIMIT ?
        `)
        .all(startedAt, boundedLimit);
      if (episodes.length === 0) {
        this.#database.exec("COMMIT");
        return { state: "no_work", episodes: [] };
      }
      const runId = randomUUID();
      const leaseToken = randomUUID();
      this.#database
        .prepare(`
          INSERT INTO reflection_runs(
            run_id,
            trigger_kind,
            worker_version,
            provider,
            model,
            status,
            episode_ids_json,
            lease_token,
            lease_expires_at,
            started_at
          ) VALUES (?, ?, ?, ?, ?, 'started', ?, ?, ?, ?)
        `)
        .run(
          runId,
          triggerKind,
          cleanedWorkerVersion,
          cleanedProvider,
          cleanedModel,
          JSON.stringify(episodes.map((episode) => episode.episode_id)),
          leaseToken,
          leaseExpiresAt,
          startedAt,
        );
      this.#database.exec("COMMIT");
      return {
        state: "started",
        run_id: runId,
        lease_token: leaseToken,
        episodes: episodes.map(reflectionEpisode),
        active_memories: this.listMemories({ limit: 12 }),
      };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  completeReflection({
    runId,
    leaseToken,
    proposals,
    dryRun = false,
  }) {
    this.#assertOpen();
    const cleanedRunId = cleanText(runId, 128, "Memory reflection run ID");
    const cleanedLeaseToken = cleanText(
      leaseToken,
      128,
      "Memory reflection lease token",
    );
    const snapshot = this.#database
      .prepare(`
        SELECT *
        FROM reflection_runs
        WHERE run_id = ? AND status = 'started' AND lease_token = ?
      `)
      .get(cleanedRunId, cleanedLeaseToken);
    if (!snapshot) throw new Error("Memory reflection run is not active");
    const episodeIds = JSON.parse(snapshot.episode_ids_json);
    const normalizedProposals = normalizeReflectionProposals(
      proposals,
      episodeIds,
    );
    const completedAt = isoTimestamp(this.#clock);
    const counts = {
      proposals: normalizedProposals.length,
      promoted_memories: 0,
      created_memories: 0,
      candidate_episodes: 0,
      ignored_episodes: 0,
    };

    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const active = this.#database
        .prepare(`
          SELECT run_id
          FROM reflection_runs
          WHERE run_id = ?
            AND status = 'started'
            AND lease_token = ?
            AND lease_expires_at > ?
        `)
        .get(cleanedRunId, cleanedLeaseToken, completedAt);
      if (!active) throw new Error("Memory reflection lease was lost");
      const eligibleEpisodes = this.#database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM episodes
          WHERE episode_id IN (${episodeIds.map(() => "?").join(", ")})
            AND status = 'active'
            AND promotion_state = 'none'
            AND (expires_at IS NULL OR expires_at > ?)
        `)
        .get(...episodeIds, completedAt).count;
      if (eligibleEpisodes !== episodeIds.length) {
        throw new Error("Memory reflection episode checkpoint expired or changed");
      }
      if (dryRun) this.#database.exec("SAVEPOINT reflection_preview");
      const updateEpisode = this.#database.prepare(`
        UPDATE episodes
        SET promotion_state = ?
        WHERE episode_id = ? AND status = 'active' AND promotion_state = 'none'
      `);
      for (const proposal of normalizedProposals) {
        let nextState = "candidate";
        if (proposal.action === "ignore") {
          nextState = "rejected";
          counts.ignored_episodes += proposal.episode_ids.length;
        } else if (
          proposal.action === "candidate_memory" &&
          proposal.assertion_mode === "explicit" &&
          proposal.confidence >= 0.9
        ) {
          const promoted = this.#applyReflectionMemoryProposal(
            proposal,
            completedAt,
          );
          if (
            promoted.blocked_by_conflict ||
            promoted.blocked_by_expiry ||
            promoted.blocked_by_retraction
          ) {
            nextState = "candidate";
            counts.candidate_episodes += proposal.episode_ids.length;
          } else {
            nextState = "promoted";
            counts.promoted_memories += 1;
            if (promoted.created) counts.created_memories += 1;
          }
        } else {
          counts.candidate_episodes += proposal.episode_ids.length;
        }
        for (const episodeId of proposal.episode_ids) {
          const result = updateEpisode.run(nextState, episodeId);
          if (result.changes !== 1) {
            throw new Error("Memory reflection episode checkpoint changed");
          }
        }
      }
      if (dryRun) {
        this.#database.exec("ROLLBACK TO reflection_preview");
        this.#database.exec("RELEASE reflection_preview");
      }
      this.#database
        .prepare(`
          UPDATE reflection_runs
          SET status = ?, proposals_json = ?, counts_json = ?, completed_at = ?
          WHERE run_id = ? AND status = 'started' AND lease_token = ?
        `)
        .run(
          dryRun ? "dry_run" : "completed",
          JSON.stringify(normalizedProposals),
          JSON.stringify(counts),
          completedAt,
          cleanedRunId,
          cleanedLeaseToken,
        );
      this.#database.exec("COMMIT");
      return {
        state: dryRun ? "dry_run" : "completed",
        run_id: cleanedRunId,
        counts,
        proposals: normalizedProposals,
      };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  failReflection(runId, leaseToken, errorCode = "reflection_failed") {
    this.#assertOpen();
    const cleanedRunId = cleanText(runId, 128, "Memory reflection run ID");
    const cleanedLeaseToken = cleanText(
      leaseToken,
      128,
      "Memory reflection lease token",
    );
    const cleanedErrorCode = /^[a-z0-9_]{1,64}$/u.test(errorCode)
      ? errorCode
      : "reflection_failed";
    const completedAt = isoTimestamp(this.#clock);
    const result = this.#database
      .prepare(`
        UPDATE reflection_runs
        SET status = 'failed', error_code = ?, completed_at = ?
        WHERE run_id = ? AND status = 'started' AND lease_token = ?
      `)
      .run(
        cleanedErrorCode,
        completedAt,
        cleanedRunId,
        cleanedLeaseToken,
      );
    return { failed: result.changes === 1, run_id: cleanedRunId };
  }

  reflectionStatus({ now = this.#clock() } = {}) {
    this.#assertOpen();
    const nowTimestamp = cleanTimestamp(now, "Memory reflection status time");
    const pending = this.#database
      .prepare(`
        SELECT COUNT(*) AS count
        FROM episodes
        WHERE status = 'active'
          AND promotion_state = 'none'
          AND (expires_at IS NULL OR expires_at > ?)
      `)
      .get(nowTimestamp).count;
    const candidates = this.#database
      .prepare(`
        SELECT COUNT(*) AS count
        FROM episodes
        WHERE status = 'active' AND promotion_state = 'candidate'
      `)
      .get().count;
    const latest = this.#database
      .prepare(`
        SELECT *
        FROM reflection_runs
        ORDER BY started_at DESC, run_id DESC
        LIMIT 1
      `)
      .get();
    const state =
      latest?.status === "started"
        ? latest.lease_expires_at > nowTimestamp
          ? "running"
          : "stale"
        : latest?.status === "failed"
          ? "degraded"
          : "ready";
    return {
      state,
      pending_episodes: pending,
      candidate_episodes: candidates,
      last_run: publicReflectionRun(latest),
    };
  }

  listMemories({ limit = 12, query } = {}) {
    this.#assertOpen();
    const bounded = Math.max(1, Math.min(Number(limit) || 12, 50));
    const rows = this.#database
      .prepare(`
        SELECT *
        FROM memory_claims
        WHERE status = 'active'
        ORDER BY updated_at DESC, memory_id ASC
        LIMIT 256
      `)
      .all();
    const terms = queryTerms(query);
    const ranked = rows
      .map((row) => ({ row, score: relevanceScore(row, terms) }))
      .filter(({ score }) => terms.length === 0 || score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.row.updated_at.localeCompare(left.row.updated_at),
      );
    const evidence = this.#database.prepare(`
      SELECT episode_id
      FROM claim_episode_refs
      WHERE memory_id = ?
      ORDER BY created_at DESC
      LIMIT 8
    `);
    return ranked.slice(0, bounded).map(({ row }) => ({
      ...publicMemory(row),
      evidence_episode_ids: evidence
        .all(row.memory_id)
        .map((reference) => reference.episode_id),
    }));
  }

  recentEpisodes({
    query,
    excludeSessionId,
    limit = 12,
    now = this.#clock(),
  } = {}) {
    this.#assertOpen();
    const bounded = Math.max(1, Math.min(Number(limit) || 12, 50));
    const nowTimestamp = cleanTimestamp(now, "Episode recall time");
    const rows = this.#database
      .prepare(`
        SELECT *
        FROM episodes
        WHERE status = 'active'
          AND (expires_at IS NULL OR expires_at > ?)
          AND (session_id IS NULL OR session_id != COALESCE(?, ''))
        ORDER BY occurred_at DESC, episode_id ASC
        LIMIT 256
      `)
      .all(nowTimestamp, excludeSessionId ?? null);
    const terms = queryTerms(query);
    return rows
      .map((row) => ({
        row,
        score: relevanceScore({ content: row.summary }, terms),
      }))
      .filter(
        ({ score }) => terms.length === 0 || score > 0,
      )
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.row.importance - left.row.importance ||
          right.row.occurred_at.localeCompare(left.row.occurred_at),
      )
      .slice(0, bounded)
      .map(({ row }) => publicEpisode(row));
  }

  recentSessions({ excludeSessionId, limit = 2, turnsPerSession = 4 } = {}) {
    this.#assertOpen();
    const boundedSessions = Math.max(1, Math.min(Number(limit) || 2, 5));
    const boundedTurns = Math.max(
      1,
      Math.min(Number(turnsPerSession) || 4, 10),
    );
    const sessions = this.#database
      .prepare(`
        SELECT s.session_id, s.started_at, s.ended_at
        FROM sessions s
        WHERE s.session_id != COALESCE(?, '')
          AND EXISTS (SELECT 1 FROM turns t WHERE t.session_id = s.session_id)
        ORDER BY COALESCE(s.ended_at, s.started_at) DESC
        LIMIT ?
      `)
      .all(excludeSessionId ?? null, boundedSessions);
    const readTurns = this.#database.prepare(`
      SELECT role, content, created_at
      FROM turns
      WHERE session_id = ?
      ORDER BY position DESC
      LIMIT ?
    `);
    return sessions.map((session) => ({
      session_id: session.session_id,
      started_at: session.started_at,
      ended_at: session.ended_at,
      turns: readTurns
        .all(session.session_id, boundedTurns)
        .reverse()
        .map((turn) => ({
          role: turn.role,
          text: turn.content,
          created_at: turn.created_at,
        })),
    }));
  }

  context({ query, currentSessionId } = {}) {
    this.#assertOpen();
    const durableMemories = this.listMemories({ limit: 12 })
      .filter((memory) => memory.kind !== "fact")
      .slice(0, 6);
    const durableIds = new Set(
      durableMemories.map((memory) => memory.memory_id),
    );
    return {
      durable_memories: durableMemories,
      relevant_memories: this.listMemories({ limit: 8, query }).filter(
        (memory) => !durableIds.has(memory.memory_id),
      ),
      recent_episodes: this.recentEpisodes({
        query,
        excludeSessionId: currentSessionId,
        limit: 10,
      }),
      recent_sessions: this.recentSessions({
        excludeSessionId: currentSessionId,
        limit: 2,
        turnsPerSession: 6,
      }),
    };
  }

  status() {
    this.#assertOpen();
    const sessions = this.#database
      .prepare("SELECT COUNT(*) AS count FROM sessions")
      .get().count;
    const turns = this.#database
      .prepare("SELECT COUNT(*) AS count FROM turns")
      .get().count;
    const memories = this.#database
      .prepare(
        "SELECT COUNT(*) AS count FROM memory_claims WHERE status = 'active'",
      )
      .get().count;
    const episodes = this.#database
      .prepare(
        "SELECT COUNT(*) AS count FROM episodes WHERE status = 'active'",
      )
      .get().count;
    return {
      state: "ready",
      sessions,
      turns,
      episodes,
      active_memories: memories,
    };
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#database.close();
  }
}

export async function openLocalMemoryStore({
  databasePath = defaultMoondogMemoryPath,
  clock,
} = {}) {
  const parent = path.dirname(path.resolve(databasePath));
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(parent, 0o700);

  const DatabaseSync = await databaseConstructor();
  const database = new DatabaseSync(path.resolve(databasePath));
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA trusted_schema = OFF");
    const currentVersion = database.prepare("PRAGMA user_version").get()
      .user_version;
    if (![0, 1, MOONDOG_MEMORY_SCHEMA_VERSION].includes(currentVersion)) {
      throw new Error("Memory database schema is incompatible");
    }
    database.exec(schema);
    if (currentVersion < MOONDOG_MEMORY_SCHEMA_VERSION) {
      database.exec(`PRAGMA user_version = ${MOONDOG_MEMORY_SCHEMA_VERSION}`);
    }
    if (process.platform !== "win32") {
      await chmod(path.resolve(databasePath), 0o600);
    }
    return new LocalMemoryStore(database, { clock });
  } catch (error) {
    database.close();
    throw error;
  }
}
