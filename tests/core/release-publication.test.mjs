import assert from "node:assert/strict";
import test from "node:test";
import { assertPublishedPackage, packageIntegrity, prepareRelease, publishFailureSummary, readGithubRelease, registryRequest } from "../../scripts/release-npm.mjs";

const version = "0.2.1", head = "a".repeat(40), bytes = Buffer.from("fictional package archive");
const metadata = { name: "@audiofool/moondog", version, gitHead: head, dist: { integrity: packageIntegrity(bytes) } };
function fixture({ existing = null, latest = "0.2.0", release = null } = {}) {
  let published = existing, tags = { latest };
  const effects = [], logs = [], clock = { elapsed: 0 };
  return { effects, logs, clock, options: { version, head, integrity: packageIntegrity(bytes),
    now: () => clock.elapsed,
    sleep: async ms => { clock.elapsed += ms; },
    log: message => logs.push(message),
    readTags: async () => tags,
    readVersion: async () => published,
    readTarball: async () => bytes,
    latestGithubVersion: async () => "0.2.0",
    publish: async channel => { effects.push("publish"); published = metadata; tags = { ...tags, [channel]: version }; },
    readRelease: async () => release,
    createDraft: async channel => { effects.push(`draft:${channel}`); },
  } };
}

test("first publication verifies npm before preparing a draft", async () => {
  const f = fixture();
  assert.deepEqual(await prepareRelease(f.options), { channel: "latest", resumed: false, draft: true });
  assert.deepEqual(f.effects, ["publish", "draft:latest"]);
});

test("retry after npm success creates only the missing draft", async () => {
  const f = fixture({ existing: metadata, latest: version });
  await prepareRelease(f.options);
  assert.deepEqual(f.effects, ["draft:latest"]);
  f.options.readRelease = async () => ({ tagName: `v${version}`, isPrerelease: false, isDraft: true });
  f.effects.length = 0;
  assert.equal((await prepareRelease(f.options)).draft, true);
  assert.deepEqual(f.effects, []);
});

test("a lost publish response is recovered by verifying the registry", async () => {
  const f = fixture(), publish = f.options.publish;
  f.options.publish = async channel => { await publish(channel); throw new Error("connection lost"); };
  await prepareRelease(f.options);
  assert.deepEqual(f.effects, ["publish", "draft:latest"]);
});

test("an existing version must match both commit and tarball bytes", async () => {
  for (const bad of [{ ...metadata, gitHead: "b".repeat(40) }, { ...metadata, dist: { integrity: packageIntegrity(Buffer.from("different")) } }]) {
    const f = fixture({ existing: bad, latest: version });
    await assert.rejects(prepareRelease(f.options), /does not match/u);
    assert.deepEqual(f.effects, []);
  }
  assert.throws(() => assertPublishedPackage(metadata, { version, head, integrity: packageIntegrity(bytes) }, Buffer.from("corrupted")), /tarball/u);
});

test("old releases cannot move npm or GitHub latest backwards", async () => {
  for (const source of ["npm", "github"]) {
    const f = fixture({ latest: source === "npm" ? "0.3.0" : "0.2.0" });
    if (source === "github") f.options.latestGithubVersion = async () => "0.3.0";
    await assert.rejects(prepareRelease(f.options), /Refusing to promote/u);
    assert.deepEqual(f.effects, []);
  }
});

test("a newer release appearing during publication blocks draft promotion", async () => {
  const f = fixture();
  let reads = 0;
  f.options.readTags = async () => ({ latest: ++reads === 1 ? "0.2.0" : "0.3.0" });
  await assert.rejects(prepareRelease(f.options), /Refusing to promote/u);
  assert.deepEqual(f.effects, ["publish"]);
});

test("an unconfirmed npm publication never creates a GitHub draft", async () => {
  const f = fixture();
  f.options.publish = async () => { f.effects.push("publish"); throw new Error("registry unavailable"); };
  await assert.rejects(prepareRelease(f.options), /could not be confirmed after 180s.*npm publish failed/u);
  assert.deepEqual(f.effects, ["publish"]);
  assert.equal(f.clock.elapsed, 180_000);
});

test("a verified preview creates a prerelease draft without moving stable", async () => {
  const f = fixture({ existing: metadata });
  f.options.version = "0.3.0-beta.1";
  f.options.readVersion = async () => ({ ...metadata, version: f.options.version });
  f.options.readTags = async () => ({ latest: "0.2.0", beta: f.options.version });
  assert.equal((await prepareRelease(f.options)).channel, "beta");
  assert.deepEqual(f.effects, ["draft:beta"]);
});

