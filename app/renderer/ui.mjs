// The window's few building blocks: elements, icons, a tooltip that names an icon button and its
// keys, and a scrollbar that shows only while a list moves or the pointer asks for it.

export const make = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

export function icon(name, className = "icon") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}
export const setIcon = (node, name) => node.querySelector("use")?.setAttribute("href", `#i-${name}`);

// The turning mark: four quarter-turns of a record in one strip the compositor moves, in step with
// every other mark on screen. It stands for work in progress, in place of the word "Loading".
const PHASE_MS = 2400;
export function turning() {
  const mark = make("span", "phase");
  const strip = make("i", "", "◐\n◓\n◑\n◒");
  strip.style.animationDelay = `-${Math.round(performance.now() % PHASE_MS)}ms`;
  mark.append(strip);
  mark.setAttribute("aria-hidden", "true");
  return mark;
}

// An icon button says what it does in its tooltip and to a screen reader; the words never sit on screen.
export function name(node, label, keys = "") {
  node.setAttribute("aria-label", label);
  node.dataset.tip = label;
  if (keys) node.dataset.keys = keys; else delete node.dataset.keys;
}

// One tooltip for the whole window. It waits a moment on the first hover, then follows the pointer
// from button to button at once, and never covers what it names. It has no entrance: it is there or not.
export function tooltips() {
  const tip = make("div", "tip");
  tip.setAttribute("role", "tooltip");
  tip.hidden = true;
  document.body.append(tip);
  let target = null;
  let timer = 0;
  let warm = 0;
  const place = () => {
    if (!target?.isConnected) return hide();
    tip.replaceChildren(make("span", "", target.dataset.tip));
    if (target.dataset.keys) tip.append(make("kbd", "", target.dataset.keys));
    tip.hidden = false;
    const box = target.getBoundingClientRect();
    const own = tip.getBoundingClientRect();
    let left;
    let top;
    if (target.dataset.tipAt === "left") {
      left = box.left - own.width - 6;
      top = box.top + box.height / 2 - own.height / 2;
    } else {
      const below = box.top < 64 || target.dataset.tipAt === "below";
      left = box.left + box.width / 2 - own.width / 2;
      top = below ? box.bottom + 6 : box.top - own.height - 6;
    }
    tip.style.left = `${Math.round(Math.min(innerWidth - own.width - 8, Math.max(8, left)))}px`;
    tip.style.top = `${Math.round(Math.min(innerHeight - own.height - 8, Math.max(8, top)))}px`;
  };
  const hide = () => {
    clearTimeout(timer);
    if (!tip.hidden) warm = performance.now();
    tip.hidden = true;
    target = null;
  };
  document.addEventListener("pointerover", (event) => {
    const next = event.target.closest?.("[data-tip]");
    if (next === target) return;
    hide();
    if (!next || next.disabled) return;
    target = next;
    timer = setTimeout(place, performance.now() - warm < 300 ? 0 : 280);
  });
  // A control reached with the keyboard names itself too, at once.
  document.addEventListener("focusin", (event) => {
    const next = event.target.closest?.("[data-tip]");
    if (!next || next === target || !next.matches(":focus-visible")) return;
    hide();
    target = next;
    timer = setTimeout(place, 0);
  });
  document.addEventListener("focusout", hide);
  document.addEventListener("pointerdown", hide, true);
  document.addEventListener("keydown", hide, true);
  document.addEventListener("wheel", hide, { passive: true, capture: true });
  window.addEventListener("blur", hide);
  return { hide };
}

