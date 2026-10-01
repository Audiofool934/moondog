import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PublicPiModelCatalog } from "../../src/runtime/pi/public-model-catalog.mjs";
import { createPiModels } from "../../src/runtime/pi/model-catalog.mjs";
import { createConfiguredRuntime } from "../../src/runtime/pi/configured-runtime.mjs";
import { writePiRuntimeSelection } from "../../src/runtime/pi/runtime-settings.mjs";

const response = id => Response.json({ [id]: { ...createPiModels().getModel("deepseek", "deepseek-flash"), id, name: "Fictional process model" } });
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-catalog-process-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, environment: { MOONDOG_CONFIG_HOME: root } };
}
function worker(t, root, id) {
  const child = fork(new URL("../fixtures/model-catalog/worker.mjs", import.meta.url), [root, id], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const messages = []; const waits = [];
  child.on("message", message => { messages.push(message); for (const accept of [...waits]) accept(message); });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  const wait = event => new Promise((resolve, reject) => {
    const seen = messages.find(message => message.event === event);
    if (seen) return resolve(seen);
    const timer = setTimeout(() => reject(new Error(`Missing catalog worker ${event}: ${JSON.stringify(messages)}`)), 10_000);
    const accept = message => { if (message.event === event) { clearTimeout(timer); waits.splice(waits.indexOf(accept), 1); resolve(message); } };
    waits.push(accept);
  });
  return { child, wait, send: message => child.send(message) };
}

test("an older catalog instance cannot erase a saved remote-only model from disk", async t => {
  const { environment } = await fixture(t);
  const a = new PublicPiModelCatalog({ environment, fetchImpl: async () => response("fictional-first") });
  const b = new PublicPiModelCatalog({ environment, fetchImpl: async () => response("fictional-second") });
  await Promise.all([a.ready, b.ready]);
  // Construct the singleton before either publication to reproduce an old app.
  const options = { runtimeFactory: value => value };
  await writePiRuntimeSelection({ provider: "deepseek", model: "deepseek-flash" }, environment);
  await createConfiguredRuntime({}, { ...environment, DEEPSEEK_API_KEY: "FICTIONAL_KEY" }, options);
  await a.refresh({ provider: "deepseek", force: true });
  await writePiRuntimeSelection({ provider: "deepseek", model: "fictional-first" }, environment);
  await b.refresh({ provider: "deepseek", force: true });
  const restored = new PublicPiModelCatalog({ environment }); await restored.ready;
  assert.ok(restored.models("deepseek").some(model => model.id === "fictional-first"));
  assert.ok(restored.models("deepseek").some(model => model.id === "fictional-second"));
  const configured = await createConfiguredRuntime({}, { ...environment, DEEPSEEK_API_KEY: "FICTIONAL_KEY" }, options);
  assert.equal(configured.model.id, "fictional-first");
});

test("independent processes preserve both catalog generations and a saved selection", async t => {
  const { root, environment } = await fixture(t);
  const a = worker(t, root, "fictional-first"), b = worker(t, root, "fictional-second");
  await Promise.all([a.wait("ready"), b.wait("ready")]);
  a.send("start"); await a.wait("fetch");
  b.send("start"); a.send("release");
  assert.equal((await a.wait("done")).result[0].state, "updated");
  await writePiRuntimeSelection({ provider: "deepseek", model: "fictional-first" }, environment);
  await b.wait("fetch"); b.send("release");
  const second = await b.wait("done");
  assert.equal(second.result[0].state, "updated");
  assert.ok(second.ids.includes("fictional-first"));
  const file = path.join(root, "model-catalog", "deepseek.json");
  const cached = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(cached.models.map(model => model.id).sort(), ["fictional-first", "fictional-second"]);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const configured = await createConfiguredRuntime({}, { ...environment, DEEPSEEK_API_KEY: "FICTIONAL_KEY" }, { runtimeFactory: value => value });
  assert.equal(configured.model.id, "fictional-first");
});

test("a failed process holding the public cache lock is recoverable without touching auth", async t => {
  const { root, environment } = await fixture(t);
  const holder = worker(t, root, "fictional-unpublished");
  await holder.wait("ready"); holder.send("start"); await holder.wait("fetch");
  const exited = once(holder.child, "exit"); holder.child.kill("SIGKILL"); await exited;
  const catalog = new PublicPiModelCatalog({ environment, fetchImpl: async () => response("fictional-recovered") });
  assert.equal((await catalog.refresh({ provider: "deepseek", force: true }))[0].state, "updated");
  assert.ok(catalog.models("deepseek").some(model => model.id === "fictional-recovered"));
  assert.ok(!catalog.models("deepseek").some(model => model.id === "fictional-unpublished"));
  await assert.rejects(stat(path.join(root, "auth.json")), { code: "ENOENT" });
});

for (const mode of ["cancel", "timeout"]) {
  test(`${mode} while another process holds the catalog lock is bounded and sends no request`, async t => {
    const { root, environment } = await fixture(t);
    const holder = worker(t, root, "fictional-holder");
    await holder.wait("ready"); holder.send("start"); await holder.wait("fetch");
    let fetches = 0;
    const catalog = new PublicPiModelCatalog({ environment, timeoutMs: 50, fetchImpl: async () => { fetches++; return response("fictional-waiter"); } });
    const controller = new AbortController();
    const pending = catalog.refresh({ provider: "deepseek", force: true, signal: controller.signal });
    if (mode === "cancel") { controller.abort(); await assert.rejects(pending, { name: "AbortError" }); }
    else assert.deepEqual((await pending)[0], { provider: "deepseek", state: "failed", reason: "timeout" });
    assert.equal(fetches, 0);
    assert.ok(await stat(path.join(root, "model-catalog", "deepseek.json.lock")));
    holder.send("release"); assert.equal((await holder.wait("done")).result[0].state, "updated");
  });
}
