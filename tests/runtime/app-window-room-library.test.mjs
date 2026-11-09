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
    async previewPlaylistLink({ link }) {
      if (!link.includes("spotify")) throw Object.assign(new Error("unsupported"), { code: "playlist_link_unsupported" });
      return { token: "t1", provider: "spotify", name: "Night drive", read: 2, total: 2, owned: true, sample: ["Pink Moon - Nick Drake"] };
    },
    async importPlaylistLink({ token, taste, folderId }) {
      return { playlist: { id: `imported-${token}-${taste}-${folderId}`, name: "Night drive" }, added: 2, taste: taste ? "added" : "not_added" };
    },
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

  // A pasted link is read and shown first; the import carries the listener's answer and the folder it was pasted in.
  listener({ data: { type: "library-import-preview", link: "https://open.spotify.com/playlist/x", folderId: folder.id } });
  await settle();
  assert.deepEqual([last("library-import-preview").token, last("library-import-preview").folderId], ["t1", folder.id]);
  listener({ data: { type: "library-import", token: "t1", taste: true, folderId: folder.id } });
  await settle();
  assert.equal(last("library-imported").playlist.id, `imported-t1-true-${folder.id}`);
  listener({ data: { type: "library-import-preview", link: "https://example.com/x" } });
  await settle();
  assert.equal(last("notice").code, "playlist_link_unsupported");

  // A refused edit comes back as a notice with the store's code.
  listener({ data: { type: "library-playlist-delete", id: "saved" } });
  await settle();
  assert.equal(last("notice").code, "library_saved_fixed");
  quit.abort();
  await room;
  libraryStore.close();
});

test("a message from an open playlist starts its own conversation, or goes back to the composer", async (t) => {
  const libraryStore = await openLibraryStore({ databasePath: ":memory:" });
  const messages = [];
  let listener = null;
  const quit = new AbortController();
  t.after(() => { quit.abort(); libraryStore.close(); });
  let opened = 0;
  const app = { ...application(libraryStore), startNewSession() { opened += 1; this.sessionId = `new-${opened}`; } };
  const asked = [];
  const answering = { ...runtime, async prompt(text) { asked.push([app.sessionId, text]); return { status: "completed", text: "ok" }; } };
  const room = runWindowRoom({ application: app, runtime: answering, modelSettings: { async models() { return { models: [] }; } },
    openConversation: async () => { throw new Error("unused"); } }, {
    port: { on(_type, fn) { listener = fn; }, start() {} }, send: (message) => { messages.push(message); }, quit: quit.signal, focus: new EventTarget(),
  });
  await tick();

  listener({ data: { type: "prompt", text: "stays here" } });
  await settle();
  const first = asked.at(-1)[0];
  assert.equal(asked.at(-1)[1], "stays here");

  listener({ data: { type: "prompt", text: "@Rain too loud", fresh: true } });
  await settle();
  assert.equal(asked.at(-1)[1], "@Rain too loud");
  assert.notEqual(asked.at(-1)[0], first);
  assert.equal(messages.findLast((message) => message.type === "session").current, asked.at(-1)[0]);

  // No new conversation could open: the message is not sent into the one on screen.
  app.startNewSession = () => {};
  listener({ data: { type: "prompt", text: "@Rain again", fresh: true } });
  await settle();
  assert.equal(asked.length, 2);
  assert.equal(messages.findLast((message) => message.type === "notice").text, "@Rain again");
  quit.abort();
  await room;
});
