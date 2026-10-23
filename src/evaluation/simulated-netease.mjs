// Fictional local responses for the existing desktop simulator; never contacts NetEase.
import { createNeteaseLibrary } from "../integrations/netease/library.mjs";
export function createSimulatedNetease({ environment }) {
  const song = (id) => ({ id, name: `模拟歌曲 ${id}`, ar: [{ name: "示例乐队" }], al: { name: "月光唱片" }, dt: 180_000 });
  return createNeteaseLibrary({ environment, fetchImpl: async (value, options) => {
    const url = new URL(value);
    if (url.pathname.includes("account")) return Response.json({ code: 200, account: { id: 12345 }, profile: { nickname: "模拟听众 · Fictional listener", userId: 12345 } });
    if (url.pathname === "/api/user/playlist") return Response.json({ code: 200, more: false, playlist: [
      { id: 1001, name: "深夜电台 · 模拟歌单", creator: { userId: 12345 }, trackCount: 205, privacy: 10 },
      { id: 1002, name: "周末漫游 · 模拟收藏", creator: { userId: 9999 }, trackCount: 2 },
      { id: 1003, name: "空白唱片 · 模拟空歌单", creator: { userId: 12345 }, trackCount: 0 },
    ] });
    if (url.pathname.includes("playlist/detail")) {
      const id = Number(url.searchParams.get("id"));
      const count = id === 1001 ? 205 : id === 1002 ? 2 : 0;
      return Response.json({ code: 200, playlist: { id, name: id === 1001 ? "深夜电台 · 模拟歌单" : "模拟歌单", description: "全部数据为本地虚构，仅用于功能验证。",
        trackIds: Array.from({ length: count }, (_, i) => ({ id: i + 1 })), tracks: Array.from({ length: Math.min(2, count) }, (_, i) => song(i + 1)) } });
    }
    if (url.pathname.includes("song/detail")) return Response.json({ code: 200, songs: JSON.parse(new URLSearchParams(options.body).get("c")).map(({ id }) => song(Number(id))) });
    return Response.json({ code: 404 });
  } });
}
