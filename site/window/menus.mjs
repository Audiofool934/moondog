// The menus and confirmations the app shows natively (app/main.mjs), drawn in the page. The same plain
// items go in, { id, label, checked, enabled, type, submenu }, and the chosen id, or null, comes back.
const make = (tag, className, text) => Object.assign(document.createElement(tag), className ? { className } : {}, text ? { textContent: text } : {});
// The window's own symbols, from its index.html.
const glyph = (id) => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  use.setAttribute("href", `#${id}`);
  svg.append(use);
  return svg;
};

let closeOpen = null;

export function showMenu(items, at) {
  closeOpen?.(null);
  return new Promise((resolve) => {
    // A layer under the menus takes the click that closes them.
    const layer = make("div", "menu-layer");
    const opened = [];
    const close = (value) => {
      if (closeOpen !== close) return;
      closeOpen = null;
      layer.remove();
      document.removeEventListener("keydown", onKey, true);
      resolve(value);
    };
    closeOpen = close;
    layer.addEventListener("pointerdown", (event) => { if (event.target === layer) close(null); });
    layer.addEventListener("contextmenu", (event) => event.preventDefault());

    const place = (menu, x, y, beside) => {
      const { innerWidth: width, innerHeight: height } = window;
      const box = menu.getBoundingClientRect();
      let left = x;
      let top = y;
      if (left + box.width > width - 8) left = beside ? beside.left - box.width + 4 : width - 8 - box.width;
      if (top + box.height > height - 8) top = Math.max(8, height - 8 - box.height);
      menu.style.left = `${Math.max(8, left)}px`;
      menu.style.top = `${top}px`;
    };
    const rows = (menu) => [...menu.querySelectorAll(":scope > .menu-item:not([aria-disabled='true'])")];
    const closeFrom = (depth) => { for (const menu of opened.splice(depth)) menu.remove(); };
    const open = (list, depth, x, y, beside) => {
      closeFrom(depth);
      const menu = make("div", "menu");
      menu.setAttribute("role", "menu");
      menu.tabIndex = -1;
      for (const item of list) {
        if (item.type === "separator") { menu.append(make("div", "menu-separator")); continue; }
        if (item.type === "header") { menu.append(make("div", "menu-header", String(item.label ?? ""))); continue; }
        const row = make("button", "menu-item");
        row.type = "button";
        row.tabIndex = -1;
        row.setAttribute("role", item.checked !== undefined ? "menuitemcheckbox" : "menuitem");
        if (item.checked !== undefined) row.setAttribute("aria-checked", String(item.checked === true));
        if (item.enabled === false) row.setAttribute("aria-disabled", "true");
        const check = make("span", "menu-check");
        if (item.checked === true) check.append(glyph("i-check"));
        row.append(check, make("span", "menu-label", String(item.label ?? "")));
        const submenu = Array.isArray(item.submenu) ? item.submenu : null;
        if (submenu) {
          row.setAttribute("aria-haspopup", "menu");
          row.append(glyph("i-chevron"));
        }
        const openSubmenu = () => {
          const box = row.getBoundingClientRect();
          open(submenu, depth + 1, box.right - 4, box.top - 5, box);
        };
        row.addEventListener("pointerenter", () => {
          row.focus({ preventScroll: true });
          if (submenu) openSubmenu(); else closeFrom(depth + 1);
        });
        row.addEventListener("click", () => {
          if (item.enabled === false) return;
          if (submenu) { openSubmenu(); rows(opened[depth + 1])[0]?.focus(); } else close(item.id ?? null);
        });
        row.addEventListener("keydown", (event) => {
          if (submenu && event.key === "ArrowRight") { event.preventDefault(); openSubmenu(); rows(opened[depth + 1])[0]?.focus(); }
        });
        menu.append(row);
      }
      // The pointer leaving the deepest menu leaves nothing chosen in it.
      menu.addEventListener("pointerleave", () => { if (opened.at(-1) === menu) menu.focus({ preventScroll: true }); });
      layer.append(menu);
      opened.push(menu);
      place(menu, x, y, beside);
      return menu;
    };
    const onKey = (event) => {
      const menu = opened.find((candidate) => candidate.contains(document.activeElement)) ?? opened.at(-1);
      const list = rows(menu);
      const index = list.indexOf(document.activeElement);
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(null); }
      else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        // From the menu itself, Down takes the first item and Up the last.
        const step = event.key === "ArrowDown" ? 1 : -1;
        list[index < 0 ? (step > 0 ? 0 : list.length - 1) : (index + step + list.length) % list.length]?.focus();
      } else if (event.key === "ArrowLeft" && opened.indexOf(menu) > 0) {
        event.preventDefault();
        const depth = opened.indexOf(menu);
        closeFrom(depth);
        rows(opened[depth - 1]).find((row) => row.getAttribute("aria-haspopup"))?.focus();
      } else if (event.key === "Tab") event.preventDefault();
    };

    document.body.append(layer);
    document.addEventListener("keydown", onKey, true);
    // As a Mac menu does, nothing is chosen until the pointer or a key moves onto an item.
    const point = at ?? { x: window.innerWidth / 2, y: window.innerHeight / 3 };
    open(items, 0, point.x, point.y).focus({ preventScroll: true });
  });
}

// A question before something that can't be undone, such as deleting a conversation.
export function confirmAction({ message, detail, confirm, cancel } = {}) {
  closeOpen?.(null);
  return new Promise((resolve) => {
    const layer = make("div", "confirm-layer");
    const dialog = make("div", "confirm");
    dialog.setAttribute("role", "alertdialog");
    dialog.setAttribute("aria-modal", "true");
    const title = make("p", "confirm-message", String(message ?? ""));
    title.id = "confirm-message";
    dialog.setAttribute("aria-labelledby", title.id);
    dialog.append(title);
    if (detail) dialog.append(make("p", "confirm-detail", String(detail)));
    const actions = make("div", "confirm-actions");
    const no = make("button", "button", String(cancel ?? "Cancel"));
    const yes = make("button", "button primary", String(confirm ?? "OK"));
    no.type = yes.type = "button";
    actions.append(no, yes);
    dialog.append(actions);
    layer.append(dialog);
    const done = (value) => {
      layer.remove();
      document.removeEventListener("keydown", onKey, true);
      resolve(value);
    };
    const onKey = (event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); done(false); }
      if (event.key === "Tab") { event.preventDefault(); (document.activeElement === no ? yes : no).focus(); }
    };
    no.addEventListener("click", () => done(false));
    yes.addEventListener("click", () => done(true));
    layer.addEventListener("pointerdown", (event) => { if (event.target === layer) done(false); });
    document.body.append(layer);
    document.addEventListener("keydown", onKey, true);
    no.focus();
  });
}
