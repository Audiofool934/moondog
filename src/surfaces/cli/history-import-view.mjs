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
    this.clientEditor = new Editor(tui, {
      borderColor: (text) => this.getTheme().faint(text), selectList,
    }, { paddingX: 1 });
    this.clientEditor.onSubmit = (text) => {
      this.clientEditor.setText(text);
      this.emit("configureSpotify", { clientId: text.trim() });
    };
  }

  get focused() { return this._focused; }
  set focused(value) {
    this._focused = Boolean(value);
    this.editor.focused = this._focused && this.state.page === "file";
    this.clientEditor.focused = this._focused && this.state.page === "client";
    if (!value) this.editor.setText(this.getPath());
  }

  invalidate() { this.editor.invalidate(); this.clientEditor.invalidate(); }
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
    this.clientEditor.focused = this._focused && next.page === "client";
  }

  emit(type, detail = {}) { this.onAction?.({ type, ...detail }); }

  pageContent() {
    const profile = this.profileReady ? [{ type: "profile", label: "View my profile" }] : [];
    const file = { type: "file", label: "Choose a file" };
    const back = { type: "back", label: "Back" };
    switch (this.state.page) {
      case "quick": {
        const status = this.state.spotify ?? {};
        const ready = status.state === "ready" && status.scopes?.granted?.includes("user-read-recently-played");
        const configured = status.client_id_configured;
        return {
          title: "Quick start with Spotify",
          paragraphs: [
            "Start a listening profile from up to 50 recent plays.",
            "Preview before saving. No model or history download needed.",
            "Older listening can be added later with a history ZIP.",
            ready ? "Spotify is connected. Read your recent listening when you are ready."
              : configured ? "Connect Spotify to allow reading your recent listening."
                : "Spotify connection needs one-time app setup on this installation. You can also start with a downloaded ZIP.",
          ],
          actions: [
            { type: ready ? "recent" : configured ? "connectSpotify" : "setup", label: ready ? "Preview recent listening" : configured ? "Connect Spotify" : "Set up Spotify connection" },
            ...(ready ? [{ type: "connectSpotify", label: "Reconnect Spotify" }] : []),
            { type: "spotify", label: "Add past listening history" }, back,
          ],
        };
      }
      case "setup": return {
        title: "Set up Spotify connection",
        paragraphs: [
          "This release uses your own Spotify developer app.",
          "In Spotify Dashboard, create an app with Web API enabled.",
          "Add redirect URI: http://127.0.0.1:43821/callback",
          "Copy the Client ID from its settings. No client secret is needed.",
          "Development apps require Premium for the app owner and allow up to 5 listed users. Add your listener under User Management if needed.",
        ],
        actions: [
          { type: "openSpotifySetup", label: "Open Spotify Dashboard" },
          { type: "client", label: "Enter my Client ID" },
          { type: "spotify", label: "Use a history ZIP instead" }, back,
        ],
      };
      case "empty": return {
        title: "No recent listening returned",
        paragraphs: [
          "Spotify returned no recent tracks. Nothing was imported.",
          "Listen in Spotify, then try again, or add an existing history ZIP.",
          "An empty recent snapshot does not mean your account has no listening history.",
        ],
        actions: [{ type: "recent", label: "Try recent listening again" }, { type: "spotify", label: "Add past listening history" }, back],
      };
      case "spotify": return {
        title: "Add past listening history",
        paragraphs: [
          "Already have a Spotify ZIP? Choose it below, without extracting it.",
          "To request one: account privacy > Download your data.",
          "Extended Streaming History covers years of listening. Account Data includes past-year history and library evidence.",
          "Complete Spotify's confirmation steps and wait for its download email. Extended history can take around 30 days.",
          "No Spotify developer app or Moondog connection is needed for file import.",
        ],
        actions: [
          { type: "file", label: "Choose my Spotify ZIP" },
          { type: "openSpotify", label: "Open Spotify privacy" },
          { type: "waiting", label: "I'm waiting for my download" }, back,
        ],
      };
      case "waiting": return {
        title: "Come back with your download",
        paragraphs: [
          "When the file is ready, return to /import > Add past listening history.",
          this.profileReady ? "Your existing profile is still ready to explore." : "You can keep exploring music while you wait.",
          "Connecting Spotify enables live features; it does not reconstruct your full listening history.",
        ],
        actions: [{ type: "quick", label: "Quick start while I wait" }, file, ...profile, back],
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
        const recent = this.state.origin === "quick";
        const first = day(preview.earliestListeningAt);
        const last = day(preview.latestListeningAt);
        return {
          title: recent ? "Review recent listening" : "Review this import",
          notice: "Nothing added yet.",
          paragraphs: [
            clean(preview.sourceLabel) || "Listening history",
            clean(preview.fileName),
            `${count(preview.listeningEvents)} plays · ${count(preview.tracks)} tracks`,
            first && last ? `${first} to ${last}` : "Listening dates not included.",
            recent
              ? "Listening time is not supplied by Spotify."
              : `Actual played duration: ${count(preview.eventsWithPlayedMs)} of ${count(preview.listeningEvents)} records`,
            ...(preview.profileEvidence > 0 ? [`Other music observations: ${count(preview.profileEvidence)}`] : []),
            clean(preview.scopeNote),
          ].filter(Boolean),
          actions: [
            { type: "commit", label: "Import into my profile" },
            recent ? { type: "recent", label: "Refresh recent listening" } : { type: "file", label: "Choose another file" }, back,
          ],
        };
      }
      default: return {
        title: "Import from Spotify",
        paragraphs: [
          "Quick start: connect Spotify and preview recent listening.",
          "Past history: bring a downloaded ZIP for a deeper picture.",
          this.profileReady ? "Both paths add to your existing profile and keep your choices." : "Start with what is available. Add more history whenever you are ready.",
        ],
        actions: [{ type: "quick", label: "Quick start" }, { type: "spotify", label: "Add past listening history" }, { type: "other", label: "Other sources" }, ...profile],
      };
    }
  }

  handleInput(data) {
    if (this.state.page === "working") return;
    if (data.includes("\x1b[200~")) this.pasteActive = true;
    if (this.pasteActive) {
      if (this.state.page === "file") this.editor.handleInput(data);
      if (this.state.page === "client") this.clientEditor.handleInput(data);
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
    if (this.state.page === "client") {
      this.clientEditor.handleInput(data);
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
    const client = this.state.page === "client";
    const input = client ? this.clientEditor : this.editor;
    const error = clean(this.state.error?.message ?? this.state.error);
    const errorLines = error ? wrapTextWithAnsi(error, width).slice(0, Math.min(3, Math.max(1, height - 6))).map(theme.error) : [];
    const header = client
      ? [theme.bold("Enter your Spotify Client ID"), theme.muted("From your app settings. No client secret."), theme.text("Client ID")]
      : [theme.bold("Choose your history file"), theme.muted("Spotify ZIP or ListenBrainz JSON"), theme.text("File path")];
    const hint = client ? theme.muted("Enter save · Esc back") : theme.muted(width >= 64 ? "Paste or drag one path · Tab completes · Enter inspect · Esc back"
      : width >= 38 ? "Paste/drag · Tab path · ↵ inspect · Esc" : "Tab path · ↵ inspect · Esc");
    const budget = Math.max(1, height - header.length - errorLines.length - 1);
    input.setAutocompleteMaxVisible(Math.max(1, Math.min(4, budget - 8)));
    let editor = input.render(width);
    if (editor.length > budget) {
      const tailSize = input.isShowingAutocomplete()
        ? Math.min(input.getAutocompleteMaxVisible() + 1, Math.max(0, budget - 1)) : 0;
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
    if (["file", "client"].includes(this.state.page)) {
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
