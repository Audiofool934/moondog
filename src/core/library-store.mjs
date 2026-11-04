// The listener's library: their own collection, kept on this Mac and shared by the terminal and the window.
// Songs by artists and the tracks Moondog made sit side by side in it, each entry saying which it is, so a
// playlist can hold both and still tell "Moondog made this" from a song someone recorded.
//
// Folders hold playlists and other folders, up to MAX_DEPTH deep; inside a folder, folders and playlists share
// one order, which the listener sets by dragging. Saved is the one built-in playlist: single songs and made
// tracks the listener kept, first in the list, never renamed or deleted. An entry keeps what names the song
// (title, artist, album, ISRC) and the ids each service found for it, so the same playlist plays on whichever
// service the listener chose, and any one service can be dropped without losing it.
import { randomUUID } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { resolveMoondogStateDirectory } from "./state-directory.mjs";

export const LIBRARY_SCHEMA_VERSION = 1;
export const SAVED_PLAYLIST_ID = "saved";
export const MAX_DEPTH = 4;
export const MAX_ENTRIES = 2000;
const ORIGINS = new Set(["listener", "moondog", "spotify", "apple_music", "netease", "qq_music", "file"]);
const ADDERS = new Set(["listener", "moondog"]);

export const resolveLibraryPath = (environment = process.env) => path.join(resolveMoondogStateDirectory(environment), "library.sqlite");

const schema = `
  CREATE TABLE IF NOT EXISTS library_folders (
    folder_id TEXT PRIMARY KEY NOT NULL,
    parent_id TEXT REFERENCES library_folders(folder_id),
    name TEXT NOT NULL,
    position INTEGER NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS library_playlists (
    playlist_id TEXT PRIMARY KEY NOT NULL,
    folder_id TEXT REFERENCES library_folders(folder_id),
    name TEXT NOT NULL,
    origin TEXT NOT NULL,
    source_json TEXT,
    position INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS library_entries (
    entry_id TEXT PRIMARY KEY NOT NULL,
    playlist_id TEXT NOT NULL REFERENCES library_playlists(playlist_id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('song', 'made')),
    title TEXT NOT NULL,
    artist_credit TEXT NOT NULL DEFAULT '',
    album TEXT,
    isrc TEXT,
    made_id TEXT,
    refs_json TEXT NOT NULL DEFAULT '{}',
    added_by TEXT NOT NULL,
    added_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS library_entries_by_playlist ON library_entries(playlist_id, position);
  CREATE INDEX IF NOT EXISTS library_entries_by_made ON library_entries(made_id) WHERE made_id IS NOT NULL;
`;

const libraryError = (code, message) => Object.assign(new Error(message), { code });

function cleanText(value, maximum, label, { optional = false } = {}) {
  if (optional && (value === undefined || value === null || (typeof value === "string" && !value.trim()))) return null;
  if (typeof value !== "string") throw libraryError("library_invalid", `${label} must be text.`);
  const cleaned = value.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/gu, " ").replace(/\s+/gu, " ").trim();
  if (!cleaned) throw libraryError("library_invalid", `${label} must not be empty.`);
  return Array.from(cleaned).slice(0, maximum).join("");
}
const cleanId = (value, label) => cleanText(value, 128, label);
const madeIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

// The ids a service gave a song, kept so the next play skips the search. Only short plain strings are kept.
// A cached Spotify recording keeps its own title and credit, so a later Avoid is checked against it.
const REF_KEYS = ["spotify_uri", "spotify_title", "spotify_credit", "apple_music_id", "netease_id"];
function cleanRefs(refs) {
  const kept = {};
  if (!refs || typeof refs !== "object") return kept;
  // A cover from the services' own image hosts, which the window already shows.
  try {
    const url = new URL(String(refs.artwork_url ?? ""));
    if (url.protocol === "https:" && /(^|\.)(mzstatic\.com|scdn\.co|music\.126\.net)$/u.test(url.hostname) && url.href.length <= 500) kept.artwork_url = url.href;
  } catch { /* No cover. */ }
  for (const key of REF_KEYS) {
    const value = refs[key];
    if (typeof value === "string" && value.trim() && value.length <= 200) kept[key] = value.trim();
  }
  return kept;
}

