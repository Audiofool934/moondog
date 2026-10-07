// Builds the project page into dist/.
// The room is the real TUI bundled for the browser: Node built-ins and the model and
// sign-in modules are swapped for the small stand-ins in room/shims/.
//
//   node build.mjs              build once (makes the fictional data snapshot if missing)
//   node build.mjs --snapshot   remake the snapshot first
//   node build.mjs --serve      rebuild on change and serve at http://localhost:8737
import { execFile } from "node:child_process";
import { access, cp, mkdir, readFile, rm, watch } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import * as esbuild from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const outdir = path.join(here, "dist");
const flags = new Set(process.argv.slice(2));
const shim = (name) => path.join(here, "room", "shims", name);
const builtins = {
  crypto: "crypto.mjs", fs: "fs.mjs", "fs/promises": "fs-promises.mjs", os: "os.mjs", path: "path.mjs",
  util: "util.mjs", events: "events.mjs", child_process: "misc.mjs", module: "misc.mjs", url: "misc.mjs",
  perf_hooks: "misc.mjs", "timers/promises": "misc.mjs",
};
const replaced = new Set(["model-catalog.mjs", "public-model-catalog.mjs", "authentication.mjs"]);
const staticFiles = ["index.html", "style.css", "static"];

const browserPlugin = {
  name: "moondog-browser",
  setup(build) {
    build.onResolve({ filter: /^(node:)?[a-z_/]+$/ }, ({ path: spec }) => {
      const name = builtins[spec.replace(/^node:/, "")];
      return name ? { path: shim(name) } : undefined;
    });
    build.onResolve({ filter: /runtime\/pi\/[a-z-]+\.mjs$/ }, ({ path: spec }) =>
      replaced.has(path.basename(spec)) ? { path: shim("catalog.mjs") } : undefined);
    // pi-tui unrefs its timers so Node can exit; browser timers are plain numbers.
    build.onLoad({ filter: /[\\/]@earendil-works[\\/]pi-tui[\\/]dist[\\/].+\.js$/ }, async ({ path: file }) => ({
      contents: (await readFile(file, "utf8")).replaceAll(".unref()", ".unref?.()"),
      loader: "js",
    }));
  },
};

const snapshotPath = path.join(here, "generated", "snapshot.json");
if (flags.has("--snapshot") || !(await access(snapshotPath).then(() => true, () => false))) {
  const { stdout } = await promisify(execFile)(process.execPath, [
    "--disable-warning=ExperimentalWarning", path.join(here, "room", "snapshot.mjs"),
  ]);
  process.stdout.write(stdout);
}

const copyStatic = () => Promise.all(staticFiles.map((name) =>
  cp(path.join(here, name), path.join(outdir, name), { recursive: true })));
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await copyStatic();

const options = {
  entryPoints: { page: path.join(here, "page.mjs") },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outdir,
  inject: [shim("process.mjs")],
  plugins: [browserPlugin],
  loader: { ".json": "json" },
  minify: !flags.has("--dev"),
  sourcemap: true,
  metafile: true,
  logLevel: "warning",
};

if (flags.has("--serve")) {
  const context = await esbuild.context(options);
  await context.watch();
  const { port } = await context.serve({ servedir: outdir, port: Number(process.env.PORT ?? 8737) });
  console.log(`Serving the page at http://localhost:${port}`);
  // esbuild watches the bundle; the page's own files are copied again when they change.
  for await (const { filename } of watch(here, { recursive: true })) {
    if (staticFiles.some((name) => filename === name || filename?.startsWith(`${name}${path.sep}`))) {
      await copyStatic().catch(() => {});
    }
  }
} else {
  const result = await esbuild.build(options);
  const bytes = Object.entries(result.metafile.outputs)
    .filter(([file]) => !file.endsWith(".map"))
    .map(([file, { bytes }]) => `${path.basename(file)} ${(bytes / 1024).toFixed(0)} KB`);
  console.log(`Built ${bytes.join(", ")}`);
  if (flags.has("--analyze")) console.log(await esbuild.analyzeMetafile(result.metafile));
}
