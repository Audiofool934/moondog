import assert from "node:assert/strict";
import test from "node:test";

import { retryTransientUpload } from "../../app/release-publication.mjs";
import { commandFailure } from "../../app/release-tools.mjs";

const quiet = { wait: async () => {}, warn: () => {} };

test("a timed-out upload to GitHub is tried again, at most three times", async () => {
  let calls = 0;
  const result = await retryTransientUpload(async () => {
    calls += 1;
    if (calls < 3) throw commandFailure("gh", { code: 1, stderr: "gh: Request Timeout (HTTP 408)" });
    return "published";
  }, quiet);
  assert.equal(result, "published");
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(retryTransientUpload(async () => { calls += 1; throw commandFailure("gh", { code: 1, stderr: "HTTP 502" }); }, quiet), /HTTP 502/u);
  assert.equal(calls, 3);
});

test("a broken connection counts as transient, and other failures stop at once", async () => {
  const timeout = commandFailure("gh", { code: 1, stderr: "Post \"https://uploads.github.com/x\": net/http: TLS handshake timeout" });
  assert.equal(timeout.networkTimeout, true);
  assert.doesNotMatch(timeout.message, /uploads\.github\.com/u);
  let calls = 0;
  await retryTransientUpload(async () => { calls += 1; if (calls === 1) throw timeout; }, quiet);
  assert.equal(calls, 2);
  for (const error of [commandFailure("gh", { code: 1, stderr: "HTTP 422" }), new Error("Remote asset differs: x.dmg. It was not overwritten; publish a new version.")]) {
    calls = 0;
    await assert.rejects(retryTransientUpload(async () => { calls += 1; throw error; }, quiet));
    assert.equal(calls, 1);
  }
});
