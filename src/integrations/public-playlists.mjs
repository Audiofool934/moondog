import { musicHash, musicText, prepareMusicBundle } from "../profile/music-import-bundle.mjs";

const qqHosts = ["y.qq.com", "c.y.qq.com", "i.y.qq.com", "m.y.qq.com"];
const hosts = new Set([...qqHosts, "music.163.com", "y.music.163.com", "163cn.tv"]);
const numericId = /^[1-9][0-9]{0,19}$/u;

function allowedUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Paste a QQ Music or NetEase Music playlist share link."); }
  if (!hosts.has(url.hostname) || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port) {
    throw new Error("Use a playlist link from y.qq.com, music.163.com or their official share links.");
  }
  url.protocol = "https:";
  return url;
}

export function playlistLink(input) {
  const links = String(input).match(/https?:\/\/[^\s<>"“”]+/gu) ?? [];
  if (links.length !== 1) throw new Error("Paste one playlist share link at a time.");
  return allowedUrl(links[0]);
}

function playlistIdentity(url) {
  const fragment = url.hash.startsWith("#/") ? new URL(url.hash.slice(1), url.origin) : url;
  if (["music.163.com", "y.music.163.com"].includes(url.hostname)) {
    const id = fragment.searchParams.get("id");
    if (/(?:^|\/)playlist\/?$/u.test(fragment.pathname) && numericId.test(id ?? "")) return { provider: "netease", id };
  }
  if (qqHosts.includes(url.hostname)) {
    const match = url.pathname.match(/^\/n\/(?:ryqq|ryqq_v2)\/playlist\/([0-9]+)\/?$/u);
    const id = match?.[1] ?? url.searchParams.get("disstid") ?? url.searchParams.get("id");
    if ((match || /(?:taoge|playlist|playsquare)/u.test(url.pathname)) && numericId.test(id ?? "")) return { provider: "qq_music", id };
  }
  return null;
}

async function responseFor(url, fetchImpl, referer) {
  try {
    return await fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(15_000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Moondog music metadata import)", ...(referer ? { Referer: referer } : {}) } });
  } catch { throw new Error("Could not reach the music service. Check your connection and try the same playlist link again."); }
}

async function boundedJson(response) {
  if (!response.ok) { await response.body?.cancel(); throw new Error("The service did not return a public playlist. Open the link in your browser to check that it is available without signing in."); }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 16 * 1024 * 1024) throw new Error("Playlist response is too large. Choose a smaller playlist.");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("The service changed its playlist response or requires sign-in. No music was imported."); }
}

// A NetEase playlist, as { code, result: { id, name, privacy, trackCount, tracks } }. NetEase's web player reads
// playlists with v6, which answers every public one, a listener's Liked songs among them, with all its song ids but
// details for only the first few without a sign-in; the rest come from song/detail, 200 at a time, in the
// playlist's order. The older endpoint, which some playlists answer with code 20001, is the fallback.
const NETEASE_SONGS_MAX = 3000;
async function neteasePlaylist(id, fetchImpl) {
  const referer = "https://music.163.com/";
  const current = await boundedJson(await responseFor(`https://music.163.com/api/v6/playlist/detail?id=${id}&n=100000`, fetchImpl, referer)).catch(() => null);
  const playlist = current?.code === 200 ? current.playlist : null;
  if (!playlist || !Array.isArray(playlist.trackIds)) {
    return boundedJson(await responseFor(`https://music.163.com/api/playlist/detail?id=${id}`, fetchImpl, referer));
  }
  const ids = playlist.trackIds.map((entry) => String(entry?.id ?? "")).filter((value) => numericId.test(value)).slice(0, NETEASE_SONGS_MAX);
  const songs = new Map((Array.isArray(playlist.tracks) ? playlist.tracks : []).map((song) => [String(song?.id ?? ""), song]));
  const missing = ids.filter((songId) => !songs.has(songId));
  for (let start = 0; start < missing.length; start += 200) {
    const batch = missing.slice(start, start + 200);
    const detail = await boundedJson(await responseFor(`https://music.163.com/api/song/detail/?ids=${encodeURIComponent(`[${batch.join(",")}]`)}`, fetchImpl, referer));
    for (const song of Array.isArray(detail?.songs) ? detail.songs : []) songs.set(String(song?.id ?? ""), song);
  }
  return { code: 200, result: { id: playlist.id, name: playlist.name, privacy: playlist.privacy, trackCount: playlist.trackCount ?? ids.length,
    tracks: ids.map((songId) => songs.get(songId)).filter(Boolean) } };
}

