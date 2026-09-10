import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const launcher = path.join(repositoryRoot, "scripts", "moondog");
const cliEntry = path.join(repositoryRoot, "scripts", "moondog.mjs");

async function createLauncherFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-launcher-"));
  const oldBin = path.join(root, "old-bin");
  const compatibleBin = path.join(root, "compatible-bin");
  const linkedBin = path.join(root, "linked-bin");
  const invocationLog = path.join(root, "invocation.log");
  await mkdir(oldBin);
  await mkdir(compatibleBin);
  await mkdir(linkedBin);

  const oldNode = path.join(oldBin, "node");
  const compatibleNode = path.join(compatibleBin, "node");
  const linkedLauncher = path.join(linkedBin, "moondog");

  await writeFile(oldNode, "#!/bin/sh\nexit 1\n");
  await writeFile(
    compatibleNode,
    `#!/bin/sh
if [ "$1" = "-e" ]; then
  exit 0
fi
printf '%s\\n' "$@" > "$MOONDOG_TEST_LOG"
`,
  );
  await chmod(oldNode, 0o755);
  await chmod(compatibleNode, 0o755);
  await symlink(launcher, linkedLauncher);

  return {
    root,
    oldBin,
    compatibleBin,
    linkedLauncher,
    invocationLog,
    oldNode,
  };
}

test("launcher skips an old PATH Node and resolves its npm-style symlink", async (context) => {
  if (process.platform === "win32") {
    context.skip("POSIX launcher test");
    return;
  }
  const fixture = await createLauncherFixture();
  try {
    const result = spawnSync(fixture.linkedLauncher, ["doctor"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fixture.oldBin}:${fixture.compatibleBin}:/usr/bin:/bin`,
        MOONDOG_NODE: "",
        MOONDOG_TEST_LOG: fixture.invocationLog,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const invocation = (await readFile(fixture.invocationLog, "utf8"))
      .trimEnd()
      .split("\n");
    assert.deepEqual(invocation, [
      "--disable-warning=ExperimentalWarning",
      cliEntry,
      "doctor",
    ]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("launcher rejects an incompatible MOONDOG_NODE override", async (context) => {
  if (process.platform === "win32") {
    context.skip("POSIX launcher test");
    return;
  }
  const fixture = await createLauncherFixture();
  try {
    const result = spawnSync(fixture.linkedLauncher, ["doctor"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fixture.compatibleBin}:/usr/bin:/bin`,
        MOONDOG_NODE: fixture.oldNode,
        MOONDOG_TEST_LOG: fixture.invocationLog,
      },
    });

    assert.equal(result.status, 1);
    assert.equal(
      result.stderr,
      "moondog: MOONDOG_NODE must point to Node >=22.19.0.\n",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
