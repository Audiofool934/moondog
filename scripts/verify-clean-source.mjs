#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  copyReleaseFiles,
  visibleReleasePaths,
} from "./public-source-tree.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function assert(condition, message) {
  if (!condition) throw new Error(`Clean-source verification failed: ${message}`);
}

function npmInvocation(args) {
  const npmExecPath = process.env.npm_execpath;
  return npmExecPath
    ? { command: process.execPath, args: [npmExecPath, ...args] }
    : { command: "npm", args };
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

async function runLocal(sourceRoot, manifestPath) {
  const install = npmInvocation([
    "ci",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--prefer-offline",
  ]);
  await run(install.command, install.args, { cwd: sourceRoot, env: process.env });
  const verify = npmInvocation(["run", "verify"]);
  await run(verify.command, verify.args, {
    cwd: sourceRoot,
    env: {
      ...process.env,
      MOONDOG_RELEASE_SKIP_HISTORY: "1",
      MOONDOG_RELEASE_TREE_MANIFEST: manifestPath,
    },
  });
}

async function runLinuxContainer(sourceRoot, manifestPath) {
  await execFileAsync("docker", ["info"], { timeout: 30_000 });
  const command = [
    "set -eu",
    "apt-get update -qq",
    "apt-get install -y -qq --no-install-recommends zip unzip >/dev/null",
    "npm install --global --silent npm@11.16.0",
    "npm ci --ignore-scripts --no-audit --no-fund",
    "npm run verify",
  ].join("\n");
  await run("docker", [
    "run",
    "--rm",
    "--init",
    "--workdir",
    "/workspace",
    "--env",
    "CI=1",
    "--env",
    "MOONDOG_RELEASE_SKIP_HISTORY=1",
    "--env",
    "MOONDOG_RELEASE_TREE_MANIFEST=/tmp/moondog-release-tree.manifest",
    "--mount",
    `type=bind,src=${sourceRoot},dst=/workspace`,
    "--mount",
    `type=bind,src=${manifestPath},dst=/tmp/moondog-release-tree.manifest,readonly`,
    "node:22.19.0-bookworm-slim",
    "sh",
    "-c",
    command,
  ]);
}

async function main() {
  const useLinuxContainer = process.argv.includes("--linux-container");
  const unexpectedArguments = process.argv.slice(2).filter((argument) => argument !== "--linux-container");
  assert(unexpectedArguments.length === 0, `unknown arguments: ${unexpectedArguments.join(", ")}`);

  const releaseVerifier = path.join(repositoryRoot, "scripts", "verify-release-tree.mjs");
  await run(process.execPath, [releaseVerifier], { cwd: repositoryRoot, env: process.env });
  const paths = await visibleReleasePaths(repositoryRoot);
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "moondog-clean-source-"));
  if (process.platform !== "win32") await chmod(temporaryRoot, 0o700);
  try {
    const sourceRoot = path.join(temporaryRoot, "source");
    const manifestPath = path.join(temporaryRoot, "release-tree.manifest");
    await mkdir(sourceRoot, { mode: 0o700 });
    await writeFile(manifestPath, `${paths.join("\0")}\0`, { mode: 0o600 });
    await copyReleaseFiles({
      sourceRoot: repositoryRoot,
      destinationRoot: sourceRoot,
      paths,
    });
    const copiedPackage = JSON.parse(await readFile(path.join(sourceRoot, "package.json"), "utf8"));
    assert(copiedPackage.name === "@ruc-aimusic-lab/moondog", "snapshot package identity changed");
    await run(
      process.execPath,
      [path.join(sourceRoot, "scripts", "verify-release-tree.mjs")],
      {
        cwd: sourceRoot,
        env: {
          ...process.env,
          MOONDOG_RELEASE_SKIP_HISTORY: "1",
          MOONDOG_RELEASE_TREE_MANIFEST: manifestPath,
        },
      },
    );
    if (useLinuxContainer) await runLinuxContainer(sourceRoot, manifestPath);
    else await runLocal(sourceRoot, manifestPath);
    process.stdout.write(
      `Verified clean source: ${paths.length} files on ${useLinuxContainer ? "Linux Node 22.19.0 container" : `${process.platform} Node ${process.version}`}, no Git metadata or private local state.\n`,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
