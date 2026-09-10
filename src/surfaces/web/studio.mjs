import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createPublicTasteprintDemoProfile,
  PUBLIC_TASTEPRINT_DEMO_GENERATED_AT,
} from "../../demo/moondog-tasteprint-demo.mjs";
import { InteractiveTasteprintDemoSession } from "../../demo/moondog-interactive-tasteprint-demo.mjs";
import { writeFictionalSpotifyHistoryArchive } from "../../demo/fictional-spotify-history.mjs";
import {
  LISTENBRAINZ_HISTORY_LIMITS,
  readListenBrainzHistoryFile,
} from "../../integrations/listenbrainz/history-file.mjs";
import {
  createListeningHistoryProfileProjection,
  persistTasteFromSpotifyArchive,
  projectTasteFromSpotifyArchives,
  projectTasteFromSpotifyArchive,
  SPOTIFY_ARCHIVE_SET_MAXIMUM,
} from "../../profile/spotify-archive-taste.mjs";
import {
  openListeningHistoryStore,
  resolveListeningHistoryPath,
} from "../../profile/listening-history-store.mjs";
import { writeTasteprintArtifact } from "../html/tasteprint-artifact.mjs";
import {
  renderTasteprintCardHtml,
  renderTasteprintHtml,
} from "../html/tasteprint.mjs";
import { renderStudioPage } from "./studio-page.mjs";

export const MOONDOG_STUDIO_HOST = "127.0.0.1";
export const MOONDOG_STUDIO_MAXIMUM_ARCHIVES = SPOTIFY_ARCHIVE_SET_MAXIMUM;
export const MOONDOG_STUDIO_MAXIMUM_ARCHIVE_BYTES = 512 * 1024 * 1024;
export const MOONDOG_STUDIO_MAXIMUM_HISTORY_JSON_BYTES =
  LISTENBRAINZ_HISTORY_LIMITS.maximumFileBytes;
export const MOONDOG_STUDIO_MAXIMUM_JSON_BYTES = 16 * 1024;

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const defaultBrandImagePath = path.join(
  repositoryRoot,
  "assets",
  "brand",
  "moondog-lunar-record",
  "moondog-logo-1x1.png",
);
const zipSignatures = new Set(["504b0304", "504b0506", "504b0708"]);
const fictionalHistoryCapturedAt = "2026-08-25T23:59:59.000Z";

class StudioHttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = "StudioHttpError";
    this.statusCode = statusCode;
  }
}

function sessionSecret() {
  return randomBytes(32).toString("base64url");
}

function validToken(candidate, expected) {
  if (typeof candidate !== "string") return false;
  const left = Buffer.from(candidate, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function baseHeaders(contentType) {
  return {
    "Cache-Control": "no-store, max-age=0",
    "Content-Type": contentType,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}

function send(response, statusCode, body, headers = {}) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  response.writeHead(statusCode, {
    ...headers,
    "Content-Length": buffer.length,
  });
  response.end(buffer);
}

function sendJson(response, statusCode, value) {
  send(response, statusCode, `${JSON.stringify(value)}\n`, {
    ...baseHeaders("application/json; charset=utf-8"),
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  });
}

function sendNotFound(response) {
  send(response, 404, "Not found.\n", {
    ...baseHeaders("text/plain; charset=utf-8"),
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  });
}

function archiveContentLength(request) {
  const raw = request.headers["content-length"];
  if (raw === undefined) return null;
  if (Array.isArray(raw) || !/^[0-9]+$/u.test(raw)) {
    throw new StudioHttpError(400, "The ZIP upload length is invalid.");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new StudioHttpError(413, "That ZIP is larger than Studio supports.");
  }
  return value;
}

function historyJsonContentLength(request) {
  const raw = request.headers["content-length"];
  if (raw === undefined) return null;
  if (Array.isArray(raw) || !/^[0-9]+$/u.test(raw)) {
    throw new StudioHttpError(400, "The ListenBrainz JSON upload length is invalid.");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new StudioHttpError(
      413,
      "That ListenBrainz JSON is larger than Studio supports.",
    );
  }
  return value;
}

function requestContentLength(request, maximumBytes) {
  const raw = request.headers["content-length"];
  if (raw === undefined) return null;
  if (Array.isArray(raw) || !/^[0-9]+$/u.test(raw)) {
    throw new StudioHttpError(400, "The local profile update length is invalid.");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > maximumBytes) {
    throw new StudioHttpError(413, "That local profile update is too large.");
  }
  return value;
}

async function receiveJson(request, maximumBytes = MOONDOG_STUDIO_MAXIMUM_JSON_BYTES) {
  requestContentLength(request, maximumBytes);
  const chunks = [];
  let bytes = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    bytes += chunk.length;
    if (bytes > maximumBytes) {
      throw new StudioHttpError(413, "That local profile update is too large.");
    }
    chunks.push(chunk);
  }
  if (bytes === 0) {
    throw new StudioHttpError(400, "The local profile update is empty.");
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new StudioHttpError(400, "The local profile update is not valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StudioHttpError(422, "The local profile update is invalid.");
  }
  return value;
}

function exactObject(value, allowedKeys) {
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new StudioHttpError(422, "The local profile update has unknown fields.");
  }
  return value;
}

function listenerCorrectionInput(value) {
  exactObject(
    value,
    new Set([
      "entity_type",
      "label",
      "artist_credit",
      "stance",
      "note",
    ]),
  );
  if (value.entity_type === "artist" && "artist_credit" in value) {
    throw new StudioHttpError(
      422,
      "Artist corrections do not use a separate artist credit.",
    );
  }
  return {
    entityType: value.entity_type,
    label: value.label,
    artistCredit: value.artist_credit,
    stance: value.stance,
    ...(
      typeof value.note === "string" && value.note.trim() === ""
        ? {}
        : { note: value.note }
    ),
  };
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function createFictionalHistoryDemo({
  temporaryRoot,
  writeArchive = writeFictionalSpotifyHistoryArchive,
  projectArchive = projectTasteFromSpotifyArchive,
} = {}) {
  await mkdir(temporaryRoot, { recursive: true });
  const demoRoot = await mkdtemp(
    path.join(temporaryRoot, "moondog-studio-fictional-history-"),
  );
  if (process.platform !== "win32") await chmod(demoRoot, 0o700);
  const archivePath = path.join(demoRoot, "moondog-fictional-history.zip");
  try {
    const manifest = await writeArchive({ outputPath: archivePath });
    const projection = await projectArchive({
      archivePath,
      capturedAt: fictionalHistoryCapturedAt,
      maxItems: 10,
    });
    const profile = structuredClone(projection.profile);
    profile.limitations = [
      "This fictional Studio profile was generated through the production Spotify history importer and exists only in this process.",
      ...(profile.limitations ?? []),
    ].slice(0, 8);
    return {
      profile,
      proof: {
        kind: "fictional_spotify_extended_history",
        archive_schema: manifest.schema,
        source_format: projection.source.source_format,
        record_count: projection.source.input_records,
        years: manifest.years,
        production_importer: true,
        private_listener_data_read: false,
        persistent_profile_writes: false,
      },
    };
  } finally {
    await rm(demoRoot, { recursive: true, force: true });
  }
}

async function createPrivateArchiveSession({
  archivePaths,
  maximumArchiveBytes,
  capturedAt,
  projectArchive = projectTasteFromSpotifyArchive,
  projectArchives = projectTasteFromSpotifyArchives,
} = {}) {
  let totalArchiveBytes = 0;
  for (const archivePath of archivePaths) {
    let archiveStats;
    try {
      archiveStats = await stat(archivePath);
    } catch {
      throw new StudioHttpError(
        422,
        "A selected Spotify history ZIP could not be read safely.",
      );
    }
    if (!archiveStats.isFile() || archiveStats.size < 4) {
      throw new StudioHttpError(
        422,
        "A selected Spotify history ZIP could not be read safely.",
      );
    }
    totalArchiveBytes += archiveStats.size;
  }
  if (totalArchiveBytes > maximumArchiveBytes) {
    throw new StudioHttpError(
      413,
      "The selected ZIP archives are larger than Studio supports together.",
    );
  }
  try {
    const projection = archivePaths.length === 1
      ? await projectArchive({
          archivePath: archivePaths[0],
          capturedAt,
          maxItems: 10,
        })
      : await projectArchives({
          archivePaths,
          capturedAt,
          maxItems: 10,
        });
    return {
      profile: structuredClone(projection.profile),
      source: {
        provider: "spotify",
        data_scope: projection.source.data_scope,
        input_records: projection.source.input_records,
        persistent_import: false,
        ...(projection.source.archive_count > 1
          ? {
              archive_count: projection.source.archive_count,
              sources: projection.source.sources,
              effective_listening_events:
                projection.source.effective_listening_events,
              reconciled_overlap_events:
                projection.source.reconciled_overlap_events,
            }
          : {}),
      },
    };
  } catch (error) {
    throw publicImportError(error);
  }
}

function selectedSpotifyArchivePaths({ archivePath, archivePaths }) {
  if (archivePath !== null && archivePaths !== null) {
    throw new TypeError(
      "Moondog Studio accepts archivePath or archivePaths, not both.",
    );
  }
  const selected = archivePaths ?? (archivePath === null ? [] : [archivePath]);
  if (
    !Array.isArray(selected) ||
    selected.length > SPOTIFY_ARCHIVE_SET_MAXIMUM ||
    selected.some((item) => typeof item !== "string" || !item.trim())
  ) {
    throw new TypeError("Moondog Studio archive paths are invalid.");
  }
  const normalized = selected.map((item) => item.trim());
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError("Moondog Studio archive paths must be distinct.");
  }
  return normalized;
}

async function receivePrivateZip(
  request,
  { maximumArchiveBytes, temporaryRoot },
) {
  const contentLength = archiveContentLength(request);
  if (contentLength !== null && contentLength > maximumArchiveBytes) {
    throw new StudioHttpError(413, "That ZIP is larger than Studio supports.");
  }
  if (contentLength !== null && contentLength < 4) {
    throw new StudioHttpError(422, "That file is not a readable Spotify ZIP.");
  }

  await mkdir(temporaryRoot, { recursive: true });
  const uploadRoot = await mkdtemp(path.join(temporaryRoot, "moondog-studio-"));
  if (process.platform !== "win32") await chmod(uploadRoot, 0o700);
  const archivePath = path.join(uploadRoot, "spotify-history.zip");
  let handle;
  try {
    handle = await open(archivePath, "wx", 0o600);
    let bytes = 0;
    let oversized = false;
    const signature = Buffer.alloc(4);
    let signatureBytes = 0;
    for await (const value of request) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      bytes += chunk.length;
      if (signatureBytes < signature.length) {
        const copyBytes = Math.min(signature.length - signatureBytes, chunk.length);
        chunk.copy(signature, signatureBytes, 0, copyBytes);
        signatureBytes += copyBytes;
      }
      if (bytes > maximumArchiveBytes) {
        oversized = true;
        continue;
      }
      await handle.writeFile(chunk);
    }
    await handle.close();
    handle = null;
    if (oversized) {
      throw new StudioHttpError(413, "That ZIP is larger than Studio supports.");
    }
    if (bytes < 4 || !zipSignatures.has(signature.toString("hex"))) {
      throw new StudioHttpError(422, "That file is not a readable Spotify ZIP.");
    }
    if (process.platform !== "win32") await chmod(archivePath, 0o600);
    return { archivePath, uploadRoot };
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(uploadRoot, { recursive: true, force: true });
    throw error;
  }
}

