import { CURSOR_MARKER, Editor, Text, getCellDimensions, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
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
    const { profileReady, modelReady, spotifyReady, provider, model, place } = this.getStatus();
    const compact = width < 60;
    const clean = (value) => sanitizeTerminalText(stripVTControlCharacters(String(value ?? "")))
      .replace(/\s+/gu, " ").trim();
    const modelName = clean(model);
    const providerName = clean(provider);
    const placeName = clean(place);
    const lead = "  /  ";
    const placeRoom = width - (1 + visibleWidth("MOONDOG") + visibleWidth(lead));
    const suffix = placeName && placeRoom >= 12
      ? theme.muted(lead + truncateToWidth(placeName, placeRoom, "…"))
      : !placeName && width >= 46 ? theme.muted(`${lead}your listening room`) : "";
    const title = theme.bold("MOONDOG") + suffix;
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

/**
 * Steps taken while answering. They stay on screen for this visit and are not saved.
 */
export class AgentWork {
  constructor(getTheme, getPhase = () => 0) {
    this.getTheme = getTheme;
    this.getPhase = getPhase;
    this.calls = [];
    this.live = true;
    this.settled = false;
    this.elapsed = "";
  }
  invalidate() {}
  note(key, label, state) {
    const text = sanitizeTerminalText(label).replace(/\s+/gu, " ").trim() || "Music tool";
    const existing = this.calls.find((call) => call.key === key);
    if (existing) {
      existing.label = text;
      existing.state = state;
    } else {
      this.calls.push({ key, label: text, state });
    }
  }
  quiet() {
    this.live = false;
  }
  settle(elapsed) {
    this.live = false;
    this.settled = true;
    this.elapsed = elapsed;
  }
  summary() {
    const count = (state) => this.calls.filter((call) => call.state === state).length;
    const parts = [];
    const done = count("completed");
    const failed = count("failed");
    const open = count("running");
    if (done) parts.push(`${done} done`);
    if (failed) parts.push(`${failed} didn't work`);
    if (open) parts.push(`${open} not confirmed`);
    return [parts.join(", "), this.elapsed].filter(Boolean).join(" · ");
  }
  render(width) {
    const theme = this.getTheme();
    const line = (text, ink) => new Text(ink(text), 3, 0).render(width);
    if (!this.calls.length) return this.live ? line("…", theme.faint) : [];
    const phase = this.getPhase() % 4;
    const liveMarks = ["·", "•", "·", "∙"];
    const shown = this.calls.slice(-8);
    const earlier = this.calls.length - shown.length;
    const lines = earlier ? line(`· ${earlier} earlier`, theme.faint) : [];
    lines.push(...shown.flatMap((call) => {
      const settledOpen = this.settled && call.state === "running";
      const mark = call.state === "failed" ? "×"
        : call.state === "completed" ? "✓"
        : settledOpen ? "·"
        : liveMarks[phase];
      const ink = call.state === "failed" ? theme.error : call.state === "completed" ? theme.muted : theme.faint;
      return line(`${mark} ${call.label}`, ink);
    }));
    if (this.settled) lines.push(...line(this.summary(), theme.faint));
    return lines;
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
  recallEntries() {
    return this.history.slice(0, 100);
  }
  replaceRecall(entries) {
    const next = [];
    for (const entry of entries ?? []) {
      if (typeof entry !== "string") continue;
      const text = entry.trim();
      if (!text || next.at(-1) === text) continue;
      next.push(text);
      if (next.length === 100) break;
    }
    this.history = next;
    this.exitHistoryBrowsing();
    return next.slice();
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
      const hint = homeFocused ? "Esc returns to your next thought." : homeVisible ? "What have you been listening to?" : "A song, a playlist, or what to play next.";
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
    // Pi learns the real cell size from terminals that answer it; others keep the 1:2 default.
    const { widthPx, heightPx } = getCellDimensions();
    const cellAspect = heightPx / widthPx;
    const frameKey = [
      width, rows, cellAspect, this.phase, this.lyricPosition, this.sleeveNote, focused ? 1 : 0, selected,
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
    const pixelTitle = rightWidth >= 41 && rows >= 20 && !["ascii", "text"].includes(this.artMode) && this.environment.TERM !== "dumb";
    const withNote = (lines, columns) => {
      const scrolling = motionEnabled && !theme.plain;
      const text = `"${this.sleeveNote}"`;
      const noteLines = ["", ...(scrolling ? [scrollingLyric(text, columns, this.lyricPosition)] : wrapTextWithAnsi(text, columns)).map((line) => hang(theme.muted(line)))];
      if (lines.length + noteLines.length > rows) return lines;
      this.canAnimate ||= scrolling;
      this.lyricColumns = scrolling ? columns : 0;
      return [...lines, ...noteLines];
    };
    // Copy sits two columns in, so the tracklist's selection mark hangs in the gutter.
    const copy = withNote([
      ...(pixelTitle ? renderMoondogWordmark().map(theme.text) : [theme.bold(roomy ? "M O O N D O G" : "MOONDOG")]).map(hang),
      ...(rows >= 12 ? [...wrapDescription("Your personal music agent.", rightWidth).map((line) => hang(theme.muted(line))), ""] : [""]),
      ...tracklist(theme, { focused, selected, columns: rightWidth + 2 }),
      ...(roomy ? ["", ...actionNote(focused ? homeActions[selected].description : "", rightWidth).map((line) => hang(theme.muted(line)))] : []),
    ], rightWidth);
    if (rows < 7 || width < 34 || this.artMode === "off") {
      this.canAnimate = false;
      this.lyricColumns = 0;
      const compact = withNote([hang(theme.bold("MOONDOG  ◎")),
        ...(rows >= 9 && width >= 30 ? [hang(theme.muted("Your personal music agent.")), ""] : []),
        ...tracklist(theme, { focused, selected, columns: width }),
      ], Math.max(1, width - 2));
      const top = Math.max(0, Math.floor((rows - compact.length) / 2));
      return finish(Array.from({ length: rows }, (_, row) => paint(compact[row - top] ?? "")));
    }
    const height = Math.min(22, rows - (roomy ? 2 : 0));
    const mode = this.artMode === "ascii" || this.artMode === "text" || this.environment.TERM === "dumb" ? "ascii" : "braille";
    this.canAnimate ||= !theme.plain && artWidth >= 20 && height >= 9;
    const phase = theme.plain ? 0 : this.phase;
    const key = `${artWidth}:${height}:${mode}:${phase}:${cellAspect}`;
    if (!this.cache.has(key)) {
      if (this.cache.size >= LOGO_MOTION_FRAMES * 2) this.cache.clear();
      this.cache.set(key, renderLunarRecord({ columns: artWidth, rows: height, style: mode, phase, cellAspect }));
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
      return `  ${pad(left, artWidth)} ${copy[row - copyTop] ?? ""}`;
    });
    return finish(lines.map(paint));
  }
}

/** The home actions as a sleeve tracklist: each row names the command that opens it. */
function tracklist(theme, { focused, selected, columns }) {
  // Two columns hold the selection mark; the rest matches the pixel wordmark's width.
  const width = Math.min(columns, 43);
  const fits = (key) => homeActions.every((action) => visibleWidth(action[key]) + action.command.length + 8 <= width);
  const key = fits("label") ? "label" : fits("short") ? "short" : null;
  return homeActions.map((action, index) => {
    const active = focused && selected === index;
    const label = action[key ?? "short"];
    const marker = active ? theme.accent("◉ ") : "  ";
    const name = active ? theme.bold(theme.text(label)) : focused ? theme.muted(label) : theme.text(label);
    if (!key) return marker + name;
    const command = `/${action.command}`;
    const leader = "·".repeat(width - 4 - visibleWidth(label) - command.length);
    return `${marker}${name} ${(active ? theme.accent : theme.faint)(leader)} ${(active ? theme.accent : theme.muted)(command)}`;
  });
}

/** Hold the tallest note's rows so moving through the list never shifts the sleeve. */
function actionNote(text, width) {
  const rows = Math.max(...homeActions.map((action) => wrapDescription(action.description, width).length));
  const lines = wrapDescription(text, width);
  return [...lines, ...Array(rows - lines.length).fill("")];
}

function hang(line) {
  return `  ${line}`;
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
While an answer is coming, each step shows in the conversation, and the footer names the one in progress.

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
- Up and Down in the draft recall what you typed in this conversation
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
