// Builds the project page into dist/: the page, start.html, the getting-started guide, and window.html,
// the desktop app's own window (app/renderer) playing the page's scene. Node built-ins the window's core
// imports are swapped for the small stand-ins in shims/. No document makes a request beyond the page's own files.
//
//   node build.mjs              build once
//   node build.mjs --serve      rebuild on change and serve at http://localhost:8737
//   node build.mjs --offline    link the release list rather than ask GitHub for desktop downloads
//   node build.mjs --mirror     first copy missing downloads to the Cloudflare mirror (mirror.mjs)
//   node build.mjs --film       also build the film's stage and windows (film/), which the page never links
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, watch, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { desktopDownloads as chooseDownloads } from "./download.mjs";
import { mirrorDownloads } from "./mirror.mjs";

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

// What each document may load: its own files, drawn covers, and for the page, the window's frame and the
// scene's music. The page and the guide also take Cloudflare's Web Analytics, which Cloudflare adds to
// each page it serves and which reports to the site's own /cdn-cgi/rum. The window's frame reloads with
// each play of the scene, so it keeps the beacon out rather than count a visit each time.
const analytics = "https://static.cloudflareinsights.com";
function contentPolicy(document) {
  const page = document === "page";
  const visited = document !== "window";
  const sources = {
    "default-src": ["'self'"],
    "script-src": ["'self'", ...(visited ? [analytics] : [])],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:"],
    "media-src": page ? ["'self'"] : ["'none'"],
    "font-src": ["'self'"],
    "connect-src": visited ? ["'self'", "https://cloudflareinsights.com"] : ["'none'"],
    "frame-src": page ? ["'self'"] : ["'none'"],
    "object-src": ["'none'"],
    "base-uri": ["'none'"],
    "form-action": ["'none'"],
  };
  return Object.entries(sources).map(([name, list]) => `${name} ${list.join(" ")}`).join("; ");
}
const policyTag = (document) => `<meta http-equiv="Content-Security-Policy" content="${contentPolicy(document)}">`;

