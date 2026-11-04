// The library in the sidebar, in the conversations' place when the listener turns to it: Saved first, then the
// listener's own folders and playlists, in the order they dragged them. Folders hold playlists and folders, a few
// levels deep; a folder folds like a conversation folder, and its rows step in under its icon. Rows look and act
// like conversation rows: a click opens the playlist in the room, the ⋯ button or a right-click opens its menu,
// and dragging moves it, or drops songs dragged from a playlist into it.
import { icon, make } from "./ui.mjs";

export const NODE_DRAG = "application/x-moondog-library-node";
export const ENTRY_DRAG = "application/x-moondog-library-entries";
const MAX_DEPTH = 4;
// moveBefore keeps focus and hover; older engines fall back to insertBefore.
const put = (parent, node, before) => (node.isConnected && node.parentNode === parent && parent.moveBefore ? parent.moveBefore(node, before) : parent.insertBefore(node, before));
function reconcile(parent, wanted) {
  let cursor = parent.firstChild;
  for (const node of wanted) {
    if (node === cursor) cursor = cursor.nextSibling;
    else put(parent, node, cursor);
  }
  while (cursor) { const next = cursor.nextSibling; cursor.remove(); cursor = next; }
}

// A playlist's cover: the first song's artwork, or the first made track's drawn cover.
export function coverUrl(cover) {
  if (cover?.made_id) return `moondog-media://generated/${cover.made_id}/cover.svg`;
  return cover?.artwork_url ?? null;
}

