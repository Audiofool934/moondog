import { make, turning } from "./ui.mjs";
import "./netease.css";

const words = {
  zh: { title: "网易云音乐", intro: "连接账号，查看你创建和收藏的歌单。", connect: "登录网易云", disconnect: "退出登录", refresh: "刷新歌单",
    login: "请在网易云官方窗口完成登录。", cancel: "取消登录", loading: "正在读取网易云…", created: "我创建的", saved: "我收藏的", all: "全部歌单",
    search: "搜索歌单", empty: "账号中还没有歌单。", noMatches: "没有匹配的歌单，试试其他名称。", tracks: "首", private: "私密", back: "返回歌单",
    import: "导入音乐画像", importNote: "预览后再导入这个歌单。歌单收藏不会被当作播放历史。", titleColumn: "歌曲", artist: "歌手", album: "专辑", duration: "时长",
    emptyTracks: "这个歌单还没有歌曲。", previous: "上一页", next: "下一页", retry: "重试", play: "播放整个歌单", playTrack: "播放", playback: "登录后即可直接播放歌单，音源按账号会员及版权权限提供。" },
  en: { title: "NetEase Cloud Music", intro: "Connect your account to browse your created and saved playlists.", connect: "Sign in to NetEase", disconnect: "Sign out", refresh: "Refresh playlists",
    login: "Finish signing in in the official NetEase window.", cancel: "Cancel sign-in", loading: "Reading NetEase…", created: "Created", saved: "Saved", all: "All playlists",
    search: "Search playlists", empty: "No playlists in this account yet.", noMatches: "No matching playlists. Try another name.", tracks: "tracks", private: "Private", back: "Back to playlists",
    import: "Import into profile", importNote: "Preview this playlist before adding it. Collection membership is never treated as listening history.", titleColumn: "Song", artist: "Artist", album: "Album", duration: "Time",
    emptyTracks: "This playlist has no songs yet.", previous: "Previous", next: "Next", retry: "Retry", play: "Play playlist", playTrack: "Play", playback: "Sign in to play playlists directly. Audio availability follows your account and regional rights." },
};