// Each platform's file can arrive separately. The Mac offers only a complete stable release; Windows and
// Linux fall back to their newest beta until they have a stable one (download.mjs).
async function desktopDownloads() {
  const fallback = { mac: { url: `${repository}/releases`, version: null }, windows: null, linux: null };
  if (flags.has("--offline")) return fallback;
  try {
    const token = process.env.GITHUB_TOKEN;
    const response = await fetch("https://api.github.com/repos/Audiofool934/moondog/releases?per_page=100", {
      headers: { accept: "application/vnd.github+json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    const found = await mirrorDownloads(chooseDownloads(await response.json()), { upload: flags.has("--mirror") });
    return { ...found, mac: found.mac ?? fallback.mac };
  } catch (error) {
    console.warn(`Desktop downloads link to the release list: ${error.message}`);
  }
  return fallback;
}
const downloads = await desktopDownloads();
const { mac } = downloads;
const escapeHTML = (value) => String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const versionLine = (download) => `Version ${escapeHTML(download.version)}, ${download.beta ? "a test build for x64" : "for x64"}.`;
// Windows installers are not code-signed yet, so SmartScreen asks before the first run.
const additionalDownloads = [
  ["windows", "Windows", "Open the installer to install Moondog for your account. It isn't signed yet, so Windows asks before it runs: choose More info, then Run anyway. Spotify and Apple Music previews play here; whole Apple Music songs need a Mac."],
  ["linux", "Linux", "Make the AppImage executable, then open it to start Moondog."],
].map(([platform, label, instructions]) => {
  const download = downloads[platform];
  return download ? `<h3 id="${platform}">For ${label}</h3>\n<p>${instructions} Updates download only when you ask.</p>\n<p class="actions"><a class="button" href="${escapeHTML(download.url)}">Download for ${label}</a> <span class="fine">${versionLine(download)}</span></p>` : "";
}).join("\n");
// The intro's button follows the visitor's system (page.mjs). The Mac's line is the one shown without a
// script; each line names the other systems the same way, so none reads as the main one. Linux goes to
// the terminal until it has an AppImage.
const places = {
  mac: { name: "Mac", href: "#mac" },
  windows: downloads.windows ? { name: "Windows", href: "#windows" } : null,
  linux: { name: "Linux", href: downloads.linux ? "#linux" : "#terminal" },
};
const others = (platform) => {
  const links = Object.entries(places).filter(([key, place]) => key !== platform && place)
    .map(([, place]) => `<a href="${place.href}">${place.name}</a>`);
  return links.length ? ` Moondog runs on ${links.join(" and ")} too.` : "";
};
const introLine = (platform, href, label, fine, shown) =>
  `<p class="actions" data-platform="${platform}"${shown ? "" : " hidden"}>\n          <a class="button" href="${escapeHTML(href)}">${label}</a>\n          <span class="fine">${fine}${others(platform)}</span>\n        </p>`;
const introActions = [
  introLine("mac", mac.url, "Download for Mac", `${mac.version ? `Version ${escapeHTML(mac.version)}` : "From the releases page"}, for Apple silicon.`, true),
  downloads.windows && introLine("windows", downloads.windows.url, "Download for Windows", versionLine(downloads.windows), false),
  downloads.linux
    ? introLine("linux", downloads.linux.url, "Download for Linux", versionLine(downloads.linux), false)
    : introLine("linux", "#terminal", "Install on Linux", "In a terminal, with Node.js 22.19 or newer.", false),
].filter(Boolean).join("\n        ");

const browserPlugin = {
  name: "moondog-browser",
  setup(build) {
    build.onResolve({ filter: /^(node:)?[a-z_/]+$/ }, ({ path: spec }) => {
      // The film's setup windows run the app's harness core, which asks for Electron's bridge to open menus.
      if (spec === "electron") return { path: "electron", namespace: "film-bridge" };
      const name = builtins[spec.replace(/^node:/, "")];
      return name ? { path: shim(name) } : undefined;
    });
    build.onLoad({ filter: /.*/, namespace: "film-bridge" }, () => ({ contents: "module.exports = { ipcRenderer: { invoke: async () => null } };", loader: "js" }));
    // pi-tui unrefs its timers so Node can exit; browser timers are plain numbers.
    build.onLoad({ filter: /[\\/]@earendil-works[\\/]pi-tui[\\/]dist[\\/].+\.js$/ }, async ({ path: file }) => ({
      contents: (await readFile(file, "utf8")).replaceAll(".unref()", ".unref?.()"),
      loader: "js",
    }));
  },
};

// The documents. The page and the guide name the Mac download. The window's markup is the app's own
// index.html, with this page's policy and bundle, three resting traffic lights where the app's sit, and
// its composer set aside from the first frame, where the page's cover speaks (window/host.css).
const withMac = (html) => html
  .replaceAll("{{mac.url}}", mac.url)
  .replaceAll("{{mac.version}}", mac.version ? `Version ${mac.version}` : "From the releases page");
const documents = {
  "index.html": async () => withMac(await readFile(path.join(here, "index.html"), "utf8"))
    .replace("<!-- policy -->", policyTag("page"))
    .replace("{{intro.actions}}", introActions)
    .replace("{{desktop.downloads}}", additionalDownloads),
  "start.html": async () => withMac(await readFile(path.join(here, "start.html"), "utf8"))
    .replace("<!-- policy -->", policyTag("guide")),
  "window.html": async () => (await readFile(path.join(root, "app", "renderer", "index.html"), "utf8"))
    .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/u, `${policyTag("window")}\n  <meta name="referrer" content="no-referrer">`)
    .replace('href="renderer.css"', 'href="window.css"')
    .replace(/(<textarea[^>]*?) autofocus/u, "$1")
    .replace("<body>", '<body class="waiting">')
    .replace('<script type="module" src="renderer.js"></script>',
      '<div class="lights" aria-hidden="true"><i></i><i></i><i></i></div>\n  <script type="module" src="window.js"></script>'),
};
// The film (film/): its stage, and the app's window on the scene's core and on the harness's core. They
// are built only when asked for, and nothing on the page links them.
const filmWindow = (name) => async () => (await readFile(path.join(root, "app", "renderer", "index.html"), "utf8"))
  .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/u, policyTag("window"))
  .replace('href="renderer.css"', `href="${name}.css"`)
  .replace(/(<textarea[^>]*?) autofocus/u, "$1")
  .replace('<script type="module" src="renderer.js"></script>',
    `<div class="lights" aria-hidden="true"><i></i><i></i><i></i></div>\n  <script type="module" src="${name}.js"></script>`);
if (flags.has("--film")) Object.assign(documents, {
  "film.html": () => readFile(path.join(here, "film", "film.html"), "utf8"),
  "room.html": filmWindow("room"),
  "harness.html": filmWindow("harness"),
});
// Cloudflare keeps scripts and styles for hours, so a published document asks for each one by its
// content: a new deploy never pairs new markup with an old stylesheet.
const fingerprint = async (html) => {
  for (const name of new Set(html.match(/(?<=(?:href|src)=")[a-z]+\.(?:css|js)(?=")/gu) ?? [])) {
    const hash = createHash("sha256").update(await readFile(path.join(outdir, name))).digest("hex").slice(0, 10);
    html = html.replaceAll(`"${name}"`, `"${name}?v=${hash}"`);
  }
  return html;
};
const writeDocuments = async ({ fingerprinted = false } = {}) => {
  await cp(path.join(here, "static"), path.join(outdir, "static"), { recursive: true });
  await cp(path.join(here, "style.css"), path.join(outdir, "style.css"));
  await Promise.all(Object.entries(documents).map(async ([name, render]) => {
    const html = await render();
    await writeFile(path.join(outdir, name), fingerprinted ? await fingerprint(html) : html);
  }));
};
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await writeDocuments();

const options = {
  entryPoints: {
    page: path.join(here, "page.mjs"),
    start: path.join(here, "start.mjs"),
    window: path.join(here, "window", "window.mjs"),
    ...(flags.has("--film") ? { film: path.join(here, "film", "stage.mjs"), room: path.join(here, "film", "room.mjs"), harness: path.join(here, "film", "harness.mjs") } : {}),
  },
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
  // esbuild watches the bundles; the documents and static files are written again when they change.
  const sources = [path.join(here, "index.html"), path.join(here, "start.html"), path.join(here, "style.css"), path.join(root, "app", "renderer", "index.html"), path.join(here, "static")];
  for await (const { filename } of watch(root, { recursive: true })) {
    const file = path.join(root, filename ?? "");
    if (sources.some((source) => file === source || file.startsWith(`${source}${path.sep}`))) await writeDocuments().catch(() => {});
  }
} else {
  const result = await esbuild.build(options);
  await writeDocuments({ fingerprinted: true });
  const bytes = Object.entries(result.metafile.outputs)
    .filter(([file]) => !file.endsWith(".map"))
    .map(([file, { bytes }]) => `${path.basename(file)} ${(bytes / 1024).toFixed(0)} KB`);
  console.log(`Built ${bytes.join(", ")}; the Mac download is ${mac.version ?? "the release list"}.`);
  if (flags.has("--analyze")) console.log(await esbuild.analyzeMetafile(result.metafile));
}
