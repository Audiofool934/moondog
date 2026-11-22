#!/usr/bin/env node
// Renders the film (stage.mjs): builds its documents, plays it in a headless Chromium a frame at a time
// (recorder.mjs), and mixes its sound from the page's own music at the moments the stage noted.
//
//   node film/render.mjs               the full cut: 60 frames a second at 3840 by 2160, and a 1920 by 1080 copy
//   node film/render.mjs --draft       30 frames a second at 1920 by 1080, in a few minutes
//   node film/render.mjs --out <dir>   where the files go; by default outputs/promo-video beside site/
//
// It needs ffmpeg, and a Chromium: MOONDOG_FILM_BROWSER names one, and Playwright's cached headless
// shell is found on its own. Nothing here is published; the page's build leaves the film out.
import { execFile, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { openRecorder } from "./recorder.mjs";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const site = path.resolve(here, "..");
const dist = path.join(site, "dist");
const args = process.argv.slice(2);
const draft = args.includes("--draft");
const out = path.resolve(args.includes("--out") ? args[args.indexOf("--out") + 1] : path.join(site, "..", "outputs", "promo-video"));
const fps = draft ? 30 : 60;
const scale = draft ? 1 : 2;
const name = draft ? "moondog-film-draft" : "moondog-film";

function findBrowser() {
  if (process.env.MOONDOG_FILM_BROWSER) return process.env.MOONDOG_FILM_BROWSER;
  const cache = path.join(homedir(), "Library", "Caches", "ms-playwright");
  const shells = existsSync(cache) ? readdirSync(cache).filter((entry) => entry.startsWith("chromium_headless_shell-")).sort().reverse() : [];
  for (const shell of shells) {
    const found = readdirSync(path.join(cache, shell)).map((folder) => path.join(cache, shell, folder, "chrome-headless-shell")).find(existsSync);
    if (found) return found;
  }
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (existsSync(chrome)) return chrome;
  throw new Error("No Chromium found. Set MOONDOG_FILM_BROWSER to one.");
}

// The page's files, served from dist/ for as long as the film plays.
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".m4a": "audio/mp4", ".map": "application/json" };
const server = createServer(async (request, response) => {
  const asked = decodeURIComponent(new URL(request.url, "http://film").pathname);
  try {
    const body = await readFile(path.join(dist, asked === "/" ? "index.html" : asked));
    response.writeHead(200, { "content-type": types[path.extname(asked)] ?? "text/html" });
    response.end(body);
  } catch { response.writeHead(404); response.end(); }
});

