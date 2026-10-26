// The conversations on the left: pinned ones first, then folders, then the rest by day.
// A row's actions (rename, pin, move to a folder, delete) open from its ⋯ button or a right-click,
// as a native menu; dragging a row onto a folder files it there.
// ⌘-click and Shift-click select several rows, as in Finder; the menu and a drag then act on all of them.
// Rows are kept by id and moved rather than rebuilt, so the row under the pointer keeps its hover,
// a focused row keeps the focus, and a running dot keeps breathing when the list changes.
import { icon, make } from "./ui.mjs";

const dayStart = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
function groupOf(updatedAt) {
  const days = Math.round((dayStart(new Date()) - dayStart(new Date(updatedAt))) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : days < 7 ? "previous7" : "older";
}
const DRAG = "application/x-moondog-session";
// moveBefore keeps focus, hover and running animations; older engines fall back to insertBefore.
const put = (parent, node, before) => (node.isConnected && node.parentNode === parent && parent.moveBefore ? parent.moveBefore(node, before) : parent.insertBefore(node, before));
function reconcile(parent, wanted) {
  let cursor = parent.firstChild;
  for (const node of wanted) {
    if (node === cursor) cursor = cursor.nextSibling;
    else put(parent, node, cursor);
  }
  while (cursor) { const next = cursor.nextSibling; cursor.remove(); cursor = next; }
}

export function createSidebar({ root, state, send, t, open, store, menuPoint }) {
  const collapsed = new Set(JSON.parse(store.get("moondog.folders.collapsed") ?? "[]"));
  const rows = new Map();
  const heads = new Map();
  const labels = new Map();
  let renaming = null;
  let naming = null;
  const menu = (items, event) => window.moondogApp?.showMenu?.(items, event ? menuPoint(event) : undefined);

  // The rows selected with ⌘ or Shift. Empty, the open conversation is the only one chosen. A Shift range
  // runs from the anchor, the row last clicked or added with ⌘, to the row clicked now.
  const selected = new Set();
  let anchor = null;
  const shownIds = () => [...root.querySelectorAll(".row")].map((item) => item.dataset.id);
  function select(id, { metaKey, shiftKey }) {
    const order = shownIds();
    // A selection starts from the open conversation, as one in Finder starts from the selected file.
    if (!selected.size && order.includes(state.current)) selected.add(state.current);
    if (shiftKey) {
      const from = order.indexOf(order.includes(anchor) ? anchor : state.current);
      const to = order.indexOf(id);
      if (!metaKey) selected.clear();
      for (const each of from < 0 ? [id] : order.slice(Math.min(from, to), Math.max(from, to) + 1)) selected.add(each);
    } else if (selected.has(id)) {
      // Taking a row out leaves the anchor on a chosen row.
      selected.delete(id);
      if (anchor === id) anchor = [...selected].at(-1) ?? null;
    } else {
      selected.add(id);
      anchor = id;
    }
    paint();
  }
  function deselect() {
    if (!selected.size) return false;
    selected.clear();
    paint();
    return true;
  }
  function paint() {
    // A row that left the list, or hides in a folded folder, leaves the selection too.
    for (const id of selected) if (!rows.get(id)?.item.isConnected) selected.delete(id);
    root.classList.toggle("selecting", selected.size > 0);
    for (const [id, entry] of rows) entry.item.classList.toggle("selected", selected.has(id));
  }
  // What a row's menu, drag or delete key acts on: the whole selection when the row is in it, else the row.
  const chosenWith = (id) => (selected.has(id) && selected.size > 1 ? shownIds().filter((each) => selected.has(each)) : [id]);
  function rowMenu(session, event) {
    const ids = chosenWith(session.id);
    if (ids.length > 1) return selectionMenu(ids, event);
    // A row outside the selection takes the menu for itself, and the selection lets go.
    if (!selected.has(session.id)) deselect();
    return sessionMenu(session, event);
  }

  async function selectionMenu(ids, event) {
    const sessions = ids.map((id) => rows.get(id)?.session).filter(Boolean);
    const pinned = sessions.every((session) => session.pinned);
    const folders = state.folders.filter((folder) => !sessions.every((session) => session.folderId === folder.id));
    const chosen = await menu([
      { id: "pin", label: pinned ? t()("unpin") : t()("pin") },
      { id: "move", label: t()("moveTo"), submenu: [
        ...folders.map((folder) => ({ id: `folder:${folder.id}`, label: folder.name })),
        ...(folders.length ? [{ type: "separator" }] : []),
        { id: "new-folder", label: t()("newFolder") },
        ...(sessions.some((session) => session.folderId) ? [{ type: "separator" }, { id: "unfile", label: t()("removeFromFolder") }] : []),
      ] },
      { type: "separator" },
      { id: "delete", label: t()("deleteConversations", { count: sessions.length }), enabled: !sessions.some((session) => state.running.includes(session.id)) },
    ], event);
    if (!chosen) return;
    if (chosen === "pin") send({ type: "label", ids, patch: { pinned: !pinned } });
    if (chosen === "unfile") send({ type: "label", ids, patch: { folderId: null } });
    if (chosen.startsWith("folder:")) send({ type: "label", ids, patch: { folderId: chosen.slice(7) } });
    if (chosen === "new-folder") { naming = { moveSessions: ids }; render(); }
    if (chosen === "delete") await confirmDelete(ids);
  }
  async function confirmDelete(ids) {
    const title = ids.length === 1 ? rows.get(ids[0])?.session.title || t()("untitled") : null;
    const confirmed = await window.moondogApp?.confirm?.({ message: title ? t()("deleteQuestion", { title }) : t()("deleteManyQuestion", { count: ids.length }),
      detail: t()("deleteDetail"), confirm: t()("delete"), cancel: t()("cancel") });
    if (confirmed) send({ type: "delete", ids });
  }

  async function sessionMenu(session, event) {
    const folders = state.folders.filter((folder) => folder.id !== session.folderId);
    const chosen = await menu([
      { id: "rename", label: t()("rename") },
      { id: "pin", label: session.pinned ? t()("unpin") : t()("pin") },
      { id: "move", label: t()("moveTo"), submenu: [
        ...folders.map((folder) => ({ id: `folder:${folder.id}`, label: folder.name })),
        ...(folders.length ? [{ type: "separator" }] : []),
        { id: "new-folder", label: t()("newFolder") },
        ...(session.folderId ? [{ type: "separator" }, { id: "unfile", label: t()("removeFromFolder") }] : []),
      ] },
      { type: "separator" },
      { id: "delete", label: t()("deleteConversation"), enabled: !state.running.includes(session.id) },
    ], event);
    if (!chosen) return;
    if (chosen === "rename") { renaming = session.id; render(); }
    if (chosen === "pin") send({ type: "label", id: session.id, patch: { pinned: !session.pinned } });
    if (chosen === "unfile") send({ type: "label", id: session.id, patch: { folderId: null } });
    if (chosen.startsWith("folder:")) send({ type: "label", id: session.id, patch: { folderId: chosen.slice(7) } });
    if (chosen === "new-folder") { naming = { moveSessions: [session.id] }; render(); }
    if (chosen === "delete") await confirmDelete([session.id]);
  }
  async function folderMenu(folder, event) {
    const chosen = await menu([{ id: "rename", label: t()("renameFolder") }, { type: "separator" }, { id: "delete", label: t()("deleteFolder") }], event);
    if (chosen === "rename") { naming = { folderId: folder.id, name: folder.name }; render(); }
    if (chosen === "delete") {
      const confirmed = await window.moondogApp?.confirm?.({ message: t()("deleteFolderQuestion", { name: folder.name }), detail: t()("deleteFolderDetail"),
        confirm: t()("delete"), cancel: t()("cancel") });
      if (confirmed) send({ type: "folder-delete", id: folder.id });
    }
  }

  // An inline field for a new name; Enter keeps it, Esc or an empty name leaves things as they were.
  function nameField(value, done, label) {
    const field = make("input", "rename");
    field.value = value ?? "";
    field.placeholder = label;
    field.setAttribute("aria-label", label);
    field.spellcheck = false;
    let finished = false;
    const finish = (keep) => {
      if (finished) return;
      finished = true;
      done(keep ? field.value.trim() : null);
    };
    field.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); finish(true); }
      if (event.key === "Escape") { event.preventDefault(); finish(false); }
    });
    // A redraw that removes the field is not the listener leaving it.
    field.addEventListener("blur", () => { if (field.isConnected) finish(true); });
    requestAnimationFrame(() => { field.focus(); field.select(); });
    return field;
  }

  // One row per conversation, made once. Its handlers read entry.session, which each render updates.
  function rowFor(session) {
    let entry = rows.get(session.id);
    if (!entry) {
      const item = make("div", "row");
      item.dataset.id = session.id;
      const button = make("button", "open");
      button.type = "button";
      const label = make("span", "name");
      const running = make("span", "running");
      running.setAttribute("aria-hidden", "true");
      button.append(label);
      // The ⋯ button is for the pointer; the keyboard opens the same menu with the context menu key or Shift+F10.
      const more = make("button", "more");
      more.type = "button";
      more.tabIndex = -1;
      more.append(icon("more"));
      item.append(button, more);
      entry = { item, button, label, running, more, session };
      button.addEventListener("keydown", (event) => {
        const id = entry.session.id;
        if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) { event.preventDefault(); void rowMenu(entry.session, event); }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const all = [...root.querySelectorAll(".row .open")];
          const next = all[all.indexOf(button) + (event.key === "ArrowDown" ? 1 : -1)];
          if (!next) return;
          // Shift extends a selection from the row it started on, as Shift-click does.
          if (event.shiftKey) {
            if (!selected.size) anchor = id;
            select(next.closest(".row").dataset.id, { shiftKey: true });
          }
          next.focus();
        }
        if (event.key === "Escape" && deselect()) event.preventDefault();
        // ⌘⌫ or Delete deletes the row, or the selection it is in, after asking.
        if ((event.key === "Backspace" && event.metaKey) || event.key === "Delete") { event.preventDefault(); void confirmDelete(chosenWith(id)); }
      });
      button.addEventListener("click", (event) => {
        if (event.metaKey || event.shiftKey) { select(entry.session.id, event); return; }
        deselect();
        anchor = entry.session.id;
        // The choice shows at once; the core confirms it a moment later.
        for (const other of rows.values()) other.item.removeAttribute("aria-current");
        item.setAttribute("aria-current", "true");
        open(entry.session.id);
      });
      more.addEventListener("click", (event) => { event.stopPropagation(); void rowMenu(entry.session, event); });
      item.addEventListener("contextmenu", (event) => { event.preventDefault(); void rowMenu(entry.session, event); });
      item.draggable = true;
      item.addEventListener("dragstart", (event) => {
        const ids = chosenWith(entry.session.id);
        event.dataTransfer.setData(DRAG, JSON.stringify(ids));
        event.dataTransfer.effectAllowed = "move";
        if (ids.length > 1) dragImage(event, item, ids.length);
      });
      rows.set(session.id, entry);
    }
    entry.session = session;
    const title = session.title || t()("untitled");
    if (entry.title !== title) {
      entry.title = title;
      // The core ends an unnamed branch's title with its place in the lineage, "Late night #2". The number gets
      // its own span, so the title shortens before it and two branches never read alike.
      const branch = session.branch && !session.customTitle ? title.match(/^(.*) (#\d+)$/su) : null;
      entry.label.replaceChildren(...(branch ? [make("span", "base", branch[1]), make("span", "number", branch[2])] : [title]));
    }
    entry.more.setAttribute("aria-label", t()("conversationActions"));
    if (session.id === state.current) entry.item.setAttribute("aria-current", "true"); else entry.item.removeAttribute("aria-current");
    const answering = state.running.includes(session.id);
    entry.item.classList.toggle("answering", answering);
    if (answering && !entry.running.isConnected) entry.button.append(entry.running);
    if (!answering) entry.running.remove();
    return entry.item;
  }

  function dropTarget(node, folderId) {
    let depth = 0;
    node.addEventListener("dragenter", (event) => {
      if (!event.dataTransfer.types.includes(DRAG)) return;
      depth += 1;
      node.classList.add("drop-target");
    });
    node.addEventListener("dragover", (event) => { if (event.dataTransfer.types.includes(DRAG)) event.preventDefault(); });
    node.addEventListener("dragleave", () => { depth = Math.max(0, depth - 1); if (!depth) node.classList.remove("drop-target"); });
    node.addEventListener("drop", (event) => {
      const ids = JSON.parse(event.dataTransfer.getData(DRAG) || "[]");
      depth = 0;
      node.classList.remove("drop-target");
      if (!ids.length) return;
      event.preventDefault();
      event.stopPropagation();
      send({ type: "label", ids, patch: { folderId } });
    });
  }
  // Several rows drag as the row under the pointer with their count beside it.
  function dragImage(event, item, count) {
    const ghost = item.cloneNode(true);
    ghost.querySelector(".more")?.remove();
    ghost.querySelector(".running")?.remove();
    ghost.classList.add("drag-ghost");
    ghost.style.width = `${item.offsetWidth}px`;
    ghost.append(make("span", "count", String(count)));
    document.body.append(ghost);
    const box = item.getBoundingClientRect();
    event.dataTransfer.setDragImage(ghost, event.clientX - box.left, event.clientY - box.top);
    requestAnimationFrame(() => ghost.remove());
  }

  function label(key) {
    let node = labels.get(key);
    if (!node) { node = make("h2"); labels.set(key, node); }
    const text = t()(key.replace(/^loose:/u, ""));
    if (node.textContent !== text) node.textContent = text;
    return node;
  }

  function folderSection(folder, sessions) {
    let entry = heads.get(folder.id);
    if (!entry) {
      const section = make("section", "folder");
      const head = make("div", "folder-head");
      const toggle = make("button", "folder-toggle");
      toggle.type = "button";
      const chevron = icon("chevron", "icon chevron");
      const name = make("span", "name");
      const count = make("span", "count");
      toggle.append(chevron, icon("folder"), name, count);
      const more = make("button", "more");
      more.type = "button";
      more.tabIndex = -1;
      more.append(icon("more"));
      head.append(toggle, more);
      const list = make("div", "folder-rows");
      section.append(head, list);
      entry = { section, head, toggle, name, count, more, list, folder };
      toggle.addEventListener("keydown", (event) => {
        if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) { event.preventDefault(); void folderMenu(entry.folder, event); }
      });
      toggle.addEventListener("click", () => {
        const id = entry.folder.id;
        if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
        store.set("moondog.folders.collapsed", JSON.stringify([...collapsed]));
        render();
      });
      more.addEventListener("click", (event) => { event.stopPropagation(); void folderMenu(entry.folder, event); });
      head.addEventListener("contextmenu", (event) => { event.preventDefault(); void folderMenu(entry.folder, event); });
      dropTarget(head, folder.id);
      heads.set(folder.id, entry);
    }
    entry.folder = folder;
    const open = !collapsed.has(folder.id);
    entry.toggle.setAttribute("aria-expanded", String(open));
    entry.more.setAttribute("aria-label", t()("folderActions"));
    if (entry.name.textContent !== folder.name) entry.name.textContent = folder.name;
    // The count says how much is inside only while the folder hides it.
    entry.count.textContent = open || !sessions.length ? "" : String(sessions.length);
    if (naming?.folderId === folder.id) {
      entry.head.replaceChildren(nameField(folder.name, (name) => {
        naming = null;
        entry.head.replaceChildren(entry.toggle, entry.more);
        if (name && name !== folder.name) send({ type: "folder-save", id: folder.id, name });
        render();
      }, t()("renameFolder")));
    }
    reconcile(entry.list, open ? sessions.map(rowOrField) : []);
    return entry.section;
  }
  const rowOrField = (session) => (renaming === session.id ? renameRow(session) : rowFor(session));
  function renameRow(session) {
    return nameField(session.title, (name) => {
      renaming = null;
      if (name !== null && name !== session.title) send({ type: "label", id: session.id, patch: { title: name || null } });
      render();
    }, t()("rename"));
  }

  // The core's updates wait while a name is being typed, so the field and its text stay.
  let waiting = false;
  let queued = 0;
  function refresh() {
    if (root.querySelector(".rename") && root.contains(document.activeElement)) { waiting = true; return; }
    if (!queued) queued = requestAnimationFrame(() => { queued = 0; render(); });
  }
  const loose = make("div", "loose");
  dropTarget(loose, null);
  function render() {
    waiting = false;
    const sessions = state.sessions;
    const wanted = [];
    const pinned = sessions.filter((session) => session.pinned);
    if (pinned.length) wanted.push(label("pinned"), ...pinned.map(rowOrField));
    if (naming && !naming.folderId) {
      wanted.push(naming.field ??= nameField("", (name) => {
        const pending = naming;
        naming = null;
        if (name) send({ type: "folder-save", name, moveSessions: pending.moveSessions ?? [] });
        render();
      }, t()("newFolder")));
    }
    const folders = [...state.folders].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
    for (const folder of folders) wanted.push(folderSection(folder, sessions.filter((entry) => entry.folderId === folder.id && !entry.pinned)));
    // Everything not pinned and not filed, grouped by the day it was last used.
    const looseRows = [];
    let group = null;
    for (const session of sessions.filter((entry) => !entry.pinned && !entry.folderId)) {
      const name = groupOf(session.updatedAt);
      if (name !== group) { looseRows.push(label(`loose:${name}`)); group = name; }
      looseRows.push(rowOrField(session));
    }
    reconcile(loose, looseRows);
    wanted.push(loose);
    reconcile(root, wanted);
    // Rows and folders that left the list are forgotten.
    const ids = new Set(sessions.map((session) => session.id));
    for (const id of rows.keys()) if (!ids.has(id)) rows.delete(id);
    const folderIds = new Set(state.folders.map((folder) => folder.id));
    for (const id of heads.keys()) if (!folderIds.has(id)) heads.delete(id);
    paint();
  }
  // A click on the list's empty space lets the selection go, as in Finder.
  root.addEventListener("click", (event) => { if (!event.target.closest(".row, .folder-head, .rename")) deselect(); });

  return { render: refresh, startNewFolder: () => { naming = {}; render(); }, get waiting() { return waiting; } };
}