export function createLibrary({ root, state, send, t, open, store, menuPoint }) {
  const collapsed = new Set(JSON.parse(store.get("moondog.library.collapsed") ?? "[]"));
  const rows = new Map();
  const heads = new Map();
  // An inline name being typed: { kind, parentId } for a new one, { kind, id } for a rename.
  let naming = null;
  let field = null;
  const menu = (items, event) => window.moondogApp?.showMenu?.(items, event ? menuPoint(event) : undefined);
  const library = () => state.library ?? { folders: [], playlists: [] };
  const folderOf = (id) => library().folders.find((folder) => folder.id === id) ?? null;
  const depthOf = (folderId) => { let depth = 0; for (let at = folderOf(folderId); at; at = folderOf(at.parentId)) depth += 1; return depth; };
  const inside = (folderId, ancestorId) => { for (let at = folderOf(folderId); at; at = folderOf(at.parentId)) if (at.id === ancestorId) return true; return false; };
  const children = (parentId) => [
    ...library().folders.filter((folder) => folder.parentId === parentId).map((folder) => ({ kind: "folder", node: folder })),
    ...library().playlists.filter((playlist) => !playlist.saved && playlist.folderId === parentId).map((playlist) => ({ kind: "playlist", node: playlist })),
  ].sort((a, b) => a.node.position - b.node.position || a.node.name.localeCompare(b.node.name));
  const playlistName = (playlist) => (playlist.saved ? t()("saved") : playlist.name);

  // ── Menus ────────────────────────────────────────────────────────────────────────────────
  // Every folder, indented by depth, as places to move to; a folder never offers itself or what is inside it.
  function placesFor(moving) {
    const items = [];
    const walk = (parentId, depth) => {
      for (const { kind, node } of children(parentId)) {
        if (kind !== "folder") continue;
        if (moving.kind === "folder" && (node.id === moving.id || inside(node.id, moving.id))) continue;
        items.push({ id: `into:${node.id}`, label: `${" ".repeat(depth)}${node.name}`, enabled: node.id !== moving.parentId });
        walk(node.id, depth + 1);
      }
    };
    walk(null, 0);
    return [{ id: "into:", label: t()("topLevel"), enabled: moving.parentId !== null }, ...(items.length ? [{ type: "separator" }, ...items] : [])];
  }
  async function playlistMenu(playlist, event) {
    const items = [{ id: "play", label: t()("play") }, { id: "shuffle", label: t()("shufflePlaylist") }];
    if (!playlist.saved) {
      items.push({ type: "separator" }, { id: "rename", label: t()("renamePlaylist") },
        { id: "move", label: t()("moveTo"), submenu: placesFor({ kind: "playlist", id: playlist.id, parentId: playlist.folderId }) },
        { type: "separator" }, { id: "delete", label: t()("deletePlaylist") });
    }
    const chosen = await menu(items, event);
    if (!chosen) return;
    if (chosen === "play" || chosen === "shuffle") send({ type: "library-play", playlistId: playlist.id, shuffle: chosen === "shuffle" });
    if (chosen === "rename") { naming = { kind: "playlist", id: playlist.id }; render(); }
    if (chosen.startsWith("into:")) send({ type: "library-playlist-save", id: playlist.id, folderId: chosen.slice(5) || null });
    if (chosen === "delete") await confirmDelete(playlist);
  }
  async function confirmDelete(playlist) {
    const confirmed = await window.moondogApp?.confirm?.({ message: t()("deletePlaylistQuestion", { name: playlist.name }), detail: t()("deletePlaylistDetail"),
      confirm: t()("delete"), cancel: t()("cancel") });
    if (confirmed) send({ type: "library-playlist-delete", id: playlist.id });
  }
  async function folderMenu(folder, event) {
    const deep = depthOf(folder.id) >= MAX_DEPTH;
    const chosen = await menu([
      { id: "new-playlist", label: t()("newPlaylist") },
      { id: "new-folder", label: t()("newFolder"), enabled: !deep },
      { id: "new-import", label: t()("importPlaylist") },
      { type: "separator" },
      { id: "rename", label: t()("renameFolder") },
      { id: "move", label: t()("moveTo"), submenu: placesFor({ kind: "folder", id: folder.id, parentId: folder.parentId }) },
      { type: "separator" },
      { id: "delete", label: t()("deleteFolder") },
    ], event);
    if (!chosen) return;
    if (chosen?.startsWith("new-")) startNew({ "new-folder": "folder", "new-import": "import" }[chosen] ?? "playlist", folder.id);
    if (chosen === "rename") { naming = { kind: "folder", id: folder.id }; render(); }
    if (chosen.startsWith("into:")) send({ type: "library-folder-save", id: folder.id, parentId: chosen.slice(5) || null });
    if (chosen === "delete") {
      const confirmed = await window.moondogApp?.confirm?.({ message: t()("deleteFolderQuestion", { name: folder.name }), detail: t()("libraryFolderDetail"),
        confirm: t()("delete"), cancel: t()("cancel") });
      if (confirmed) send({ type: "library-folder-delete", id: folder.id });
    }
  }
  // The menu for making something new: from the bar's button, or a right-click on the list's empty space.
  async function newMenu(event) {
    const chosen = await menu([{ id: "playlist", label: t()("newPlaylist") }, { id: "folder", label: t()("newFolder") },
      { type: "separator" }, { id: "import", label: t()("importPlaylist") }], event);
    if (chosen) startNew(chosen, null);
  }
  function startNew(kind, parentId) {
    if (parentId) { collapsed.delete(parentId); saveCollapsed(); }
    naming = { kind, parentId };
    field = null;
    render();
  }
  const saveCollapsed = () => store.set("moondog.library.collapsed", JSON.stringify([...collapsed]));

  // ── Naming ───────────────────────────────────────────────────────────────────────────────
  // An inline field: Enter keeps the name, Esc or an empty name leaves things as they were.
  function nameField(value, done, label, depth) {
    const input = make("input", "rename");
    input.value = value ?? "";
    input.placeholder = label;
    input.setAttribute("aria-label", label);
    input.spellcheck = false;
    input.style.setProperty("--depth", String(depth));
    let finished = false;
    const finish = (keep) => {
      if (finished) return;
      finished = true;
      done(keep ? input.value.trim() : null);
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); finish(true); }
      if (event.key === "Escape") { event.preventDefault(); finish(false); }
    });
    input.addEventListener("blur", () => { if (input.isConnected) finish(true); });
    requestAnimationFrame(() => { input.focus(); input.select(); });
    return input;
  }
  function newField(parentId, depth) {
    if (field) return field;
    const kind = naming.kind;
    field = nameField("", (value) => {
      naming = null;
      field = null;
      // A link is read first; the window asks before the playlist is kept (renderer.mjs, library-import-preview).
      if (value && kind === "import") { importing = true; send({ type: "library-import-preview", link: value, folderId: parentId }); }
      else if (value) send(kind === "folder" ? { type: "library-folder-save", name: value, parentId } : { type: "library-playlist-save", name: value, folderId: parentId });
      render();
    }, { folder: t()("newFolder"), import: t()("pastePlaylistLink") }[kind] ?? t()("newPlaylist"), depth);
    return field;
  }

  // ── Dragging ─────────────────────────────────────────────────────────────────────────────
  const dragged = (event) => (event.dataTransfer.types.includes(NODE_DRAG) ? "node" : event.dataTransfer.types.includes(ENTRY_DRAG) ? "entries" : null);
  let carrying = null;
  // A drop target: what each kind of drag does over it, or null when it can't take that drag.
  function dropTarget(node, accepts) {
    let depth = 0;
    const clear = () => { depth = 0; node.classList.remove("drop-target", "drop-before"); };
    node.addEventListener("dragenter", (event) => {
      const kind = dragged(event);
      const how = kind && accepts(kind, carrying);
      if (!how) return;
      event.stopPropagation();
      depth += 1;
      node.classList.add(how === "before" ? "drop-before" : "drop-target");
    });
    node.addEventListener("dragover", (event) => {
      const kind = dragged(event);
      if (kind && accepts(kind, carrying)) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = kind === "entries" ? "copy" : "move"; }
    });
    node.addEventListener("dragleave", () => { depth = Math.max(0, depth - 1); if (!depth) node.classList.remove("drop-target", "drop-before"); });
    node.addEventListener("drop", (event) => {
      const kind = dragged(event);
      clear();
      if (!kind || !accepts(kind, carrying)) return;
      event.preventDefault();
      event.stopPropagation();
      const data = JSON.parse(event.dataTransfer.getData(kind === "node" ? NODE_DRAG : ENTRY_DRAG) || "null");
      if (data) accepts.drop(kind, data);
    });
    node.addEventListener("dragend", clear);
  }
  const moveNode = (data, parentId, beforeId = null) => send(data.kind === "folder"
    ? { type: "library-folder-save", id: data.id, parentId, beforeId }
    : { type: "library-playlist-save", id: data.id, folderId: parentId, beforeId });
  // Folders may not go inside themselves, nor deeper than the library allows.
  const fits = (data, parentId) => {
    if (data?.kind !== "folder") return true;
    if (data.id === parentId || inside(parentId, data.id)) return false;
    const height = (id) => 1 + Math.max(0, ...library().folders.filter((folder) => folder.parentId === id).map((folder) => height(folder.id)));
    return (parentId ? depthOf(parentId) : 0) + height(data.id) <= MAX_DEPTH;
  };
  function draggable(node, data) {
    node.draggable = true;
    node.addEventListener("dragstart", (event) => {
      carrying = data();
      event.dataTransfer.setData(NODE_DRAG, JSON.stringify(carrying));
      event.dataTransfer.effectAllowed = "move";
    });
    node.addEventListener("dragend", () => { carrying = null; });
  }

  // ── Rows ─────────────────────────────────────────────────────────────────────────────────
  function thumbFor(entry, playlist) {
    const url = playlist.saved ? null : coverUrl(playlist.cover);
    if (entry.thumbUrl === url && entry.thumbSaved === Boolean(playlist.saved)) return;
    entry.thumbUrl = url;
    entry.thumbSaved = Boolean(playlist.saved);
    if (url) {
      const image = make("img");
      image.alt = "";
      image.loading = "lazy";
      image.src = url;
      image.addEventListener("error", () => entry.thumb.replaceChildren(icon("playlist")));
      entry.thumb.replaceChildren(image);
    } else entry.thumb.replaceChildren(icon(playlist.saved ? "saved" : "playlist"));
  }
  function rowFor(playlist, depth) {
    let entry = rows.get(playlist.id);
    if (!entry) {
      const item = make("div", "row");
      item.dataset.id = playlist.id;
      const button = make("button", "open");
      button.type = "button";
      const thumb = make("span", "sleeve");
      const label = make("span", "name");
      button.append(thumb, label);
      const more = make("button", "more");
      more.type = "button";
      more.tabIndex = -1;
      more.append(icon("more"));
      item.append(button, more);
      entry = { item, button, thumb, label, more, playlist };
      button.addEventListener("click", () => open(entry.playlist.id));
      button.addEventListener("keydown", (event) => {
        if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) { event.preventDefault(); void playlistMenu(entry.playlist, event); }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); step(button, event.key === "ArrowDown" ? 1 : -1); }
        if (!entry.playlist.saved && ((event.key === "Backspace" && event.metaKey) || event.key === "Delete")) {
          event.preventDefault();
          void confirmDelete(entry.playlist);
        }
      });
      more.addEventListener("click", (event) => { event.stopPropagation(); void playlistMenu(entry.playlist, event); });
      item.addEventListener("contextmenu", (event) => { event.preventDefault(); void playlistMenu(entry.playlist, event); });
      // Saved stays first, so it takes songs but never moves.
      if (!playlist.saved) draggable(item, () => ({ kind: "playlist", id: entry.playlist.id }));
      const accepts = (kind, data) => (kind === "entries" ? (data?.playlistId === entry.playlist.id ? null : "into")
        : !entry.playlist.saved && data && data.id !== entry.playlist.id && fits(data, entry.playlist.folderId) ? "before" : null);
      accepts.drop = (kind, data) => (kind === "entries"
        ? send({ type: "library-entries-copy", fromPlaylistId: data.playlistId, ids: data.ids, playlistId: entry.playlist.id })
        : moveNode(data, entry.playlist.folderId, entry.playlist.id));
      dropTarget(item, accepts);
      rows.set(playlist.id, entry);
    }
    entry.playlist = playlist;
    const text = playlistName(playlist);
    if (entry.label.textContent !== text) entry.label.textContent = text;
    thumbFor(entry, playlist);
    entry.more.setAttribute("aria-label", t()("playlistActions"));
    entry.item.style.setProperty("--depth", String(depth));
    entry.item.classList.toggle("saved-row", Boolean(playlist.saved));
    if (state.shelf?.id === playlist.id) entry.item.setAttribute("aria-current", "true"); else entry.item.removeAttribute("aria-current");
    return naming?.kind === "playlist" && naming.id === playlist.id ? renameField(playlist, depth) : entry.item;
  }
  function renameField(playlist, depth) {
    return field ??= nameField(playlist.name, (value) => {
      naming = null;
      field = null;
      if (value && value !== playlist.name) send({ type: "library-playlist-save", id: playlist.id, name: value });
      render();
    }, t()("renamePlaylist"), depth);
  }

  function folderSection(folder, depth) {
    let entry = heads.get(folder.id);
    if (!entry) {
      const section = make("section", "folder");
      const head = make("div", "folder-head");
      const toggle = make("button", "folder-toggle");
      toggle.type = "button";
      const name = make("span", "name");
      const count = make("span", "count");
      toggle.append(icon("chevron", "icon chevron"), icon("folder"), name, count);
      const more = make("button", "more");
      more.type = "button";
      more.tabIndex = -1;
      more.append(icon("more"));
      head.append(toggle, more);
      const list = make("div", "folder-rows");
      section.append(head, list);
      entry = { section, head, toggle, name, count, more, list, folder };
      toggle.addEventListener("click", () => {
        const id = entry.folder.id;
        if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
        saveCollapsed();
        render();
      });
      toggle.addEventListener("keydown", (event) => {
        if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) { event.preventDefault(); void folderMenu(entry.folder, event); }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); step(toggle, event.key === "ArrowDown" ? 1 : -1); }
        if (event.key === "ArrowRight" && collapsed.has(entry.folder.id)) toggle.click();
        if (event.key === "ArrowLeft" && !collapsed.has(entry.folder.id)) toggle.click();
      });
      more.addEventListener("click", (event) => { event.stopPropagation(); void folderMenu(entry.folder, event); });
      head.addEventListener("contextmenu", (event) => { event.preventDefault(); void folderMenu(entry.folder, event); });
      draggable(head, () => ({ kind: "folder", id: entry.folder.id }));
      const accepts = (kind, data) => (kind === "node" && data && fits(data, entry.folder.id) ? "into" : null);
      accepts.drop = (_kind, data) => moveNode(data, entry.folder.id);
      dropTarget(head, accepts);
      heads.set(folder.id, entry);
    }
    entry.folder = folder;
    const openFolder = !collapsed.has(folder.id);
    const held = children(folder.id);
    entry.toggle.setAttribute("aria-expanded", String(openFolder));
    entry.more.setAttribute("aria-label", t()("folderActions"));
    entry.head.style.setProperty("--depth", String(depth));
    if (entry.name.textContent !== folder.name) entry.name.textContent = folder.name;
    // The count says how much is inside only while the folder hides it.
    entry.count.textContent = openFolder || !held.length ? "" : String(held.length);
    if (naming?.kind === "folder" && naming.id === folder.id) {
      if (!field) {
        field = nameField(folder.name, (value) => {
          naming = null;
          field = null;
          entry.head.replaceChildren(entry.toggle, entry.more);
          if (value && value !== folder.name) send({ type: "library-folder-save", id: folder.id, name: value });
          render();
        }, t()("renameFolder"), depth);
        entry.head.replaceChildren(field);
      }
    }
    const wanted = [];
    if (openFolder && naming && !naming.id && naming.parentId === folder.id) wanted.push(newField(folder.id, depth + 1));
    if (openFolder) wanted.push(...nodes(folder.id, depth + 1));
    reconcile(entry.list, wanted);
    return entry.section;
  }
  const nodes = (parentId, depth) => children(parentId).map(({ kind, node }) => (kind === "folder" ? folderSection(node, depth) : rowFor(node, depth)));

  // Arrow keys walk every visible row and folder, as in the conversation list.
  function step(from, by) {
    const all = [...root.querySelectorAll(".row .open, .folder-toggle")];
    all[all.indexOf(from) + by]?.focus();
  }

  // The rest of the list, below everything: a drop here moves a playlist or folder to the top level, at the end.
  const tail = make("div", "loose");
  {
    const accepts = (kind, data) => (kind === "node" && data && fits(data, null) ? "into" : null);
    accepts.drop = (_kind, data) => moveNode(data, null);
    dropTarget(tail, accepts);
  }
  // The library's own new button: a bar across the top of the list, a plus in its middle, that offers a
  // playlist or a folder. The bar's new button stays the conversation's.
  const addBar = make("button", "library-add");
  addBar.type = "button";
  addBar.dataset.tipAt = "below";
  addBar.append(icon("plus"));
  addBar.addEventListener("click", (event) => void newMenu(event));
  // A playlist link being read: the bar breathes until the window has asked about it.
  let importing = false;
  // A link dropped on the list is read as one pasted into the import field.
  root.addEventListener("dragover", (event) => { if (!dragged(event) && event.dataTransfer.types.includes("text/uri-list")) event.preventDefault(); });
  root.addEventListener("drop", (event) => {
    if (dragged(event) || !event.dataTransfer.types.includes("text/uri-list")) return;
    const link = event.dataTransfer.getData("text/uri-list").split("\n").find((line) => line.startsWith("http"));
    if (!link) return;
    event.preventDefault();
    importing = true;
    send({ type: "library-import-preview", link: link.trim(), folderId: null });
    render();
  });
  let queued = 0;
  function refresh() {
    // Updates wait while a name is being typed, so the field and its text stay.
    if (field && root.contains(document.activeElement)) return;
    if (!queued) queued = requestAnimationFrame(() => { queued = 0; render(); });
  }
  function render() {
    const saved = library().playlists.find((playlist) => playlist.saved);
    const wanted = [addBar];
    addBar.setAttribute("aria-label", importing ? t()("readingPlaylist") : t()("libraryNew"));
    addBar.dataset.tip = importing ? t()("readingPlaylist") : t()("libraryNew");
    addBar.classList.toggle("busy", importing);
    if (saved) wanted.push(rowFor(saved, 0));
    if (naming && !naming.id && naming.parentId === null) wanted.push(newField(null, 0));
    wanted.push(...nodes(null, 0), tail);
    reconcile(root, wanted);
    const playlistIds = new Set(library().playlists.map((playlist) => playlist.id));
    for (const id of rows.keys()) if (!playlistIds.has(id)) rows.delete(id);
    const folderIds = new Set(library().folders.map((folder) => folder.id));
    for (const id of heads.keys()) if (!folderIds.has(id)) heads.delete(id);
  }
  root.addEventListener("contextmenu", (event) => {
    if (event.target.closest(".row, .folder-head, .rename")) return;
    event.preventDefault();
    void newMenu(event);
  });

  return { render: refresh, newMenu, startNew, importDone() { importing = false; render(); } };
}
