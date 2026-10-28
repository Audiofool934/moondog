// NetEase Cloud Music through its official command line tool, ncm-cli (npm @music163/ncm-cli).
// ncm-cli keeps its own App ID, key and sign-in and plays through mpv; Moondog only runs its
// commands and reads their JSON. It serves listeners in mainland China: elsewhere, and for many
// original recordings, NetEase marks songs as not playable (`visible: false`), most often for
// copyright, and no membership changes that.
import { execFile } from "node:child_process";
import { access, constants, stat } from "node:fs/promises";
import path from "node:path";

const COMMAND_TIMEOUT_MS = 20_000;
// Where Homebrew and npm put ncm-cli, the node it runs on, and mpv, for a PATH that lacks them.
const EXTRA_FOLDERS = ["/opt/homebrew/bin", "/usr/local/bin"];
// play returns before mpv runs, so Moondog waits for the player to report the song.
const START_WAIT_MS = 8_000;
const START_POLL_MS = 250;
// ncm-cli's player daemon quits about three seconds after its last client leaves, even in the
// middle of a song, so Moondog reads its state this often while a song plays or is paused.
// state is read locally and sends NetEase nothing.
const KEEP_ALIVE_MS = 1_500;
const KNOWN_SONGS = 300;

const failure = (code, message) => Object.assign(new Error(message), { code });

const folders = (value) => String(value ?? "").split(path.delimiter).filter((folder) => path.isAbsolute(folder));
const searchPath = (environment) => [...new Set([...folders(environment.PATH), ...EXTRA_FOLDERS])];

async function findIn(places) {
  for (const folder of places) {
    const file = path.join(folder, "ncm-cli");
    try {
      if (!(await stat(file)).isFile()) continue;
      await access(file, constants.X_OK);
      return file;
    } catch {}
  }
  return null;
}

// Opened from Finder, the app has its login shell's PATH, which lacks the folders ~/.zshrc adds,
// such as nvm's for npm's global commands. There, the listener's shell as Terminal opens it says.
function terminalPath(environment) {
  return new Promise((resolve) => {
    execFile(environment.SHELL || "/bin/zsh", ["-ilc", 'printf "\\n__MOONDOG_PATH__%s\\n" "$PATH"'], { env: environment, timeout: 5_000 },
      (_error, stdout) => resolve(folders(String(stdout ?? "").match(/__MOONDOG_PATH__(.+)/u)?.[1])));
  });
}

/** ncm-cli and the PATH to run it with, which has the node it runs on, or null. */
async function findNcmCli(environment) {
  const places = searchPath(environment);
  const file = await findIn(places);
  if (file) return { file, places };
  const terminal = await terminalPath(environment);
  const found = await findIn(terminal);
  return found ? { file: found, places: [...new Set([...terminal, ...places])] } : null;
}

