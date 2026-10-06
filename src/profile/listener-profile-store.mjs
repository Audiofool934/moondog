import { randomUUID } from "node:crypto";
import { directAssertionReview, profileDigest } from "./listener-profile-build.mjs";

export const listenerProfileSchema = `
  CREATE TABLE IF NOT EXISTS listener_profile_builds (
    build_id TEXT PRIMARY KEY NOT NULL, subject_id TEXT NOT NULL,
    input_digest TEXT NOT NULL, model_key TEXT NOT NULL,
    lease_token TEXT NOT NULL, state TEXT NOT NULL, record_json TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS listener_profile_build_input
    ON listener_profile_builds(subject_id, input_digest, model_key);
  CREATE TABLE IF NOT EXISTS listener_profile_partitions (
    build_id TEXT NOT NULL, partition_id TEXT NOT NULL,
    review_json TEXT NOT NULL,
    PRIMARY KEY (build_id, partition_id),
    FOREIGN KEY (build_id) REFERENCES listener_profile_builds(build_id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS listener_profile_partition_cache ON listener_profile_partitions(partition_id);
  CREATE TABLE IF NOT EXISTS listener_profile_revisions (
    revision_id TEXT PRIMARY KEY NOT NULL, subject_id TEXT NOT NULL,
    sequence INTEGER NOT NULL, input_digest TEXT NOT NULL, record_json TEXT NOT NULL,
    UNIQUE (subject_id, sequence)
  ) STRICT;
`;

export class ListenerProfileStore {
  constructor(database, subjectId) {
    this.database = database;
    this.subjectId = subjectId;
  }

  current() {
    const row = this.database.prepare(`SELECT record_json FROM listener_profile_revisions
      WHERE subject_id = ? ORDER BY sequence DESC LIMIT 1`).get(this.subjectId);
    return row ? JSON.parse(row.record_json) : null;
  }

  revision(id) {
    const row = this.database.prepare(`SELECT record_json FROM listener_profile_revisions
      WHERE subject_id = ? AND revision_id = ?`).get(this.subjectId, id);
    return row ? JSON.parse(row.record_json) : null;
  }

  reviews(buildId) {
    return Object.fromEntries(this.database.prepare(`SELECT partition_id, review_json
      FROM listener_profile_partitions WHERE build_id = ?`).all(buildId)
      .map(row => [row.partition_id, JSON.parse(row.review_json)]));
  }

  begin(input, model, { force = false } = {}) {
    const modelKey = profileDigest(model);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = force ? null : this.database.prepare(`SELECT record_json FROM listener_profile_builds
        WHERE subject_id = ? AND input_digest = ? AND model_key = ? AND state <> 'complete'
        ORDER BY rowid DESC LIMIT 1`).get(this.subjectId, input.input_digest, modelKey);
      const build = existing ? JSON.parse(existing.record_json) : {
        build_id: randomUUID(), input_digest: input.input_digest, model,
        parent_revision_id: this.current()?.revision_id ?? null,
        started_at: new Date().toISOString(), manifest: input.manifest,
      };
      build.lease_token = randomUUID();
      this.database.prepare(`INSERT INTO listener_profile_builds
        (build_id, subject_id, input_digest, model_key, lease_token, state, record_json)
        VALUES (?, ?, ?, ?, ?, 'building', ?) ON CONFLICT(build_id) DO UPDATE
        SET lease_token = excluded.lease_token, state = 'building', record_json = excluded.record_json`)
        .run(build.build_id, this.subjectId, input.input_digest, modelKey, build.lease_token, JSON.stringify(build));
      let reused = 0;
      const present = this.reviews(build.build_id);
      for (const partition of input.partitions) {
        if (present[partition.partition_id]) { reused++; continue; }
        const direct = directAssertionReview(partition);
        const cached = direct || force ? null : this.database.prepare(`SELECT p.review_json FROM listener_profile_partitions p
          JOIN listener_profile_builds b ON b.build_id = p.build_id
          WHERE b.subject_id = ? AND b.model_key = ? AND p.partition_id = ? ORDER BY b.rowid DESC LIMIT 1`)
          .get(this.subjectId, modelKey, partition.partition_id);
        const review = direct ?? (cached ? JSON.parse(cached.review_json) : null);
        if (review && review.claims.every(claim => [...claim.supporting_refs, ...claim.contradicting_refs]
          .every(ref => input.evidence.has(ref)))) {
          this.#writeReview(build.build_id, partition.partition_id, review);
          if (!direct) reused++;
        }
      }
      this.database.exec("COMMIT");
      return { ...build, reused_partitions: reused, reviews: this.reviews(build.build_id) };
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  #assertLease(build) {
    const row = this.database.prepare(`SELECT lease_token, state FROM listener_profile_builds
      WHERE subject_id = ? AND build_id = ?`).get(this.subjectId, build.build_id);
    if (row?.lease_token !== build.lease_token || row.state !== "building") {
      throw new Error("Another profile build has taken over; continue from its saved progress");
    }
  }

  #writeReview(buildId, partitionId, review) {
    this.database.prepare(`INSERT INTO listener_profile_partitions (build_id, partition_id, review_json)
      VALUES (?, ?, ?) ON CONFLICT(build_id, partition_id) DO UPDATE SET review_json = excluded.review_json`)
      .run(buildId, partitionId, JSON.stringify(review));
  }

  checkpoint(build, review) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.#assertLease(build);
      this.#writeReview(build.build_id, review.partition_id, review);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  checkpointFinalization(build, finalization) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.#assertLease(build);
      const row = this.database.prepare("SELECT record_json FROM listener_profile_builds WHERE build_id = ?")
        .get(build.build_id);
      const record = { ...JSON.parse(row.record_json), finalization };
      this.database.prepare("UPDATE listener_profile_builds SET record_json = ? WHERE build_id = ?")
        .run(JSON.stringify(record), build.build_id);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  interrupt(build) {
    this.database.prepare(`UPDATE listener_profile_builds SET state = 'interrupted'
      WHERE subject_id = ? AND build_id = ? AND lease_token = ? AND state = 'building'`)
      .run(this.subjectId, build.build_id, build.lease_token);
  }

  complete(build, profile, assertCurrentInput = () => {}) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.#assertLease(build);
      assertCurrentInput();
      const previous = this.current();
      if ((previous?.revision_id ?? null) !== build.parent_revision_id) {
        throw new Error("The current profile changed during this build; start again from the new version");
      }
      const revision = {
        ...profile, revision_id: randomUUID(), sequence: (previous?.sequence ?? 0) + 1,
        parent_revision_id: previous?.revision_id ?? null, built_at: new Date().toISOString(), model: build.model,
      };
      this.database.prepare(`INSERT INTO listener_profile_revisions
        (revision_id, subject_id, sequence, input_digest, record_json) VALUES (?, ?, ?, ?, ?)`)
        .run(revision.revision_id, this.subjectId, revision.sequence, revision.input_digest, JSON.stringify(revision));
      this.database.prepare("UPDATE listener_profile_builds SET state = 'complete' WHERE build_id = ?").run(build.build_id);
      this.database.exec("COMMIT");
      return revision;
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
}
