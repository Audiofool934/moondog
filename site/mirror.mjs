// The download mirror: a copy of each desktop download in Cloudflare R2, served from a domain on
// Cloudflare's network, which is faster for most visitors than GitHub's release files. GitHub stays the
// record. A download links to its copy only when the copy has the same size as the GitHub file;
// otherwise it links to GitHub.
//
// With upload set (the page workflow on main, with a Cloudflare API token), a missing copy is first
// downloaded from GitHub and put in the bucket with wrangler.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const mirrorOrigin = "https://downloads.audiofool.ai";
const bucket = "moondog";
const wrangler = "wrangler@4.166.0";
const contentTypes = {
  ".dmg": "application/x-apple-diskimage",
  ".exe": "application/vnd.microsoft.portable-executable",
  ".AppImage": "application/octet-stream",
};

const mirrorURL = (download) => `${mirrorOrigin}/${encodeURIComponent(download.name)}`;

async function mirrored(download) {
  try {
    const response = await fetch(mirrorURL(download), { method: "HEAD", signal: AbortSignal.timeout(10_000) });
    return response.ok && Number(response.headers.get("content-length")) === download.size;
  } catch {
    return false;
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`))));
  });
}

async function upload(download) {
  const folder = await mkdtemp(path.join(tmpdir(), "moondog-mirror-"));
  try {
    const file = path.join(folder, download.name);
    const response = await fetch(download.url, { signal: AbortSignal.timeout(10 * 60_000) });
    if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${download.name}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(file));
    await run("npx", ["--yes", wrangler, "r2", "object", "put", `${bucket}/${download.name}`, "--remote",
      "--file", file,
      "--content-type", contentTypes[path.extname(download.name)] ?? "application/octet-stream",
      "--content-disposition", `attachment; filename="${download.name}"`,
      "--cache-control", "public, max-age=31536000, immutable"]);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/** Each download, linked to its mirror copy when the copy is complete. */
export async function mirrorDownloads(downloads, { upload: wanted = false } = {}) {
  // Wrangler signs in with the token; without one it would try a browser sign-in.
  const uploading = wanted && Boolean(process.env.CLOUDFLARE_API_TOKEN);
  if (wanted && !uploading) console.warn("No CLOUDFLARE_API_TOKEN, so nothing new is copied to the download mirror.");
  const entries = await Promise.all(Object.entries(downloads).map(async ([platform, download]) => {
    if (!download?.name) return [platform, download];
    if (!(await mirrored(download)) && uploading) {
      try {
        await upload(download);
      } catch (error) {
        console.warn(`The ${platform} download stays on GitHub: ${error.message}`);
      }
    }
    return [platform, (await mirrored(download)) ? { ...download, url: mirrorURL(download) } : download];
  }));
  return Object.fromEntries(entries);
}
