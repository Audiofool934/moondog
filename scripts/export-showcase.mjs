#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MOONDOG_SHOWCASE_ROUTES } from "../src/surfaces/web/showcase.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const sourceEntrypoint = "showcase/index.html";
const exportedEntrypoint = "index.html";

function assert(condition, message) {
  if (!condition) throw new Error(`Showcase export failed: ${message}`);
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function normalizeRelativePath(value) {
  const normalized = value.split(path.sep).join("/");
  const segments = normalized.split("/");
  assert(
    normalized &&
      !normalized.startsWith("/") &&
      !normalized.includes("\0") &&
      segments.every((segment) => segment && segment !== "." && segment !== ".."),
    `unsafe public path: ${value}`,
  );
  return normalized;
}

function referencesFrom(html) {
  return [...html.matchAll(/\b(?:href|src)="([^"]+)"/gu)].map(
    (match) => match[1],
  );
}

function localReferencePath(reference) {
  return reference.split("#", 1)[0];
}

function sourceFiles() {
  const files = new Map();
  for (const route of MOONDOG_SHOWCASE_ROUTES) {
    const sourcePath = normalizeRelativePath(route.relativePath);
    const destinationPath = sourcePath === sourceEntrypoint
      ? exportedEntrypoint
      : sourcePath;
    assert(
      !files.has(destinationPath),
      `duplicate public destination: ${destinationPath}`,
    );
    files.set(destinationPath, sourcePath);
  }
  assert(
    files.get(exportedEntrypoint) === sourceEntrypoint,
    "the showcase entrypoint is absent from the server allowlist",
  );
  return files;
}

