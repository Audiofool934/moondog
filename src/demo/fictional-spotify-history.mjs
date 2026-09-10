import { createHash } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export const FICTIONAL_SPOTIFY_HISTORY_VERSION =
  "moondog-fictional-spotify-history/2";

const archiveDirectory = "Spotify Extended Streaming History";
const fixedDosTime = 12 << 11;
const fixedDosDate = ((2026 - 1980) << 9) | (8 << 5) | 25;
const utf8Flag = 0x0800;

const tracks = Object.freeze({
  midnightLines: Object.freeze({
    id: "MoondogDemoTrack000001",
    title: "Midnight Lines",
    artist: "Mara Vale",
    album: "Night Transit",
  }),
  quietCoordinates: Object.freeze({
    id: "MoondogDemoTrack000002",
    title: "Quiet Coordinates",
    artist: "Sable Arcade",
    album: "Night Survey",
  }),
  weatherMemory: Object.freeze({
    id: "MoondogDemoTrack000003",
    title: "Weather Memory",
    artist: "Cinder Lake",
    album: "Shoreline Code",
  }),
  glassHighway: Object.freeze({
    id: "MoondogDemoTrack000004",
    title: "Glass Highway",
    artist: "North Window",
    album: "Pale Signals",
  }),
  signalGarden: Object.freeze({
    id: "MoondogDemoTrack000005",
    title: "Signal Garden",
    artist: "Glass Atlas",
    album: "Unfolding Maps",
  }),
  blueExit: Object.freeze({
    id: "MoondogDemoTrack000006",
    title: "Blue Exit",
    artist: "Ash Meridian",
    album: "Afterimage",
  }),
  parallelRooms: Object.freeze({
    id: "MoondogDemoTrack000007",
    title: "Parallel Rooms",
    artist: "Elsewhere Signal",
    album: "Long Distance",
  }),
  northernRelay: Object.freeze({
    id: "MoondogDemoTrack000008",
    title: "Northern Relay",
    artist: "Drift Assembly",
    album: "Moving Weather",
  }),
  blueHourIndex: Object.freeze({
    id: "MoondogDemoTrack000009",
    title: "Blue Hour Index",
    artist: "New Coast Archive",
    album: "Tide Tables",
  }),
  lowVoltageMoon: Object.freeze({
    id: "MoondogDemoTrack000010",
    title: "Low Voltage Moon",
    artist: "Low Lanterns",
    album: "Street Astronomy",
  }),
  lastTramHome: Object.freeze({
    id: "MoondogDemoTrack000011",
    title: "Last Tram Home",
    artist: "Mara Vale",
    album: "Night Transit",
  }),
  signalBlue: Object.freeze({
    id: "MoondogDemoTrack000012",
    title: "Signal Blue",
    artist: "Mara Vale",
    album: "Night Transit",
  }),
  paleStatic: Object.freeze({
    id: "MoondogDemoTrack000013",
    title: "Pale Static",
    artist: "North Window",
    album: "Pale Signals",
  }),
  exitSigns: Object.freeze({
    id: "MoondogDemoTrack000014",
    title: "Exit Signs",
    artist: "North Window",
    album: "Pale Signals",
  }),
});

