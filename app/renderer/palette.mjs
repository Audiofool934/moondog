// Slash commands in the composer: typing "/" lists what Moondog can do here, filtered as you type.
// Each row names what the command opens, with the command beside it. Up and Down choose, Enter or
// Tab runs, Esc closes. A command with words after it, such as /remember, runs with them on Enter.
import { make } from "./ui.mjs";

export function createPalette({ input, anchor, t, commands }) {
  const list = make("div", "palette");
  list.setAttribute("role", "listbox");
  list.id = "palette";
  list.hidden = true;
  anchor.append(list);
  let matches = [];
  let index = 0;
  // A pointer parked over the list does not steal the choice until it actually moves.
  let pointerMoved = false;

  const query = () => {
    const value = input.value;
    if (!value.startsWith("/") || value.includes("\n")) return null;
    const [name, ...rest] = value.slice(1).split(/\s+/u);
    return { name: name.toLowerCase(), rest: rest.join(" ").trim(), hasSpace: /\s/u.test(value) };
  };
  function render() {
    const tr = t();
    const found = query();
    // Once a full command name has a space after it, the list steps aside for its words.
    if (!found || (found.hasSpace && commands().some((command) => command.name === found.name))) return hide();
    // A command whose name starts with what was typed wins; its label is searched only when no name matches.
    const named = commands().filter((command) => command.name.startsWith(found.name));
    matches = named.length ? named : commands().filter((command) => tr(command.label).toLowerCase().includes(found.name));
    if (!matches.length) return hide();
    index = Math.min(index, matches.length - 1);
    list.replaceChildren(...matches.map((command, position) => {
      const item = make("div", `palette-item${position === index ? " on" : ""}`);
      item.id = `palette-${command.name}`;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(position === index));
      // The command leads; its name in the window's language follows only where it says more, as "Shortcuts" does for /help.
      const label = tr(command.label);
      item.append(make("span", "palette-command", `/${command.name}${command.argument ? ` ${tr(command.argument)}` : ""}`));
      if (label.toLowerCase().replace(/\s+/gu, "") !== command.name) item.append(make("span", "palette-name", label));
      item.addEventListener("pointermove", () => {
        if (!pointerMoved || index === position) { pointerMoved = true; return; }
        index = position;
        mark();
      });
      item.addEventListener("mousedown", (event) => { event.preventDefault(); index = position; run(); });
      return item;
    }));
    if (list.hidden) pointerMoved = false;
    list.hidden = false;
    input.setAttribute("aria-controls", "palette");
    input.setAttribute("aria-activedescendant", list.children[index]?.id ?? "");
  }
  function mark() {
    [...list.children].forEach((item, position) => {
      item.classList.toggle("on", position === index);
      item.setAttribute("aria-selected", String(position === index));
    });
    list.children[index]?.scrollIntoView({ block: "nearest" });
    input.setAttribute("aria-activedescendant", list.children[index]?.id ?? "");
  }
  function hide() {
    list.hidden = true;
    matches = [];
    index = 0;
    input.removeAttribute("aria-activedescendant");
  }
  function run() {
    const found = query();
    const command = matches[index] ?? commands().find((entry) => entry.name === found?.name);
    if (!command) return false;
    if (command.argument && !(found?.name === command.name && found.rest)) {
      // Fill in the name and wait for the words that go with it.
      input.value = `/${command.name} `;
      input.dispatchEvent(new Event("input"));
      hide();
      return true;
    }
    input.value = "";
    input.dispatchEvent(new Event("input"));
    hide();
    command.run(found?.name === command.name ? found.rest : "");
    return true;
  }

  input.addEventListener("input", () => { index = 0; render(); });
  input.addEventListener("blur", () => setTimeout(hide, 120));
  // Runs before the composer's own key handler, so Enter picks a command instead of sending.
  input.addEventListener("keydown", (event) => {
    const found = query();
    const exact = found && commands().some((command) => command.name === found.name);
    if (list.hidden && !(event.key === "Enter" && exact && !event.shiftKey && !event.isComposing)) return;
    if (event.key === "ArrowDown") { event.preventDefault(); index = (index + 1) % matches.length; mark(); }
    else if (event.key === "ArrowUp") { event.preventDefault(); index = (index - 1 + matches.length) % matches.length; mark(); }
    else if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey && !event.isComposing) {
      if (run()) { event.preventDefault(); event.stopImmediatePropagation(); }
    } else if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); hide(); }
  }, { capture: true });

  return { hide, refresh() { if (!list.hidden) render(); }, get open() { return !list.hidden; } };
}
