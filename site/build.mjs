// Builds the project page into dist/: the page, and the two frames it shows. window.html is the
// desktop app's own window (app/renderer) and terminal.html the terminal's room (src/surfaces/cli),
// both on the fictional listener. Node built-ins and the model and sign-in modules are swapped for
// the small stand-ins in shims/.
//
//   node build.mjs              build once (makes the fictional data snapshot if missing)
//   node build.mjs --snapshot   remake the snapshot first
//   node build.mjs --serve      rebuild on change and serve at http://localhost:8737
//   node build.mjs --offline    link the release list rather than ask GitHub for the newest Mac download
import { execFile } from "node:child_process";
import { access, cp, mkdir, readFile, rm, watch, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import * as esbuild from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const outdir = path.join(here, "dist");
const flags = new Set(process.argv.slice(2));
const repository = "https://github.com/Audiofool934/moondog";
const shim = (name) => path.join(here, "shims", name);
const builtins = {
  crypto: "crypto.mjs", fs: "fs.mjs", "fs/promises": "fs-promises.mjs", os: "os.mjs", path: "path.mjs",
  util: "util.mjs", events: "events.mjs", child_process: "misc.mjs", module: "misc.mjs", url: "misc.mjs",
  perf_hooks: "misc.mjs", "timers/promises": "misc.mjs", sqlite: "sqlite.mjs",
};
const replaced = new Set(["model-catalog.mjs", "public-model-catalog.mjs", "authentication.mjs"]);
const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

// The public agent's address. Without it, both frames run with no model and make no requests.
const agentUrl = process.env.MOONDOG_AGENT_URL?.trim().replace(/\/+$/u, "") ?? "";
// Cloudflare Turnstile's public site key, when the agent checks visitors first.
const turnstileSiteKey = agentUrl ? process.env.MOONDOG_TURNSTILE_SITE_KEY?.trim() ?? "" : "";
if (turnstileSiteKey && !/^[0-9A-Za-z_-]{10,64}$/u.test(turnstileSiteKey)) throw new Error("MOONDOG_TURNSTILE_SITE_KEY does not look like a Turnstile site key.");
if (agentUrl && !/^https:\/\/[a-z0-9.-]+(:\d+)?$|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/u.test(agentUrl)) {
  throw new Error(`MOONDOG_AGENT_URL must be an https origin (or http on localhost): ${agentUrl}`);
}

// What each document may load. The page only frames its own two documents; the frames may reach the
// agent, Apple's preview audio and cover art, and Cloudflare's check, and only when the agent runs.
const turnstile = "https://challenges.cloudflare.com";
function contentPolicy(document) {
  const live = document !== "page" && Boolean(agentUrl);
  const check = live && Boolean(turnstileSiteKey);
  const sources = {
    "default-src": ["'self'"],
    "script-src": ["'self'", ...(check ? [turnstile] : [])],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", ...(live ? ["https://*.mzstatic.com"] : [])],
    "media-src": live ? ["https://audio-ssl.itunes.apple.com"] : ["'none'"],
    "font-src": ["'self'"],
    "connect-src": live ? [agentUrl] : ["'none'"],
    "frame-src": document === "page" ? ["'self'"] : check ? [turnstile] : ["'none'"],
    "object-src": ["'none'"],
    "base-uri": ["'none'"],
    "form-action": ["'none'"],
  };
  return Object.entries(sources).map(([name, list]) => `${name} ${list.join(" ")}`).join("; ");
}
const policyTag = (document) => `<meta http-equiv="Content-Security-Policy" content="${contentPolicy(document)}">`;

// The newest release with a Mac download. A release is created before its files are uploaded,
// so the page links the newest one that already has its DMG, and the release list otherwise.
async function macDownload() {
  const fallback = { url: `${repository}/releases`, version: null };
  if (flags.has("--offline")) return fallback;
  try {
    const token = process.env.GITHUB_TOKEN;
    const response = await fetch("https://api.github.com/repos/Audiofool934/moondog/releases?per_page=20", {
      headers: { accept: "application/vnd.github+json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    for (const release of await response.json()) {
      const dmg = !release.draft && release.assets?.find((asset) => /-arm64\.dmg$/u.test(asset.name));
      if (dmg) return { url: dmg.browser_download_url, version: release.tag_name.replace(/^v/u, "") };
    }
  } catch (error) {
    console.warn(`The Mac download links to the release list: ${error.message}`);
  }
  return fallback;
}
const mac = await macDownload();

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
    "--disable-warning=ExperimentalWarning", path.join(here, "listener", "snapshot.mjs"),
  ]);
  process.stdout.write(stdout);
}

