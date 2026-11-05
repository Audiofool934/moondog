// Pointing at the library from the composer. Typing @ lists the playlists and folders, filtered as you type; Up and
// Down choose, Enter or Tab puts @name in the words, Esc closes. The name stays plain words in the message, so the
// model reads it where it was written, and the core finds what it points at (libraryMentions in library-store.mjs).
import { icon, make } from "./ui.mjs";

// An @ inside a word is an address, not a mention. Chinese and Japanese run on without spaces, so they may come before one.
const ASKING = /(?:^|[^\p{Script=Latin}\p{N}])@([^@\n]{0,60})$/u;

export function createMentions({ input, anchor, items, coverOf }) {
  const list = make("div", "palette mentions");
  list.setAttribute("role", "listbox");
  list.hidden = true;
  anchor.append(list);
  let matches = [];
  let index = 0;
  let pointerMoved = false;

  const asked = () => input.value.slice(0, input.selectionStart ?? input.value.length).match(ASKING)?.[1] ?? null;
  function render() {
    const words = asked();
    if (words === null) return hide();
    const wanted = words.toLowerCase();
    const named = items().filter((item) => item.name.toLowerCase().includes(wanted));
    // What starts with the words comes first.
    matches = [...named.filter((item) => item.name.toLowerCase().startsWith(wanted)), ...named.filter((item) => !item.name.toLowerCase().startsWith(wanted))];
    if (!matches.length) return hide();
    index = Math.min(index, matches.length - 1);
    list.replaceChildren(...matches.map((item, position) => {
      const row = make("div", `palette-item${position === index ? " on" : ""}`);
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(position === index));
      const sleeve = make("span", "mention-sleeve");
      const cover = coverOf(item);
      if (cover) {
        const image = make("img");
        image.alt = "";
        image.src = cover;
        image.addEventListener("error", () => image.replaceWith(icon("record")));
        sleeve.append(image);
      } else sleeve.append(icon(item.kind === "folder" ? "folder" : item.saved ? "saved" : "record"));
      row.append(sleeve, make("span", "mention-name", item.name));
      if (item.note) row.append(make("span", "palette-name", item.note));
      row.addEventListener("pointermove", () => {
        if (!pointerMoved || index === position) { pointerMoved = true; return; }
        index = position;
        mark();
      });
      row.addEventListener("mousedown", (event) => { event.preventDefault(); index = position; choose(); });
      return row;
    }));
    if (list.hidden) pointerMoved = false;
    list.hidden = false;
  }
  function mark() {
    [...list.children].forEach((row, position) => {
      row.classList.toggle("on", position === index);
      row.setAttribute("aria-selected", String(position === index));
    });
    list.children[index]?.scrollIntoView({ block: "nearest" });
  }
  function hide() {
    list.hidden = true;
    matches = [];
    index = 0;
  }
  // Puts @name at the caret, with a space on either side where the words need one.
  function insert(name, from = input.selectionStart ?? input.value.length) {
    const to = input.selectionEnd ?? from;
    const before = input.value.slice(0, from);
    const gap = before && !/\s$/u.test(before) && from === to && !before.endsWith("@") ? " " : "";
    const words = `${gap}@${name} `;
    input.value = `${before}${words}${input.value.slice(to)}`;
    input.setSelectionRange(from + words.length, from + words.length);
    input.focus();
    input.dispatchEvent(new Event("input"));
    hide();
  }
  function choose() {
    const item = matches[index];
    const words = asked();
    if (!item || words === null) return false;
    const caret = input.selectionStart ?? input.value.length;
    const start = caret - words.length - 1;
    input.value = `${input.value.slice(0, start)}${input.value.slice(caret)}`;
    input.setSelectionRange(start, start);
    insert(item.name, start);
    return true;
  }

  input.addEventListener("input", () => { index = 0; render(); });
  input.addEventListener("blur", () => setTimeout(hide, 120));
  input.addEventListener("keydown", (event) => {
    if (list.hidden || event.isComposing) return;
    if (event.key === "ArrowDown") { event.preventDefault(); index = (index + 1) % matches.length; mark(); }
    else if (event.key === "ArrowUp") { event.preventDefault(); index = (index - 1 + matches.length) % matches.length; mark(); }
    else if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
      if (choose()) { event.preventDefault(); event.stopImmediatePropagation(); }
    } else if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); hide(); }
  }, { capture: true });

  return { insert, hide, get open() { return !list.hidden; } };
}
