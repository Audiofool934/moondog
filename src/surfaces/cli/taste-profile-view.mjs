import { stripVTControlCharacters } from "node:util";
import {
  Input,
  getKeybindings,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

import { sanitizeTerminalText } from "./format-output.mjs";

const categories = [
  { id: "all", label: "All" },
  { id: "track", label: "Tracks" },
  { id: "artist", label: "Artists" },
  { id: "choices", label: "Your choices" },
];

function clean(value) {
  return sanitizeTerminalText(stripVTControlCharacters(String(value ?? ""))).replaceAll("\t", "    ");
}

function inline(value) { return clean(value).replace(/\s+/gu, " ").trim(); }

function fit(value, width) {
  const clipped = truncateToWidth(value, Math.max(1, width), "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function paint(value, width, theme) {
  const line = fit(value, width);
  // Only remove SGR styling in plain mode; Pi's cursor marker positions the IME.
  return theme.plain ? line.replace(/\u001b\[[\d;:]*m/g, "") : theme.background(theme.text(line));
}

function ends(left, right, width) {
  const tailWidth = visibleWidth(right);
  if (tailWidth + 3 >= width) return truncateToWidth(left, width, "");
  const head = truncateToWidth(left, width - tailWidth - 2, "");
  return head + " ".repeat(width - visibleWidth(head) - tailWidth) + right;
}

function stanceLabel(subject) {
  return subject?.stance === "like" ? "You like this" : subject?.stance === "avoid" ? "You asked me to keep this out" : "";
}

/** A terminal-native, searchable profile with a live reading beside its subjects. */
export class TasteProfileView {
  constructor({ model, getTheme, getRows }) {
    this.getTheme = getTheme;
    this.getRows = getRows;
    this.input = new Input();
    this.category = "all";
    this.query = "";
    this.selectedKey = undefined;
    this.detailOffset = 0;
    this.detailPageSize = 1;
    this.detailMaxOffset = 0;
    this.pasteActive = false;
    this.pasteTail = "";
    this.onSelect = undefined;
    this.onClose = undefined;
    this.onRefresh = undefined;
    this.onReport = undefined;
    this.setModel(model);
  }

  get focused() { return this.input.focused; }
  set focused(value) { this.input.focused = value; }

  invalidate() { this.input.invalidate(); }

  setModel(model) {
    this.model = model ?? {};
    const subjects = Array.isArray(this.model.subjects) ? this.model.subjects : [];
    this.entries = subjects.filter((subject) => subject && typeof subject === "object").map((subject) => ({
      subject,
      search: [subject.label, subject.subtitle, subject.kind, stanceLabel(subject), ...(subject.detailLines ?? [])]
        .map(inline).join(" ").toLowerCase(),
    }));
    this.filterSubjects();
  }

  filterSubjects() {
    const tokens = inline(this.query).toLowerCase().split(/\s+/u).filter(Boolean);
    this.filtered = this.entries.filter(({ subject, search }) => {
      const categoryMatches = this.category === "all" || this.category === subject.kind ||
        (this.category === "choices" && ["like", "avoid"].includes(subject.stance));
      return categoryMatches && tokens.every((token) => search.includes(token));
    }).map(({ subject }) => subject);
    if (!this.filtered.some((subject) => subject.key === this.selectedKey)) {
      this.selectedKey = this.filtered[0]?.key;
      this.detailOffset = 0;
    }
  }

  getSelectedItem() {
    return this.filtered.find((subject) => subject.key === this.selectedKey) ?? null;
  }

  updateInput(data) {
    const previous = this.input.getValue();
    this.input.handleInput(data);
    if (previous !== this.input.getValue()) {
      this.query = this.input.getValue();
      this.filterSubjects();
    }
  }

  handleInput(data) {
    if (data.includes("\x1b[200~")) this.pasteActive = true;
    if (this.pasteActive) {
      this.updateInput(data);
      const paste = this.pasteTail + data;
      this.pasteActive = !paste.includes("\x1b[201~");
      this.pasteTail = this.pasteActive ? paste.slice(-5) : "";
      return;
    }
    const keys = getKeybindings();
    if (keys.matches(data, "tui.select.cancel")) { this.onClose?.(); return; }
    if (matchesKey(data, "ctrl+r")) { this.onRefresh?.(); return; }
    if (matchesKey(data, "ctrl+o")) { this.onReport?.(); return; }
    if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
      const index = categories.findIndex((category) => category.id === this.category);
      this.category = categories[(index + (matchesKey(data, "shift+tab") ? -1 : 1) + categories.length) % categories.length].id;
      this.filterSubjects();
      this.detailOffset = 0;
      return;
    }
    if (keys.matches(data, "tui.select.up") || keys.matches(data, "tui.select.down")) {
      if (this.filtered.length) {
        const index = this.filtered.findIndex((subject) => subject.key === this.selectedKey);
        this.selectedKey = this.filtered[(index + (keys.matches(data, "tui.select.up") ? -1 : 1) + this.filtered.length) % this.filtered.length].key;
        this.detailOffset = 0;
      }
      return;
    }
    if (keys.matches(data, "tui.select.confirm")) {
      const selected = this.getSelectedItem();
      if (selected) this.onSelect?.(selected);
      return;
    }
    if (keys.matches(data, "tui.select.pageUp") || keys.matches(data, "tui.select.pageDown")) {
      const direction = keys.matches(data, "tui.select.pageUp") ? -1 : 1;
      this.detailOffset = Math.max(0, Math.min(this.detailMaxOffset, this.detailOffset + direction * Math.max(1, this.detailPageSize - 1)));
      return;
    }
    this.updateInput(data);
  }

  renderCategories(width, theme) {
    if (width < 34) {
      const label = categories.find((category) => category.id === this.category)?.label ?? "All";
      return theme.bold(`‹ ${label} ›`) + (width >= 24 ? theme.faint("  tab change") : "");
    }
    return categories.map(({ id, label }) => {
      const text = width < 38 && id === "choices" ? "Choices" : label;
      return id === this.category ? theme.inverse(theme.bold(` ${text} `)) : theme.muted(text);
    }).join(width >= 34 ? "  " : " ");
  }

  renderList(width, height, theme, { compact = false } = {}) {
    if (height <= 0) return [];
    const lineHeight = compact ? 1 : 2;
    const capacity = Math.max(1, Math.floor(height / lineHeight));
    const selectedIndex = this.filtered.findIndex((subject) => subject.key === this.selectedKey);
    const start = Math.max(0, Math.min(selectedIndex - Math.floor(capacity / 2), this.filtered.length - capacity));
    const lines = [];
    for (const subject of this.filtered.slice(start, start + capacity)) {
      const selected = subject.key === this.selectedKey;
      const marker = selected ? "› " : "  ";
      const label = inline(subject.label) || (subject.kind === "artist" ? "Artist" : "Track");
      const stance = subject.stance === "like" ? "+" : subject.stance === "avoid" ? "−" : "";
      const main = ends(marker + label, stance, width);
      lines.push(selected ? theme.inverse(theme.bold(fit(main, width))) : theme.text(main));
      if (!compact && lines.length < height) lines.push(theme.muted(`  ${inline(subject.subtitle) || (subject.kind === "artist" ? "Artist" : "Track")}`));
    }
    return Array.from({ length: height }, (_, index) => lines[index] ?? "");
  }

  renderDetail(width, height, theme) {
    if (height <= 0) return [];
    const subject = this.getSelectedItem();
    if (!subject) return Array(height).fill("");
    const heading = theme.bold(inline(subject.label) || "Selected");
    const subtitle = inline(subject.subtitle);
    const stance = stanceLabel(subject);
    const prefix = [heading];
    if (subtitle && height >= 4) prefix.push(theme.muted(subtitle));
    if (stance && height >= 6) prefix.push(theme.accent(stance));
    if (height >= 8) prefix.push("");
    const sourceLines = Array.isArray(subject.detailLines) && subject.detailLines.length
      ? subject.detailLines
      : ["Nothing more to show for this one yet."];
    const detail = sourceLines.flatMap((line) => wrapTextWithAnsi(clean(line), Math.max(1, width)));
    const available = Math.max(0, height - prefix.length);
    const scrolls = detail.length > available;
    const contentHeight = Math.max(0, available - (scrolls && available >= 2 ? 1 : 0));
    this.detailPageSize = Math.max(1, contentHeight);
    this.detailMaxOffset = Math.max(0, detail.length - contentHeight);
    this.detailOffset = Math.min(this.detailOffset, this.detailMaxOffset);
    const visible = detail.slice(this.detailOffset, this.detailOffset + contentHeight).map(theme.text);
    const lines = [...prefix, ...visible];
    if (scrolls && available >= 2) {
      const range = `${this.detailOffset + 1}–${Math.min(detail.length, this.detailOffset + contentHeight)}/${detail.length}`;
      lines.push(theme.faint(ends("PgUp/PgDn to scroll", range, width)));
    }
    return Array.from({ length: height }, (_, index) => lines[index] ?? "");
  }

  renderEmpty(width, height, theme) {
    this.detailOffset = 0;
    this.detailMaxOffset = 0;
    const filtered = this.entries.length > 0;
    const lines = filtered
      ? ["Nothing matches that.", "", "Try fewer words, or press Tab for another list."]
      : (Array.isArray(this.model.emptyLines) && this.model.emptyLines.length
        ? this.model.emptyLines
        : ["Nothing to look at yet.", "", "Import your history or library and it will show up here."]);
    const wrapped = lines.flatMap((line) => wrapTextWithAnsi(clean(line), width));
    return Array.from({ length: height }, (_, index) => index === 0
      ? theme.bold(wrapped[index] ?? "") : theme.muted(wrapped[index] ?? ""));
  }

  render(width) {
    const columns = Math.max(1, Math.floor(width));
    const requestedRows = Number(this.getRows());
    const height = Number.isFinite(requestedRows) ? Math.max(0, Math.floor(requestedRows)) : 0;
    if (!height) return [];
    const theme = this.getTheme();
    const inset = columns >= 8 ? 1 : 0;
    const inner = Math.max(1, columns - inset * 2);
    const position = this.filtered.findIndex((subject) => subject.key === this.selectedKey) + 1;
    const count = `${Math.max(0, position)}/${this.filtered.length}`;
    const heading = theme.bold(inner >= 24 + count.length ? "Your listening profile" : "Your profile");
    const lines = [ends(heading, theme.muted(count), inner)];
    if (height >= 10) {
      const summaries = Array.isArray(this.model.summaryLines) ? this.model.summaryLines : [];
      const maxSummary = height >= 22 ? 2 : 1;
      lines.push(...summaries.slice(0, maxSummary).map((line) => theme.muted(inline(line))));
    }
    if (height >= 5) lines.push(inner >= 76
      ? ends(this.renderCategories(inner, theme), theme.faint("Ctrl+R refresh · Ctrl+O report"), inner)
      : this.renderCategories(inner, theme));
    if (height >= 2) {
      const searchLabel = inner >= 26 ? theme.faint("Search ") : "";
      lines.push(searchLabel + this.input.render(Math.max(1, inner - visibleWidth(searchLabel)))[0]);
    }
    if (height >= 7) lines.push(theme.faint("─".repeat(inner)));
    const remaining = Math.max(0, height - lines.length);
    if (!this.filtered.length) {
      lines.push(...this.renderEmpty(inner, remaining, theme));
    } else if (columns >= 90 && remaining >= 7) {
      const leftWidth = Math.max(24, Math.floor((inner - 3) * 0.42));
      const rightWidth = Math.max(1, inner - leftWidth - 3);
      const list = this.renderList(leftWidth, remaining, theme);
      const detail = this.renderDetail(rightWidth, remaining, theme);
      for (let row = 0; row < remaining; row += 1) {
        lines.push(fit(list[row], leftWidth) + theme.faint(" │ ") + fit(detail[row], rightWidth));
      }
    } else if (remaining >= 6) {
      const listHeight = Math.max(2, Math.min(5, Math.floor(remaining * 0.32)));
      lines.push(...this.renderList(inner, listHeight, theme, { compact: true }));
      lines.push(theme.faint("─".repeat(inner)));
      lines.push(...this.renderDetail(inner, remaining - listHeight - 1, theme));
    } else {
      lines.push(...this.renderList(inner, remaining, theme, { compact: true }));
    }
    return Array.from({ length: height }, (_, index) => paint(" ".repeat(inset) + (lines[index] ?? ""), columns, theme));
  }
}
