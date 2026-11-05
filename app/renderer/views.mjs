// The sidebar's views, conversations, the library and your taste, arranged by the listener: stacked as tabs, one
// showing at a time, or split two at a time one above the other with a grip between them. A view's tab or header
// drags: dropped on the upper or lower half of the sidebar it takes that place, dropped on the tab row or a header
// they stack as tabs again. Split, each part's header is its switcher: a click lists the views, the one there
// checked; the other part's view trades places with it, the third takes its place, and Show as tabs stacks them.
// So each view shows once, as a tab or as a header, never both. The layout is kept. A core without a
// library shows no library, and one without a profile no taste; with neither, conversations show alone.
import { icon, make } from "./ui.mjs";

const VIEW_DRAG = "application/x-moondog-view";
const VIEWS = ["conversations", "library", "taste"];
const ICONS = { conversations: "chat", library: "library", taste: "taste" };
const SPLIT_MIN = 0.2;
const SPLIT_DEFAULT = 0.55;

function savedLayout(store) {
  let layout = null;
  try { layout = JSON.parse(store.get("moondog.sidebar.views") ?? "null"); } catch { layout = null; }
  // The sidebar of 0.3.0-beta.8 to beta.10 kept only which one it showed.
  const legacy = store.get("moondog.sidebar.mode") === "library" ? "library" : "conversations";
  // An order saved before taste was a view holds two; taste joins it last, out of the split.
  const kept = Array.isArray(layout?.order) ? layout.order.filter((view, at, all) => VIEWS.includes(view) && all.indexOf(view) === at) : [];
  const order = kept.length >= 2 ? [...kept, ...VIEWS.filter((view) => !kept.includes(view))] : [...VIEWS];
  return {
    mode: layout?.mode === "split" ? "split" : "tabs",
    order,
    active: VIEWS.includes(layout?.active) ? layout.active : legacy,
    split: Number.isFinite(layout?.split) ? Math.min(1 - SPLIT_MIN, Math.max(SPLIT_MIN, layout.split)) : SPLIT_DEFAULT,
  };
}

