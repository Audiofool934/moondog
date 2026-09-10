#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { startMoondogStudio } from "../src/surfaces/web/studio.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const defaultOutputPath = path.join(
  repositoryRoot,
  "assets",
  "demo",
  "moondog-studio-tour.gif",
);
const captureWidth = 1240;
const captureHeight = 840;
const screenshotTimeoutMilliseconds = 15_000;
const fixedTimestamp = "2026-09-03T09:00:00.000Z";

function outputArgument(args) {
  const values = [...args];
  if (values.length === 0) return defaultOutputPath;
  if (values.length !== 2 || values[0] !== "--output") {
    throw new Error("Usage: capture-studio-tour [--output <gif-path>].");
  }
  return path.resolve(values[1]);
}

async function executable(filePath) {
  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function executableOnPath(name) {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    if (await executable(candidate)) return candidate;
  }
  return null;
}

async function resolveBrowser() {
  const explicit = process.env.MOONDOG_CAPTURE_BROWSER;
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (!(await executable(resolved))) {
      throw new Error("MOONDOG_CAPTURE_BROWSER is not an executable file.");
    }
    return resolved;
  }
  const absoluteCandidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  for (const candidate of absoluteCandidates) {
    if (await executable(candidate)) return candidate;
  }
  for (const name of [
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
  ]) {
    const candidate = await executableOnPath(name);
    if (candidate) return candidate;
  }
  throw new Error(
    "A Chrome or Chromium executable is required. Set MOONDOG_CAPTURE_BROWSER to its absolute path.",
  );
}

async function terminate(child, exited) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([exited, delay(2_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([exited, delay(2_000)]);
  }
}

async function waitForScreenshot(filePath, childState) {
  const deadline = Date.now() + screenshotTimeoutMilliseconds;
  while (Date.now() < deadline) {
    try {
      const metadata = await stat(filePath);
      if (metadata.size >= 24) return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (childState.value) {
      throw new Error(
        `Headless browser exited before writing a screenshot: ${childState.value.code ?? childState.value.signal ?? "unknown"}.`,
      );
    }
    await delay(100);
  }
  throw new Error("Headless browser timed out before writing a screenshot.");
}

function pngDimensions(buffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature)) {
    throw new Error("Studio capture is not a PNG file.");
  }
  if (buffer.subarray(12, 16).toString("ascii") !== "IHDR") {
    throw new Error("Studio capture has no PNG IHDR header.");
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

async function captureScreenshot({ browserPath, url, outputPath, root, name }) {
  const profilePath = path.join(root, `browser-${name}`);
  await mkdir(profilePath, { recursive: true });
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    `--window-size=${captureWidth},${captureHeight}`,
    "--virtual-time-budget=1800",
    `--user-data-dir=${profilePath}`,
    `--screenshot=${outputPath}`,
    url,
  ];
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    args.unshift("--no-sandbox");
  }
  const child = spawn(browserPath, args, {
    stdio: ["ignore", "ignore", "pipe"],
  });
  const stderr = [];
  let stderrBytes = 0;
  child.stderr.on("data", (chunk) => {
    if (stderrBytes >= 8_192) return;
    const bounded = chunk.subarray(0, 8_192 - stderrBytes);
    stderr.push(bounded);
    stderrBytes += bounded.length;
  });
  const childState = { value: null };
  const exited = new Promise((resolve) => {
    child.once("error", (error) => {
      childState.value = { error };
      resolve(childState.value);
    });
    child.once("exit", (code, signal) => {
      childState.value = { code, signal };
      resolve(childState.value);
    });
  });
  try {
    await waitForScreenshot(outputPath, childState);
  } catch (error) {
    const details = Buffer.concat(stderr).toString("utf8").trim();
    if (details) error.message = `${error.message}\n${details}`;
    throw error;
  } finally {
    await terminate(child, exited);
  }
  const screenshot = await readFile(outputPath);
  const dimensions = pngDimensions(screenshot);
  if (dimensions.width !== captureWidth || dimensions.height !== captureHeight) {
    throw new Error(
      `Studio capture must be ${captureWidth}x${captureHeight}, observed ${dimensions.width}x${dimensions.height}.`,
    );
  }
}

