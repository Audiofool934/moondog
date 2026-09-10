import {
  Input,
  SelectList,
  getKeybindings,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

function paintLine(value, width, theme) {
  const clipped = truncateToWidth(value, width, "");
  const padded = clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
  // Retain Pi's zero-width cursor marker, including in NO_COLOR terminals.
  if (theme.plain) return padded.replace(/\u001b\[[\d;:]*m/g, "");
  return theme.background(theme.text(padded));
}

/** A searchable Pi menu that keeps its own contents inside the viewport. */
export class ListeningMenu {
  constructor({ items, title, getTheme, getRows, currentValue }) {
    this.items = items;
    this.title = title;
    this.getTheme = getTheme;
    this.getRows = getRows;
    this.currentValue = currentValue;
    this.input = new Input();
    this.query = "";
    this.pasteActive = false;
    this.pasteTail = "";
    this.capacity = 1;
    this.filteredItems = items;
    this.select = null;
    this.onSelect = undefined;
    this.onCancel = undefined;
    this.rebuildList();
  }

  get focused() { return this.input.focused; }
  set focused(value) { this.input.focused = value; }

  invalidate() {
    this.input.invalidate();
    this.select.invalidate();
  }

  getSelectedItem() { return this.select.getSelectedItem(); }

  rebuildList() {
    const previousValue = this.select?.getSelectedItem()?.value ?? this.currentValue;
    const tokens = this.query.toLowerCase().trim().split(/\s+/u).filter(Boolean);
    this.filteredItems = this.items.filter((item) => {
      const searchable = [item.value, item.label, item.description].filter(Boolean).join(" ").toLowerCase();
      return tokens.every((token) => searchable.includes(token));
    });
    const theme = Object.fromEntries(
      ["selectedPrefix", "selectedText", "description", "scrollInfo", "noMatch"].map(
        (key) => [key, (text) => this.getTheme().selectListTheme[key](text)],
      ),
    );
    this.select = new SelectList(this.filteredItems, this.capacity, theme, {
      minPrimaryColumnWidth: 16,
      maxPrimaryColumnWidth: 34,
    });
    const previousIndex = this.filteredItems.findIndex((item) => item.value === previousValue);
    if (previousIndex >= 0) this.select.setSelectedIndex(previousIndex);
    this.select.onSelect = (item) => this.onSelect?.(item);
    this.select.onCancel = () => this.onCancel?.();
  }

  handleInput(data) {
    if (data.includes("\x1b[200~")) this.pasteActive = true;
    if (this.pasteActive) {
      // A paste chunk containing only Enter must remain text, never select an item.
      this.updateInput(data);
      const paste = this.pasteTail + data;
      this.pasteActive = !paste.includes("\x1b[201~");
      this.pasteTail = this.pasteActive ? paste.slice(-5) : "";
      return;
    }
    const keys = getKeybindings();
    if (keys.matches(data, "tui.select.cancel")) {
      this.onCancel?.();
      return;
    }
    if (
      keys.matches(data, "tui.select.up") ||
      keys.matches(data, "tui.select.down") ||
      keys.matches(data, "tui.select.confirm")
    ) {
      // Pi's selection arrows assume at least one item.
      if (this.filteredItems.length) this.select.handleInput(data);
      return;
    }
    this.updateInput(data);
  }

  updateInput(data) {
    const before = this.input.getValue();
    this.input.handleInput(data);
    if (before !== this.input.getValue()) {
      this.query = this.input.getValue();
      this.rebuildList();
    }
  }

  render(width) {
    const columns = Math.max(1, Math.floor(width));
    const theme = this.getTheme();
    const rows = Number(this.getRows());
    const budget = Math.max(1, Math.min(18, Math.floor(Number.isFinite(rows) ? rows : 24) - 2));
    const boxed = budget >= 5 && columns >= 8;
    const compactBox = boxed && budget === 5;
    const inset = boxed ? 2 : columns >= 8 ? 1 : 0;
    const inner = Math.max(1, columns - inset * 2);
    const separator = boxed ? budget >= 8 : budget >= 7;
    const chromeRows = boxed ? (compactBox ? 4 : 5) : 3;
    const capacity = Math.max(1, budget - chromeRows - (separator ? 1 : 0));
    if (capacity !== this.capacity) {
      this.capacity = capacity;
      this.rebuildList();
    }
    const selected = this.getSelectedItem();
    const position = selected ? this.filteredItems.indexOf(selected) + 1 : 0;
    const count = `${position}/${this.filteredItems.length}`;
    const titleWidth = Math.max(1, inner - visibleWidth(count) - 2);
    const title = theme.bold(truncateToWidth(this.title, titleWidth, ""));
    const heading = title + " ".repeat(Math.max(1, inner - visibleWidth(title) - count.length)) + theme.muted(count);
    const search = this.input.render(inner)[0];
    const hint = theme.muted(inner >= 55
      ? "type to filter  ↑↓ choose  enter select  esc back"
      : inner >= 29 ? "↑↓ choose  enter ↵  esc back" : "↑↓  ↵  esc");
    let lines;
    if (budget < 4) {
      // An exceptionally short terminal has no room for separate chrome rows.
      const compactTitle = budget === 1
        ? theme.bold(truncateToWidth(this.title, Math.max(1, Math.min(12, Math.floor(inner / 4))), "")) + " "
        : "";
      const compactHint = " ↵ esc";
      const compactSearch = this.input.render(Math.max(1, inner - visibleWidth(compactTitle) - visibleWidth(compactHint)))[0];
      const combined = compactTitle + compactSearch + theme.muted(compactHint);
      lines = budget === 1 ? [combined]
        : budget === 2 ? [heading, combined]
          : [heading, search, hint];
    } else {
      // The title owns the item count; omit SelectList's additional scroll-info row.
      const candidates = this.filteredItems.length
        ? this.select.render(inner).slice(0, this.capacity)
        : [theme.muted("No matches. Backspace to broaden.")];
      let labels = [heading, search];
      if (compactBox) {
        const labelWidth = Math.max(1, Math.floor(inner / 2));
        const compactTitle = theme.bold(truncateToWidth(this.title, Math.max(1, labelWidth - count.length - 1), ""));
        const label = truncateToWidth(compactTitle + " " + theme.muted(count), labelWidth, "");
        labels = [label + " ".repeat(Math.max(1, labelWidth - visibleWidth(label) + 1)) + this.input.render(Math.max(1, inner - labelWidth - 1))[0]];
      }
      lines = [...labels,
        ...(separator ? [theme.faint("─".repeat(inner))] : []),
        ...candidates, hint];
    }
    if (boxed) {
      const edge = "─".repeat(columns - 2);
      const body = lines.map((line) => {
        const clipped = truncateToWidth(line, inner, "");
        const padded = clipped + " ".repeat(Math.max(0, inner - visibleWidth(clipped)));
        return theme.faint("│") + " " + padded + " " + theme.faint("│");
      });
      return [theme.faint(`╭${edge}╮`), ...body, theme.faint(`╰${edge}╯`)]
        .map((line) => paintLine(line, columns, theme));
    }
    return lines.map((line) => paintLine(" ".repeat(inset) + line, columns, theme));
  }
}
