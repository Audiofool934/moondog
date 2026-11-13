// A playlist from the library, open in the room where the conversation was: its sleeve, its name and what it
// holds, songs and Moondog's tracks in one list. Play starts it on the listener's service; a double-click or
// Enter plays from that entry. Entries drag to a new place in the list, or onto a playlist in the sidebar to
// copy them there. The composer stays below, so the listener can go on talking to Moondog.
import { coverUrl, ENTRY_DRAG } from "./library.mjs";
import { discButton } from "./disc.mjs";
import { primaryModifier } from "./platform.mjs";
import { icon, make, name } from "./ui.mjs";

const madeCover = (id) => `moondog-media://generated/${id}/cover.svg`;
const entryCover = (entry) => (entry.kind === "made" ? madeCover(entry.made_id) : entry.refs?.artwork_url ?? null);

export function createShelf({ root, state, send, t, menuPoint, onClose }) {
  const menu = (items, event) => window.moondogApp?.showMenu?.(items, event ? menuPoint(event) : undefined);
  const scroller = make("div", "shelf-scroll");
  const head = make("header", "shelf-head");
  const art = make("div", "shelf-art");
  const meta = make("div", "shelf-meta");
  const title = make("h1", "shelf-name");
  const count = make("p", "shelf-count");
  const actions = make("div", "shelf-actions");
  const play = make("button", "shelf-play");
  play.type = "button";
  // A record button (disc.mjs): its glints turn while this playlist plays.
  const playDisc = discButton(play, { size: 36, glyph: "play-disc", fill: true });
  let playingNow = null;
  const turnIfPlaying = () => {
    const current = playlist();
    const title = String(playingNow?.title ?? "");
    playDisc.setTurning(Boolean(playingNow?.playing && current && title && current.entries.some((entry) => entry.title === title)));
  };
  const shuffle = make("button", "tool");
  shuffle.type = "button";
  shuffle.append(icon("shuffle"));
  const more = make("button", "tool");
  more.type = "button";
  more.append(icon("more"));
  actions.append(play, shuffle, more);
  meta.append(title, count, actions);
  head.append(art, meta);
  const list = make("ol", "shelf-tracks");
  const empty = make("p", "shelf-empty");
  scroller.append(head, list, empty);
  root.append(scroller);

  const rows = new Map();
  const selected = new Set();
  let shownArt = undefined;
  let renaming = false;
  const playlist = () => state.shelf?.playlist ?? null;
  const shownName = (value) => (value.saved ? t()("saved") : value.name);

  play.addEventListener("click", () => playlist() && send({ type: "library-play", playlistId: playlist().id }));
  shuffle.addEventListener("click", () => playlist() && send({ type: "library-play", playlistId: playlist().id, shuffle: true }));
  more.addEventListener("click", (event) => void playlistMenu(event));
  title.addEventListener("dblclick", () => { if (playlist() && !playlist().saved) rename(); });
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !renaming && !event.defaultPrevented) { event.preventDefault(); onClose(); }
  });

  async function playlistMenu(event) {
    const current = playlist();
    if (!current) return;
    const chosen = await menu([
      ...(current.saved ? [] : [{ id: "rename", label: t()("renamePlaylist") }, { type: "separator" }, { id: "delete", label: t()("deletePlaylist") }]),
      ...(current.saved ? [{ id: "close", label: t()("backToConversation") }] : [{ type: "separator" }, { id: "close", label: t()("backToConversation") }]),
    ], event);
    if (chosen === "rename") rename();
    if (chosen === "close") onClose();
    if (chosen === "delete") {
      const confirmed = await window.moondogApp?.confirm?.({ message: t()("deletePlaylistQuestion", { name: current.name }), detail: t()("deletePlaylistDetail"),
        confirm: t()("delete"), cancel: t()("cancel") });
      if (confirmed) { send({ type: "library-playlist-delete", id: current.id }); onClose(); }
    }
  }
  function rename() {
    const current = playlist();
    renaming = true;
    const input = make("input", "shelf-rename");
    input.value = current.name;
    input.spellcheck = false;
    input.setAttribute("aria-label", t()("renamePlaylist"));
    let done = false;
    const finish = (keep) => {
      if (done) return;
      done = true;
      renaming = false;
      const value = input.value.trim();
      input.replaceWith(title);
      if (keep && value && value !== current.name) { title.textContent = value; send({ type: "library-playlist-save", id: current.id, name: value }); }
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); finish(true); }
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finish(false); }
    });
    input.addEventListener("blur", () => finish(true));
    title.replaceWith(input);
    requestAnimationFrame(() => { input.focus(); input.select(); });
  }

  // The entries a menu, a drag or the delete key acts on: the selection when the row is in it, else the row.
  const chosenWith = (id) => (selected.has(id) && selected.size > 1 ? [...list.children].map((row) => row.dataset.id).filter((each) => selected.has(each)) : [id]);
  async function entryMenu(entry, event) {
    const ids = chosenWith(entry.id);
    const current = playlist();
    const others = (state.library?.playlists ?? []).filter((each) => each.id !== current.id && !each.saved)
      .sort((a, b) => a.name.localeCompare(b.name));
    const chosen = await menu([
      ...(ids.length === 1 ? [{ id: "play", label: t()("playFromHere"), enabled: entry.kind === "song" || entry.audio_kept }, { type: "separator" }] : []),
      ...(current.saved ? [] : [{ id: "keep", label: t()("saveToSaved") }]),
      { id: "add", label: t()("addToPlaylist"), enabled: others.length > 0, submenu: others.map((each) => ({ id: `to:${each.id}`, label: each.name })) },
      { type: "separator" },
      { id: "remove", label: ids.length > 1 ? t()("removeEntries", { count: ids.length }) : current.saved ? t()("removeFromSaved") : t()("removeFromPlaylist") },
    ], event);
    if (!chosen) return;
    if (chosen === "play") send({ type: "library-play", playlistId: current.id, entryId: entry.id });
    if (chosen === "keep") send({ type: "library-entries-copy", fromPlaylistId: current.id, ids, playlistId: "saved" });
    if (chosen.startsWith("to:")) send({ type: "library-entries-copy", fromPlaylistId: current.id, ids, playlistId: chosen.slice(3) });
    if (chosen === "remove") remove(ids);
  }
  const remove = (ids) => {
    for (const id of ids) selected.delete(id);
    send({ type: "library-entries-remove", playlistId: playlist().id, ids });
  };

  // Dragging an entry over another puts it before that one; dropping past the last puts it at the end.
  let dragging = null;
  function rowFor(entry, index) {
    let row = rows.get(entry.id);
    if (!row) {
      const item = make("li", "shelf-row");
      item.dataset.id = entry.id;
      item.tabIndex = -1;
      const button = make("button", "shelf-open");
      button.type = "button";
      const number = make("span", "shelf-index");
      const thumb = make("span", "sleeve");
      const words = make("span", "shelf-words");
      const song = make("strong");
      const by = make("span");
      words.append(song, by);
      button.append(number, thumb, words);
      const rowMore = make("button", "more");
      rowMore.type = "button";
      rowMore.tabIndex = -1;
      rowMore.append(icon("more"));
      item.append(button, rowMore);
      row = { item, button, number, thumb, song, by, more: rowMore, entry, cover: undefined };
      const self = row;
      button.addEventListener("click", (event) => {
        if (primaryModifier(event)) { if (selected.has(self.entry.id)) selected.delete(self.entry.id); else selected.add(self.entry.id); }
        else if (event.shiftKey && selected.size) {
          const ids = [...list.children].map((each) => each.dataset.id);
          const from = ids.findIndex((id) => selected.has(id));
          const to = ids.indexOf(self.entry.id);
          for (const id of ids.slice(Math.min(from, to), Math.max(from, to) + 1)) selected.add(id);
        } else { selected.clear(); selected.add(self.entry.id); }
        paint();
      });
      button.addEventListener("dblclick", () => {
        if (self.entry.kind === "made" && !self.entry.audio_kept) return;
        send({ type: "library-play", playlistId: playlist().id, entryId: self.entry.id });
      });
      button.addEventListener("keydown", (event) => {
        if (event.key === "Enter") { event.preventDefault(); button.dispatchEvent(new MouseEvent("dblclick")); }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const next = event.key === "ArrowDown" ? item.nextElementSibling : item.previousElementSibling;
          next?.querySelector(".shelf-open")?.focus();
          if (next) { selected.clear(); selected.add(next.dataset.id); paint(); }
        }
        if ((event.key === "Backspace" && primaryModifier(event)) || event.key === "Delete") { event.preventDefault(); remove(chosenWith(self.entry.id)); }
        if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) { event.preventDefault(); void entryMenu(self.entry, event); }
      });
      rowMore.addEventListener("click", (event) => { event.stopPropagation(); void entryMenu(self.entry, event); });
      item.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        if (!selected.has(self.entry.id)) { selected.clear(); selected.add(self.entry.id); paint(); }
        void entryMenu(self.entry, event);
      });
      item.draggable = true;
      item.addEventListener("dragstart", (event) => {
        const ids = chosenWith(self.entry.id);
        dragging = ids;
        event.dataTransfer.setData(ENTRY_DRAG, JSON.stringify({ playlistId: playlist().id, ids }));
        event.dataTransfer.effectAllowed = "copyMove";
      });
      item.addEventListener("dragend", () => { dragging = null; for (const each of list.children) each.classList.remove("drop-before"); });
      item.addEventListener("dragover", (event) => {
        if (!dragging || dragging.includes(self.entry.id)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        for (const each of list.children) each.classList.toggle("drop-before", each === item);
      });
      item.addEventListener("drop", (event) => {
        if (!dragging) return;
        event.preventDefault();
        item.classList.remove("drop-before");
        send({ type: "library-entries-move", playlistId: playlist().id, ids: dragging, beforeId: self.entry.id });
        dragging = null;
      });
      rows.set(entry.id, row);
    }
    row.entry = entry;
    row.number.textContent = String(index + 1);
    if (row.song.textContent !== entry.title) row.song.textContent = entry.title;
    const credit = entry.kind === "made" ? t()("madeByMoondog") : entry.artist_credit;
    if (row.by.textContent !== credit) row.by.textContent = credit;
    const gone = entry.kind === "made" && !entry.audio_kept;
    row.item.classList.toggle("gone", gone);
    row.item.classList.toggle("made", entry.kind === "made");
    if (gone) row.item.dataset.tip = t()("receiptOnly"); else delete row.item.dataset.tip;
    const cover = entryCover(entry);
    if (row.cover !== cover) {
      row.cover = cover;
      if (cover) {
        const image = make("img");
        image.alt = "";
        image.loading = "lazy";
        image.src = cover;
        image.addEventListener("error", () => image.remove());
        row.thumb.replaceChildren(image);
      } else row.thumb.replaceChildren();
    }
    row.more.setAttribute("aria-label", t()("entryActions"));
    return row.item;
  }
  // Dropping below the last entry moves the dragged ones to the end.
  list.addEventListener("dragover", (event) => { if (dragging && event.target === list) event.preventDefault(); });
  list.addEventListener("drop", (event) => {
    if (!dragging || event.target !== list) return;
    event.preventDefault();
    send({ type: "library-entries-move", playlistId: playlist().id, ids: dragging, beforeId: null });
    dragging = null;
  });
  function paint() {
    for (const [id, row] of rows) row.item.classList.toggle("selected", selected.has(id));
  }

  function render() {
    const current = playlist();
    root.hidden = !state.shelf?.id;
    if (!current) {
      list.replaceChildren();
      turnIfPlaying();
      return;
    }
    if (!renaming && title.textContent !== shownName(current)) title.textContent = shownName(current);
    const songs = current.entries.length;
    const made = current.entries.filter((entry) => entry.kind === "made").length;
    count.textContent = [songs === 1 ? t()("oneEntry") : t()("entries", { count: songs }), made ? t()("madeCount", { count: made }) : ""].filter(Boolean).join(" · ");
    set(count, "hidden", !songs);
    play.disabled = !songs;
    shuffle.disabled = songs < 2;
    name(play, t()("play"));
    name(shuffle, t()("shufflePlaylist"));
    name(more, t()("playlistActions"));
    // The sleeve is its own cover from where it was imported, or the first cover in it, as in the sidebar; a playlist
    // with none shows the blank record.
    const first = current.source?.cover ?? current.entries.map(entryCover).find(Boolean) ?? coverUrl(state.library?.playlists?.find((each) => each.id === current.id)?.cover);
    if (first !== shownArt) {
      shownArt = first;
      if (first) {
        const image = make("img");
        image.alt = "";
        image.src = first;
        art.replaceChildren(image);
        art.classList.remove("blank-art");
      } else {
        art.replaceChildren(icon(current.saved ? "saved" : "record"));
        art.classList.add("blank-art");
      }
    }
    const items = current.entries.map(rowFor);
    const ids = new Set(current.entries.map((entry) => entry.id));
    for (const id of [...rows.keys()]) if (!ids.has(id)) { rows.delete(id); selected.delete(id); }
    let cursor = list.firstChild;
    for (const node of items) {
      if (node === cursor) cursor = cursor.nextSibling;
      else list.insertBefore(node, cursor);
    }
    while (cursor) { const next = cursor.nextSibling; cursor.remove(); cursor = next; }
    empty.textContent = songs ? "" : current.saved ? t()("savedEmpty") : t()("playlistEmpty");
    empty.hidden = Boolean(songs);
    paint();
    turnIfPlaying();
  }
  const set = (node, key, value) => { if (node[key] !== value) node[key] = value; };

  return {
    render,
    reset() { selected.clear(); shownArt = undefined; scroller.scrollTop = 0; },
    focus() { play.focus({ preventScroll: true }); },
    // The song playing now belongs to this playlist: its play button's glints turn. A paused song stills them.
    // The playlist can arrive after the player's news, so each draw of the playlist looks again.
    syncPlaying(now) { playingNow = now ?? null; turnIfPlaying(); },
  };
}
