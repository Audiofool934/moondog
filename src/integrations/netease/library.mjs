import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveMoondogStateDirectory } from "../../core/state-directory.mjs";
import { musicHash, musicText, prepareMusicBundle } from "../../profile/music-import-bundle.mjs";

const fail = (code, message) => Object.assign(new Error(message), { code });
const idOf = (value) => {
  const id = String(value ?? "");
  if (!/^[1-9][0-9]{0,19}$/u.test(id)) throw fail("netease_invalid_id", "Invalid NetEase music identifier.");
  return id;
};
export function normalizeNeteaseCookie(value) {
  const match = String(value ?? "").match(/(?:^|;\s*)MUSIC_U=([^;\s\r\n]{1,8192})(?:;|$)/u);
  if (!match) throw fail("netease_invalid_cookie", "NetEase did not supply a login session. Please sign in again.");
  return `MUSIC_U=${match[1]}`;
}
const artwork = (value) => {
  try {
    const url = new URL(value);
    if (!/(?:^|\.)music\.126\.net$/u.test(url.hostname)) return null;
    url.protocol = "https:";
    return url.href;
  } catch { return null; }
};
const accountOf = (data) => {
  const id = data.account?.id ?? data.profile?.userId;
  if (!id) throw fail("netease_signed_out", "Your NetEase session expired. Sign in again.");
  return { userId: idOf(id), nickname: musicText(data.profile?.nickname) || "NetEase listener", avatarUrl: artwork(data.profile?.avatarUrl) };
};
const trackOf = (song) => ({ id: idOf(song.id), title: musicText(song.name),
  artists: (song.ar ?? song.artists ?? []).map((artist) => musicText(artist.name)).filter(Boolean),
  album: musicText((song.al ?? song.album)?.name), durationMs: song.dt ?? song.duration ?? 0,
  image: artwork((song.al ?? song.album)?.picUrl), available: true });

export function neteaseAudioUrl(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port ||
      !/(?:^|\.)music\.126\.net$/u.test(url.hostname)) return null;
    url.protocol = "https:";
    return url.href;
  } catch { return null; }
}

