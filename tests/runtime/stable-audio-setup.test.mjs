import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createLocalGenerator, readGenerationSettings, writeGenerationSettings } from "../../src/integrations/stable-audio/local-generator.mjs";
import { createStableAudioSetup } from "../../src/integrations/stable-audio/setup.mjs";
import { STABLE_AUDIO_SOURCES } from "../../src/integrations/stable-audio/sources.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

const run = async (command, args, options) => {
  const child = spawn(command, args, { stdio: "ignore", ...options });
  const [code] = await once(child, "exit");
  assert.equal(code, 0, `${command} ${args.join(" ")}`);
};
const exists = (file) => stat(file).then(() => true, () => false);
const until = async (condition, { timeout = 5000 } = {}) => {
  const started = Date.now();
  while (!(await condition())) {
    if (Date.now() - started > timeout) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

// Small stand-ins for the official downloads, with their real sizes and sha256 in the sources, served
// by a local server that honors Range like GitHub and Hugging Face do. No test reaches the network.
async function fakeSources(t, { tamperCode = false } = {}) {
  const folder = await mkdtemp(path.join(tmpdir(), "moondog-sa3-setup-"));
  t.after(() => rm(folder, { recursive: true, force: true }));

  // uv: a shell script that makes the environment's python and logs what it was asked.
  const uvTree = path.join(folder, "uv-src", "uv-aarch64-apple-darwin");
  await mkdir(uvTree, { recursive: true });
  await writeFile(path.join(uvTree, "uv"), `#!/bin/sh
echo "$* | $UV_CACHE_DIR | $UV_PYTHON_INSTALL_DIR | $UV_INDEX_URL" >> "$FAKE_UV_LOG"
if [ "$1" = "venv" ]; then
  for last; do :; done
  mkdir -p "$last/bin" && printf '#!/bin/sh\\nexit 0\\n' > "$last/bin/python" && chmod +x "$last/bin/python"
fi
if [ "$1" = "pip" ] && [ -n "$FAKE_UV_FAIL" ]; then exit 3; fi
exit 0
`);
  await chmod(path.join(uvTree, "uv"), 0o755);
  await run("/usr/bin/tar", ["-czf", path.join(folder, "uv.tar.gz"), "-C", path.join(folder, "uv-src"), "uv-aarch64-apple-darwin"]);
  const uv = await readFile(path.join(folder, "uv.tar.gz"));

  // The code: a few files under the repository's top folder, with a file the run must not reach.
  const top = `stable-audio-3-${COMMIT}`;
  const code = { "scripts/sa3_mlx.py": "# stand-in\n", "models/defs/__init__.py": "", "README.md": "Stable Audio 3\n" };
  for (const [file, text] of Object.entries(code)) {
    await mkdir(path.dirname(path.join(folder, "code-src", top, "optimized", "mlx", file)), { recursive: true });
    await writeFile(path.join(folder, "code-src", top, "optimized", "mlx", file), tamperCode && file === "README.md" ? "changed\n" : text);
  }
  await writeFile(path.join(folder, "code-src", top, "LICENSE"), "MIT\n");
  await run("/usr/bin/tar", ["-czf", path.join(folder, "code.tar.gz"), "-C", path.join(folder, "code-src"), top]);
  const codeTarball = await readFile(path.join(folder, "code.tar.gz"));

  const weights = Object.fromEntries(Object.keys(STABLE_AUDIO_SOURCES.weights.files).map((name) => [name, randomBytes(4096)]));
  const served = new Map([["/uv.tar.gz", uv], ["/code.tar.gz", codeTarball], ...Object.entries(weights).map(([name, bytes]) => [`/w/${name}`, bytes])]);
  const requests = [];
  // Per path: "tamper" serves other bytes of the same size; "full" ignores Range; "stall" sends 2000 bytes and waits.
  const behavior = new Map();
  const stalled = new Set();
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    requests.push({ path: url.pathname, range: request.headers.range ?? null });
    let body = served.get(url.pathname);
    if (!body) { response.writeHead(404).end(); return; }
    const mode = behavior.get(url.pathname);
    if (mode === "tamper") body = Buffer.from(body).fill(7, 100, 200);
    const range = /^bytes=(\d+)-$/u.exec(request.headers.range ?? "");
    if (range && mode !== "full") {
      const start = Number(range[1]);
      if (start >= body.length) { response.writeHead(416).end(); return; }
      response.writeHead(206, { "content-length": body.length - start, "content-range": `bytes ${start}-${body.length - 1}/${body.length}` });
      response.end(body.subarray(start));
      return;
    }
    response.writeHead(200, { "content-length": body.length });
    if (mode === "stall") { response.write(body.subarray(0, 2000)); stalled.add(response); return; }
    response.end(body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const sources = {
    uv: { version: "0.9.7", url: `${base}/uv.tar.gz`, size: uv.length, sha256: sha256(uv) },
    code: { commit: COMMIT, url: `${base}/code.tar.gz`, folder: `${top}/optimized/mlx`,
      files: Object.entries(code).map(([file, text]) => [file, Buffer.byteLength(text), sha256(text)]) },
    python: { version: "3.11.14", packages: ["mlx==0.32.4", "numpy==2.4.6"] },
    weights: { url: (name) => `${base}/w/${name}`, files: Object.fromEntries(Object.entries(weights).map(([name, bytes]) => [name, { size: bytes.length, sha256: sha256(bytes) }])) },
    licenses: STABLE_AUDIO_SOURCES.licenses,
  };
  const environment = {
    PATH: process.env.PATH,
    MOONDOG_STATE_HOME: path.join(folder, "state"),
    MOONDOG_CONFIG_HOME: path.join(folder, "config"),
    FAKE_UV_LOG: path.join(folder, "uv.log"),
    // The listener's own uv settings never reach the setup's uv.
    UV_INDEX_URL: "https://elsewhere.invalid/simple",
  };
  const root = path.join(folder, "state", "stable-audio-3");
  const setup = (options = {}) => createStableAudioSetup({ environment, sources, platform: "darwin", arch: "arm64", ...options });
  const fetched = (prefix) => requests.filter((entry) => entry.path.startsWith(prefix));
  const uvLog = () => readFile(path.join(folder, "uv.log"), "utf8").catch(() => "");
  return { folder, root, environment, sources, weights, setup, requests, fetched, behavior, stalled, uvLog };
}

test("the first download waits for the licenses, then sets up uv, the code, Python and Medium, verified, and turns music making on", async (t) => {
  const fake = await fakeSources(t);
  const setup = fake.setup();
  await assert.rejects(setup.install("medium"), (error) => error.code === "setup_license_required" && error.licenses.length === 2);
  assert.equal(setup.status().licenses.accepted, false);
  assert.deepEqual(fake.requests, [], "nothing is downloaded before the agreement");
  await assert.rejects(setup.install("small"), { code: "setup_model_unknown" });

  const snapshots = [];
  const unsubscribe = setup.subscribe((snapshot) => snapshots.push(snapshot));
  const started = await setup.install("medium", { accepted: true });
  assert.equal(started.job.running, true);
  await assert.rejects(setup.install("small-music"), { code: "setup_busy" });
  const done = await setup.wait();
  unsubscribe();

  assert.equal(done.job, null);
  assert.deepEqual(done.base, { uv: "ready", code: "ready", python: "ready" });
  assert.equal(done.models.medium.state, "ready");
  assert.equal(done.models.medium.bytes, done.models.medium.total);
  assert.equal(done.models["small-music"].state, "absent", "the shared text encoder alone is no model");
  assert.equal(done.licenses.accepted, true);
  assert.ok(snapshots.some((snapshot) => snapshot.job?.step === "weights"), "progress reached the listener");
  assert.ok(snapshots.every((snapshot, index) => index === 0 || JSON.stringify(snapshot) !== JSON.stringify(snapshots[index - 1])));

  // Only the code's checked files, none of the repository around them.
  assert.ok(await exists(path.join(fake.root, "mlx", "scripts", "sa3_mlx.py")));
  assert.equal(await exists(path.join(fake.root, "mlx", "LICENSE")), false);
  assert.deepEqual(await readdir(path.join(fake.root, "downloads")), [], "no download is left behind");
  assert.equal(await exists(path.join(fake.root, "setup.lock")), false);

  const log = await fake.uvLog();
  assert.match(log, /^venv --clear --python 3\.11\.14 \S+\/mlx\/\.venv \| \S+\/stable-audio-3\/uv-cache \| \S+\/stable-audio-3\/python \| $/mu);
  assert.match(log, /^pip install --python \S+\/\.venv\/bin\/python mlx==0\.32\.4 numpy==2\.4\.6 \|/mu);
  assert.doesNotMatch(log, /elsewhere/u);

  const settings = await readGenerationSettings(fake.environment);
  assert.deepEqual([settings.enabled, settings.source, settings.model, settings.path], [true, "managed", "medium", path.join(fake.root, "mlx")]);
  const generator = createLocalGenerator({ environment: fake.environment, platform: "darwin", arch: "arm64" });
  const status = await generator.check();
  assert.deepEqual([status.state, status.managed, status.model], ["ready", true, "medium"]);

  // The next model downloads only its own weights, and Medium stays in use.
  const before = fake.requests.length;
  await setup.install("small-music");
  const both = await setup.wait();
  assert.deepEqual(fake.requests.slice(before).map((entry) => entry.path).sort(), ["/w/dit_sm-music_f16.npz", "/w/same_s_decoder_f32.npz"]);
  assert.equal(both.models["small-music"].state, "ready");
  assert.equal((await readGenerationSettings(fake.environment)).model, "medium");
});

test("a download resumes from its .part file, a server that ignores Range starts over, and a file that fails its sha256 is deleted", async (t) => {
  const fake = await fakeSources(t);
  const setup = fake.setup();
  await mkdir(path.join(fake.root, "downloads"), { recursive: true });
  await writeFile(path.join(fake.root, "downloads", "dit_medium_f16.npz.part"), fake.weights["dit_medium_f16.npz"].subarray(0, 1000));
  await writeFile(path.join(fake.root, "downloads", "t5gemma_f16.npz.part"), fake.weights["t5gemma_f16.npz"].subarray(0, 500));
  fake.behavior.set("/w/t5gemma_f16.npz", "full");
  fake.behavior.set("/w/same_l_decoder_f32.npz", "tamper");
  await setup.install("medium", { accepted: true });
  const failed = await setup.wait();

  assert.deepEqual(fake.fetched("/w/dit_medium").map((entry) => entry.range), ["bytes=1000-"]);
  assert.deepEqual(fake.fetched("/w/t5gemma").map((entry) => entry.range), ["bytes=500-"]);
  const weights = path.join(fake.root, "mlx", "models", "mlx");
  assert.deepEqual(await readFile(path.join(weights, "dit_medium_f16.npz")), fake.weights["dit_medium_f16.npz"]);
  assert.deepEqual(await readFile(path.join(weights, "t5gemma_f16.npz")), fake.weights["t5gemma_f16.npz"]);
  assert.equal(failed.job.running, false);
  assert.equal(failed.job.error.code, "setup_verification_failed");
  assert.equal(await exists(path.join(weights, "same_l_decoder_f32.npz")), false);
  assert.equal(await exists(path.join(fake.root, "downloads", "same_l_decoder_f32.npz.part")), false, "a file that failed is deleted");
  assert.equal(failed.models.medium.state, "partial");
  assert.equal(await exists(path.join(fake.root, "setup.lock")), false);
  assert.notEqual((await readGenerationSettings(fake.environment)).source, "managed", "nothing switches to a broken install");

  // Try again downloads only what is still missing.
  fake.behavior.delete("/w/same_l_decoder_f32.npz");
  const before = fake.requests.length;
  await setup.install("medium");
  const ready = await setup.wait();
  assert.deepEqual(fake.requests.slice(before).map((entry) => entry.path), ["/w/same_l_decoder_f32.npz"]);
  assert.equal(ready.models.medium.state, "ready");
  assert.equal(ready.job, null);
});

test("code that differs from the pinned manifest is deleted, and the job fails", async (t) => {
  const fake = await fakeSources(t, { tamperCode: true });
  const setup = fake.setup();
  await setup.install("medium", { accepted: true });
  const failed = await setup.wait();
  assert.equal(failed.job.error.code, "setup_verification_failed");
  assert.equal(failed.job.step, "verifying");
  assert.equal(failed.base.code, "absent");
  assert.deepEqual((await readdir(fake.root)).filter((name) => name.startsWith("mlx")), []);
  assert.deepEqual(fake.fetched("/w/"), [], "no weights are fetched for code that failed");
});

test("not enough space stops the job before it downloads", async (t) => {
  const fake = await fakeSources(t);
  const setup = fake.setup({ freeSpace: async () => 100 * 1024 ** 2 });
  await setup.install("medium", { accepted: true });
  const failed = await setup.wait();
  assert.equal(failed.job.error.code, "setup_disk_full");
  assert.match(failed.job.error.message, /not enough space/u);
  assert.deepEqual(fake.requests, []);
});

test("the other process sees a running job and can cancel it; the partial download stays for the next install", async (t) => {
  const fake = await fakeSources(t);
  fake.behavior.set("/w/dit_medium_f16.npz", "stall");
  const window = fake.setup();
  const terminal = fake.setup();
  await window.install("medium", { accepted: true });
  await until(() => fake.stalled.size === 1);
  // The running process writes its progress to the status file, which the other one reads.
  await until(() => terminal.status().job?.received >= 2000);
  const seen = terminal.status().job;
  assert.deepEqual([seen.model, seen.step, seen.running], ["medium", "weights", true]);
  assert.equal(terminal.status().models.medium.state, "partial");
  await assert.rejects(terminal.install("small-music"), { code: "setup_busy" });
  await assert.rejects(terminal.remove("medium"), { code: "setup_busy" });

  assert.equal(await terminal.cancel(), true);
  const ended = await window.wait();
  assert.equal(ended.job, null, "a cancel is not an error");
  assert.equal((await stat(path.join(fake.root, "downloads", "dit_medium_f16.npz.part"))).size, 2000);
  assert.equal(await exists(path.join(fake.root, "setup.lock")), false);
  assert.equal(terminal.status().job, null);

  // The next install continues where the cancel stopped it.
  fake.behavior.delete("/w/dit_medium_f16.npz");
  await terminal.install("medium");
  assert.equal((await terminal.wait()).models.medium.state, "ready");
  assert.deepEqual(fake.fetched("/w/dit_medium").map((entry) => entry.range), [null, "bytes=2000-"]);
});

test("a cancel in the same process stops the job at once", async (t) => {
  const fake = await fakeSources(t);
  fake.behavior.set("/w/t5gemma_f16.npz", "stall");
  const setup = fake.setup();
  await setup.install("medium", { accepted: true });
  await until(() => fake.stalled.size === 1);
  assert.equal(await setup.cancel(), true);
  assert.equal(setup.status().job, null);
  assert.equal(await setup.cancel(), false, "nothing runs to cancel");
});

test("closing stops this process's own job and leaves another process's job alone", async (t) => {
  const fake = await fakeSources(t);
  fake.behavior.set("/w/t5gemma_f16.npz", "stall");
  const setup = fake.setup();
  assert.equal(await setup.close(), false, "nothing of its own runs");
  await setup.install("medium", { accepted: true });
  await until(() => fake.stalled.size === 1);
  assert.equal(await setup.close(), true);
  assert.equal(setup.status().job, null, "the room can close without waiting for the download");

  const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => other.kill());
  await writeFile(path.join(fake.root, "setup.lock"), JSON.stringify({ pid: other.pid, token: "theirs", model: "small-music" }));
  assert.equal(await fake.setup().close(), false);
  assert.equal(await exists(path.join(fake.root, "cancel.json")), false, "the other window's download is not asked to stop");
});

test("a lock held by a running process refuses a second job; one left by a process that ended is taken over", async (t) => {
  const fake = await fakeSources(t);
  const setup = fake.setup();
  await mkdir(fake.root, { recursive: true });
  const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => other.kill());
  await writeFile(path.join(fake.root, "setup.lock"), JSON.stringify({ pid: other.pid, token: "theirs", model: "small-music" }));
  await writeFile(path.join(fake.root, "job.json"), JSON.stringify({ pid: other.pid, token: "theirs", model: "small-music", step: "python", received: 0, total: 0 }));
  await assert.rejects(setup.install("medium", { accepted: true }), { code: "setup_busy" });
  assert.deepEqual(setup.status().job, { model: "small-music", step: "python", received: 0, total: 0, running: true });

  other.kill();
  await once(other, "exit");
  assert.equal(setup.status().job, null, "a crashed job does not show as running");
  await setup.install("medium");
  assert.equal((await setup.wait()).models.medium.state, "ready");
});

test("remove deletes a model's own files, moves music making to what is left, and deletes everything with the last model", async (t) => {
  const fake = await fakeSources(t);
  const setup = fake.setup();
  await setup.install("medium", { accepted: true });
  await setup.wait();
  await setup.install("small-music");
  await setup.wait();

  const afterMedium = await setup.remove("medium");
  assert.equal(afterMedium.models.medium.state, "absent");
  assert.equal(afterMedium.models["small-music"].state, "ready", "the shared text encoder stays");
  const switched = await readGenerationSettings(fake.environment);
  assert.deepEqual([switched.source, switched.model], ["managed", "small-music"]);

  const afterAll = await setup.remove("small-music");
  assert.equal(await exists(fake.root), false, "uv, the code, Python and the caches go with the last model");
  assert.deepEqual(afterAll.base, { uv: "absent", code: "absent", python: "absent" });
  assert.equal(afterAll.licenses.accepted, true, "the agreement is kept");
  assert.notEqual((await readGenerationSettings(fake.environment)).source, "managed");
});

test("the listener's own folder is kept when a download finishes, and stays chosen until they pick a model", async (t) => {
  const fake = await fakeSources(t);
  // The listener's own folder, which the setup never touches.
  const own = path.join(fake.folder, "own", "mlx");
  await mkdir(path.join(own, "scripts"), { recursive: true });
  await writeFile(path.join(own, "scripts", "sa3_mlx.py"), "# theirs\n");
  await mkdir(path.join(own, ".venv", "bin"), { recursive: true });
  await writeFile(path.join(own, ".venv", "bin", "python"), "#!/bin/sh\n");
  await chmod(path.join(own, ".venv", "bin", "python"), 0o755);
  await mkdir(path.join(own, "models", "mlx"), { recursive: true });
  for (const name of ["t5gemma_f16.npz", "dit_medium_f16.npz", "same_l_decoder_f32.npz"]) await writeFile(path.join(own, "models", "mlx", name), Buffer.alloc(2048));
  await writeGenerationSettings({ enabled: true, path: own }, fake.environment);

  const setup = fake.setup();
  await setup.install("small-music", { accepted: true });
  await setup.wait();
  assert.equal((await readGenerationSettings(fake.environment)).source, "settings", "a folder that runs stays in use");

  // Choosing an installed model switches to Moondog's install; the folder stays saved for later.
  const chosen = await writeGenerationSettings({ model: "small-music" }, fake.environment);
  assert.deepEqual([chosen.source, chosen.path, chosen.folder], ["managed", path.join(fake.root, "mlx"), own]);
  const back = await writeGenerationSettings({ source: "settings" }, fake.environment);
  assert.deepEqual([back.source, back.path], ["settings", own]);

  await setup.remove("small-music");
  assert.ok(await exists(path.join(own, "models", "mlx", "dit_medium_f16.npz")), "the listener's folder is never deleted");
});

test("the setup refuses a Mac without Apple silicon", async (t) => {
  const fake = await fakeSources(t);
  const setup = fake.setup({ platform: "linux", arch: "x64" });
  assert.equal(setup.status().supported, false);
  await assert.rejects(setup.install("medium", { accepted: true }), { code: "setup_unsupported" });
});

test("a first setup stopped before any model's weights arrived can still be removed", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "moondog-sa3-leftover-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const environment = { MOONDOG_STATE_HOME: home, MOONDOG_CONFIG_HOME: home };
  const setup = createStableAudioSetup({ environment, platform: "darwin", arch: "arm64" });
  // What a cancelled first setup leaves: uv and caches, but no model's own weights.
  await mkdir(path.join(setup.root, "uv-cache"), { recursive: true });
  await writeFile(path.join(setup.root, "uv-cache", "wheel"), "partial");
  assert.equal(setup.status().models.medium.state, "partial", "the model it was for offers Remove");
  assert.equal(setup.status().models["small-music"].state, "absent");
  await setup.remove("medium");
  assert.equal(await exists(setup.root), false, "removing it takes the whole setup away");
});