const playSchedule = Object.freeze({
  2023: Object.freeze([
    ["2023-09-01T21:12:00Z", "midnightLines", 304_000],
    ["2023-09-01T21:17:00Z", "midnightLines", 311_000],
    ["2023-09-01T21:22:00Z", "midnightLines", 306_000],
    ["2023-09-01T21:27:00Z", "lastTramHome", 296_000],
    ["2023-09-01T21:32:00Z", "signalBlue", 289_000],
    ["2023-11-18T21:14:00Z", "quietCoordinates", 322_000],
    ["2023-11-18T21:20:00Z", "midnightLines", 309_000],
    ["2023-11-18T21:25:00Z", "weatherMemory", 284_000],
    ["2023-11-18T21:31:00Z", "quietCoordinates", 315_000],
    ["2023-12-28T20:11:00Z", "midnightLines", 307_000, { shuffle: true }],
  ]),
  2024: Object.freeze([
    ["2024-01-11T21:05:00Z", "glassHighway", 314_000],
    ["2024-01-11T21:10:00Z", "glassHighway", 319_000],
    ["2024-01-11T21:15:00Z", "glassHighway", 316_000],
    ["2024-01-11T21:20:00Z", "paleStatic", 287_000],
    ["2024-01-11T21:25:00Z", "exitSigns", 292_000],
    ["2024-06-01T21:48:00Z", "glassHighway", 321_000],
    ["2024-06-01T21:53:00Z", "signalGarden", 298_000],
    ["2024-06-01T21:58:00Z", "glassHighway", 317_000],
    ["2024-06-01T22:03:00Z", "midnightLines", 305_000],
    ["2024-12-28T21:37:00Z", "glassHighway", 323_000, { offline: true }],
    [
      "2024-12-28T21:43:00Z",
      "lowVoltageMoon",
      21_000,
      { reason_end: "fwdbtn", skipped: true },
    ],
  ]),
  2025: Object.freeze([
    ["2025-01-13T20:42:00Z", "blueExit", 307_000],
    ["2025-01-13T20:47:00Z", "blueExit", 312_000],
    ["2025-01-13T20:52:00Z", "blueExit", 309_000],
    ["2025-01-13T20:57:00Z", "parallelRooms", 281_000],
    ["2025-01-13T21:02:00Z", "quietCoordinates", 319_000],
    ["2025-04-25T21:23:00Z", "blueExit", 315_000],
    ["2025-04-25T21:28:00Z", "parallelRooms", 286_000],
    ["2025-04-25T21:33:00Z", "blueExit", 311_000],
    ["2025-04-25T21:38:00Z", "glassHighway", 318_000],
    ["2025-09-09T23:06:00Z", "blueExit", 314_000, { shuffle: true }],
    ["2025-09-09T23:11:00Z", "parallelRooms", 283_000],
    ["2025-09-09T23:16:00Z", "blueExit", 316_000],
    ["2025-11-26T19:42:00Z", "quietCoordinates", 321_000],
    [
      "2025-12-29T20:02:00Z",
      "lowVoltageMoon",
      18_000,
      { reason_end: "fwdbtn", skipped: true },
    ],
  ]),
  2026: Object.freeze([
    ["2026-01-08T14:20:00Z", "signalGarden", 299_000],
    ["2026-01-08T14:25:00Z", "northernRelay", 321_000],
    ["2026-01-08T14:30:00Z", "blueHourIndex", 292_000],
    ["2026-01-08T14:35:00Z", "northernRelay", 324_000],
    ["2026-03-09T22:41:00Z", "northernRelay", 319_000],
    ["2026-03-09T22:46:00Z", "blueExit", 310_000],
    ["2026-03-09T22:51:00Z", "northernRelay", 326_000],
    ["2026-03-09T22:56:00Z", "glassHighway", 315_000],
    ["2026-06-04T19:12:00Z", "blueHourIndex", 296_000],
    ["2026-06-04T19:17:00Z", "northernRelay", 323_000],
    ["2026-06-04T19:22:00Z", "midnightLines", 308_000],
    ["2026-06-04T19:27:00Z", "northernRelay", 327_000],
    ["2026-08-24T22:06:00Z", "blueHourIndex", 294_000],
    ["2026-08-24T22:12:00Z", "northernRelay", 325_000],
    ["2026-08-24T22:18:00Z", "blueHourIndex", 297_000],
    [
      "2026-08-24T22:24:00Z",
      "lowVoltageMoon",
      16_000,
      { reason_end: "fwdbtn", skipped: true },
    ],
    ["2026-08-24T22:30:00Z", "northernRelay", 328_000, { offline: true }],
  ]),
});

function fail(message) {
  throw new Error(`Fictional Spotify history generation failed: ${message}`);
}

function spotifyRecord([ts, trackKey, playedMs, overrides = {}], index, plays) {
  const track = tracks[trackKey];
  if (!track) fail(`unknown fictional track key: ${trackKey}`);
  const previousTimestamp = index > 0 ? plays[index - 1][0] : null;
  const gapMilliseconds = previousTimestamp
    ? Date.parse(ts) - Date.parse(previousTimestamp)
    : Number.POSITIVE_INFINITY;
  const continuedSession =
    gapMilliseconds >= 0 && gapMilliseconds <= 30 * 60_000;
  return {
    ts,
    ms_played: playedMs,
    master_metadata_track_name: track.title,
    master_metadata_album_artist_name: track.artist,
    master_metadata_album_album_name: track.album,
    spotify_track_uri: `spotify:track:${track.id}`,
    reason_start: continuedSession ? "trackdone" : "clickrow",
    reason_end: "trackdone",
    shuffle: false,
    skipped: false,
    offline: false,
    incognito_mode: false,
    ...overrides,
  };
}

