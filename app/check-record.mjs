// Exercise the shared renderer in real Electron with fictional data, without signing in or
// building an app bundle. Captures and metrics go to app/release/record-check/{before,after}.
// Run node app/check-record.mjs; --baseline records the old behavior without assertions.
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";
import * as esbuild from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const outdir = path.join(here, "dist");
await mkdir(outdir, { recursive: true });
await copyFile(path.join(here, "renderer/index.html"), path.join(outdir, "index.html"));
await esbuild.build({ entryPoints: { renderer: path.join(here, "renderer/renderer.mjs") }, bundle: true,
  format: "esm", platform: "browser", target: "chrome130", outdir, sourcemap: true, logLevel: "warning" });
const profile = await mkdtemp(path.join(os.tmpdir(), `moondog-record-check-${process.pid}-`));
let child;
try {
  process.exitCode = await new Promise((resolve, reject) => {
    child = spawn(electron, [path.join(here, "harness-record.mjs"), ...process.argv.slice(2)], {
      stdio: "inherit", env: { ...process.env, MOONDOG_RECORD_CHECK_PROFILE: profile },
    });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child.kill(signal));
  });
} finally {
  await rm(profile, { recursive: true, force: true });
}