async function receivePrivateListenBrainzJson(
  request,
  { maximumHistoryJsonBytes, temporaryRoot },
) {
  const contentLength = historyJsonContentLength(request);
  if (contentLength !== null && contentLength > maximumHistoryJsonBytes) {
    throw new StudioHttpError(
      413,
      "That ListenBrainz JSON is larger than Studio supports.",
    );
  }
  if (contentLength === 0) {
    throw new StudioHttpError(422, "That file is not readable ListenBrainz JSON.");
  }

  await mkdir(temporaryRoot, { recursive: true });
  const uploadRoot = await mkdtemp(path.join(temporaryRoot, "moondog-studio-"));
  if (process.platform !== "win32") await chmod(uploadRoot, 0o700);
  const historyPath = path.join(uploadRoot, "listenbrainz-history.json");
  let handle;
  try {
    handle = await open(historyPath, "wx", 0o600);
    let bytes = 0;
    let oversized = false;
    for await (const value of request) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      bytes += chunk.length;
      if (bytes > maximumHistoryJsonBytes) {
        oversized = true;
        continue;
      }
      await handle.writeFile(chunk);
    }
    await handle.close();
    handle = null;
    if (oversized) {
      throw new StudioHttpError(
        413,
        "That ListenBrainz JSON is larger than Studio supports.",
      );
    }
    if (bytes === 0) {
      throw new StudioHttpError(
        422,
        "That file is not readable ListenBrainz JSON.",
      );
    }
    if (process.platform !== "win32") await chmod(historyPath, 0o600);
    return { historyPath, uploadRoot };
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(uploadRoot, { recursive: true, force: true });
    throw error;
  }
}

async function persistTasteFromListenBrainzHistory({
  historyPath,
  subjectId,
  store,
  capturedAt,
  maxItems,
  historyFileImporter = readListenBrainzHistoryFile,
}) {
  const bundle = await historyFileImporter({
    filePath: historyPath,
    subjectId,
    capturedAt,
  });
  const receipt = store.ingestImport(bundle);
  const listening = store.profileSummary({ subjectId, maxItems });
  return {
    profile: createListeningHistoryProfileProjection(listening, { maxItems }),
    source: {
      source_format: receipt.source_format,
      data_scope: receipt.data_scope,
      input_records: receipt.input_records,
      persistent_import: true,
      already_imported: receipt.already_imported,
      effective_event_delta: receipt.effective_event_delta,
      mapped_track_refs: bundle.track_refs.filter(
        (track) => track.identity_status === "resolved",
      ).length,
      events_with_played_duration: bundle.listening_events.filter(
        (event) => Number.isSafeInteger(event.played_ms),
      ).length,
    },
    receipt,
  };
}

async function trustedLocalSubjectId(store) {
  const [sourceStatusModule, projectionModule] = await Promise.all([
    import("../../core/apple-library-source-status.mjs"),
    import("../../core/apple-projection-domain-services.mjs"),
  ]);
  const { readAppleMusicSourceStatus } = sourceStatusModule;
  const { resolveAppleMusicSubjectId } = projectionModule;
  const source = await readAppleMusicSourceStatus();
  if (source.state === "invalid") {
    const error = new Error("The canonical Apple Music import source is invalid.");
    error.code = "projection_source_invalid";
    throw error;
  }
  const appleSubjectId = source.state === "missing"
    ? null
    : await resolveAppleMusicSubjectId();
  return store.localSubjectId({
    ...(appleSubjectId ? { preferredSubjectId: appleSubjectId } : {}),
    create: true,
  });
}

function safeCoverage(profile) {
  const coverage = profile?.coverage ?? {};
  return {
    effective_listening_events: Number.isInteger(
      coverage.effective_listening_events,
    )
      ? coverage.effective_listening_events
      : 0,
    listening_hours: Number.isFinite(coverage.listening_hours)
      ? coverage.listening_hours
      : 0,
    distinct_tracks: Number.isInteger(coverage.listening_tracks)
      ? coverage.listening_tracks
      : 0,
    cross_format_track_links: Number.isInteger(
      coverage.cross_format_track_links,
    )
      ? coverage.cross_format_track_links
      : 0,
    cross_format_linked_events: Number.isInteger(
      coverage.cross_format_linked_events,
    )
      ? coverage.cross_format_linked_events
      : 0,
    cross_format_ambiguous_tracks: Number.isInteger(
      coverage.cross_format_ambiguous_tracks,
    )
      ? coverage.cross_format_ambiguous_tracks
      : 0,
    cross_format_ambiguous_events: Number.isInteger(
      coverage.cross_format_ambiguous_events,
    )
      ? coverage.cross_format_ambiguous_events
      : 0,
  };
}

function boundedStudioText(value, maximumLength = 160) {
  if (typeof value !== "string") return null;
  const cleaned = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!cleaned) return null;
  return cleaned.slice(0, maximumLength);
}

function safeTimeMachine(profile) {
  const behavior = profile?.listening_behavior ?? {};
  const candidates = Array.isArray(behavior.time_capsule_tracks)
    ? behavior.time_capsule_tracks
    : [];
  const landmarks = candidates
    .map((candidate) => {
      const year = candidate?.capsule_year;
      const title = boundedStudioText(candidate?.label);
      const artist = boundedStudioText(candidate?.artist_credit);
      if (
        !Number.isInteger(year) ||
        year < 1900 ||
        year > 2100 ||
        !title ||
        !artist
      ) {
        return null;
      }
      return { year, title, artist };
    })
    .filter(Boolean)
    .sort((left, right) => left.year - right.year)
    .slice(0, 12);
  const retainedYears = [
    ...new Set(
      (Array.isArray(behavior.history_arc) ? behavior.history_arc : [])
        .map((item) => item?.year)
        .filter(
          (year) =>
            Number.isInteger(year) && year >= 1900 && year <= 2100,
        ),
    ),
  ].sort((left, right) => left - right);
  const landmarkYears = new Set(landmarks.map((landmark) => landmark.year));
  const representedYears = retainedYears.filter((year) =>
    landmarkYears.has(year),
  );
  const context = behavior.context ?? {};
  const minimumEngagedPlays = Number.isInteger(
    context.time_capsule_minimum_engaged_plays,
  ) && context.time_capsule_minimum_engaged_plays >= 1
    ? context.time_capsule_minimum_engaged_plays
    : null;
  const minimumListeningMinutes = Number.isFinite(
    context.time_capsule_minimum_listening_minutes,
  ) && context.time_capsule_minimum_listening_minutes >= 1
    ? context.time_capsule_minimum_listening_minutes
    : null;
  return {
    ready: landmarks.length >= 2,
    landmark_count: landmarks.length,
    retained_year_count: retainedYears.length,
    represented_year_count: representedYears.length,
    unrepresented_years: retainedYears.filter(
      (year) => !landmarkYears.has(year),
    ),
    minimum_engaged_plays: minimumEngagedPlays,
    minimum_listening_minutes: minimumListeningMinutes,
    landmarks,
  };
}

