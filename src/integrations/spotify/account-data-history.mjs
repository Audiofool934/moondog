import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { isUuid, uuidV5 } from "../../core/uuid-v5.mjs";
import {
  SPOTIFY_ACCOUNT_PROFILE_MEMBERS,
  mergeSpotifyAccountProfile,
  projectSpotifyAccountDataProfile,
} from "./account-data-profile.mjs";

export const SPOTIFY_ACCOUNT_DATA_HISTORY_SOURCE =
  "spotify.account_data.streaming_history";
export const SPOTIFY_ACCOUNT_DATA_HISTORY_FORMAT =
  "spotify_account_data_streaming_history_v1";
export const SPOTIFY_ACCOUNT_DATA_HISTORY_SCOPE = "past_year_account_data";
export const SPOTIFY_ACCOUNT_DATA_TRACK_NAMESPACE =
  "a3ac8a61-684b-58e0-8bb0-c9691b9323e7";
export const SPOTIFY_ACCOUNT_DATA_EVENT_NAMESPACE =
  "18f7b1ad-0da4-51f9-a023-2807e7b8d5cf";
export const SPOTIFY_ACCOUNT_DATA_BATCH_NAMESPACE =
  "47382c18-99ba-5d22-a1e1-4adf89145cdb";

export const SPOTIFY_ACCOUNT_DATA_HISTORY_LIMITS = Object.freeze({
  maximumArchiveBytes: 512 * 1024 * 1024,
  maximumHistoryMembers: 100,
  maximumMemberBytes: 64 * 1024 * 1024,
  maximumTotalJsonBytes: 128 * 1024 * 1024,
  maximumRecords: 500_000,
});

const execFileAsync = promisify(execFile);
const musicMemberPattern =
  /^Spotify Account Data\/StreamingHistory_music_([0-9]+)\.json$/u;
const endTimePattern =
  /^([0-9]{4}-[0-9]{2}-[0-9]{2}) ([0-9]{2}:[0-9]{2})$/u;
const unsafeTextPattern =
  /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu;
const sha256Pattern = /^[a-f0-9]{64}$/u;

export class SpotifyAccountDataHistoryError extends Error {
  constructor(message, code = "spotify_account_data_invalid") {
    super(message);
    this.name = "SpotifyAccountDataHistoryError";
    this.code = code;
  }
}

function fail(message, code) {
  throw new SpotifyAccountDataHistoryError(message, code);
}

function normalizedTimestamp(value, label) {
  if (typeof value !== "string") fail(`${label} is invalid.`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) fail(`${label} is invalid.`);
  const normalized = new Date(milliseconds).toISOString();
  if (normalized !== value) fail(`${label} must be a normalized UTC timestamp.`);
  return normalized;
}

function accountDataEndTime(value, index) {
  if (typeof value !== "string") {
    fail(`Spotify music history record ${index + 1} has an invalid endTime.`);
  }
  const match = endTimePattern.exec(value);
  if (!match) {
    fail(`Spotify music history record ${index + 1} has an invalid endTime.`);
  }
  const normalized = `${match[1]}T${match[2]}:00.000Z`;
  const milliseconds = Date.parse(normalized);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== normalized
  ) {
    fail(`Spotify music history record ${index + 1} has an invalid endTime.`);
  }
  return normalized;
}

function cleanText(value, label, index) {
  if (typeof value !== "string") {
    fail(`Spotify music history record ${index + 1} has an invalid ${label}.`);
  }
  const cleaned = value
    .normalize("NFC")
    .replace(unsafeTextPattern, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!cleaned || Array.from(cleaned).length > 512) {
    fail(`Spotify music history record ${index + 1} has an invalid ${label}.`);
  }
  return cleaned;
}

function normalizedIdentityText(value) {
  return value.normalize("NFKC").toLowerCase();
}

function hashParts(...parts) {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part).update("\0");
  return hash.digest("hex");
}

function clippedText(value, maximum = 512) {
  return Array.from(value).slice(0, maximum).join("");
}

function lexicalCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function accountDataEventTuple({ occurredAt, artist, title, playedMs }) {
  return [
    occurredAt,
    normalizedIdentityText(artist),
    normalizedIdentityText(title),
    String(playedMs),
  ].join("\0");
}

