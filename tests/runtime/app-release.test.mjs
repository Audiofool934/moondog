import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertProvenance, releaseNames, updateFeed, verifyArtifacts } from "../../app/release-artifacts.mjs";
import { notarizeFile, prepareDmgUpload } from "../../app/release-notary.mjs";
import { markAsLatest, uploadImmutableAssets, validateNpmRelease } from "../../app/release-publication.mjs";
import { builderSigningIdentity, digestFile, readJson, saveJson, SIGNING_TEAM } from "../../app/release-tools.mjs";

const provenance = { version: "0.2.1", source: "a".repeat(40), buildNumber: "123", teamId: SIGNING_TEAM };

test("the builder qualifier omits the certificate prefix while retaining the signing team", () => {
  const full = `Developer ID Application: Fixture Developer (${SIGNING_TEAM})`;
  assert.equal(builderSigningIdentity(full), `Fixture Developer (${SIGNING_TEAM})`);
  assert.equal(full, `Developer ID Application: Fixture Developer (${SIGNING_TEAM})`, "the codesign identity remains unchanged");
  assert.equal(builderSigningIdentity(null), null);
  assert.throws(() => builderSigningIdentity("Apple Development: Fixture"), /Developer ID Application/u);
});

async function artifacts(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "moondog-release-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const names = releaseNames(provenance.version), createdAt = "2026-01-01T00:00:00.000Z";
  for (const name of [names.zip, names.dmg, names.blockmap]) await writeFile(path.join(directory, name), `fixture ${name}`);
  const zip = await digestFile(path.join(directory, names.zip)), dmg = await digestFile(path.join(directory, names.dmg));
  await writeFile(path.join(directory, names.feed), updateFeed(provenance.version, zip, dmg, createdAt));
  const manifest = { schema: 1, ...provenance, notarized: true, createdAt,
    files: await Promise.all([names.zip, names.dmg, names.blockmap, names.feed].map(name => digestFile(path.join(directory, name)))) };
  await saveJson(path.join(directory, names.manifest), manifest);
  return { directory, names, manifest };
}

test("artifact verification rejects a changed ZIP even when its name and length match", async t => {
  const { directory, names } = await artifacts(t);
  let inspected = 0;
  const inspect = async () => { inspected++; };
  await verifyArtifacts(directory, provenance, { inspect });
  const file = path.join(directory, names.zip), bytes = await readFile(file);
  bytes[0] ^= 1;
  await writeFile(file, bytes);
  await assert.rejects(verifyArtifacts(directory, provenance, { inspect }), /Artifact changed.*sha256/u);
  assert.equal(inspected, 1, "reject corrupt files before launching container verification");
});

test("artifact verification requires the recorded source, all assets, and an exact feed", async t => {
  const { directory, names, manifest } = await artifacts(t);
  await assert.rejects(verifyArtifacts(directory, { ...provenance, source: "b".repeat(40) }, { inspect: async () => {} }), /provenance differs: source/u);
  assert.throws(() => assertProvenance({ ...provenance, teamId: "WRONG" }, provenance), /teamId/u);
  await writeFile(path.join(directory, names.feed), (await readFile(path.join(directory, names.feed), "utf8")).replace("sha512:", "wrongHash:"));
  manifest.files = await Promise.all(manifest.files.map(file => digestFile(path.join(directory, file.name))));
  await saveJson(path.join(directory, names.manifest), manifest);
  await assert.rejects(verifyArtifacts(directory, provenance, { inspect: async () => {} }), /feed does not describe/u);
  manifest.files.pop();
  await saveJson(path.join(directory, names.manifest), manifest);
  await assert.rejects(verifyArtifacts(directory, provenance, { inspect: async () => {} }), /exactly the four/u);
});

function notaryFixture() {
  const saved = new Map(), calls = [];
  let status = "In Progress", timeout = true;
  return {
    saved, calls,
    finish() { status = "Accepted"; timeout = false; },
    options: { file: "/fixture/unique-app.zip", receiptFile: "/fixture/notary.json", profile: "fixture",
      digest: async () => ({ sha256: "a".repeat(64) }),
      read: async file => structuredClone(saved.get(file) ?? null),
      save: async (file, value) => { saved.set(file, structuredClone(value)); },
      report: async (_label, operation) => operation(),
      run: async (_program, args) => {
        calls.push(args);
        const verb = args[1];
        if (verb === "submit") return { stdout: JSON.stringify({ id: "fixture-submission" }) };
        if (verb === "info") return { stdout: JSON.stringify({ status }) };
        if (verb === "wait" && timeout) throw new Error("wait timeout");
        throw new Error(`Unexpected command ${verb}`);
      },
    },
  };
}