// The documents. The window's markup is the app's own index.html, with this page's policy and bundle,
// three resting traffic lights where the app's sit, and a place for Cloudflare's check. Its composer
// doesn't take focus on load, as it does in the app, since here the page comes first.
const documents = {
  "index.html": async () => (await readFile(path.join(here, "index.html"), "utf8"))
    .replace("<!-- policy -->", policyTag("page"))
    .replaceAll("{{mac.url}}", mac.url)
    .replaceAll("{{mac.version}}", mac.version ? `Version ${mac.version}` : "From the releases page"),
  "window.html": async () => (await readFile(path.join(root, "app", "renderer", "index.html"), "utf8"))
    .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/u, `${policyTag("window")}\n  <meta name="referrer" content="no-referrer">`)
    .replace('href="renderer.css"', 'href="window.css"')
    .replace(/(<textarea[^>]*?) autofocus/u, "$1")
    .replace('<script type="module" src="renderer.js"></script>',
      '<div class="lights" aria-hidden="true"><i></i><i></i><i></i></div>\n  <div class="human-check" data-check hidden></div>\n  <script type="module" src="window.js"></script>'),
  "terminal.html": async () => (await readFile(path.join(here, "terminal", "terminal.html"), "utf8"))
    .replace("<!-- policy -->", policyTag("terminal")),
};
const writeDocuments = async () => {
  await cp(path.join(here, "static"), path.join(outdir, "static"), { recursive: true });
  await cp(path.join(here, "style.css"), path.join(outdir, "style.css"));
  await Promise.all(Object.entries(documents).map(async ([name, render]) => writeFile(path.join(outdir, name), await render())));
};
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await writeDocuments();

const options = {
  entryPoints: {
    page: path.join(here, "page.mjs"),
    window: path.join(here, "window", "window.mjs"),
    terminal: path.join(here, "terminal", "terminal.mjs"),
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outdir,
  inject: [shim("process.mjs")],
  define: {
    MOONDOG_AGENT_URL: JSON.stringify(agentUrl),
    MOONDOG_TURNSTILE_SITE_KEY: JSON.stringify(turnstileSiteKey),
    MOONDOG_VERSION: JSON.stringify(version),
  },
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
  // esbuild watches the bundles; the documents and static files are written again when they change.
  const sources = [path.join(here, "index.html"), path.join(here, "style.css"), path.join(here, "terminal", "terminal.html"),
    path.join(root, "app", "renderer", "index.html"), path.join(here, "static")];
  for await (const { filename } of watch(root, { recursive: true })) {
    const file = path.join(root, filename ?? "");
    if (sources.some((source) => file === source || file.startsWith(`${source}${path.sep}`))) await writeDocuments().catch(() => {});
  }
} else {
  const result = await esbuild.build(options);
  const bytes = Object.entries(result.metafile.outputs)
    .filter(([file]) => !file.endsWith(".map"))
    .map(([file, { bytes }]) => `${path.basename(file)} ${(bytes / 1024).toFixed(0)} KB`);
  console.log(`Built ${bytes.join(", ")}; the Mac download is ${mac.version ?? "the release list"}.`);
  if (flags.has("--analyze")) console.log(await esbuild.analyzeMetafile(result.metafile));
}
