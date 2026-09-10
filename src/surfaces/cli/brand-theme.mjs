import { stripVTControlCharacters } from "node:util";

const escape = "\u001b[";
const modes = new Set(["auto", "paper", "charcoal", "terminal"]);
const palettes = {
  paper: {
    background: "#eee7d5",
    foreground: "#242722",
    muted: "#606359",
    faint: "#65685d",
    accent: "#746044",
    success: "#50644b",
    warning: "#7c5d25",
    error: "#a04136",
  },
  charcoal: {
    background: "#222521",
    foreground: "#eee7d5",
    muted: "#a9ab9c",
    faint: "#96988d",
    accent: "#ccb995",
    success: "#a8b497",
    warning: "#d0ad73",
    error: "#d39b8c",
  },
};
const ansi16 = [
  [0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0],
  [0, 0, 128], [128, 0, 128], [0, 128, 128], [192, 192, 192],
  [128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0],
  [0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
];

function rgb(hex) {
  return [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
}

function xtermRgb(index) {
  if (index < 16) return ansi16[index];
  if (index >= 232) return [1, 1, 1].map(() => 8 + (index - 232) * 10);
  const cube = index - 16;
  return [Math.floor(cube / 36), Math.floor(cube / 6) % 6, cube % 6]
    .map((value) => value === 0 ? 0 : 55 + value * 40);
}

function nearestXterm(hex) {
  const target = rgb(hex);
  let nearest = 16;
  let distance = Infinity;
  // The first sixteen colors are user-configurable; the remaining palette is fixed.
  for (let index = 16; index < 256; index += 1) {
    const difference = xtermRgb(index).reduce(
      (sum, value, channel) => sum + (value - target[channel]) ** 2,
      0,
    );
    if (difference < distance) {
      distance = difference;
      nearest = index;
    }
  }
  return nearest;
}

function detectedMode(environment) {
  const hint = String(environment.COLORFGBG ?? "").split(";").at(-1);
  if (!/^\d+$/.test(hint)) return "charcoal";
  const index = Number(hint);
  if (index > 255) return "charcoal";
  const luminance = xtermRgb(index).reduce((sum, value, channel) => {
    const normalized = value / 255;
    const linear = normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
    return sum + linear * [0.2126, 0.7152, 0.0722][channel];
  }, 0);
  return luminance > 0.4 ? "paper" : "charcoal";
}

function colorDepth(environment) {
  if (Object.hasOwn(environment, "NO_COLOR") || environment.TERM === "dumb") return 0;
  if (/^(truecolor|24bit)$/i.test(environment.COLORTERM ?? "")) return 24;
  if (/^(iTerm\.app|WezTerm|ghostty|vscode|Hyper|Windows_Terminal)$/i.test(environment.TERM_PROGRAM ?? "")) return 24;
  if (/(direct|truecolor|kitty|ghostty)/i.test(environment.TERM ?? "")) return 24;
  if (/256color/i.test(environment.TERM ?? "") || environment.TERM_PROGRAM === "Apple_Terminal") return 8;
  return 4;
}

// Treat extended color parameters as one command so an RGB zero is never a reset.
function sgrCommands(parameters) {
  const values = parameters.split(";");
  const commands = [];
  for (let index = 0; index < values.length; index += 1) {
    const first = values[index];
    const code = Number(first.split(":", 1)[0]);
    let length = 1;
    if (!first.includes(":") && [38, 48, 58].includes(code)) {
      if (values[index + 1] === "5") length = 3;
      if (values[index + 1] === "2") length = 5;
    }
    commands.push({ code, parameters: values.slice(index, index + length).join(";") });
    index += length - 1;
  }
  return commands;
}

function style(openParameters, closeCode) {
  const open = `${escape}${openParameters}m`;
  const close = `${escape}${closeCode}m`;
  return (value) => {
    const content = String(value ?? "").replace(/\u001b\[([\d;:]*)m/g, (sequence, parameters) => {
      const commands = sgrCommands(parameters);
      if (!commands.some(({ code }) => code === 0 || code === closeCode)) return sequence;
      // Reopen immediately after a reset, preserving later explicit nested styles.
      return commands.map(({ code, parameters: command }) =>
        `${escape}${command}m${code === 0 || code === closeCode ? open : ""}`,
      ).join("");
    });
    return open + content + close;
  };
}

/**
 * The lunar-record identity, scoped to rendered text rather than terminal settings.
 * Explicit modes override MOONDOG_THEME; auto uses the environment then COLORFGBG.
 * Terminal mode leaves the user's background and base foreground intact.
 */
export function createMoondogTheme({ mode = "auto", environment = process.env } = {}) {
  const env = environment ?? {};
  const option = String(mode).trim().toLowerCase();
  const preference = String(env.MOONDOG_THEME ?? "").trim().toLowerCase();
  let resolvedMode = modes.has(option) ? option : "auto";
  if (resolvedMode === "auto" && modes.has(preference)) resolvedMode = preference;
  if (resolvedMode === "auto") resolvedMode = detectedMode(env);
  const depth = colorDepth(env);
  const terminal = resolvedMode === "terminal";
  const palette = Object.freeze(terminal
    ? { ...palettes[detectedMode(env)], background: null, foreground: null }
    : { ...palettes[resolvedMode] });
  const plain = (value) => String(value ?? "");
  const unstyled = (value) => stripVTControlCharacters(plain(value));
  const decoration = (open, close) => depth === 0 ? unstyled : style(open, close);
  const bold = decoration(1, 22);
  const italic = decoration(3, 23);
  const underline = decoration(4, 24);
  const inverse = decoration(7, 27);
  const strikethrough = decoration(9, 29);
  const light = resolvedMode === "paper";
  const fallback = {
    foreground: light ? 30 : 37,
    muted: light ? 30 : 37,
    faint: light ? 30 : 90,
    accent: light ? 30 : 33,
    success: light ? 32 : 92,
    warning: light ? 30 : 33,
    error: light ? 31 : 91,
  };
  const foreground = (name) => {
    if (depth === 0) return unstyled;
    if (terminal) {
      if (name === "accent") return bold;
      if (name === "success") return style(32, 39);
      if (name === "warning") return style(33, 39);
      if (name === "error") return style(31, 39);
      return plain;
    }
    if (depth === 24) return style(`38;2;${rgb(palette[name]).join(";")}`, 39);
    if (depth === 8) return style(`38;5;${nearestXterm(palette[name])}`, 39);
    return style(fallback[name], 39);
  };
  const text = foreground("foreground");
  const muted = foreground("muted");
  const faint = foreground("faint");
  const accent = foreground("accent");
  const success = foreground("success");
  const warning = foreground("warning");
  const error = foreground("error");
  let background = plain;
  if (depth === 0) background = unstyled;
  else if (!terminal) {
    const code = depth === 24
      ? `48;2;${rgb(palette.background).join(";")}`
      : depth === 8 ? `48;5;${nearestXterm(palette.background)}` : light ? 107 : 40;
    background = style(code, 49);
  }
  const selected = (value) => inverse(bold(text(value)));
  const selectListTheme = {
    selectedPrefix: selected,
    selectedText: selected,
    description: muted,
    scrollInfo: muted,
    noMatch: muted,
  };
  const editorTheme = { borderColor: faint, selectList: selectListTheme };
  const markdownTheme = {
    heading: (value) => bold(text(value)),
    link: (value) => underline(text(value)),
    linkUrl: muted,
    code: text,
    codeBlock: text,
    codeBlockBorder: faint,
    quote: muted,
    quoteBorder: faint,
    hr: faint,
    listBullet: muted,
    bold,
    italic,
    strikethrough,
    underline,
  };
  return {
    mode: resolvedMode,
    plain: depth === 0,
    palette,
    text,
    muted,
    faint,
    accent,
    success,
    warning,
    error,
    bold,
    italic,
    underline,
    inverse,
    background,
    editorTheme,
    selectListTheme,
    markdownTheme,
    defaultTextStyle: { color: text, bgColor: background },
  };
}
