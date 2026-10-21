// The conversations on the left: pinned ones first, then folders, then the rest by day.
// A row's actions (rename, pin, move to a folder, delete) open from its ⋯ button or a right-click,
// as a native menu; dragging a row onto a folder files it there.
const make = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const icon = (name) => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
};
const dayStart = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
function groupOf(updatedAt) {
  const days = Math.round((dayStart(new Date()) - dayStart(new Date(updatedAt))) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : days < 7 ? "previous7" : "older";
}

export function createSidebar({ root, state, send, t, open, store, menuPoint }) {
  const collapsed = new Set(JSON.parse(store.get("moondog.folders.collapsed") ?? "[]"));
  let renaming = null;
  let naming = null;
  const menu = (items, event) => window.moondogApp?.showMenu?.(items, event ? menuPoint(event) : undefined);

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
    if (chosen === "new-folder") { naming = { moveSession: session.id }; render(); }
    if (chosen === "delete") {
      const title = session.title || t()("untitled");
      const confirmed = await window.moondogApp?.confirm?.({ message: t()("deleteQuestion", { title }), detail: t()("deleteDetail"),
        confirm: t()("delete"), cancel: t()("cancel") });
      if (confirmed) send({ type: "delete", id: session.id });
    }
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
  function nameField(value, done) {
    const field = make("input", "rename");
    field.value = value ?? "";
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

  function row(session) {
    const item = make("div", "row");
    item.dataset.session = session.id;
    if (session.id === state.current) item.setAttribute("aria-current", "true");
    if (renaming === session.id) {
      item.append(nameField(session.title, (name) => {
        renaming = null;
        if (name !== null && name !== session.title) send({ type: "label", id: session.id, patch: { title: name || null } });
        render();
      }));
      return item;
    }
    const button = make("button", "open");
    button.type = "button";
    button.title = session.title || t()("untitled");
    if (state.running.includes(session.id)) button.append(make("span", "running"));
    button.append(make("span", "name", session.title || t()("untitled")));
    button.addEventListener("click", () => open(session.id));
    const more = make("button", "more");
    more.type = "button";
    more.setAttribute("aria-label", t()("conversationActions"));
    more.append(icon("more"));
    more.addEventListener("click", (event) => { event.stopPropagation(); void sessionMenu(session, event); });
    item.append(button, more);
    item.addEventListener("contextmenu", (event) => { event.preventDefault(); void sessionMenu(session, event); });
    item.draggable = true;
    item.addEventListener("dragstart", (event) => { event.dataTransfer.setData("application/x-moondog-session", session.id); event.dataTransfer.effectAllowed = "move"; });
    return item;
  }

  function dropTarget(node, folderId) {
    node.addEventListener("dragover", (event) => {
      if (!event.dataTransfer.types.includes("application/x-moondog-session")) return;
      event.preventDefault();
      node.classList.add("drop-target");
    });
    node.addEventListener("dragleave", () => node.classList.remove("drop-target"));
    node.addEventListener("drop", (event) => {
      const id = event.dataTransfer.getData("application/x-moondog-session");
      node.classList.remove("drop-target");
      if (!id) return;
      event.preventDefault();
      event.stopPropagation();
      send({ type: "label", id, patch: { folderId } });
    });
  }

  // The core's updates wait while a name is being typed, so the field and its text stay.
  let waiting = false;
  function refresh() {
    if (root.querySelector(".rename") && root.contains(document.activeElement)) { waiting = true; return; }
    render();
  }
  function render() {
    waiting = false;
    root.replaceChildren();
    const sessions = state.sessions;
    const pinned = sessions.filter((session) => session.pinned);
    if (pinned.length) {
      root.append(make("h2", "", t()("pinned")));
      for (const session of pinned) root.append(row(session));
    }
    const folders = [...state.folders].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
    if (naming && !naming.folderId) {
      root.append(nameField("", (name) => {
        const pending = naming;
        naming = null;
        if (name) send({ type: "folder-save", name, moveSession: pending.moveSession ?? null });
        render();
      }));
    }
    for (const folder of folders) {
      const section = make("section", "folder");
      const header = make("div", "folder-head");
      if (naming?.folderId === folder.id) {
        header.append(nameField(folder.name, (name) => {
          naming = null;
          if (name && name !== folder.name) send({ type: "folder-save", id: folder.id, name });
          render();
        }));
      } else {
        const toggle = make("button", "folder-toggle");
        toggle.type = "button";
        toggle.setAttribute("aria-expanded", String(!collapsed.has(folder.id)));
        toggle.append(icon(collapsed.has(folder.id) ? "folder" : "folder-open"), make("span", "name", folder.name));
        const count = sessions.filter((session) => session.folderId === folder.id && !session.pinned).length;
        if (count) toggle.append(make("span", "count", String(count)));
        toggle.addEventListener("click", () => {
          if (collapsed.has(folder.id)) collapsed.delete(folder.id); else collapsed.add(folder.id);
          store.set("moondog.folders.collapsed", JSON.stringify([...collapsed]));
          render();
        });
        const more = make("button", "more");
        more.type = "button";
        more.setAttribute("aria-label", t()("folderActions"));
        more.append(icon("more"));
        more.addEventListener("click", (event) => { event.stopPropagation(); void folderMenu(folder, event); });
        header.append(toggle, more);
        header.addEventListener("contextmenu", (event) => { event.preventDefault(); void folderMenu(folder, event); });
      }
      dropTarget(header, folder.id);
      section.append(header);
      if (!collapsed.has(folder.id)) {
        for (const session of sessions.filter((entry) => entry.folderId === folder.id && !entry.pinned)) section.append(row(session));
      }
      root.append(section);
    }
    // Everything not pinned and not filed, grouped by the day it was last used.
    const loose = make("div", "loose");
    dropTarget(loose, null);
    let group = null;
    for (const session of sessions.filter((entry) => !entry.pinned && !entry.folderId)) {
      const name = groupOf(session.updatedAt);
      if (name !== group) { loose.append(make("h2", "", t()(name))); group = name; }
      loose.append(row(session));
    }
    root.append(loose);
  }

  return { render: refresh, startNewFolder: () => { naming = {}; render(); }, get waiting() { return waiting; } };
}