function studioMonthIndex(monthKey) {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(monthKey)) return null;
  const year = Number(monthKey.slice(0, 4));
  const month = Number(monthKey.slice(5, 7));
  if (!Number.isInteger(year) || year < 1900 || year > 9999) return null;
  return year * 12 + month - 1;
}

function emptyMonthlyActivity() {
  return {
    ready: false,
    timezone: "UTC",
    retained_span_months: 0,
    represented_month_count: 0,
    active_month_count: 0,
    omitted_earlier_month_count: 0,
    preview_month_count: 0,
    preview_active_month_count: 0,
    preview_omitted_month_count: 0,
    peak_listening_minutes: 0,
    months: [],
  };
}

function safeMonthlyActivity(profile) {
  const value = profile?.listening_behavior?.monthly_activity;
  if (!value || typeof value !== "object" || value.timezone !== "UTC") {
    return emptyMonthlyActivity();
  }
  const firstMonth = boundedStudioText(value.first_month, 7);
  const lastMonth = boundedStudioText(value.last_month, 7);
  const firstIndex = studioMonthIndex(firstMonth);
  const lastIndex = studioMonthIndex(lastMonth);
  const retainedSpanMonths = value.retained_span_months;
  const representedMonthCount = value.represented_month_count;
  const activeMonthCount = value.active_month_count;
  const omittedEarlierMonthCount = value.omitted_earlier_month_count;
  const peakListeningMinutes = value.peak_listening_minutes;
  const rawMonths = Array.isArray(value.months) ? value.months : [];
  const months = rawMonths
    .map((item) => {
      const month = boundedStudioText(item?.month, 7);
      const eventCount = item?.event_count;
      const engagedPlayCount = item?.engaged_play_count;
      const listeningMinutes = item?.listening_minutes;
      const distinctTracks = item?.distinct_tracks;
      if (
        studioMonthIndex(month) === null ||
        !Number.isInteger(eventCount) ||
        eventCount < 0 ||
        !Number.isInteger(engagedPlayCount) ||
        engagedPlayCount < 0 ||
        engagedPlayCount > eventCount ||
        !Number.isFinite(listeningMinutes) ||
        listeningMinutes < 0 ||
        !Number.isInteger(distinctTracks) ||
        distinctTracks < 0
      ) {
        return null;
      }
      return {
        month,
        event_count: eventCount,
        engaged_play_count: engagedPlayCount,
        listening_minutes: listeningMinutes,
        distinct_tracks: distinctTracks,
      };
    })
    .filter(Boolean)
    .sort((left, right) =>
      left.month < right.month ? -1 : left.month > right.month ? 1 : 0,
    );
  const monthIndexes = months.map((month) => studioMonthIndex(month.month));
  if (
    firstIndex === null ||
    lastIndex === null ||
    firstIndex > lastIndex ||
    !Number.isInteger(retainedSpanMonths) ||
    retainedSpanMonths < 1 ||
    !Number.isInteger(representedMonthCount) ||
    representedMonthCount < 1 ||
    representedMonthCount > 240 ||
    !Number.isInteger(activeMonthCount) ||
    activeMonthCount < 1 ||
    !Number.isInteger(omittedEarlierMonthCount) ||
    omittedEarlierMonthCount < 0 ||
    !Number.isFinite(peakListeningMinutes) ||
    peakListeningMinutes < 0 ||
    months.length !== rawMonths.length ||
    months.length !== representedMonthCount ||
    months[0]?.month !== firstMonth ||
    months.at(-1)?.month !== lastMonth ||
    retainedSpanMonths !== representedMonthCount + omittedEarlierMonthCount ||
    activeMonthCount !== months.filter((month) => month.event_count > 0).length ||
    peakListeningMinutes !== Math.max(...months.map((month) => month.listening_minutes)) ||
    monthIndexes.some(
      (index, position) =>
        index === null ||
        (position > 0 && index !== monthIndexes[position - 1] + 1),
    )
  ) {
    return emptyMonthlyActivity();
  }
  const previewMonths = months.slice(-72);
  return {
    ready: true,
    timezone: "UTC",
    first_month: firstMonth,
    last_month: lastMonth,
    preview_first_month: previewMonths[0].month,
    retained_span_months: retainedSpanMonths,
    represented_month_count: representedMonthCount,
    active_month_count: activeMonthCount,
    omitted_earlier_month_count: omittedEarlierMonthCount,
    preview_month_count: previewMonths.length,
    preview_active_month_count: previewMonths.filter(
      (month) => month.event_count > 0,
    ).length,
    preview_omitted_month_count: months.length - previewMonths.length,
    peak_listening_minutes: Math.max(
      ...previewMonths.map((month) => month.listening_minutes),
    ),
    months: previewMonths,
  };
}

function studioSeasonIndex(value) {
  if (!/^\d{4}-Q[1-4]$/u.test(value)) return null;
  const year = Number(value.slice(0, 4));
  const quarter = Number(value.slice(6));
  if (!Number.isInteger(year) || year < 1900 || year > 9999) return null;
  return year * 4 + quarter - 1;
}

function emptyListeningSeasons() {
  return {
    ready: false,
    timezone: "UTC",
    retained_season_count: 0,
    represented_season_count: 0,
    active_season_count: 0,
    represented_active_season_count: 0,
    omitted_earlier_season_count: 0,
    omitted_earlier_active_season_count: 0,
    preview_season_count: 0,
    preview_active_season_count: 0,
    preview_omitted_season_count: 0,
    preview_omitted_active_season_count: 0,
    seasons: [],
  };
}