export function fictionalSpotifyHistoryEntries() {
  return Object.entries(playSchedule).map(([year, plays]) => ({
    name: `${archiveDirectory}/Streaming_History_Audio_${year}.json`,
    data: Buffer.from(
      `${JSON.stringify(plays.map(spotifyRecord), null, 2)}\n`,
      "utf8",
    ),
    year: Number(year),
    records: plays.length,
  }));
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1
      ? (value >>> 1) ^ 0xedb88320
      : value >>> 1;
  }
  return value >>> 0;
});

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function localHeader(name, data) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(utf8Flag, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(fixedDosTime, 10);
  header.writeUInt16LE(fixedDosDate, 12);
  header.writeUInt32LE(crc32(data), 14);
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(0, 28);
  return header;
}

function centralHeader(name, data, offset) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(utf8Flag, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(fixedDosTime, 12);
  header.writeUInt16LE(fixedDosDate, 14);
  header.writeUInt32LE(crc32(data), 16);
  header.writeUInt32LE(data.length, 20);
  header.writeUInt32LE(data.length, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(offset, 42);
  return header;
}

function endOfCentralDirectory(entryCount, size, offset) {
  const header = Buffer.alloc(22);
  header.writeUInt32LE(0x06054b50, 0);
  header.writeUInt16LE(0, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(entryCount, 8);
  header.writeUInt16LE(entryCount, 10);
  header.writeUInt32LE(size, 12);
  header.writeUInt32LE(offset, 16);
  header.writeUInt16LE(0, 20);
  return header;
}

export function createFictionalSpotifyHistoryArchive() {
  const entries = fictionalSpotifyHistoryEntries();
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const local = localHeader(name, entry.data);
    localParts.push(local, name, entry.data);
    centralParts.push(centralHeader(name, entry.data, localOffset), name);
    localOffset += local.length + name.length + entry.data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  return Buffer.concat([
    ...localParts,
    centralDirectory,
    endOfCentralDirectory(entries.length, centralDirectory.length, localOffset),
  ]);
}

function archiveManifest(outputPath, archive) {
  const entries = fictionalSpotifyHistoryEntries();
  const records = entries.flatMap((entry) =>
    JSON.parse(entry.data.toString("utf8")),
  );
  const timestamps = records.map((record) => record.ts).sort();
  return {
    schema: FICTIONAL_SPOTIFY_HISTORY_VERSION,
    archive_path: outputPath,
    archive_bytes: archive.length,
    archive_sha256: createHash("sha256").update(archive).digest("hex"),
    record_count: records.length,
    years: entries.map((entry) => entry.year),
    members: entries.map((entry) => entry.name),
    listening_range: {
      earliest: timestamps[0],
      latest: timestamps.at(-1),
    },
    boundaries: {
      fictional_demonstration_data_only: true,
      private_listener_data_read: false,
      network_requests: false,
      provider_actions: false,
      persistent_profile_writes: false,
    },
  };
}

async function pathExists(filePath) {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function writeFictionalSpotifyHistoryArchive({ outputPath } = {}) {
  if (typeof outputPath !== "string" || !outputPath.trim()) {
    fail("an explicit output path is required");
  }
  if (!path.isAbsolute(outputPath)) {
    fail("the output path must be absolute");
  }
  const resolvedPath = path.normalize(outputPath);
  if (path.extname(resolvedPath).toLocaleLowerCase("en-US") !== ".zip") {
    fail("the output file must use the .zip extension");
  }
  if (await pathExists(resolvedPath)) {
    fail(`the destination already exists: ${resolvedPath}`);
  }
  const parentPath = path.dirname(resolvedPath);
  const parent = await lstat(parentPath).catch((error) => {
    if (error?.code === "ENOENT") {
      fail(`the destination parent does not exist: ${parentPath}`);
    }
    throw error;
  });
  if (!parent.isDirectory() || parent.isSymbolicLink()) {
    fail(`the destination parent is not a regular directory: ${parentPath}`);
  }

  const archive = createFictionalSpotifyHistoryArchive();
  const stagingRoot = await mkdtemp(
    path.join(parentPath, ".moondog-fictional-history-"),
  );
  if (process.platform !== "win32") await chmod(stagingRoot, 0o700);
  const stagedPath = path.join(stagingRoot, "history.zip");
  try {
    await writeFile(stagedPath, archive, { flag: "wx", mode: 0o600 });
    if (process.platform !== "win32") await chmod(stagedPath, 0o600);
    try {
      await link(stagedPath, resolvedPath);
    } catch (error) {
      if (error?.code === "EEXIST") {
        fail(`the destination appeared during generation: ${resolvedPath}`);
      }
      throw error;
    }
    return archiveManifest(resolvedPath, archive);
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}