test("an interrupted Apple wait resumes the saved submission without a second upload", async () => {
  const f = notaryFixture();
  await assert.rejects(notarizeFile(f.options), /resume this submission/u);
  assert.equal(f.saved.get("/fixture/notary.json").id, "fixture-submission");
  f.finish();
  const result = await notarizeFile(f.options);
  assert.equal(result.status, "Accepted");
  assert.equal(f.calls.filter(args => args[1] === "submit").length, 1);
  await assert.rejects(notarizeFile({ ...f.options, digest: async () => ({ sha256: "b".repeat(64) }) }), /input changed/u);
  assert.equal(f.calls.filter(args => args[1] === "submit").length, 1);
});

test("a lost submit response is recovered from its unique name, never blindly resubmitted", async () => {
  const f = notaryFixture();
  f.saved.set("/fixture/notary.json", { name: "unique-app.zip", sha256: "a".repeat(64), submitting: true, startedAt: "2026-01-01T00:00:00.750Z" });
  let history = [];
  const run = async (_program, args) => {
    f.calls.push(args);
    if (args[1] === "history") return { stdout: JSON.stringify({ history }) };
    if (args[1] === "info") return { stdout: JSON.stringify({ status: "Accepted" }) };
    throw new Error("Must not submit again");
  };
  await assert.rejects(notarizeFile({ ...f.options, run }), /outcome is unknown/u);
  history = [{ name: "unique-app.zip", id: "older-id" }, { name: "unique-app.zip", id: "newer-id" }];
  await assert.rejects(notarizeFile({ ...f.options, run }), /outcome is unknown/u);
  history = [{ name: "unique-app.zip", createdDate: "2025-12-31T23:59:59Z", id: "recovered-id" }];
  // A unique name still recovers when Apple's seconds-only clock is slightly behind.
  assert.equal((await notarizeFile({ ...f.options, run })).id, "recovered-id");
  assert.equal(f.calls.some(args => args[1] === "submit"), false);
});

test("the DMG upload name survives an interrupted copy and its Apple submission resumes once", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "moondog-dmg-upload-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "release.dmg"), receiptFile = path.join(directory, "build.json");
  await writeFile(file, "signed DMG fixture");
  const receipt = { version: "0.2.1", dmg: await digestFile(file) };
  await assert.rejects(prepareDmgUpload({ file, receipt, receiptFile, uuid: () => "stable-uuid",
    copy: async (_from, temporary) => {
      assert.equal((await readJson(receiptFile)).dmgInputName, "Moondog-0.2.1-stable-uuid.dmg", "persist name before copying");
      await writeFile(temporary, "partial");
      throw new Error("interrupted copy");
    } }), /interrupted copy/u);
  const retry = { file, receipt: await readJson(receiptFile), receiptFile, uuid: () => { throw new Error("Must reuse the saved UUID"); } };
  const upload = await prepareDmgUpload(retry);
  assert.equal(path.basename(upload), "Moondog-0.2.1-stable-uuid.dmg");
  assert.equal((await digestFile(upload)).sha256, receipt.dmg.sha256);
  let submitted = 0, accepted = false;
  const options = { file: upload, receiptFile: path.join(directory, "dmg-notary.json"), profile: "fixture",
    report: async (_label, operation) => operation(), run: async (_program, args) => {
      if (args[1] === "submit") { submitted++; assert.equal(args[2], upload); return { stdout: '{"id":"dmg-id"}' }; }
      if (args[1] === "info") return { stdout: JSON.stringify({ status: accepted ? "Accepted" : "In Progress" }) };
      if (args[1] === "wait") throw new Error("wait interrupted");
      throw new Error("Unexpected command");
    } };
  await assert.rejects(notarizeFile(options), /resume this submission/u);
  accepted = true;
  assert.equal(await prepareDmgUpload(retry), upload);
  assert.equal((await notarizeFile(options)).status, "Accepted");
  assert.equal(submitted, 1);
  assert.equal(await readFile(file, "utf8"), "signed DMG fixture", "the final DMG remains separate for stapling");
  await writeFile(upload, "corrupted upload");
  await assert.rejects(prepareDmgUpload(retry), /saved DMG upload copy changed/u);
});