export function spotifyAccountDataTrackIdentity({ artist, title } = {}) {
  if (typeof artist !== "string" || typeof title !== "string") {
    fail("Spotify account-data track identity is invalid.");
  }
  const fingerprint = hashParts(
    "spotify-account-data-track-label-v1",
    normalizedIdentityText(artist),
    normalizedIdentityText(title),
  );
  return {
    fingerprint,
    track_ref_id: uuidV5(
      fingerprint,
      SPOTIFY_ACCOUNT_DATA_TRACK_NAMESPACE,
    ),
  };
}

export function spotifyAccountDataEventIdentity({
  subjectId,
  occurredAt,
  artist,
  title,
  playedMs,
  duplicateOrdinal,
} = {}) {
  if (
    !isUuid(subjectId) ||
    typeof artist !== "string" ||
    typeof title !== "string" ||
    !Number.isSafeInteger(playedMs) ||
    playedMs < 0 ||
    !Number.isSafeInteger(duplicateOrdinal) ||
    duplicateOrdinal < 1
  ) {
    fail("Spotify account-data event identity is invalid.");
  }
  const normalizedOccurredAt = normalizedTimestamp(
    occurredAt,
    "Spotify account-data event timestamp",
  );
  const tuple = accountDataEventTuple({
    occurredAt: normalizedOccurredAt,
    artist,
    title,
    playedMs,
  });
  const fingerprint = hashParts(
    "spotify-account-data-play-v1",
    subjectId.toLowerCase(),
    tuple,
    String(duplicateOrdinal),
  );
  return {
    fingerprint,
    listening_event_id: uuidV5(
      fingerprint,
      SPOTIFY_ACCOUNT_DATA_EVENT_NAMESPACE,
    ),
    tuple,
  };
}

function normalizedMusicRows(records, capturedAt) {
  if (!Array.isArray(records)) {
    fail("Spotify music history records are invalid.");
  }
  if (records.length > SPOTIFY_ACCOUNT_DATA_HISTORY_LIMITS.maximumRecords) {
    fail("Spotify music history contains too many records.");
  }
  const capturedMilliseconds = Date.parse(capturedAt);
  return records.map((record, index) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      fail(`Spotify music history record ${index + 1} is invalid.`);
    }
    const occurredAt = accountDataEndTime(record.endTime, index);
    if (Date.parse(occurredAt) > capturedMilliseconds) {
      fail(`Spotify music history record ${index + 1} is later than the import time.`);
    }
    const artist = cleanText(record.artistName, "artistName", index);
    const title = cleanText(record.trackName, "trackName", index);
    if (!Number.isSafeInteger(record.msPlayed) || record.msPlayed < 0) {
      fail(`Spotify music history record ${index + 1} has an invalid msPlayed.`);
    }
    return {
      artist,
      title,
      occurredAt,
      playedMs: record.msPlayed,
      tuple: accountDataEventTuple({
        occurredAt,
        artist,
        title,
        playedMs: record.msPlayed,
      }),
    };
  });
}

function normalizedMemberNames(memberNames) {
  if (
    !Array.isArray(memberNames) ||
    memberNames.length < 1 ||
    memberNames.length > SPOTIFY_ACCOUNT_DATA_HISTORY_LIMITS.maximumHistoryMembers
  ) {
    fail("Spotify music history member names are invalid.");
  }
  const normalized = memberNames.map((value) => {
    if (
      typeof value !== "string" ||
      !/^StreamingHistory_music_[0-9]+\.json$/u.test(value)
    ) {
      fail("Spotify music history member names are invalid.");
    }
    return value;
  });
  if (new Set(normalized).size !== normalized.length) {
    fail("Spotify music history contains duplicate member names.");
  }
  return [...normalized].sort(lexicalCompare);
}

