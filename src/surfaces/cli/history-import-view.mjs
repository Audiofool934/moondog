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
import { IMPORT_GUIDE_URLS } from "./import-guides.mjs";

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
      case "youtube_music": return {
        title: "Import from YouTube Music",
        paragraphs: ["Start with the songs in your library, then add what you've played from Google Takeout.", "Already have an export? Bring it in now. A new export takes a while to arrive, but there's nothing to set up."],
        actions: [{ type: "youtubeQuick", label: "Start with my music library" }, { type: "youtubeHistory", label: "Add past listening history" }, back],
      };
      case "youtubeQuick":
      case "youtubeHistory": return {
        title: this.state.page === "youtubeQuick" ? "YouTube Music: saved library" : "YouTube Music: past listening",
        paragraphs: [
          `Website: ${IMPORT_GUIDE_URLS.youtube}`,
          "1. In Google Takeout, deselect all products, then select YouTube and YouTube Music.",
          "2. Under included data, select music library songs and history. In format options, set history to JSON (not HTML).",
          "3. Create a one-time ZIP export with a download link. Google emails you when it is ready; save it in Downloads.",
          "4. Return here and choose the ZIP, or an extracted music-library-songs.csv or watch-history.json.",
          "Library songs show what you keep. Only YouTube Music plays count as plays; regular YouTube videos are left out. Google doesn't say how long you listened.",
          "Regular YouTube playlist CSVs and uploaded audio don't work yet. If the ZIP is over 256 MB, unzip it and bring in the music files one at a time.",
        ],
        actions: [{ type: "file", label: "Choose my Takeout file" }, { type: "openYouTube", label: "Open Google Takeout" }, back],
      };
      case "qq_music":
      case "netease": {
        const qq = this.state.page === "qq_music";
        return {
          title: `Import from ${qq ? "QQ Music / QQ 音乐" : "NetEase / 网易云音乐"}`,
          paragraphs: [
            "Quick start: open a playlist that sounds like you, choose Share > Copy link, and paste it below.",
            "Moondog reads the public song list without signing in. You'll see the playlist and its songs before anything is added.",
            "Private playlists can't be read, and some songs may be unavailable; the preview shows how many made it. A playlist shows what you keep, not what you played, and not necessarily one you made.",
            "Past listening: there's no reliable way to export your full history from this service yet, so playlists are the way in for now.",
          ],
          actions: [{ type: "file", label: "Paste a playlist share link" }, { type: qq ? "openQQ" : "openNetEase", label: "Open my music service" }, back],
        };
      }
      case "spotify": return {
        title: "Import from Spotify",
        paragraphs: [
          "Quick start: connect Spotify and bring in what you've played lately.",
          "Past history: bring in the history ZIP Spotify sends you, going back years.",
          "Either way, it all ends up in the same profile.",
        ],
        actions: [{ type: "quick", label: "Quick start" }, { type: "spotifyHistory", label: "Add past listening history" }, back],
      };
      case "apple": return {
        title: "Import from Apple Music",
        paragraphs: [
          "Quick start: export your library from Music on Mac and bring in the XML file.",
          "Past history: Apple can send you your data, but Moondog can't read that archive yet.",
        ],
        actions: [{ type: "appleQuick", label: "Quick start with library XML" }, { type: "appleHistory", label: "Past listening history guide" }, back],
      };
      case "appleQuick": return {
        title: "Quick start with Apple Music",
        paragraphs: [
          "1. In Music on Mac, choose File > Library > Export Library.",
          "2. Save Library.xml somewhere easy to find, such as Downloads.",
          "3. Choose the XML below. Preview it before adding it to your profile.",
          "Moondog reads the file on this machine, including your loves, ratings and play counts. Nothing to sign in to.",
          "A library shows what you keep and how often, but not when you played each song. Apple's privacy download is a different format.",
        ],
        actions: [{ type: "file", label: "Choose my Library.xml" }, { type: "openAppleHelp", label: "Open Apple XML export guide" }, back],
      };
      case "appleHistory": return {
        title: "Apple Music: past listening history",
        paragraphs: [
          `Website: ${IMPORT_GUIDE_URLS.applePrivacy}`,
          "1. Sign in to Apple's Data & Privacy website and choose Request a copy of your data.",
          "2. Select Apple Media Services information, which includes Apple Music activity, then complete the request.",
          "3. Apple notifies you when it is ready. Return to Data & Privacy to download the prepared files within 14 days.",
          "4. Save the download on your computer. Your browser usually uses Downloads, or asks you to choose a folder.",
          "What's included depends on your account and region. Opening the link doesn't request or import anything by itself.",
          "Moondog can't read Apple's privacy download yet. Keep it safe, and start with Library.xml for now.",
        ],
        actions: [{ type: "openApplePrivacy", label: "Open privacy.apple.com" }, { type: "appleQuick", label: "Start with library XML" }, back],
      };
      case "quick": {
        const status = this.state.spotify ?? {};
        const ready = status.state === "ready" && status.scopes?.granted?.includes("user-read-recently-played");
        const configured = status.client_id_configured;
        return {
          title: "Quick start with Spotify",
          paragraphs: [
            "Start your profile from up to 50 of your latest plays.",
            "You'll see them before anything is saved. No model or download needed.",
            "Older listening can come later with a history ZIP.",
            ready ? "Spotify is connected. Go ahead when you're ready."
              : configured ? "Connect Spotify so Moondog can read your recent plays."
                : "Connecting Spotify takes a one-time setup on this computer. Or start with a downloaded ZIP instead.",
          ],
          actions: [
            { type: ready ? "recent" : configured ? "connectSpotify" : "setup", label: ready ? "Preview recent listening" : configured ? "Connect Spotify" : "Set up Spotify connection" },
            ...(ready ? [{ type: "connectSpotify", label: "Reconnect Spotify" }] : []),
            { type: "spotifyHistory", label: "Add past listening history" }, back,
          ],
        };
      }
      case "setup": return {
        title: "Set up Spotify connection",
        paragraphs: [
          "For now, Moondog connects through a Spotify app you create yourself. It takes a few minutes.",
          "In the Spotify Dashboard, create an app with Web API turned on.",
          "Add redirect URI: http://127.0.0.1:43821/callback",
          "Copy the Client ID from the app's settings. You don't need the client secret.",
          "The app owner needs Premium, and up to 5 people can use it. If you're not the owner, get added under User Management.",
        ],
        actions: [
          { type: "openSpotifySetup", label: "Open Spotify Dashboard" },
          { type: "client", label: "Enter my Client ID" },
          { type: "spotifyHistory", label: "Use a history ZIP instead" }, back,
        ],
      };
      case "empty": return {
        title: "Silence from Spotify",
        paragraphs: [
          "Spotify didn't return any recent plays, so nothing was imported.",
          "Play something in Spotify and try again, or bring a history ZIP.",
          "This only covers the last few plays. Your full history is still there.",
        ],
        actions: [{ type: "recent", label: "Try recent listening again" }, { type: "spotifyHistory", label: "Add past listening history" }, back],
      };
      case "spotifyHistory": return {
        title: "Spotify: past listening history",
        paragraphs: [
          "Already have your Spotify ZIP? Choose it below. No need to unzip it.",
          `Website: ${IMPORT_GUIDE_URLS.spotify}`,
          "1. Sign in, find Download your data, and select Extended streaming history. It goes back the furthest.",
          "2. Confirm the request. Spotify emails you when it's ready, which can take up to 30 days.",
          "3. Download the ZIP. It usually lands in your Downloads folder.",
          "4. Come back to /import > Spotify > Add past listening history and choose that ZIP.",
          "The quicker Account data download works too. It covers the past year plus your library. Neither needs a Spotify app or sign-in.",
          "Opening the website doesn't request or import anything by itself.",
        ],
        actions: [
          { type: "file", label: "Choose my Spotify ZIP" },
          { type: "openSpotify", label: "Open Spotify data export website" },
          { type: "waiting", label: "I'm waiting for my download" }, back,
        ],
      };
      case "waiting": return {
        title: "Wish you were here",
        paragraphs: [
          "When Spotify's email arrives, save the ZIP, usually in Downloads.",
          "Then come back to /import > Spotify > Add past listening history and choose it.",
          this.profileReady ? "Your profile is still here to explore in the meantime." : "You can still talk music while you wait.",
          "Connecting Spotify now brings in your latest plays, not your full history.",
        ],
        actions: [{ type: "quick", label: "Quick start while I wait" }, file, ...profile, back],
      };
      case "other": return {
        title: "Other listening sources",
        paragraphs: [
          "ListenBrainz: choose a listens JSON file saved from ListenBrainz, either a GET export or a single/import payload.",
        ],
        actions: [file, back],
      };
      case "preview": {
        const preview = this.state.preview ?? {};
        const recent = this.state.origin === "quick";
        const library = preview.kind === "library";
        const collection = preview.kind === "collection";
        const first = day(preview.earliestListeningAt);
        const last = day(preview.latestListeningAt);
        return {
          title: library ? "Review your Apple Music library" : recent ? "Review recent listening" : "Review this import",
          notice: "Nothing is added until you import it.",
          paragraphs: [
            clean(preview.sourceLabel) || "Your history",
            clean(preview.fileName),
            library || collection ? `${count(preview.tracks)} ${preview.tracks === 1 ? "song" : "songs"}` : `${count(preview.listeningEvents)} ${preview.listeningEvents === 1 ? "play" : "plays"} · ${count(preview.tracks)} ${preview.tracks === 1 ? "track" : "tracks"}`,
            library || collection ? `As of ${day(preview.capturedAt) ?? "an unknown date"}` : first && last ? `${first} to ${last}` : "No dates in this file.",
            library || collection ? "This shows what you keep, so no plays will be added." : recent
              ? "Spotify doesn't say how long you listened to recent plays."
              : preview.eventsWithPlayedMs === preview.listeningEvents
                ? "Listening time is known for every play."
                : `Listening time is known for ${count(preview.eventsWithPlayedMs)} of ${count(preview.listeningEvents)} plays.`,
            ...(preview.profileEvidence > 0 ? [`Also ${count(preview.profileEvidence)} saved songs, follows, or playlist entries`] : []),
            ...(preview.skippedRecords > 0 ? [`Left out ${count(preview.skippedRecords)} podcasts, videos, or incomplete entries`] : []),
            clean(preview.scopeNote),
            ...(preview.sampleTracks ?? []).map((track) => `  ${clean(track)}`),
          ].filter(Boolean),
          actions: [
            { type: "commit", label: "Add to my profile" },
            recent ? { type: "recent", label: "Refresh recent listening" } : { type: "file", label: "Choose a different file" }, back,
          ],
        };
      }
      default: return {
        title: "Bring your music",
        paragraphs: [
          "Pick your music service. Start with what you've played lately, or go all the way back.",
          this.profileReady ? "Anything you bring in joins your profile. Your choices stay as they are." : "You'll see what's inside before anything is added. It all stays on this machine.",
        ],
        actions: [{ type: "spotify", label: "Spotify" }, { type: "apple", label: "Apple Music" }, { type: "youtube_music", label: "YouTube Music" }, { type: "qq_music", label: "QQ Music / QQ 音乐" }, { type: "netease", label: "NetEase / 网易云音乐" }, { type: "other", label: "Other sources" }, ...profile],
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
    const playlist = ["qq_music", "netease"].includes(this.state.provider);
    const input = client ? this.clientEditor : this.editor;
    const error = clean(this.state.error?.message ?? this.state.error);
    const errorLines = error ? wrapTextWithAnsi(error, width).slice(0, Math.min(3, Math.max(1, height - 6))).map(theme.error) : [];
    const header = client
      ? [theme.bold("Enter your Spotify Client ID"), theme.muted("From your app settings. No client secret."), theme.text("Client ID")]
      : playlist ? [theme.bold("Paste your playlist share link"), theme.muted(this.state.provider === "qq_music" ? "QQ Music public playlist" : "NetEase Cloud Music public playlist"), theme.text("Link (or the copied share text)")]
      : [theme.bold("Choose your music file"), theme.muted(this.state.provider === "apple" ? "Apple Music library XML" : this.state.provider === "spotify" ? "Original Spotify history ZIP" : this.state.provider === "youtube_music" ? "Takeout ZIP, music library CSV or watch-history JSON" : this.state.provider === "other" ? "ListenBrainz JSON" : "Music export file or public playlist link"), theme.text("File path")];
    const hint = client ? theme.muted("Enter save · Esc back") : playlist ? theme.muted("Paste link · Enter preview · Esc back") : theme.muted(width >= 64 ? "Paste or drag one path · Tab completes · Enter inspect · Esc back"
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
      const message = clean(this.state.message) || "Working on it…";
      lines = [theme.bold("Your listening history"), "", ...wrapTextWithAnsi(message, inner).map(theme.text)];
      if (height >= 5) lines.push("", theme.muted("One moment."));
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
