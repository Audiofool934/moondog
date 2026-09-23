import { createHash } from "node:crypto";
import { isUuid, uuidV5 } from "../core/uuid-v5.mjs";
import { MUSIC_PROVIDER_LABELS } from "./music-providers.mjs";

const namespace = "c9a85706-bf02-4f1d-b7e0-49e10d25a6be";
export const musicHash = (value) => createHash("sha256").update(value).digest("hex");
const id = (...parts) => uuidV5(JSON.stringify(parts), namespace);
export const musicText = (value) => typeof value === "string" ? Array.from(value.normalize("NFC")
  .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, " ")
  .replace(/\s+/gu, " ").trim()).slice(0, 512).join("") : "";

/** Shared normalized boundary. Collections never manufacture listening events. */
export function prepareMusicBundle({ provider, subjectId, capturedAt, rows, digest, size, members, skipped = 0, scopeNote, fileName }) {
  if (!MUSIC_PROVIDER_LABELS[provider] || !isUuid(subjectId)) throw new Error("Invalid music import identity.");
  subjectId = subjectId.toLowerCase();
  capturedAt = new Date(capturedAt).toISOString();
  const sourceKey = `${provider}.music_import`;
  const format = `${provider}_music_v1`;
  const batchId = id(provider, subjectId, digest, "batch");
  const profileId = id(provider, subjectId, digest, "profile");
  const tracks = new Map();
  const events = new Map();
  const evidence = new Map();
  for (const row of rows) {
    const title = musicText(row.title);
    const artist = musicText(row.artist);
    const album = musicText(row.album);
    if (!row.id || !title) { skipped += 1; continue; }
    const trackId = id(provider, "track", row.id);
    const track = {
      schema_version: 1, track_ref_id: trackId, revision: 1, identity_status: "provisional",
      display_label: musicText(artist ? `${title} - ${artist}` : title), title,
      ...(artist ? { artist_credits: [{ name: artist, role: "unknown" }] } : {}),
      ...(album ? { release: { title: album } } : {}),
      external_refs: [{ system: provider, entity_type: `${provider}.track`, external_id: String(row.id) }],
      created_at: capturedAt,
    };
    // Prefer supplied library metadata to a history record's video title.
    if (!tracks.has(trackId) || (artist && !tracks.get(trackId).artist_credits)) tracks.set(trackId, track);
    if (row.occurredAt) {
      const at = new Date(row.occurredAt).toISOString();
      const key = musicHash(JSON.stringify([provider, subjectId, row.id, at]));
      events.set(key, {
        schema_version: 1, listening_event_id: id(key, "event"), subject_id: subjectId,
        track_ref_id: trackId, track_ref_revision: 1, event_type: "play_observed",
        occurred_at: at, ingested_at: capturedAt, interaction_mode: "unknown", context: { context_type: "unknown" },
        provenance: { source_kind: "import", captured_at: capturedAt, import_batch_id: batchId,
          external_ref: { system: provider, entity_type: `${provider}.play`, external_id: key } },
        deduplication_key: key,
      });
    } else {
      const kind = row.playlistId ? "playlist_track_added" : "library_track_saved";
      const key = musicHash(JSON.stringify([provider, subjectId, kind, row.playlistId ?? "library", row.id]));
      evidence.set(key, {
        schema_version: 1, profile_evidence_id: id(profileId, key), evidence_key: key, subject_id: subjectId,
        evidence_kind: kind, direction: "supports", strength_class: row.playlistId ? "curated" : "explicit",
        entity: { entity_type: "track", entity_ref_id: trackId, track_ref_id: trackId, track_ref_revision: 1,
          label: title, ...(artist ? { artist_credit: artist } : {}), ...(album ? { release: album } : {}) },
        observed_at: capturedAt,
        attributes: row.playlistId ? { playlist_name: musicText(row.playlistName) || "Selected playlist",
          playlist_position: row.position ?? 1, playlist_id: String(row.playlistId), selected_public_playlist: true } : {},
        provenance: { source_kind: "import", source_system: provider, source_member: row.member,
          profile_import_id: profileId, captured_at: capturedAt },
      });
    }
  }
  if (!events.size && !evidence.size) throw new Error("No supported music records found. Choose a music library CSV, YouTube Music watch-history JSON, or a non-empty public playlist.");
  const dates = [...events.values()].map((event) => event.occurred_at).sort();
  const manifest = { subject_id: subjectId, source_format: format, archive_sha256: digest,
    archive_size_bytes: size, member_names: members, imported_at: capturedAt };
  return {
    provider,
    bundle: {
      source_key: sourceKey, captured_at: capturedAt, cursor_after_ms: null,
      track_refs: [...tracks.values()], listening_events: [...events.values()],
      import_batch: { ...manifest, import_batch_id: batchId, data_scope: "selected_music_records",
        input_records: events.size, earliest_occurred_at: dates[0] ?? null, latest_occurred_at: dates.at(-1) ?? null },
      ...(evidence.size ? {
        profile_import: { ...manifest, profile_import_id: profileId, source_key: sourceKey, input_records: evidence.size },
        profile_evidence: [...evidence.values()],
      } : {}),
    },
    preview: {
      kind: events.size ? "history" : "collection", sourceLabel: MUSIC_PROVIDER_LABELS[provider], fileName,
      tracks: tracks.size, listeningEvents: events.size, profileEvidence: evidence.size,
      skippedRecords: skipped, eventsWithPlayedMs: 0, earliestListeningAt: dates[0], latestListeningAt: dates.at(-1),
      sampleTracks: [...tracks.values()].slice(0, 3).map((track) => track.display_label),
      capturedAt, scopeNote,
    },
  };
}
