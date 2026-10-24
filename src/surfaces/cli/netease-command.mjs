import { sanitizeTerminalText } from "./format-output.mjs";
const clean = (value) => sanitizeTerminalText(String(value ?? "")).replace(/[|`*\[\]]/gu, "");

export async function runNeteaseCommand({ args = [], library, openLogin, prepareImport, signal } = {}) {
  const [action = "help", id, ...extra] = args;
  if (extra.length || (!["playlist", "import"].includes(action) && id)) throw new Error("Usage: netease login | logout | status | playlists | playlist <id> | import <id>");
  let data;
  let markdown;
  if (action === "login") {
    data = await library.login(openLogin, { signal });
    markdown = data.cancelled ? "NetEase sign-in cancelled." : `Connected to NetEase as ${clean(data.account.nickname)}. Use /netease playlists.`;
  } else if (action === "logout") {
    data = await library.logout(); markdown = "NetEase signed out on this machine.";
  } else if (action === "status") {
    data = await library.status({ refresh: true, signal });
    markdown = data.account ? `NetEase: ${clean(data.account.nickname)} (${data.account.userId}).` : "NetEase is signed out. Use /netease login.";
  } else if (action === "playlists") {
    data = await library.playlists({ signal });
    markdown = data.length ? data.map((item) => `- ${clean(item.name)} · ${item.kind} · ${item.trackCount} tracks · ID ${item.id}`).join("\n") : "No NetEase playlists yet.";
  } else if (action === "playlist") {
    data = await library.playlist(id, { signal });
    markdown = `**${clean(data.name)}** · ${data.trackCount} tracks\n\n${data.tracks.map((track, i) => `${i + 1}. ${clean(track.title)} — ${clean(track.artists.join(", "))}`).join("\n")}\n\nImport this collection with /netease import ${data.id}.`;
  } else if (action === "import") {
    const prepared = await prepareImport(id, { signal });
    try { data = await prepared.commit(); markdown = "Selected NetEase playlist added to your listening profile as collection evidence."; }
    finally { prepared.close(); }
  } else if (action === "help") {
    data = { commands: ["login", "logout", "status", "playlists", "playlist <id>", "import <id>"] };
    markdown = "NetEase Cloud Music: /netease login, /netease status, /netease playlists, /netease playlist <id>, /netease import <id>, /netease logout.\n\nSign-in and library browsing work without ncm-cli. Full playback still uses ncm-cli.";
  } else throw new Error("Unknown NetEase command. Use /netease help.");
  return { data, markdown };
}
