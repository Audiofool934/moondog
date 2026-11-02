// What Moondog's own player plays: the queue it was sent last, and where in it the player's own
// events put it. The window and the terminal players keep one each, so the agent can read the songs
// it played or queued, and the tracks it made, as it reads the Music app or Spotify.

const entry = (track) => ({
  title: String(track?.title ?? "").trim(),
  artist_credit: String(track?.artist_credit ?? "").trim(),
  ...(track?.generated === true ? { generated: true } : {}),
});

export function createPlayerNow() {
  // null, or { tracks, index, state } where state is "loading", "playing" or "paused".
  let queue = null;
  return {
    /** A new queue replaces the last one and starts from its first song. */
    queued(tracks) {
      const list = (Array.isArray(tracks) ? tracks : []).map(entry).filter((track) => track.title);
      queue = list.length ? { tracks: list, index: 0, state: "loading" } : null;
    },
    /** A made track queued behind the last one, as Moondog's stream does. */
    appended(track) {
      const added = entry(track);
      if (queue && added.title) queue.tracks.push(added);
    },
    /** One of the player's events: { type, position } moves it along; stopped empties it. */
    observe(event) {
      // The terminal's player announces each new queue with its songs; the window's does not.
      if (event?.type === "queue" && Array.isArray(event.tracks)) { this.queued(event.tracks); return; }
      if (!queue) return;
      if (event?.type === "stopped") { queue = null; return; }
      if (Number.isInteger(event?.position) && event.position >= 1 && event.position <= queue.tracks.length) queue.index = event.position - 1;
      if (event?.type === "playing" || event?.type === "paused" || event?.type === "loading") queue.state = event.type;
    },
    clear() {
      queue = null;
    },
    /** null when nothing is queued, or { state, song, position, count, next } with up to ten songs after it. */
    read() {
      if (!queue) return null;
      return {
        // A song still loading is the one the listener is about to hear.
        state: queue.state === "paused" ? "paused" : "playing",
        song: { ...queue.tracks[queue.index] },
        position: queue.index + 1,
        count: queue.tracks.length,
        next: queue.tracks.slice(queue.index + 1, queue.index + 11).map((track) => ({ ...track })),
      };
    },
  };
}