/** A public QQ Music or NetEase playlist by its share link: { provider, id, url, name, total, rows, skipped }. */
export async function fetchPublicPlaylist({ input, provider, fetchImpl = fetch }) {
  let url = playlistLink(input);
  let identity = playlistIdentity(url);
  // Follow only official share redirects, never arbitrary network destinations or cookies.
  for (let index = 0; !identity && index < 4; index += 1) {
    const response = await responseFor(url, fetchImpl);
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (response.status < 300 || response.status >= 400 || !location) break;
    url = allowedUrl(new URL(location, url).href);
    identity = playlistIdentity(url);
  }
  if (!identity) throw new Error("Open this share link in your browser, then copy the full playlist page URL. Song, album and private playlist links are not supported.");
  if (provider && ["qq_music", "netease"].includes(provider) && provider !== identity.provider) throw new Error("This link belongs to another service. Go back and choose that service, or paste the matching playlist link.");
  const qq = identity.provider === "qq_music";
  const data = qq
    ? await boundedJson(await responseFor(`https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg?type=1&json=1&utf8=1&onlysong=0&disstid=${identity.id}&format=json`, fetchImpl, "https://y.qq.com/"))
    : await neteasePlaylist(identity.id, fetchImpl);
  const playlist = qq ? data?.cdlist?.[0] : data?.result;
  if ((qq ? data?.code !== 0 || data?.subcode !== 0 : data?.code !== 200) || !playlist
    || (qq ? Number(playlist.dir_show) === 0 : Number(playlist.privacy) === 10)) throw new Error("This playlist is unavailable publicly. Choose a playlist you can open without signing in; no account password or cookies are needed.");
  if (String(qq ? playlist.disstid : playlist.id) !== identity.id) throw new Error("The service returned a different playlist. Nothing imported; try copying the playlist link again.");
  const songs = qq ? playlist.songlist : playlist.tracks;
  if (!Array.isArray(songs) || songs.length > 10_000) throw new Error("The playlist format is unsupported or exceeds 10,000 songs.");
  const name = musicText(qq ? playlist.dissname : playlist.name) || "Selected playlist";
  const totalValue = Number(qq ? playlist.total_song_num ?? playlist.songnum : playlist.trackCount);
  const total = Number.isSafeInteger(totalValue) && totalValue >= songs.length ? totalValue : null;
  const rows = songs.map((song, index) => {
    if (!song || typeof song !== "object") return {};
    const artists = qq ? song.singer : song.artists ?? song.ar;
    return {
      id: qq ? song.songmid || String(song.songid ?? "") : String(song.id ?? ""),
      title: musicText(qq ? song.songname : song.name),
      artist: musicText(Array.isArray(artists) ? artists.map((artist) => musicText(artist?.name)).filter(Boolean).join(", ") : ""),
      album: musicText(qq ? song.albumname : (song.album ?? song.al)?.name),
      // NetEase names each album cover on its own image host; it is shown over https.
      ...(!qq && /^https?:\/\/p[0-9]+\.music\.126\.net\//u.test((song.album ?? song.al)?.picUrl ?? "") ? { artwork: (song.album ?? song.al).picUrl.replace(/^http:/u, "https:") } : {}),
      playlistId: identity.id, playlistName: name, position: index + 1, member: "public-playlist.json",
    };
  }).filter((row) => row.id && row.title);
  return { provider: identity.provider, id: identity.id, url: url.href, name, total, rows, skipped: songs.length - rows.length };
}

export async function readPublicPlaylist({ input, subjectId, capturedAt, provider, fetchImpl = fetch }) {
  const { provider: source, id, name, total, rows, skipped } = await fetchPublicPlaylist({ input, provider, fetchImpl });
  const bytes = Buffer.from(JSON.stringify({ provider: source, id, name, rows }));
  const prepared = prepareMusicBundle({ provider: source, subjectId, capturedAt, rows,
    digest: musicHash(bytes), size: bytes.length, members: ["public-playlist.json"], fileName: name, skipped,
    scopeNote: `${rows.length} of ${total ?? "an unknown number of"} songs could be read; the service hides some. Only this playlist is added. It shows what you keep, not what you played, and it may not be one you made.`,
  });
  prepared.preview.source = "public-playlist";
  prepared.preview.availableTracks = rows.length;
  prepared.preview.totalTracks = total;
  return prepared;
}