test("an interrupted release never silently retags or changes a public release", async () => {
  const stale = fixture({ existing: metadata });
  await assert.rejects(prepareRelease(stale.options), /Restore that dist-tag explicitly/u);
  assert.deepEqual(stale.effects, []);
  const publicRelease = fixture({ existing: metadata, latest: version,
    release: { tagName: `v${version}`, isPrerelease: false, isDraft: false } });
  assert.equal((await prepareRelease(publicRelease.options)).draft, false);
  assert.deepEqual(publicRelease.effects, []);
});

test("publication waits through delayed metadata, tarball and channel without publishing twice", async () => {
  const f = fixture();
  // The incident's metadata appeared 66 seconds after the old confirmation window ended.
  f.options.readVersion = async () => f.clock.elapsed >= 76_000 ? metadata : null;
  f.options.readTarball = async () => {
    if (f.clock.elapsed < 90_000) throw Object.assign(new Error("Registry request failed with HTTP 404."), { retryable: true });
    return bytes;
  };
  f.options.readTags = async () => ({ latest: f.clock.elapsed >= 100_000 ? version : "0.2.0" });
  await prepareRelease(f.options);
  assert.equal(f.clock.elapsed, 100_000);
  assert.deepEqual(f.effects, ["publish", "draft:latest"]);
  assert.ok(f.logs.some(line => line.includes("70/180s") && line.includes("metadata")));
  assert.ok(f.logs.some(line => line.includes("npm publish exited successfully")));
  assert.ok(f.logs.some(line => line.includes("Verified npm 0.2.1 commit, tarball and latest after 100s")));
});

test("successful publish with no public version stops at the deadline without creating a draft", async () => {
  const f = fixture();
  let reads = 0;
  f.options.readVersion = async () => { reads++; return null; };
  await assert.rejects(prepareRelease(f.options), /after 180s.*metadata is not visible.*publish exited successfully/u);
  assert.deepEqual(f.effects, ["publish"]);
  assert.equal(f.clock.elapsed, 180_000);
  assert.equal(reads, 19); // One preflight, then 18 polls, with no request after the deadline.
});

test("slow transient reads share the same deadline rather than adding a timeout per retry", async () => {
  const f = fixture();
  const timeouts = [];
  f.options.waitTimeoutMs = 65_000;
  f.options.readVersion = async options => {
    if (!options) return null;
    timeouts.push(options.timeoutMs);
    f.clock.elapsed += options.timeoutMs;
    throw Object.assign(new Error("Registry request timed out or could not connect."), { retryable: true });
  };
  await assert.rejects(prepareRelease(f.options), /after 65s/u);
  assert.deepEqual(timeouts, [20_000, 20_000, 5_000]);
  assert.equal(f.clock.elapsed, 65_000);
  assert.deepEqual(f.effects, ["publish"]);
});

test("a mismatched delayed publication fails immediately and never creates a release", async () => {
  const f = fixture();
  let tarballReads = 0;
  f.options.readVersion = async () => f.clock.elapsed < 70_000 ? null : { ...metadata, gitHead: "b".repeat(40) };
  f.options.readTarball = async () => { tarballReads++; return bytes; };
  await assert.rejects(prepareRelease(f.options), /Git commit/u);
  assert.equal(f.clock.elapsed, 70_000);
  assert.equal(tarballReads, 0);
  assert.deepEqual(f.effects, ["publish"]);
});

test("existing corrupted bytes fail without publishing, waiting or creating a draft", async () => {
  const f = fixture({ existing: metadata, latest: version });
  f.options.readTarball = async () => Buffer.from("wrong archive");
  await assert.rejects(prepareRelease(f.options), /tarball does not match/u);
  assert.equal(f.clock.elapsed, 0);
  assert.deepEqual(f.effects, []);
});

test("publish diagnostics retain exit and npm error codes without leaking captured output", async () => {
  const secret = "fictional-private-token";
  // Build a synthetic credential URL only in memory; it is never requested.
  const unsafeUrl = new URL("https://registry.example.invalid/");
  unsafeUrl.username = "fixture";
  unsafeUrl.password = secret;
  unsafeUrl.searchParams.set("token", secret);
  const failure = Object.assign(new Error(`publish failed: ${secret}`), {
    code: 1, stdout: `Authorization: Bearer ${secret}`,
    stderr: `npm error code E403\nnpm error Access denied: ${unsafeUrl}\n`,
  });
  assert.equal(publishFailureSummary(failure), "npm publish failed (exit 1; npm E403).");
  const f = fixture();
  f.options.publish = async () => { f.effects.push("publish"); throw failure; };
  await assert.rejects(prepareRelease(f.options), error => {
    assert.match(error.message, /exit 1; npm E403/u);
    assert.ok(!error.message.includes(secret));
    return true;
  });
  assert.ok(f.logs.some(line => line.includes("exit 1; npm E403")));
  assert.ok(f.logs.every(line => !line.includes(secret)));
  assert.deepEqual(f.effects, ["publish"]);
});

