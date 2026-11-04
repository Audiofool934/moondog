// The sidebar's views, conversations and the library, arranged by the listener: stacked as tabs, one showing at a
// time, or split one above the other with a grip between them. A view's tab or header drags: dropped on the upper or
// lower part of the sidebar it splits there, dropped on the tab row or the middle they stack as tabs again. The
// header's menu does the same without a drag. The layout is kept. A core without a library shows conversations alone.

const VIEW_DRAG = "application/x-moondog-view";
const VIEWS = ["conversations", "library"];
const SPLIT_MIN = 0.2;
const SPLIT_DEFAULT = 0.55;

function savedLayout(store) {
  let layout = null;
  try { layout = JSON.parse(store.get("moondog.sidebar.views") ?? "null"); } catch { layout = null; }
  // The sidebar of 0.3.0-beta.8 to beta.10 kept only which one it showed.
  const legacy = store.get("moondog.sidebar.mode") === "library" ? "library" : "conversations";
  const order = Array.isArray(layout?.order) && layout.order.length === 2 && VIEWS.every((view) => layout.order.includes(view)) ? layout.order : [...VIEWS];
  return {
    mode: layout?.mode === "split" ? "split" : "tabs",
    order,
    active: VIEWS.includes(layout?.active) ? layout.active : legacy,
    split: Number.isFinite(layout?.split) ? Math.min(1 - SPLIT_MIN, Math.max(SPLIT_MIN, layout.split)) : SPLIT_DEFAULT,
  };
}

export function createSidebarViews({ root, store, t, menu, onShow }) {
  const tabs = root.querySelector("[data-view-tabs]");
  const area = root.querySelector("[data-views]");
  const grip = root.querySelector("[data-view-grip]");
  const sections = Object.fromEntries(VIEWS.map((view) => [view, root.querySelector(`[data-view="${view}"]`)]));
  const heads = Object.fromEntries(VIEWS.map((view) => [view, root.querySelector(`[data-view-head="${view}"]`)]));
  const tabButtons = Object.fromEntries(VIEWS.map((view) => [view, root.querySelector(`[data-view-tab="${view}"]`)]));
  let layout = savedLayout(store);
  let enabled = false;
  const save = () => store.set("moondog.sidebar.views", JSON.stringify(layout));
  const label = (view) => (view === "library" ? t()("library") : t()("conversations"));

  function render() {
    const split = enabled && layout.mode === "split";
    tabs.hidden = !enabled || split;
    grip.hidden = !split;
    root.classList.toggle("views-split", split);
    for (const view of VIEWS) {
      const showing = view === "conversations" ? !enabled || split || layout.active === view : enabled && (split || layout.active === view);
      sections[view].hidden = !showing;
      sections[view].style.order = String(layout.order.indexOf(view) * 2);
      heads[view].hidden = !split;
      if (heads[view].textContent !== label(view)) heads[view].textContent = label(view);
      const tab = tabButtons[view];
      tab.setAttribute("aria-selected", String(!split && layout.active === view));
      tab.setAttribute("aria-label", label(view));
      tab.dataset.tip = label(view);
    }
    tabButtons.library.hidden = !enabled;
    grip.style.order = "1";
    // The first view takes the split's share of the height, the second the rest.
    const [first, second] = layout.order;
    sections[first].style.flex = split ? `${layout.split} 1 0` : "";
    sections[second].style.flex = split ? `${1 - layout.split} 1 0` : "";
  }

  // Which view shows: in tabs it becomes the one tab showing; split, both show and it takes the focus.
  function show(view) {
    if (!VIEWS.includes(view) || (view === "library" && !enabled)) return;
    layout.active = view;
    save();
    render();
    onShow?.(view);
  }
  const arrange = (next) => { layout = { ...layout, ...next }; save(); render(); onShow?.(layout.active); };

  // ── Dragging a view ───────────────────────────────────────────────────────────────────────
  let dragging = null;
  const zoneOf = (event) => {
    if (tabs.contains(event.target)) return "tabs";
    const box = area.getBoundingClientRect();
    const at = (event.clientY - box.top) / Math.max(1, box.height);
    return at < 0.35 ? "top" : at > 0.65 ? "bottom" : "tabs";
  };
  const mark = (zone) => { for (const name of ["top", "bottom", "tabs"]) root.classList.toggle(`view-drop-${name}`, zone === name); };
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
      const other = VIEWS.find((each) => each !== view);
      if (!tabButtons[other].hidden) { show(other); tabButtons[other].focus(); }
    });
    tabButtons[view].addEventListener("contextmenu", (event) => { event.preventDefault(); void viewMenu(view, event); });
    heads[view].addEventListener("contextmenu", (event) => { event.preventDefault(); void viewMenu(view, event); });
    heads[view].addEventListener("click", () => show(view));
    // Split, a header is the only control for its arrangement, so the keyboard reaches it as it reaches a tab.
    heads[view].tabIndex = 0;
    heads[view].setAttribute("role", "button");
    heads[view].addEventListener("keydown", (event) => {
      if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) { event.preventDefault(); void viewMenu(view, event); }
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
    mark(zoneOf(event));
  });
  root.addEventListener("dragleave", (event) => { if (dragging && !root.contains(event.relatedTarget)) mark(null); });
  root.addEventListener("drop", (event) => {
    if (!dragging || !event.dataTransfer.types.includes(VIEW_DRAG)) return;
    event.preventDefault();
    const view = dragging;
    const other = VIEWS.find((each) => each !== view);
    const zone = zoneOf(event);
    dragging = null;
    mark(null);
    if (zone === "tabs") arrange({ mode: "tabs", active: view });
    else arrange({ mode: "split", order: zone === "top" ? [view, other] : [other, view], active: view });
  });

  // The same arrangements without a drag, from a view's tab or header.
  async function viewMenu(view, event) {
    const split = layout.mode === "split";
    const chosen = await menu(split
      ? [{ id: "tabs", label: t()("viewsAsTabs") }, { id: "swap", label: t()("viewsSwap") }]
      : [{ id: "split", label: t()("viewsSplit") }], event);
    if (chosen === "tabs") arrange({ mode: "tabs", active: view });
    if (chosen === "split") arrange({ mode: "split" });
    if (chosen === "swap") arrange({ order: [...layout.order].reverse() });
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
    setEnabled(value) { if (enabled !== value) { enabled = value; render(); } },
    // Whether a view shows now: always when split, else only the active tab.
    showing: (view) => (view === "conversations" ? !enabled || layout.mode === "split" || layout.active === view : enabled && (layout.mode === "split" || layout.active === view)),
    get layout() { return { ...layout }; },
    // ⌥⌘L: the library in tabs, or back to conversations from it; split, the library takes the focus.
    toggleLibrary() {
      if (!enabled) return;
      show(layout.mode === "tabs" && layout.active === "library" ? "conversations" : "library");
    },
  };
}

