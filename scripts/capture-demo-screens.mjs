#!/usr/bin/env node

// Regenerates the README terminal screenshots and the Tasteprint preview PNGs.
// The terminal views come from the real TUI driven in a private tmux server with
// fictional history, so no personal data, model, or music service is involved.

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, constants, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { writeFictionalSpotifyHistoryArchive } from "../src/demo/fictional-spotify-history.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const demoDirectory = path.join(repositoryRoot, "assets", "demo");
const columns = 100;
const rows = 34;
const terminalSize = { width: 956, height: 800 };
const previewSize = { width: 1240, height: 840 };

const palette = { background: "#222521", foreground: "#eee7d5", muted: "#a9ab9c" };

async function executable(filePath) {
  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveBrowser() {
  if (process.env.MOONDOG_CAPTURE_BROWSER) return path.resolve(process.env.MOONDOG_CAPTURE_BROWSER);
  for (const candidate of [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ]) {
    if (await executable(candidate)) return candidate;
  }
  throw new Error("A Chrome or Chromium executable is required. Set MOONDOG_CAPTURE_BROWSER to its path.");
}

/** Headless Chrome writes the file but may not exit, so wait for the file and stop it. */
async function screenshot({ browser, url, outputPath, size, profile }) {
  await rm(outputPath, { force: true });
  const child = spawn(browser, [
    "--headless=new", "--disable-gpu", "--disable-extensions", "--disable-background-networking",
    "--disable-sync", "--no-first-run", "--no-default-browser-check", "--hide-scrollbars",
    "--force-device-scale-factor=1", `--window-size=${size.width},${size.height}`,
    "--virtual-time-budget=2000", `--user-data-dir=${profile}`, `--screenshot=${outputPath}`, url,
  ], { stdio: "ignore" });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const size = await stat(outputPath).then((value) => value.size, () => 0);
      if (size > 1024) {
        await delay(300);
        return;
      }
      await delay(100);
    }
    throw new Error(`Headless browser did not write ${path.basename(outputPath)}.`);
  } finally {
    child.kill("SIGTERM");
    await Promise.race([exited, delay(5_000)]);
  }
}

const basicColors = [
  "#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
  "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff",
];

function color256(index) {
  if (index < 16) return basicColors[index];
  if (index < 232) {
    const value = index - 16;
    const level = (step) => (step === 0 ? 0 : 55 + step * 40);
    return `rgb(${level(Math.floor(value / 36))},${level(Math.floor(value / 6) % 6)},${level(value % 6)})`;
  }
  const gray = 8 + (index - 232) * 10;
  return `rgb(${gray},${gray},${gray})`;
}

function applySgr(state, codes) {
  const values = codes.length === 0 ? [0] : codes;
  for (let index = 0; index < values.length; index += 1) {
    const code = values[index];
    if (code === 0) Object.assign(state, { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false });
    else if (code === 1) state.bold = true;
    else if (code === 2) state.dim = true;
    else if (code === 3) state.italic = true;
    else if (code === 4) state.underline = true;
    else if (code === 7) state.inverse = true;
    else if (code === 22) Object.assign(state, { bold: false, dim: false });
    else if (code === 23) state.italic = false;
    else if (code === 24) state.underline = false;
    else if (code === 27) state.inverse = false;
    else if (code >= 30 && code <= 37) state.fg = basicColors[code - 30];
    else if (code >= 90 && code <= 97) state.fg = basicColors[code - 82];
    else if (code >= 40 && code <= 47) state.bg = basicColors[code - 40];
    else if (code >= 100 && code <= 107) state.bg = basicColors[code - 92];
    else if (code === 39) state.fg = null;
    else if (code === 49) state.bg = null;
    else if (code === 38 || code === 48) {
      const target = code === 38 ? "fg" : "bg";
      if (values[index + 1] === 5) {
        state[target] = color256(values[index + 2]);
        index += 2;
      } else if (values[index + 1] === 2) {
        state[target] = `rgb(${values[index + 2]},${values[index + 3]},${values[index + 4]})`;
        index += 4;
      }
    }
  }
}

function wide(character) {
  const code = character.codePointAt(0);
  return (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1faff);
}

