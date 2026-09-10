import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

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

test("profile correction listing is read-only before a music identity exists", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-profile-empty-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const stateRoot = path.join(root, "state");
  const environment = {
    ...process.env,
    MOONDOG_STATE_HOME: stateRoot,
    MOONDOG_CONFIG_HOME: path.join(root, "config"),
    MOONDOG_APPLE_IMPORTS_ROOT: path.join(root, "apple-imports"),
    MOONDOG_APPLE_PROJECTION_PATH: path.join(root, "apple-projection.sqlite"),
  };

  const value = JSON.parse((await runMoondog(
    ["profile", "corrections", "--json"],
    environment,
  )).stdout);
  assert.equal(value.active, 0);
  assert.equal(value.writes, "none");
  await missing(stateRoot);

  await assert.rejects(
    runMoondog(
      ["profile", "correct", "--artist", "Pink Floyd", "--avoid"],
      environment,
    ),
    (error) => {
      assert.match(error.stderr, /No local music identity/iu);
      return true;
    },
  );
  await missing(stateRoot);
});

test("profile correction CLI changes the next Tasteprint and remains retractable", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-profile-cli-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const stateRoot = path.join(root, "state");
  const environment = {
    ...process.env,
    MOONDOG_STATE_HOME: stateRoot,
    MOONDOG_CONFIG_HOME: path.join(root, "config"),
    MOONDOG_APPLE_IMPORTS_ROOT: path.join(root, "apple-imports"),
    MOONDOG_APPLE_PROJECTION_PATH: path.join(root, "apple-projection.sqlite"),
  };
  const store = await openListeningHistoryStore({ environment });
  const subjectId = store.localSubjectId({ create: true });
  store.close();

  const avoided = JSON.parse((await runMoondog(
    [
      "profile",
      "correct",
      "--artist",
      "Pink Floyd",
      "--avoid",
      "--note",
      "This listening was contextual.",
      "--json",
    ],
    environment,
  )).stdout);
  assert.equal(avoided.subject_id, subjectId);
  assert.equal(avoided.stance, "avoid");

  const firstTaste = JSON.parse((await runMoondog(
    ["taste", "--json"],
    environment,
  )).stdout);
  assert.equal(firstTaste.listener_assertions.avoids[0].label, "Pink Floyd");
  assert.equal(firstTaste.curated_preferences.avoids[0].label, "Pink Floyd");

  const liked = JSON.parse((await runMoondog(
    [
      "profile",
      "correct",
      "--artist",
      "Pink Floyd",
      "--like",
      "--json",
    ],
    environment,
  )).stdout);
  assert.equal(liked.superseded_correction_id, avoided.correction_id);
  const history = JSON.parse((await runMoondog(
    ["profile", "corrections", "--all", "--json"],
    environment,
  )).stdout);
  assert.deepEqual(
    history.corrections.map((item) => item.state),
    ["active", "superseded"],
  );

  const secondTaste = JSON.parse((await runMoondog(
    ["taste", "--json"],
    environment,
  )).stdout);
  assert.equal(secondTaste.strong_preferences[0].label, "Pink Floyd");
  assert.equal(secondTaste.listener_assertions.preferences[0].stance, "like");

  const retracted = JSON.parse((await runMoondog(
    ["profile", "retract", liked.correction_id, "--json"],
    environment,
  )).stdout);
  assert.equal(retracted.state, "retracted");
  const active = JSON.parse((await runMoondog(
    ["profile", "corrections", "--json"],
    environment,
  )).stdout);
  assert.equal(active.active, 0);
  assert.deepEqual(active.corrections, []);
});
