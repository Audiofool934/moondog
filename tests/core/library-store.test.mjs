import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { MAX_DEPTH, openLibraryStore, SAVED_PLAYLIST_ID } from "../../src/core/library-store.mjs";

const MADE = "0b7c6f1e-2a3d-4c5e-8f90-1a2b3c4d5e6f";

test("folders nest, keep one order with playlists, and give up what they held when deleted", async () => {
  const library = await openLibraryStore({ databasePath: ":memory:" });
  const moods = library.saveFolder({ name: "Moods" });
  const night = library.saveFolder({ name: "Night", parentId: moods.id });
  const rain = library.savePlaylist({ name: "Rain", folderId: night.id });
  const first = library.savePlaylist({ name: "First", folderId: moods.id, beforeId: night.id });
  const order = (parent) => {
    const { folders, playlists } = library.view();
    return [...folders.filter((f) => f.parentId === parent).map((f) => [f.name, f.position]),
      ...playlists.filter((p) => p.folderId === parent && !p.saved).map((p) => [p.name, p.position])]
      .sort((a, b) => a[1] - b[1]).map(([name]) => name);
  };
  assert.deepEqual(order(moods.id), ["First", "Night"]);

  // Never inside itself, and never deeper than MAX_DEPTH.
  assert.throws(() => library.saveFolder({ id: moods.id, parentId: night.id }), { code: "library_folder_cycle" });
  let parent = night.id;
  for (let depth = 2; depth < MAX_DEPTH; depth += 1) parent = library.saveFolder({ name: `L${depth}`, parentId: parent }).id;
  assert.throws(() => library.saveFolder({ name: "Too deep", parentId: parent }), { code: "library_too_deep" });

  library.deleteFolder(night.id);
  assert.deepEqual(order(moods.id), ["First", "Rain", "L2"]);
  assert.equal(library.playlist(rain.id).folderId, moods.id);
  assert.equal(library.playlist(first.id).name, "First");
  library.close();
});

test("Saved is fixed, holds each song once, and keeps the made tracks it holds", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "moondog-library-"));
  try {
    const library = await openLibraryStore({ databasePath: path.join(folder, "library.sqlite") });
    assert.throws(() => library.deletePlaylist(SAVED_PLAYLIST_ID), { code: "library_saved_fixed" });
    assert.throws(() => library.savePlaylist({ id: SAVED_PLAYLIST_ID, name: "Mine" }), { code: "library_saved_fixed" });
    const first = library.addEntries(SAVED_PLAYLIST_ID, [{ title: "Blue in Green", artist: "Miles Davis" }]);
    const again = library.addEntries(SAVED_PLAYLIST_ID, [{ title: "blue in green", artist_credit: "Miles  Davis" }, { kind: "made", id: MADE, title: "Tide Glass" }]);
    assert.equal(first.added, 1);
    assert.deepEqual([again.added, again.already], [1, 1]);
    // The newest first.
    assert.deepEqual(library.playlist(SAVED_PLAYLIST_ID).entries.map((entry) => entry.title), ["Tide Glass", "Blue in Green"]);
    assert.equal(library.holdsMade(MADE), true);

    // A playlist may hold a song twice, keeps the order it is given, and moves entries by hand.
    const set = library.savePlaylist({ name: "Set", entries: [{ title: "A", artist: "X" }, { title: "B", artist: "X" }, { title: "A", artist: "X" }] });
    assert.equal(set.added, 3);
    const ids = library.playlist(set.id).entries.map((entry) => entry.id);
    library.moveEntries(set.id, [ids[2]], ids[0]);
    library.rememberRefs([{ entryId: ids[1], refs: { spotify_uri: "spotify:track:1", other: "dropped" } }]);
    const entries = library.playlist(set.id).entries;
    assert.deepEqual(entries.map((entry) => entry.id), [ids[2], ids[0], ids[1]]);
    assert.deepEqual(entries[2].refs, { spotify_uri: "spotify:track:1" });

    // Another connection sees the writes, and its data version moves.
    const other = await openLibraryStore({ databasePath: path.join(folder, "library.sqlite") });
    const seen = other.dataVersion();
    library.removeEntries(SAVED_PLAYLIST_ID, library.playlist(SAVED_PLAYLIST_ID).entries[0].id);
    assert.notEqual(other.dataVersion(), seen);
    assert.equal(other.holdsMade(MADE), false);
    other.close();
    library.close();
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