function safeListeningSeasons(profile) {
  const value = profile?.listening_behavior?.listening_seasons;
  if (
    !value ||
    typeof value !== "object" ||
    value.timezone !== "UTC" ||
    value.alignment !== "calendar_quarter" ||
    value.season_length_months !== 3
  ) {
    return emptyListeningSeasons();
  }
  const retainedFirstSeason = boundedStudioText(
    value.retained_first_season,
    7,
  );
  const representedFirstSeason = boundedStudioText(
    value.represented_first_season,
    7,
  );
  const lastSeason = boundedStudioText(value.last_season, 7);
  const retainedFirstIndex = studioSeasonIndex(retainedFirstSeason);
  const representedFirstIndex = studioSeasonIndex(representedFirstSeason);
  const lastIndex = studioSeasonIndex(lastSeason);
  const retainedSeasonCount = value.retained_season_count;
  const representedSeasonCount = value.represented_season_count;
  const activeSeasonCount = value.active_season_count;
  const representedActiveSeasonCount = value.represented_active_season_count;
  const omittedEarlierSeasonCount = value.omitted_earlier_season_count;
  const omittedEarlierActiveSeasonCount =
    value.omitted_earlier_active_season_count;
  const rawSeasons = Array.isArray(value.seasons) ? value.seasons : [];
  const seasons = rawSeasons
    .map((item) => {
      const key = boundedStudioText(item?.key, 7);
      const index = studioSeasonIndex(key);
      const startMonth = boundedStudioText(item?.start_month, 7);
      const endMonth = boundedStudioText(item?.end_month, 7);
      const startMonthIndex = studioMonthIndex(startMonth);
      const endMonthIndex = studioMonthIndex(endMonth);
      const retainedMonthCount = item?.retained_month_count;
      const activeMonthCount = item?.active_month_count;
      const eventCount = item?.event_count;
      const engagedPlayCount = item?.engaged_play_count;
      const listeningMinutes = item?.listening_minutes;
      const distinctTracks = item?.distinct_tracks;
      const firstObservedTracks = item?.first_observed_tracks;
      const returningTracks = item?.returning_tracks;
      const leadingArtist = boundedStudioText(item?.leading_artist?.name);
      const leadingEventCount = item?.leading_artist?.event_count;
      const leadingEngagedPlayCount =
        item?.leading_artist?.engaged_play_count;
      const leadingListeningMinutes =
        item?.leading_artist?.listening_minutes;
      const leadingDistinctTracks = item?.leading_artist?.distinct_tracks;
      const signatureTitle = boundedStudioText(item?.signature_track?.label);
      const signatureArtist = boundedStudioText(
        item?.signature_track?.artist_credit,
      );
      const signaturePlayCount = item?.signature_track?.play_count;
      const signatureEngagedPlayCount =
        item?.signature_track?.engaged_play_count;
      const signatureListeningMinutes =
        item?.signature_track?.listening_minutes;
      const signatureExplicitSkips = item?.signature_track?.explicit_skips;
      const active = Number.isInteger(eventCount) && eventCount > 0;
      if (
        index === null ||
        startMonthIndex === null ||
        endMonthIndex === null ||
        startMonthIndex > endMonthIndex ||
        Math.floor(startMonthIndex / 3) !== index ||
        Math.floor(endMonthIndex / 3) !== index ||
        !Number.isInteger(retainedMonthCount) ||
        retainedMonthCount < 1 ||
        retainedMonthCount > 3 ||
        retainedMonthCount !== endMonthIndex - startMonthIndex + 1 ||
        !Number.isInteger(activeMonthCount) ||
        activeMonthCount < 0 ||
        activeMonthCount > retainedMonthCount ||
        !Number.isInteger(eventCount) ||
        eventCount < 0 ||
        !Number.isInteger(engagedPlayCount) ||
        engagedPlayCount < 0 ||
        engagedPlayCount > eventCount ||
        !Number.isFinite(listeningMinutes) ||
        listeningMinutes < 0 ||
        !Number.isInteger(distinctTracks) ||
        distinctTracks < 0 ||
        distinctTracks > eventCount ||
        !Number.isInteger(firstObservedTracks) ||
        firstObservedTracks < 0 ||
        !Number.isInteger(returningTracks) ||
        returningTracks < 0 ||
        firstObservedTracks + returningTracks !== distinctTracks ||
        (!active &&
          (activeMonthCount !== 0 ||
            engagedPlayCount !== 0 ||
            listeningMinutes !== 0 ||
            distinctTracks !== 0 ||
            leadingArtist !== null ||
            signatureTitle !== null)) ||
        (active &&
          (activeMonthCount < 1 ||
            !leadingArtist ||
            !signatureTitle ||
            !signatureArtist ||
            !Number.isInteger(leadingEventCount) ||
            leadingEventCount < 1 ||
            leadingEventCount > eventCount ||
            !Number.isInteger(leadingEngagedPlayCount) ||
            leadingEngagedPlayCount < 0 ||
            leadingEngagedPlayCount > leadingEventCount ||
            leadingEngagedPlayCount > engagedPlayCount ||
            !Number.isFinite(leadingListeningMinutes) ||
            leadingListeningMinutes < 0 ||
            leadingListeningMinutes > listeningMinutes ||
            !Number.isInteger(leadingDistinctTracks) ||
            leadingDistinctTracks < 1 ||
            leadingDistinctTracks > distinctTracks ||
            !Number.isInteger(signaturePlayCount) ||
            signaturePlayCount < 1 ||
            signaturePlayCount > eventCount ||
            !Number.isInteger(signatureEngagedPlayCount) ||
            signatureEngagedPlayCount < 0 ||
            !Number.isInteger(signatureExplicitSkips) ||
            signatureExplicitSkips < 0 ||
            signatureEngagedPlayCount + signatureExplicitSkips !==
              signaturePlayCount ||
            signatureEngagedPlayCount > engagedPlayCount ||
            !Number.isFinite(signatureListeningMinutes) ||
            signatureListeningMinutes < 0 ||
            signatureListeningMinutes > listeningMinutes))
      ) {
        return null;
      }
      return {
        key,
        start_month: startMonth,
        end_month: endMonth,
        retained_month_count: retainedMonthCount,
        active_month_count: activeMonthCount,
        event_count: eventCount,
        listening_minutes: listeningMinutes,
        distinct_tracks: distinctTracks,
        first_observed_tracks: firstObservedTracks,
        returning_tracks: returningTracks,
        ...(active
          ? {
              leading_artist: leadingArtist,
              signature_track: {
                title: signatureTitle,
                artist: signatureArtist,
              },
            }
          : {}),
      };
    })
    .filter(Boolean);
  const indexes = seasons.map((season) => studioSeasonIndex(season.key));
  if (
    retainedFirstIndex === null ||
    representedFirstIndex === null ||
    lastIndex === null ||
    retainedFirstIndex > representedFirstIndex ||
    representedFirstIndex > lastIndex ||
    !Number.isInteger(retainedSeasonCount) ||
    retainedSeasonCount < 1 ||
    !Number.isInteger(representedSeasonCount) ||
    representedSeasonCount < 1 ||
    representedSeasonCount > 80 ||
    !Number.isInteger(activeSeasonCount) ||
    activeSeasonCount < 1 ||
    !Number.isInteger(representedActiveSeasonCount) ||
    representedActiveSeasonCount < 1 ||
    !Number.isInteger(omittedEarlierSeasonCount) ||
    omittedEarlierSeasonCount < 0 ||
    !Number.isInteger(omittedEarlierActiveSeasonCount) ||
    omittedEarlierActiveSeasonCount < 0 ||
    seasons.length !== rawSeasons.length ||
    seasons.length !== representedSeasonCount ||
    indexes[0] !== representedFirstIndex ||
    indexes.at(-1) !== lastIndex ||
    indexes.some(
      (index, position) =>
        index === null ||
        (position > 0 && index !== indexes[position - 1] + 1),
    ) ||
    retainedSeasonCount !== lastIndex - retainedFirstIndex + 1 ||
    representedSeasonCount !== lastIndex - representedFirstIndex + 1 ||
    omittedEarlierSeasonCount !== representedFirstIndex - retainedFirstIndex ||
    activeSeasonCount !==
      representedActiveSeasonCount + omittedEarlierActiveSeasonCount ||
    representedActiveSeasonCount !==
      seasons.filter((season) => season.event_count > 0).length ||
    activeSeasonCount > retainedSeasonCount ||
    representedActiveSeasonCount > representedSeasonCount ||
    omittedEarlierActiveSeasonCount > omittedEarlierSeasonCount
  ) {
    return emptyListeningSeasons();
  }
  const previewSeasons = seasons.slice(-6);
  const previewActiveSeasonCount = previewSeasons.filter(
    (season) => season.event_count > 0,
  ).length;
  return {
    ready: previewActiveSeasonCount > 0,
    timezone: "UTC",
    retained_first_season: retainedFirstSeason,
    represented_first_season: representedFirstSeason,
    last_season: lastSeason,
    retained_season_count: retainedSeasonCount,
    represented_season_count: representedSeasonCount,
    active_season_count: activeSeasonCount,
    represented_active_season_count: representedActiveSeasonCount,
    omitted_earlier_season_count: omittedEarlierSeasonCount,
    omitted_earlier_active_season_count: omittedEarlierActiveSeasonCount,
    preview_season_count: previewSeasons.length,
    preview_active_season_count: previewActiveSeasonCount,
    preview_omitted_season_count: seasons.length - previewSeasons.length,
    preview_omitted_active_season_count:
      representedActiveSeasonCount - previewActiveSeasonCount,
    seasons: previewSeasons,
  };
}

function safeHistoricalReturns(profile) {
  const behavior = profile?.listening_behavior ?? {};
  const context = behavior.context ?? {};
  const minimumGapDays = Number.isInteger(
    context.historical_return_minimum_gap_days,
  ) && context.historical_return_minimum_gap_days >= 1
    ? context.historical_return_minimum_gap_days
    : null;
  const tracks = (Array.isArray(behavior.historical_return_tracks)
    ? behavior.historical_return_tracks
    : [])
    .map((candidate) => {
      const title = boundedStudioText(candidate?.label);
      const artist = boundedStudioText(candidate?.artist_credit);
      const returnCount = candidate?.return_count;
      const longestGapDays = candidate?.longest_gap_days;
      const latestReturnGapDays = candidate?.latest_return_gap_days;
      const latestReturnAt = candidate?.latest_return_at;
      if (
        !title ||
        !artist ||
        !Number.isInteger(returnCount) ||
        returnCount < 1 ||
        !Number.isInteger(longestGapDays) ||
        longestGapDays < 1 ||
        !Number.isInteger(latestReturnGapDays) ||
        latestReturnGapDays < 1 ||
        latestReturnGapDays > longestGapDays ||
        typeof latestReturnAt !== "string" ||
        !Number.isFinite(Date.parse(latestReturnAt))
      ) {
        return null;
      }
      return {
        title,
        artist,
        return_count: returnCount,
        longest_gap_days: longestGapDays,
        latest_return_gap_days: latestReturnGapDays,
        latest_return_date: new Date(latestReturnAt)
          .toISOString()
          .slice(0, 10),
      };
    })
    .filter(Boolean)
    .slice(0, 4);
  return {
    ready: tracks.length > 0,
    return_track_count: tracks.length,
    minimum_gap_days: minimumGapDays,
    tracks,
  };
}

