// A frame-exact recorder: a headless Chromium whose page time is moved by hand, one frame at a time, with
// a picture taken after each step. Motion comes out the same on any machine, however slow the pictures are.
// Chromium's own begin-frame control would do this, but it is not supported on macOS.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// The page's own time: timers, Date, performance.now and the stamp of each animation frame run on a clock
// the recorder advances. CSS animations, transitions and element.animate() are held and placed on that
// clock through the Web Animations API. Smooth scrolling and video stay on real time; the window uses neither.
export const CLOCK = `(() => {
  if (window.__film) return;
  const native = { setTimeout: window.setTimeout.bind(window), raf: window.requestAnimationFrame.bind(window), Date: window.Date, Channel: window.MessageChannel };
  const epoch = __EPOCH__;
  // The same small unevenness in every take: typing and reading pace come from Math.random.
  let seed = 0x6d6f6f6e;
  Math.random = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  // Every moment on this clock is a whole number of ticks, 1024 to a millisecond, so a wait added to a
  // moment and taken away again is the same wait exactly. With rounding, a page that counts down what is
  // left of a wait (the scene's clock does) can be left with a sliver too small to move this clock, and
  // it never ends: real time always passes, this time passes only as far as a timer asks.
  const TICKS = 1024;
  let now = 0;
  let asked = 0;
  let sequence = 0;
  const timers = new Map();
  const add = (run, delay, repeat, args) => {
    const id = (sequence += 1);
    const wait = Math.ceil(Math.max(0, Number(delay) || 0) * TICKS) / TICKS;
    timers.set(id, { id, at: now + wait, run, every: repeat ? Math.max(1, wait) : 0, args });
    return id;
  };
  window.setTimeout = (run, delay, ...args) => add(run, delay, false, args);
  window.setInterval = (run, delay, ...args) => add(run, delay, true, args);
  window.clearTimeout = window.clearInterval = (id) => { timers.delete(id); };
  window.requestIdleCallback = (run) => add(() => run({ didTimeout: false, timeRemaining: () => 8 }), 1, false, []);
  window.cancelIdleCallback = (id) => { timers.delete(id); };
  window.requestAnimationFrame = (run) => native.raf(() => run(now));
  performance.now = () => now;
  window.Date = class extends native.Date {
    constructor(...given) { if (given.length) super(...given); else super(epoch + now); }
    static now() { return epoch + now; }
  };
  // Lets every task already queued run: messages between frames, loads, promise chains.
  const settle = () => new Promise((resolve) => native.setTimeout(resolve, 0));
  // Every animation the document runs, with the moment on the film's clock when it began. An animation
  // that CSS itself pauses (animation-play-state) keeps its place until CSS lets it run.
  const held = new Map();
  const pausedByStyle = (animation) => {
    if (typeof CSSAnimation === "undefined" || !(animation instanceof CSSAnimation)) return false;
    const target = animation.effect?.target;
    if (!target) return false;
    const style = getComputedStyle(target, animation.effect.pseudoElement || undefined);
    const names = style.animationName.split(",").map((name) => name.trim());
    const states = style.animationPlayState.split(",").map((state) => state.trim());
    const index = names.indexOf(animation.animationName);
    return index >= 0 && states[index % states.length] === "paused";
  };
  function place() {
    for (const animation of document.getAnimations()) {
      if (held.has(animation) || animation.playState === "finished") continue;
      if (animation.timeline && animation.timeline !== document.timeline) continue;
      held.set(animation, { start: now - (pausedByStyle(animation) ? Number(animation.currentTime) || 0 : 0), at: null });
    }
    for (const [animation, entry] of held) {
      if (animation.playState === "idle" || !animation.effect) { held.delete(animation); continue; }
      let at = now - entry.start;
      if (pausedByStyle(animation)) { at = entry.at ?? at; entry.start = now - at; }
      entry.at = at;
      if (at >= Number(animation.effect.getComputedTiming().endTime)) { held.delete(animation); animation.finish(); continue; }
      if (animation.playState !== "paused") animation.pause();
      if (animation.currentTime !== at) animation.currentTime = at;
    }
  }
  // An animation that starts between two steps is held within one real frame.
  const watch = () => { try { place(); } catch (error) { console.error(error); } native.raf(watch); };
  native.raf(watch);
  window.__film = {
    get now() { return now; },
    get animations() { return held.size; },
    settle,
    async advance(ms) {
      asked += ms;
      const target = Math.max(now, Math.round(asked * TICKS) / TICKS);
      // How many timers have run without the clock moving. A page that asks for no time, again and
      // again, would hold this frame for ever; the film stops and says so.
      let still = 0;
      for (;;) {
        let next = null;
        for (const timer of timers.values()) if (timer.at <= target && (!next || timer.at < next.at || (timer.at === next.at && timer.id < next.id))) next = timer;
        if (!next) break;
        if (next.at > now) still = 0;
        else if ((still += 1) > 2000) throw new Error("The film's clock is stuck at " + now + " ms in " + location.pathname + ": a timer keeps asking for no time");
        now = Math.max(now, next.at);
        if (next.every) next.at += next.every; else timers.delete(next.id);
        try { next.run(...next.args); } catch (error) { console.error(error); }
        place();
        await settle();
      }
      now = target;
      place();
      // Frames inside this one keep the same time. A frame that can't be reached has no clock to move.
      for (const frame of document.querySelectorAll("iframe")) {
        let inner = null;
        try { inner = frame.contentWindow.__film; } catch {}
        if (inner) await inner.advance(ms);
      }
      await settle();
      place();
    },
    // Resolves once the page has drawn this moment: two real frames, so canvases and styles have landed.
    painted: () => new Promise((resolve) => native.raf(() => native.raf(() => resolve()))),
  };
})();`;