export function transformShowcaseHtml(source) {
  assert(typeof source === "string" && source.length > 0, "entrypoint is empty");
  assert(!/<script\b/iu.test(source), "entrypoint contains a script");
  assert(!/\bhttps?:\/\//iu.test(source), "entrypoint contains a remote URL");
  assert(
    source.includes('http-equiv="Content-Security-Policy"') &&
      source.includes("default-src 'none'") &&
      source.includes("img-src 'self'") &&
      source.includes("style-src 'unsafe-inline'"),
    "entrypoint has no static Content Security Policy",
  );
  const transformed = source.replaceAll("../assets/", "assets/");
  assert(transformed !== source, "entrypoint has no exportable asset references");
  assert(!transformed.includes("../assets/"), "entrypoint retains source-tree paths");
  return transformed;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function publicTreeManifest(fileBuffers) {
  const files = [...fileBuffers.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "en-US"))
    .map(([filePath, buffer]) => ({
      path: filePath,
      bytes: buffer.length,
      sha256: sha256(buffer),
    }));
  const treeHash = createHash("sha256");
  for (const file of files) {
    treeHash.update(`${file.path}\0${file.bytes}\0${file.sha256}\n`);
  }
  return {
    file_count: files.length,
    total_bytes: files.reduce((total, file) => total + file.bytes, 0),
    sha256: treeHash.digest("hex"),
    files,
  };
}

function validateEntrypointReferences(html, fileBuffers) {
  const references = referencesFrom(html)
    .filter((reference) => !reference.startsWith("#"))
    .map(localReferencePath);
  const referencedFiles = new Set(references);
  const expected = new Set(
    [...fileBuffers.keys()].filter((filePath) => filePath !== exportedEntrypoint),
  );
  assert(
    referencedFiles.size === expected.size &&
      [...referencedFiles].every((reference) => expected.has(reference)),
    "entrypoint references do not match the exact public file set",
  );
}

function exportManifest({ createdAt, publicTree }) {
  return {
    schema: "moondog.showcase-export.v1",
    created_at: createdAt,
    site_root: ".",
    entrypoint: exportedEntrypoint,
    public_tree: publicTree,
    verification: {
      source_allowlist: "passed",
      exported_references: "passed",
      static_content_security_policy: "passed",
    },
    boundaries: {
      fictional_demonstration_data_only: true,
      scripts_included: false,
      external_resources_included: false,
      private_listener_state_included: false,
      publication_performed: false,
    },
  };
}

export function parseShowcaseExportArguments(args) {
  let outputPath = null;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--output") {
      assert(outputPath === null, "--output may be supplied only once");
      outputPath = args[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (argument.startsWith("--output=")) {
      assert(outputPath === null, "--output may be supplied only once");
      outputPath = argument.slice("--output=".length);
      continue;
    }
    assert(false, `unknown argument: ${argument}`);
  }
  assert(outputPath, "an explicit --output path is required");
  assert(path.isAbsolute(outputPath), "--output must be an absolute path");
  return { outputPath: path.normalize(outputPath) };
}

async function verifyDestination(outputPath) {
  assert(!(await pathExists(outputPath)), `destination already exists: ${outputPath}`);
  const parentPath = path.dirname(outputPath);
  const parentMetadata = await lstat(parentPath).catch((error) => {
    if (error?.code === "ENOENT") {
      throw new Error(
        `Showcase export failed: parent directory does not exist: ${parentPath}`,
      );
    }
    throw error;
  });
  assert(
    parentMetadata.isDirectory() && !parentMetadata.isSymbolicLink(),
    `destination parent is not a regular directory: ${parentPath}`,
  );
  return parentPath;
}

async function readSourceFiles() {
  const fileBuffers = new Map();
  for (const [destinationPath, sourcePath] of sourceFiles()) {
    const absolutePath = path.join(repositoryRoot, sourcePath);
    const metadata = await lstat(absolutePath);
    assert(
      metadata.isFile() && !metadata.isSymbolicLink(),
      `${sourcePath} is not a regular source file`,
    );
    const source = await readFile(absolutePath);
    const buffer = sourcePath === sourceEntrypoint
      ? Buffer.from(transformShowcaseHtml(source.toString("utf8")))
      : source;
    fileBuffers.set(destinationPath, buffer);
  }
  validateEntrypointReferences(
    fileBuffers.get(exportedEntrypoint).toString("utf8"),
    fileBuffers,
  );
  return fileBuffers;
}

async function writePublicFiles(root, fileBuffers) {
  for (const [relativePath, buffer] of fileBuffers) {
    const destinationPath = path.join(root, relativePath);
    await mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
    await writeFile(destinationPath, buffer, { flag: "wx", mode: 0o600 });
  }
}

export async function exportShowcase({
  outputPath,
  now = () => new Date(),
} = {}) {
  assert(typeof outputPath === "string", "an output path is required");
  assert(path.isAbsolute(outputPath), "output path must be absolute");
  const parentPath = await verifyDestination(outputPath);
  const createdAt = now().toISOString();
  const fileBuffers = await readSourceFiles();
  const publicTree = publicTreeManifest(fileBuffers);
  const manifest = exportManifest({ createdAt, publicTree });
  let stagingRoot = await mkdtemp(path.join(parentPath, ".moondog-showcase-"));
  if (process.platform !== "win32") await chmod(stagingRoot, 0o700);

  try {
    await writePublicFiles(stagingRoot, fileBuffers);
    await writeFile(
      path.join(stagingRoot, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    assert(
      !(await pathExists(outputPath)),
      `destination appeared during export: ${outputPath}`,
    );
    await rename(stagingRoot, outputPath);
    stagingRoot = null;
    process.stdout.write(
      `Exported host-ready showcase: ${publicTree.file_count} public files, ${publicTree.total_bytes} bytes, sha256 ${publicTree.sha256}, ${outputPath}. No publication performed.\n`,
    );
    return manifest;
  } finally {
    if (stagingRoot) await rm(stagingRoot, { recursive: true, force: true });
  }
}

async function main() {
  await exportShowcase(parseShowcaseExportArguments(process.argv.slice(2)));
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
