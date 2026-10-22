// Draws the window against the stand-in core in harness-preload.cjs and captures each state in
// light and dark, so a change to the window can be looked at without a model, a music service,
// or the listener's own data. Not packaged.
//
//   npm run harness                                  every state, light and dark, 1240x800
//   MOONDOG_HARNESS_STATES=empty,reply npm run harness
//   MOONDOG_HARNESS_THEMES=dark MOONDOG_HARNESS_SIZE=900x700 npm run harness
//   MOONDOG_HARNESS_LOCALE=zh npm run harness       the window's words in another language
//   MOONDOG_HARNESS_SHOW=1 npm run harness           a visible window to try by hand
//   MOONDOG_HARNESS_EVAL=check.js npm run harness    runs a script in the page after each state, before the
//                                                    capture, and prints what it returns (for checks)
import { app, BrowserWindow, nativeTheme } from "electron";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = process.env.MOONDOG_HARNESS_OUT || path.join(here, "release", "harness");
const [width, height] = (process.env.MOONDOG_HARNESS_SIZE || "1240x800").split("x").map(Number);
const themes = (process.env.MOONDOG_HARNESS_THEMES || "light,dark").split(",").filter(Boolean);
const locale = process.env.MOONDOG_HARNESS_LOCALE || "en";
const settle = Number(process.env.MOONDOG_HARNESS_SETTLE || 900);
const show = process.env.MOONDOG_HARNESS_SHOW === "1";
const check = process.env.MOONDOG_HARNESS_EVAL ? readFileSync(process.env.MOONDOG_HARNESS_EVAL, "utf8") : null;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Each run keeps its own throwaway profile, so its panel widths and choices never reach the real
// app's, and two runs at once don't share one.
const profile = path.join(os.tmpdir(), `moondog-harness-${process.pid}`);
app.setPath("userData", profile);
app.on("quit", () => rmSync(profile, { recursive: true, force: true }));
// Chromium can write into a profile after quit; earlier runs' leftovers go now, unless that run is still alive.
for (const name of readdirSync(os.tmpdir())) {
  const pid = Number(name.match(/^moondog-harness-(\d+)$/u)?.[1]);
  if (!pid || pid === process.pid) continue;
  try { process.kill(pid, 0); } catch { rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true }); }
}
if (!show) setTimeout(() => { process.stderr.write("[harness] timed out\n"); app.exit(1); }, 240_000);

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width, height, useContentSize: true, show, title: "Moondog harness",
    titleBarStyle: "hiddenInset", trafficLightPosition: { x: 18, y: 15 },
    webPreferences: {
      preload: path.join(here, "harness-preload.cjs"),
      // The stand-in core shares the page's context. The shipped window isolates it.
      contextIsolation: false, sandbox: false, backgroundThrottling: false,
    },
  });
  window.webContents.on("console-message", (event) => {
    if (event.level === "error" || event.level === "warning") process.stderr.write(`[page] ${event.message}\n`);
  });
  const load = () => window.loadFile(path.join(here, "dist", "index.html"), { query: { locale } });
  if (show) { await load(); return; }

  await mkdir(out, { recursive: true });
  await load();
  // A state can carry its own size, as narrow does.
  const states = process.env.MOONDOG_HARNESS_STATES?.split(",").filter(Boolean)
    ?? (await window.webContents.executeJavaScript("window.__harness.states")).map((name) => (name === "narrow" ? "narrow@760x600" : name));
  for (const theme of themes) {
    nativeTheme.themeSource = theme;
    for (const entry of states) {
      // A state name may end in @WIDTHxHEIGHT to draw it at another size.
      const [name, size] = entry.split("@");
      const [w, h] = size ? size.split("x").map(Number) : [width, height];
      window.setContentSize(w, h);
      // Every capture starts from a fresh page at its own size: the page decides which panels fit when it loads.
      await load();
      await wait(350);
      // A state that fails is reported and skipped, so one mistake doesn't hold the run open.
      const actions = await window.webContents.executeJavaScript(`window.__harness.setState(${JSON.stringify(name)})`)
        .catch((error) => { process.stderr.write(`[harness] ${entry}: ${error.message}\n`); return { skip: true }; });
      if (actions?.skip) continue;
      if (actions?.hover) {
        // The page draws a state on its next frame; the pointer aims once it has.
        await wait(250);
        const point = await window.webContents.executeJavaScript(`(() => { const r = document.querySelector(${JSON.stringify(actions.hover)})?.getBoundingClientRect();
          return r ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null; })()`);
        if (point) window.webContents.sendInputEvent({ type: "mouseMove", ...point });
      }
      if (check) {
        const result = await window.webContents.executeJavaScript(`(async () => { ${check}\n })()`).catch((error) => ({ error: String(error) }));
        process.stdout.write(`[check] ${entry} ${theme} ${JSON.stringify(result)}\n`);
      }
      await wait(settle);
      const image = await window.webContents.capturePage();
      const file = path.join(out, `${entry.replace(/[@x]/gu, (c) => (c === "@" ? "-" : "x"))}-${theme}.png`);
      await writeFile(file, image.toPNG());
      process.stdout.write(`${path.relative(here, file)}\n`);
    }
  }
  window.destroy();
  app.quit();
}, (error) => { process.stderr.write(`${error?.stack ?? error}\n`); app.exit(1); });
