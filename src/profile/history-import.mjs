import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readSpotifyHistoryArchive } from "../integrations/spotify/history-archive.mjs";
import { readListenBrainzHistoryFile } from "../integrations/listenbrainz/history-file.mjs";
import { projectSpotifyRecentActivity } from "../integrations/spotify/recent-activity.mjs";
import { buildAppleMusicLibraryImport } from "../importers/apple-music-library/index.mjs";

export function prepareSpotifyRecentImport({ page, subjectId, capturedAt = new Date().toISOString() }) {
  const bundle = projectSpotifyRecentActivity({ page, subjectId, capturedAt });
  const dates = bundle.listening_events.map((event) => event.occurred_at).sort();
  return {
    provider: "spotify-recent",
    bundle,
    preview: {
      sourceLabel: "Spotify recent listening",
      listeningEvents: bundle.listening_events.length,
      tracks: bundle.track_refs.length,
      earliestListeningAt: dates[0],
      latestListeningAt: dates.at(-1),
      eventsWithPlayedMs: 0,
      scopeNote: "A recent snapshot, up to 50 plays. Spotify does not supply actual played duration here. Add a history ZIP later for older listening.",
    },
  };
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function literalPath(input) {
  if (typeof input !== "string" || !input.trim()) {
    fail("history_import_path_required", "Paste the path to one Spotify ZIP, Apple Music XML, or ListenBrainz JSON file.");
  }
  let value = input.trim();
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    fail("history_import_path_invalid", "Paste one file path on a single line.");
  }
  const quote = ["'", '"'].includes(value[0]) ? value[0] : null;
  if (quote) {
    if (value.at(-1) !== quote) {
      fail("history_import_path_invalid", "The quoted path is incomplete. Paste the complete file path.");
    }
    value = value.slice(1, -1);
  }
  let decoded = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote && character === quote) {
      fail("history_import_path_invalid", "Paste one complete file path, not several quoted arguments.");
    }
    if (character === "\\" && quote !== "'") {
      const next = value[index + 1];
      const allowed = quote === '"' ? /["\\$`]/u : /[ \t()\[\]{}!&;'"\\#$~`]/u;
      if (!next || !allowed.test(next)) {
        fail("history_import_path_invalid", "The path has an unsupported escape. Paste the plain path, including its spaces.");
      }
      decoded += next;
      index += 1;
    } else {
      decoded += character;
    }
  }
  if (!decoded) fail("history_import_path_required", "Paste a file path between the quotes.");
  if (/^file:/iu.test(decoded)) {
    try {
      const url = new URL(decoded);
      if (url.hostname && url.hostname !== "localhost") throw new Error();
      if (url.search || url.hash || url.username || url.password || url.port) throw new Error();
      decoded = fileURLToPath(url);
    } catch {
      fail("history_import_path_invalid", "Use a local file:// URL with no remote host, query, or fragment, or paste the file path.");
    }
  } else if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(decoded)) {
    fail("history_import_path_invalid", "Choose a downloaded local file. Remote URLs are not imported.");
  }
  if (decoded === "~" || decoded.startsWith("~/")) decoded = path.join(homedir(), decoded.slice(1));
  else if (decoded.startsWith("~")) fail("history_import_path_invalid", "Use ~/ for your home folder, or paste the full file path.");
  return path.resolve(decoded);
}

export async function prepareHistoryImport({ filePath, subjectId, capturedAt = new Date().toISOString() } = {}) {
  const resolvedPath = literalPath(filePath);
  let file;
  try {
    file = await lstat(resolvedPath);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      fail("history_import_file_missing", `File not found: ${resolvedPath}. Paste the path to the downloaded file.`);
    }
    fail("history_import_file_unreadable", `Could not read ${resolvedPath}. Check that the file is accessible.`);
  }
  if (file.isDirectory()) {
    fail("history_import_directory", "This is a folder. Choose one Spotify ZIP, Apple Music library XML, or saved ListenBrainz JSON file.");
  }
  if (!file.isFile()) fail("history_import_file_invalid", "Choose a regular Spotify ZIP, Apple Music XML, or ListenBrainz JSON file.");
  const extension = path.extname(resolvedPath).toLowerCase();
  if (extension === ".xml") {
    const bundle = await buildAppleMusicLibraryImport(resolvedPath, { subjectId });
    return {
      provider: "apple-music-library",
      bundle,
      preview: {
        kind: "library",
        sourceLabel: "Apple Music library",
        fileName: path.basename(resolvedPath),
        tracks: bundle.trackRefs.length,
        capturedAt: bundle.manifest.source.captured_at,
        scopeNote: "Library snapshot with any supplied favorites, ratings, play counts and last-played dates. Individual listening events are not included.",
      },
    };
  }
  if (![".zip", ".json"].includes(extension)) {
    fail("history_import_format_unsupported", "Choose a Spotify history ZIP, Apple Music library XML or saved ListenBrainz JSON. Other file formats are not supported here.");
  }
  const provider = extension === ".zip" ? "spotify" : "listenbrainz";
  let bundle;
  try {
    bundle = provider === "spotify"
      ? await readSpotifyHistoryArchive({ archivePath: resolvedPath, subjectId, capturedAt })
      : await readListenBrainzHistoryFile({ filePath: resolvedPath, subjectId, capturedAt });
  } catch (error) {
    if (provider === "listenbrainz" && error.code === "listenbrainz_history_invalid") {
      error.message += " If this is a Spotify export, choose the original ZIP instead of an extracted JSON file.";
    }
    throw error;
  }
  const extended = bundle.import_batch.data_scope === "lifetime_extended_streaming_history";
  return {
    provider,
    bundle,
    preview: {
      sourceLabel: provider === "listenbrainz" ? "ListenBrainz history" : extended ? "Spotify Extended Streaming History" : "Spotify Account Data",
      fileName: path.basename(resolvedPath),
      sourceFormat: bundle.import_batch.source_format,
      dataScope: bundle.import_batch.data_scope,
      listeningEvents: bundle.listening_events.length,
      tracks: bundle.track_refs.length,
      earliestListeningAt: bundle.import_batch.earliest_occurred_at,
      latestListeningAt: bundle.import_batch.latest_occurred_at,
      eventsWithPlayedMs: bundle.listening_events.filter((event) => Number.isSafeInteger(event.played_ms)).length,
      profileEvidence: bundle.profile_evidence?.length ?? 0,
      scopeNote: provider === "listenbrainz"
        ? "Saved listens. Records without actual played duration do not add listening minutes."
        : extended
          ? "Music listening history with Spotify track identity and playback details. The dates describe this archive's coverage."
          : "Music listening history and any supported library or profile snapshots. Extended playback details are not included.",
    },
  };
}
