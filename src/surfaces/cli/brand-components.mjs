import { CURSOR_MARKER, Editor, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { sanitizeTerminalText } from "./format-output.mjs";
import { LOGO_MOTION_FRAMES, renderLunarRecord, renderMoondogWordmark } from "./terminal-art.mjs";
export { ListeningMenu } from "./listening-menu.mjs";

export function paintBrandLine(line, width, theme) {
  const clipped = truncateToWidth(line, Math.max(1, width), "");
  const padding = " ".repeat(Math.max(0, width - visibleWidth(clipped)));
  // NO_COLOR affects styling, not Pi's zero-width cursor marker or IME placement.
  if (theme.plain) return (clipped + padding).replace(/\u001b\[[\d;:]*m/g, "");
  return theme.background(theme.text(clipped + padding));
}

function pad(text, width) {
  const clipped = truncateToWidth(text, Math.max(1, width), "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

export class BrandSurface {
  constructor(component, getTheme, padding = 0) {
    this.component = component;
    this.getTheme = getTheme;
    this.padding = padding;
  }
  handleInput(data) { this.component.handleInput?.(data); }
  invalidate() {
    this.paintCache = undefined;
    this.component.invalidate?.();
  }
  render(width) {
    const theme = this.getTheme();
    const padding = Math.min(this.padding, Math.max(0, Math.floor((width - 1) / 2)));
    const lines = this.component.render(Math.max(1, width - padding * 2));
    if (this.paintTheme !== theme || this.paintWidth !== width || this.paintPadding !== padding) {
      this.paintCache = new Map();
      this.paintTheme = theme;
      this.paintWidth = width;
      this.paintPadding = padding;
    }
    const prefix = " ".repeat(padding);
    return lines.map((line) => {
      const painted = this.paintCache.get(line);
      if (painted !== undefined) return painted;
      const next = paintBrandLine(prefix + line, width, theme);
      if (this.paintCache.size > 4000) this.paintCache.clear();
      this.paintCache.set(line, next);
      return next;
    });
  }
}

export class ListeningHeader {
  constructor(getTheme, getStatus) {
    this.getTheme = getTheme;
    this.getStatus = getStatus;
  }
  invalidate() {}
  render(width) {
    const theme = this.getTheme();
    const { profileReady, modelReady, spotifyReady, provider, model } = this.getStatus();
    const title = theme.bold("MOONDOG") + (width >= 46 ? theme.muted("  /  your listening room") : "");
    const compact = width < 60;
    const clean = (value) => sanitizeTerminalText(stripVTControlCharacters(String(value ?? "")))
      .replace(/\s+/gu, " ").trim();
    const modelName = clean(model);
    const providerName = clean(provider);
    const profileLabel = profileReady
      ? compact ? "profile ready" : "local profile"
      : compact ? "no history" : "bring your history";
    const modelLabel = modelReady ? modelName || (compact ? "model ready" : "conversation ready") : "model offline";
    const identity = modelReady && providerName ? `${providerName} / ${modelLabel}` : modelLabel;
    const available = Math.max(1, width - 1);
    // Keep the active model readable before spending space on optional status.
    const candidates = [
      [profileLabel, identity, ...(spotifyReady && !compact ? ["Spotify connected"] : [])],
      [profileLabel, identity],
      [profileLabel, modelLabel],
      [identity],
      [modelLabel],
    ].map((parts) => parts.join("  ·  "));
    const status = candidates.find((candidate) => visibleWidth(candidate) <= available)
      ?? truncateToWidth(modelLabel, available, "…");
    return [
      paintBrandLine(` ${title}`, width, theme),
      paintBrandLine(` ${theme.faint(status)}`, width, theme),
    ];
  }
}

/** Keep Pi's editing, paste, IME, history, and autocomplete intact. */
export class ListeningEditor extends Editor {
  constructor(tui, theme, getTheme, getState) {
    super(tui, theme, { paddingX: 1, autocompleteMaxVisible: 5 });
    this.getTheme = getTheme;
    this.getState = getState;
    this.rowCount = 3;
  }
  // The sleeve measures this during the same frame. The signature is taken again
  // after painting because the editor can adjust its own scroll while rendering.
  renderSignature() {
    const { busy, homeVisible, homeFocused } = this.getState();
    const list = this.autocompleteState ? this.autocompleteList : null;
    const items = list?.filteredItems ?? [];
    return [
      this.focused ? 1 : 0,
      this.disableSubmit ? 1 : 0,
      busy ? 1 : 0,
      homeVisible ? 1 : 0,
      homeFocused ? 1 : 0,
      this.state.cursorLine,
      this.state.cursorCol,
      this.scrollOffset,
      this.state.lines.join("\n"),
      list ? list.selectedIndex : "",
      items.map((item) => `${item.value ?? ""}\t${item.label ?? ""}`).join("\n"),
    ].join("\0");
  }
  render(width) {
    const theme = this.getTheme();
    const signature = `${width}\0${this.renderSignature()}`;
    if (this.renderCache?.signature === signature && this.renderCache.theme === theme) {
      this.rowCount = this.renderCache.lines.length;
      return this.renderCache.lines;
    }
    const lines = super.render(width).map((line) => this.focused ? line : line.replace(/\x1b\[7m([\s\S]*?)\x1b\[0m/g, "$1"));
    const { busy, homeVisible, homeFocused } = this.getState();
    if (!/[↑↓]/u.test(lines[0])) {
      const label = busy ? " DRAFT " : homeFocused ? " TAB TO TYPE " : " YOU ";
      lines[0] = width >= label.length + 4
        ? theme.faint("─ ") + theme.muted(label) + theme.faint("─".repeat(width - label.length - 2))
        : theme.faint("─".repeat(width));
    }
    if (!busy && !this.getText() && lines.length === 3 && width >= 28) {
      const hint = homeFocused ? "Esc returns to your next thought." : homeVisible ? "What have you been listening to?" : "Keep the conversation going...";
      const text = truncateToWidth(hint, width - 2, "");
      lines[1] = " " + (this.focused ? CURSOR_MARKER + theme.inverse(text[0]) : theme.faint(text[0])) + theme.faint(text.slice(1));
    }
    this.rowCount = lines.length;
    this.renderCache = { signature: `${width}\0${this.renderSignature()}`, theme, lines };
    return lines;
  }
}

export const homeActions = [
  { command: "taste", label: "Listening profile", short: "Profile", description: "See what your listening reveals. Tell me what I missed." },
  { command: "import", label: "Import your music", short: "Import music", description: "Bring songs, playlists or listening history." },
  { command: "theme", label: "Appearance", short: "Appearance", description: "Paper, charcoal, or your terminal colors." },
  { command: "help", label: "Help & commands", short: "Help", description: "Commands, connections and keyboard shortcuts." },
];

const sleeveNotes = [
  // Welcome to the Machine: https://www.pinkfloyd.com/albums/wish-you-were-here/
  "Where have you been?",
  // https://www.pinkfloyd.com/albums/the-wall/
  "Is there anybody out there?",
  // https://www.pinkfloyd.com/albums/wish-you-were-here/
  "Wish you were here.",
];

const lyricSegments = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function scrollingLyric(text, columns, position) {
  let line = "";
  let filled = 0;
  for (const { segment } of lyricSegments.segment(text)) {
    const width = visibleWidth(segment);
    // A terminal cannot draw half a wide character; leave its clipped cell blank.
    if (position >= 0 && position + width <= columns) {
      line += " ".repeat(Math.max(0, position - filled)) + segment;
      filled = position + width;
    }
    position += width;
    if (position >= columns) break;
  }
  return line;
}

/** A character-native listening room; it never transmits image protocols. */
export class RecordSleeve {
  constructor({ terminal, getTheme, environment = process.env, getState = () => ({}), random = Math.random, getNextLyric = () => null }) {
    this.terminal = terminal;
    this.getTheme = getTheme;
    this.getState = getState;
    this.environment = environment;
    this.random = random;
    this.getNextLyric = getNextLyric;
    this.artMode = environment.MOONDOG_ART ?? "auto";
    // Redraws preserve the line; only a completed passage asks for another.
    this.sleeveNote = sleeveNotes[Math.floor(random() * sleeveNotes.length)];
    this.defaultSleeveNote = this.sleeveNote;
    this.phase = 0;
    this.lyricPosition = 0;
    this.lyricHold = 12; // Give the opening 1.5 seconds before it starts moving.
    this.lyricColumns = 0;
    this.canAnimate = false;
    this.cache = new Map();
    this.colored = new Map();
  }
  invalidate() {
    this.cache.clear();
    this.colored.clear();
    this.frame = undefined;
    this.colorTheme = undefined;
  }
  setLyric(text, { enterFromRight = false } = {}) {
    const note = text ? sanitizeTerminalText(text).replace(/\s+/gu, " ").trim() : this.defaultSleeveNote;
    if (note !== this.sleeveNote || enterFromRight) {
      this.lyricPosition = enterFromRight ? this.lyricColumns : 0;
      this.lyricHold = enterFromRight ? 0 : 12;
    }
    this.sleeveNote = note;
    this.invalidate();
  }
  setArtMode(mode) { this.artMode = mode; this.invalidate(); }
  advance() {
    this.phase = (this.phase + 1) % LOGO_MOTION_FRAMES;
    if (!this.lyricColumns) return;
    if (this.lyricHold > 0) { this.lyricHold--; return; }
    this.lyricPosition--;
    if (this.lyricPosition <= -visibleWidth(`"${this.sleeveNote}"`) - 8) {
      const fallback = sleeveNotes.filter((note) => note !== this.sleeveNote);
      const next = this.getNextLyric() ?? fallback[Math.floor(this.random() * fallback.length)];
      this.setLyric(next, { enterFromRight: true });
    }
  }
  render(width) {
    const theme = this.getTheme();
    const { focused = false, selected = 0, editorRows = 3,
      motionEnabled = this.environment.MOONDOG_MOTION !== "off" } = this.getState();
    // Fill the viewport between the header and composer, independently of art size.
    const rows = Math.max(1, this.terminal.rows - 2 - editorRows - (this.terminal.rows >= 20 ? 2 : 1));
    const frameKey = [
      width, rows, this.phase, this.lyricPosition, this.sleeveNote, focused ? 1 : 0, selected,
      motionEnabled ? 1 : 0, this.artMode, this.environment.TERM ?? "", theme.plain ? 1 : 0,
    ].join("\0");
    if (this.frame?.key === frameKey && this.frame.theme === theme) {
      this.canAnimate = this.frame.canAnimate;
      this.lyricColumns = this.frame.lyricColumns;
      return this.frame.lines;
    }
    const finish = (lines) => {
      this.frame = { key: frameKey, theme, lines, canAnimate: this.canAnimate, lyricColumns: this.lyricColumns };
      return lines;
    };
    const paint = (line) => paintBrandLine(line, width, theme);
    this.canAnimate = false;
    this.lyricColumns = 0;
    const roomy = width >= 76 && rows >= 14;
    const narrow = width < 54;
    const available = Math.max(1, width - 4);
    const artWidth = Math.min(50, Math.floor(available * (narrow ? 0.40 : 0.48)));
    const rightWidth = Math.max(1, available - artWidth - 3);
    const actionLines = homeActions.map((action, index) => {
      const label = narrow ? action.short : action.label;
      const active = focused && selected === index;
      const prefix = active ? theme.accent("› ") : theme.faint(`${index + 1} `);
      return prefix + (active ? theme.inverse(theme.bold(` ${label} `)) : theme.text(` ${label} `));
    });
    const pixelTitle = rightWidth >= 41 && rows >= 20 && !["ascii", "text"].includes(this.artMode) && this.environment.TERM !== "dumb";
    const withNote = (lines, columns) => {
      const scrolling = motionEnabled && !theme.plain;
      const text = `"${this.sleeveNote}"`;
      const noteLines = ["", ...(scrolling ? [scrollingLyric(text, columns, this.lyricPosition)] : wrapTextWithAnsi(text, columns)).map(theme.muted)];
      if (lines.length + noteLines.length > rows) return lines;
      this.canAnimate ||= scrolling;
      this.lyricColumns = scrolling ? columns : 0;
      return [...lines, ...noteLines];
    };
    const copy = withNote([
      ...(pixelTitle ? renderMoondogWordmark().map(theme.text) : [theme.bold(roomy ? "M O O N D O G" : "MOONDOG")]),
      ...(rows >= 12 ? [...wrapDescription("Your personal music agent.", rightWidth).map(theme.muted), ""] : [""]),
      ...actionLines,
      ...(roomy ? ["", ...wrapDescription(homeActions[selected].description, rightWidth).map(theme.muted)] : []),
    ], rightWidth);
    if (rows < 7 || width < 34 || this.artMode === "off") {
      this.canAnimate = false;
      this.lyricColumns = 0;
      const compact = withNote([theme.bold("MOONDOG  ◎"),
        ...(rows >= 9 && width >= 30 ? [theme.muted("Your personal music agent."), ""] : []),
        ...actionLines,
      ], Math.max(1, width - 1)).map((line) => ` ${line}`);
      const top = Math.max(0, Math.floor((rows - compact.length) / 2));
      return finish(Array.from({ length: rows }, (_, row) => paint(compact[row - top] ?? "")));
    }
    const height = Math.min(22, rows - (roomy ? 2 : 0));
    const mode = this.artMode === "ascii" || this.artMode === "text" || this.environment.TERM === "dumb" ? "ascii" : "braille";
    this.canAnimate ||= !theme.plain && artWidth >= 20 && height >= 9;
    const phase = theme.plain ? 0 : this.phase;
    const key = `${artWidth}:${height}:${mode}:${phase}`;
    if (!this.cache.has(key)) {
      if (this.cache.size >= LOGO_MOTION_FRAMES * 2) this.cache.clear();
      this.cache.set(key, renderLunarRecord({ columns: artWidth, rows: height, style: mode, phase }));
    }
    const art = this.cache.get(key);
    if (this.colorTheme !== theme) {
      this.colored.clear();
      this.colorTheme = theme;
    }
    let colored = this.colored.get(key);
    if (!colored) {
      colored = art.map((ink) => {
        let run = "";
        let foreground = false;
        let left = "";
        for (const character of ink) {
          const mask = character.codePointAt(0) - 0x2800;
          const density = mask >= 0 && mask <= 255 ? mask.toString(2).replaceAll("0", "").length : 1;
          const next = density >= 4;
          if (next !== foreground && run) {
            left += (foreground ? theme.text : theme.muted)(run);
            run = "";
          }
          foreground = next;
          run += character;
        }
        return left + (foreground ? theme.text : theme.muted)(run);
      });
      if (this.colored.size > LOGO_MOTION_FRAMES * 4) this.colored.clear();
      this.colored.set(key, colored);
    }
    const count = rows;
    const copyTop = Math.max(0, Math.floor((count - copy.length) / 2));
    const artTop = Math.max(0, Math.floor((count - colored.length) / 2));
    const lines = Array.from({ length: count }, (_, row) => {
      const left = colored[row - artTop] ?? "";
      return `  ${pad(left, artWidth)}   ${copy[row - copyTop] ?? ""}`;
    });
    return finish(lines.map(paint));
  }
}

function wrapDescription(text, width) {
  const lines = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && visibleWidth(`${line} ${word}`) > width) { lines.push(line); line = ""; }
    line += (line ? " " : "") + word;
  }
  if (line) lines.push(line);
  return lines;
}

export function listeningHelp() {
  return `# Your listening room

## 01 / Listen and discover

Just type to talk about music, ask for a playlist, or go exploring.
To talk, Moondog needs a model: \`/auth\` signs you in, then \`/model\` picks one.

- \`/taste\` - your profile: open any song or artist to see why it's there
- \`/taste report\` - the whole picture on one page
- \`/import\` - bring in your history, your library, or a playlist
- \`/lyrics\` - the lyrics on the sleeve; \`/lyrics sync\` finds more
- \`/spotify\` - play, queue, and make playlists in Spotify
- Ask to move playback onto your iPhone, computer, or another Spotify device by name
- \`/web search <query>\` or \`/web read <url>\` - look things up on public music sites

## 02 / Make it yours

- \`/profile\` - the same profile as \`/taste\`
- \`/profile corrections\` - everything you've told me
- \`/profile retract <id>\` - undo one of those
- \`/profile help\` - the full set of profile commands
- \`/remember <text>\`, \`/memory\`, \`/forget <id>\` - what I remember between conversations

## 03 / Around the room

- \`/home\` - back to the record sleeve; the conversation stays
- \`/theme paper|charcoal|terminal|auto\` - change the look
- \`/art braille|ascii|off\` - change the artwork
- \`/motion on|off\` - turn the animation on or off
- \`/commands\` or Ctrl+P - search every command; your message stays put
- Page Up and Page Down scroll the conversation. The header and your draft stay put
- \`/resume\` - pick up a saved conversation (type to filter, Enter opens)
- \`/new\` - start fresh; this conversation stays saved
- \`/status\`, \`/sources\`, \`/tools\`, \`/doctor\` - see what's connected and working
- \`/reload\` - reload model settings and sign-ins
- \`/help all\` - every command, including the ones for the shell
- \`/quit\` - leave

Tab moves to the menu on the home screen. Esc goes back to typing.
Enter sends, and Shift+Enter starts a new line.
Tab or Enter accepts a suggestion.
Ctrl+C stops a model or web request, or leaves when nothing is running.
In the profile, type to filter, Tab switches lists, and Enter shows what you can do.
Ctrl+R refreshes it and Ctrl+O opens the full report.
Your profile works without a model.
Put quotes around paths, titles, and names that have spaces.`;
}
