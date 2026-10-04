import { createHash } from "node:crypto";

export const LISTENER_PROFILE_ANALYSIS_VERSION = "listener-profile/1";
export const PROFILE_DIGEST_ROWS = 24;

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort()
    .filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function profileDigest(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function text(value, maximum, field) {
  if (typeof value !== "string" || !value.trim() || Array.from(value).length > maximum ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value)) {
    throw new TypeError(`Listener profile ${field} is invalid`);
  }
  return value.trim();
}

export function createListenerProfileInput({ subjectId, evidenceRevision, listening, apple }) {
  const sections = { ...listening?.sections, ...apple?.sections };
  const context = listening?.context ?? {};
  const constraints = profileDigest([sections.listener_preferences ?? [], sections.listener_avoids ?? []]);
  const partitions = [];
  const evidence = new Map();
  for (const [section, rows] of Object.entries(sections).sort(([a], [b]) => a.localeCompare(b))) {
    const entries = rows.map(row => {
      const reference_id = `ev_${profileDigest([section, row]).slice(0, 32)}`;
      const entry = { reference_id, section, data: structuredClone(row) };
      evidence.set(reference_id, entry);
      return entry;
    });
    for (let offset = 0; offset < entries.length; offset += PROFILE_DIGEST_ROWS) {
      const items = entries.slice(offset, offset + PROFILE_DIGEST_ROWS);
      // A changed direct choice invalidates interpretations even where historical
      // counts stay the same. Identical partitions on the same context can resume.
      const partition_id = `part_${profileDigest([LISTENER_PROFILE_ANALYSIS_VERSION, section, items, context, constraints]).slice(0, 32)}`;
      partitions.push({ partition_id, section, offset, total: entries.length, items });
    }
  }
  const manifest = {
    analysis_version: LISTENER_PROFILE_ANALYSIS_VERSION,
    coverage: { ...listening?.coverage, ...apple?.coverage },
    sources: listening?.sources ?? [], context,
    sections: Object.entries(sections).map(([section, rows]) => ({ section, rows: rows.length })),
    digest_partitions: partitions.length,
    digest_rows: [...evidence.values()].length,
    limitations: [
      "All supported records contribute to local analysis before digest pages are selected. Digest rows are aggregates or observations, not a count of distinct plays.",
      "History measures attention. Apple snapshot counts are separate from dated plays; private-session plays and superseded overlaps do not become behavioral evidence.",
      "Reviewed partitions record what was examined during synthesis, not proof that every interpretation is correct. Provider labels are not listener assertions or measured audio features.",
    ],
  };
  const input_digest = profileDigest({ subjectId, evidenceRevision, manifest, partitions });
  return { subjectId, input_digest, manifest, partitions, evidence };
}

export function modelEvidence(entry, offset = 0) {
  // Only music observations cross the model boundary. Local identities and
  // provider handles remain in the private frozen evidence snapshot.
  const fields = new Set([
    "name", "label", "title", "artist_credit", "release", "genre", "entity_type", "stance", "asserted_at",
    "first_played_at", "last_played_at", "source_label", "identity_status", "evidence_kind", "period",
    "text", "playlist_name", "unit", "observed_at", "last_added_at", "play_count", "engaged_play_count",
    "explicit_skips", "listening_minutes", "distinct_tracks", "year", "event_count", "first_observed_tracks",
    "playlist_count", "library_tracks", "preferred_tracks", "tracks_with_play_count", "preference_strength",
    "loved", "favorited", "rating_value", "rating_computed", "rank", "playlist_position", "value",
    "stream_count", "played_seconds", "playlist_names", "top_artist", "first_year", "last_year", "active_years",
  ]);
  const data = Object.fromEntries(Object.entries(entry.data).filter(([key]) => fields.has(key)));
  if (data.top_artist) data.top_artist = Object.fromEntries(Object.entries(data.top_artist)
    .filter(([key]) => ["name", "play_count", "listening_minutes"].includes(key)));
  const continuations = {};
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value)) {
      data[key] = value.slice(offset, offset + 12);
      if (value.length > offset + 12) continuations[key] = { total: value.length, next_offset: offset + 12 };
    }
  }
  return { ...entry, data, ...(Object.keys(continuations).length ? { continuations } : {}) };
}

export function validateProfileReview(input, partitionId, value) {
  const partition = input.partitions.find(part => part.partition_id === partitionId);
  if (!partition || !value || !Array.isArray(value.claims) || value.claims.length > 6) {
    throw new TypeError("Listener profile partition review is invalid");
  }
  const own = new Set(partition.items.map(item => item.reference_id));
  const references = (raw, minimum) => {
    if (!Array.isArray(raw) || raw.length < minimum || raw.length > 8 || new Set(raw).size !== raw.length ||
        raw.some(id => !input.evidence.has(id))) throw new TypeError("Listener profile evidence reference is invalid");
    return [...raw];
  };
  const claims = value.claims.map(raw => {
    if (!["observation", "hypothesis"].includes(raw?.kind)) {
      throw new TypeError("Only the listener can establish a direct preference");
    }
    const supporting_refs = references(raw.supporting_refs, 1);
    if (!supporting_refs.some(id => own.has(id))) throw new TypeError("A finding must cite its reviewed partition");
    const contradicting_refs = references(raw.contradicting_refs ?? [], 0);
    if (contradicting_refs.some(id => supporting_refs.includes(id))) throw new TypeError("Supporting and conflicting evidence must differ");
    const claim = {
      kind: raw.kind,
      statement: text(raw.statement, 700, "statement"),
      scope: text(raw.scope, 300, "scope"),
      uncertainty: text(raw.uncertainty, 500, "uncertainty"),
      supporting_refs, contradicting_refs,
    };
    return { claim_id: `claim_${profileDigest(claim).slice(0, 32)}`, ...claim };
  });
  return { partition_id: partitionId, note: text(value.note, 700, "review note"), claims };
}

