// A simulated Spotify Web API for playback evaluations. Titles are real and public, every
// provider ID is invented, and nothing leaves this process. The player changes state the
// way Spotify's does: play, queue, pause, skip and device moves all show up in later reads.

const image = (id) => [{ url: `https://i.scdn.co/image/simulated-${id}`, width: 640, height: 640 }];
const albums = new Map();
const tracks = [];

function album(id, name, artists, year, entries) {
  const value = { id, uri: `spotify:album:${id}`, type: "album", name, release_date: `${year}-01-01`, total_tracks: entries.length,
    artists: artists.map((artist) => ({ id: `artist${artist.replace(/\W/gu, "")}`, name: artist, type: "artist", uri: `spotify:artist:artist${artist.replace(/\W/gu, "")}` })),
    images: image(id), aliases: [] };
  value.tracks = entries.map(([trackId, title, trackArtists = artists, aliases = [], duration = 270_000], index) => {
    const track = { id: trackId, uri: `spotify:track:${trackId}`, type: "track", name: title, duration_ms: duration, explicit: false,
      popularity: 70 - index, track_number: index + 1, is_playable: true,
      artists: trackArtists.map((artist) => ({ id: `artist${artist.replace(/\W/gu, "")}`, name: artist, type: "artist", uri: `spotify:artist:artist${artist.replace(/\W/gu, "")}` })),
      album: { id, uri: value.uri, type: "album", name, release_date: value.release_date, images: value.images, artists: value.artists },
      aliases };
    tracks.push(track);
    return track;
  });
  albums.set(id, value);
  return value;
}

// Aliases carry the other script and spellings a listener may type.
album("albumShuZhiGuNiao", "樹枝孤鳥", ["伍佰 & China Blue"], 1998, [
  ["simBeidong", "被動", undefined, ["被动", "伍佰", "wu bai"]],
  ["simNiShiWoDeHuaDuo", "你是我的花朵", undefined, ["伍佰", "wu bai"]],
  ["simShuZhiGuNiao", "樹枝孤鳥", undefined, ["树枝孤鸟", "伍佰", "wu bai"]],
  ["simQianGua", "牽掛", undefined, ["牵挂", "伍佰", "wu bai"]],
]);
album("albumLeiQiao", "淚橋", ["伍佰 & China Blue"], 2003, [
  ["simTuRanDeZiWo", "突然的自我", undefined, ["伍佰", "wu bai"]],
  ["simLeiQiao", "淚橋", undefined, ["泪桥", "伍佰", "wu bai"]],
]);
album("albumAiQingDeJinTou", "愛情的盡頭", ["伍佰 & China Blue"], 1996, [
  ["simNuoWeiDeSenLin", "挪威的森林", undefined, ["伍佰", "wu bai"]],
  ["simLangRenQingGe", "浪人情歌", undefined, ["伍佰", "wu bai"]],
]);
album("albumWuBaiLive", "伍佰 Live 冬之火", ["Wu Bai"], 2001, [
  ["simBeidongLive", "被動 - Live", ["Wu Bai"], ["被动", "伍佰"]],
  ["simNuoWeiLive", "挪威的森林 - Live", ["Wu Bai"], ["伍佰"]],
]);
album("albumLaLaLive", "徐佳瑩 LaLa 演唱會", ["LaLa Hsu"], 2019, [
  ["simBeidongDuet", "被動 feat. 伍佰 - Live", ["LaLa Hsu", "Wu Bai"], ["被动", "伍佰", "徐佳莹", "徐佳瑩", "合唱"]],
  ["simShenQiBaiMa", "身騎白馬 - Live", ["LaLa Hsu"], ["身骑白马", "徐佳莹", "徐佳瑩"]],
]);
album("albumLaLaDebut", "LaLa首張創作專輯", ["LaLa Hsu"], 2009, [
  ["simShiLuoShaZhou", "失落沙洲", ["LaLa Hsu"], ["徐佳莹", "徐佳瑩"]],
  ["simXunRenQiShi", "尋人啟事", ["LaLa Hsu"], ["寻人启事", "徐佳莹", "徐佳瑩"]],
]);
album("albumDuets", "華語對唱精選", ["Various Artists"], 2012, [
  ["simLiangShanBo", "梁山伯與茱麗葉", ["卓文萱", "Gary Chaw"], ["梁山伯与茱丽叶", "曹格", "对唱", "對唱"]],
  ["simXiaoJiuWo", "小酒窩", ["JJ Lin", "Charlene Choi"], ["小酒窝", "林俊杰", "林俊傑", "蔡卓妍", "对唱"]],
  ["simJinTianNiYao", "今天你要嫁給我", ["David Tao", "Jolin Tsai"], ["今天你要嫁给我", "陶喆", "蔡依林", "对唱"]],
  ["simWuDing", "屋頂", ["Jay Chou", "Landy Wen"], ["屋顶", "周杰伦", "周杰倫", "温岚", "溫嵐", "对唱"]],
]);
album("albumBeyond", "海闊天空", ["Beyond"], 1993, [
  ["simHaiKuoTianKong", "海闊天空", ["Beyond"], ["海阔天空", "粤语", "粵語"]],
  ["simGuangHui", "光輝歲月", ["Beyond"], ["光辉岁月", "粤语"]],
  ["simXiHuanNi", "喜歡你", ["Beyond"], ["喜欢你", "粤语"]],
]);
album("albumEason", "U87", ["Eason Chan"], 2005, [
  ["simFuShiShanXia", "富士山下", ["Eason Chan"], ["陈奕迅", "陳奕迅", "粤语"]],
  ["simFuKua", "浮誇", ["Eason Chan"], ["浮夸", "陈奕迅", "陳奕迅", "粤语"]],
]);
album("albumQianQian", "永遠是你的朋友", ["Priscilla Chan"], 1989, [
  ["simQianQianQueGe", "千千闕歌", ["Priscilla Chan"], ["千千阙歌", "陈慧娴", "陳慧嫻", "粤语"]],
]);
album("albumInRainbows", "In Rainbows", ["Radiohead"], 2007, [
  ["simWeirdFishes", "Weird Fishes/Arpeggi", ["Radiohead"]],
  ["simNude", "Nude", ["Radiohead"]],
  ["simReckoner", "Reckoner", ["Radiohead"]],
]);