test("removing the last managed model goes back to the listener's folder with a model it has", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "moondog-sa3-fallback-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const environment = { MOONDOG_STATE_HOME: home, MOONDOG_CONFIG_HOME: home };
  // The listener's own folder, with Medium only.
  const own = path.join(home, "own", "mlx");
  await mkdir(path.join(own, "scripts"), { recursive: true });
  await mkdir(path.join(own, ".venv", "bin"), { recursive: true });
  await mkdir(path.join(own, "models", "mlx"), { recursive: true });
  await writeFile(path.join(own, "scripts", "sa3_mlx.py"), "# stand-in\n");
  await writeFile(path.join(own, ".venv", "bin", "python"), "#!/bin/sh\n");
  await chmod(path.join(own, ".venv", "bin", "python"), 0o755);
  for (const name of ["t5gemma_f16.npz", "dit_medium_f16.npz", "same_l_decoder_f32.npz"]) await writeFile(path.join(own, "models", "mlx", name), randomBytes(2048));
  await writeGenerationSettings({ enabled: true, path: own }, environment);
  // Then managed Small Music, in use.
  const setup = createStableAudioSetup({ environment, platform: "darwin", arch: "arm64" });
  await mkdir(path.join(setup.root, "mlx", "models", "mlx"), { recursive: true });
  await writeFile(path.join(setup.root, "mlx", "models", "mlx", "dit_sm-music_f16.npz"), "partial");
  await writeGenerationSettings({ source: "managed", model: "small-music" }, environment);
  await setup.remove("small-music");
  const settings = await readGenerationSettings(environment);
  assert.deepEqual([settings.source, settings.path, settings.model], ["settings", own, "medium"]);
  const generator = createLocalGenerator({ environment, platform: "darwin", arch: "arm64" });
  assert.equal((await generator.check()).state, "ready", "the folder that worked before still works");
});

