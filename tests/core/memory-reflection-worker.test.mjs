import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { MoondogApplication } from "../../src/core/moondog-application.mjs";
import { openLocalMemoryStore } from "../../src/memory/local-memory-store.mjs";
import { runMemoryReflection } from "../../src/memory/reflection-worker.mjs";

async function withApplication(callback) {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-memory-worker-"));
  const memoryStore = await openLocalMemoryStore({
    databasePath: path.join(root, "memory.sqlite"),
  });
  const application = new MoondogApplication({ memoryStore });
  try {
    return await callback(application);
  } finally {
    application.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("memory worker skips runtime creation when there is no work", async () => {
  await withApplication(async (application) => {
    let runtimeCreated = false;
    const result = await runMemoryReflection({
      application,
      runtimeFactory: async () => {
        runtimeCreated = true;
        throw new Error("Runtime should not be created");
      },
    });
    assert.equal(result.state, "no_work");
    assert.equal(runtimeCreated, false);
  });
});

test("memory worker commits a model proposal and advances its checkpoint", async () => {
  await withApplication(async (application) => {
    application.commitCompletedPrompt(
      "Please keep this answer short.",
      "Sure.",
    );
    const runtimeFactory = async () => ({
      publicStatus() {
        return {
          state: "configured",
          provider: "faux",
          model: "faux-1",
        };
      },
      async reflect({ episodes }) {
        return {
          proposals: [
            {
              action: "ignore",
              episode_ids: episodes.map((episode) => episode.episode_id),
              reason: "This synthetic test batch is transient.",
            },
          ],
        };
      },
    });

    const result = await runMemoryReflection({ application, runtimeFactory });

    assert.equal(result.state, "completed");
    assert.equal(result.counts.ignored_episodes, 1);
    assert.equal(application.memoryReflectionStatus().pending_episodes, 0);
  });
});
