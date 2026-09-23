import { musicHash, musicText, prepareMusicBundle } from "../profile/music-import-bundle.mjs";

const qqHosts = ["y.qq.com", "c.y.qq.com", "i.y.qq.com", "m.y.qq.com"];
const hosts = new Set([...qqHosts, "music.163.com", "y.music.163.com", "163cn.tv"]);
const numericId = /^[1-9][0-9]{0,19}$/u;

function allowedUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Paste a QQ Music or NetEase Cloud Music playlist share link."); }
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

export async function readPublicPlaylist({ input, subjectId, capturedAt, provider, fetchImpl = fetch }) {
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
  const endpoint = qq
    ? `https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg?type=1&json=1&utf8=1&onlysong=0&disstid=${identity.id}&format=json`
    : `https://music.163.com/api/playlist/detail?id=${identity.id}`;
  const data = await boundedJson(await responseFor(endpoint, fetchImpl, qq ? "https://y.qq.com/" : "https://music.163.com/"));
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
      playlistId: identity.id, playlistName: name, position: index + 1, member: "public-playlist.json",
    };
  }).filter((row) => row.id && row.title);
  const bytes = Buffer.from(JSON.stringify({ provider: identity.provider, id: identity.id, name, rows }));
  const prepared = prepareMusicBundle({ provider: identity.provider, subjectId, capturedAt, rows,
    digest: musicHash(bytes), size: bytes.length, members: ["public-playlist.json"], fileName: name, skipped: songs.length - rows.length,
    scopeNote: `${rows.length} of ${total ?? "an unknown number of"} songs could be read; the service hides some. Only this playlist is added. It shows what you keep, not what you played, and it may not be one you made.`,
  });
  prepared.preview.availableTracks = rows.length;
  prepared.preview.totalTracks = total;
  return prepared;
}
