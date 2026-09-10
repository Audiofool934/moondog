import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  exportShowcase,
  parseShowcaseExportArguments,
} from "../../scripts/export-showcase.mjs";

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

test("showcase export arguments require one explicit absolute destination", () => {
  assert.throws(
    () => parseShowcaseExportArguments([]),
    /explicit --output path is required/u,
  );
  assert.throws(
    () => parseShowcaseExportArguments(["--output", "dist/showcase"]),
    /--output must be an absolute path/u,
  );
  assert.throws(
    () => parseShowcaseExportArguments([
      "--output",
      "/tmp/one",
      "--output",
      "/tmp/two",
    ]),
    /--output may be supplied only once/u,
  );
});

test("showcase export refuses an existing destination without changing it", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "moondog-showcase-existing-test-"),
  );
  try {
    const outputPath = path.join(temporaryRoot, "showcase");
    const markerPath = path.join(outputPath, "keep.txt");
    await mkdir(outputPath, { mode: 0o700 });
    await writeFile(markerPath, "keep\n", { mode: 0o600 });
    await assert.rejects(
      exportShowcase({ outputPath }),
      /destination already exists/u,
    );
    assert.equal(await readFile(markerPath, "utf8"), "keep\n");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("showcase command creates an exact host-ready fictional bundle", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "moondog-showcase-export-test-"),
  );
  try {
    const outputPath = path.join(temporaryRoot, "showcase");
    const exporterPath = path.join(repositoryRoot, "scripts", "export-showcase.mjs");
    const { stdout } = await execFileAsync(
      process.execPath,
      [exporterPath, "--output", outputPath],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeout: 30_000,
      },
    );
    assert.match(stdout, /Exported host-ready showcase: 7 public files/u);
    assert.match(stdout, /No publication performed\./u);
    assert.deepEqual((await readdir(outputPath)).sort(), [
      "assets",
      "index.html",
      "manifest.json",
    ]);

    const html = await readFile(path.join(outputPath, "index.html"), "utf8");
    assert.match(html, /Your listening history, made useful\./u);
    assert.match(html, /http-equiv="Content-Security-Policy"/u);
    assert.match(html, /src="assets\/demo\/moondog-time-machine-preview\.png"/u);
    assert.match(html, /href="assets\/demo\/moondog-tasteprint-demo\.html#time-machine"/u);
    assert.doesNotMatch(html, /\.\.\/assets\//u);
    assert.doesNotMatch(html, /<script\b/iu);
    assert.doesNotMatch(html, /\bhttps?:\/\//iu);

    const manifestText = await readFile(
      path.join(outputPath, "manifest.json"),
      "utf8",
    );
    const manifest = JSON.parse(manifestText);
    assert.equal(manifest.schema, "moondog.showcase-export.v1");
    assert.equal(manifest.site_root, ".");
    assert.equal(manifest.entrypoint, "index.html");
    assert.equal(manifest.public_tree.file_count, 7);
    assert.match(manifest.public_tree.sha256, /^[a-f0-9]{64}$/u);
    assert.deepEqual(manifest.verification, {
      source_allowlist: "passed",
      exported_references: "passed",
      static_content_security_policy: "passed",
    });
    assert.deepEqual(manifest.boundaries, {
      fictional_demonstration_data_only: true,
      scripts_included: false,
      external_resources_included: false,
      private_listener_state_included: false,
      publication_performed: false,
    });
    assert.equal(manifestText.includes(repositoryRoot), false);
    assert.equal(manifestText.includes(temporaryRoot), false);
    assert.equal(await exists(path.join(outputPath, ".git")), false);

    for (const file of manifest.public_tree.files) {
      const buffer = await readFile(path.join(outputPath, file.path));
      assert.equal(buffer.length, file.bytes, file.path);
      assert.equal(
        createHash("sha256").update(buffer).digest("hex"),
        file.sha256,
        file.path,
      );
    }
    if (process.platform !== "win32") {
      assert.equal((await lstat(outputPath)).mode & 0o777, 0o700);
      assert.equal(
        (await lstat(path.join(outputPath, "index.html"))).mode & 0o777,
        0o600,
      );
      assert.equal(
        (await lstat(path.join(outputPath, "manifest.json"))).mode & 0o777,
        0o600,
      );
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
