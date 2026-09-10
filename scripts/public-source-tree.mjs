import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function assert(condition, message) {
  if (!condition) throw new Error(`Public-source tree failed: ${message}`);
}

function normalizedReleasePath(relativePath) {
  const normalized = relativePath.split(path.sep).join("/");
  const segments = normalized.split("/");
  assert(
    normalized &&
      !path.posix.isAbsolute(normalized) &&
      !normalized.includes("\0") &&
      segments.every((segment) => segment && segment !== "." && segment !== ".."),
    `unsafe release path: ${relativePath}`,
  );
  return normalized;
}

export function parseNullSeparatedReleasePaths(buffer) {
  const paths = buffer
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map(normalizedReleasePath)
    .sort();
  assert(paths.length > 0, "release manifest is empty");
  assert(new Set(paths).size === paths.length, "release manifest has duplicate paths");
  return paths;
}

export async function visibleReleasePaths(
  repositoryRoot,
  { manifestPath = process.env.MOONDOG_RELEASE_TREE_MANIFEST } = {},
) {
  if (manifestPath) {
    return parseNullSeparatedReleasePaths(await readFile(manifestPath));
  }
  const { stdout } = await execFileAsync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
      cwd: repositoryRoot,
      encoding: "buffer",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30_000,
    },
  );
  return parseNullSeparatedReleasePaths(stdout);
}

export async function copyReleaseFiles({ sourceRoot, destinationRoot, paths }) {
  for (const rawRelativePath of paths) {
    const relativePath = normalizedReleasePath(rawRelativePath);
    const sourcePath = path.join(sourceRoot, ...relativePath.split("/"));
    const destinationPath = path.join(destinationRoot, ...relativePath.split("/"));
    const metadata = await lstat(sourcePath);
    assert(
      metadata.isFile() && !metadata.isSymbolicLink(),
      `${relativePath} is not a regular file`,
    );
    await mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
    await copyFile(sourcePath, destinationPath, fsConstants.COPYFILE_EXCL);
    if (process.platform !== "win32") {
      await chmod(destinationPath, metadata.mode & 0o777);
    }
  }
}

export async function createReleaseTreeManifest({ sourceRoot, paths }) {
  const files = [];
  const treeDigest = createHash("sha256");
  let totalBytes = 0;

  for (const rawRelativePath of [...paths].sort()) {
    const relativePath = normalizedReleasePath(rawRelativePath);
    const absolutePath = path.join(sourceRoot, ...relativePath.split("/"));
    const metadata = await lstat(absolutePath);
    assert(
      metadata.isFile() && !metadata.isSymbolicLink(),
      `${relativePath} is not a regular file`,
    );
    const content = await readFile(absolutePath);
    const sha256 = createHash("sha256").update(content).digest("hex");
    const mode = (metadata.mode & 0o777).toString(8).padStart(4, "0");
    files.push({ path: relativePath, bytes: metadata.size, mode, sha256 });
    totalBytes += metadata.size;
    treeDigest.update(relativePath).update("\0").update(sha256).update("\0");
  }

  return {
    file_count: files.length,
    total_bytes: totalBytes,
    sha256: treeDigest.digest("hex"),
    files,
  };
}