export function createNeteaseSettings({ send, locale, changed }) {
  let account = null;
  let playlists = null;
  let detail = null;
  let busy = null;
  let error = null;
  let failedAction = "status";
  let requestedId = null;
  let filter = "all";
  let query = "";
  let page = 0;
  const text = () => words[String(locale()).startsWith("zh") ? "zh" : "en"];
  const ask = (action, extra = {}) => send({ type: `netease-${action}`, ...extra });
  const note = (value) => make("p", "note", value);
  function control(label, action, key, primary = false) {
    const node = make("button", `button ${primary ? "primary" : "quiet small"}`, label);
    node.type = "button";
    node.dataset.key = `netease:${key}`;
    node.addEventListener("click", action);
    return node;
  }
  const clear = () => { playlists = null; detail = null; query = ""; page = 0; };
  function receive(message) {
    if (message.type !== "netease-library") return;
    const { action, stage } = message;
    if (stage === "loading") { busy = action; error = null; }
    else {
      busy = null;
      if (stage === "error") {
        failedAction = action;
        error = action === "play" ? message.message : message.code === "netease_signed_out"
          ? (String(locale()).startsWith("zh") ? "登录已过期或访问被拒绝，请重新登录网易云。" : "Your session expired or access was refused. Sign in again.")
          : (String(locale()).startsWith("zh") ? "读取失败，请检查网络后重试。" : "Could not read NetEase. Check your connection and retry.");
        if (message.code === "netease_signed_out") { account = null; clear(); }
      } else if (["status", "login", "logout"].includes(action)) {
        if (message.account?.userId !== account?.userId) clear();
        account = message.account ?? null;
        if (account && playlists === null) ask("playlists");
        if (!account) clear();
      } else if (action === "playlists") { playlists = message.playlists ?? []; detail = null; page = 0; }
      else if (action === "playlist" && message.playlist?.id === requestedId) { detail = message.playlist; page = 0; }
    }
    changed();
  }
  function render() {
    const t = text();
    const root = make("div", "netease-library");
    const heading = make("div", "netease-heading");
    const title = make("div");
    title.append(make("h2", "", t.title), note(account ? account.nickname : t.intro));
    if (account?.avatarUrl) {
      const image = make("img", "netease-avatar"); image.src = account.avatarUrl; image.alt = ""; heading.append(image);
    }
    heading.append(title);
    root.append(heading);
    const actions = make("div", "netease-actions");
    if (busy === "login") {
      actions.append(turning(), note(t.login), control(t.cancel, () => { ask("login-cancel"); busy = null; changed(); }, "cancel"));
    } else if (!account) actions.append(control(t.connect, () => ask("login"), "connect", true));
    else {
      actions.append(control(t.refresh, () => ask("playlists"), "refresh"), control(t.disconnect, () => { clear(); account = null; ask("logout"); }, "logout"));
    }
    root.append(actions);
    if (error) {
      const box = make("div", "netease-error"); box.setAttribute("role", "alert");
      box.append(note(error), control(t.retry, () => ask(failedAction, ["playlist", "play"].includes(failedAction) ? { id: requestedId } : {}), "retry")); root.append(box);
    }
    if (busy && busy !== "login") {
      const status = make("div", "netease-actions"); status.setAttribute("role", "status"); status.append(turning(), note(t.loading)); root.append(status);
    }
    if (!account) { root.append(note(t.playback)); return root; }
    if (detail) {
      root.append(control(t.back, () => { detail = null; requestedId = null; page = 0; changed(); }, "back"));
      const info = make("div", "netease-heading");
      if (detail.coverUrl) { const cover = make("img", "netease-cover"); cover.src = detail.coverUrl; cover.alt = ""; info.append(cover); }
      const label = make("div"); label.append(make("h3", "", detail.name), note(`${detail.trackCount} ${t.tracks}`)); info.append(label); root.append(info);
      if (detail.description) root.append(note(detail.description));
      const add = control(t.import, () => send({ type: "import-netease", id: detail.id }), "import", true);
      add.disabled = !detail.tracks.some((track) => track.available);
      const actions = make("div", "netease-actions");
      const play = control(t.play, () => ask("play", { id: detail.id }), "play-all", true);
      play.disabled = !detail.tracks.length;
      actions.append(play, add); root.append(actions, note(t.importNote));
      if (!detail.tracks.length) { root.append(note(t.emptyTracks)); return root; }
      const table = make("table", "netease-tracks");
      const head = make("thead"); const headings = make("tr");
      for (const text of ["#", t.titleColumn, t.artist, t.album, t.duration]) { const cell = make("th", "", text); cell.scope = "col"; headings.append(cell); }
      head.append(headings); table.append(head);
      const body = make("tbody");
      for (const [index, track] of detail.tracks.slice(page * 100, (page + 1) * 100).entries()) {
        const row = make("tr");
        const seconds = Math.floor(track.durationMs / 1000);
        for (const [column, value] of [page * 100 + index + 1, track.title, track.artists.join(", "), track.album, `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`].entries()) {
          const cell = make("td", "", column === 1 ? "" : String(value)); cell.title = String(value);
          if (column === 1) {
            const play = control(track.title, () => ask("play", { id: detail.id, trackId: track.id }), `play:${track.id}`);
            play.setAttribute("aria-label", `${t.playTrack} ${track.title}`); play.disabled = !track.available; cell.append(play);
          }
          row.append(cell);
        }
        body.append(row);
      }
      table.append(body); root.append(table, pagination(detail.tracks.length, 100));
      return root;
    }
    if (playlists === null) return root;
    const filters = make("div", "netease-actions");
    for (const [kind, label] of [["all", t.all], ["created", t.created], ["saved", t.saved]]) {
      const button = control(label, () => { filter = kind; page = 0; changed(); }, `filter:${kind}`);
      button.setAttribute("aria-pressed", String(filter === kind)); filters.append(button);
    }
    root.append(filters);
    const search = make("input", "text-field netease-search");
    search.type = "search"; search.placeholder = t.search; search.setAttribute("aria-label", t.search); search.dataset.key = "netease:search"; search.value = query;
    const list = make("div", "netease-playlists");
    function drawList() {
      const items = playlists.filter((item) => (filter === "all" || item.kind === filter) && item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
      list.replaceChildren();
      if (!items.length) { list.append(note(playlists.length ? t.noMatches : t.empty)); return; }
      for (const item of items.slice(page * 60, (page + 1) * 60)) {
        const row = control("", () => { requestedId = item.id; detail = null; ask("playlist", { id: item.id }); }, `playlist:${item.id}`);
        row.className = "netease-playlist";
        if (item.coverUrl) { const cover = make("img", "netease-cover small"); cover.src = item.coverUrl; cover.alt = ""; cover.loading = "lazy"; row.append(cover); }
        const label = make("span", "netease-playlist-words");
        label.append(make("span", "netease-name", item.name), make("span", "note", `${item.trackCount} ${t.tracks} · ${item.kind === "created" ? t.created : t.saved}${item.private ? ` · ${t.private}` : ""}`));
        row.append(label); list.append(row);
      }
      list.append(pagination(items.length, 60));
    }
    search.addEventListener("input", () => { query = search.value; page = 0; drawList(); });
    drawList(); root.append(search, list);
    return root;
  }
  function pagination(total, size) {
    const t = text(); const bar = make("div", "netease-pagination"); const pages = Math.ceil(total / size);
    if (pages <= 1) return bar;
    const previous = control(t.previous, () => { page -= 1; changed(); }, "previous"); previous.disabled = page === 0;
    const next = control(t.next, () => { page += 1; changed(); }, "next"); next.disabled = page + 1 >= pages;
    bar.append(previous, note(`${page + 1} / ${pages}`), next); return bar;
  }
  return { receive, render, refresh: () => ask("status") };
}