export function projectSpotifyAccountDataHistory({
  subjectId,
  records,
  archiveSha256,
  archiveSizeBytes,
  memberNames,
  capturedAt = new Date().toISOString(),
} = {}) {
  if (!isUuid(subjectId)) fail("A trusted subject ID is required.");
  const normalizedSubjectId = subjectId.toLowerCase();
  const normalizedCapturedAt = normalizedTimestamp(
    capturedAt,
    "Spotify account-data import timestamp",
  );
  if (typeof archiveSha256 !== "string" || !sha256Pattern.test(archiveSha256)) {
    fail("Spotify account-data archive SHA-256 is invalid.");
  }
  if (
    !Number.isSafeInteger(archiveSizeBytes) ||
    archiveSizeBytes < 1 ||
    archiveSizeBytes > SPOTIFY_ACCOUNT_DATA_HISTORY_LIMITS.maximumArchiveBytes
  ) {
    fail("Spotify account-data archive size is invalid.");
  }
  const normalizedMembers = normalizedMemberNames(memberNames);
  const rows = normalizedMusicRows(records, normalizedCapturedAt).sort(
    (left, right) => lexicalCompare(left.tuple, right.tuple),
  );
  const importBatchId = uuidV5(
    `${normalizedSubjectId}\0${archiveSha256}`,
    SPOTIFY_ACCOUNT_DATA_BATCH_NAMESPACE,
  );
  const trackRefs = new Map();
  const listeningEvents = [];
  let previousTuple = null;
  let duplicateOrdinal = 0;

  for (const row of rows) {
    if (row.tuple === previousTuple) duplicateOrdinal += 1;
    else duplicateOrdinal = 1;
    previousTuple = row.tuple;

    const trackIdentity = spotifyAccountDataTrackIdentity(row);
    const trackFingerprint = trackIdentity.fingerprint;
    const trackRefId = trackIdentity.track_ref_id;
    if (!trackRefs.has(trackRefId)) {
      trackRefs.set(trackRefId, {
        schema_version: 1,
        track_ref_id: trackRefId,
        revision: 1,
        identity_status: "provisional",
        display_label: clippedText(`${row.title} - ${row.artist}`),
        title: row.title,
        artist_credits: [{ name: row.artist, role: "unknown" }],
        external_refs: [
          {
            system: "spotify-account-data",
            entity_type: "spotify.account_data.track_label",
            external_id: trackFingerprint,
          },
        ],
        created_at: row.occurredAt,
      });
    }

    const eventIdentity = spotifyAccountDataEventIdentity({
      subjectId: normalizedSubjectId,
      occurredAt: row.occurredAt,
      artist: row.artist,
      title: row.title,
      playedMs: row.playedMs,
      duplicateOrdinal,
    });
    const eventFingerprint = eventIdentity.fingerprint;
    listeningEvents.push({
      schema_version: 1,
      listening_event_id: eventIdentity.listening_event_id,
      subject_id: normalizedSubjectId,
      track_ref_id: trackRefId,
      track_ref_revision: 1,
      event_type: "play_observed",
      occurred_at: row.occurredAt,
      ingested_at: normalizedCapturedAt,
      interaction_mode: "unknown",
      played_ms: row.playedMs,
      context: { context_type: "unknown" },
      provenance: {
        source_kind: "import",
        captured_at: normalizedCapturedAt,
        external_ref: {
          system: "spotify-account-data",
          entity_type: "spotify.account_data.play_history",
          external_id: eventFingerprint,
        },
        import_batch_id: importBatchId,
      },
      deduplication_key: eventFingerprint,
    });
  }

  const earliestOccurredAt = rows[0]?.occurredAt ?? null;
  const latestOccurredAt = rows.at(-1)?.occurredAt ?? null;
  return {
    source_key: SPOTIFY_ACCOUNT_DATA_HISTORY_SOURCE,
    captured_at: normalizedCapturedAt,
    cursor_after_ms:
      latestOccurredAt === null ? null : Date.parse(latestOccurredAt),
    track_refs: [...trackRefs.values()],
    listening_events: listeningEvents,
    import_batch: {
      import_batch_id: importBatchId,
      subject_id: normalizedSubjectId,
      source_format: SPOTIFY_ACCOUNT_DATA_HISTORY_FORMAT,
      data_scope: SPOTIFY_ACCOUNT_DATA_HISTORY_SCOPE,
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
      "The Spotify account-data ZIP could not be read safely.",
      "spotify_account_data_archive_unreadable",
    );
  }
}

function selectedMusicMembers(listing) {
  const selected = listing
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((name) => {
      const match = musicMemberPattern.exec(name);
      return match ? { name, index: Number(match[1]) } : null;
    })
    .filter(Boolean)
    .sort((left, right) => left.index - right.index);
  if (selected.length < 1) {
    fail("The ZIP does not contain Spotify Account Data music history files.");
  }
  if (selected.length > SPOTIFY_ACCOUNT_DATA_HISTORY_LIMITS.maximumHistoryMembers) {
    fail("The ZIP contains too many Spotify music history files.");
  }
  if (new Set(selected.map(({ name }) => name)).size !== selected.length) {
    fail("The ZIP contains duplicate Spotify music history files.");
  }
  for (let index = 0; index < selected.length; index += 1) {
    if (selected[index].index !== index) {
      fail("The ZIP has a missing Spotify music history segment.");
    }
  }
  return selected;
}