// A frame at full size takes under a second. A call the browser leaves unanswered this long is a stall,
// and the recorder stops with its name instead of waiting for ever.
const QUIET_MS = 120_000;

function connect(url) {
  const socket = new WebSocket(url);
  let last = 0;
  const waiting = new Map();
  const listeners = new Set();
  const settle = (id) => { const call = waiting.get(id); waiting.delete(id); clearTimeout(call?.timer); return call; };
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && waiting.has(message.id)) {
      const { resolve, reject } = settle(message.id);
      if (message.error) reject(new Error(`${message.error.message}${message.error.data ? `: ${message.error.data}` : ""}`));
      else resolve(message.result);
    } else for (const listener of listeners) listener(message);
  });
  socket.addEventListener("close", () => { for (const id of [...waiting.keys()]) settle(id).reject(new Error("The browser closed its connection")); });
  const opened = new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", () => reject(new Error("Couldn't reach the browser")), { once: true }); });
  return {
    opened,
    send(method, params = {}, sessionId) {
      const id = (last += 1);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { settle(id); reject(new Error(`The browser didn't answer ${method} in ${QUIET_MS / 1000} s`)); }, QUIET_MS);
        waiting.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    on(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    close() { socket.close(); },
  };
}

// Opens one page. frame() advances the page's time by one frame, waits for it to be drawn and returns
// its picture.
export async function openRecorder({ browser, width, height, scale = 1, fps = 60, epoch = Date.UTC(2026, 10, 22, 6, 40), format = "png", quality = 95 }) {
  const profile = await mkdtemp(path.join(tmpdir(), "moondog-film-"));
  const child = spawn(browser, ["--headless", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--hide-scrollbars", "--mute-audio",
    "--no-first-run", "--disable-background-networking", "--force-color-profile=srgb", "--disable-checker-imaging", "--run-all-compositor-stages-before-draw", `--window-size=${width},${height}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const address = await new Promise((resolve, reject) => {
    let text = "";
    child.stderr.on("data", (chunk) => { text += chunk; const found = /DevTools listening on (ws:\/\/\S+)/u.exec(text); if (found) resolve(found[1]); });
    child.once("exit", (code) => reject(new Error(`The browser left with ${code}: ${text.slice(-400)}`)));
  });
  const cdp = connect(address);
  await cdp.opened;
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const send = (method, params) => cdp.send(method, params, sessionId);
  const problems = [];
  cdp.on((message) => {
    if (message.sessionId !== sessionId) return;
    if (message.method === "Runtime.exceptionThrown") problems.push(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text);
    if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") problems.push(message.params.args.map((arg) => arg.value ?? arg.description).join(" "));
  });
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: false });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: CLOCK.replace("__EPOCH__", String(epoch)) });
  const interval = 1000 / fps;
  let last = null;
  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  };
  const draw = async () => {
    await evaluate("window.__film.painted()");
    const { data } = await send("Page.captureScreenshot", { format, ...(format === "jpeg" ? { quality } : {}), optimizeForSpeed: true });
    return Buffer.from(data, "base64");
  };
  return {
    problems, evaluate, interval,
    async open(url) {
      const loaded = new Promise((resolve) => { const off = cdp.on((message) => { if (message.sessionId === sessionId && message.method === "Page.loadEventFired") { off(); resolve(); } }); });
      await send("Page.navigate", { url });
      await loaded;
    },
    // One frame: the page's time moves on, the real mouse goes where the film's pointer is, so what is
    // under it lights as it would under a hand, and the picture is taken once the page has drawn.
    async frame({ picture = true, mouse = null } = {}) {
      await evaluate(`window.__film.advance(${interval})`);
      if (mouse) {
        const point = await evaluate(mouse);
        const next = point ? `${point.x},${point.y}` : null;
        if (next !== last) {
          last = next;
          await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point?.x ?? 4, y: point?.y ?? 4 });
        }
      }
      return picture ? draw() : null;
    },
    async close() {
      cdp.close();
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
      await rm(profile, { recursive: true, force: true });
    },
  };
}
