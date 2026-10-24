// The Music app on this Mac, read and controlled through Apple Events (osascript). Moondog sees what
// the listener plays there themselves, and the playlist it comes from. Nothing is sent until the app
// is running, so reading never opens Music. The first read asks the listener to let Moondog (or the
// terminal it runs in) control Music; until they allow it, reads answer "not_allowed".
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// The first read waits while macOS asks the listener; later ones answer in well under a second.
const READ_TIMEOUT_MS = 15_000;
// A playlist longer than this is read as a window around the playing song.
const PLAYLIST_WINDOW = 50;
const PLAYLIST_BEFORE = 5;
const COLUMN_READ_MAX = 2_000;
// Covers already drawn, by album, or by song for one without an album.
const KNOWN_COVERS = 40;
const COVER_SIZE = 600;
// After a refusal, Moondog asks macOS again only this often.
const REFUSED_RETRY_MS = 60_000;

const failure = (code, message) => Object.assign(new Error(message), { code });

// One JSON answer per run. argv: the action, then its argument.
const SCRIPT = String.raw`
function run(argv) {
  const action = argv[0];
  const music = Application("Music");
  if (!music.running()) return JSON.stringify({ running: false });
  if (action === "pause") music.pause();
  else if (action === "resume") music.play();
  else if (action === "next") music.nextTrack();
  else if (action === "previous") music.backTrack();
  else if (action === "seek") music.playerPosition = Number(argv[1]);
  const state = music.playerState();
  const answer = { running: true, state: state };
  if (state === "stopped") return JSON.stringify(answer);
  try {
    const track = music.currentTrack.properties();
    answer.track = { id: track.persistentID, title: track.name, artist: track.artist, album: track.album,
      albumArtist: track.albumArtist, duration: track.duration };
  } catch (error) {}
  try { answer.stream = music.currentStreamTitle(); } catch (error) {}
  try { answer.position = music.playerPosition(); } catch (error) {}
  try { answer.shuffle = music.shuffleEnabled(); answer.repeat = music.songRepeat(); } catch (error) {}
  try {
    const playlist = music.currentPlaylist;
    answer.playlist = { id: playlist.persistentID(), name: playlist.name() };
    try { answer.playlist.special = playlist.specialKind(); } catch (error) {}
    if (action === "tracks") {
      const tracks = playlist.tracks;
      const ids = tracks.persistentID();
      answer.playlist.count = ids.length;
      const at = answer.track ? ids.indexOf(answer.track.id) : -1;
      const start = ids.length <= ${PLAYLIST_WINDOW} || at < 0 ? 0 : Math.max(0, Math.min(at - ${PLAYLIST_BEFORE}, ids.length - ${PLAYLIST_WINDOW}));
      const end = Math.min(ids.length, start + ${PLAYLIST_WINDOW});
      answer.playlist.index = at;
      answer.playlist.start = start;
      answer.playlist.tracks = [];
      // A playlist of ordinary length comes back fastest a column at a time; a long one, song by song.
      if (ids.length <= ${COLUMN_READ_MAX}) {
        const titles = tracks.name(), artists = tracks.artist(), albums = tracks.album(), durations = tracks.duration();
        for (let index = start; index < end; index++) {
          answer.playlist.tracks.push({ id: ids[index], title: titles[index], artist: artists[index], album: albums[index], duration: durations[index] });
        }
      } else {
        for (let index = start; index < end; index++) {
          const entry = tracks[index].properties();
          answer.playlist.tracks.push({ id: entry.persistentID, title: entry.name, artist: entry.artist, album: entry.album, duration: entry.duration });
        }
      }
    }
  } catch (error) {}
  return JSON.stringify(answer);
}`;

// Music hands a cover over only as AppleScript data, which JavaScript for Automation cannot write.
// argv: the file to write, then the persistent id of the playing song or of one in its playlist.
const COVER_SCRIPT = String.raw`
on run argv
  if application "Music" is not running then return "none"
  set wanted to item 2 of argv
  tell application "Music"
    try
      if persistent ID of current track is wanted then
        set chosen to current track
      else
        set chosen to first track of current playlist whose persistent ID is wanted
      end if
      set cover to raw data of artwork 1 of chosen
    on error
      return "none"
    end try
  end tell
  set target to open for access (POSIX file (item 1 of argv)) with write permission
  set eof target to 0
  write cover to target
  close access target
  return "ok"
end run`;

function osascript(args, { timeout = READ_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/osascript", args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return resolve(String(stdout).trim());
      // -1743: the listener has not let this app control Music (System Settings, Privacy & Security, Automation).
      if (/-1743|Not authori[sz]ed/iu.test(String(stderr))) {
        return reject(failure("music_app_not_allowed", "Moondog is not allowed to control the Music app. Turn it on in System Settings, Privacy & Security, Automation."));
      }
      reject(failure("music_app_failed", `The Music app did not answer: ${String(stderr || error.message).trim().slice(0, 200)}`));
    });
  });
}

const text = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);
const milliseconds = (seconds) => (Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null);

