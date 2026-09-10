import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { openSpotifyResolutionCache } from "../../src/integrations/spotify/resolution-cache.mjs";
import { openListeningHistoryStore } from "../../src/profile/listening-history-store.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function runMoondog(args, environment) {
  return execFileAsync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", "scripts/moondog.mjs", ...args],
    {
      cwd: repositoryRoot,
      env: environment,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
}

async function missing(filePath) {
  await assert.rejects(access(filePath), { code: "ENOENT" });
}

test("data help and empty inspection do not initialize local state", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-data-cli-empty-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const stateRoot = path.join(root, "state");
  const environment = {
    ...process.env,
    MOONDOG_STATE_HOME: stateRoot,
    MOONDOG_CONFIG_HOME: path.join(root, "config"),
  };

  const help = await runMoondog(["data", "help"], environment);
  assert.match(help.stdout, /data inspect --scope/iu);
  assert.match(help.stdout, /never silently deletes/iu);
  await missing(stateRoot);

  const inspection = JSON.parse(
    (await runMoondog(
      ["data", "inspect", "--scope", "listening", "--json"],
      environment,
    )).stdout,
  );
  assert.equal(inspection.state, "empty");
  assert.equal(inspection.writes, "none");
  await missing(stateRoot);
});

test("data CLI inspects, exports, and recoverably resets one explicit scope", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-data-cli-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const stateRoot = path.join(root, "state");
  const environment = {
    ...process.env,
    MOONDOG_STATE_HOME: stateRoot,
    MOONDOG_CONFIG_HOME: path.join(root, "config"),
  };
  const store = await openListeningHistoryStore({ environment });
  const subjectId = store.localSubjectId({ create: true });
  store.close();
  const cache = await openSpotifyResolutionCache({ environment });
  cache.close();
  const tasteprintsPath = path.join(stateRoot, "tasteprints");
  await mkdir(tasteprintsPath, { mode: 0o700 });
  await writeFile(path.join(tasteprintsPath, "profile.html"), "private\n", {
    mode: 0o600,
  });
  const memoryPath = path.join(stateRoot, "memory.sqlite");
  await writeFile(memoryPath, "MEMORY_SENTINEL\n", { mode: 0o600 });

  const inspection = JSON.parse(
    (await runMoondog(
      ["data", "inspect", "--scope", "listening", "--json"],
      environment,
    )).stdout,
  );
  assert.equal(inspection.state, "ready");
  assert.equal(inspection.subject_id, subjectId);
  assert.equal(inspection.totals.components, 3);

  const outputPath = path.join(root, "export");
  const exported = JSON.parse(
    (await runMoondog(
      [
        "data",
        "export",
        "--scope",
        "listening",
        "--output",
        outputPath,
        "--json",
      ],
      environment,
    )).stdout,
  );
  assert.equal(exported.path, outputPath);
  assert.equal(exported.source_changed, false);
  await access(path.join(outputPath, "manifest.json"));

  await assert.rejects(
    runMoondog(
      [
        "data",
        "reset",
        "--scope",
        "listening",
        "--confirm",
        "reset-listening-not-current",
      ],
      environment,
    ),
    (error) => {
      assert.match(error.stderr, /does not match the current selected state/iu);
      return true;
    },
  );
  await access(path.join(stateRoot, "listening-history.sqlite"));

  const reset = JSON.parse(
    (await runMoondog(
      [
        "data",
        "reset",
        "--scope",
        "listening",
        "--confirm",
        inspection.reset_confirmation,
        "--json",
      ],
      environment,
    )).stdout,
  );
  assert.equal(reset.state, "archived");
  assert.equal(reset.deletion, "none");
  assert.equal(reset.archives.length, 3);
  await access(reset.manifest_path);
  await missing(path.join(stateRoot, "listening-history.sqlite"));
  await missing(path.join(stateRoot, "spotify-resolution-cache.sqlite"));
  await missing(tasteprintsPath);
  assert.equal(await readFile(memoryPath, "utf8"), "MEMORY_SENTINEL\n");

  const after = JSON.parse(
    (await runMoondog(
      ["data", "inspect", "--scope", "listening", "--json"],
      environment,
    )).stdout,
  );
  assert.equal(after.state, "empty");
});
