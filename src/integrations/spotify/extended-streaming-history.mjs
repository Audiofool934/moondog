import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { isUuid, uuidV5 } from "../../core/uuid-v5.mjs";
import {
  spotifyAccountDataEventIdentity,
} from "./account-data-history.mjs";
import { SPOTIFY_TRACK_NAMESPACE } from "./recent-activity.mjs";

export const SPOTIFY_EXTENDED_HISTORY_SOURCE =
  "spotify.extended_streaming_history.music";
export const SPOTIFY_EXTENDED_HISTORY_FORMAT =
  "spotify_extended_streaming_history_music_v1";
export const SPOTIFY_EXTENDED_HISTORY_SCOPE =
  "lifetime_extended_streaming_history";
export const SPOTIFY_EXTENDED_HISTORY_EVENT_NAMESPACE =
  "8ec283b4-13d8-50a4-bb3d-f67bb3f0d2c6";
export const SPOTIFY_EXTENDED_HISTORY_BATCH_NAMESPACE =
  "584a5465-d764-59e0-91d2-1be1e51beaef";

export const SPOTIFY_EXTENDED_HISTORY_LIMITS = Object.freeze({
  maximumArchiveBytes: 512 * 1024 * 1024,
  maximumHistoryMembers: 100,
  maximumMemberBytes: 64 * 1024 * 1024,
  maximumTotalJsonBytes: 256 * 1024 * 1024,
  maximumRecords: 500_000,
});

const execFileAsync = promisify(execFile);
const audioMemberPattern =
  /^Spotify Extended Streaming History\/Streaming_History_Audio_([0-9]{4})(?:_([0-9]+))?\.json$/u;
const trackUriPattern = /^spotify:track:([A-Za-z0-9]{22})$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const unsafeTextPattern =
  /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu;

export class SpotifyExtendedHistoryError extends Error {
  constructor(message, code = "spotify_extended_history_invalid") {
    super(message);
    this.name = "SpotifyExtendedHistoryError";
    this.code = code;
  }
}

function fail(message, code) {
  throw new SpotifyExtendedHistoryError(message, code);
}

function timestamp(value, label) {
  if (
    typeof value !== "string" ||
    !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z$/u.test(value)
  ) {
    fail(`${label} is invalid.`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) fail(`${label} is invalid.`);
  return new Date(milliseconds).toISOString();
}

function cleanText(value, maximum, label, index) {
  if (typeof value !== "string") {
    fail(`Spotify Extended History record ${index + 1} has an invalid ${label}.`);
  }
  const cleaned = value
    .normalize("NFC")
    .replace(unsafeTextPattern, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!cleaned || Array.from(cleaned).length > maximum) {
    fail(`Spotify Extended History record ${index + 1} has an invalid ${label}.`);
  }
  return cleaned;
}

function optionalText(value, maximum, label, index) {
  if (value === null || value === undefined) return null;
  return cleanText(value, maximum, label, index);
}

function nullableBoolean(value, label, index) {
  if (value === null || typeof value === "boolean") return value;
  fail(`Spotify Extended History record ${index + 1} has an invalid ${label}.`);
}

function hashParts(...parts) {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(String(part)).update("\0");
  return hash.digest("hex");
}

function clippedText(value, maximum = 512) {
  return Array.from(value).slice(0, maximum).join("");
}

function lexicalCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function standardOccurredAt(occurredAt) {
  return `${occurredAt.slice(0, 16)}:00.000Z`;
}

function normalizedMusicRows(records, capturedAt) {
  if (!Array.isArray(records)) {
    fail("Spotify Extended History records are invalid.");
  }
  if (records.length > SPOTIFY_EXTENDED_HISTORY_LIMITS.maximumRecords) {
    fail("Spotify Extended History contains too many records.");
  }
  const capturedMilliseconds = Date.parse(capturedAt);
  const rows = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      fail(`Spotify Extended History record ${index + 1} is invalid.`);
    }
    if (record.spotify_track_uri === null) continue;
    const uri = cleanText(
      record.spotify_track_uri,
      64,
      "spotify_track_uri",
      index,
    );
    const uriMatch = trackUriPattern.exec(uri);
    if (!uriMatch) {
      fail(
        `Spotify Extended History record ${index + 1} has an invalid spotify_track_uri.`,
      );
    }
    const occurredAt = timestamp(
      record.ts,
      `Spotify Extended History record ${index + 1} timestamp`,
    );
    if (Date.parse(occurredAt) > capturedMilliseconds) {
      fail(`Spotify Extended History record ${index + 1} is later than the import time.`);
    }
    if (!Number.isSafeInteger(record.ms_played) || record.ms_played < 0) {
      fail(`Spotify Extended History record ${index + 1} has an invalid ms_played.`);
    }
    const title = cleanText(
      record.master_metadata_track_name,
      512,
      "master_metadata_track_name",
      index,
    );
    const artist = cleanText(
      record.master_metadata_album_artist_name,
      512,
      "master_metadata_album_artist_name",
      index,
    );
    const album = optionalText(
      record.master_metadata_album_album_name,
      512,
      "master_metadata_album_album_name",
      index,
    );
    const reasonStart = optionalText(
      record.reason_start,
      128,
      "reason_start",
      index,
    );
    const reasonEnd = optionalText(
      record.reason_end,
      128,
      "reason_end",
      index,
    );
    const shuffle = nullableBoolean(record.shuffle, "shuffle", index);
    const skipped = nullableBoolean(record.skipped, "skipped", index);
    const offline = nullableBoolean(record.offline, "offline", index);
    const incognitoMode = nullableBoolean(
      record.incognito_mode,
      "incognito_mode",
      index,
    );
    const trackId = uriMatch[1];
    const tuple = [
      occurredAt,
      trackId,
      String(record.ms_played),
      reasonStart ?? "",
      reasonEnd ?? "",
      String(shuffle),
      String(skipped),
      String(offline),
      String(incognitoMode),
    ].join("\0");
    rows.push({
      occurredAt,
      playedMs: record.ms_played,
      title,
      artist,
      album,
      reasonStart,
      reasonEnd,
      shuffle,
      skipped,
      offline,
      incognitoMode,
      trackId,
      tuple,
    });
  }
  return rows.sort((left, right) => lexicalCompare(left.tuple, right.tuple));
}

