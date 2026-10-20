import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createToolTrace } from "../../src/runtime/pi/tool-trace.mjs";

test("tool calls are kept locally, one JSON line each, in a file per day", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-trace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const trace = createToolTrace({ MOONDOG_STATE_HOME: root }, { now: () => new Date("2026-10-20T19:00:00.000Z") });
  trace.record({ session: "s1", call: "c1", tool: "moondog_spotify_search", state: "start", args: { query: "伍佰 被动" } });
  await trace.record({ session: "s1", call: "c1", tool: "moondog_spotify_search", state: "done", result: "x".repeat(5_000) });
  const lines = (await readFile(path.join(root, "traces", "2026-10-20.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((line) => line.state), ["start", "done"]);
  assert.equal(lines[0].args, '{"query":"伍佰 被动"}');
  assert.equal(lines[1].result.length, 4_001);
  assert.equal(createToolTrace({ MOONDOG_STATE_HOME: root, MOONDOG_TRACE: "off" }), null);
});
