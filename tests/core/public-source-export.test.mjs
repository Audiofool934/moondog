import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  exportPublicSource,
  parseArguments,
} from "../../scripts/export-public-source.mjs";
import {
  copyReleaseFiles,
  createReleaseTreeManifest,
} from "../../scripts/public-source-tree.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

test("public-source arguments require one explicit absolute destination", () => {
  assert.throws(() => parseArguments([]), /explicit --output path is required/u);
  assert.throws(
    () => parseArguments(["--output", "dist/public-source"]),
    /--output must be an absolute path/u,
  );
  assert.throws(
    () => parseArguments(["--output", "/tmp/one", "--output", "/tmp/two"]),
    /--output may be supplied only once/u,
  );
});

test("public-source copy rejects symbolic links", async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "moondog-source-copy-test-"));
  try {
    const sourceRoot = path.join(temporaryRoot, "input");
    const destinationRoot = path.join(temporaryRoot, "output");
    await mkdir(sourceRoot, { mode: 0o700 });
    await mkdir(destinationRoot, { mode: 0o700 });
    await writeFile(path.join(sourceRoot, "target.txt"), "synthetic\n", { mode: 0o600 });
    await symlink("target.txt", path.join(sourceRoot, "link.txt"));
    await assert.rejects(
      copyReleaseFiles({
        sourceRoot,
        destinationRoot,
        paths: ["link.txt"],
      }),
      /link\.txt is not a regular file/u,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("public-source export refuses an existing destination without changing it", async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "moondog-source-existing-test-"));
  try {
    const outputPath = path.join(temporaryRoot, "snapshot");
    const markerPath = path.join(outputPath, "keep.txt");
    await mkdir(outputPath, { mode: 0o700 });
    await writeFile(markerPath, "keep\n", { mode: 0o600 });
    await assert.rejects(
      exportPublicSource({ outputPath }),
      /destination already exists/u,
    );
    assert.equal(await readFile(markerPath, "utf8"), "keep\n");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("public-source command creates an exact private snapshot and relative audit manifest", {
  timeout: 120_000,
}, async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "moondog-source-export-test-"));
  try {
    const outputPath = path.join(temporaryRoot, "snapshot");
    const exporterPath = path.join(repositoryRoot, "scripts", "export-public-source.mjs");
    const { stdout } = await execFileAsync(
      process.execPath,
      [exporterPath, "--output", outputPath],
      {
        cwd: repositoryRoot,
        env: process.env,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: 120_000,
      },
    );
    assert.match(stdout, /Exported public-source snapshot:/u);
    assert.deepEqual((await readdir(outputPath)).sort(), ["manifest.json", "source"]);

    const sourceRoot = path.join(outputPath, "source");
    const manifestText = await readFile(path.join(outputPath, "manifest.json"), "utf8");
    const manifest = JSON.parse(manifestText);
    assert.equal(manifest.schema, "moondog.public-source-snapshot.v1");
    assert.equal(manifest.package.name, "@audiofool/moondog");
    assert.equal(manifest.source_root, "source");
    assert.deepEqual(manifest.verification, {
      source_release_tree: "passed",
      copied_release_tree: "passed",
      clean_install: "not-run-by-this-command",
    });
    assert.deepEqual(manifest.boundaries, {
      git_metadata_included: false,
      ignored_local_state_included: false,
      publication_performed: false,
      license_decision_inferred: false,
    });
    assert.equal(manifestText.includes(repositoryRoot), false);
    assert.equal(manifestText.includes(temporaryRoot), false);
    assert.equal(await exists(path.join(sourceRoot, ".git")), false);
    assert.equal(await exists(path.join(sourceRoot, "node_modules")), false);

    const paths = manifest.release_tree.files.map((file) => file.path);
    assert.equal(new Set(paths).size, paths.length);
    assert.deepEqual(
      await createReleaseTreeManifest({ sourceRoot, paths }),
      manifest.release_tree,
    );

    if (process.platform !== "win32") {
      const sourceMode = (await lstat(path.join(repositoryRoot, "scripts", "moondog"))).mode & 0o777;
      const copiedMode = (await lstat(path.join(sourceRoot, "scripts", "moondog"))).mode & 0o777;
      assert.equal(copiedMode, sourceMode);
      assert.equal((await lstat(outputPath)).mode & 0o777, 0o700);
      assert.equal((await lstat(path.join(outputPath, "manifest.json"))).mode & 0o777, 0o600);
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