/** One entry to add, as it is kept. A song has a title and an artist; a made track has its id and title. */
export function normalizeLibraryEntry(entry) {
  if (!entry || typeof entry !== "object") throw libraryError("library_invalid", "An entry must be an object.");
  const kind = entry.kind === "made" ? "made" : "song";
  if (kind === "made") {
    const id = String(entry.made_id ?? entry.id ?? "");
    if (!madeIdPattern.test(id)) throw libraryError("library_invalid", "A made track needs its id.");
    return { kind, title: cleanText(entry.title, 200, "Title"), artist_credit: "Moondog", album: null, isrc: null, made_id: id, refs: {} };
  }
  const isrc = typeof entry.isrc === "string" && /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/u.test(entry.isrc.trim().toUpperCase()) ? entry.isrc.trim().toUpperCase() : null;
  return {
    kind,
    title: cleanText(entry.title, 200, "Title"),
    artist_credit: cleanText(entry.artist_credit ?? entry.artist ?? (Array.isArray(entry.artists) ? entry.artists.join(", ") : ""), 200, "Artist"),
    album: cleanText(entry.album, 200, "Album", { optional: true }),
    isrc,
    made_id: null,
    refs: cleanRefs(entry.refs),
  };
}

// The same song twice in Saved is one song; ISRC first, then title and artist without case or marks.
const fold = (value) => String(value ?? "").normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
export const entryIdentity = (entry) => entry.kind === "made" ? `made:${entry.made_id}` : entry.isrc ? `isrc:${entry.isrc}` : `song:${fold(entry.title)}|${fold(entry.artist_credit)}`;

const entryOf = (row) => ({
  id: row.entry_id,
  kind: row.kind,
  title: row.title,
  artist_credit: row.artist_credit,
  ...(row.album ? { album: row.album } : {}),
  ...(row.isrc ? { isrc: row.isrc } : {}),
  ...(row.made_id ? { made_id: row.made_id } : {}),
  refs: JSON.parse(row.refs_json || "{}"),
  added_by: row.added_by,
  added_at: row.added_at,
});

export class LibraryStore {
  #database;
  #clock;
  #closed = false;
  #listeners = new Set();

  constructor(database, { clock = () => new Date() } = {}) {
    this.#database = database;
    this.#clock = clock;
    this.#ensureSaved();
  }