// Each view that makes something has one +, at its header's end when split and at the tab row's end for the tab
// showing when stacked: onAdd(view, event) makes what that view holds (a conversation folder; a playlist, folder or
// imported playlist), and addLabel(view) names it. Taste makes nothing, so it has none.
export function createSidebarViews({ root, store, t, menu, onShow, onAdd = () => {}, addLabel = () => "" }) {
  const tabs = root.querySelector("[data-view-tabs]");
  const tabAdd = root.querySelector("[data-view-add]");
  const busy = new Set();
  const area = root.querySelector("[data-views]");
  const grip = root.querySelector("[data-view-grip]");
  const sections = Object.fromEntries(VIEWS.map((view) => [view, root.querySelector(`[data-view="${view}"]`)]));
  const heads = Object.fromEntries(VIEWS.map((view) => [view, root.querySelector(`[data-view-head="${view}"]`)]));
  const tabButtons = Object.fromEntries(VIEWS.map((view) => [view, root.querySelector(`[data-view-tab="${view}"]`)]));
  let layout = savedLayout(store);
  // Which views the core can fill: conversations always, the library once it has one, taste once it has a profile.
  const enabled = { conversations: true, library: false, taste: false };
  const save = () => store.set("moondog.sidebar.views", JSON.stringify(layout));
  const available = () => VIEWS.filter((view) => enabled[view]);
  const makes = (view) => view !== "taste";
  // The views' own short names ("Chats" rather than the longer "Conversations" the bar's tooltip uses).
  const label = (view) => (view === "library" ? t()("library") : view === "taste" ? t()("taste") : t()("viewChats"));
  const headAdds = Object.fromEntries(VIEWS.map((view) => {
    const button = make("button", "tool view-head-add");
    button.type = "button";
    button.dataset.tipAt = "below";
    button.append(icon("plus"));
    button.addEventListener("click", (event) => { event.stopPropagation(); onAdd(view, event); });
    // A press on the + is not the start of a header drag.
    button.addEventListener("dragstart", (event) => event.preventDefault());
    return [view, button];
  }));
  tabAdd?.addEventListener("click", (event) => onAdd(current(), event));
  const paintAdd = (button, view) => {
    if (!button) return;
    const text = addLabel(view);
    button.setAttribute("aria-label", text);
    button.dataset.tip = text;
    button.classList.toggle("busy", busy.has(view));
  };

  // What shows: split takes the first two available views in the saved order; stacked, the active one if it can show.
  const split = () => layout.mode === "split" && available().length >= 2;
  const slots = () => layout.order.filter((view) => enabled[view]).slice(0, 2);
  const current = () => (enabled[layout.active] ? layout.active : "conversations");
  const showing = (view) => enabled[view] && (available().length < 2 ? view === "conversations" : split() ? slots().includes(view) : current() === view);

  function render() {
    const isSplit = split();
    const many = available().length;
    // Stacked, the tabs pick the view; split, the headers do, so the tab row goes.
    tabs.hidden = many < 2 || isSplit;
    grip.hidden = !isSplit;
    root.classList.toggle("views-split", isSplit);
    const [first, second] = slots();
    for (const view of VIEWS) {
      sections[view].hidden = !showing(view);
      sections[view].style.order = String(view === first ? 0 : view === second ? 2 : 4);
      heads[view].hidden = !isSplit;
      // Split, a header carries its tab's icon before its name, so the two forms read as one.
      if (heads[view].dataset.label !== label(view)) {
        heads[view].dataset.label = label(view);
        heads[view].replaceChildren(icon(ICONS[view]), make("span", "view-name", label(view)), icon("chevron", "icon view-chevron"),
          ...(makes(view) ? [headAdds[view]] : []));
      }
      paintAdd(headAdds[view], view);
      const tab = tabButtons[view];
      tab.hidden = !enabled[view];
      tab.setAttribute("aria-selected", String(showing(view) && (isSplit ? true : current() === view)));
      tab.setAttribute("aria-label", label(view));
      tab.dataset.tip = label(view);
    }
    // Stacked, the row's + is the + of the tab showing; taste has none.
    if (tabAdd) { tabAdd.hidden = many < 2 || isSplit || !makes(current()); paintAdd(tabAdd, current()); }
    grip.style.order = "1";
    // The upper view takes the split's share of the height, the lower the rest.
    for (const view of VIEWS) sections[view].style.flex = "";
    if (isSplit) { sections[first].style.flex = `${layout.split} 1 0`; sections[second].style.flex = `${1 - layout.split} 1 0`; }
  }

  // A view put in a place of the split: at the top, at the bottom, or where the view being worked in is.
  // A view already in the split trades places with the other; one that wasn't takes the place it is put in, and the
  // view it replaces waits last, out of the split.
  function place(view, at) {
    const [first, second] = slots();
    const target = at === "top" ? first : second;
    if (!target || target === view) return layout.order;
    const order = [...layout.order];
    const from = order.indexOf(view), to = order.indexOf(target);
    if (first === view || second === view) { [order[from], order[to]] = [order[to], order[from]]; return order; }
    order[to] = view;
    order.splice(from, 1);
    return [...order, target];
  }
  // Which view shows: in tabs it becomes the one tab showing; split, it takes the focus, and one that wasn't showing
  // takes the place of the view that had it.
  function show(view) {
    if (!enabled[view]) return;
    if (split() && !slots().includes(view)) layout.order = place(view, slots().indexOf(current()) === 0 ? "top" : "bottom");
    layout.active = view;
    save();
    render();
    onShow?.(view);
  }
  const arrange = (next) => { layout = { ...layout, ...next }; save(); render(); onShow?.(current()); };

  // ── Dragging a view ───────────────────────────────────────────────────────────────────────
  let dragging = null;
  // Split, a header stacks the views as tabs, as the tab row does when they are tabs.
  const zoneOf = (event) => {
    if (tabs.contains(event.target)) return "tabs";
    if (VIEWS.some((view) => heads[view].contains(event.target))) return "tabs";
    const box = area.getBoundingClientRect();
    return event.clientY < box.top + box.height / 2 ? "top" : "bottom";
  };
  const mark = (zone, target = null) => {
    for (const name of ["top", "bottom", "tabs"]) root.classList.toggle(`view-drop-${name}`, zone === name);
    for (const view of VIEWS) heads[view].classList.toggle("drop-target", zone === "tabs" && Boolean(target) && heads[view].contains(target));
  };
  for (const view of VIEWS) {
    for (const handle of [tabButtons[view], heads[view]]) {
      handle.draggable = true;
      handle.addEventListener("dragstart", (event) => {
        dragging = view;
        event.dataTransfer.setData(VIEW_DRAG, view);
        event.dataTransfer.effectAllowed = "move";
      });
      handle.addEventListener("dragend", () => { dragging = null; mark(null); });
    }
    tabButtons[view].addEventListener("click", () => show(view));
    tabButtons[view].addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const list = available();
      const next = list[(list.indexOf(view) + (event.key === "ArrowRight" ? 1 : -1) + list.length) % list.length];
      if (next && next !== view) { show(next); tabButtons[next].focus(); }
    });
    tabButtons[view].addEventListener("contextmenu", (event) => { event.preventDefault(); void viewMenu(view, event); });
    heads[view].addEventListener("contextmenu", (event) => { event.preventDefault(); void viewMenu(view, event); });
    // Split, a header is its part's switcher, by a click, Enter, Space or the context menu key.
    heads[view].addEventListener("click", (event) => { layout.active = view; save(); void viewMenu(view, event); });
    heads[view].tabIndex = 0;
    heads[view].setAttribute("role", "button");
    heads[view].setAttribute("aria-haspopup", "menu");
    heads[view].addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " " || event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) { event.preventDefault(); void viewMenu(view, event); }
    });
    // Split, the view the listener works in is the active one, so ⌥⌘L and the palette act where they are.
    sections[view].addEventListener("focusin", () => {
      if (layout.mode !== "split" || layout.active === view) return;
      layout.active = view;
      save();
    });
  }
  root.addEventListener("dragover", (event) => {
    if (!dragging || !event.dataTransfer.types.includes(VIEW_DRAG)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    mark(zoneOf(event), event.target);
  });
  root.addEventListener("dragleave", (event) => { if (dragging && !root.contains(event.relatedTarget)) mark(null); });
  root.addEventListener("drop", (event) => {
    if (!dragging || !event.dataTransfer.types.includes(VIEW_DRAG)) return;
    event.preventDefault();
    const view = dragging;
    const zone = zoneOf(event);
    dragging = null;
    mark(null);
    if (zone === "tabs") arrange({ mode: "tabs", active: view });
    else arrange({ mode: "split", order: place(view, zone), active: view });
  });

  // Split, a header's menu is its part's switcher: every view, the one there checked, then Show as tabs. Stacked, a
  // tab's menu splits the sidebar.
  async function viewMenu(view, event) {
    if (!split()) {
      const chosen = await menu([{ id: "split", label: t()("viewsSplit") }], event);
      // Split from a tab, that view takes a place beside the one above it.
      if (chosen === "split") arrange({ mode: "split", order: slots().includes(view) || available().length < 3 ? layout.order : place(view, "bottom"), active: view });
      return;
    }
    // It opens as the header's own pop-up, the view there set over the header's name.
    const choices = available();
    const chosen = await menu([
      ...choices.map((each) => ({ id: `view:${each}`, label: label(each), checked: each === view })),
      { type: "separator" },
      { id: "tabs", label: t()("viewsAsTabs") },
    ], event, { element: heads[view].querySelector(".view-name"), selected: choices.indexOf(view) });
    if (chosen === "tabs") { arrange({ mode: "tabs", active: view }); return; }
    const next = typeof chosen === "string" && chosen.startsWith("view:") ? chosen.slice(5) : null;
    if (!next || next === view || !enabled[next]) return;
    arrange({ order: place(next, slots().indexOf(view) === 0 ? "top" : "bottom"), active: next });
  }

  // The grip between split views sets their shares; a double-click restores the default.
  grip.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    grip.setPointerCapture(event.pointerId);
    grip.classList.add("dragging");
    const box = area.getBoundingClientRect();
    const move = (moved) => {
      layout.split = Math.min(1 - SPLIT_MIN, Math.max(SPLIT_MIN, (moved.clientY - box.top) / Math.max(1, box.height)));
      render();
    };
    const up = () => { grip.removeEventListener("pointermove", move); grip.classList.remove("dragging"); save(); };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up, { once: true });
    grip.addEventListener("pointercancel", up, { once: true });
  });
  grip.addEventListener("dblclick", () => arrange({ split: SPLIT_DEFAULT }));

  return {
    render,
    show,
    // The library's view, as before taste had one; enable(view, value) for any view.
    setEnabled(value) { if (enabled.library !== value) { enabled.library = value; render(); } },
    enable(view, value) { if (view in enabled && view !== "conversations" && enabled[view] !== value) { enabled[view] = value; render(); } },
    // A view's + breathes while what it makes is on its way, as a pasted playlist link is read.
    setBusy(view, value) { if (busy.has(view) !== value) { if (value) busy.add(view); else busy.delete(view); render(); } },
    // Whether a view shows now: the two in the split, else only the active tab.
    showing,
    get layout() { return { ...layout, active: current() }; },
    // ⌥⌘L: the library in tabs, or back to conversations from it; split, the library takes the focus.
    toggleLibrary() {
      if (!enabled.library) return;
      show(layout.mode === "tabs" && current() === "library" ? "conversations" : "library");
    },
  };
}
