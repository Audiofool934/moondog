import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { activeInstallationProcesses, compareReleaseVersions, createApplicationUpdater, releaseVersion } from "../../src/core/application-update.mjs";
import { parseUpdateArguments, runUpdateCommand } from "../../src/surfaces/cli/update-command.mjs";
import { releaseChannel } from "../../scripts/release-version.mjs";

const exec = promisify(execFile);
const command = async (file, args, options = {}) => (await exec(file, args, { ...options, encoding: "utf8" })).stdout.trim();
const name = "@audiofool/moondog";
const archive = Buffer.from("fictional tarball: the test package preparer is injected");
const metadata = (version = "0.2.0", extra = {}) => ({ name, version, repository: { url: "git+https://github.com/Audiofool934/moondog.git" }, engines: { node: ">=22.19.0" }, dist: { tarball: `https://registry.npmjs.org/@audiofool/moondog/-/moondog-${version}.tgz`, integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}` }, ...extra });
const json = file => readFile(file, "utf8").then(JSON.parse);
async function packageAt(root, version) {
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name, version, type: "module" }));
  await writeFile(path.join(root, "scripts/moondog.mjs"), `import { readFileSync } from 'node:fs'; console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version);\n`);
  await writeFile(path.join(root, "scripts/moondog"), "#!/bin/sh\n");
}
async function fixture(t, { mode = "npm", version = "0.1.0" } = {}) {
  const temporary = await realpath(await mkdtemp(path.join(tmpdir(), "moondog-update-test-")));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = mode === "npm" ? path.join(temporary, "prefix/lib/node_modules/@audiofool/moondog") : path.join(temporary, "source");
  await packageAt(root, version);
  const config = path.join(temporary, "config"), state = path.join(temporary, "state");
  await mkdir(config); await mkdir(state);
  await writeFile(path.join(config, "auth.json"), "fixture credential stays local");
  await writeFile(path.join(state, "history.sqlite"), "fixture history stays local");
  const environment = { ...process.env, MOONDOG_CONFIG_HOME: config, MOONDOG_STATE_HOME: state, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = args => command("git", ["-C", root, ...args], { env: environment });
  if (mode === "npm") {
    await mkdir(path.join(temporary, "prefix/bin"), { recursive: true });
    await symlink(path.join(root, "scripts/moondog"), path.join(temporary, "prefix/bin/moondog"));
  } else if (mode === "source") {
    await git(["init", "-b", "main"]); await git(["config", "user.email", "fixture@example.invalid"]); await git(["config", "user.name", "Fixture"]);
    await writeFile(path.join(root, ".gitignore"), "node_modules\n");
    await git(["add", "."]); await git(["commit", "-m", "old release"]);
    await git(["remote", "add", "origin", "https://github.com/Audiofool934/moondog.git"]);
  }
  await mkdir(path.join(root, "node_modules")); await writeFile(path.join(root, "node_modules/old"), "previous dependency");
  let release = metadata(), fetches = 0, afterPrepare;
  const calls = [];
  const run = async (file, args, options = {}) => {
    calls.push({ file, args });
    if (file === "fixture-npm") {
      const stage = args[0] === "ci" ? options.cwd : path.join(args[args.indexOf("--prefix") + 1], "node_modules/@audiofool/moondog");
      if (args[0] !== "ci") await packageAt(stage, release.version);
      await mkdir(path.join(stage, "node_modules"), { recursive: true });
      await writeFile(path.join(stage, "node_modules/new"), "new dependency");
      await afterPrepare?.(stage);
      return "";
    }
    if (file === "git" && args.includes("fetch")) return ""; // Tags are created in the local fixture; no network.
    return command(file, args, options);
  };
  const options = { root, environment, run, npm: "fixture-npm", activeProcesses: async () => [],
    fetchImpl: async (url, opts) => { fetches++; assert.match(url, /^https:\/\/registry\.npmjs\.org\//u); assert.equal(opts.redirect, "error"); if (url.endsWith(".tgz")) return new Response(archive); assert.deepEqual(Object.keys(opts.headers), ["Accept"]); return new Response(JSON.stringify(release)); } };
  return { root, temporary, config, state, git, calls, options, updater: createApplicationUpdater(options),
    set release(value) { release = value; }, get fetches() { return fetches; }, set afterPrepare(fn) { afterPrepare = fn; },
    async unchangedData() {
      assert.equal(await readFile(path.join(config, "auth.json"), "utf8"), "fixture credential stays local");
      assert.equal(await readFile(path.join(state, "history.sqlite"), "utf8"), "fixture history stays local");
    },
    async sourceRelease() {
      const previous = await git(["rev-parse", "HEAD"]);
      await packageAt(root, "0.2.0"); await git(["add", "."]); await git(["commit", "-m", "new release"]);
      const target = await git(["rev-parse", "HEAD"]); await git(["tag", "v0.2.0"]); await git(["reset", "--hard", previous]);
      release = metadata("0.2.0", { gitHead: target }); return { previous, target };
    },
  };
}

test("release ordering, argument validation and publication channels agree", () => {
  assert.ok(compareReleaseVersions("0.2.0", "0.2.0-beta.9") > 0);
  assert.ok(compareReleaseVersions("0.2.0-beta.10", "0.2.0-beta.9") > 0);
  for (const version of ["v1.0.0", "1.0.0-rc.1", "01.2.3", "1.0.0;touch", "9999999.0.0"]) assert.equal(releaseVersion(version), null);
  assert.deepEqual(parseUpdateArguments(["--check", "--channel", "beta"]), { checkOnly: true, channel: "beta" });
  for (const args of [["--dry-run"], ["--channel"], ["--check", "--check"], ["--channel", "evil"]]) assert.throws(() => parseUpdateArguments(args));
  assert.equal(releaseChannel({ name, version: "0.2.0-beta.1", lockVersion: "0.2.0-beta.1", tag: "v0.2.0-beta.1" }), "beta");
  assert.throws(() => releaseChannel({ name, version: "0.2.0", lockVersion: "0.1.0", tag: "v0.2.0" }));
});

test("version checks cache metadata, keep data private and honor opt-out/offline", async t => {
  const f = await fixture(t);
  assert.equal((await f.updater.check()).state, "available"); await f.updater.check(); assert.equal(f.fetches, 1);
  await f.updater.check({ force: true }); assert.equal(f.fetches, 2);
  const off = createApplicationUpdater({ ...f.options, environment: { ...f.options.environment, MOONDOG_UPDATE_CHECK: "off" } });
  assert.equal(await off.startupCheck(), null);
  const offline = createApplicationUpdater({ ...f.options, fetchImpl: async () => { throw new Error("offline"); } });
  assert.equal((await offline.check({ force: true })).state, "unavailable");
  const missing = createApplicationUpdater({ ...f.options, fetchImpl: async () => new Response("", { status: 404 }) });
  assert.match((await missing.check({ channel: "beta", force: true })).message, /No beta release/u);
  await f.unchangedData();
});

test("invalid metadata, unsupported Node and unmanaged installs never prepare a package", async t => {
  const f = await fixture(t);
  for (const bad of [metadata("0.2.0-beta.1"), metadata("0.2.0", { repository: { url: "https://example.invalid" } }), metadata("0.2.0", { name: "different" })]) {
    f.release = bad; assert.equal((await f.updater.check({ force: true })).state, "unavailable");
  }
  f.release = metadata("0.2.0", { engines: { node: ">=999.0.0" } });
  await assert.rejects(f.updater.apply(), { code: "update_node_required" });
  const local = await fixture(t, { mode: "local" });
  await assert.rejects(local.updater.apply(), { code: "update_installation_unmanaged" });
  assert.equal(f.calls.filter(call => call.file === "fixture-npm").length, 0);
});

test("npm installs in staging, preserves the launcher and old package, and saves channel only on success", async t => {
  const f = await fixture(t); f.release = metadata("0.2.0-beta.1");
  const result = await f.updater.apply({ channel: "beta" });
  assert.equal(result.state, "updated"); assert.equal(await f.updater.version(), "0.2.0-beta.1");
  assert.equal((await json(path.join(result.recoveryBackup, "package.json"))).version, "0.1.0");
  assert.equal(await realpath(path.join(f.temporary, "prefix/bin/moondog")), path.join(f.root, "scripts/moondog"));
  assert.equal((await json(path.join(f.config, "updates/settings.json"))).channel, "beta");
  assert.ok(f.calls.find(call => call.file === "fixture-npm").args.includes("--install-strategy=nested"));
  await f.unchangedData();
});

test("failed staging and failed post-install smoke restore exact previous npm package", async t => {
  for (const postInstall of [false, true]) {
    const f = await fixture(t);
    const updater = createApplicationUpdater({ ...f.options, run: async (file, args, options) => {
      if (file === process.execPath && (!postInstall || args[0] === path.join(f.root, "scripts/moondog.mjs"))) throw new Error("smoke failure");
      return f.options.run(file, args, options);
    } });
    await assert.rejects(updater.apply(), { code: "update_failed" });
    assert.equal(await updater.version(), "0.1.0");
    assert.equal(await readFile(path.join(f.root, "node_modules/old"), "utf8"), "previous dependency");
    assert.equal((await readdir(path.dirname(f.root))).filter(file => file.startsWith(".moondog-update")).length, 0);
    await f.unchangedData();
  }
});

test("source release verifies tag identity, fast-forwards, and replaces prepared dependencies", async t => {
  const f = await fixture(t, { mode: "source" }); const { target } = await f.sourceRelease();
  const result = await f.updater.apply();
  assert.equal(result.state, "updated"); assert.equal(await f.git(["rev-parse", "HEAD"]), target);
  assert.equal(await f.git(["status", "--porcelain"]), "");
  assert.equal(await readFile(path.join(result.recoveryBackup, "old"), "utf8"), "previous dependency");
  await f.unchangedData();
});

test("source rollback restores commit and dependencies after failed installed smoke", async t => {
  const f = await fixture(t, { mode: "source" }); const { previous } = await f.sourceRelease();
  const updater = createApplicationUpdater({ ...f.options, run: (file, args, options) => {
    if (file === process.execPath && args[0] === path.join(f.root, "scripts/moondog.mjs")) throw new Error("post-install failure");
    return f.options.run(file, args, options);
  } });
  await assert.rejects(updater.apply(), { code: "update_failed" });
  assert.equal(await f.git(["rev-parse", "HEAD"]), previous);
  assert.equal(await readFile(path.join(f.root, "node_modules/old"), "utf8"), "previous dependency");
  await f.unchangedData();
});

test("dirty, changed, wrong-branch and mismatched source checkouts are not overwritten", async t => {
  for (const problem of ["dirty", "changed", "branch", "identity"]) {
    const f = await fixture(t, { mode: "source" }); const { previous } = await f.sourceRelease();
    if (problem === "dirty") await writeFile(path.join(f.root, "notes.txt"), "keep this");
    if (problem === "changed") f.afterPrepare = () => writeFile(path.join(f.root, "notes.txt"), "keep this");
    if (problem === "branch") await f.git(["checkout", "-b", "my-work"]);
    if (problem === "identity") f.release = metadata("0.2.0", { gitHead: previous });
    await assert.rejects(f.updater.apply(), { code: problem === "branch" ? "update_source_branch" : problem === "identity" ? "update_release_unverified" : "update_source_dirty" });
    assert.equal(await f.git(["rev-parse", "HEAD"]), previous);
    if (["dirty", "changed"].includes(problem)) assert.equal(await readFile(path.join(f.root, "notes.txt"), "utf8"), "keep this");
  }
});

test("active sessions checked before preparation and again before replacement", async t => {
  for (const late of [false, true]) {
    const f = await fixture(t); let checks = 0;
    const updater = createApplicationUpdater({ ...f.options, activeProcesses: async () => ++checks >= (late ? 2 : 1) ? [123] : [] });
    await assert.rejects(updater.apply(), { code: "update_session_active" });
    assert.equal(await updater.version(), "0.1.0"); await f.unchangedData();
  }
});

test("installation lock excludes a second updater with a different config home and new launches", async t => {
  const f = await fixture(t);
  let releasePreparation, started;
  const start = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { releasePreparation = resolve; });
  f.afterPrepare = async () => { started(); await gate; };
  const installing = f.updater.apply(); await start;
  try {
    const second = createApplicationUpdater({ ...f.options, environment: { ...f.options.environment, MOONDOG_CONFIG_HOME: path.join(f.temporary, "other-config") } });
    await assert.rejects(second.apply(), { code: "update_busy" });
    await assert.rejects(second.assertNotUpdating(), { code: "update_busy" });
  } finally { releasePreparation(); }
  assert.equal((await installing).state, "updated");
});

test("cancellation before replacement preserves old files; cancellation after replacement reports success truthfully", async t => {
  for (const late of [false, true]) {
    const f = await fixture(t), controller = new AbortController();
    if (!late) f.afterPrepare = () => controller.abort();
    const result = f.updater.apply({ signal: controller.signal, onProgress: text => { if (late && text.startsWith("Installing")) controller.abort(); } });
    if (late) { assert.equal((await result).state, "updated"); assert.equal(await f.updater.version(), "0.2.0"); }
    else { await assert.rejects(result, { name: "AbortError" }); assert.equal(await f.updater.version(), "0.1.0"); }
    await f.unchangedData();
  }
});

test("TUI preparation never installs, and read-only checks never select a channel", async t => {
  const f = await fixture(t);
  const check = await runUpdateCommand({ updater: f.updater, args: ["--check", "--channel", "beta"], deferInstall: true });
  assert.equal(check.update, undefined);
  const request = await runUpdateCommand({ updater: f.updater, deferInstall: true });
  assert.deepEqual(request.update, { channel: "latest" });
  assert.equal(await f.updater.version(), "0.1.0");
  await assert.rejects(readFile(path.join(f.config, "updates/settings.json")), { code: "ENOENT" });
});

test("process checks recognize absolute and relative launchers without logging arguments", async () => {
  const root = "/tmp/fixture-moondog";
  const output = `101 node node ${root}/scripts/moondog.mjs\n102 node node scripts/moondog.mjs\n103 node node /tmp/other/scripts/moondog.mjs\n104 node node scripts/unrelated.mjs\n105 node node ${root}/scripts/moondog.mjs`;
  const run = async (file, args) => file === "ps" ? output : `p${args[2]}\nn${args[2] === "102" ? root : "/tmp/other"}`;
  assert.deepEqual(await activeInstallationProcesses(root, { run, ownPid: 105, platform: "darwin" }), [101, 102]);
  await assert.rejects(activeInstallationProcesses(root, { ownPid: 105, platform: "darwin", run: async file => { if (file === "ps") return output; throw new Error("denied"); } }), { code: "update_session_check_failed" });
});

test("configured data inside a replaced directory, including a symlink alias, stops installation", async t => {
  for (const key of ["MOONDOG_CONFIG_HOME", "MOONDOG_STATE_HOME", "MOONDOG_APPLE_IMPORTS_ROOT"]) {
    const f = await fixture(t);
    const internal = path.join(f.root, "private"); await mkdir(internal); await writeFile(path.join(internal, "keep"), "personal");
    const alias = path.join(f.temporary, "alias"); await symlink(internal, alias);
    const updater = createApplicationUpdater({ ...f.options, environment: { ...f.options.environment, [key]: alias } });
    await assert.rejects(updater.apply(), { code: "update_data_inside_installation" });
    assert.equal(await readFile(path.join(internal, "keep"), "utf8"), "personal");
    assert.equal(await updater.version(), "0.1.0");
  }
});

test("uncertain source merge completion observes HEAD and restores old program", async t => {
  const f = await fixture(t, { mode: "source" }); const { previous } = await f.sourceRelease();
  const updater = createApplicationUpdater({ ...f.options, run: async (file, args, options) => {
    const result = await f.options.run(file, args, options);
    if (file === "git" && args.includes("merge")) throw new Error("lost command completion after successful merge");
    return result;
  } });
  await assert.rejects(updater.apply(), { code: "update_failed" });
  assert.equal(await f.git(["rev-parse", "HEAD"]), previous);
  assert.equal(await readFile(path.join(f.root, "node_modules/old"), "utf8"), "previous dependency");
});

test("tarball integrity fails before npm executes, and exact launchers recognize custom Node names", async t => {
  const f = await fixture(t);
  const updater = createApplicationUpdater({ ...f.options, fetchImpl: (url, options) => url.endsWith(".tgz") ? Promise.resolve(new Response("wrong archive")) : f.options.fetchImpl(url, options) });
  await assert.rejects(updater.apply(), { code: "update_integrity_failed" });
  assert.equal(f.calls.filter(call => call.file === "fixture-npm").length, 0);
  assert.deepEqual(await activeInstallationProcesses(f.root, { run: async () => `123 node22 node22 ${f.root}/scripts/moondog.mjs`, ownPid: 456 }), [123]);
});

test("a numeric npm process exit code reports a retained installation", async t => {
  const f = await fixture(t);
  const updater = createApplicationUpdater({ ...f.options, run: (file, args, options) => {
    if (file === "fixture-npm") throw Object.assign(new Error("npm exited"), { code: 1 });
    return f.options.run(file, args, options);
  } });
  await assert.rejects(updater.apply(), { code: "update_failed" });
  assert.equal(await updater.version(), "0.1.0"); await f.unchangedData();
});
