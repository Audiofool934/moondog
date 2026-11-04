// Playlist links the listener pastes into the library: Spotify, Apple Music, NetEase Music and QQ Music.
// Each link is read for its name and songs only; nothing signs in to a service it doesn't already have,
// and nothing but the official hosts is ever fetched.
import { fetchPublicPlaylist } from "./public-playlists.mjs";

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const PUBLIC_HOSTS = new Set(["y.qq.com", "c.y.qq.com", "i.y.qq.com", "m.y.qq.com", "music.163.com", "y.music.163.com", "163cn.tv"]);
const APPLE_PAGE_MAX = 12 * 1024 * 1024;

/** The one playlist link in some text: { provider, id, url } for Spotify and Apple Music, or { provider: "public", url } for NetEase and QQ. */
export function parsePlaylistLink(text) {
  const value = String(text ?? "").trim();
  const uri = /^spotify:playlist:([A-Za-z0-9]{10,40})$/u.exec(value);
  if (uri) return { provider: "spotify", id: uri[1], url: `https://open.spotify.com/playlist/${uri[1]}` };
  const links = value.match(/https?:\/\/[^\s<>"“”]+/gu) ?? [];
  if (links.length !== 1) fail("playlist_link_missing", "Paste one playlist link: Spotify, Apple Music, NetEase Music or QQ Music.");
  let url;
  try { url = new URL(links[0]); } catch { fail("playlist_link_missing", "That link can't be read."); }
  if (url.username || url.password || url.port) fail("playlist_link_unsupported", "That link can't be read.");
  if (url.hostname === "open.spotify.com") {
    const match = /^\/(?:intl-[a-z-]+\/)?playlist\/([A-Za-z0-9]{10,40})\/?$/u.exec(url.pathname);
    if (match) return { provider: "spotify", id: match[1], url: `https://open.spotify.com/playlist/${match[1]}` };
  }
  if (url.hostname === "music.apple.com" || url.hostname === "embed.music.apple.com") {
    const match = /^\/([a-z]{2})\/playlist\/(?:[^/]+\/)?(pl\.[A-Za-z0-9.-]{6,80})\/?$/u.exec(url.pathname);
    if (match) return { provider: "apple_music", id: match[2], storefront: match[1], url: `https://music.apple.com/${match[1]}/playlist/${match[2]}` };
  }
  if (PUBLIC_HOSTS.has(url.hostname)) return { provider: "public", url: url.href };
  fail("playlist_link_unsupported", "Moondog reads playlist links from Spotify, Apple Music, NetEase Music and QQ Music.");
}

// The page's text, bounded, from Apple's own host only and never through a redirect elsewhere.
async function applePage(url, fetchImpl, signal) {
  let response;
  try {
    response = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.any([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]),
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Moondog playlist import)", "Accept-Language": "en" } });
  } catch (error) {
    if (signal?.aborted) throw error;
    fail("playlist_unreachable", "Couldn't reach Apple Music. Check your connection and try the link again.");
  }
  if (response.url && new URL(response.url).hostname !== "music.apple.com") fail("playlist_unavailable", "Apple Music answered from another address.");
  if (!response.ok) { await response.body?.cancel(); fail("playlist_unavailable", "Apple Music didn't show this playlist. Check that it opens in a browser without signing in."); }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > APPLE_PAGE_MAX) fail("playlist_too_large", "This playlist page is too large to read.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const text = (value, maximum = 200) => (typeof value === "string" ? Array.from(value.replace(/\s+/gu, " ").trim()).slice(0, maximum).join("") : "");

/**
 * An Apple Music playlist from its public page: its name, how many songs it has, and the songs the page
 * lists with their Apple Music ids and covers. A long playlist's page may list only its first songs;
 * read and total say how many.
 */
export async function readApplePlaylist({ id, url }, { fetchImpl = fetch, signal } = {}) {
  const html = await applePage(url, fetchImpl, signal);
  const block = (pattern) => { const match = pattern.exec(html); try { return match ? JSON.parse(match[1]) : null; } catch { return null; } };
  const schema = block(/<script[^>]*id=schema:music-playlist[^>]*>([\s\S]*?)<\/script>/u) ?? block(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/u);
  const data = block(/<script[^>]*id="serialized-server-data"[^>]*>([\s\S]*?)<\/script>/u);
  const tracks = [];
  const seen = new Set();
  // The server data lists each song as a track lockup with its title, its artist and its catalog id.
  const walk = (node, depth) => {
    if (!node || typeof node !== "object" || depth > 12 || tracks.length >= 2000) return;
    if (Array.isArray(node)) { for (const each of node) walk(each, depth + 1); return; }
    const catalog = node.contentDescriptor?.identifiers?.storeAdamID;
    if (typeof node.title === "string" && typeof node.artistName === "string" && node.contentDescriptor?.kind === "song" && catalog) {
      const key = String(catalog);
      if (!seen.has(key)) {
        seen.add(key);
        const artwork = typeof node.artwork?.dictionary?.url === "string" ? node.artwork.dictionary.url.replace("{w}x{h}", "300x300").replace("{f}", "jpg") : null;
        tracks.push({ id: key, title: text(node.title), artist: text(node.artistName), ...(artwork?.startsWith("https://") ? { artwork } : {}) });
      }
      return;
    }
    for (const value of Object.values(node)) walk(value, depth + 1);
  };
  walk(data, 0);
  const name = text(schema?.name) || text(/<meta property="og:title" content="([^"]+)"/u.exec(html)?.[1]) || "Apple Music playlist";
  const total = Number.isSafeInteger(Number(schema?.numTracks)) ? Number(schema.numTracks) : null;
  if (!tracks.length) fail("playlist_unavailable", "Apple Music didn't list the songs of this playlist. Check that it is shared publicly.");
  return { provider: "apple_music", id, url, name, total: total !== null && total >= tracks.length ? total : null, tracks: tracks.filter((track) => track.title && track.artist) };
}

/** A NetEase Music or QQ Music playlist through its public share link, as library songs. */
export async function readPublicPlaylistLink({ url }, { fetchImpl = fetch } = {}) {
  const playlist = await fetchPublicPlaylist({ input: url, fetchImpl });
  return { provider: playlist.provider, id: playlist.id, url: playlist.url, name: playlist.name, total: playlist.total,
    tracks: playlist.rows.map((row) => ({ id: row.id, title: row.title, artist: row.artist, ...(row.album ? { album: row.album } : {}) })).filter((track) => track.artist) };
}