const keyOf = (value) => value.normalize("NFKC").toLocaleLowerCase();
function score(query, words) {
  const terms = keyOf(query).split(/[\s,，、]+/u).filter((term) => term && !["the", "by", "版本", "的"].includes(term));
  const haystack = keyOf(words.join(" "));
  return terms.filter((term) => haystack.includes(term)).length / Math.max(1, terms.length);
}
const trackWords = (track) => [track.name, ...track.artists.map((artist) => artist.name), track.album.name, ...track.aliases];
const albumWords = (value) => [value.name, ...value.artists.map((artist) => artist.name), ...value.tracks.flatMap((track) => track.aliases)];
const publicTrack = ({ aliases: _aliases, ...track }) => track;
const publicAlbum = ({ aliases: _aliases, tracks: _tracks, ...value }) => value;

/** Every title, album and artist name in the catalog, longest first, for reading replies around them. */
export function catalogNames() {
  const names = new Set();
  for (const track of tracks) {
    names.add(track.name);
    names.add(track.album.name);
    for (const artist of track.artists) names.add(artist.name);
  }
  return [...names].sort((left, right) => right.length - left.length);
}

export function createSimulatedSpotify({ devices = [
  { id: "simMac", name: "Fictional MacBook Pro", type: "Computer" },
  { id: "simPC", name: "PC", type: "Computer" },
], active = null, refuseMovesTo = [], refuseTransfersTo = [], refuseContexts = [], playing = null, queue = [] } = {}) {
  // refuseMovesTo refuses every way onto a device; refuseTransfersTo refuses only the transfer call,
  // as Spotify sometimes does while still accepting a play request aimed at that device.
  // refuseContexts lists album URIs whose play is refused, while their songs still play alone.
  // context is the album or list of songs being played, and contextIndex the song reached in it:
  // queued songs play first, then the context goes on from there.
  const state = { active, current: playing ? tracks.find((track) => track.id === playing) ?? null : null, playing: Boolean(playing),
    progressMs: 42_000, queue: queue.map((id) => tracks.find((track) => track.id === id)).filter(Boolean),
    context: null, contextIndex: -1, contextUri: null, writes: [], unknown: [] };
  const json = (value, status = 200) => Response.json(value, { status });
  const empty = () => new Response(null, { status: 204 });
  const refused = () => json({ error: { status: 403, message: "Player command failed: Restriction violated", reason: "UNKNOWN" } }, 403);
  const noDevice = () => json({ error: { status: 404, message: "Player command failed: No active device found", reason: "NO_ACTIVE_DEVICE" } }, 404);
  const deviceView = (device) => ({ ...device, is_active: device.id === state.active, is_private_session: false, is_restricted: false,
    supports_volume: true, volume_percent: 60 });
  const playFrom = (list, index, contextUri = null) => {
    state.context = list;
    state.contextIndex = list[index] ? index : 0;
    state.contextUri = contextUri;
    state.current = list[state.contextIndex] ?? state.current;
    state.playing = true;
    state.progressMs = 0;
  };
  // Where a play body's offset starts: a position, a song in the list, or the first song.
  // An offset naming a song outside the list is refused (the simulator's choice).
  const offsetIndex = (list, offset) => (typeof offset?.uri === "string" ? list.findIndex((track) => track.uri === offset.uri) : Number(offset?.position ?? 0));
  const advance = () => {
    const next = state.queue.shift();
    if (next) { state.current = next; state.progressMs = 0; return; }
    if (state.context?.[state.contextIndex + 1]) { state.contextIndex += 1; state.current = state.context[state.contextIndex]; state.progressMs = 0; }
  };
  // Spotify's queue shows the listener's queue first, then the rest of what is playing.
  const upcoming = () => [...state.queue, ...(state.context ?? []).slice(state.contextIndex + 1)];

  async function fetchImpl(url, init = {}) {
    const parsed = new URL(url);
    const method = (init.method ?? "GET").toUpperCase();
    const path = parsed.pathname.replace(/^\/v1/u, "");
    const query = Object.fromEntries(parsed.searchParams);
    const body = init.body ? JSON.parse(init.body) : null;
    if (method !== "GET") {
      const write = { method, path, query, body, status: 204 };
      state.writes.push(write);
      const respond = (response) => { write.status = response.status; return response; };
      if (path === "/me/player" && method === "PUT") {
        const target = body?.device_ids?.[0];
        if (refuseMovesTo.includes(target) || refuseTransfersTo.includes(target)) return respond(refused());
        if (!devices.some((device) => device.id === target)) return respond(json({ error: { status: 404, message: "Device not found" } }, 404));
        state.active = target;
        if (body?.play === true) state.playing = Boolean(state.current);
        return respond(empty());
      }
      if (path === "/me/player/play") {
        const target = query.device_id ?? state.active;
        if (!target) return respond(noDevice());
        if (refuseMovesTo.includes(target) && target !== state.active) return respond(refused());
        state.active = target;
        if (body?.uris?.length) {
          const list = body.uris.map((uri) => tracks.find((track) => track.uri === uri)).filter(Boolean);
          const index = offsetIndex(list, body.offset);
          if (index < 0) return respond(json({ error: { status: 400, message: "Invalid offset" } }, 400));
          playFrom(list, index);
        } else if (body?.context_uri) {
          const value = [...albums.values()].find((entry) => entry.uri === body.context_uri);
          if (!value || refuseContexts.includes(body.context_uri)) return respond(json({ error: { status: 404, message: "Context not found" } }, 404));
          const index = offsetIndex(value.tracks, body.offset);
          if (index < 0) return respond(json({ error: { status: 400, message: "Invalid offset" } }, 400));
          playFrom(value.tracks, index, value.uri);
        } else {
          if (!state.current) return respond(json({ error: { status: 404, message: "Nothing to resume" } }, 404));
          state.playing = true;
        }
        if (Number.isInteger(body?.position_ms)) state.progressMs = body.position_ms;
        return respond(empty());
      }
      if (!state.active && path.startsWith("/me/player")) return respond(noDevice());
      // Like Spotify, pausing a paused player is refused.
      if (path === "/me/player/pause") { if (!state.playing) return respond(refused()); state.playing = false; return respond(empty()); }
      if (path === "/me/player/next") { advance(); state.playing = true; return respond(empty()); }
      if (path === "/me/player/previous") { state.progressMs = 0; return respond(empty()); }
      if (path === "/me/player/queue") {
        const item = tracks.find((track) => track.uri === query.uri);
        if (!item) return respond(json({ error: { status: 400, message: "Invalid track uri" } }, 400));
        state.queue.push(item);
        return respond(empty());
      }
      if (["/me/player/volume", "/me/player/seek", "/me/player/shuffle", "/me/player/repeat"].includes(path)) return respond(empty());
      state.unknown.push(`${method} ${path}`);
      return respond(json({ error: { status: 404, message: `No simulated route for ${method} ${path}` } }, 404));
    }
    if (path === "/search") {
      const type = (query.type ?? "track").split(",")[0];
      const limit = Math.min(50, Number(query.limit ?? 20));
      const offset = Number(query.offset ?? 0);
      const q = query.q ?? "";
      const ranked = (type === "album" ? [...albums.values()].map((value) => [value, score(q, albumWords(value))])
        : type === "artist" ? [] : type === "playlist" ? [] : tracks.map((track) => [track, score(q, trackWords(track))]))
        .filter(([, value]) => value > 0).sort((left, right) => right[1] - left[1]).map(([item]) => item);
      const items = ranked.slice(offset, offset + limit).map((item) => (item.type === "album" ? publicAlbum(item) : publicTrack(item)));
      return json({ [`${type}s`]: { items, total: ranked.length, limit, offset, next: offset + limit < ranked.length ? "simulated-next" : null } });
    }
    const albumTracks = path.match(/^\/albums\/([^/]+)\/tracks$/u);
    if (albumTracks) {
      const value = albums.get(decodeURIComponent(albumTracks[1]));
      return value ? json({ items: value.tracks.map(publicTrack), total: value.tracks.length, next: null }) : json({ error: { status: 404, message: "Album not found" } }, 404);
    }
    const albumOne = path.match(/^\/albums\/([^/]+)$/u);
    if (albumOne) {
      const value = albums.get(decodeURIComponent(albumOne[1]));
      return value ? json({ ...publicAlbum(value), tracks: { items: value.tracks.map(publicTrack), total: value.tracks.length } }) : json({ error: { status: 404, message: "Album not found" } }, 404);
    }
    const trackOne = path.match(/^\/tracks\/([^/]+)$/u);
    if (trackOne) {
      const item = tracks.find((track) => track.id === decodeURIComponent(trackOne[1]));
      return item ? json(publicTrack(item)) : json({ error: { status: 404, message: "Track not found" } }, 404);
    }
    if (path === "/me/player/devices") return json({ devices: devices.map(deviceView) });
    if (path === "/me/player") {
      if (!state.active) return empty();
      return json({ device: deviceView(devices.find((device) => device.id === state.active)), is_playing: state.playing,
        item: state.current ? publicTrack(state.current) : null, progress_ms: state.progressMs, shuffle_state: false, repeat_state: "off",
        currently_playing_type: "track", context: state.contextUri ? { type: "album", uri: state.contextUri } : null, timestamp: Date.now() });
    }
    if (path === "/me/player/currently-playing") return state.current ? json({ item: publicTrack(state.current), is_playing: state.playing, progress_ms: state.progressMs }) : empty();
    if (path === "/me/player/queue") return json({ currently_playing: state.current ? publicTrack(state.current) : null, queue: upcoming().map(publicTrack) });
    if (path === "/me/player/recently-played") return json({ items: [], next: null, cursors: null });
    if (path === "/me") return json({ id: "simulatedListener", display_name: "Fictional listener", product: "premium", country: "TW", type: "user" });
    if (path.startsWith("/me/top/")) return json({ items: [], total: 0, next: null });
    if (path === "/me/following") return json({ artists: { items: [], next: null, cursors: { after: null }, total: 0 } });
    if (path === "/me/playlists") return json({ items: [], total: 0, next: null });
    if (path.startsWith("/me/library")) return json(path.endsWith("/contains") ? [] : { items: [], total: 0, next: null });
    state.unknown.push(`GET ${path}`);
    return json({ error: { status: 404, message: `No simulated route for GET ${path}` } }, 404);
  }

  return { fetchImpl, state, devices, findTrack: (id) => tracks.find((track) => track.id === id) ?? null };
}