function normalizedMemberNames(memberNames) {
  if (
    !Array.isArray(memberNames) ||
    memberNames.length < 1 ||
    memberNames.length > SPOTIFY_EXTENDED_HISTORY_LIMITS.maximumHistoryMembers
  ) {
    fail("Spotify Extended History member names are invalid.");
  }
  const normalized = memberNames.map((value) => {
    if (
      typeof value !== "string" ||
      !/^Streaming_History_Audio_[0-9]{4}(?:_[0-9]+)?\.json$/u.test(value)
    ) {
      fail("Spotify Extended History member names are invalid.");
    }
    return value;
  });
  if (new Set(normalized).size !== normalized.length) {
    fail("Spotify Extended History contains duplicate member names.");
  }
  return [...normalized].sort(lexicalCompare);
}

export function projectSpotifyExtendedStreamingHistory({
  subjectId,
  records,
  archiveSha256,
  archiveSizeBytes,
  memberNames,
  capturedAt = new Date().toISOString(),
} = {}) {
  if (!isUuid(subjectId)) fail("A trusted subject ID is required.");
  const normalizedSubjectId = subjectId.toLowerCase();
  const normalizedCapturedAt = timestamp(
    capturedAt,
    "Spotify Extended History import timestamp",
  );
  if (typeof archiveSha256 !== "string" || !sha256Pattern.test(archiveSha256)) {
    fail("Spotify Extended History archive SHA-256 is invalid.");
  }
  if (
    !Number.isSafeInteger(archiveSizeBytes) ||
    archiveSizeBytes < 1 ||
    archiveSizeBytes > SPOTIFY_EXTENDED_HISTORY_LIMITS.maximumArchiveBytes
  ) {
    fail("Spotify Extended History archive size is invalid.");
  }
  const normalizedMembers = normalizedMemberNames(memberNames);
  const rows = normalizedMusicRows(records, normalizedCapturedAt);
  const importBatchId = uuidV5(
    `${normalizedSubjectId}\0${archiveSha256}`,
    SPOTIFY_EXTENDED_HISTORY_BATCH_NAMESPACE,
  );
  const trackRefs = new Map();
  const listeningEvents = [];
  const reconciliationCandidates = [];
  const eventOrdinals = new Map();
  const standardOrdinals = new Map();

  for (const row of rows) {
    const trackRefId = uuidV5(row.trackId, SPOTIFY_TRACK_NAMESPACE);
    if (!trackRefs.has(trackRefId)) {
      const trackRef = {
        schema_version: 1,
        track_ref_id: trackRefId,
        revision: 1,
        identity_status: "resolved",
        display_label: clippedText(`${row.title} - ${row.artist}`),
        title: row.title,
        artist_credits: [{ name: row.artist, role: "unknown" }],
        external_refs: [
          {
            system: "spotify",
            entity_type: "spotify.track",
            external_id: row.trackId,
          },
        ],
        created_at: row.occurredAt,
        resolved_at: row.occurredAt,
      };
      if (row.album) trackRef.release = { title: row.album };
      trackRefs.set(trackRefId, trackRef);
    }

    const duplicateOrdinal = (eventOrdinals.get(row.tuple) ?? 0) + 1;
    eventOrdinals.set(row.tuple, duplicateOrdinal);
    const eventFingerprint = hashParts(
      "spotify-extended-history-play-v1",
      normalizedSubjectId,
      row.tuple,
      duplicateOrdinal,
    );
    const listeningEventId = uuidV5(
      eventFingerprint,
      SPOTIFY_EXTENDED_HISTORY_EVENT_NAMESPACE,
    );
    const extensions = {};
    if (row.reasonStart !== null) {
      extensions["spotify.reason_start"] = row.reasonStart;
    }
    if (row.reasonEnd !== null) {
      extensions["spotify.reason_end"] = row.reasonEnd;
    }
    if (row.shuffle !== null) extensions["spotify.shuffle"] = row.shuffle;
    if (row.skipped !== null) extensions["spotify.skipped"] = row.skipped;
    if (row.offline !== null) extensions["spotify.offline"] = row.offline;
    if (row.incognitoMode !== null) {
      extensions["spotify.incognito_mode"] = row.incognitoMode;
    }
    const event = {
      schema_version: 1,
      listening_event_id: listeningEventId,
      subject_id: normalizedSubjectId,
      track_ref_id: trackRefId,
      track_ref_revision: 1,
      event_type: row.skipped === true ? "play_skipped" : "play_observed",
      occurred_at: row.occurredAt,
      ingested_at: normalizedCapturedAt,
      interaction_mode: "unknown",
      played_ms: row.playedMs,
      context: { context_type: "unknown" },
      provenance: {
        source_kind: "import",
        captured_at: normalizedCapturedAt,
        external_ref: {
          system: "spotify-extended-history",
          entity_type: "spotify.extended_history.play",
          external_id: eventFingerprint,
        },
        import_batch_id: importBatchId,
      },
      deduplication_key: eventFingerprint,
    };
    if (Object.keys(extensions).length > 0) event.extensions = extensions;
    listeningEvents.push(event);

    const standardTime = standardOccurredAt(row.occurredAt);
    const standardTuple = [
      standardTime,
      row.artist.normalize("NFKC").toLowerCase(),
      row.title.normalize("NFKC").toLowerCase(),
      String(row.playedMs),
    ].join("\0");
    const standardOrdinal = (standardOrdinals.get(standardTuple) ?? 0) + 1;
    standardOrdinals.set(standardTuple, standardOrdinal);
    const standardIdentity = spotifyAccountDataEventIdentity({
      subjectId: normalizedSubjectId,
      occurredAt: standardTime,
      artist: row.artist,
      title: row.title,
      playedMs: row.playedMs,
      duplicateOrdinal: standardOrdinal,
    });
    reconciliationCandidates.push({
      superseding_event_id: listeningEventId,
      superseded_event_id: standardIdentity.listening_event_id,
    });
  }

  const earliestOccurredAt = rows[0]?.occurredAt ?? null;
  const latestOccurredAt = rows.at(-1)?.occurredAt ?? null;
  return {
    source_key: SPOTIFY_EXTENDED_HISTORY_SOURCE,
    captured_at: normalizedCapturedAt,
    cursor_after_ms:
      latestOccurredAt === null ? null : Date.parse(latestOccurredAt),
    track_refs: [...trackRefs.values()],
    listening_events: listeningEvents,
    reconciliation_candidates: reconciliationCandidates,
    import_batch: {
      import_batch_id: importBatchId,
      subject_id: normalizedSubjectId,
      source_format: SPOTIFY_EXTENDED_HISTORY_FORMAT,
      data_scope: SPOTIFY_EXTENDED_HISTORY_SCOPE,
      archive_sha256: archiveSha256,
      archive_size_bytes: archiveSizeBytes,
      member_names: normalizedMembers,
      input_records: rows.length,
      earliest_occurred_at: earliestOccurredAt,
      latest_occurred_at: latestOccurredAt,
      imported_at: normalizedCapturedAt,
    },
  };
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function unzip(args, maximumBytes) {
  try {
    const { stdout } = await execFileAsync("/usr/bin/unzip", args, {
      encoding: "utf8",
      maxBuffer: maximumBytes,
      windowsHide: true,
    });
    return stdout;
  } catch {
    fail(
      "The Spotify Extended History ZIP could not be read safely.",
      "spotify_extended_history_archive_unreadable",
    );
  }
}

function selectedAudioMembers(listing) {
  const selected = listing
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((name) => {
      const match = audioMemberPattern.exec(name);
      return match
        ? {
            name,
            year: Number(match[1]),
            segment: match[2] === undefined ? 0 : Number(match[2]) + 1,
          }
        : null;
    })
    .filter(Boolean)
    .sort((left, right) =>
      left.year === right.year
        ? left.segment - right.segment
        : left.year - right.year,
    );
  if (selected.length < 1) {
    fail("The ZIP does not contain Spotify Extended History audio files.");
  }
  if (selected.length > SPOTIFY_EXTENDED_HISTORY_LIMITS.maximumHistoryMembers) {
    fail("The ZIP contains too many Spotify Extended History audio files.");
  }
  if (new Set(selected.map(({ name }) => name)).size !== selected.length) {
    fail("The ZIP contains duplicate Spotify Extended History audio files.");
  }
  return selected;
}

export async function readSpotifyExtendedStreamingHistoryArchive({
  archivePath,
  subjectId,
  capturedAt = new Date().toISOString(),
} = {}) {
  if (typeof archivePath !== "string" || !archivePath.trim()) {
    fail("A Spotify Extended History ZIP path is required.");
  }
  const resolvedPath = path.resolve(archivePath);
  if (path.extname(resolvedPath).toLowerCase() !== ".zip") {
    fail("Spotify Extended History must be supplied as a ZIP archive.");
  }
  let file;
  try {
    file = await lstat(resolvedPath);
  } catch {
    fail(
      "The Spotify Extended History ZIP could not be opened.",
      "spotify_extended_history_archive_unreadable",
    );
  }
  if (
    !file.isFile() ||
    file.isSymbolicLink() ||
    file.size < 1 ||
    file.size > SPOTIFY_EXTENDED_HISTORY_LIMITS.maximumArchiveBytes
  ) {
    fail("The Spotify Extended History ZIP is not a supported regular file.");
  }

  const listing = await unzip(["-Z1", resolvedPath], 1024 * 1024);
  const members = selectedAudioMembers(listing);
  const records = [];
  let totalJsonBytes = 0;
  for (const member of members) {
    const jsonText = await unzip(
      ["-p", resolvedPath, member.name],
      SPOTIFY_EXTENDED_HISTORY_LIMITS.maximumMemberBytes,
    );
    totalJsonBytes += Buffer.byteLength(jsonText, "utf8");
    if (
      totalJsonBytes > SPOTIFY_EXTENDED_HISTORY_LIMITS.maximumTotalJsonBytes
    ) {
      fail("Spotify Extended History JSON is too large to import safely.");
    }
    let parsed;
    try {
      parsed = JSON.parse(jsonText.replace(/^\uFEFF/u, ""));
    } catch {
      fail(
        `Spotify Extended History audio file for ${member.year} is invalid JSON.`,
      );
    }
    if (!Array.isArray(parsed)) {
      fail(
        `Spotify Extended History audio file for ${member.year} is not an array.`,
      );
    }
    records.push(...parsed);
    if (records.length > SPOTIFY_EXTENDED_HISTORY_LIMITS.maximumRecords) {
      fail("Spotify Extended History contains too many records.");
    }
  }

  return projectSpotifyExtendedStreamingHistory({
    subjectId,
    records,
    archiveSha256: await sha256File(resolvedPath),
    archiveSizeBytes: file.size,
    memberNames: members.map(({ name }) => path.posix.basename(name)),
    capturedAt,
  });
}