test("registry reads bypass negative caches and consume missing responses before retry", async () => {
  const requests = [];
  let cancelled = false;
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (requests.length === 1) return { ok: false, status: 404, body: { cancel: async () => { cancelled = true; } } };
    return new Response(JSON.stringify(metadata));
  };
  const url = "https://registry.npmjs.org/@audiofool%2fmoondog/0.2.1";
  assert.equal(await registryRequest(url, { missing: true, fetchImpl }), null);
  assert.equal(cancelled, true);
  assert.deepEqual(await registryRequest(url, { missing: true, fetchImpl }), metadata);
  assert.notEqual(requests[0].url.search, requests[1].url.search);
  for (const request of requests) {
    assert.equal(request.url.origin, "https://registry.npmjs.org");
    assert.equal(request.url.pathname, "/@audiofool%2fmoondog/0.2.1");
    assert.equal(request.options.headers["Cache-Control"], "no-cache");
    assert.equal(request.options.headers.Pragma, "no-cache");
    assert.equal(request.options.redirect, "error");
  }
});

test("registry parse and stream failures never include private response content", async () => {
  const privateMarker = "fictional-private-response";
  for (const fetchImpl of [
    async () => new Response(`${privateMarker}: not JSON`),
    async () => ({ ok: true, body: { async *[Symbol.asyncIterator]() { throw new Error(privateMarker); } } }),
  ]) {
    await assert.rejects(registryRequest("https://registry.npmjs.org/fixture", { fetchImpl }), error => {
      assert.ok(!error.message.includes(privateMarker));
      assert.ok(!JSON.stringify(error).includes(privateMarker));
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});

test("structured command diagnostics preserve only allowlisted npm codes", () => {
  const failure = { code: 1, npmCodes: ["E403", "not a safe code", "E403"] };
  assert.equal(publishFailureSummary(failure), "npm publish failed (exit 1; npm E403).");
});

test("only missing, throttled and server/network registry failures are retryable", async () => {
  for (const status of [401, 403, 404, 429, 503]) {
    await assert.rejects(registryRequest("https://registry.npmjs.org/fixture", {
      fetchImpl: async () => new Response("failure", { status }),
    }), error => {
      assert.equal(error.retryable, [404, 429, 503].includes(status));
      assert.match(error.message, new RegExp(`HTTP ${status}`, "u"));
      return true;
    });
  }
  await assert.rejects(registryRequest("https://registry.npmjs.org/fixture", {
    fetchImpl: async () => { throw new Error("network error with fictional private details"); },
  }), error => error.retryable && !error.message.includes("private details"));
});

test("an existing draft is resumed through list and release ID without querying the by-tag endpoint", async () => {
  const f = fixture({ existing: metadata, latest: version });
  const draft = { id: 42, tag_name: `v${version}`, draft: true, prerelease: false };
  const requests = [];
  f.options.readRelease = channel => readGithubRelease({ tag: `v${version}`, prerelease: channel === "beta",
    request: async endpoint => {
      requests.push(endpoint);
      if (endpoint === "releases?per_page=100&page=1") return [draft];
      if (endpoint === "releases/42") return draft;
      throw new Error("The by-tag endpoint would return 404 for this draft.");
    },
  });
  assert.deepEqual(await prepareRelease(f.options), { channel: "latest", resumed: true, draft: true });
  assert.deepEqual(f.effects, []);
  assert.deepEqual(requests, ["releases?per_page=100&page=1", "releases/42"]);
});

test("a release whose identity changes between listing and ID lookup cannot be resumed or recreated", async () => {
  const f = fixture({ existing: metadata, latest: version });
  const draft = { id: 42, tag_name: `v${version}`, draft: true, prerelease: false };
  f.options.readRelease = channel => readGithubRelease({ tag: `v${version}`, prerelease: channel === "beta",
    request: async endpoint => endpoint.startsWith("releases?") ? [draft] : { ...draft, tag_name: "v0.2.2" },
  });
  await assert.rejects(prepareRelease(f.options), /release.*(identity|tag)|tag.*match/iu);
  assert.deepEqual(f.effects, []);
});