// An overlay scrollbar for a scrolling element whose parent is its positioned frame. The native bar
// is hidden; this thumb appears while the list scrolls or when the pointer nears the edge, and can be dragged.
export function scrollbar(scroller, { inset = 6, onGrab = null, onRelease = null } = {}) {
  const frame = scroller.parentElement;
  const rail = make("div", "rail");
  const thumb = make("div", "thumb");
  rail.append(thumb);
  frame.append(rail);
  let idle = 0;
  let queued = 0;
  let geometry = { track: -1, size: 0, room: 0, top: -1 };

  function measure() {
    queued = 0;
    const { scrollHeight, clientHeight, scrollTop } = scroller;
    const room = scrollHeight - clientHeight;
    const track = Math.max(0, clientHeight - inset - 6);
    const none = room <= 1;
    if (rail.classList.contains("none") !== none) rail.classList.toggle("none", none);
    if (none) return;
    const size = Math.max(30, Math.round(track * clientHeight / scrollHeight));
    // Only what changed is written: the frame's size rarely, the thumb's place on every scroll.
    if (geometry.track !== track || geometry.top !== scroller.offsetTop) {
      rail.style.top = `${scroller.offsetTop + inset}px`;
      rail.style.height = `${track}px`;
    }
    if (geometry.size !== size) thumb.style.height = `${size}px`;
    geometry = { track, size, room, top: scroller.offsetTop };
    thumb.style.transform = `translateY(${Math.round((track - size) * Math.min(1, scrollTop / room))}px)`;
  }
  const soon = () => { if (!queued) queued = requestAnimationFrame(measure); };
  const wake = () => {
    rail.classList.add("on");
    clearTimeout(idle);
    idle = setTimeout(() => { if (!rail.classList.contains("held")) rail.classList.remove("on"); }, 1100);
  };
  scroller.addEventListener("scroll", () => { soon(); wake(); }, { passive: true });
  const observer = new ResizeObserver(soon);
  observer.observe(scroller);
  const watchContent = () => { for (const child of scroller.children) observer.observe(child); };
  new MutationObserver(() => { watchContent(); soon(); }).observe(scroller, { childList: true });
  watchContent();

  thumb.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onGrab?.();
    thumb.setPointerCapture(event.pointerId);
    rail.classList.add("held", "on");
    const start = { y: event.clientY, top: scroller.scrollTop };
    const move = (moved) => {
      const { track, size, room } = geometry;
      scroller.scrollTop = start.top + (moved.clientY - start.y) * room / Math.max(1, track - size);
    };
    const up = () => {
      thumb.removeEventListener("pointermove", move);
      rail.classList.remove("held");
      onRelease?.();
      wake();
    };
    thumb.addEventListener("pointermove", move);
    thumb.addEventListener("pointerup", up, { once: true });
    thumb.addEventListener("pointercancel", up, { once: true });
  });
  // A click on the track pages toward it.
  rail.addEventListener("pointerdown", (event) => {
    if (event.target !== rail) return;
    onGrab?.();
    const box = thumb.getBoundingClientRect();
    scroller.scrollBy({ top: (event.clientY < box.top ? -1 : 1) * scroller.clientHeight * 0.85,
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  });
  rail.addEventListener("pointerenter", wake);
  soon();
  return { measure: soon };
}

// A line too long for its place rolls to its end and back while the pointer rests on its row, so the
// whole of it can be read without a tooltip. `find` picks the line in the hovered row; `tail` keeps
// room clear past the line's end, such as for a button that floats over it there.
const ROLL_SPEED = 36;
const ROLL_HOLD = 1100;
export function marquee(root, rows, { find = (row) => row, tail = () => 0 } = {}) {
  root.addEventListener("pointerover", (event) => {
    const row = event.target.closest?.(rows);
    if (!row || !root.contains(row) || row.rolling) return;
    const line = find(row);
    const over = line ? line.scrollWidth - line.clientWidth : 0;
    if (over < 2 || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const reach = over + tail(line);
    const out = (reach / ROLL_SPEED) * 1000;
    const back = out * 0.45;
    const total = ROLL_HOLD + out + ROLL_HOLD + back;
    const at = (ms) => ms / total;
    line.classList.add("rolling");
    const animation = line.animate([
      { offset: 0, textIndent: "0px" },
      { offset: at(ROLL_HOLD), textIndent: "0px", easing: "cubic-bezier(0.45, 0, 0.55, 1)" },
      { offset: at(ROLL_HOLD + out), textIndent: `${-reach}px` },
      { offset: at(ROLL_HOLD * 2 + out), textIndent: `${-reach}px`, easing: "cubic-bezier(0.45, 0, 0.55, 1)" },
      { offset: 1, textIndent: "0px" },
    ], { duration: total, delay: 350, iterations: Infinity });
    row.rolling = animation;
    const leave = (out) => {
      if (row.contains(out.relatedTarget)) return;
      row.removeEventListener("pointerout", leave);
      const indent = getComputedStyle(line).textIndent;
      animation.cancel();
      row.rolling = null;
      const settle = line.animate([{ textIndent: indent }, { textIndent: "0px" }], { duration: 240, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
      settle.onfinish = () => { if (!row.rolling) line.classList.remove("rolling"); };
    };
    row.addEventListener("pointerout", leave);
  });
}