  #now() { return new Date(this.#clock()).toISOString(); }
  #open() { if (this.#closed) throw libraryError("library_closed", "The library is closed."); }
  #transaction(work) {
    this.#open();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.#database.exec("COMMIT");
      // This connection's own writes leave its data version alone, so its surfaces hear of them here.
      for (const listener of this.#listeners) { try { listener(); } catch { /* A surface's redraw can't undo the write. */ } }
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }
  #ensureSaved() {
    const at = this.#now();
    this.#database.prepare(`INSERT OR IGNORE INTO library_playlists(playlist_id, folder_id, name, origin, source_json, position, created_at, updated_at)
      VALUES (?, NULL, 'Saved', 'listener', NULL, -1, ?, ?)`).run(SAVED_PLAYLIST_ID, at, at);
  }

  // Folders and playlists in one parent share one order, as the listener dragged them.
  #children(parentId) {
    const folders = this.#database.prepare(`SELECT folder_id AS id, position, 'folder' AS kind FROM library_folders WHERE parent_id IS ?`).all(parentId);
    const playlists = this.#database.prepare(`SELECT playlist_id AS id, position, 'playlist' AS kind FROM library_playlists
      WHERE folder_id IS ? AND playlist_id != ?`).all(parentId, SAVED_PLAYLIST_ID);
    return [...folders, ...playlists].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  }
  #renumber(parentId, order) {
    const folder = this.#database.prepare("UPDATE library_folders SET position = ? WHERE folder_id = ?");
    const playlist = this.#database.prepare("UPDATE library_playlists SET position = ? WHERE playlist_id = ?");
    order.forEach((node, index) => (node.kind === "folder" ? folder : playlist).run(index, node.id));
  }
  #requireFolder(id) {
    if (id === null) return null;
    const row = this.#database.prepare("SELECT folder_id, parent_id FROM library_folders WHERE folder_id = ?").get(id);
    if (!row) throw libraryError("library_folder_not_found", "That folder is not in the library.");
    return row;
  }
  #depth(folderId) {
    let depth = 0;
    for (let id = folderId; id !== null; depth += 1) id = this.#requireFolder(id).parent_id ?? null;
    return depth;
  }
  // How many levels a folder holds below itself, counting itself.
  #height(folderId) {
    const kids = this.#database.prepare("SELECT folder_id FROM library_folders WHERE parent_id = ?").all(folderId);
    return 1 + Math.max(0, ...kids.map((kid) => this.#height(kid.folder_id)));
  }
  #requirePlaylist(id) {
    const row = this.#database.prepare("SELECT playlist_id, folder_id, name FROM library_playlists WHERE playlist_id = ?").get(id);
    if (!row) throw libraryError("library_playlist_not_found", "That playlist is not in the library.");
    return row;
  }
  // Puts a node in a parent before a sibling, or last; the parent's order is written again.
  #place(node, parentId, beforeId) {
    const order = this.#children(parentId).filter((each) => !(each.id === node.id && each.kind === node.kind));
    const at = beforeId ? order.findIndex((each) => each.id === beforeId) : -1;
    order.splice(at < 0 ? order.length : at, 0, node);
    this.#renumber(parentId, order);
  }
  #touch(playlistId) {
    this.#database.prepare("UPDATE library_playlists SET updated_at = ? WHERE playlist_id = ?").run(this.#now(), playlistId);
  }

  /**
   * The tree the sidebar draws: folders, and playlists with their counts and a cover (the first entry's
   * artwork, or the first made track, whose cover the window draws), Saved among them.
   */
  view() {
    this.#open();
    const folders = this.#database.prepare("SELECT folder_id, parent_id, name, position FROM library_folders").all()
      .map((row) => ({ id: row.folder_id, parentId: row.parent_id ?? null, name: row.name, position: row.position }));
    const firsts = this.#database.prepare("SELECT made_id, refs_json FROM library_entries WHERE playlist_id = ? ORDER BY position LIMIT 8");
    const coverOf = (playlistId) => {
      for (const row of firsts.all(playlistId)) {
        if (row.made_id) return { made_id: row.made_id };
        const artwork = JSON.parse(row.refs_json || "{}").artwork_url;
        if (artwork) return { artwork_url: artwork };
      }
      return null;
    };
    const playlists = this.#database.prepare(`SELECT p.playlist_id, p.folder_id, p.name, p.origin, p.position, p.updated_at,
        (SELECT COUNT(*) FROM library_entries e WHERE e.playlist_id = p.playlist_id) AS count,
        (SELECT COUNT(*) FROM library_entries e WHERE e.playlist_id = p.playlist_id AND e.kind = 'made') AS made
      FROM library_playlists p`).all()
      .map((row) => ({ id: row.playlist_id, folderId: row.folder_id ?? null, name: row.name, origin: row.origin, position: row.position,
        updatedAt: row.updated_at, count: row.count, made: row.made, cover: coverOf(row.playlist_id),
        ...(row.playlist_id === SAVED_PLAYLIST_ID ? { saved: true } : {}) }));
    return { folders, playlists };
  }

  /** One playlist with its entries in order, or null. */
  playlist(id) {
    this.#open();
    const row = this.#database.prepare("SELECT * FROM library_playlists WHERE playlist_id = ?").get(String(id ?? ""));
    if (!row) return null;
    const entries = this.#database.prepare("SELECT * FROM library_entries WHERE playlist_id = ? ORDER BY position, added_at").all(row.playlist_id).map(entryOf);
    return { id: row.playlist_id, folderId: row.folder_id ?? null, name: row.name, origin: row.origin,
      ...(row.source_json ? { source: JSON.parse(row.source_json) } : {}), createdAt: row.created_at, updatedAt: row.updated_at,
      ...(row.playlist_id === SAVED_PLAYLIST_ID ? { saved: true } : {}), entries };
  }

  /** Playlists whose names hold the words, best first, for the agent and the terminal. */
  findPlaylists(query, { limit = 8 } = {}) {
    const wanted = fold(query);
    const { playlists } = this.view();
    if (!wanted) return playlists.slice(0, limit);
    const scored = playlists.map((playlist) => {
      const name = fold(playlist.saved ? "saved" : playlist.name);
      return { playlist, score: name === wanted ? 3 : name.startsWith(wanted) ? 2 : name.includes(wanted) || wanted.includes(name) ? 1 : 0 };
    }).filter((each) => each.score > 0);
    return scored.sort((a, b) => b.score - a.score || b.playlist.updatedAt.localeCompare(a.playlist.updatedAt)).slice(0, limit).map((each) => each.playlist);
  }

  /** Makes a folder, or renames or moves one. Moving keeps it within MAX_DEPTH and never inside itself. */
  saveFolder({ id, name, parentId, beforeId } = {}) {
    return this.#transaction(() => {
      const parent = parentId === undefined ? undefined : parentId === null ? null : cleanId(parentId, "Folder");
      if (!id) {
        const folderName = cleanText(name, 80, "Folder name");
        const under = parent ?? null;
        if (under !== null && this.#depth(under) >= MAX_DEPTH) throw libraryError("library_too_deep", `Folders go ${MAX_DEPTH} levels deep at most.`);
        if (under !== null) this.#requireFolder(under);
        const folderId = randomUUID();
        this.#database.prepare("INSERT INTO library_folders(folder_id, parent_id, name, position, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(folderId, under, folderName, 1e9, this.#now());
        this.#place({ id: folderId, kind: "folder" }, under, beforeId ?? null);
        return { id: folderId, parentId: under, name: folderName };
      }
      const folderId = cleanId(id, "Folder");
      const current = this.#requireFolder(folderId);
      if (name !== undefined) this.#database.prepare("UPDATE library_folders SET name = ? WHERE folder_id = ?").run(cleanText(name, 80, "Folder name"), folderId);
      if (parent !== undefined || beforeId !== undefined) {
        const under = parent === undefined ? current.parent_id ?? null : parent;
        for (let at = under; at !== null; at = this.#requireFolder(at).parent_id ?? null) {
          if (at === folderId) throw libraryError("library_folder_cycle", "A folder can't go inside itself.");
        }
        if ((under === null ? 0 : this.#depth(under)) + this.#height(folderId) > MAX_DEPTH) {
          throw libraryError("library_too_deep", `Folders go ${MAX_DEPTH} levels deep at most.`);
        }
        this.#database.prepare("UPDATE library_folders SET parent_id = ? WHERE folder_id = ?").run(under, folderId);
        this.#place({ id: folderId, kind: "folder" }, under, beforeId ?? null);
        if ((current.parent_id ?? null) !== under) this.#renumber(current.parent_id ?? null, this.#children(current.parent_id ?? null));
      }
      const row = this.#requireFolder(folderId);
      return { id: folderId, parentId: row.parent_id ?? null };
    });
  }

  /** Deletes a folder; what it held moves up into its parent, in its place, so nothing is lost. */
  deleteFolder(id) {
    return this.#transaction(() => {
      const folderId = cleanId(id, "Folder");
      const folder = this.#requireFolder(folderId);
      const parent = folder.parent_id ?? null;
      const held = this.#children(folderId);
      this.#database.prepare("UPDATE library_folders SET parent_id = ? WHERE parent_id = ?").run(parent, folderId);
      this.#database.prepare("UPDATE library_playlists SET folder_id = ? WHERE folder_id = ?").run(parent, folderId);
      const order = this.#children(parent).filter((node) => !held.some((each) => each.id === node.id));
      const at = order.findIndex((node) => node.id === folderId);
      order.splice(at, 1, ...held);
      this.#database.prepare("DELETE FROM library_folders WHERE folder_id = ?").run(folderId);
      this.#renumber(parent, order);
      return { deleted: true, moved: held.length };
    });
  }

  /** Makes a playlist, optionally with entries, or renames or moves one. */
  savePlaylist({ id, name, folderId, beforeId, origin, source, entries, addedBy = "listener" } = {}) {
    return this.#transaction(() => {
      const folder = folderId === undefined ? undefined : folderId === null ? null : cleanId(folderId, "Folder");
      if (folder) this.#requireFolder(folder);
      if (!id) {
        const playlistId = randomUUID();
        const at = this.#now();
        const kept = ORIGINS.has(origin) ? origin : "listener";
        this.#database.prepare(`INSERT INTO library_playlists(playlist_id, folder_id, name, origin, source_json, position, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(playlistId, folder ?? null, cleanText(name, 120, "Playlist name"), kept,
          source && typeof source === "object" ? JSON.stringify(source).slice(0, 2000) : null, 1e9, at, at);
        this.#place({ id: playlistId, kind: "playlist" }, folder ?? null, beforeId ?? null);
        const added = entries?.length ? this.#add(playlistId, entries, { addedBy }) : { added: 0, already: 0 };
        return { id: playlistId, ...added };
      }
      const playlistId = cleanId(id, "Playlist");
      const current = this.#requirePlaylist(playlistId);
      if (name !== undefined) {
        if (playlistId === SAVED_PLAYLIST_ID) throw libraryError("library_saved_fixed", "Saved keeps its name.");
        this.#database.prepare("UPDATE library_playlists SET name = ? WHERE playlist_id = ?").run(cleanText(name, 120, "Playlist name"), playlistId);
        this.#touch(playlistId);
      }
      if (folder !== undefined || beforeId !== undefined) {
        if (playlistId === SAVED_PLAYLIST_ID) throw libraryError("library_saved_fixed", "Saved stays at the top.");
        const under = folder === undefined ? current.folder_id ?? null : folder;
        this.#database.prepare("UPDATE library_playlists SET folder_id = ? WHERE playlist_id = ?").run(under, playlistId);
        this.#place({ id: playlistId, kind: "playlist" }, under, beforeId ?? null);
        if ((current.folder_id ?? null) !== under) this.#renumber(current.folder_id ?? null, this.#children(current.folder_id ?? null));
      }
      return { id: playlistId };
    });
  }

  deletePlaylist(id) {
    return this.#transaction(() => {
      const playlistId = cleanId(id, "Playlist");
      if (playlistId === SAVED_PLAYLIST_ID) throw libraryError("library_saved_fixed", "Saved can't be deleted.");
      const current = this.#requirePlaylist(playlistId);
      this.#database.prepare("DELETE FROM library_entries WHERE playlist_id = ?").run(playlistId);
      this.#database.prepare("DELETE FROM library_playlists WHERE playlist_id = ?").run(playlistId);
      this.#renumber(current.folder_id ?? null, this.#children(current.folder_id ?? null));
      return { deleted: true };
    });
  }

  #add(playlistId, entries, { addedBy = "listener", beforeId = null } = {}) {
    const list = (Array.isArray(entries) ? entries : [entries]).map(normalizeLibraryEntry);
    const rows = this.#database.prepare("SELECT entry_id, kind, title, artist_credit, isrc, made_id FROM library_entries WHERE playlist_id = ? ORDER BY position").all(playlistId);
    // Saved holds each song once; a playlist may hold one twice, as a set can.
    const once = playlistId === SAVED_PLAYLIST_ID;
    const known = new Set(once ? rows.map(entryIdentity) : []);
    const fresh = [];
    let already = 0;
    for (const entry of list) {
      const key = entryIdentity(entry);
      if (once && known.has(key)) { already += 1; continue; }
      known.add(key);
      fresh.push(entry);
    }
    if (rows.length + fresh.length > MAX_ENTRIES) throw libraryError("library_full", `A playlist holds up to ${MAX_ENTRIES} entries.`);
    const by = ADDERS.has(addedBy) ? addedBy : "listener";
    const at = this.#now();
    const insert = this.#database.prepare(`INSERT INTO library_entries(entry_id, playlist_id, position, kind, title, artist_credit, album, isrc, made_id, refs_json, added_by, added_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const ids = fresh.map((entry) => {
      const entryId = randomUUID();
      insert.run(entryId, playlistId, 1e9, entry.kind, entry.title, entry.artist_credit, entry.album, entry.isrc, entry.made_id, JSON.stringify(entry.refs), by, at);
      return entryId;
    });
    // Saved shows the newest first; a playlist adds at the end, or before the entry it was dropped on.
    const order = rows.map((row) => row.entry_id);
    const before = beforeId ? order.indexOf(beforeId) : -1;
    if (playlistId === SAVED_PLAYLIST_ID && !beforeId) order.unshift(...ids);
    else order.splice(before < 0 ? order.length : before, 0, ...ids);
    this.#renumberEntries(order);
    this.#touch(playlistId);
    return { added: ids.length, already, entry_ids: ids };
  }
  #renumberEntries(order) {
    const update = this.#database.prepare("UPDATE library_entries SET position = ? WHERE entry_id = ?");
    order.forEach((entryId, index) => update.run(index, entryId));
  }

  /** Adds songs or made tracks to a playlist (Saved when none is named). */
  addEntries(playlistId = SAVED_PLAYLIST_ID, entries, { addedBy = "listener", beforeId = null } = {}) {
    return this.#transaction(() => {
      const id = cleanId(playlistId ?? SAVED_PLAYLIST_ID, "Playlist");
      this.#requirePlaylist(id);
      return { playlist_id: id, ...this.#add(id, entries, { addedBy, beforeId }) };
    });
  }

  removeEntries(playlistId, entryIds) {
    return this.#transaction(() => {
      const id = cleanId(playlistId, "Playlist");
      this.#requirePlaylist(id);
      const remove = this.#database.prepare("DELETE FROM library_entries WHERE playlist_id = ? AND entry_id = ?");
      const removed = (Array.isArray(entryIds) ? entryIds : [entryIds]).reduce((count, entryId) => count + remove.run(id, String(entryId)).changes, 0);
      this.#renumberEntries(this.#database.prepare("SELECT entry_id FROM library_entries WHERE playlist_id = ? ORDER BY position").all(id).map((row) => row.entry_id));
      this.#touch(id);
      return { removed };
    });
  }

  /** Moves entries, in their order, before another entry or to the end. */
  moveEntries(playlistId, entryIds, beforeId = null) {
    return this.#transaction(() => {
      const id = cleanId(playlistId, "Playlist");
      this.#requirePlaylist(id);
      const moving = new Set((Array.isArray(entryIds) ? entryIds : [entryIds]).map(String));
      const order = this.#database.prepare("SELECT entry_id FROM library_entries WHERE playlist_id = ? ORDER BY position").all(id).map((row) => row.entry_id);
      const moved = order.filter((entryId) => moving.has(entryId));
      const rest = order.filter((entryId) => !moving.has(entryId));
      const at = beforeId && !moving.has(beforeId) ? rest.indexOf(beforeId) : -1;
      rest.splice(at < 0 ? rest.length : at, 0, ...moved);
      this.#renumberEntries(rest);
      this.#touch(id);
      return { moved: moved.length };
    });
  }

  /** Keeps the ids a service found for songs, so their next play skips the search. */
  rememberRefs(updates) {
    if (!Array.isArray(updates) || !updates.length) return;
    this.#transaction(() => {
      const read = this.#database.prepare("SELECT refs_json FROM library_entries WHERE entry_id = ?");
      const write = this.#database.prepare("UPDATE library_entries SET refs_json = ? WHERE entry_id = ?");
      for (const { entryId, refs } of updates) {
        const row = read.get(String(entryId));
        if (row) write.run(JSON.stringify({ ...JSON.parse(row.refs_json || "{}"), ...cleanRefs(refs) }), String(entryId));
      }
    });
  }

  /** Whether a made track is in the library, so its audio is kept. */
  holdsMade(madeId) {
    this.#open();
    return Boolean(this.#database.prepare("SELECT 1 FROM library_entries WHERE made_id = ? LIMIT 1").get(String(madeId ?? "")));
  }

  /** Which of these entries Saved already holds, by identity, so a surface can show a filled mark. */
  savedKeys() {
    this.#open();
    return new Set(this.#database.prepare("SELECT kind, title, artist_credit, isrc, made_id FROM library_entries WHERE playlist_id = ?").all(SAVED_PLAYLIST_ID).map(entryIdentity));
  }

  /** Calls listener after each write through this connection; returns the unsubscribe. */
  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  // SQLite's count of commits by other connections: the terminal's writes reach the window, and the window's the terminal.
  dataVersion() {
    this.#open();
    return this.#database.prepare("PRAGMA data_version").get().data_version;
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#listeners.clear();
    this.#database.close();
  }
}

/** Opens the library at its path, or in memory for the simulated window and tests (":memory:"). */
export async function openLibraryStore({ databasePath = resolveLibraryPath(), clock } = {}) {
  const memory = databasePath === ":memory:";
  if (!memory) {
    const parent = path.dirname(path.resolve(databasePath));
    await mkdir(parent, { recursive: true, mode: 0o700 });
  }
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(memory ? ":memory:" : path.resolve(databasePath));
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    if (!memory) database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA trusted_schema = OFF");
    const version = database.prepare("PRAGMA user_version").get().user_version;
    if (version > LIBRARY_SCHEMA_VERSION) throw libraryError("library_newer", "This library was written by a newer Moondog.");
    database.exec(schema);
    if (version < LIBRARY_SCHEMA_VERSION) database.exec(`PRAGMA user_version = ${LIBRARY_SCHEMA_VERSION}`);
    if (!memory && process.platform !== "win32") await chmod(path.resolve(databasePath), 0o600);
    return new LibraryStore(database, { clock });
  } catch (error) {
    database.close();
    throw error;
  }
}