function selectedProfileMembers(listing) {
  const supported = new Set(SPOTIFY_ACCOUNT_PROFILE_MEMBERS);
  const selected = listing
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((name) => {
      const prefix = "Spotify Account Data/";
      if (!name.startsWith(prefix)) return null;
      const basename = name.slice(prefix.length);
      return supported.has(basename) ? { name, basename } : null;
    })
    .filter(Boolean)
    .sort((left, right) => lexicalCompare(left.basename, right.basename));
  if (new Set(selected.map(({ basename }) => basename)).size !== selected.length) {
    fail("The ZIP contains duplicate Spotify account-profile files.");
  }
  return selected;
}

export async function readSpotifyAccountDataHistoryArchive({
  archivePath,
  subjectId,
  capturedAt = new Date().toISOString(),
} = {}) {
  if (typeof archivePath !== "string" || !archivePath.trim()) {
    fail("A Spotify account-data ZIP path is required.");
  }
  const resolvedPath = path.resolve(archivePath);
  if (path.extname(resolvedPath).toLowerCase() !== ".zip") {
    fail("Spotify account data must be supplied as a ZIP archive.");
  }
  let file;
  try {
    file = await lstat(resolvedPath);
  } catch {
    fail(
      "The Spotify account-data ZIP could not be opened.",
      "spotify_account_data_archive_unreadable",
    );
  }
  if (
    !file.isFile() ||
    file.isSymbolicLink() ||
    file.size < 1 ||
    file.size > SPOTIFY_ACCOUNT_DATA_HISTORY_LIMITS.maximumArchiveBytes
  ) {
    fail("The Spotify account-data ZIP is not a supported regular file.");
  }

  const listing = await unzip(["-Z1", resolvedPath], 1024 * 1024);
  const members = selectedMusicMembers(listing);
  const profileMembers = selectedProfileMembers(listing);
  const records = [];
  const documents = {};
  let totalJsonBytes = 0;
  for (const member of members) {
    const jsonText = await unzip(
      ["-p", resolvedPath, member.name],
      SPOTIFY_ACCOUNT_DATA_HISTORY_LIMITS.maximumMemberBytes,
    );
    totalJsonBytes += Buffer.byteLength(jsonText, "utf8");
    if (
      totalJsonBytes >
      SPOTIFY_ACCOUNT_DATA_HISTORY_LIMITS.maximumTotalJsonBytes
    ) {
      fail("Spotify music history JSON is too large to import safely.");
    }
    let parsed;
    try {
      parsed = JSON.parse(jsonText.replace(/^\uFEFF/u, ""));
    } catch {
      fail(`Spotify music history segment ${member.index} is invalid JSON.`);
    }
    if (!Array.isArray(parsed)) {
      fail(`Spotify music history segment ${member.index} is not an array.`);
    }
    records.push(...parsed);
    if (records.length > SPOTIFY_ACCOUNT_DATA_HISTORY_LIMITS.maximumRecords) {
      fail("Spotify music history contains too many records.");
    }
  }

  for (const member of profileMembers) {
    const jsonText = await unzip(
      ["-p", resolvedPath, member.name],
      SPOTIFY_ACCOUNT_DATA_HISTORY_LIMITS.maximumMemberBytes,
    );
    totalJsonBytes += Buffer.byteLength(jsonText, "utf8");
    if (
      totalJsonBytes >
      SPOTIFY_ACCOUNT_DATA_HISTORY_LIMITS.maximumTotalJsonBytes
    ) {
      fail("Spotify account-profile JSON is too large to import safely.");
    }
    try {
      documents[member.basename] = JSON.parse(
        jsonText.replace(/^\uFEFF/u, ""),
      );
    } catch {
      fail(`Spotify account-profile file ${member.basename} is invalid JSON.`);
    }
  }

  const archiveSha256 = await sha256File(resolvedPath);
  const historyBundle = projectSpotifyAccountDataHistory({
    subjectId,
    records,
    archiveSha256,
    archiveSizeBytes: file.size,
    memberNames: members.map(({ name }) => path.posix.basename(name)),
    capturedAt,
  });
  if (profileMembers.length === 0) return historyBundle;
  return mergeSpotifyAccountProfile(
    historyBundle,
    projectSpotifyAccountDataProfile({
      subjectId,
      archiveSha256,
      archiveSizeBytes: file.size,
      documents,
      capturedAt,
    }),
  );
}
