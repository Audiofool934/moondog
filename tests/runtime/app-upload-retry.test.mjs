import assert from "node:assert/strict";
import test from "node:test";

import { retryTransientUpload, uploadTimeoutMs } from "../../app/release-publication.mjs";
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

test("an upload that stalls past its time limit is tried again, and the limit follows the file's size", async () => {
  let calls = 0;
  await retryTransientUpload(async () => { calls += 1; if (calls === 1) throw commandFailure("gh", { code: null, signal: "SIGTERM", timedOut: true }); }, quiet);
  assert.equal(calls, 2);
  const minutes = (bytes, options) => uploadTimeoutMs(bytes, options) / 60_000;
  // The update feed and the manifest get the floor; a 150 MB ZIP sharing the line with the DMG gets about 41 minutes.
  assert.equal(minutes(1_500), 10);
  assert.equal(Math.round(minutes(150_887_031, { sharing: 2 })), 41);
  assert.ok(minutes(150_887_031) < minutes(150_887_031, { sharing: 2 }));
  // Never the flat two hours that once left a stalled ZIP waiting.
  assert.equal(minutes(2_000_000_000, { sharing: 2 }), 60);
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