function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Turn one tmux `capture-pane -e` screen into a fixed character grid of spans. */
function ansiToHtml(screen) {
  const state = { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false };
  const lines = screen.replace(/\n$/u, "").split("\n").slice(0, rows);
  return lines.map((line) => {
    let html = "";
    const pattern = /\u001b\[([\d;:]*)m|\u001b\][^\u0007]*\u0007|\u001b[^[\]]|([\s\S])/gu;
    for (const match of line.matchAll(pattern)) {
      if (match[1] !== undefined) {
        applySgr(state, match[1] ? match[1].split(/[;:]/u).map(Number) : []);
        continue;
      }
      const character = match[2];
      if (character === undefined) continue;
      let fg = state.fg ?? palette.foreground;
      let bg = state.bg ?? "transparent";
      if (state.inverse) [fg, bg] = [bg === "transparent" ? palette.background : bg, fg];
      // Font block glyphs leave gaps at this line height, so draw them as fills.
      const blocks = { "█": `${fg} 0 100%`, "▀": `${fg} 0 50%, ${bg} 50% 100%`, "▄": `${bg} 0 50%, ${fg} 50% 100%` };
      if (blocks[character]) {
        html += `<span style="background:linear-gradient(${blocks[character]})"></span>`;
        continue;
      }
      const style = [
        `color:${fg}`,
        bg !== "transparent" ? `background:${bg}` : "",
        state.bold ? "font-weight:700" : "",
        state.dim ? "opacity:.72" : "",
        state.italic ? "font-style:italic" : "",
        state.underline ? "text-decoration:underline" : "",
        wide(character) ? "width:18px" : "",
      ].filter(Boolean).join(";");
      html += `<span style="${style}">${character === " " ? "&nbsp;" : escapeHtml(character)}</span>`;
    }
    return `<div class="row">${html}</div>`;
  }).join("");
}

