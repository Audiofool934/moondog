import assert from "node:assert/strict";
import test from "node:test";
import { assertPublishedPackage, packageIntegrity, prepareRelease } from "../../scripts/release-npm.mjs";

const version = "0.2.1", head = "a".repeat(40), bytes = Buffer.from("fictional package archive");
const metadata = { name: "@audiofool/moondog", version, gitHead: head, dist: { integrity: packageIntegrity(bytes) } };
function fixture({ existing = null, latest = "0.2.0", release = null } = {}) {
  let published = existing, tags = { latest };
  const effects = [];
  return { effects, options: { version, head, integrity: packageIntegrity(bytes),
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
  await assert.rejects(prepareRelease(f.options), /registry unavailable/u);
  assert.deepEqual(f.effects, ["publish"]);
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
