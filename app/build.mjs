// Builds the window's page into dist/: the renderer bundle, its styles, and index.html.
// The room itself is not bundled; it runs from the source tree in the room process.
import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const outdir = path.join(here, "dist");

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await copyFile(path.join(here, "renderer", "index.html"), path.join(outdir, "index.html"));
// The Apple Music helper for `npm start`, built again only when its source changed.
if (process.platform === "darwin") {
  const { buildMusicHelper } = await import("./native/build.mjs");
  const source = path.join(here, "native", "music.swift");
  const built = path.join(here, "native", "build", "apps.noindex", "Moondog Music.app", "Contents", "MacOS", "moondog-music");
  const stale = await Promise.all([stat(source), stat(built).catch(() => null)]).then(([a, b]) => !b || a.mtimeMs > b.mtimeMs);
  if (stale) await buildMusicHelper();
}
await esbuild.build({
  entryPoints: { renderer: path.join(here, "renderer", "renderer.mjs") },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome130",
  outdir,
  sourcemap: true,
  logLevel: "warning",
});