test("switching back to the listener's folder keeps a model that folder has", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "moondog-sa3-switch-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const environment = { MOONDOG_STATE_HOME: home, MOONDOG_CONFIG_HOME: home };
  const own = path.join(home, "own", "mlx");
  await mkdir(path.join(own, "scripts"), { recursive: true });
  await mkdir(path.join(own, ".venv", "bin"), { recursive: true });
  await mkdir(path.join(own, "models", "mlx"), { recursive: true });
  await writeFile(path.join(own, "scripts", "sa3_mlx.py"), "# stand-in\n");
  await writeFile(path.join(own, ".venv", "bin", "python"), "#!/bin/sh\n");
  await chmod(path.join(own, ".venv", "bin", "python"), 0o755);
  for (const name of ["t5gemma_f16.npz", "dit_medium_f16.npz", "same_l_decoder_f32.npz"]) await writeFile(path.join(own, "models", "mlx", name), randomBytes(2048));
  const generator = createLocalGenerator({ environment, platform: "darwin", arch: "arm64" });
  await generator.save({ enabled: true, source: "managed", model: "small-music" });
  // Settings' folder field, or /generation on <folder>, gives the folder and no model.
  await generator.save({ enabled: true, path: own });
  const status = await generator.check();
  assert.deepEqual([status.state, status.model, status.managed], ["ready", "medium", false]);
});

