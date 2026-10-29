// Real Electron checks for the record's hover control and response to a quick scroll.
// Run with node check-record.mjs, which builds the renderer and cleans the profile after exit.
// This uses only the harness's fictional conversations and a disposable browser profile.
import assert from "node:assert/strict";
import { app, BrowserWindow, nativeTheme } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const baseline = process.argv.includes("--baseline");
const out = path.resolve(process.env.MOONDOG_RECORD_CHECK_OUT || path.join(here, "release", "record-check", baseline ? "before" : "after"));
const profile = process.env.MOONDOG_RECORD_CHECK_PROFILE;
if (!profile) throw new Error("Run node check-record.mjs so the harness profile is cleaned after Electron exits.");
app.setPath("userData", profile);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const timeout = setTimeout(() => app.exit(1), 90_000);
let window;
let failure = null;
const results = [];

async function check() {
try {
  await app.whenReady();
  await mkdir(out, { recursive: true });
  window = new BrowserWindow({ width: 1240, height: 800, useContentSize: true, show: true, title: "Moondog record check - fictional data",
    titleBarStyle: "hiddenInset", trafficLightPosition: { x: 18, y: 15 },
    webPreferences: { preload: path.join(here, "harness-preload.cjs"), contextIsolation: false, sandbox: false, backgroundThrottling: false } });
  const run = (code) => window.webContents.executeJavaScript(code);
  const capture = async (name) => writeFile(path.join(out, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  const point = (selector) => run(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  const click = async (selector) => {
    const at = await point(selector);
    window.webContents.sendInputEvent({ type: "mouseMove", ...at });
    window.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...at });
    window.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...at });
    await wait(180);
  };
  const load = async (state) => {
    await window.loadFile(path.join(here, "dist", "index.html"));
    await wait(200);
    await run(`window.__harness.setState(${JSON.stringify(state)})`);
    await wait(900);
    window.focus();
  };
  for (const theme of ["light", "dark"]) {
    nativeTheme.themeSource = theme;
    for (const state of ["empty", "long"]) {
      await load(state);
      window.webContents.sendInputEvent({ type: "mouseMove", ...await point("[data-record-frame]") });
      await wait(150);
      const hover = await run(`(() => { const b = document.querySelector('[data-expand]'); const s = getComputedStyle(b); const r = b.getBoundingClientRect(); return { display: s.display, opacity: Number(s.opacity), pointerEvents: s.pointerEvents, tabIndex: b.tabIndex, hit: document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('[data-expand]') === b }; })()`);
      await capture(`${theme}-${state}-hover`);
      results.push({ theme, state, hover });
      if (!baseline) {
        assert.notEqual(hover.display, "none", `${theme} ${state} expand is shown`);
        assert.equal(hover.opacity, 1, `${theme} ${state} expand is visible`);
        assert.equal(hover.hit, true, `${theme} ${state} expand is reachable`);
        assert.equal(hover.tabIndex, 0, `${theme} ${state} expand is keyboard reachable`);
        await click("[data-expand]");
        assert.equal(await run("document.querySelector('[data-immersive]').hidden"), false);
        await wait(400);
        await capture(`${theme}-${state}-immersive`);
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
        await wait(200);
        assert.equal(await run("document.querySelector('[data-immersive]').hidden"), true);
        if (state === "long") {
          await click("[data-record-button]");
          await wait(350);
          assert.equal(await run("document.querySelector('[data-record-button]').classList.contains('away')"), true);
          await click("[data-new]");
          await wait(600);
          assert.equal(await run("document.querySelector('[data-room]').classList.contains('empty')"), true);
          window.webContents.sendInputEvent({ type: "mouseMove", ...await point("[data-record-frame]") });
          await wait(150);
          assert.equal(await run("getComputedStyle(document.querySelector('[data-expand]')).opacity"), "1");
          assert.equal(await run("document.querySelector('[data-expand]').tabIndex"), 0);
          await capture(`${theme}-new-after-fold`);
        }
      }
    }
    await load("long");
    const at = await run("(() => { const r = document.querySelector('[data-scroll]').getBoundingClientRect(); return { x: Math.round(r.right - 70), y: Math.round(r.bottom - 100) }; })()");
    window.webContents.sendInputEvent({ type: "mouseMove", ...at });
    await run(`window.__recordSamples = []; window.__recordSampling = true; (() => { const s = document.querySelector('[data-scroll]'); const f = document.querySelector('[data-record-frame]'); const sample = () => { window.__recordSamples.push({ time: performance.now(), top: s.scrollTop, width: f.getBoundingClientRect().width }); if (window.__recordSampling) requestAnimationFrame(sample); }; requestAnimationFrame(sample); })()`);
    for (let i = 0; i < 10; i++) { window.webContents.sendInputEvent({ type: "mouseWheel", deltaY: 110, deltaX: 0, ...at }); await wait(16); }
    await wait(250);
    await capture(`${theme}-history-small`);
    const away = await run("({ top: document.querySelector('[data-scroll]').scrollTop, width: document.querySelector('[data-record-frame]').getBoundingClientRect().width })");
    for (let i = 0; i < 10; i++) { window.webContents.sendInputEvent({ type: "mouseWheel", deltaY: -110, deltaX: 0, ...at }); await wait(16); }
    await wait(1000);
    const samples = await run("window.__recordSampling = false; window.__recordSamples");
    const final = samples.at(-1);
    const reverse = samples.findIndex((s, i) => i && s.top > samples[i - 1].top + 1);
    const lastTravel = samples.findLastIndex((s, i) => i && Math.abs(s.top - samples[i - 1].top) > 0.5);
    const settled = samples.findIndex((s, i) => i >= lastTravel && Math.abs(s.width - final.width) < 1);
    const catchupMs = samples[settled].time - samples[lastTravel].time;
    const maxFrameGapMs = Math.max(...samples.slice(reverse + 1).map((s, i) => s.time - samples[reverse + i].time));
    const scroll = { away, final, reverse, catchupMs, maxFrameGapMs };
    results.push({ theme, scroll });
    await writeFile(path.join(out, `${theme}-scroll-samples.json`), JSON.stringify(samples, null, 2));
    await capture(`${theme}-history-home`);
    if (!baseline) {
      assert(away.width < final.width * 0.7, "wheel moved away far enough to shrink the record");
      assert(catchupMs < 70, `${theme} record follows the final scroll within a few frames (${catchupMs.toFixed(1)} ms)`);
    }
  }
} catch (error) {
  failure = error;
  process.stderr.write(`${error.stack}\n`);
} finally {
  await writeFile(path.join(out, "results.json"), JSON.stringify({ results, error: failure?.message ?? null }, null, 2)).catch(() => {});
  process.stdout.write(`${JSON.stringify(results)}\n`);
  window?.destroy();
  clearTimeout(timeout);
  app.exit(failure ? 1 : 0);
}
}
void check();