export function directAssertionReview(partition) {
  if (!["listener_preferences", "listener_avoids"].includes(partition.section)) return null;
  const stance = partition.section === "listener_avoids" ? "avoid" : "like";
  return {
    partition_id: partition.partition_id,
    note: "Direct choices and source exclusions are retained separately from inferred taste.",
    claims: partition.items.map(({ reference_id, data }) => {
      const direct = Boolean(data.correction_id);
      const claim = {
        kind: direct ? "listener_assertion" : "observation",
        statement: `${data.label ?? data.name}${data.artist_credit ? ` by ${data.artist_credit}` : ""}: ${stance === "avoid" ? "keep out of suggestions" : "explicit positive choice"}.`,
        scope: data.entity_type ?? "listener choice",
        uncertainty: direct ? "An explicit listener choice; it does not rewrite past listening."
          : "An exclusion or choice in imported source data; it is not a new statement by the listener.",
        stance, supporting_refs: [reference_id], contradicting_refs: [],
      };
      return { claim_id: `claim_${profileDigest(claim).slice(0, 32)}`, ...claim };
    }),
  };
}

export function compileListenerProfile(input, reviews, submission) {
  if (input.partitions.some(part => !reviews[part.partition_id])) {
    throw new Error("Review every digest partition before saving the profile");
  }
  const claims = [...new Map(Object.values(reviews).flatMap(review => review.claims)
    .map(claim => [claim.claim_id, claim])).values()];
  const known = new Set(claims.map(claim => claim.claim_id));
  const highlights = submission?.highlight_claim_ids;
  if (!Array.isArray(highlights) || highlights.length > 12 || new Set(highlights).size !== highlights.length ||
      highlights.some(id => !known.has(id)) || (claims.length > 0 && highlights.length === 0)) {
    throw new TypeError("Listener profile highlights must cite saved findings");
  }
  const referenced = new Set(claims.flatMap(claim => [...claim.supporting_refs, ...claim.contradicting_refs]));
  return {
    analysis_version: LISTENER_PROFILE_ANALYSIS_VERSION,
    input_digest: input.input_digest,
    summary: text(submission.summary, 1_600, "summary"),
    coverage: { ...input.manifest, reviewed_partitions: input.partitions.length },
    claims, highlight_claim_ids: [...highlights],
    evidence: Object.fromEntries([...referenced].map(id => [id, input.evidence.get(id)])),
  };
}

export function readListenerProfile({ input, store }, { offset = 0, limit = 12, claimId, revisionId } = {}) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw new TypeError("Saved profile page is invalid");
  }
  const current = store.current();
  const revision = revisionId ? store.revision(revisionId) : current;
  if (revisionId && !revision) throw new Error("That saved profile version is unavailable");
  if (!revision) return { state: "missing", total_claims: 0, claims: [], next_offset: null };
  const state = revision.input_digest === input.input_digest ? "current" : "stale";
  const result = {
    state, revision_id: revision.revision_id, sequence: revision.sequence,
    parent_revision_id: revision.parent_revision_id, built_at: revision.built_at, model: revision.model,
    summary: revision.summary, coverage: revision.coverage,
    total_claims: revision.claims.length,
    claims: revision.claims.slice(offset, offset + limit), offset,
    next_offset: offset + limit < revision.claims.length ? offset + limit : null,
    highlights: revision.highlight_claim_ids.map(id => revision.claims.find(claim => claim.claim_id === id)),
  };
  if (claimId !== undefined) {
    const claim = revision.claims.find(item => item.claim_id === claimId);
    if (!claim) throw new Error("That finding is not part of this saved profile");
    result.claim = claim;
    result.supporting_evidence = claim.supporting_refs.map(ref => modelEvidence(revision.evidence[ref]));
    result.contradicting_evidence = claim.contradicting_refs.map(ref => modelEvidence(revision.evidence[ref]));
  }
  return result;
}

export function compactListenerProfile(value) {
  if (!value || value.state === "missing") return { state: "missing" };
  return {
    state: value.state, revision_id: value.revision_id, sequence: value.sequence, built_at: value.built_at,
    ...(value.state === "current" ? {
      summary: value.summary,
      claims: value.highlights,
      coverage: { digest_partitions: value.coverage.digest_partitions,
        reviewed_partitions: value.coverage.reviewed_partitions },
    } : { message: "New source evidence or listener choices require an updated reading. Do not use the previous interpretation as current taste." }),
  };
}
