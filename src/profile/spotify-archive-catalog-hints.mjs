import { randomUUID } from "node:crypto";

import { readSpotifyHistoryArchive } from "../integrations/spotify/history-archive.mjs";

const supportedSourceFormats = new Set([
  "spotify_account_data_streaming_history_v1",
  "spotify_extended_streaming_history_music_v1",
]);
const maximumImportedRecords = 500_000;
const maximumReleaseHints = 3;
const unsafeTextPattern =
  /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu;

function fail(message) {
  const error = new Error(message);
  error.code = "spotify_archive_catalog_hint_invalid";
  throw error;
}

function cleanText(value, maximum, field) {
  if (typeof value !== "string") fail(`The Spotify archive ${field} is invalid.`);
  const cleaned = value
    .normalize("NFC")
    .replace(unsafeTextPattern, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!cleaned || Array.from(cleaned).length > maximum) {
    fail(`The Spotify archive ${field} is invalid.`);
  }
  return cleaned;
}

function normalizeIdentity(value) {
  return cleanText(value, 512, "artist name")
    .normalize("NFKC")
    .toLocaleLowerCase("und");
}

function normalizedReleaseKey(value) {
  return value === null
    ? null
    : value.normalize("NFKC").toLocaleLowerCase("und");
}

function boundedArray(value, field) {
  if (!Array.isArray(value) || value.length > maximumImportedRecords) {
    fail(`The Spotify archive ${field} is invalid.`);
  }
  return value;
}

function timestampScore(value) {
  if (typeof value !== "string") return 0;
  const score = Date.parse(value);
  return Number.isFinite(score) ? score : 0;
}

function numericPlayedMs(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function compareHints(left, right) {
  if (left.eventCount !== right.eventCount) {
    return right.eventCount - left.eventCount;
  }
  if (left.playedMs !== right.playedMs) return right.playedMs - left.playedMs;
  if (left.latestAt !== right.latestAt) return right.latestAt - left.latestAt;
  if (left.trackIds.size !== right.trackIds.size) {
    return right.trackIds.size - left.trackIds.size;
  }
  return left.title.localeCompare(right.title, "und");
}

export async function deriveArtistReleaseHintsFromSpotifyArchive({
  archivePath,
  artistName,
  capturedAt = new Date().toISOString(),
  maximumHints = maximumReleaseHints,
  historyArchiveImporter = readSpotifyHistoryArchive,
} = {}) {
  if (typeof archivePath !== "string" || !archivePath.trim()) {
    throw new TypeError("A Spotify history ZIP path is required.");
  }
  const normalizedArtist = normalizeIdentity(artistName);
  if (
    typeof capturedAt !== "string" ||
    !Number.isFinite(Date.parse(capturedAt))
  ) {
    throw new TypeError("The Spotify archive capture time is invalid.");
  }
  if (
    !Number.isInteger(maximumHints) ||
    maximumHints < 1 ||
    maximumHints > maximumReleaseHints
  ) {
    throw new TypeError("The Spotify archive release-hint limit is invalid.");
  }
  if (typeof historyArchiveImporter !== "function") {
    throw new TypeError("A Spotify history archive reader is required.");
  }

  const bundle = await historyArchiveImporter({
    archivePath,
    subjectId: randomUUID(),
    capturedAt: new Date(capturedAt).toISOString(),
  });
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
    fail("The Spotify archive import result is invalid.");
  }
  const sourceFormat = cleanText(
    bundle.import_batch?.source_format,
    128,
    "source format",
  );
  if (!supportedSourceFormats.has(sourceFormat)) {
    fail("The Spotify archive source format is unsupported.");
  }

  const matchingTracks = new Map();
  for (const trackRef of boundedArray(bundle.track_refs, "track references")) {
    if (!trackRef || typeof trackRef !== "object" || Array.isArray(trackRef)) {
      fail("The Spotify archive track reference is invalid.");
    }
    const artistCredits = boundedArray(trackRef.artist_credits, "artist credits");
    const exactArtist = artistCredits.some(
      (credit) =>
        credit &&
        typeof credit === "object" &&
        !Array.isArray(credit) &&
        normalizeIdentity(credit.name) === normalizedArtist,
    );
    if (!exactArtist) continue;
    const trackRefId = cleanText(trackRef.track_ref_id, 128, "track reference ID");
    const releaseTitle = trackRef.release?.title;
    const normalizedRelease =
      typeof releaseTitle === "string" && releaseTitle.trim()
        ? cleanText(releaseTitle, 512, "release title")
        : null;
    const existing = matchingTracks.get(trackRefId);
    if (
      existing &&
      existing.releaseTitle !== null &&
      normalizedRelease !== null &&
      normalizedReleaseKey(existing.releaseTitle) !==
        normalizedReleaseKey(normalizedRelease)
    ) {
      fail("The Spotify archive track identity is inconsistent.");
    }
    if (existing) {
      existing.releaseTitle ??= normalizedRelease;
      existing.createdAt = Math.max(
        existing.createdAt,
        timestampScore(trackRef.created_at),
      );
      continue;
    }
    matchingTracks.set(trackRefId, {
      releaseTitle: normalizedRelease,
      createdAt: timestampScore(trackRef.created_at),
      eventCount: 0,
      playedMs: 0,
      latestAt: 0,
    });
  }

  let exactArtistEventCount = 0;
  for (const event of boundedArray(bundle.listening_events, "listening events")) {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      fail("The Spotify archive listening event is invalid.");
    }
    const track = matchingTracks.get(event.track_ref_id);
    if (!track) continue;
    exactArtistEventCount += 1;
    track.eventCount += 1;
    track.playedMs += numericPlayedMs(event.played_ms);
    track.latestAt = Math.max(track.latestAt, timestampScore(event.occurred_at));
  }

  const releases = new Map();
  for (const [trackRefId, track] of matchingTracks) {
    if (!track.releaseTitle) continue;
    const key = normalizedReleaseKey(track.releaseTitle);
    const release = releases.get(key) ?? {
      title: track.releaseTitle,
      trackIds: new Set(),
      eventCount: 0,
      playedMs: 0,
      latestAt: 0,
    };
    release.trackIds.add(trackRefId);
    release.eventCount += track.eventCount;
    release.playedMs += track.playedMs;
    release.latestAt = Math.max(
      release.latestAt,
      track.latestAt,
      track.createdAt,
    );
    releases.set(key, release);
  }

  return {
    source_format: sourceFormat,
    exact_artist_track_count: matchingTracks.size,
    exact_artist_event_count: exactArtistEventCount,
    release_titles: [...releases.values()]
      .sort(compareHints)
      .slice(0, maximumHints)
      .map((release) => release.title),
  };
}
