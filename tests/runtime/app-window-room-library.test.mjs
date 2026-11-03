import assert from "node:assert/strict";
import test from "node:test";
import { runWindowRoom } from "../../app/window-room.mjs";
import { openLibraryStore } from "../../src/core/library-store.mjs";

const tick = async () => {
  for (let step = 0; step < 6; step += 1) await new Promise((resolve) => { setImmediate(resolve); });
};
const settle = () => new Promise((resolve) => { setTimeout(resolve, 80); });

function application(libraryStore) {
  return {
    locale: "en", playbackService: "spotify", sessionId: "A", libraryStore,
    ensureMemorySession() { return { session_id: this.sessionId }; },
    startNewSession() {}, resumeSession() {},
    listSavedSessions() { return []; }, listConversationFolders() { return []; }, currentConversationTurns() { return []; },
    spotifyReady() { return false; }, spotifyStatus() { return { state: "unavailable" }; }, memoryStatus() { return { state: "unavailable" }; },
    profileServicesReady() { return false; },
    libraryView() { return libraryStore.view(); },
    async libraryPlaylist(id) { return libraryStore.playlist(id); },
  };
}
const runtime = { publicStatus: () => ({ state: "configured", provider: "p", model: "m", effort: null, effort_levels: [] }), reset() {}, restoreSession() {} };

test("the window gets the library, edits it, and hears the terminal's changes", async () => {
  const libraryStore = await openLibraryStore({ databasePath: ":memory:" });
  const messages = [];
  let listener = null;
  const quit = new AbortController();
  const room = runWindowRoom({ application: application(libraryStore), runtime, modelSettings: { async models() { return { models: [] }; } },
    openConversation: async () => { throw new Error("unused"); } }, {
    port: { on(_type, fn) { listener = fn; }, start() {} }, send: (message) => { messages.push(message); }, quit: quit.signal, focus: new EventTarget(),
  });
  await tick();
  const last = (type) => messages.findLast((message) => message.type === type);
  // The tree arrives at launch, Saved in it.
  assert.ok(last("library").playlists.some((playlist) => playlist.saved));

  // A folder, then a playlist made inside it, which opens.
  listener({ data: { type: "library-folder-save", name: "Moods" } });
  await settle();
  const folder = last("library").folders[0];
  listener({ data: { type: "library-playlist-save", name: "Rain", folderId: folder.id } });
  await settle();
  const made = last("library-made");
  assert.ok(made?.id);
  assert.equal(last("library").playlists.find((playlist) => playlist.id === made.id).folderId, folder.id);

  // The open playlist follows its writes: here an entry added as the terminal or the agent would add it.
  listener({ data: { type: "library-open", id: made.id } });
  await settle();
  libraryStore.addEntries(made.id, [{ title: "Pink Moon", artist: "Nick Drake" }]);
  await settle();
  assert.deepEqual(last("library-playlist").playlist.entries.map((entry) => entry.title), ["Pink Moon"]);

  // Deleting the open playlist tells the window it is gone, so the window closes it.
  listener({ data: { type: "library-playlist-delete", id: made.id } });
  await settle();
  assert.deepEqual([last("library-playlist").id, last("library-playlist").playlist], [made.id, null]);

  // A refused edit comes back as a notice with the store's code.
  listener({ data: { type: "library-playlist-delete", id: "saved" } });
  await settle();
  assert.equal(last("notice").code, "library_saved_fixed");
  quit.abort();
  await room;
  libraryStore.close();
});
