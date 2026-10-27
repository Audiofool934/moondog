// What the window's core reads in the page's scene: the scene's conversations, kept in the tab, and a
// Music app that plays the scene's songs, as Moondog reads the Music app on a Mac. Nothing is fetched.
import { shortConversationTitle } from "../../src/memory/local-memory-store.mjs";

const now = () => new Date().toISOString();

// The Music app as window-room reads it (src/integrations/apple-music/music-app.mjs): what plays, where
// it is, the songs after it, and each song's cover. Songs carry their covers as data URLs.
export function createSceneMusicApp() {
  let queue = [];
  let index = 0;
  let startedAt = 0;
  return {
    available: true,
    play(songs) {
      queue = songs.map((song, place) => ({ id: `scene-${song.title}`, ...song, place }));
      index = 0;
      startedAt = Date.now();
    },
    async nowPlaying() {
      if (!queue.length) return { state: "not_running" };
      // The queue moves on by the clock, a song at a time.
      let position = Date.now() - startedAt;
      while (position > queue[index].duration_ms && index < queue.length - 1) {
        position -= queue[index].duration_ms;
        startedAt += queue[index].duration_ms;
        index += 1;
      }
      const song = queue[index];
      return { state: "playing", song, position_ms: Math.min(position, song.duration_ms), shuffle: false, repeat: "off",
        playlist: { id: "scene", name: "Moondog", library: false, position: index + 1, first_position: 1, tracks: queue } };
    },
    async cover(song) { return song?.image ?? null; },
    async pause() {},
    async resume() {},
    async next() {},
    async previous() {},
    async seek() {},
  };
}

export class SceneApplication {
  constructor({ musicApp }) {
    this.locale = "en";
    this.conversationLocale = "en";
    this.playbackService = "apple_music";
    this.musicApp = musicApp;
    this.conversations = new Map();
    this.sequence = 0;
    this.startNewSession();
  }

  spotifyReady() { return false; }
  spotifyStatus() { return { state: "not_configured", client_id_configured: false }; }

  // Conversations live in this tab. A new one is listed after its first message.
  startNewSession() {
    const id = `scene-${(this.sequence += 1)}`;
    this.current = { id, title: "", startedAt: now(), updatedAt: now(), entries: [] };
    this.conversations.set(id, this.current);
    return { session_id: id };
  }
  ensureMemorySession() { return { session_id: this.current.id }; }
  resumeSession(id) {
    this.current = this.conversations.get(id) ?? this.current;
    return { session_id: this.current.id };
  }
  // The scene's agent saves each finished turn here, as the app's agent saves it to memory.
  recordTurn(userText, assistantText) {
    this.current.entries.push({ user_text: userText, assistant_text: assistantText });
    this.current.title ||= shortConversationTitle(userText);
    this.current.updatedAt = now();
  }
  currentConversationTurns({ limit = 40 } = {}) {
    return this.current.entries.flatMap((entry) => [{ role: "user", text: entry.user_text }, { role: "assistant", text: entry.assistant_text }]).slice(-limit);
  }
  listSavedSessions() {
    return [...this.conversations.values()].filter((conversation) => conversation.entries.length)
      .map((conversation) => ({ session_id: conversation.id, title: conversation.title, started_at: conversation.startedAt, updated_at: conversation.updatedAt }));
  }
}