function songOf(track) {
  return {
    id: text(track.id),
    title: text(track.title) ?? "",
    artists: text(track.artist) ? [text(track.artist)] : [],
    album: text(track.album),
    duration_ms: milliseconds(track.duration),
  };
}

// A radio station names its song only in the stream's title, "Artist - Title".
function streamSongOf(answer) {
  const stream = text(answer.stream);
  if (!stream) return answer.track ? songOf(answer.track) : null;
  const [artist, ...title] = stream.split(" - ");
  return title.length ? { id: null, title: title.join(" - "), artists: [artist], album: text(answer.track?.title), duration_ms: null }
    : { id: null, title: stream, artists: [], album: text(answer.track?.title), duration_ms: null };
}

/**
 * What the Music app plays: { state, song, position_ms, shuffle, repeat, playlist }.
 * state is "playing", "paused" or "stopped"; "not_running" while the app is closed,
 * "not_allowed" until the listener lets Moondog control it, "unavailable" off macOS.
 * playlist.tracks, with the playing song's place among them, comes only when asked for.
 */
function nowPlayingOf(answer) {
  if (!answer?.running) return { state: "not_running" };
  const state = answer.state === "playing" || answer.state === "fast forwarding" || answer.state === "rewinding" ? "playing"
    : answer.state === "paused" ? "paused" : "stopped";
  const song = state === "stopped" ? null : streamSongOf(answer);
  if (!song?.title) return { state: "stopped" };
  const playlist = answer.playlist && text(answer.playlist.name) ? {
    id: text(answer.playlist.id),
    name: text(answer.playlist.name),
    // "Library" or "Music" when the song plays from the whole library rather than a playlist.
    library: ["Library", "Music"].includes(answer.playlist.special),
    ...(Number.isInteger(answer.playlist.count) ? { tracks_total: answer.playlist.count } : {}),
    ...(Array.isArray(answer.playlist.tracks) ? {
      position: answer.playlist.index >= 0 ? answer.playlist.index + 1 : null,
      first_position: answer.playlist.start + 1,
      tracks: answer.playlist.tracks.map(songOf),
    } : {}),
  } : null;
  return {
    state,
    song,
    position_ms: milliseconds(answer.position) ?? 0,
    shuffle: answer.shuffle === true,
    repeat: answer.repeat === "one" ? "track" : answer.repeat === "all" ? "context" : "off",
    playlist,
  };
}

export function createMusicAppPlayer({ platform = process.platform, run = osascript, now = Date.now } = {}) {
  const available = platform === "darwin";
  let refusedAt = null;
  const covers = new Map();

  async function ask(action, argument) {
    if (!available) return null;
    if (refusedAt !== null && now() - refusedAt < REFUSED_RETRY_MS) throw failure("music_app_not_allowed", "Moondog is not allowed to control the Music app. Turn it on in System Settings, Privacy & Security, Automation.");
    try {
      const answer = JSON.parse(await run(["-l", "JavaScript", "-e", SCRIPT, action, ...(argument === undefined ? [] : [String(argument)])]));
      refusedAt = null;
      return answer;
    } catch (error) {
      if (error?.code === "music_app_not_allowed") refusedAt = now();
      throw error;
    }
  }
  const read = async (action, argument) => {
    try {
      return available ? nowPlayingOf(await ask(action, argument)) : { state: "unavailable" };
    } catch (error) {
      if (error?.code === "music_app_not_allowed") return { state: "not_allowed", reason: error.message };
      throw error;
    }
  };

  return {
    available,
    nowPlaying: ({ tracks = false } = {}) => read(tracks ? "tracks" : "read"),
    pause: () => read("pause"),
    resume: () => read("resume"),
    next: () => read("next"),
    previous: () => read("previous"),
    seek: ({ positionMs = 0 } = {}) => read("seek", Math.max(0, positionMs) / 1000),

    // The cover of the playing song, or of one in its playlist, as a data URL. It is read from Music
    // and scaled down once per album.
    async cover(song) {
      if (!available || !song?.id) return null;
      const key = song.album ? `${song.artists?.[0] ?? ""}\n${song.album}` : song.id;
      if (covers.has(key)) return covers.get(key);
      const folder = await mkdtemp(path.join(tmpdir(), "moondog-cover-"));
      let url = null;
      try {
        const original = path.join(folder, "cover");
        const scaled = path.join(folder, "cover.jpg");
        if (await run(["-e", COVER_SCRIPT, original, song.id]) === "ok") {
          await new Promise((resolve, reject) => execFile("/usr/bin/sips", ["-s", "format", "jpeg", "-Z", String(COVER_SIZE), original, "--out", scaled],
            { timeout: READ_TIMEOUT_MS }, (error) => (error ? reject(error) : resolve())));
          url = `data:image/jpeg;base64,${(await readFile(scaled)).toString("base64")}`;
        }
      } catch {
        url = null;
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
      covers.set(key, url);
      if (covers.size > KNOWN_COVERS) covers.delete(covers.keys().next().value);
      return url;
    },
  };
}