/** Account metadata only crosses this boundary. Cookies stay in the core and local state. */
export function createNeteaseLibrary({ environment = process.env, fetchImpl = globalThis.fetch,
  credentialPath = path.join(resolveMoondogStateDirectory(environment), "netease-session.json") } = {}) {
  let session = null;
  let loading = null;
  let epoch = 0;
  let persistence = Promise.resolve();
  const current = (version) => { if (version !== epoch) throw fail("netease_session_changed", "The NetEase account changed. Refresh and try again."); };
  const persist = (value) => {
    const work = persistence.then(async () => {
      if (!value) return rm(credentialPath, { force: true });
      await mkdir(path.dirname(credentialPath), { recursive: true, mode: 0o700 });
      const temporary = `${credentialPath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
        await rename(temporary, credentialPath);
      } finally { await rm(temporary, { force: true }); }
    });
    persistence = work.catch(() => {});
    return work;
  };
  async function load() {
    loading ??= (async () => {
      try {
        const saved = JSON.parse(await readFile(credentialPath, "utf8"));
        session = { cookie: normalizeNeteaseCookie(saved.cookie), account: accountOf({ profile: saved.account }) };
      } catch { session = null; }
    })();
    await loading;
  }
  async function request(endpoint, { cookie = session?.cookie, signal, form } = {}) {
    if (!cookie) throw fail("netease_signed_out", "Sign in to NetEase Cloud Music first.");
    let response;
    try {
      response = await fetchImpl(`https://music.163.com${endpoint}`, {
        method: form ? "POST" : "GET", redirect: "error",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
        headers: { Cookie: cookie, Referer: "https://music.163.com/", "User-Agent": "Mozilla/5.0", Accept: "application/json",
          ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
        ...(form ? { body: new URLSearchParams(form).toString() } : {}),
      });
    } catch {
      signal?.throwIfAborted();
      throw fail("netease_network", "Could not reach NetEase. Check your connection and retry.");
    }
    if ([301, 401, 403].includes(response.status)) throw fail("netease_signed_out", "Your NetEase session expired or access was refused. Sign in again.");
    if (!response.ok) throw fail("netease_network", `NetEase returned HTTP ${response.status}. Try again later.`);
    let data;
    try { data = await response.json(); } catch { throw fail("netease_response", "NetEase returned an unreadable response. Try again later."); }
    if ([301, 302, 401].includes(data.code)) throw fail("netease_signed_out", "Your NetEase session expired. Sign in again.");
    if (data.code !== 200) throw fail("netease_unavailable", "NetEase could not read this account or playlist. Check its access and try again.");
    return data;
  }
  const service = {
    async playback(trackId, { signal } = {}) {
      await load();
      const version = epoch;
      const id = idOf(trackId);
      let preview = null;
      for (const level of ["exhigh", "higher", "standard"]) {
        const data = await request(`/api/song/enhance/player/url/v1?ids=${encodeURIComponent(JSON.stringify([id]))}&level=${level}&encodeType=mp3`, { signal });
        current(version);
        const audio = data.data?.find((item) => String(item.id) === id);
        const url = neteaseAudioUrl(audio?.url);
        if (!url || audio?.code !== 200) continue;
        const source = { url, trial: Boolean(audio.freeTrialInfo), expiresIn: Number(audio.expi) || 1200 };
        if (!source.trial) return source;
        preview ??= source;
      }
      if (preview) return preview;
      throw fail("netease_unplayable", "这首歌暂不可播放，可能需要会员、购买或版权授权。 / This song is unavailable for this account or region.");
    },
    async search({ query, limit = 10, signal } = {}) {
      await load();
      const version = epoch;
      const keyword = musicText(query);
      if (!keyword) throw fail("netease_invalid_query", "Enter a song or artist to search.");
      const data = await request(`/api/cloudsearch/pc?s=${encodeURIComponent(keyword)}&type=1&limit=${Math.min(20, Math.max(1, Number(limit) || 10))}&offset=0`, { signal });
      current(version);
      return (data.result?.songs ?? []).map(trackOf);
    },
    async status({ refresh = false, signal } = {}) {
      await load();
      const version = epoch;
      if (session && refresh) {
        try {
          const account = accountOf(await request("/api/nuser/account/get", { signal }));
          current(version);
          session.account = account;
        } catch (error) {
          if (error.code !== "netease_signed_out") throw error;
          current(version);
          session = null;
          epoch += 1;
          await persist(null);
        }
      }
      return { state: session ? "connected" : "signed_out", account: session ? { ...session.account } : null };
    },
    async login(openLogin, { signal } = {}) {
      await load();
      const version = ++epoch;
      const value = await openLogin({ signal });
      signal?.throwIfAborted();
      current(version);
      if (!value) return { ...(await service.status()), cancelled: true };
      const cookie = normalizeNeteaseCookie(value);
      const account = accountOf(await request("/api/nuser/account/get", { cookie, signal }));
      current(version);
      await persist({ cookie, account });
      current(version);
      session = { cookie, account };
      epoch += 1;
      return service.status();
    },
    async logout() {
      await load();
      epoch += 1;
      session = null;
      await persist(null);
      return service.status();
    },
    async playlists({ signal } = {}) {
      await load();
      if (!session) throw fail("netease_signed_out", "Sign in to NetEase Cloud Music first.");
      const version = epoch;
      const userId = session.account.userId;
      const items = new Map();
      for (let offset = 0; offset < 100_000; offset += 100) {
        const data = await request(`/api/user/playlist?uid=${userId}&limit=100&offset=${offset}`, { signal });
        current(version);
        const page = data.playlist;
        if (!Array.isArray(page)) throw fail("netease_response", "NetEase returned an unreadable playlist list.");
        for (const item of page) items.set(idOf(item.id), { id: idOf(item.id), name: musicText(item.name),
          kind: String(item.creator?.userId) === userId ? "created" : "saved", creator: musicText(item.creator?.nickname),
          trackCount: item.trackCount ?? 0, coverUrl: artwork(item.coverImgUrl), private: item.privacy === 10 });
        if (!data.more || !page.length) return [...items.values()];
      }
      throw fail("netease_response", "NetEase returned too many playlist pages. Please retry later.");
    },
    async playlist(playlistId, { signal } = {}) {
      await load();
      const version = epoch;
      const id = idOf(playlistId);
      const data = await request(`/api/v6/playlist/detail?id=${id}&n=1000&s=0`, { signal });
      current(version);
      const list = data.playlist;
      if (!list || String(list.id) !== id || !Array.isArray(list.trackIds)) throw fail("netease_response", "NetEase did not return the selected playlist.");
      const ids = list.trackIds.map((track) => idOf(track.id));
      const known = new Map((list.tracks ?? []).map((song) => [idOf(song.id), trackOf(song)]));
      const missing = ids.filter((trackId) => !known.has(trackId));
      for (let offset = 0; offset < missing.length; offset += 200) {
        const batch = missing.slice(offset, offset + 200);
        // IDs remain decimal strings so large service identifiers do not lose precision.
        const detail = await request("/api/v3/song/detail", { signal, form: { c: JSON.stringify(batch.map((id) => ({ id }))) } });
        current(version);
        for (const song of detail.songs ?? []) known.set(idOf(song.id), trackOf(song));
      }
      return { id, name: musicText(list.name), description: musicText(list.description), coverUrl: artwork(list.coverImgUrl),
        trackCount: ids.length, tracks: ids.map((id) => known.get(id) ?? { id, title: "Unavailable track", artists: [], album: "", durationMs: 0, image: null, available: false }) };
    },
    async prepareImport(playlistId, { subjectId, capturedAt = new Date().toISOString(), signal } = {}) {
      const list = await service.playlist(playlistId, { signal });
      const rows = list.tracks.map((track, index) => track.available && track.title ? ({
        id: track.id, title: track.title, artist: track.artists.join(", "), album: track.album,
        playlistId: list.id, playlistName: list.name, position: index + 1, member: "netease-account-playlist.json" }) : null).filter(Boolean);
      const bytes = Buffer.from(JSON.stringify({ id: list.id, name: list.name, rows }));
      const prepared = prepareMusicBundle({ provider: "netease", subjectId, capturedAt, rows, digest: musicHash(bytes), size: bytes.length,
        members: ["netease-account-playlist.json"], fileName: list.name, skipped: list.tracks.length - rows.length,
        scopeNote: "Only this selected playlist is added. Playlist membership is collection evidence, not listening history. Unavailable tracks are skipped." });
      for (const evidence of prepared.bundle.profile_evidence ?? []) {
        evidence.attributes.selected_public_playlist = false;
        evidence.attributes.selected_account_playlist = true;
      }
      prepared.preview.source = "netease-account";
      return prepared;
    },
  };
  return service;
}