function safeBackToBack(profile) {
  const behavior = profile?.listening_behavior ?? {};
  const context = behavior.context ?? {};
  const minimumConsecutivePlays = Number.isInteger(
    context.back_to_back_minimum_consecutive_plays,
  ) && context.back_to_back_minimum_consecutive_plays >= 2
    ? context.back_to_back_minimum_consecutive_plays
    : null;
  const minimumPlayedSeconds = Number.isInteger(
    context.back_to_back_minimum_played_seconds,
  ) && context.back_to_back_minimum_played_seconds >= 1
    ? context.back_to_back_minimum_played_seconds
    : null;
  const maximumGapMinutes = Number.isInteger(
    context.back_to_back_maximum_gap_minutes,
  ) && context.back_to_back_maximum_gap_minutes >= 1
    ? context.back_to_back_maximum_gap_minutes
    : null;
  const tracks = (Array.isArray(behavior.back_to_back_tracks)
    ? behavior.back_to_back_tracks
    : [])
    .map((candidate) => {
      const title = boundedStudioText(candidate?.label);
      const artist = boundedStudioText(candidate?.artist_credit);
      const burstCount = candidate?.burst_count;
      const maximumConsecutive = candidate?.maximum_consecutive_plays;
      const playsInBursts = candidate?.plays_in_bursts;
      const listeningMinutes = candidate?.listening_minutes_in_bursts;
      const latestBurstAt = candidate?.latest_burst_at;
      if (
        !title ||
        !artist ||
        !Number.isInteger(burstCount) ||
        burstCount < 1 ||
        !Number.isInteger(maximumConsecutive) ||
        maximumConsecutive < 2 ||
        !Number.isInteger(playsInBursts) ||
        playsInBursts < maximumConsecutive ||
        playsInBursts < burstCount * 2 ||
        !Number.isFinite(listeningMinutes) ||
        listeningMinutes < 0 ||
        typeof latestBurstAt !== "string" ||
        !Number.isFinite(Date.parse(latestBurstAt)) ||
        candidate?.sequence_signal !== "adjacent retained plays"
      ) {
        return null;
      }
      return {
        title,
        artist,
        burst_count: burstCount,
        maximum_consecutive_plays: maximumConsecutive,
        plays_in_bursts: playsInBursts,
        listening_minutes_in_bursts: listeningMinutes,
        latest_burst_date: new Date(latestBurstAt)
          .toISOString()
          .slice(0, 10),
      };
    })
    .filter(Boolean)
    .slice(0, 4);
  return {
    ready: tracks.length > 0,
    track_count: tracks.length,
    minimum_consecutive_plays: minimumConsecutivePlays,
    minimum_played_seconds: minimumPlayedSeconds,
    maximum_gap_minutes: maximumGapMinutes,
    tracks,
  };
}

