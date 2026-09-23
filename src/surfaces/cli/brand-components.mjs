import { CURSOR_MARKER, Editor, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
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
  invalidate() { this.component.invalidate?.(); }
  handleInput(data) { this.component.handleInput?.(data); }
  render(width) {
    const padding = Math.min(this.padding, Math.max(0, Math.floor((width - 1) / 2)));
    return this.component.render(Math.max(1, width - padding * 2)).map(
      (line) => paintBrandLine(" ".repeat(padding) + line, width, this.getTheme()),
    );
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
  }
  render(width) {
    const lines = super.render(width).map((line) => this.focused ? line : line.replace(/\x1b\[7m([\s\S]*?)\x1b\[0m/g, "$1"));
    const theme = this.getTheme();
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
    return lines;
  }
}

export const homeActions = [
  { command: "taste", label: "Listening profile", short: "Profile", description: "See what your listening reveals. Tell me what I missed." },
  { command: "import", label: "Import your music", short: "Import music", description: "Bring songs, playlists or listening history." },
  { command: "theme", label: "Appearance", short: "Appearance", description: "Paper, charcoal, or your terminal colors." },
  { command: "help", label: "Help & commands", short: "Help", description: "Commands, connections and keyboard shortcuts." },
];

/** A character-native listening room; it never transmits image protocols. */
export class RecordSleeve {
  constructor({ terminal, getTheme, environment = process.env, getState = () => ({}) }) {
    this.terminal = terminal;
    this.getTheme = getTheme;
    this.getState = getState;
    this.environment = environment;
    this.artMode = environment.MOONDOG_ART ?? "auto";
    this.phase = 0;
    this.canAnimate = false;
    this.cache = new Map();
  }
  invalidate() { this.cache.clear(); }
  setArtMode(mode) { this.artMode = mode; this.invalidate(); }
  advance() { this.phase = (this.phase + 1) % LOGO_MOTION_FRAMES; }
  render(width) {
    const theme = this.getTheme();
    const { focused = false, selected = 0, editorRows = 3 } = this.getState();
    // Fill the viewport between the header and composer, independently of art size.
    const rows = Math.max(1, this.terminal.rows - 2 - editorRows - (this.terminal.rows >= 20 ? 2 : 1));
    const paint = (line) => paintBrandLine(line, width, theme);
    this.canAnimate = false;
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
    const copy = [
      ...(pixelTitle ? renderMoondogWordmark().map(theme.text) : [theme.bold(roomy ? "M O O N D O G" : "MOONDOG")]),
      ...(rows >= 12 ? [...wrapDescription("Your personal music agent.", rightWidth).map(theme.muted), ""] : [""]),
      ...(roomy ? [...wrapDescription("Bring a song. I'll bring a point of view.", rightWidth).map(theme.text), ""] : []),
      ...actionLines,
      ...(roomy ? ["", ...wrapDescription(homeActions[selected].description, rightWidth).map(theme.muted)] : []),
    ];
    if (rows < 7 || width < 34 || this.artMode === "off") {
      const compact = [theme.bold(" MOONDOG  ◎"),
        ...(rows >= 9 && width >= 30 ? [theme.muted(" Your personal music agent."), ""] : []),
        ...actionLines.map((line) => ` ${line}`),
        ...(rows >= 13 && width >= 42 ? ["", theme.text(" Bring a song. I'll bring a point of view.")] : []),
      ];
      const top = Math.max(0, Math.floor((rows - compact.length) / 2));
      return Array.from({ length: rows }, (_, row) => paint(compact[row - top] ?? ""));
    }
    const height = Math.min(22, rows - (roomy ? 2 : 0));
    const mode = this.artMode === "ascii" || this.artMode === "text" || this.environment.TERM === "dumb" ? "ascii" : "braille";
    this.canAnimate = !theme.plain && artWidth >= 20 && height >= 9;
    const phase = theme.plain ? 0 : this.phase;
    const key = `${artWidth}:${height}:${mode}:${phase}`;
    if (!this.cache.has(key)) {
      if (this.cache.size >= LOGO_MOTION_FRAMES * 2) this.cache.clear();
      this.cache.set(key, renderLunarRecord({ columns: artWidth, rows: height, style: mode, phase }));
    }
    const art = this.cache.get(key);
    const count = rows;
    const copyTop = Math.max(0, Math.floor((count - copy.length) / 2));
    const artTop = Math.max(0, Math.floor((count - art.length) / 2));
    const lines = Array.from({ length: count }, (_, row) => {
      const ink = art[row - artTop] ?? "";
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
      left += (foreground ? theme.text : theme.muted)(run);
      return `  ${pad(left, artWidth)}   ${copy[row - copyTop] ?? ""}`;
    });
    return lines.map(paint);
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

Type a request to talk with Moondog, build a playlist, or explore music.
Use \`/auth [provider]\` to connect an API key or sign in, then \`/model\` to choose a model.

- \`/taste\` - select tracks or artists, inspect evidence, and shape your preferences
- \`/taste report\` - the full Tasteprint, Time Machine, and listening patterns
- \`/import\` - get your listening data or inspect a saved Spotify ZIP / ListenBrainz JSON
- \`/spotify\` - connected playback, queues, and playlists
- \`/web search <query>\` or \`/web read <url>\` - public music sources

## 02 / Make it yours

- \`/profile\` - open the interactive listening profile
- \`/profile help\` - advanced correction commands
- \`/profile corrections\` - inspect your explicit choices
- \`/profile retract <id>\` - retract a correction
- \`/remember <text>\`, \`/memory\`, \`/forget <id>\` - revisable conversation memory

## 03 / Around the room

- \`/home\` - return to the record sleeve without clearing the conversation
- \`/theme paper|charcoal|terminal|auto\` - change this session's appearance
- \`/art braille|ascii|off\` - choose the character artwork style
- \`/motion on|off\` - turn character animation on or off
- \`/commands\` or Ctrl+P - search commands without losing your draft
- \`/resume\` - find and continue a saved conversation; type to filter, Enter opens, Esc returns
- \`/resume <session-id>\` - restore a saved conversation directly
- \`/new\` - start a new conversation
- \`/status\`, \`/sources\`, \`/tools\`, \`/doctor\` - inspect readiness
- \`/reload\` - reload model settings and authentication
- \`/help all\` - the complete CLI and TUI command reference
- \`/quit\` - leave Moondog

Tab explores the home actions. Ctrl+P opens the searchable command palette.
Escape returns to typing. Enter sends. Shift+Enter adds a line.
Argument suggestions support appearance, web, Spotify, authentication, and model commands.
Tab or Enter accepts a suggestion; a fully typed command sends with Enter.
The header shows the current model, and the footer tracks active work and elapsed time.
Ctrl+C cancels a model or web request, or exits when idle.
Local commands without cancellation finish their current step; the draft stays available.
Profile viewing and correction work without a model.
In the profile, type to filter, Tab switches views, and Enter opens actions.
Escape returns with your draft kept; Ctrl+R refreshes and Ctrl+O opens the full report.
Quote paths, titles, and artist names that contain spaces.`;
}