// The sound: each cue's file from its moment on. A song fades as the next one comes in, and the last
// one fades with the closing card. Where two songs overlap, a limiter keeps the peak under -1.5 dB.
async function mix(cues, length, video, target) {
  const sounds = cues.filter((cue) => cue.sound);
  const seconds = (ms) => (ms / 1000).toFixed(3);
  const inputs = sounds.flatMap((cue) => ["-i", path.join(dist, cue.sound)]);
  const chains = sounds.map((cue, index) => {
    const later = sounds.slice(index + 1).find((next) => next.at > cue.at);
    const leaves = later ? { from: later.at - cue.at, over: 1400 } : { from: length - 2800 - cue.at, over: 2800 };
    // The ident keeps its own first moment, the stylus landing; a song eases in.
    const fades = `${/ident/u.test(cue.sound) ? "" : ",afade=t=in:st=0:d=0.35"},afade=t=out:st=${seconds(Math.max(0, leaves.from))}:d=${seconds(leaves.over)}`;
    return `[${index + 1}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo${fades},adelay=${cue.at}:all=1[s${index}]`;
  });
  const graph = `${chains.join(";")};${sounds.map((_, index) => `[s${index}]`).join("")}amix=inputs=${sounds.length}:normalize=0:duration=longest,atrim=0:${seconds(length)},asetpts=N/SR/TB,alimiter=limit=0.84:level=disabled[sound]`;
  await run("ffmpeg", ["-loglevel", "error", "-y", "-i", video, ...inputs, "-filter_complex", graph, "-map", "0:v", "-map", "[sound]",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", target]);
}

const built = spawn(process.execPath, [path.join(site, "build.mjs"), "--offline", "--film"], { stdio: ["ignore", "ignore", "inherit"] });
if (await new Promise((resolve) => built.once("exit", resolve)) !== 0) throw new Error("The film's documents didn't build.");
await mkdir(out, { recursive: true });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const recorder = await openRecorder({ browser: findBrowser(), width: 1920, height: 1080, scale, fps });
const silent = path.join(out, `${name}.silent.mp4`);
const encoder = spawn("ffmpeg", ["-loglevel", "error", "-y", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "png", "-i", "-",
  "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p", "-c:v", "libx264", "-preset", draft ? "veryfast" : "slow", "-crf", draft ? "18" : "13",
  "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", silent], { stdio: ["pipe", "inherit", "inherit"] });
const encoded = new Promise((resolve) => encoder.once("exit", resolve));
let stage = null;
const began = Date.now();
try {
  await recorder.open(`http://127.0.0.1:${server.address().port}/film.html`);
  // The windows load and settle before the film begins; those frames are not kept.
  for (let waited = 0; !(await recorder.evaluate("window.__stage?.started === true")); waited += 1) {
    if (waited > fps * 30) throw new Error(`The film never began: ${JSON.stringify(recorder.problems.slice(0, 4))}`);
    await recorder.frame({ picture: false });
  }
  let frames = 0;
  for (;;) {
    const picture = await recorder.frame({ mouse: "window.__stage.mouse()" });
    if (!encoder.stdin.write(picture)) await new Promise((resolve) => encoder.stdin.once("drain", resolve));
    frames += 1;
    if (frames % (fps * 10) === 0) console.log(`${frames / fps} s of film in ${Math.round((Date.now() - began) / 1000)} s`);
    if (await recorder.evaluate("window.__stage.done === true")) break;
    if (frames > fps * 120) throw new Error("The film ran past two minutes.");
  }
  stage = await recorder.evaluate("({ cues: window.__stage.cues, length: window.__stage.length, failed: window.__stage.failed ?? null })");
  stage.frames = frames;
  stage.problems = recorder.problems;
} catch (error) {
  // Half a film is no use to anyone, and its file looks like a render still at work.
  stage = null;
  process.exitCode = 1;
  console.error(error);
} finally {
  encoder.stdin.end();
  await encoded;
  await recorder.close();
  server.close();
}
if (!stage) { await rm(silent, { force: true }); process.exit(1); }
if (stage.failed) throw new Error(`The film stopped: ${stage.failed}`);
await writeFile(path.join(out, `${name}.cues.json`), `${JSON.stringify(stage, null, 2)}\n`);
const film = path.join(out, `${name}.mp4`);
await mix(stage.cues, stage.length, silent, film);
await rm(silent, { force: true });
console.log(`${film}: ${(stage.length / 1000).toFixed(1)} s, ${stage.frames} frames at ${fps} a second, in ${Math.round((Date.now() - began) / 1000)} s`);
console.log(`cues: ${stage.cues.map((cue) => `${(cue.at / 1000).toFixed(2)} ${path.basename(cue.sound)}`).join(", ")}`);
if (stage.problems.length) console.log(`the page reported: ${JSON.stringify(stage.problems.slice(0, 6))}`);
if (!draft) {
  const small = path.join(out, `${name}-1080p.mp4`);
  await run("ffmpeg", ["-loglevel", "error", "-y", "-i", film, "-vf", "scale=1920:1080:flags=lanczos", "-c:v", "libx264", "-preset", "slow", "-crf", "16",
    "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-c:a", "copy", "-movflags", "+faststart", small]);
  console.log(small);
}