// Runs one ncm-cli command and parses its JSON. ncm-cli reports most failures as
// { success: false, message } with exit status 0. play prints no JSON when it starts a song,
// so its answer is {}; the player's state says whether the song started.
function cliRunner({ environment }) {
  // Kept once found. The listener may install ncm-cli while Moondog runs, so a miss is looked for again.
  let found = null;
  return async (args) => {
    found ??= await findNcmCli(environment);
    if (!found) throw failure("netease_cli_missing", "ncm-cli is not installed. Install it with: npm install -g @music163/ncm-cli");
    const env = { ...environment, PATH: found.places.join(path.delimiter) };
    const stdout = await new Promise((resolve, reject) => {
      execFile(found.file, args, { env, timeout: COMMAND_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (error, out) =>
        (error && !out ? reject(failure("netease_failed", `ncm-cli ${args[0]} failed: ${String(error.message).slice(0, 200)}`)) : resolve(String(out ?? ""))));
    });
    const start = stdout.indexOf("{");
    if (start < 0 && args[0] === "play") return {};
    try {
      return JSON.parse(start >= 0 ? stdout.slice(start) : stdout);
    } catch {
      throw failure("netease_failed", `ncm-cli ${args[0]} returned no JSON.`);
    }
  };
}

function checked(result, what) {
  const message = String(result?.message ?? "").trim();
  if (result?.success === false || (result?.code !== undefined && result.code !== 200)) {
    if (/请求总量超限/u.test(message)) throw failure("netease_rate_limited", "NetEase says today's request limit is used up (请求总量超限). Stop and tell the listener.");
    if (/登录|login|token|授权/iu.test(message)) throw failure("netease_signed_out", `NetEase is not signed in (${message}). The listener can run: ncm-cli login`);
    throw failure("netease_failed", `NetEase could not ${what}${message ? `: ${message}` : "."}`);
  }
  return result;
}

const https = (url) => (typeof url === "string" && /^http:\/\/[a-z0-9-]+\.music\.126\.net\//u.test(url) ? `https://${url.slice(7)}` : url ?? null);

function songOf(record) {
  return {
    id: String(record.id),
    original_id: String(record.originalId),
    title: String(record.name ?? ""),
    artists: (Array.isArray(record.artists) ? record.artists : []).map((artist) => String(artist?.name ?? "")).filter(Boolean),
    album: record.album?.name ? String(record.album.name) : null,
    duration_ms: Number.isFinite(record.duration) ? Math.round(record.duration) : null,
    image: https(record.coverImgUrl),
    // NetEase's own word for whether the listener may play it: false most often means copyright.
    playable: record.visible === true,
  };
}

const fold = (value) => String(value ?? "").normalize("NFKC").toLocaleLowerCase("en-US").replace(/[\s\p{P}\p{S}]+/gu, "");

// The best playable recording of a named song: by the named artist before another artist's, and
// the exact title before a longer one such as "稻香(治愈版)".
function pick(songs, { title, artist }) {
  const wantTitle = fold(title);
  const wantArtist = fold(artist);
  const exactTitle = (song) => fold(song.title) === wantTitle;
  const titled = songs.filter((song) => exactTitle(song) || fold(song.title).startsWith(wantTitle));
  const byArtist = (song) => !wantArtist || song.artists.some((name) => fold(name) === wantArtist);
  const playable = titled.filter((song) => song.playable);
  const own = playable.filter(byArtist);
  const found = own.find(exactTitle) ?? own[0];
  if (found) return { song: found, other_artist: false };
  const other = playable.find(exactTitle) ?? playable[0];
  if (other) return { song: other, other_artist: true };
  return { song: null, unplayable: titled.length > 0 };
}

const shortIntent = (intent) => String(intent ?? "").replace(/\s+/gu, " ").trim().slice(0, 60) || "搜索歌曲";

/**
 * The NetEase player. check() reads whether ncm-cli is installed and signed in, and ready()
 * answers from that. Moondog keeps the queue itself and plays each song with ncm-cli's play:
 * ncm-cli's own queue needs the play client that its start handshake sometimes loses, and its
 * queue file breaks under concurrent commands. While a song is loaded, Moondog reads the
 * player's state every keepAliveMs, which keeps ncm-cli's daemon running and starts the next
 * queued song when one ends.
 */
export function createNeteasePlayer({
  environment = process.env,
  run: runCli = cliRunner({ environment }),
  wait = (ms) => new Promise((done) => setTimeout(done, ms)),
  keepAliveMs = KEEP_ALIVE_MS,
} = {}) {
  // ncm-cli's commands share its state files, and two at once can corrupt them ("队列文件损坏"),
  // so they run one at a time.
  let line = Promise.resolve();
  let running = 0;
  const run = (args) => {
    running += 1;
    const result = line.then(() => runCli(args)).finally(() => { running -= 1; });
    line = result.catch(() => {});
    return result;
  };
  let status = { state: "unknown", message: null };
  let queue = [];
  let index = -1;
  // The last state read while a song played, to tell the end of a song from a pause.
  let last = null;
  const known = new Map();
  const remember = (songs) => {
    for (const song of songs) {
      known.delete(song.id);
      known.set(song.id, song);
    }
    while (known.size > KNOWN_SONGS) known.delete(known.keys().next().value);
  };
  const titleOf = (now) => (typeof now?.title === "string" && now.title.trim() ? now.title.trim() : null);
  const isSong = (now, song) => Boolean(song && titleOf(now)?.startsWith(song.title));

  async function state() {
    const result = checked(await run(["state"]), "read what is playing");
    return result.state ?? {};
  }

  let keepAlive = null;
  function stayConnected() {
    if (keepAlive) return;
    let idle = 0;
    keepAlive = setInterval(async () => {
      // A command already running keeps the daemon company.
      if (running) return;
      const now = await state().catch(() => null);
      if (!now) return;
      // The song that played to its end has stopped: the next queued one starts.
      const ended = last && now.status !== "playing" && Number.isFinite(last.duration) && last.position >= last.duration - keepAliveMs / 1000 - 1.5;
      if (ended && index + 1 < queue.length) {
        await playAt(index + 1).catch(() => {});
        return;
      }
      if (now.status === "playing") last = { position: Number(now.position) || 0, duration: Number(now.duration) };
      idle = now.status === "playing" || titleOf(now) ? 0 : idle + 1;
      if (idle >= 2) letGo();
    }, keepAliveMs);
    keepAlive.unref?.();
  }
  function letGo() {
    clearInterval(keepAlive);
    keepAlive = null;
  }

  // Plays one queued song and waits until the player reports it from its start, so a song of
  // the same title still finishing is not taken for it.
  async function playAt(position) {
    const song = queue[position];
    checked(await run(["play", "--song", "--encrypted-id", song.id, "--original-id", song.original_id]), `play ${song.title}`);
    index = position;
    last = null;
    for (let waited = 0; waited < START_WAIT_MS; waited += START_POLL_MS) {
      const now = await state();
      if (now.status === "playing" && isSong(now, song) && (Number(now.position) || 0) < 5) {
        stayConnected();
        return;
      }
      await wait(START_POLL_MS);
    }
    throw failure("netease_not_started", `NetEase did not start ${song.title}. It may not be playable here, most often for copyright.`);
  }

  const player = {
    status: () => ({ ...status }),
    ready: () => status.state === "ready",

    async check() {
      try {
        const result = await run(["login", "--check"]);
        status = result?.success === true ? { state: "ready", message: null } : { state: "signed_out", message: String(result?.message ?? "") || null };
      } catch (error) {
        status = { state: error.code === "netease_cli_missing" ? "missing" : "unavailable", message: error.message };
      }
      return player.status();
    },

    /** Up to 20 songs for one search, playable or not. */
    async search({ query, limit = 10, intent } = {}) {
      const keyword = String(query ?? "").trim().slice(0, 100);
      if (!keyword) throw failure("netease_failed", "Give a song, artist or album to search for.");
      const count = Math.min(20, Math.max(1, Math.round(Number(limit) || 10)));
      const result = checked(await run(["search", "song", "--keyword", keyword, "--limit", String(count), "--userInput", shortIntent(intent)]), "search");
      const songs = (Array.isArray(result.data?.records) ? result.data.records : []).map(songOf);
      remember(songs);
      return songs;
    },

    /**
     * Finds and plays songs: each item is a search result's id, or a title and artist to look
     * up. mode "play" replaces the queue and starts the first; "queue" adds after what is
     * playing. Songs NetEase marks as not playable are never sent to the player, nor songs
     * allow(song) refuses, such as the listener's Avoids; those are only counted. Before a lookup,
     * allow gets the title and artist asked for, as { title, artist_credit }.
     */
    async play({ items = [], mode = "play", intent, allow = () => true } = {}) {
      const found = [];
      const unplayable = [];
      const notFound = [];
      let avoided = 0;
      for (const item of items.slice(0, 20)) {
        if (item?.id) {
          const song = known.get(String(item.id));
          if (!song) notFound.push({ id: String(item.id) });
          else if (!song.playable) unplayable.push(song);
          else if (!allow(song)) avoided += 1;
          else found.push({ song, other_artist: false });
          continue;
        }
        const wanted = { title: String(item?.title ?? ""), artist: String(item?.artist ?? "") };
        if (!allow({ title: wanted.title, artist_credit: wanted.artist })) { avoided += 1; continue; }
        const result = pick(await player.search({ query: `${wanted.title} ${wanted.artist}`.trim(), limit: 10, intent }), wanted);
        if (result.song && !allow(result.song)) avoided += 1;
        else if (result.song) found.push(result);
        else if (result.unplayable) unplayable.push({ title: wanted.title, artists: [wanted.artist].filter(Boolean) });
        else notFound.push(wanted);
      }
      const songs = found.map((entry) => entry.song);
      let outcome = "none";
      if (songs.length) {
        // A paused song still has its title; with nothing loaded, a queue request plays.
        const loaded = mode === "queue" && index >= 0 && titleOf(await state()) !== null;
        if (loaded) {
          queue = [...queue, ...songs];
          outcome = "queued";
        } else {
          queue = songs;
          await playAt(0);
          outcome = "playing";
        }
      }
      return {
        mode: outcome,
        songs: found.map(({ song, other_artist: otherArtist }) => ({ ...song, other_artist: otherArtist })),
        unplayable,
        not_found: notFound,
        ...(avoided ? { skipped_avoided_count: avoided } : {}),
      };
    },

    async pause() { checked(await run(["pause"]), "pause"); },
    async resume() {
      checked(await run(["resume"]), "resume");
      stayConnected();
    },
    async next() {
      if (index + 1 >= queue.length) throw failure("netease_failed", "Nothing is queued after this song.");
      await playAt(index + 1);
    },
    // Back to the start of the song, or to the one before when it has only just begun.
    async previous() {
      const now = await state();
      if (index > 0 && (Number(now.position) || 0) <= 3) await playAt(index - 1);
      else checked(await run(["seek", "0"]), "go back to the start");
    },
    async seek({ positionMs = 0 } = {}) {
      checked(await run(["seek", String(Math.max(0, Math.round(positionMs / 1000)))]), "move in the song");
      last = null;
    },
    async stop() {
      letGo();
      queue = [];
      index = -1;
      last = null;
      checked(await run(["stop"]), "stop");
    },

    /**
     * What is playing: "playing", "paused" (ncm-cli reports a paused song as stopped, with its
     * title still set) or "stopped", the song, its position, and the songs queued after it.
     */
    async nowPlaying() {
      const now = await state();
      const title = titleOf(now);
      if (!title) return { state: "stopped", song: null, position_ms: 0, next: [] };
      const queued = queue[index];
      // ncm-cli names the song "title - artist"; a song played from elsewhere is shown by that name.
      const ours = isSong(now, queued);
      const song = ours ? queued : { id: null, original_id: null, title: title.replace(/\s+-\s+[^-]+$/u, ""),
        artists: title.includes(" - ") ? [title.split(" - ").pop()] : [], album: null, duration_ms: null, image: null, playable: true };
      return {
        state: now.status === "playing" ? "playing" : "paused",
        song: { ...song, duration_ms: Number.isFinite(now.duration) ? Math.round(now.duration * 1000) : song.duration_ms },
        position_ms: Number.isFinite(now.position) ? Math.round(now.position * 1000) : 0,
        next: ours ? queue.slice(index + 1) : [],
      };
    },
  };
  return player;
}
