import { createHash } from "node:crypto";

import { isUuid, uuidV5 } from "../../core/uuid-v5.mjs";

export const SPOTIFY_RECENT_ACTIVITY_SOURCE = "spotify.recently_played";
export const SPOTIFY_TRACK_NAMESPACE =
  "e76578a4-0c61-50e2-91f9-b312ea986a92";
export const SPOTIFY_LISTENING_EVENT_NAMESPACE =
  "b8c8dbbf-2e67-51ae-99e5-744daf9f8c10";

const isrcPattern = /^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/u;
const releaseDatePattern = /^(?:[0-9]{4}|[0-9]{4}-(?:0[1-9]|1[0-2])|[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01]))$/u;
const contextTypes = new Set(["album", "playlist", "artist"]);

function fail(message) {
  throw new TypeError(message);
}

function timestamp(value, label) {
  if (typeof value !== "string") fail(`${label} is invalid`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) fail(`${label} is invalid`);
  const normalized = new Date(milliseconds).toISOString();
  if (normalized !== value) fail(`${label} must be a normalized UTC timestamp`);
  return normalized;
}

function cleanText(value, maximum, label) {
  if (typeof value !== "string") fail(`${label} is invalid`);
  const cleaned = value.replace(/\s+/gu, " ").trim();
  if (!cleaned || Array.from(cleaned).length > maximum) {
    fail(`${label} is invalid`);
  }
  return cleaned;
}

function clippedText(value, maximum) {
  return Array.from(value).slice(0, maximum).join("");
}

function validReleaseDate(value) {
  if (typeof value !== "string" || !releaseDatePattern.test(value)) {
    return false;
  }
  if (value.length < 10) return true;
  const milliseconds = Date.parse(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString().slice(0, 10) === value
  );
}

function safeExternalUrl(value) {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.search.length > 0 ||
      url.hash.length > 0 ||
      url.username.length > 0 ||
      url.password.length > 0
    ) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function trackRecord(item) {
  const track = item.track;
  const playedAt = timestamp(item.played_at, "Spotify played_at");
  const externalId = cleanText(track.id, 128, "Spotify track ID");
  const title = cleanText(track.name, 512, "Spotify track title");
  const artists = Array.isArray(track.artists)
    ? track.artists
        .map((artist) => cleanText(artist, 512, "Spotify artist name"))
        .slice(0, 5)
    : [];
  if (artists.length === 0) fail("Spotify track artists are invalid");
  const release = cleanText(track.album, 512, "Spotify release title");
  const externalRef = {
    system: "spotify",
    entity_type: "spotify.track",
    external_id: externalId,
  };
  const url = safeExternalUrl(track.external_url);
  if (url) externalRef.url = url;
  const record = {
    schema_version: 1,
    track_ref_id: uuidV5(externalId, SPOTIFY_TRACK_NAMESPACE),
    revision: 1,
    identity_status: "resolved",
    display_label: clippedText(`${title} - ${artists.join(", ")}`, 512),
    title,
    artist_credits: artists.map((name) => ({ name, role: "unknown" })),
    release: { title: release },
    external_refs: [externalRef],
    created_at: playedAt,
    resolved_at: playedAt,
  };
  if (Number.isInteger(track.duration_ms) && track.duration_ms >= 0) {
    record.duration_ms = track.duration_ms;
  }
  if (typeof track.isrc === "string" && isrcPattern.test(track.isrc)) {
    record.isrc = track.isrc;
  }
  if (
    validReleaseDate(track.release_date)
  ) {
    record.release.release_date = track.release_date;
  }
  return record;
}

function eventRecord(item, trackRef, subjectId, capturedAt) {
  const occurredAt = timestamp(item.played_at, "Spotify played_at");
  if (Date.parse(capturedAt) < Date.parse(occurredAt)) {
    fail("Spotify play time is later than its capture time");
  }
  const fingerprint = createHash("sha256")
    .update("spotify\0")
    .update(subjectId)
    .update("\0")
    .update(item.track.id)
    .update("\0")
    .update(occurredAt)
    .digest("hex");
  const contextType = contextTypes.has(item.context_type)
    ? item.context_type
    : "unknown";
  return {
    schema_version: 1,
    listening_event_id: uuidV5(
      fingerprint,
      SPOTIFY_LISTENING_EVENT_NAMESPACE,
    ),
    subject_id: subjectId,
    track_ref_id: trackRef.track_ref_id,
    track_ref_revision: trackRef.revision,
    event_type: "play_observed",
    occurred_at: occurredAt,
    ingested_at: capturedAt,
    interaction_mode: "unknown",
    context: { context_type: contextType },
    provenance: {
      source_kind: "tool",
      captured_at: capturedAt,
      external_ref: {
        system: "spotify",
        entity_type: "spotify.play_history",
        external_id: fingerprint,
      },
    },
    deduplication_key: fingerprint,
  };
}

export function projectSpotifyRecentActivity({
  subjectId,
  page,
  capturedAt = new Date().toISOString(),
} = {}) {
  if (!isUuid(subjectId)) fail("A trusted subject ID is required");
  const normalizedCapturedAt = timestamp(capturedAt, "Capture timestamp");
  if (!page || page.provider !== "spotify" || !Array.isArray(page.items)) {
    fail("A normalized Spotify recent activity page is required");
  }
  if (page.items.length > 50) fail("Spotify recent activity is not bounded");

  const trackRefs = new Map();
  const listeningEvents = new Map();
  let cursorAfterMs = Number.isSafeInteger(page.cursor_after_ms)
    ? page.cursor_after_ms
    : 0;
  for (const item of page.items) {
    const trackRef = trackRecord(item);
    trackRefs.set(trackRef.track_ref_id, trackRef);
    const event = eventRecord(
      item,
      trackRef,
      subjectId.toLowerCase(),
      normalizedCapturedAt,
    );
    listeningEvents.set(event.listening_event_id, event);
    cursorAfterMs = Math.max(cursorAfterMs, Date.parse(event.occurred_at));
  }

  return {
    source_key: SPOTIFY_RECENT_ACTIVITY_SOURCE,
    captured_at: normalizedCapturedAt,
    cursor_after_ms: cursorAfterMs > 0 ? cursorAfterMs : null,
    track_refs: [...trackRefs.values()],
    listening_events: [...listeningEvents.values()],
  };
}
