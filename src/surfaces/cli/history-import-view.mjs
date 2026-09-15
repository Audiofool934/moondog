import { stripVTControlCharacters } from "node:util";
import {
  CombinedAutocompleteProvider,
  CURSOR_MARKER,
  Editor,
  getKeybindings,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

import { sanitizeTerminalText } from "./format-output.mjs";

function clean(value) {
  return sanitizeTerminalText(stripVTControlCharacters(String(value ?? "")))
    .replace(/\s+/gu, " ").trim();
}

function fit(value, width) {
  const clipped = truncateToWidth(value, width, "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function paint(value, width, theme) {
  const line = fit(value, width);
  // Keep Pi's zero-width hardware cursor marker in NO_COLOR terminals.
  return theme.plain ? line.replace(/\u001b\[[\d;:]*m/g, "") : theme.background(theme.text(line));
}

function safeEditorLine(value) {
  // Preserve Pi's styling and cursor protocol, but remove controls from paths.
  return value.split(CURSOR_MARKER).map((part) => part.split(/(\u001b\[[\d;:]*m)/gu)
    .map((segment) => /^\u001b\[[\d;:]*m$/u.test(segment) ? segment
      : sanitizeTerminalText(stripVTControlCharacters(segment)).replace(/[\r\n\t]/gu, " "))
    .join("")).join(CURSOR_MARKER);
}

function count(value) {
  return Number.isFinite(value) && value >= 0 ? value.toLocaleString("en-US") : "Unknown";
}

function day(value) {
  if (value === undefined || value === null || value === "") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

/** Acquisition guidance and file review; all effects belong to the host. */
export class HistoryImportView {
  constructor({ tui, getTheme, getRows, profileReady = false, onAction }) {
    this.getTheme = getTheme;
    this.getRows = getRows;
    this.profileReady = profileReady;
    this.onAction = onAction;
    this.state = { page: "start" };
    this.selected = 0;
    this.contentOffset = 0;
    this.contentPageSize = 1;
    this.contentMaxOffset = 0;
    this.pasteActive = false;
    this.pasteTail = "";
    this._focused = false;
    const selectList = Object.fromEntries(
      ["selectedPrefix", "selectedText", "description", "scrollInfo", "noMatch"]
        .map((key) => [key, (text) => this.getTheme().selectListTheme[key](text)]),
    );
    this.editor = new Editor(tui, {
      borderColor: (text) => this.getTheme().faint(text), selectList,
    }, { paddingX: 1, autocompleteMaxVisible: 3 });
    const completion = new CombinedAutocompleteProvider([], process.cwd(), null);
    // This editor contains one path, so absolute paths are not slash commands.
    // A temporary quote also lets Pi complete a literal path containing spaces.
    const quotedInput = (lines, line, column) => {
      const quoted = !String(lines[line] ?? "").startsWith('"');
      const input = [...lines];
      if (quoted) input[line] = `"${input[line] ?? ""}`;
      return { lines: input, column: column + Number(quoted), quoted };
    };
    this.editor.setAutocompleteProvider({
      async getSuggestions(lines, line, column, options) {
        const input = quotedInput(lines, line, column);
        const result = await completion.getSuggestions(input.lines, line, input.column, { ...options, force: true });
        return result && { ...result, prefix: input.quoted ? result.prefix.slice(1) : result.prefix };
      },
      applyCompletion(lines, line, column, item, prefix) {
        const input = quotedInput(lines, line, column);
        return completion.applyCompletion(input.lines, line, input.column, item, input.quoted ? `"${prefix}` : prefix);
      },
    });
    // Pi clears its editor on submit, including after accepting some completions.
    this.editor.onSubmit = (text) => {
      this.editor.setText(text);
      this.emit("inspect", { path: this.getPath() });
    };
  }

  get focused() { return this._focused; }
  set focused(value) {
    this._focused = Boolean(value);
    this.editor.focused = this._focused && this.state.page === "file";
    if (!value) this.editor.setText(this.getPath());
  }

  invalidate() { this.editor.invalidate(); }
  getPath() { return this.editor.getExpandedText(); }
  setPath(value) { this.editor.setText(String(value ?? "")); }

  setState(state) {
    const next = { page: "start", ...state };
    if (next.page !== this.state.page) {
      this.selected = 0;
      this.contentOffset = 0;
      this.pasteActive = false;
      this.pasteTail = "";
      this.editor.setText(this.getPath());
    }
    this.state = next;
    if (typeof state?.profileReady === "boolean") this.profileReady = state.profileReady;
    this.editor.focused = this._focused && next.page === "file";
  }

  emit(type, detail = {}) { this.onAction?.({ type, ...detail }); }

  pageContent() {
    const profile = this.profileReady ? [{ type: "profile", label: "View my profile" }] : [];
    const file = { type: "file", label: "Choose a file" };
    const back = { type: "back", label: "Back" };
    switch (this.state.page) {
      case "spotify": return {
        title: "Get your Spotify history",
        paragraphs: [
          "Open account privacy > Download your data.",
          "Extended history is best for years of listening.",
          "Account Data also works: past-year history and library evidence.",
          "Download the ZIP when Spotify says it is ready.",
        ],
        actions: [
          { type: "openSpotify", label: "Open Spotify privacy" },
          { type: "file", label: "I have the download" },
          { type: "waiting", label: "I'm waiting for my download" }, back,
        ],
      };
      case "waiting": return {
        title: "Come back with your download",
        paragraphs: [
          "When the file is ready, return to /import and choose it.",
          this.profileReady ? "Your existing profile is still ready to explore." : "You can keep exploring music while you wait.",
          "Connecting Spotify enables live features; it does not reconstruct your full listening history.",
        ],
        actions: [file, ...profile, back],
      };
      case "other": return {
        title: "Other listening sources",
        paragraphs: [
          "ListenBrainz: choose saved official GET-listens JSON or single/import JSON.",
          "Apple Music library XML uses the separate Apple importer. It is a library snapshot, not streaming history.",
        ],
        actions: [file, { type: "openAppleHelp", label: "How to export Apple XML" }, back],
      };
      case "preview": {
        const preview = this.state.preview ?? {};
        const first = day(preview.earliestListeningAt);
        const last = day(preview.latestListeningAt);
        return {
          title: "Review this import",
          notice: "Nothing added yet.",
          paragraphs: [
            clean(preview.sourceLabel) || "Listening history",
            clean(preview.fileName),
            `${count(preview.listeningEvents)} plays · ${count(preview.tracks)} tracks`,
            first && last ? `${first} to ${last}` : "Listening dates not included.",
            `Actual played duration: ${count(preview.eventsWithPlayedMs)} of ${count(preview.listeningEvents)} records`,
            ...(preview.profileEvidence > 0 ? [`Other music observations: ${count(preview.profileEvidence)}`] : []),
            clean(preview.scopeNote),
          ].filter(Boolean),
          actions: [
            { type: "commit", label: "Import into my profile" },
            { type: "file", label: "Choose another file" }, back,
          ],
        };
      }
      default: return {
        title: this.profileReady ? "Add listening history" : "Bring your listening history",
        paragraphs: [
          "Choose a Spotify ZIP or saved ListenBrainz JSON.",
          this.profileReady ? "Add a newer file to update your listening profile." : "See your listening patterns, then refine your profile.",
          "Need a download first? Start with Spotify history.",
        ],
        actions: [file, { type: "spotify", label: "Get Spotify history" }, { type: "other", label: "Other sources" }, ...profile],
      };
    }
  }

  handleInput(data) {
    if (this.state.page === "working") return;
    if (data.includes("\x1b[200~")) this.pasteActive = true;
    if (this.pasteActive) {
      if (this.state.page === "file") this.editor.handleInput(data);
      const paste = this.pasteTail + data;
      this.pasteActive = !paste.includes("\x1b[201~");
      this.pasteTail = this.pasteActive ? paste.slice(-5) : "";
      return;
    }
    const keys = getKeybindings();
    if (keys.matches(data, "tui.select.cancel")) {
      this.emit(this.state.page === "start" ? "close" : "back");
      return;
    }
    if (this.state.page === "file") {
      if (keys.matches(data, "tui.input.submit") && !this.editor.isShowingAutocomplete()) {
        this.emit("inspect", { path: this.getPath() });
      } else this.editor.handleInput(data);
      return;
    }
    const { actions } = this.pageContent();
    if (keys.matches(data, "tui.select.up") || keys.matches(data, "tui.select.down")) {
      this.selected = (this.selected + (keys.matches(data, "tui.select.up") ? -1 : 1) + actions.length) % actions.length;
    } else if (keys.matches(data, "tui.select.confirm")) {
      this.emit(actions[this.selected]?.type ?? actions[0].type);
    } else if (keys.matches(data, "tui.select.pageUp") || keys.matches(data, "tui.select.pageDown")) {
      const direction = keys.matches(data, "tui.select.pageUp") ? -1 : 1;
      this.contentOffset = Math.max(0, Math.min(this.contentMaxOffset,
        this.contentOffset + direction * Math.max(1, this.contentPageSize - 1)));
    }
  }

  renderFile(width, height, theme) {
    const error = clean(this.state.error?.message ?? this.state.error);
    const errorLines = error ? wrapTextWithAnsi(error, width).slice(0, Math.min(3, Math.max(1, height - 6))).map(theme.error) : [];
    const header = [theme.bold("Choose your history file"), theme.muted("Spotify ZIP or ListenBrainz JSON"), theme.text("File path")];
    const hint = theme.muted(width >= 64 ? "Paste or drag one path · Tab completes · Enter inspect · Esc back"
      : width >= 38 ? "Paste/drag · Tab path · ↵ inspect · Esc" : "Tab path · ↵ inspect · Esc");
    const budget = Math.max(1, height - header.length - errorLines.length - 1);
    this.editor.setAutocompleteMaxVisible(Math.max(1, Math.min(4, budget - 8)));
    let editor = this.editor.render(width);
    if (editor.length > budget) {
      const tailSize = this.editor.isShowingAutocomplete()
        ? Math.min(this.editor.getAutocompleteMaxVisible() + 1, Math.max(0, budget - 1)) : 0;
      const tail = tailSize ? editor.slice(-tailSize) : [];
      const core = tailSize ? editor.slice(0, -tailSize) : editor;
      const available = budget - tail.length;
      const cursor = core.findIndex((line) => line.includes(CURSOR_MARKER));
      const start = Math.max(0, Math.min(core.length - available, cursor - available + 1));
      editor = [...core.slice(start, start + available), ...tail];
    }
    return [...header, ...editor.map(safeEditorLine), ...errorLines, hint];
  }

  render(width) {
    const columns = Math.max(1, Math.floor(width));
    const requestedRows = Number(this.getRows());
    const height = Number.isFinite(requestedRows) ? Math.max(0, Math.floor(requestedRows)) : 0;
    if (!height) return [];
    const inset = columns >= 8 ? 1 : 0;
    const inner = Math.max(1, columns - inset * 2);
    const theme = this.getTheme();
    let lines;
    if (this.state.page === "file") {
      lines = this.renderFile(inner, height, theme);
    } else if (this.state.page === "working") {
      const message = clean(this.state.message) || "Working on your history file…";
      lines = [theme.bold("Your listening history"), "", ...wrapTextWithAnsi(message, inner).map(theme.text)];
      if (height >= 5) lines.push("", theme.muted("Finishing the current step."));
    } else {
      const page = this.pageContent();
      const spacious = height >= 17;
      const header = [theme.bold(page.title), ...(page.notice ? [theme.accent(page.notice)] : []), ...(spacious ? [""] : [])];
      const error = clean(this.state.error?.message ?? this.state.error);
      const message = clean(this.state.message);
      const paragraphs = [
        ...(error ? wrapTextWithAnsi(error, inner).map(theme.error) : []),
        ...(message ? wrapTextWithAnsi(message, inner).map(theme.accent) : []),
        ...page.paragraphs.flatMap((text) => wrapTextWithAnsi(clean(text), inner).map(theme.muted)),
      ];
      const capacity = Math.max(0, height - header.length - page.actions.length - 1 - (spacious ? 1 : 0));
      this.contentPageSize = Math.max(1, capacity);
      this.contentMaxOffset = Math.max(0, paragraphs.length - capacity);
      this.contentOffset = Math.min(this.contentOffset, this.contentMaxOffset);
      this.selected = Math.min(this.selected, page.actions.length - 1);
      const actions = page.actions.map(({ label }, index) => {
        const selected = index === this.selected;
        const text = fit((selected ? "› " : "  ") + label, inner);
        return selected ? theme.inverse(theme.bold(text)) : theme.text(text);
      });
      const hint = this.contentMaxOffset > 0
        ? inner >= 36 ? "↑↓ ↵ choose · PgUp/Dn read · Esc back" : "↑↓ ↵ · PgUp/Dn read · Esc"
        : inner >= 34 ? "↑↓ choose · Enter select · Esc back" : "↑↓ choose · ↵ select · Esc";
      lines = [...header, ...paragraphs.slice(this.contentOffset, this.contentOffset + capacity),
        ...(spacious ? [""] : []), ...actions, theme.faint(hint)];
    }
    return Array.from({ length: height }, (_, row) => paint(" ".repeat(inset) + (lines[row] ?? ""), columns, theme));
  }
}
