// Builds the project page into dist/: the page, and window.html, the desktop app's own window
// (app/renderer) playing the page's scene. Node built-ins the window's core imports are swapped for
// the small stand-ins in shims/. Neither document makes a request beyond the page's own files.
//
//   node build.mjs              build once
//   node build.mjs --serve      rebuild on change and serve at http://localhost:8737
//   node build.mjs --offline    link the release list rather than ask GitHub for desktop downloads
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, watch, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

// What each document may load: its own files, drawn covers, and for the page, the window's frame, the
// scene's music, and Cloudflare's Web Analytics, which Cloudflare adds to each page it serves and which
// reports to the site's own /cdn-cgi/rum. The window's frame reloads with each play of the scene, so it
// keeps the beacon out rather than count a visit each time.
const analytics = "https://static.cloudflareinsights.com";
function contentPolicy(document) {
  const page = document === "page";
  const sources = {
    "default-src": ["'self'"],
    "script-src": ["'self'", ...(page ? [analytics] : [])],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:"],
    "media-src": page ? ["'self'"] : ["'none'"],
    "font-src": ["'self'"],
    "connect-src": page ? ["'self'", "https://cloudflareinsights.com"] : ["'none'"],
    "frame-src": page ? ["'self'"] : ["'none'"],
    "object-src": ["'none'"],
    "base-uri": ["'none'"],
    "form-action": ["'none'"],
  };
  return Object.entries(sources).map(([name, list]) => `${name} ${list.join(" ")}`).join("; ");
}
const policyTag = (document) => `<meta http-equiv="Content-Security-Policy" content="${contentPolicy(document)}">`;

// Each platform can arrive separately. Offer a download only after its file is on a release.
async function desktopDownloads() {
  const fallback = { mac: { url: `${repository}/releases`, version: null }, windows: null, linux: null };
  if (flags.has("--offline")) return fallback;
  try {
    const token = process.env.GITHUB_TOKEN;
    const response = await fetch("https://api.github.com/repos/Audiofool934/moondog/releases?per_page=20", {
      headers: { accept: "application/vnd.github+json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    const found = { ...fallback };
    for (const release of await response.json()) {
      if (release.draft) continue;
      for (const [platform, pattern] of Object.entries({ mac: /-arm64\.dmg$/u, windows: /-win-x64\.exe$/u, linux: /-linux-x64\.AppImage$/u })) {
        if (found[platform]?.version) continue;
        const asset = release.assets?.find((item) => pattern.test(item.name));
        if (asset) found[platform] = { url: asset.browser_download_url, version: release.tag_name.replace(/^v/u, "") };
      }
    }
    return found;
  } catch (error) {
    console.warn(`Desktop downloads link to the release list: ${error.message}`);
  }
  return fallback;
}
const downloads = await desktopDownloads();
const { mac } = downloads;
const escapeHTML = (value) => String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const additionalDownloads = [
  ["windows", "Windows", "Open the installer to install Moondog for your account."],
  ["linux", "Linux", "Make the AppImage executable, then open it to start Moondog."],
].map(([platform, label, instructions]) => {
  const download = downloads[platform];
  return download ? `<h3>For ${label}</h3>\n<p>${instructions} Updates download only when you ask.</p>\n<p class="actions"><a class="button" href="${escapeHTML(download.url)}">Download for ${label}</a> <span class="fine">Version ${escapeHTML(download.version)}, for x64.</span></p>` : "";
}).join("\n");

const browserPlugin = {
  name: "moondog-browser",
  setup(build) {
    build.onResolve({ filter: /^(node:)?[a-z_/]+$/ }, ({ path: spec }) => {
      const name = builtins[spec.replace(/^node:/, "")];
      return name ? { path: shim(name) } : undefined;
    });
    // pi-tui unrefs its timers so Node can exit; browser timers are plain numbers.
    build.onLoad({ filter: /[\\/]@earendil-works[\\/]pi-tui[\\/]dist[\\/].+\.js$/ }, async ({ path: file }) => ({
      contents: (await readFile(file, "utf8")).replaceAll(".unref()", ".unref?.()"),
      loader: "js",
    }));
  },
};

// The documents. The window's markup is the app's own index.html, with this page's policy and bundle,
// three resting traffic lights where the app's sit, and its composer set aside from the first frame,
// where the page's cover speaks (window/host.css).
const documents = {
  "index.html": async () => (await readFile(path.join(here, "index.html"), "utf8"))
    .replace("<!-- policy -->", policyTag("page"))
    .replaceAll("{{mac.url}}", mac.url)
    .replaceAll("{{mac.version}}", mac.version ? `Version ${mac.version}` : "From the releases page")
    .replace("{{desktop.downloads}}", additionalDownloads),
  "window.html": async () => (await readFile(path.join(root, "app", "renderer", "index.html"), "utf8"))
    .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/u, `${policyTag("window")}\n  <meta name="referrer" content="no-referrer">`)
    .replace('href="renderer.css"', 'href="window.css"')
    .replace(/(<textarea[^>]*?) autofocus/u, "$1")
    .replace("<body>", '<body class="waiting">')
    .replace('<script type="module" src="renderer.js"></script>',
      '<div class="lights" aria-hidden="true"><i></i><i></i><i></i></div>\n  <script type="module" src="window.js"></script>'),
};
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
    window: path.join(here, "window", "window.mjs"),
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
  const sources = [path.join(here, "index.html"), path.join(here, "style.css"), path.join(root, "app", "renderer", "index.html"), path.join(here, "static")];
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