function framePage(screenHtml, caption) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; background: ${palette.background}; }
    body { width: ${terminalSize.width}px; height: ${terminalSize.height}px; overflow: hidden; font-family: Menlo, "SF Mono", monospace; }
    .bar { display: flex; justify-content: space-between; padding: 26px 28px 0; color: ${palette.muted}; font-size: 12px; letter-spacing: .08em; }
    .screen { margin: 16px 28px 0; }
    .row { height: 20px; white-space: pre; font-size: 15px; line-height: 20px; }
    .row span { display: inline-block; width: 9px; height: 20px; overflow: visible; vertical-align: top; }
    .caption { position: absolute; left: 28px; bottom: 26px; color: ${palette.muted}; font-size: 12px; }
  </style></head><body>
    <div class="bar"><span>MOONDOG / LISTENING ROOM</span><span>FICTIONAL DEMO DATA</span></div>
    <div class="screen">${screenHtml}</div>
    <div class="caption">${escapeHtml(caption)}</div>
  </body></html>`;
}

function tmuxRunner(socket) {
  return async (...args) => (await execFileAsync("tmux", ["-L", socket, ...args])).stdout;
}

async function waitForScreen(tmux, text, { timeout = 20_000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const screen = await tmux("capture-pane", "-p", "-t", "capture");
    if (screen.includes(text)) return;
    await delay(150);
  }
  throw new Error(`The TUI never showed "${text}".`);
}

async function type(tmux, text) {
  await tmux("send-keys", "-t", "capture", "-l", text);
}

async function press(tmux, ...keys) {
  for (const key of keys) {
    await tmux("send-keys", "-t", "capture", key);
    await delay(120);
  }
}

async function captureTerminal({ root, browser, profile }) {
  const archivePath = path.join(root, "fictional-history.zip");
  await writeFictionalSpotifyHistoryArchive({ outputPath: archivePath });
  const home = path.join(root, "home");
  await mkdir(home, { recursive: true });
  const environment = {
    HOME: home,
    PATH: process.env.PATH,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    LANG: "en_US.UTF-8",
    MOONDOG_STATE_HOME: path.join(home, "state"),
    MOONDOG_CONFIG_HOME: path.join(home, "config"),
    MOONDOG_APPLE_IMPORTS_ROOT: path.join(home, "apple", "imports"),
    MOONDOG_APPLE_PROJECTION_PATH: path.join(home, "apple", "projection.sqlite"),
    MOONDOG_THEME: "charcoal",
    MOONDOG_MOTION: "off",
    MOONDOG_LYRICS: "off",
  };
  const socket = `moondog-capture-${process.pid}`;
  const tmux = tmuxRunner(socket);
  const command = [process.execPath, "--disable-warning=ExperimentalWarning", path.join(repositoryRoot, "scripts", "moondog.mjs")]
    .map((part) => `'${part.replaceAll("'", "'\\''")}'`).join(" ");
  const exports = Object.entries(environment).map(([key, value]) => `${key}='${value.replaceAll("'", "'\\''")}'`).join(" ");
  const shots = [];
  try {
    await tmux("new-session", "-d", "-s", "capture", "-x", String(columns), "-y", String(rows), `env -i ${exports} ${command}`);
    await waitForScreen(tmux, "your listening room");
    await type(tmux, `/import ${archivePath}`);
    await press(tmux, "Enter");
    await waitForScreen(tmux, "Review this import");
    await press(tmux, "Enter");
    await waitForScreen(tmux, "Your listening profile");

    // Profile: open the evidence behind one fictional track.
    await type(tmux, "Midnight");
    await waitForScreen(tmux, "1/");
    await press(tmux, "Enter");
    await waitForScreen(tmux, "Why it's here");
    await type(tmux, "why");
    await press(tmux, "Enter");
    await waitForScreen(tmux, "Which evidence?");
    await press(tmux, "Enter");
    await waitForScreen(tmux, "What it can't tell me");
    shots.push({ name: "moondog-tui-profile.png", screen: await tmux("capture-pane", "-p", "-e", "-t", "capture"), caption: "Every reading shows its evidence, and what that evidence cannot tell." });

    // Home: back to the record sleeve with a profile ready.
    await press(tmux, "Escape");
    await delay(300);
    await type(tmux, "/home");
    await press(tmux, "Enter");
    await waitForScreen(tmux, "Listening profile");
    await delay(500);
    shots.push({ name: "moondog-tui-home.png", screen: await tmux("capture-pane", "-p", "-e", "-t", "capture"), caption: "Listen, inspect, revise. Your history stays yours." });
  } finally {
    await tmux("kill-server").catch(() => {});
  }

  const files = [];
  for (const shot of shots) {
    const pagePath = path.join(root, `${shot.name}.html`);
    await writeFile(pagePath, framePage(ansiToHtml(shot.screen), shot.caption), "utf8");
    const outputPath = path.join(demoDirectory, shot.name);
    await screenshot({ browser, url: pathToFileURL(pagePath).href, outputPath, size: terminalSize, profile });
    const bytes = await readFile(outputPath);
    files.push({
      path: shot.name,
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  const metadataPath = path.join(demoDirectory, "moondog-tui-captures.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  metadata.captured_on = new Date().toISOString().slice(0, 10);
  metadata.source = "Actual Moondog TUI output in a private tmux session, rendered cell by cell in headless Chrome";
  metadata.files = files;
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  return files.map((file) => file.path);
}

async function capturePreviews({ browser, profile }) {
  const page = (name) => pathToFileURL(path.join(demoDirectory, name)).href;
  const previews = [
    ["moondog-tasteprint-preview.png", `${page("moondog-tasteprint-demo.html")}?capture=1#taste-shape`],
    ["moondog-time-machine-preview.png", `${page("moondog-tasteprint-demo.html")}#time-machine`],
    ["moondog-listening-patterns-preview.png", `${page("moondog-tasteprint-demo.html")}#listening-patterns`],
    ["moondog-tasteprint-card-preview.png", page("moondog-tasteprint-card-demo.html")],
  ];
  for (const [name, url] of previews) {
    // One-shot headless screenshots render blank when the URL has a fragment,
    // so load the page in a full-size frame that scrolls itself instead.
    const wrapperPath = path.join(profile, "..", `${name}.html`);
    await writeFile(wrapperPath, `<!doctype html><body style="margin:0;overflow:hidden"><iframe src="${url}" scrolling="no" style="display:block;border:0;width:${previewSize.width}px;height:${previewSize.height}px"></iframe></body>`, "utf8");
    await screenshot({ browser, url: pathToFileURL(wrapperPath).href, outputPath: path.join(demoDirectory, name), size: previewSize, profile });
  }
  return previews.map(([name]) => name);
}

const root = await mkdtemp(path.join(tmpdir(), "moondog-demo-screens-"));
try {
  const browser = await resolveBrowser();
  const profile = path.join(root, "browser");
  const written = [
    ...await captureTerminal({ root, browser, profile }),
    ...await capturePreviews({ browser, profile }),
  ];
  process.stdout.write(`Captured ${written.join(", ")} into assets/demo. Inspect each image before committing.\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