async function runCommand(command, args) {
  const child = spawn(command, args, {
    stdio: ["ignore", "ignore", "pipe"],
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  if (result.code !== 0) {
    const details = Buffer.concat(stderr).toString("utf8").trim();
    throw new Error(
      `${command} failed with ${result.code ?? result.signal ?? "unknown"}${details ? `: ${details}` : ""}.`,
    );
  }
}

function requireDemoProfile(profile) {
  if (
    profile?.profile_kind !== "synthetic_demo" ||
    profile?.demo_proof?.production_importer !== true ||
    profile?.demo_proof?.private_listener_data_read !== false ||
    profile?.demo_proof?.persistent_profile_writes !== false ||
    profile?.time_machine?.ready !== true ||
    profile?.listening_pulse?.ready !== true ||
    profile?.listening_pulse?.retained_span_months !== 36 ||
    profile?.listening_pulse?.active_month_count !== 15 ||
    profile?.listening_seasons?.ready !== true ||
    profile?.listening_seasons?.retained_season_count !== 13 ||
    profile?.listening_seasons?.active_season_count !== 12 ||
    profile?.listening_seasons?.preview_season_count !== 6 ||
    profile?.historical_returns?.ready !== true ||
    profile?.historical_returns?.return_track_count !== 4 ||
    profile?.listening_patterns?.ready !== true ||
    profile?.active_corrections !== 0
  ) {
    throw new Error("Studio did not return the expected zero-data demo profile.");
  }
}

const outputPath = outputArgument(process.argv.slice(2));
const temporaryRoot = await mkdtemp(
  path.join(tmpdir(), "moondog-studio-tour-"),
);
const browserPath = await resolveBrowser();
const imageMagick = await executableOnPath("magick");
if (!imageMagick) {
  throw new Error("ImageMagick 7 is required to compose the Studio tour GIF.");
}
const frames = {
  hero: path.join(temporaryRoot, "01-hero.png"),
  timeMachine: path.join(temporaryRoot, "02-time-machine.png"),
  listeningPulse: path.join(temporaryRoot, "03-listening-pulse.png"),
  listeningSeasons: path.join(temporaryRoot, "04-listening-seasons.png"),
  historicalReturns: path.join(temporaryRoot, "05-historical-returns.png"),
  listeningPatterns: path.join(temporaryRoot, "06-listening-patterns.png"),
  correction: path.join(temporaryRoot, "07-correction.png"),
};
const temporaryOutput = path.join(temporaryRoot, "moondog-studio-tour.gif");
let studio = null;

try {
  studio = await startMoondogStudio({
    demoOnly: true,
    temporaryRoot: path.join(temporaryRoot, "studio"),
    environment: {
      ...process.env,
      MOONDOG_STATE_HOME: path.join(temporaryRoot, "private-state-must-not-exist"),
      MOONDOG_CONFIG_HOME: path.join(temporaryRoot, "private-config-must-not-exist"),
    },
    now: () => new Date(fixedTimestamp),
    openStore: async () => {
      throw new Error("Studio tour capture must not open the private store.");
    },
  });
  const token = new URL(studio.url).searchParams.get("session");
  if (!token) throw new Error("Studio did not provide a session token.");
  const captureUrl = new URL(studio.url);
  captureUrl.searchParams.set("capture", "hero");
  await captureScreenshot({
    browserPath,
    url: captureUrl.href,
    outputPath: frames.hero,
    root: temporaryRoot,
    name: "hero",
  });

  const profileResponse = await fetch(new URL("/api/profile", studio.origin), {
    headers: { "X-Moondog-Session": token },
  });
  if (!profileResponse.ok) {
    throw new Error(`Studio profile request failed with ${profileResponse.status}.`);
  }
  const profile = await profileResponse.json();
  requireDemoProfile(profile);
  for (const [mode, outputPath] of [
    ["time-machine", frames.timeMachine],
    ["listening-pulse", frames.listeningPulse],
    ["listening-seasons", frames.listeningSeasons],
    ["historical-returns", frames.historicalReturns],
    ["listening-patterns", frames.listeningPatterns],
  ]) {
    const focusedCaptureUrl = new URL(captureUrl);
    focusedCaptureUrl.searchParams.set("capture", mode);
    await captureScreenshot({
      browserPath,
      url: focusedCaptureUrl.href,
      outputPath,
      root: temporaryRoot,
      name: mode,
    });
  }

  const correctionResponse = await fetch(
    new URL("/api/demo/corrections", studio.origin),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: studio.origin,
        "X-Moondog-Session": token,
      },
      body: JSON.stringify({
        entity_type: "artist",
        label: "Mara Vale",
        stance: "like",
      }),
    },
  );
  const corrected = await correctionResponse.json();
  if (
    !correctionResponse.ok ||
    corrected?.profile_kind !== "synthetic_demo" ||
    corrected?.active_corrections !== 1 ||
    corrected?.corrections?.[0]?.label !== "Mara Vale"
  ) {
    throw new Error("Studio did not apply the expected fictional correction.");
  }
  const correctionCaptureUrl = new URL(captureUrl);
  correctionCaptureUrl.searchParams.set("capture", "correction");
  await captureScreenshot({
    browserPath,
    url: correctionCaptureUrl.href,
    outputPath: frames.correction,
    root: temporaryRoot,
    name: "correction",
  });

  await runCommand(imageMagick, [
    "-delay",
    "220",
    frames.hero,
    "-delay",
    "190",
    frames.timeMachine,
    "-delay",
    "190",
    frames.listeningPulse,
    "-delay",
    "190",
    frames.listeningSeasons,
    "-delay",
    "190",
    frames.historicalReturns,
    "-delay",
    "190",
    frames.listeningPatterns,
    "-delay",
    "220",
    frames.correction,
    "-loop",
    "0",
    "-strip",
    "-dither",
    "None",
    "-colors",
    "256",
    "-layers",
    "Optimize",
    temporaryOutput,
  ]);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await rename(temporaryOutput, outputPath);
  const relativeOutput = path.relative(repositoryRoot, outputPath);
  process.stdout.write(
    `Captured synthetic Studio tour: ${relativeOutput}, ${captureWidth}x${captureHeight}, 7 frames, no private store or provider request.\n`,
  );
} finally {
  if (studio) await studio.close();
  await rm(temporaryRoot, { recursive: true, force: true });
}
