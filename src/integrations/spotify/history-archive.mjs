import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { readSpotifyAccountDataHistoryArchive } from "./account-data-history.mjs";
import { readSpotifyExtendedStreamingHistoryArchive } from "./extended-streaming-history.mjs";

const execFileAsync = promisify(execFile);

function fail(message, code = "spotify_history_archive_invalid") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

export async function readSpotifyHistoryArchive(options = {}) {
  if (typeof options.archivePath !== "string" || !options.archivePath.trim()) {
    fail("A Spotify history ZIP path is required.");
  }
  const archivePath = path.resolve(options.archivePath);
  let listing;
  try {
    ({ stdout: listing } = await execFileAsync(
      "/usr/bin/unzip",
      ["-Z1", archivePath],
      {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
    ));
  } catch {
    fail(
      "The Spotify history ZIP could not be read safely.",
      "spotify_history_archive_unreadable",
    );
  }
  const hasAccountData = listing
    .split(/\r?\n/u)
    .some((name) =>
      /^Spotify Account Data\/StreamingHistory_music_[0-9]+\.json$/u.test(
        name,
      ),
    );
  const hasExtendedHistory = listing
    .split(/\r?\n/u)
    .some((name) =>
      /^Spotify Extended Streaming History\/Streaming_History_Audio_[0-9]{4}(?:_[0-9]+)?\.json$/u.test(
        name,
      ),
    );
  if (hasAccountData === hasExtendedHistory) {
    fail("The ZIP does not contain one unambiguous Spotify history format.");
  }
  const reader = hasExtendedHistory
    ? readSpotifyExtendedStreamingHistoryArchive
    : readSpotifyAccountDataHistoryArchive;
  return reader({ ...options, archivePath });
}
