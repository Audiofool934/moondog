#!/usr/bin/env node

import { spawn } from "node:child_process";
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

import {
  copyReleaseFiles,
  createReleaseTreeManifest,
  visibleReleasePaths,
} from "./public-source-tree.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function assert(condition, message) {
  if (!condition) throw new Error(`Public-source export failed: ${message}`);
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

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      ...options,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code ?? signal}`));
    });
  });
}

export function parseArguments(args) {
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
      throw new Error(`Public-source export failed: parent directory does not exist: ${parentPath}`);
    }
    throw error;
  });
  assert(
    parentMetadata.isDirectory() && !parentMetadata.isSymbolicLink(),
    `destination parent is not a regular directory: ${parentPath}`,
  );
  return parentPath;
}

function publicSnapshotManifest({ packageMetadata, releaseTree }) {
  return {
    schema: "moondog.public-source-snapshot.v1",
    created_at: new Date().toISOString(),
    package: {
      name: packageMetadata.name,
      version: packageMetadata.version,
    },
    source_root: "source",
    release_tree: releaseTree,
    verification: {
      source_release_tree: "passed",
      copied_release_tree: "passed",
      clean_install: "not-run-by-this-command",
    },
    boundaries: {
      git_metadata_included: false,
      ignored_local_state_included: false,
      publication_performed: false,
      license_decision_inferred: false,
    },
  };
}

export async function exportPublicSource({ outputPath }) {
  const parentPath = await verifyDestination(outputPath);
  const releaseVerifier = path.join(repositoryRoot, "scripts", "verify-release-tree.mjs");
  await run(process.execPath, [releaseVerifier], {
    cwd: repositoryRoot,
    env: process.env,
  });
  const paths = await visibleReleasePaths(repositoryRoot);
  let stagingRoot = await mkdtemp(path.join(parentPath, ".moondog-public-source-"));
  if (process.platform !== "win32") await chmod(stagingRoot, 0o700);

  try {
    const sourceRoot = path.join(stagingRoot, "source");
    const releaseManifestPath = path.join(stagingRoot, ".release-tree.manifest.tmp");
    await mkdir(sourceRoot, { mode: 0o700 });
    await writeFile(releaseManifestPath, `${paths.join("\0")}\0`, { mode: 0o600 });
    await copyReleaseFiles({
      sourceRoot: repositoryRoot,
      destinationRoot: sourceRoot,
      paths,
    });
    await run(
      process.execPath,
      [path.join(sourceRoot, "scripts", "verify-release-tree.mjs")],
      {
        cwd: sourceRoot,
        env: {
          ...process.env,
          MOONDOG_RELEASE_SKIP_HISTORY: "1",
          MOONDOG_RELEASE_TREE_MANIFEST: releaseManifestPath,
        },
      },
    );

    const packageMetadata = JSON.parse(
      await readFile(path.join(sourceRoot, "package.json"), "utf8"),
    );
    assert(
      packageMetadata.name === "@audiofool/moondog",
      "snapshot package identity changed",
    );
    const releaseTree = await createReleaseTreeManifest({ sourceRoot, paths });
    const manifest = publicSnapshotManifest({ packageMetadata, releaseTree });
    await rm(releaseManifestPath);
    await writeFile(
      path.join(stagingRoot, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o600 },
    );

    assert(
      !(await pathExists(outputPath)),
      `destination appeared during export: ${outputPath}`,
    );
    await rename(stagingRoot, outputPath);
    stagingRoot = null;
    process.stdout.write(
      `Exported public-source snapshot: ${releaseTree.file_count} files, ${releaseTree.total_bytes} bytes, sha256 ${releaseTree.sha256}, ${outputPath}\n`,
    );
    return manifest;
  } finally {
    if (stagingRoot) await rm(stagingRoot, { recursive: true, force: true });
  }
}

async function main() {
  await exportPublicSource(parseArguments(process.argv.slice(2)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