test("failed draft upload can resume identical bytes without overwriting the first asset", async () => {
  const items = [{ name: "app.zip", size: 3, sha256: "aaa" }, { name: "latest-mac.yml", size: 4, sha256: "bbb" }];
  const release = { draft: true, assets: [] }, uploads = [];
  let fail = true;
  const options = { items, getRelease: async () => structuredClone(release), remoteDigest: async asset => asset.hash,
    upload: async item => {
      uploads.push(item.name);
      if (item.name === "latest-mac.yml" && fail) throw new Error("Network lost");
      release.assets.push({ name: item.name, size: item.size, hash: item.sha256, state: "uploaded" });
    } };
  await assert.rejects(uploadImmutableAssets(options), /Network lost/u);
  assert.equal(release.draft, true);
  fail = false;
  await uploadImmutableAssets(options);
  assert.deepEqual(uploads, ["app.zip", "latest-mac.yml", "latest-mac.yml"]);
  assert.equal(release.draft, true, "only the final publisher can expose the draft");
});

test("changed remote bytes and incomplete public releases fail before any upload", async () => {
  let uploads = 0;
  const item = { name: "app.zip", size: 3, sha256: "new" };
  const options = { items: [item], upload: async () => { uploads++; }, remoteDigest: async () => "old" };
  await assert.rejects(uploadImmutableAssets({ ...options, getRelease: async () => ({ draft: true, assets: [{ name: item.name, size: item.size, state: "uploaded" }] }) }), /not overwritten/u);
  await assert.rejects(uploadImmutableAssets({ ...options, getRelease: async () => ({ draft: false, assets: [] }) }), /public release is incomplete/u);
  assert.equal(uploads, 0);
});

test("a 502 starter placeholder is removed only from a draft and replaced with verified bytes", async () => {
  const item = { name: "app.zip", size: 3, sha256: "new" };
  const placeholder = { id: 17, name: item.name, state: "starter", size: 0 };
  const release = { draft: true, assets: [] }, deleted = [], uploads = [];
  let fail = true;
  const options = { items: [item], getRelease: async () => structuredClone(release), remoteDigest: async asset => asset.hash,
    deleteAsset: async asset => { deleted.push(asset.id); release.assets = release.assets.filter(value => value.id !== asset.id); },
    upload: async value => {
      uploads.push(value.name);
      if (fail) { release.assets.push(placeholder); throw new Error("HTTP 502"); }
      release.assets.push({ ...value, hash: value.sha256, state: "uploaded", id: 18 });
    } };
  await assert.rejects(uploadImmutableAssets(options), /HTTP 502/u);
  fail = false;
  const resumed = await uploadImmutableAssets(options);
  assert.deepEqual(deleted, [17]);
  assert.deepEqual(uploads, ["app.zip", "app.zip"]);
  assert.equal(resumed.assets[0].state, "uploaded");
  assert.equal(resumed.draft, true);
});

test("placeholder recovery never deletes public, nonempty, completed, or concurrently changed assets", async () => {
  const item = { name: "app.zip", size: 3, sha256: "new" };
  let mutations = 0;
  const options = { items: [item], remoteDigest: async () => "wrong",
    deleteAsset: async () => { mutations++; }, upload: async () => { mutations++; } };
  for (const [draft, state, size] of [[false, "starter", 0], [true, "starter", 1], [true, "uploaded", 0], [true, "uploaded", 3]]) {
    await assert.rejects(uploadImmutableAssets({ ...options, getRelease: async () => ({ draft, assets: [{ id: 17, name: item.name, state, size }] }) }), /not overwritten/u);
  }
  for (const change of ["public", "completed", "replaced"]) {
    let reads = 0;
    await assert.rejects(uploadImmutableAssets({ ...options, getRelease: async () => {
      const fresh = ++reads > 1;
      return { draft: !(fresh && change === "public"), assets: [{ id: fresh && change === "replaced" ? 18 : 17,
        name: item.name, state: fresh && change === "completed" ? "uploaded" : "starter", size: 0 }] };
    } }), /now public|placeholder changed/u);
  }
  assert.equal(mutations, 0);
});

test("npm provenance and latest promotion do not accept a wrong commit or downgrade", () => {
  const metadata = { name: "@audiofool/moondog", version: provenance.version, gitHead: provenance.source };
  validateNpmRelease(metadata, { ...provenance, name: metadata.name });
  assert.throws(() => validateNpmRelease({ ...metadata, gitHead: "wrong" }, { ...provenance, name: metadata.name }), /does not match/u);
  assert.equal(markAsLatest("0.2.1", ["0.2.0", "0.2.1"]), true);
  assert.equal(markAsLatest("0.2.1", ["0.2.2"]), false);
  assert.equal(markAsLatest("0.2.2-beta.1", ["0.2.1"]), false);
  assert.throws(() => markAsLatest("0.2.1", ["unknown"]), /Cannot compare/u);
});