test("with MOONDOG_SA3_DIR pinning a folder, a managed model chosen meanwhile never breaks it", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "moondog-sa3-pinned-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const pinned = path.join(home, "pinned", "mlx");
  await mkdir(path.join(pinned, "scripts"), { recursive: true });
  await mkdir(path.join(pinned, ".venv", "bin"), { recursive: true });
  await mkdir(path.join(pinned, "models", "mlx"), { recursive: true });
  await writeFile(path.join(pinned, "scripts", "sa3_mlx.py"), "# stand-in\n");
  await writeFile(path.join(pinned, ".venv", "bin", "python"), "#!/bin/sh\n");
  await chmod(path.join(pinned, ".venv", "bin", "python"), 0o755);
  for (const name of ["t5gemma_f16.npz", "dit_medium_f16.npz", "same_l_decoder_f32.npz"]) await writeFile(path.join(pinned, "models", "mlx", name), randomBytes(2048));
  const environment = { MOONDOG_STATE_HOME: home, MOONDOG_CONFIG_HOME: home, MOONDOG_SA3_DIR: pinned };
  const generator = createLocalGenerator({ environment, platform: "darwin", arch: "arm64" });
  await generator.save({ enabled: true });
  // Settings' Use, or /generation use small, with the variable still set.
  await generator.save({ enabled: true, source: "managed", model: "small-music" });
  const status = await generator.check();
  assert.deepEqual([status.state, status.source, status.model], ["ready", "environment", "medium"]);
});

