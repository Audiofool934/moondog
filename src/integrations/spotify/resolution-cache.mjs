import { createHash } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const SPOTIFY_RESOLUTION_CACHE_SCHEMA_VERSION = 1;
export const SPOTIFY_RESOLUTION_CACHE_KEY_VERSION = 2;

export function resolveSpotifyResolutionCachePath(environment = process.env) {
  const configuredState = environment.MOONDOG_STATE_HOME?.trim();
  if (configuredState) {
    if (!path.isAbsolute(configuredState)) {
      throw new TypeError("MOONDOG_STATE_HOME must be an absolute path");
    }
    return path.join(path.resolve(configuredState), "spotify-resolution-cache.sqlite");
  }

  const configuredConfig = environment.MOONDOG_CONFIG_HOME?.trim();
  if (configuredConfig) {
    if (!path.isAbsolute(configuredConfig)) {
      throw new TypeError("MOONDOG_CONFIG_HOME must be an absolute path");
    }
    return path.join(
      path.resolve(configuredConfig),
      "spotify-resolution-cache.sqlite",
    );
  }

  const xdgState = environment.XDG_STATE_HOME?.trim();
  if (xdgState && path.isAbsolute(xdgState)) {
    return path.join(
      path.resolve(xdgState),
      "moondog",
      "spotify-resolution-cache.sqlite",
    );
  }

  return path.join(
    homedir(),
    ".local",
    "state",
    "moondog",
    "spotify-resolution-cache.sqlite",
  );
}

export const defaultSpotifyResolutionCachePath =
  resolveSpotifyResolutionCachePath();

const schema = `
CREATE TABLE IF NOT EXISTS track_resolutions (
  cache_key TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  match_quality TEXT,
  matched_title TEXT,
  matched_artists TEXT,
  matched_album TEXT,
  matched_duration_ms INTEGER,
  spotify_track_id TEXT,
  spotify_uri TEXT,
  resolved_at_ms INTEGER NOT NULL
);
`;

const matchQualityValues = new Set(["alternate_master", "exact", "standard"]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cleanStoredText(value, maximum) {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/\s+/gu, " ").trim();
  if (!cleaned) return null;
  return Array.from(cleaned).slice(0, maximum).join("");
}

export function spotifyResolutionCacheKey(track) {
  if (
    !isPlainObject(track) ||
    typeof track.title !== "string" ||
    typeof track.artist_credit !== "string" ||
    typeof track.release !== "string"
  ) {
    throw new TypeError("A track title, artist credit, and release are required.");
  }
  const normalized = [
    `spotify-resolution/${SPOTIFY_RESOLUTION_CACHE_KEY_VERSION}`,
    track.title,
    track.artist_credit,
    track.release,
  ]
    .map((value) => value.normalize("NFKC").toLocaleLowerCase("und").replace(/\s+/gu, " ").trim())
    .join("|");
  return createHash("sha256").update(normalized).digest("hex");
}

function serializeArtists(value) {
  if (!Array.isArray(value)) return null;
  const artists = value
    .filter((artist) => typeof artist === "string" && artist.trim())
    .map((artist) => cleanStoredText(artist, 256))
    .filter(Boolean)
    .slice(0, 5);
  return artists.length > 0 ? JSON.stringify(artists) : null;
}

function parseArtists(value) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.slice(0, 5) : undefined;
  } catch {
    return undefined;
  }
}

function rowToEntry(row) {
  if (!row || row.status !== "resolved") return null;
  const entry = {
    status: "resolved",
    match_quality: matchQualityValues.has(row.match_quality)
      ? row.match_quality
      : "standard",
  };
  if (row.matched_title) entry.matched = { title: row.matched_title };
  const artists = parseArtists(row.matched_artists);
  if (artists) entry.matched.artists = artists;
  if (row.matched_album) entry.matched.album = row.matched_album;
  if (Number.isInteger(row.matched_duration_ms)) {
    entry.matched.duration_ms = row.matched_duration_ms;
  }
  if (row.spotify_track_id && row.spotify_uri) {
    entry.spotify = {
      track_id: row.spotify_track_id,
      uri: row.spotify_uri,
    };
  }
  if (!entry.spotify) return null;
  return entry;
}

export class SpotifyResolutionCache {
  #database;
  #closed = false;

  constructor(database) {
    this.#database = database;
  }

  async get(cacheKey) {
    if (this.#closed) return null;
    const row = this.#database
      .prepare("SELECT * FROM track_resolutions WHERE cache_key = ?")
      .get(cacheKey);
    return rowToEntry(row);
  }

  async put(cacheKey, entry, resolvedAtMs = Date.now()) {
    if (this.#closed) return;
    if (!isPlainObject(entry) || entry.status !== "resolved") return;
    const matched = isPlainObject(entry.matched) ? entry.matched : {};
    const spotify = isPlainObject(entry.spotify) ? entry.spotify : {};
    this.#database
      .prepare(
        `INSERT OR REPLACE INTO track_resolutions (
          cache_key, status, match_quality, matched_title, matched_artists,
          matched_album, matched_duration_ms, spotify_track_id, spotify_uri,
          resolved_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        cacheKey,
        "resolved",
        matchQualityValues.has(entry.match_quality)
          ? entry.match_quality
          : "standard",
        cleanStoredText(matched.title, 512),
        serializeArtists(matched.artists),
        cleanStoredText(matched.album, 512),
        Number.isInteger(matched.duration_ms) ? matched.duration_ms : null,
        cleanStoredText(spotify.track_id, 128),
        cleanStoredText(spotify.uri, 256),
        Number.isInteger(resolvedAtMs) ? resolvedAtMs : Date.now(),
      );
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#database.close();
  }
}

let databaseConstructorPromise;

function databaseConstructor() {
  databaseConstructorPromise ??= import("node:sqlite").then(
    ({ DatabaseSync }) => DatabaseSync,
  );
  return databaseConstructorPromise;
}

export async function openSpotifyResolutionCache({
  databasePath = defaultSpotifyResolutionCachePath,
  environment = process.env,
} = {}) {
  const resolvedPath =
    databasePath === defaultSpotifyResolutionCachePath
      ? resolveSpotifyResolutionCachePath(environment)
      : databasePath;
  const parent = path.dirname(path.resolve(resolvedPath));
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(parent, 0o700);

  const DatabaseSync = await databaseConstructor();
  const database = new DatabaseSync(path.resolve(resolvedPath));
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA trusted_schema = OFF");
    const currentVersion = database.prepare("PRAGMA user_version").get()
      .user_version;
    if (
      !Number.isInteger(currentVersion) ||
      currentVersion < 0 ||
      currentVersion > SPOTIFY_RESOLUTION_CACHE_SCHEMA_VERSION
    ) {
      throw new Error("Spotify resolution cache schema is incompatible");
    }
    database.exec(schema);
    if (currentVersion < SPOTIFY_RESOLUTION_CACHE_SCHEMA_VERSION) {
      database.exec(
        `PRAGMA user_version = ${SPOTIFY_RESOLUTION_CACHE_SCHEMA_VERSION}`,
      );
    }
    if (process.platform !== "win32") {
      await chmod(path.resolve(resolvedPath), 0o600);
    }
    return new SpotifyResolutionCache(database);
  } catch (error) {
    database.close();
    throw error;
  }
}

export function createInMemorySpotifyResolutionCache() {
  const entries = new Map();
  return {
    async get(cacheKey) {
      return entries.get(cacheKey) ?? null;
    },
    async put(cacheKey, entry) {
      entries.set(cacheKey, structuredClone(entry));
    },
    async close() {},
  };
}
