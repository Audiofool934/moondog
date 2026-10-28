import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { readEndpoints } from "../../src/runtime/pi/custom-endpoints.mjs";
import { runEndpointCommand } from "../../src/surfaces/cli/endpoint-command.mjs";

function terminal(answers) {
  // A plain stream stands in for the keyboard; the command is told it is interactive.
  const input = new PassThrough();
  let shown = "";
  const output = new PassThrough();
  output.isTTY = true;
  output.on("data", (chunk) => {
    shown += chunk;
    // Answer each question once it is asked, a moment later, as a listener types.
    if (answers.length && /:\s*$/u.test(String(chunk))) {
      const answer = answers.shift();
      setImmediate(() => input.write(`${answer}\n`));
    }
  });
  return { input, output, shown: () => shown };
}

test("an endpoint added in the terminal keeps its key out of sight and out of the output", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-endpoint-command-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const environment = { MOONDOG_CONFIG_HOME: root };
  const screen = terminal(["Gateway", "https://gateway.example/v1", "openai", "sk-ENDPOINT-SENTINEL", "house-model, deepseek-flash"]);
  let printed = "";
  const result = await runEndpointCommand({
    args: ["add"], environment, input: screen.input, progressOutput: screen.output, output: { write: (text) => { printed += text; } },
    signalTarget: new EventEmitter(), interactive: true,
  });
  assert.equal(result.id, "endpoint-gateway");
  assert.deepEqual(result.models, ["house-model", "deepseek-flash"]);
  assert.match(printed, /Saved Gateway as endpoint-gateway, with 2 models and its key/u);
  assert.equal(`${printed}${screen.shown()}`.includes("SENTINEL"), false, "the key is never shown");
  assert.equal((await readEndpoints(environment))[0].key, "sk-ENDPOINT-SENTINEL");

  const listed = await runEndpointCommand({ args: ["list"], environment, output: { write() {} } });
  assert.equal(listed.length, 1);
  await runEndpointCommand({ args: ["remove", "gateway"], environment, output: { write() {} } });
  assert.deepEqual(await readEndpoints(environment), []);
  await assert.rejects(runEndpointCommand({ args: ["add", "sk-in-args"], environment, output: { write() {} } }), /hidden prompt/u);
});