function safeContinuity(profile) {
  const behavior = profile?.listening_behavior ?? {};
  const relationships = (Array.isArray(behavior.artist_relationships)
    ? behavior.artist_relationships
    : [])
    .map((item) => {
      const name = boundedStudioText(item?.name);
      const firstYear = item?.first_year;
      const lastYear = item?.last_year;
      const activeYears = item?.active_years;
      const spanYears = item?.span_years;
      if (
        !name ||
        !Number.isInteger(firstYear) ||
        !Number.isInteger(lastYear) ||
        firstYear < 1900 ||
        lastYear > 2100 ||
        firstYear > lastYear ||
        !Number.isInteger(activeYears) ||
        activeYears < 2 ||
        !Number.isInteger(spanYears) ||
        spanYears < 2
      ) {
        return null;
      }
      return {
        name,
        first_year: firstYear,
        last_year: lastYear,
        active_years: activeYears,
        span_years: spanYears,
      };
    })
    .filter(Boolean)
    .slice(0, 4);
  const transitions = (Array.isArray(behavior.year_transitions)
    ? behavior.year_transitions
    : [])
    .map((item) => {
      const fromYear = item?.from_year;
      const toYear = item?.to_year;
      const retained = item?.retained_artist_count;
      const introduced = item?.new_artist_count;
      const continuity = item?.continuity_percent;
      if (
        !Number.isInteger(fromYear) ||
        !Number.isInteger(toYear) ||
        fromYear < 1900 ||
        toYear > 2100 ||
        fromYear >= toYear ||
        !Number.isInteger(retained) ||
        retained < 0 ||
        !Number.isInteger(introduced) ||
        introduced < 0 ||
        !Number.isFinite(continuity) ||
        continuity < 0 ||
        continuity > 100
      ) {
        return null;
      }
      return {
        from_year: fromYear,
        to_year: toYear,
        retained_artist_count: retained,
        new_artist_count: introduced,
        continuity_percent: continuity,
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.to_year - right.to_year)
    .slice(-12);
  return {
    ready: relationships.length > 0 || transitions.length > 0,
    relationship_count: relationships.length,
    transition_count: transitions.length,
    relationships,
    latest_transition: transitions.at(-1) ?? null,
  };
}

function safeListeningPatterns(profile) {
  const behavior = profile?.listening_behavior ?? {};
  const releases = (Array.isArray(behavior.release_depth)
    ? behavior.release_depth
    : [])
    .map((item) => {
      const title = boundedStudioText(item?.title);
      const artist = boundedStudioText(item?.artist_credit);
      const distinctTracks = item?.distinct_tracks;
      const activeYears = item?.active_years;
      if (
        !title ||
        !artist ||
        !Number.isInteger(distinctTracks) ||
        distinctTracks < 1 ||
        !Number.isInteger(activeYears) ||
        activeYears < 1
      ) {
        return null;
      }
      return {
        title,
        artist_credit: artist,
        distinct_tracks: distinctTracks,
        active_years: activeYears,
      };
    })
    .filter(Boolean)
    .slice(0, 4);
  const value = behavior.session_summary;
  const session = value &&
    value.source === "spotify_extended_history" &&
    value.method === "track_stop_gap" &&
    Number.isInteger(value.gap_minutes) &&
    value.gap_minutes >= 1 &&
    Number.isInteger(value.session_count) &&
    value.session_count >= 1 &&
    Number.isFinite(value.median_plays) &&
    value.median_plays >= 0 &&
    Number.isFinite(value.median_listening_minutes) &&
    value.median_listening_minutes >= 0 &&
    Number.isFinite(value.extended_sequence_percent) &&
    value.extended_sequence_percent >= 0 &&
    value.extended_sequence_percent <= 100 &&
    Number.isInteger(value.extended_sequence_minimum_plays) &&
    value.extended_sequence_minimum_plays >= 2
    ? {
        gap_minutes: value.gap_minutes,
        session_count: value.session_count,
        median_plays: value.median_plays,
        median_listening_minutes: value.median_listening_minutes,
        extended_sequence_minimum_plays:
          value.extended_sequence_minimum_plays,
        extended_sequence_percent: value.extended_sequence_percent,
      }
    : null;
  return {
    ready: releases.length > 0 || session !== null,
    release_count: releases.length,
    releases,
    session,
  };
}

function publicCorrection(value) {
  return {
    correction_id: value.correction_id,
    state: value.state ?? "active",
    entity_type: value.entity_type,
    label: value.label,
    ...(value.artist_credit ? { artist_credit: value.artist_credit } : {}),
    stance: value.stance,
    occurred_at: value.occurred_at,
    ...(value.note ? { note: value.note } : {}),
  };
}

function profileSnapshot(store, subjectId) {
  const status = store.subjectDataStatus({ subjectId });
  const listening = store.profileSummary({ subjectId, maxItems: 10 });
  const profile = createListeningHistoryProfileProjection(listening, {
    maxItems: 10,
  });
  return {
    profile,
    response: {
      profile_kind: "private",
      state: status.state,
      coverage: safeCoverage(profile),
      time_machine: safeTimeMachine(profile),
      listening_pulse: safeMonthlyActivity(profile),
      listening_seasons: safeListeningSeasons(profile),
      historical_returns: safeHistoricalReturns(profile),
      back_to_back: safeBackToBack(profile),
      continuity: safeContinuity(profile),
      listening_patterns: safeListeningPatterns(profile),
      active_corrections: status.active_taste_assertions,
      corrections: store
        .listListenerCorrections({ subjectId, limit: 50 })
        .map(publicCorrection),
    },
  };
}

function profileFingerprint(profile) {
  // An import receipt describes one operation, not the current cumulative profile.
  const { preview_source, ...currentProfile } = profile;
  return createHash("sha256").update(JSON.stringify(currentProfile)).digest("hex");
}

function emptyProfileResponse() {
  return {
    state: "empty",
    coverage: {
      effective_listening_events: 0,
      listening_hours: 0,
      distinct_tracks: 0,
      cross_format_track_links: 0,
      cross_format_linked_events: 0,
      cross_format_ambiguous_tracks: 0,
      cross_format_ambiguous_events: 0,
    },
    time_machine: safeTimeMachine(null),
    listening_pulse: safeMonthlyActivity(null),
    listening_seasons: safeListeningSeasons(null),
    historical_returns: safeHistoricalReturns(null),
    back_to_back: safeBackToBack(null),
    continuity: safeContinuity(null),
    listening_patterns: safeListeningPatterns(null),
    active_corrections: 0,
    corrections: [],
    tasteprint_url: null,
    tasteprint_card_url: null,
  };
}

function studioTimestamp(now) {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError("Moondog Studio clock is invalid.");
  }
  return value.toISOString();
}

function publicImportError(error) {
  if (error instanceof StudioHttpError) return error;
  if (error instanceof TypeError) {
    return new StudioHttpError(
      422,
      "Choose one or two distinct readable Spotify history ZIP archives.",
    );
  }
  if (
    typeof error?.code === "string" &&
    (error.code.startsWith("spotify_") ||
      error.code.startsWith("listenbrainz_"))
  ) {
    return new StudioHttpError(422, error.message);
  }
  if (error?.code === "projection_source_invalid") {
    return new StudioHttpError(
      409,
      "The existing Apple Music source must be repaired before this import can join the same local identity.",
    );
  }
  return new StudioHttpError(
    500,
    "Moondog could not complete the local import. The temporary source copy was removed.",
  );
}

function publicProfileError(error) {
  if (error instanceof StudioHttpError) return error;
  if (error?.code === "listener_correction_not_found") {
    return new StudioHttpError(404, "That profile correction was not found.");
  }
  if (
    error?.code === "listener_correction_inactive" ||
    error?.code === "listener_correction_time_invalid"
  ) {
    return new StudioHttpError(409, error.message);
  }
  if (error instanceof TypeError) {
    return new StudioHttpError(
      422,
      "Choose a valid artist or track, a like or avoid stance, and keep the text within the displayed limits.",
    );
  }
  return new StudioHttpError(
    500,
    "Moondog could not finish the private profile update. Check the current correction list before retrying.",
  );
}

async function openBrowser(url) {
  const [command, args] = process.platform === "darwin"
    ? ["open", [url]]
    : process.platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : ["xdg-open", [url]];
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export async function startMoondogStudio({
  host = MOONDOG_STUDIO_HOST,
  port = 0,
  demoOnly = false,
  archivePath = null,
  archivePaths = null,
  environment = process.env,
  maximumArchiveBytes = MOONDOG_STUDIO_MAXIMUM_ARCHIVE_BYTES,
  maximumHistoryJsonBytes = MOONDOG_STUDIO_MAXIMUM_HISTORY_JSON_BYTES,
  temporaryRoot = tmpdir(),
  brandImagePath = defaultBrandImagePath,
  now = () => new Date(),
  openStore = openListeningHistoryStore,
  importArchive = persistTasteFromSpotifyArchive,
  importListenBrainzHistory = persistTasteFromListenBrainzHistory,
  createDemo = createFictionalHistoryDemo,
  projectArchive = projectTasteFromSpotifyArchive,
  projectArchives = projectTasteFromSpotifyArchives,
  writeArtifact = writeTasteprintArtifact,
} = {}) {
  if (host !== MOONDOG_STUDIO_HOST) {
    throw new TypeError("Moondog Studio may only listen on 127.0.0.1.");
  }
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError("Moondog Studio port is invalid.");
  }
  if (typeof demoOnly !== "boolean") {
    throw new TypeError("Moondog Studio demo-only mode is invalid.");
  }
  const selectedArchivePaths = selectedSpotifyArchivePaths({
    archivePath,
    archivePaths,
  });
  if (demoOnly && selectedArchivePaths.length > 0) {
    throw new TypeError(
      "Moondog Studio cannot combine a fictional tour with a private archive session.",
    );
  }
  if (!Number.isSafeInteger(maximumArchiveBytes) || maximumArchiveBytes < 4) {
    throw new TypeError("Moondog Studio archive size limit is invalid.");
  }
  if (
    !Number.isSafeInteger(maximumHistoryJsonBytes) ||
    maximumHistoryJsonBytes < 1
  ) {
    throw new TypeError("Moondog Studio history JSON size limit is invalid.");
  }
  if (typeof temporaryRoot !== "string" || !path.isAbsolute(temporaryRoot)) {
    throw new TypeError("Moondog Studio temporary root must be absolute.");
  }

  const sessionToken = sessionSecret();
  const archiveSession = selectedArchivePaths.length > 0;
  const brandImage = await readFile(brandImagePath);
  const demoTasteprint = renderTasteprintHtml(
    createPublicTasteprintDemoProfile(),
    {
      generatedAt: PUBLIC_TASTEPRINT_DEMO_GENERATED_AT,
      syntheticDemo: true,
    },
  );
  const demoTasteprintCard = renderTasteprintCardHtml(
    createPublicTasteprintDemoProfile(),
    {
      generatedAt: PUBLIC_TASTEPRINT_DEMO_GENERATED_AT,
      syntheticDemo: true,
    },
  );
  let origin = null;
  let profileChanging = false;
  let latestArtifact = null;
  let demoStarted = demoOnly || archiveSession;
  let interactiveSessionPromise = null;

  const loadInteractiveSession = () => {
    if (interactiveSessionPromise) return interactiveSessionPromise;
    const loaded = archiveSession
      ? createPrivateArchiveSession({
          archivePaths: selectedArchivePaths,
          maximumArchiveBytes,
          capturedAt: studioTimestamp(now),
          projectArchive,
          projectArchives,
        })
      : createDemo({ temporaryRoot });
    interactiveSessionPromise = loaded
      .then(({ profile, proof, source }) => ({
        profileKind: archiveSession ? "private_session" : "synthetic_demo",
        ...(proof ? { proof } : {}),
        ...(source ? { source } : {}),
        session: new InteractiveTasteprintDemoSession({
          baseProfileFactory: () => structuredClone(profile),
          kind: archiveSession ? "private_session" : "demo",
        }),
      }))
      .catch((error) => {
        interactiveSessionPromise = null;
        throw error;
      });
    return interactiveSessionPromise;
  };

  const latestTasteprintUrl = () => latestArtifact
    ? `/tasteprint?session=${sessionToken}&artifact=${latestArtifact.id}`
    : null;
  const latestTasteprintCardUrl = () => latestArtifact
    ? `/tasteprint-card?session=${sessionToken}&artifact=${latestArtifact.id}`
    : null;

  const keepRenderedTasteprint = (
    profile,
    generatedAt,
    { kind = "private", syntheticDemo = false } = {},
  ) => {
    const artifactId = sessionSecret();
    latestArtifact = {
      id: artifactId,
      kind,
      profileFingerprint: profileFingerprint(profile),
      html: Buffer.from(
        renderTasteprintHtml(profile, { generatedAt, syntheticDemo }),
      ),
      cardHtml: Buffer.from(
        renderTasteprintCardHtml(profile, { generatedAt, syntheticDemo }),
      ),
    };
    return latestTasteprintUrl();
  };

  const writeRenderedTasteprint = async (profile, generatedAt) => {
    const cardHtml = Buffer.from(
      renderTasteprintCardHtml(profile, { generatedAt }),
    );
    const artifact = await writeArtifact(profile, {
      environment,
      generatedAt,
    });
    latestArtifact = {
      id: sessionSecret(),
      kind: "private",
      profileFingerprint: profileFingerprint(profile),
      path: artifact.path,
      cardHtml,
    };
    return latestTasteprintUrl();
  };

  const readPrivateProfile = async () => {
    if (demoOnly || archiveSession) return null;
    const clearPrivateArtifact = () => {
      if (latestArtifact?.kind === "private") latestArtifact = null;
      return null;
    };
    const databasePath = resolveListeningHistoryPath(environment);
    if (!(await pathExists(databasePath))) return clearPrivateArtifact();
    const store = await openStore({ environment });
    try {
      const subjectId = store.localSubjectId();
      if (!subjectId) return clearPrivateArtifact();
      const snapshot = profileSnapshot(store, subjectId);
      if (snapshot.response.state !== "ready") return clearPrivateArtifact();
      if (
        latestArtifact?.kind !== "private" ||
        latestArtifact.profileFingerprint !== profileFingerprint(snapshot.profile)
      ) {
        keepRenderedTasteprint(snapshot.profile, studioTimestamp(now), {
          kind: "private",
        });
      }
      return {
        ...snapshot.response,
        tasteprint_url: latestTasteprintUrl(),
        tasteprint_card_url: latestTasteprintCardUrl(),
      };
    } finally {
      store.close();
    }
  };

  const interactiveProfileResponse = (interactive, profile) => ({
    profile_kind: interactive.profileKind,
    ...(interactive.proof ? { demo_proof: interactive.proof } : {}),
    ...(interactive.source ? { source: interactive.source } : {}),
    state: "ready",
    coverage: safeCoverage(profile),
    time_machine: safeTimeMachine(profile),
    listening_pulse: safeMonthlyActivity(profile),
    listening_seasons: safeListeningSeasons(profile),
    historical_returns: safeHistoricalReturns(profile),
    back_to_back: safeBackToBack(profile),
    continuity: safeContinuity(profile),
    listening_patterns: safeListeningPatterns(profile),
    active_corrections: interactive.session.activeCount,
    corrections: interactive.session.corrections(),
    tasteprint_url: latestTasteprintUrl(),
    tasteprint_card_url: latestTasteprintCardUrl(),
  });

  const readInteractiveProfile = async () => {
    const interactive = await loadInteractiveSession();
    const profile = interactive.session.profile();
    if (latestArtifact?.kind !== interactive.profileKind) {
      keepRenderedTasteprint(profile, studioTimestamp(now), {
        kind: interactive.profileKind,
        syntheticDemo: interactive.profileKind === "synthetic_demo",
      });
    }
    return interactiveProfileResponse(interactive, profile);
  };

  const refreshInteractiveProfile = async (generatedAt) => {
    const interactive = await loadInteractiveSession();
    const profile = interactive.session.profile();
    const tasteprintUrl = keepRenderedTasteprint(profile, generatedAt, {
      kind: interactive.profileKind,
      syntheticDemo: interactive.profileKind === "synthetic_demo",
    });
    return {
      ...interactiveProfileResponse(interactive, profile),
      tasteprint_url: tasteprintUrl,
    };
  };

  const readCurrentProfile = async () =>
    (await readPrivateProfile()) ??
    (demoStarted ? await readInteractiveProfile() : emptyProfileResponse());

  if (archiveSession) await loadInteractiveSession();

  const server = createServer(async (request, response) => {
    let requestUrl;
    try {
      requestUrl = new URL(request.url ?? "/", origin);
    } catch {
      sendNotFound(response);
      return;
    }
    const queryToken = requestUrl.searchParams.get("session");

    if (request.method === "GET" && requestUrl.pathname === "/") {
      if (!validToken(queryToken, sessionToken)) {
        sendNotFound(response);
        return;
      }
      const nonce = randomBytes(18).toString("base64url");
      const requestedCapture = requestUrl.searchParams.get("capture");
      const html = renderStudioPage({
        sessionToken,
        nonce,
        maximumArchiveBytes,
        maximumHistoryJsonBytes,
        demoOnly,
        archiveSession,
        archiveCount: selectedArchivePaths.length,
        captureMode: demoOnly && new Set([
          "time-machine",
          "listening-pulse",
          "listening-seasons",
          "historical-returns",
          "listening-patterns",
          "correction",
        ]).has(requestedCapture)
          ? requestedCapture
          : demoOnly && new Set(["1", "hero"]).has(requestedCapture)
            ? "hero"
            : null,
      });
      send(response, 200, html, {
        ...baseHeaders("text/html; charset=utf-8"),
        "Content-Security-Policy": [
          "default-src 'none'",
          `style-src 'nonce-${nonce}'`,
          `script-src 'nonce-${nonce}'`,
          "img-src 'self'",
          "connect-src 'self'",
          "object-src 'none'",
          "base-uri 'none'",
          "form-action 'none'",
          "frame-ancestors 'none'",
        ].join("; "),
      });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/brand.png") {
      if (!validToken(queryToken, sessionToken)) {
        sendNotFound(response);
        return;
      }
      send(response, 200, brandImage, {
        ...baseHeaders("image/png"),
        "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      });
      return;
    }

    if (
      request.method === "GET" &&
      requestUrl.pathname === "/demo-tasteprint"
    ) {
      if (!validToken(queryToken, sessionToken)) {
        sendNotFound(response);
        return;
      }
      send(response, 200, demoTasteprint, {
        ...baseHeaders("text/html; charset=utf-8"),
        "Content-Disposition": "inline; filename=\"moondog-fictional-tasteprint.html\"",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      });
      return;
    }

    if (
      request.method === "GET" &&
      requestUrl.pathname === "/demo-tasteprint-card"
    ) {
      if (!validToken(queryToken, sessionToken)) {
        sendNotFound(response);
        return;
      }
      const download = requestUrl.searchParams.get("download") === "1";
      send(response, 200, demoTasteprintCard, {
        ...baseHeaders("text/html; charset=utf-8"),
        "Content-Disposition": `${download ? "attachment" : "inline"}; filename="moondog-fictional-tasteprint-card.html"`,
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      });
      return;
    }

    if (
      request.method === "GET" &&
      new Set(["/tasteprint", "/tasteprint-card"]).has(requestUrl.pathname)
    ) {
      const artifactId = requestUrl.searchParams.get("artifact");
      if (
        !validToken(queryToken, sessionToken) ||
        !latestArtifact ||
        !validToken(artifactId, latestArtifact.id)
      ) {
        sendNotFound(response);
        return;
      }
      try {
        const cardRequested = requestUrl.pathname === "/tasteprint-card";
        const download = cardRequested &&
          requestUrl.searchParams.get("download") === "1";
        const html = cardRequested
          ? latestArtifact.cardHtml
          : latestArtifact.html ?? await readFile(latestArtifact.path);
        if (!html) throw new Error("The requested Studio artifact is unavailable.");
        send(response, 200, html, {
          ...baseHeaders("text/html; charset=utf-8"),
          "Content-Disposition": download
            ? `attachment; filename="${latestArtifact.kind === "synthetic_demo"
              ? "moondog-fictional"
              : latestArtifact.kind === "private_session"
                ? "moondog-private-session"
                : "moondog-private"}-tasteprint-card.html"`
            : "inline",
          "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        });
      } catch {
        sendNotFound(response);
      }
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/profile") {
      const headerToken = request.headers["x-moondog-session"];
      if (
        Array.isArray(headerToken) ||
        !validToken(headerToken, sessionToken)
      ) {
        sendNotFound(response);
        return;
      }
      try {
        sendJson(response, 200, await readCurrentProfile());
      } catch (error) {
        const publicError = publicProfileError(error);
        sendJson(response, publicError.statusCode, {
          state: "error",
          message: publicError.message,
        });
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/import") {
      const headerToken = request.headers["x-moondog-session"];
      if (
        Array.isArray(headerToken) ||
        !validToken(headerToken, sessionToken) ||
        request.headers.origin !== origin
      ) {
        request.resume();
        sendNotFound(response);
        return;
      }
      if (demoOnly) {
        request.resume();
        sendJson(response, 409, {
          state: "error",
          message: "The fictional Studio tour does not read or accept private listening history.",
        });
        return;
      }
      if (archiveSession) {
        request.resume();
        sendJson(response, 409, {
          state: "error",
          message: "This session-only Studio already read the explicitly supplied ZIP and does not accept another import.",
        });
        return;
      }
      const rawContentType = request.headers["content-type"];
      const contentType = Array.isArray(rawContentType)
        ? ""
        : rawContentType?.split(";", 1)[0].trim().toLocaleLowerCase("en-US");
      const importKind = contentType === "application/zip"
        ? "spotify"
        : contentType === "application/json"
          ? "listenbrainz"
          : null;
      if (!importKind) {
        request.resume();
        sendJson(response, 415, {
          state: "error",
          message: "Choose a Spotify .zip or ListenBrainz .json history file.",
        });
        return;
      }
      if (profileChanging) {
        request.resume();
        sendJson(response, 409, {
          state: "error",
          message: "Another local profile update is already running.",
        });
        return;
      }

      profileChanging = true;
      let uploadRoot = null;
      let store = null;
      try {
        const upload = importKind === "spotify"
          ? await receivePrivateZip(request, {
              maximumArchiveBytes,
              temporaryRoot,
            })
          : await receivePrivateListenBrainzJson(request, {
              maximumHistoryJsonBytes,
              temporaryRoot,
            });
        uploadRoot = upload.uploadRoot;
        const generatedAt = studioTimestamp(now);
        store = await openStore({ environment });
        const subjectId = await trustedLocalSubjectId(store);
        const imported = importKind === "spotify"
          ? await importArchive({
              archivePath: upload.archivePath,
              subjectId,
              store,
              capturedAt: generatedAt,
              maxItems: 10,
            })
          : await importListenBrainzHistory({
              historyPath: upload.historyPath,
              subjectId,
              store,
              capturedAt: generatedAt,
              maxItems: 10,
            });
        const profileStatus = store.subjectDataStatus({ subjectId });
        const corrections = store
          .listListenerCorrections({ subjectId, limit: 50 })
          .map(publicCorrection);
        store.close();
        store = null;
        const profile = {
          ...imported.profile,
          preview_source: imported.source,
        };
        const tasteprintUrl = await writeRenderedTasteprint(profile, generatedAt);
        demoStarted = false;
        await rm(uploadRoot, { recursive: true, force: true });
        uploadRoot = null;
        sendJson(response, 200, {
          profile_kind: "private",
          state: "ready",
          coverage: safeCoverage(profile),
          time_machine: safeTimeMachine(profile),
          listening_pulse: safeMonthlyActivity(profile),
          listening_seasons: safeListeningSeasons(profile),
          historical_returns: safeHistoricalReturns(profile),
          back_to_back: safeBackToBack(profile),
          continuity: safeContinuity(profile),
          listening_patterns: safeListeningPatterns(profile),
          source: {
            provider: importKind,
            data_scope: imported.source.data_scope,
            already_imported: imported.source.already_imported === true,
            effective_event_delta: Number.isInteger(
              imported.source.effective_event_delta,
            )
              ? imported.source.effective_event_delta
              : 0,
            ...(importKind === "spotify"
              ? {
                  superseded_events: Number.isInteger(
                    imported.source.superseded_events,
                  )
                    ? imported.source.superseded_events
                    : 0,
                }
              : {
                  mapped_track_refs: Number.isInteger(
                    imported.source.mapped_track_refs,
                  )
                    ? imported.source.mapped_track_refs
                    : 0,
                  events_with_played_duration: Number.isInteger(
                    imported.source.events_with_played_duration,
                  )
                    ? imported.source.events_with_played_duration
                    : 0,
                }),
          },
          active_corrections: profileStatus.active_taste_assertions,
          corrections,
          tasteprint_url: tasteprintUrl,
          tasteprint_card_url: latestTasteprintCardUrl(),
        });
      } catch (error) {
        request.resume();
        store?.close?.();
        store = null;
        if (uploadRoot) {
          await rm(uploadRoot, { recursive: true, force: true }).catch(() => {});
          uploadRoot = null;
        }
        const publicError = publicImportError(error);
        sendJson(response, publicError.statusCode, {
          state: "error",
          message: publicError.message,
        });
      } finally {
        store?.close?.();
        if (uploadRoot) {
          await rm(uploadRoot, { recursive: true, force: true }).catch(() => {});
        }
        profileChanging = false;
      }
      return;
    }

    if (
      request.method === "POST" &&
      new Set([
        "/api/corrections",
        "/api/corrections/retract",
        "/api/demo/start",
        "/api/demo/corrections",
        "/api/demo/corrections/retract",
        "/api/session/corrections",
        "/api/session/corrections/retract",
      ]).has(requestUrl.pathname)
    ) {
      const headerToken = request.headers["x-moondog-session"];
      if (
        Array.isArray(headerToken) ||
        !validToken(headerToken, sessionToken) ||
        request.headers.origin !== origin
      ) {
        request.resume();
        sendNotFound(response);
        return;
      }
      const contentType = String(request.headers["content-type"] ?? "")
        .split(";", 1)[0]
        .trim()
        .toLocaleLowerCase("en-US");
      if (contentType !== "application/json") {
        request.resume();
        sendJson(response, 415, {
          state: "error",
          message: "This local profile update must be JSON.",
        });
        return;
      }
      const demoRequest = requestUrl.pathname.startsWith("/api/demo/");
      const sessionRequest = requestUrl.pathname.startsWith("/api/session/");
      if (demoOnly && !demoRequest) {
        request.resume();
        sendJson(response, 409, {
          state: "error",
          message: "The fictional Studio tour accepts only in-memory demo corrections.",
        });
        return;
      }
      if (archiveSession && requestUrl.pathname === "/api/demo/start") {
        request.resume();
        sendJson(response, 409, {
          state: "error",
          message: "This session-only Studio already contains the supplied private history.",
        });
        return;
      }
      if (archiveSession && !sessionRequest) {
        request.resume();
        sendJson(response, 409, {
          state: "error",
          message: "This session-only Studio accepts only in-memory session corrections.",
        });
        return;
      }
      if (!archiveSession && sessionRequest) {
        request.resume();
        sendJson(response, 409, {
          state: "error",
          message: "Start Studio with --from before using session-only corrections.",
        });
        return;
      }
      if (profileChanging) {
        request.resume();
        sendJson(response, 409, {
          state: "error",
          message: "Another local profile update is already running.",
        });
        return;
      }

      profileChanging = true;
      let store = null;
      try {
        const input = await receiveJson(request);
        const generatedAt = studioTimestamp(now);
        if (requestUrl.pathname === "/api/demo/start") {
          exactObject(input, new Set());
          if (await readPrivateProfile()) {
            throw new StudioHttpError(
              409,
              "The fictional demo is available only before a private profile is ready.",
            );
          }
          demoStarted = true;
          sendJson(response, 200, await refreshInteractiveProfile(generatedAt));
          return;
        }

        if (demoRequest || sessionRequest) {
          if (!demoStarted) {
            throw new StudioHttpError(
              409,
              "Start the fictional profile before correcting it.",
            );
          }
          if (!archiveSession && await readPrivateProfile()) {
            throw new StudioHttpError(
              409,
              "A private profile is ready. Apply corrections to that profile instead.",
            );
          }
          const interactive = await loadInteractiveSession();
          let mutation;
          if (requestUrl.pathname.endsWith("/corrections")) {
            const correction = interactive.session.record({
              ...listenerCorrectionInput(input),
              occurredAt: generatedAt,
              recordedAt: generatedAt,
            });
            mutation = {
              state: "active",
              correction,
            };
          } else {
            exactObject(input, new Set(["correction_id"]));
            mutation = interactive.session.retract({
              correctionId: input.correction_id,
              occurredAt: generatedAt,
              recordedAt: generatedAt,
            });
          }
          sendJson(response, 200, {
            ...(await refreshInteractiveProfile(generatedAt)),
            mutation,
          });
          return;
        }

        const databasePath = resolveListeningHistoryPath(environment);
        if (!(await pathExists(databasePath))) {
          throw new StudioHttpError(
            409,
            "Import Spotify history before correcting the profile.",
          );
        }
        store = await openStore({ environment });
        const subjectId = store.localSubjectId();
        if (
          !subjectId ||
          store.subjectDataStatus({ subjectId }).state !== "ready"
        ) {
          throw new StudioHttpError(
            409,
            "Import Spotify history before correcting the profile.",
          );
        }
        let mutation;
        if (requestUrl.pathname === "/api/corrections") {
          const correction = store.recordListenerCorrection({
            subjectId,
            ...listenerCorrectionInput(input),
            occurredAt: generatedAt,
            recordedAt: generatedAt,
          });
          mutation = {
            state: "active",
            correction: publicCorrection(correction),
          };
        } else {
          exactObject(input, new Set(["correction_id"]));
          const retraction = store.retractListenerCorrection({
            subjectId,
            correctionId: input.correction_id,
            occurredAt: generatedAt,
            recordedAt: generatedAt,
          });
          mutation = {
            state: "retracted",
            correction_id: retraction.correction_id,
          };
        }
        const snapshot = profileSnapshot(store, subjectId);
        const tasteprintUrl = await writeRenderedTasteprint(
          snapshot.profile,
          generatedAt,
        );
        sendJson(response, 200, {
          ...snapshot.response,
          mutation,
          tasteprint_url: tasteprintUrl,
          tasteprint_card_url: latestTasteprintCardUrl(),
        });
      } catch (error) {
        request.resume();
        const publicError = publicProfileError(error);
        sendJson(response, publicError.statusCode, {
          state: "error",
          message: publicError.message,
        });
      } finally {
        store?.close?.();
        profileChanging = false;
      }
      return;
    }

    request.resume();
    sendNotFound(response);
  });

  server.requestTimeout = 10 * 60 * 1000;
  server.headersTimeout = 30 * 1000;
  server.maxRequestsPerSocket = 50;
  server.on("clientError", (_error, socket) => {
    if (!socket.destroyed) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise((resolve) => server.close(resolve));
    throw new Error("Moondog Studio did not receive a loopback address.");
  }
  origin = `http://${host}:${address.port}`;
  const url = `${origin}/?session=${sessionToken}`;
  let closed = false;

  return {
    origin,
    url,
    async close() {
      if (closed) return;
      closed = true;
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

export async function runMoondogStudio({
  demoOnly = false,
  archivePath = null,
  archivePaths = null,
  environment = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  launchBrowser = openBrowser,
} = {}) {
  const studio = await startMoondogStudio({
    environment,
    demoOnly,
    archivePath,
    archivePaths,
  });
  const archiveCount = archivePaths?.length ?? (archivePath ? 1 : 0);
  stdout.write(
    `Moondog Studio is ready at ${studio.url}\n${demoOnly
      ? "Fictional production-importer tour. No personal listening history is read or accepted, and no persistent profile is written."
      : archiveCount > 0
        ? `Session-only private profile. ${archiveCount === 1 ? "The original ZIP stays" : "Both original ZIPs stay"} untouched, no persistent profile is written, and all in-memory corrections disappear when Studio stops.`
        : "Private local session."} Press Ctrl+C to stop.\n`,
  );
  if (environment.MOONDOG_STUDIO_NO_OPEN !== "1") {
    try {
      await launchBrowser(studio.url);
    } catch {
      stderr.write("Moondog could not open a browser automatically. Use the local URL above.\n");
    }
  }

  let stop;
  const stopped = new Promise((resolve) => {
    stop = resolve;
  });
  const onSignal = () => stop();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    await stopped;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await studio.close();
  }
}