// A folder of the listener's own with the given models' weights.
async function ownFolder(home, name, models) {
  const own = path.join(home, name, "mlx");
  await mkdir(path.join(own, "scripts"), { recursive: true });
  await mkdir(path.join(own, ".venv", "bin"), { recursive: true });
  await mkdir(path.join(own, "models", "mlx"), { recursive: true });
  await writeFile(path.join(own, "scripts", "sa3_mlx.py"), "# stand-in\n");
  await writeFile(path.join(own, ".venv", "bin", "python"), "#!/bin/sh\n");
  await chmod(path.join(own, ".venv", "bin", "python"), 0o755);
  const files = { medium: ["dit_medium_f16.npz", "same_l_decoder_f32.npz"], "small-music": ["dit_sm-music_f16.npz", "same_s_decoder_f32.npz"] };
  for (const file of ["t5gemma_f16.npz", ...models.flatMap((model) => files[model])]) await writeFile(path.join(own, "models", "mlx", file), randomBytes(2048));
  return own;
}

test("a save made while MOONDOG_SA3_DIR pins a folder never writes that folder's model into the file", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "moondog-sa3-pinned-save-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const pinned = await ownFolder(home, "pinned", ["medium"]);
  const plain = { MOONDOG_STATE_HOME: home, MOONDOG_CONFIG_HOME: home };
  await writeGenerationSettings({ enabled: true, source: "managed", model: "small-music" }, plain);
  // /generation off and on in a terminal started with the variable.
  const pinnedEnvironment = { ...plain, MOONDOG_SA3_DIR: pinned };
  await writeGenerationSettings({ enabled: false }, pinnedEnvironment, { platform: "darwin", arch: "arm64" });
  await writeGenerationSettings({ enabled: true }, pinnedEnvironment, { platform: "darwin", arch: "arm64" });
  const file = await readGenerationSettings(plain);
  assert.deepEqual([file.source, file.model, file.enabled], ["managed", "small-music", true], "the window without the variable still runs Moondog's install");
});

test("the listener's own folder runs a model it has, whatever model the file names", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "moondog-sa3-own-read-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const environment = { MOONDOG_STATE_HOME: home, MOONDOG_CONFIG_HOME: home };
  const own = await ownFolder(home, "own", ["small-music"]);
  // A file an older Moondog wrote: a folder and no model, which reads as Medium.
  await writeFile(path.join(home, "generation.json"), JSON.stringify({ version: 1, enabled: true, path: own }));
  const generator = createLocalGenerator({ environment, platform: "darwin", arch: "arm64" });
  const status = await generator.check();
  assert.deepEqual([status.state, status.model], ["ready", "small-music"]);
  // A folder typed before it is installed gets Medium, the model the install steps download.
  const empty = path.join(home, "empty", "mlx");
  await generator.save({ path: empty });
  assert.equal((await readGenerationSettings(environment)).model, "medium");
});
