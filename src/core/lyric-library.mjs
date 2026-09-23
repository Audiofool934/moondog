import { createHash } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { resolveListeningHistoryPath } from "../profile/listening-history-store.mjs";
import { lyricTrackKey } from "./lyric-profile.mjs";

export function resolveLyricLibraryPath(environment = process.env) {
  return path.join(path.dirname(resolveListeningHistoryPath(environment)), "lyrics.sqlite");
}

function cleanLine(text) {
  return stripVTControlCharacters(text).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, "")
    .replace(/\s+/gu, " ").trim();
}

/** Preserve provider text separately; this projection supplies reusable timed lines. */
export function parseLyricLines({ plainLyrics, syncedLyrics }) {
  const timed = [];
  const offset = Number(syncedLyrics?.match(/\[offset:([+-]?\d+)\]/iu)?.[1] ?? 0);
  for (const line of (syncedLyrics ?? "").split(/\r?\n/u)) {
    const stamps = [...line.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/gu)];
    const text = cleanLine(line.replace(/[\[<]\d{1,3}:\d{2}(?:[.:]\d{1,3})?[\]>]/gu, ""));
    for (const [, minutes, seconds, fraction = ""] of stamps) {
      if (Number(seconds) >= 60) continue;
      // Positive LRC offsets advance the lyric; empty timed lines mark instrumental gaps.
      timed.push({ text, startMs: Math.max(0, Number(minutes) * 60_000 + Number(seconds) * 1_000 + Number(fraction.padEnd(3, "0")) - offset) });
    }
  }
  if (timed.length) return timed.sort((a, b) => a.startMs - b.startMs);
  return (plainLyrics ?? "").split(/\r?\n/u).map(cleanLine)
    .filter((text) => text && !/^\[[^\]]+\]$/u.test(text)).map((text) => ({ text, startMs: null }));
}

export function homeLyricLines(lines) {
  return [...new Set(lines.map((line) => line.text))].filter((text) => {
    const length = Array.from(text).length;
    return length >= 6 && length <= 80 && /\p{L}/u.test(text) &&
      !/(?:https?:|www\.|©|作词|作曲|编曲|制作人|词[:：]|曲[:：]|lyrics?\s*(?:by|:)|written\s+by|copyright)/iu.test(text) &&
      !/^[\[(].*[\])]$/u.test(text) && !/^(?:verse|chorus|bridge|intro|outro|instrumental)(?:\s+\d+)?$/iu.test(text);
  });
}

const hash = (text) => createHash("sha256").update(text).digest("hex");

export async function openLyricLibrary({ environment = process.env, databasePath = resolveLyricLibraryPath(environment) } = {}) {
  const { DatabaseSync } = await import("node:sqlite");
  if (databasePath !== ":memory:") {
    await mkdir(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(path.dirname(databasePath), 0o700);
  }
  const db = new DatabaseSync(databasePath);
  try {
    db.exec("PRAGMA busy_timeout = 3000; PRAGMA trusted_schema = OFF;");
    const version = db.prepare("PRAGMA user_version").get().user_version;
    if (version > 1) throw new Error("Lyric library schema is newer than this Moondog version.");
    db.exec(`
      CREATE TABLE IF NOT EXISTS lyrics (
        track_key TEXT PRIMARY KEY, track_json TEXT NOT NULL,
        state TEXT NOT NULL, record_json TEXT NOT NULL, fetched_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS home_selections (
        id INTEGER PRIMARY KEY, subject_id TEXT NOT NULL, track_key TEXT NOT NULL,
        line_hash TEXT NOT NULL, shown_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS home_subject ON home_selections(subject_id, id DESC);
      CREATE TABLE IF NOT EXISTS provider_state (provider TEXT PRIMARY KEY, retry_at INTEGER NOT NULL) STRICT;
      PRAGMA user_version = 1;
    `);
    if (databasePath !== ":memory:" && process.platform !== "win32") await chmod(databasePath, 0o600);
    return {
      path: databasePath,
      get(track) {
        const row = db.prepare("SELECT * FROM lyrics WHERE track_key = ?").get(lyricTrackKey(track));
        return row ? { ...JSON.parse(row.record_json), key: row.track_key, fetchedAt: row.fetched_at } : null;
      },
      put(track, record, now = Date.now()) {
        const value = { ...record, lines: parseLyricLines(record) };
        db.prepare(`INSERT INTO lyrics VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(track_key) DO UPDATE SET track_json=excluded.track_json, state=excluded.state,
          record_json=excluded.record_json, fetched_at=excluded.fetched_at`)
          .run(lyricTrackKey(track), JSON.stringify(track), record.state, JSON.stringify(value), now);
        return value;
      },
      retryAt() { return db.prepare("SELECT retry_at FROM provider_state WHERE provider = 'lrclib'").get()?.retry_at ?? 0; },
      deferUntil(time) {
        db.prepare("INSERT INTO provider_state VALUES ('lrclib', ?) ON CONFLICT(provider) DO UPDATE SET retry_at=excluded.retry_at").run(time);
      },
      selectHome({ tracks, subjectId, random = Math.random, now = Date.now() }) {
        if (!subjectId) return null;
        const candidates = tracks.flatMap((track) => {
          const record = this.get(track);
          const lines = record?.state === "ready" ? homeLyricLines(record.lines) : [];
          return lines.length ? [{ track, record, lines }] : [];
        });
        if (!candidates.length) return null;
        const recent = db.prepare("SELECT track_key, line_hash FROM home_selections WHERE subject_id = ? ORDER BY id DESC LIMIT 12").all(subjectId);
        const fresh = candidates.map((item) => ({ ...item, lines: item.lines.filter((line) => !recent.some((seen) => seen.line_hash === hash(line))) })).filter((item) => item.lines.length);
        const available = fresh.length ? fresh : candidates;
        const otherTracks = available.filter((item) => item.record.key !== recent[0]?.track_key);
        const pool = otherTracks.length ? otherTracks : available;
        const total = pool.reduce((sum, item) => sum + (item.track.weight ?? 1), 0);
        let cursor = random() * total;
        const chosen = pool.find((item) => (cursor -= item.track.weight ?? 1) < 0) ?? pool.at(-1);
        const text = chosen.lines[Math.floor(random() * chosen.lines.length)];
        db.prepare("INSERT INTO home_selections(subject_id, track_key, line_hash, shown_at) VALUES (?, ?, ?, ?)")
          .run(subjectId, chosen.record.key, hash(text), now);
        db.prepare("DELETE FROM home_selections WHERE subject_id = ? AND id NOT IN (SELECT id FROM home_selections WHERE subject_id = ? ORDER BY id DESC LIMIT 100)").run(subjectId, subjectId);
        return { text, trackKey: chosen.record.key, title: chosen.track.title, artist: chosen.track.artist, sourceUrl: chosen.record.sourceUrl };
      },
      status() {
        return { path: databasePath, entries: db.prepare("SELECT COUNT(*) AS n FROM lyrics").get().n,
          ready: db.prepare("SELECT COUNT(*) AS n FROM lyrics WHERE state = 'ready'").get().n,
          instrumental: db.prepare("SELECT COUNT(*) AS n FROM lyrics WHERE state = 'instrumental'").get().n };
      },
      close() { db.close(); },
    };
  } catch (error) { db.close(); throw error; }
}
