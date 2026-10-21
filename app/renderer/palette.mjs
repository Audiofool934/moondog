// Slash commands in the composer: typing "/" lists what Moondog can do here, filtered as you type.
// Up and Down choose, Enter or Tab runs, Esc closes. A command with words after it, such as
// /remember, runs with them when you press Enter.
const make = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

export function createPalette({ input, anchor, t, commands }) {
  const list = make("div", "palette");
  list.setAttribute("role", "listbox");
  list.hidden = true;
  anchor.append(list);
  let matches = [];
  let index = 0;

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
    matches = commands().filter((command) => command.name.startsWith(found.name) || tr(command.description).toLowerCase().includes(found.name));
    if (!matches.length) return hide();
    index = Math.min(index, matches.length - 1);
    list.replaceChildren(...matches.map((command, position) => {
      const item = make("div", `palette-item${position === index ? " on" : ""}`);
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(position === index));
      item.append(make("span", "palette-name", `/${command.name}${command.argument ? ` ${tr(command.argument)}` : ""}`), make("span", "palette-what", tr(command.description)));
      item.addEventListener("mousedown", (event) => { event.preventDefault(); index = position; run(); });
      return item;
    }));
    list.hidden = false;
  }
  function hide() {
    list.hidden = true;
    matches = [];
    index = 0;
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
    if (event.key === "ArrowDown") { event.preventDefault(); index = (index + 1) % matches.length; render(); }
    else if (event.key === "ArrowUp") { event.preventDefault(); index = (index - 1 + matches.length) % matches.length; render(); }
    else if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey && !event.isComposing) {
      if (run()) { event.preventDefault(); event.stopImmediatePropagation(); }
    } else if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); hide(); }
  }, { capture: true });

  return { hide, get open() { return !list.hidden; } };
}
