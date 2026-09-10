#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  maximumReleaseEntries,
  maximumReleaseFileBytes,
  maximumReleaseTreeBytes,
  requiredIgnoredPaths,
  requiredReleasePaths,
  scanForbiddenContent,
  validateReleasePath,
} from "./release-tree-policy.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function assert(condition, message) {
  if (!condition) throw new Error(`Release-tree verification failed: ${message}`);
}

async function runGit(args, options = {}) {
  return execFileAsync("git", args, {
    cwd: repositoryRoot,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
    ...options,
  });
}

function runGitWithInput(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: repositoryRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Git timed out: git ${args.join(" ")}`));
    }, 120_000);
    child.stdout.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > 64 * 1024 * 1024) {
        child.kill("SIGTERM");
        reject(new Error(`Git output exceeded 64 MiB: git ${args.join(" ")}`));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
      } else {
        reject(
          new Error(
            `Git exited with ${code ?? signal}: ${Buffer.concat(stderr).toString("utf8").trim()}`,
          ),
        );
      }
    });
    child.stdin.end(input);
  });
}

function parseNullPaths(buffer) {
  return buffer
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((entry) => entry.split(path.sep).join("/"));
}

async function visiblePaths() {
  const manifestPath = process.env.MOONDOG_RELEASE_TREE_MANIFEST;
  if (manifestPath) return parseNullPaths(await readFile(manifestPath));
  const { stdout } = await runGit([
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  return parseNullPaths(stdout);
}

async function verifyIgnoredPaths() {
  if (process.env.MOONDOG_RELEASE_TREE_MANIFEST) return;
  const { stdout } = await runGitWithInput(
    ["check-ignore", "--no-index", "--stdin"],
    Buffer.from(`${requiredIgnoredPaths.join("\n")}\n`),
  );
  const ignored = new Set(stdout.toString("utf8").trim().split("\n").filter(Boolean));
  for (const ignoredPath of requiredIgnoredPaths) {
    assert(ignored.has(ignoredPath), `${ignoredPath} is not covered by .gitignore`);
  }
}

async function scanFile(relativePath, digest) {
  const absolutePath = path.join(repositoryRoot, ...relativePath.split("/"));
  const metadata = await lstat(absolutePath);
  assert(metadata.isFile(), `${relativePath} is not a regular file`);
  assert(!metadata.isSymbolicLink(), `${relativePath} is a symbolic link`);
  assert(
    metadata.size <= maximumReleaseFileBytes,
    `${relativePath} exceeds the ${(maximumReleaseFileBytes / (1024 * 1024)).toFixed(0)} MiB file ceiling`,
  );
  const content = await readFile(absolutePath);
  const contentIssues = scanForbiddenContent(content);
  assert(
    contentIssues.length === 0,
    `${relativePath} contains ${contentIssues.join(", ")}`,
  );
  const contentDigest = createHash("sha256").update(content).digest("hex");
  digest.update(relativePath).update("\0").update(contentDigest).update("\0");
  return metadata.size;
}

async function publicHistoryBlobs() {
  if (process.env.MOONDOG_RELEASE_SKIP_HISTORY === "1") return [];
  const { stdout } = await runGit([
    "rev-list",
    "--objects",
    "--branches",
    "--tags",
    "--remotes",
  ]);
  const records = stdout
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf(" ");
      return separator === -1
        ? { objectId: line, relativePath: null }
        : {
            objectId: line.slice(0, separator),
            relativePath: line.slice(separator + 1),
          };
    });
  const objectIds = [...new Set(records.map((record) => record.objectId))];
  const { stdout: objectRecords } = await runGitWithInput(
    ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
    Buffer.from(`${objectIds.join("\n")}\n`),
  );
  const blobMetadata = new Map(
    objectRecords
      .toString("utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [objectId, type, size] = line.split(" ");
        return [objectId, { type, size: Number(size) }];
      }),
  );
  return records.filter((record) => blobMetadata.get(record.objectId)?.type === "blob");
}

async function readBlobBatch(objectIds) {
  if (objectIds.length === 0) return new Map();
  const { stdout } = await runGitWithInput(
    ["cat-file", "--batch"],
    Buffer.from(`${objectIds.join("\n")}\n`),
  );
  const contents = new Map();
  let offset = 0;
  while (offset < stdout.length) {
    const headerEnd = stdout.indexOf(10, offset);
    assert(headerEnd !== -1, "Git returned a truncated history-object header");
    const [objectId, type, sizeText] = stdout
      .subarray(offset, headerEnd)
      .toString("utf8")
      .split(" ");
    const size = Number(sizeText);
    assert(type === "blob" && Number.isInteger(size), `Git returned an invalid blob header for ${objectId}`);
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + size;
    assert(contentEnd < stdout.length, `Git returned a truncated blob for ${objectId}`);
    contents.set(objectId, stdout.subarray(contentStart, contentEnd));
    assert(stdout[contentEnd] === 10, `Git returned an invalid blob delimiter for ${objectId}`);
    offset = contentEnd + 1;
  }
  return contents;
}

async function verifyPublicHistory() {
  const blobs = await publicHistoryBlobs();
  const uniqueBlobs = new Map();
  for (const record of blobs) {
    if (record.relativePath) {
      const issues = validateReleasePath(record.relativePath);
      assert(
        issues.length === 0,
        `public Git history contains ${record.relativePath}: ${issues.join(", ")}`,
      );
    }
    if (!uniqueBlobs.has(record.objectId)) uniqueBlobs.set(record.objectId, record.relativePath);
  }
  const contents = await readBlobBatch([...uniqueBlobs.keys()]);
  assert(contents.size === uniqueBlobs.size, "Git did not return every public-history blob");
  for (const [objectId, relativePath] of uniqueBlobs) {
    const issues = scanForbiddenContent(contents.get(objectId));
    assert(
      issues.length === 0,
      `public Git history blob ${objectId.slice(0, 12)}${relativePath ? ` (${relativePath})` : ""} contains ${issues.join(", ")}`,
    );
  }
  return uniqueBlobs.size;
}

async function main() {
  const paths = (await visiblePaths()).sort();
  assert(paths.length > 0, "the intended release tree is empty");
  assert(new Set(paths).size === paths.length, "the intended release tree has duplicate paths");
  assert(
    paths.length <= maximumReleaseEntries,
    `the intended release tree exceeds ${maximumReleaseEntries} entries`,
  );
  for (const requiredPath of requiredReleasePaths) {
    assert(paths.includes(requiredPath), `the intended release tree is missing ${requiredPath}`);
  }
  for (const relativePath of paths) {
    const issues = validateReleasePath(relativePath);
    assert(issues.length === 0, `${relativePath}: ${issues.join(", ")}`);
  }

  await verifyIgnoredPaths();
  const digest = createHash("sha256");
  let totalBytes = 0;
  for (const relativePath of paths) totalBytes += await scanFile(relativePath, digest);
  assert(
    totalBytes <= maximumReleaseTreeBytes,
    `the intended release tree exceeds ${(maximumReleaseTreeBytes / (1024 * 1024)).toFixed(0)} MiB`,
  );
  const historyBlobs = await verifyPublicHistory();
  const historyLabel = process.env.MOONDOG_RELEASE_SKIP_HISTORY === "1"
    ? "history inherited from source gate"
    : `${historyBlobs} public-history blobs checked for machine-detectable markers`;
  process.stdout.write(
    `Verified release tree: ${paths.length} files, ${(totalBytes / (1024 * 1024)).toFixed(2)} MiB, ${historyLabel}, sha256 ${digest.digest("hex")}.\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
