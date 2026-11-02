import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspect } from "node:util";
import { assertProvenance, releaseNames, updateFeed, verifyArtifacts } from "../../app/release-artifacts.mjs";
import { notarizeFile, prepareDmgUpload } from "../../app/release-notary.mjs";
import { assertReleaseIdentity, findReleaseByTag, markAsLatest, publicationSource, uploadImmutableAssets, validateNpmRelease, waitFor } from "../../app/release-publication.mjs";
import { builderSigningIdentity, command, commandFailure, digestFile, ELECTRON_DATA_SIGN_IGNORE, parseReleaseJson, readJson, retryTimestampSigning, saveJson, SIGNING_TEAM } from "../../app/release-tools.mjs";

const provenance = { version: "0.2.1", source: "a".repeat(40), buildNumber: "123", teamId: SIGNING_TEAM };

async function captureCommandOutput(operation) {
  const originalOut = process.stdout.write, originalErr = process.stderr.write;
  let output = "";
  const capture = (chunk, encoding, callback) => {
    output += String(chunk);
    if (typeof encoding === "function") encoding();
    else callback?.();
    return true;
  };
  process.stdout.write = capture; process.stderr.write = capture;
  try { return { result: await operation(), output }; }
  finally { process.stdout.write = originalOut; process.stderr.write = originalErr; }
}

test("release child output stays private on success and cannot leak through live chunks or failure objects", async () => {
  const key = ["sk", "proj", "synthetic", "x".repeat(40)].join("-");
  const token = ["npm", "y".repeat(40)].join("_");
  const url = `https://example.invalid/callback?code=${token}&key=${key}`;
  const script = `const [key,token,url,code]=process.argv.slice(1);
    const text=JSON.stringify({key,token,url});
    process.stdout.write(text.slice(0,17)); process.stderr.write(token.slice(0,11));
    setTimeout(()=>{process.stdout.write(text.slice(17));process.stderr.write(token.slice(11));process.exitCode=Number(code);},10);`;
  const success = await captureCommandOutput(() => command(process.execPath, ["-e", script, key, token, url, "0"], { live: true }));
  assert.deepEqual(parseReleaseJson(success.result.stdout), { key, token, url });
  assert.equal(success.result.stderr === token, true, "successful private output remains intact");
  for (const value of [key, token, url]) assert.equal(success.output.includes(value), false);
  const failed = await captureCommandOutput(async () => {
    try { await command(process.execPath, ["-e", script, key, token, url, "7"], { live: true }); }
    catch (error) { return error; }
    assert.fail("the child must fail");
  });
  assert.equal(failed.result.code, 7);
  for (const value of [key, token, url]) {
    assert.equal(`${failed.output}${inspect(failed.result, { showHidden: true })}${JSON.stringify(failed.result)}`.includes(value), false);
  }
  assert.deepEqual(Object.keys(failed.result), ["code"]);
  assert.equal(failed.result.cause, undefined);
  assert.equal(failed.result.stdout, undefined);
  assert.equal(failed.result.stderr, undefined);
  assert.equal(failed.result.spawnargs, undefined);
});

test("release spawn failures and invalid JSON cannot expose executable paths, arguments or response fragments", async () => {
  const secret = ["fixture", "private", "z".repeat(40)].join("_");
  const result = await captureCommandOutput(async () => {
    try { await command(`/missing/${secret}`, [`https://example.invalid/?token=${secret}`], { live: true }); }
    catch (error) { return error; }
    assert.fail("missing executable must fail");
  });
  assert.equal(result.result.code, "ENOENT");
  assert.equal(`${result.output}${inspect(result.result, { showHidden: true })}`.includes(secret), false);
  assert.deepEqual(Object.keys(result.result), ["code"]);
  assert.throws(() => parseReleaseJson(`{invalid:${secret}`), error =>
    error.message === "Release command returned invalid JSON." && !inspect(error, { showHidden: true }).includes(secret) && error.cause === undefined);
});

test("release failures preserve only recognized HTTP, npm and timestamp diagnostics", async () => {
  const secret = ["fixture", "private", "q".repeat(40)].join("_");
  const script = `process.stderr.write('gh: Not Found (HTTP 404)\\nnpm error code E401\\nnpm error code E' + process.argv[1] + '\\nThe timestamp service is not available. ' + process.argv[1]);process.exitCode=1;`;
  let failure;
  try { await command(process.execPath, ["-e", script, secret]); } catch (error) { failure = error; }
  assert.equal(failure.httpStatus, 404);
  assert.deepEqual(failure.npmCodes, ["E401"]);
  assert.equal(failure.timestampUnavailable, true);
  assert.equal(inspect(failure, { showHidden: true }).includes(secret), false);
  let attempts = 0;
  const delays = [];
  assert.equal(await retryTimestampSigning(async () => {
    if (++attempts < 3) throw failure;
    return "signed";
  }, { wait: async ms => delays.push(ms), warn: () => {} }), "signed");
  assert.deepEqual(delays, [5000, 10000]);
  assert.equal(commandFailure("gh", { stderr: "HTTP 404suffix HTTP 999", code: 1 }).httpStatus, undefined);
  assert.equal(commandFailure("gh", { stderr: "HTTP 404\nHTTP 502", code: 1 }).httpStatus, undefined);
});

test("release command timeout reports only a fixed reason and reaps its child", async () => {
  const secret = ["fixture", "timeout", "r".repeat(40)].join("_");
  const captured = await captureCommandOutput(async () => {
    try {
      await command(process.execPath, ["-e", "process.stderr.write(process.argv[1]);setInterval(()=>{},1000);", secret], { live: true, timeout: 100 });
    } catch (error) { return error; }
    assert.fail("the child must time out");
  });
  assert.equal(captured.result.timedOut, true);
  assert.equal(captured.result.signal, "SIGTERM");
  assert.equal(`${captured.output}${inspect(captured.result, { showHidden: true })}`.includes(secret), false);
});

test("draft lookup scans release pages and binds subsequent reads to one ID, tag and channel", async () => {
  const identity = { id: 427169761, tag: "v0.2.1", prerelease: false };
  const draft = { id: identity.id, tag_name: identity.tag, prerelease: false, draft: true, assets: [] };
  const older = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, tag_name: `v0.1.${i}`, prerelease: false, draft: false }));
  const pages = [];
  assert.equal(await findReleaseByTag({ ...identity, listPage: async page => {
    pages.push(page);
    return page === 1 ? older : [draft];
  } }), draft);
  assert.deepEqual(pages, [1, 2]);
  assert.equal(assertReleaseIdentity(draft, identity), draft);
  assert.equal(assertReleaseIdentity({ ...draft, draft: false }, identity).draft, false, "the same ID may become public");
  for (const change of [{ id: 427169762 }, { tag_name: "v0.2.2" }, { prerelease: true }, { draft: undefined }]) {
    assert.throws(() => assertReleaseIdentity({ ...draft, ...change }, identity), /identity or channel/u);
  }
});

test("draft lookup rejects ambiguity, inaccessible lists and wrong release channels", async () => {
  const expected = { tag: "v0.2.1", prerelease: false };
  const draft = { id: 7, tag_name: expected.tag, prerelease: false, draft: true };
  assert.equal(await findReleaseByTag({ ...expected, listPage: async () => [] }), null);
  await assert.rejects(findReleaseByTag({ ...expected, listPage: async () => [draft, { ...draft, id: 8 }] }), /Multiple GitHub releases/u);
  await assert.rejects(findReleaseByTag({ ...expected, listPage: async () => [{ ...draft, prerelease: true }] }), /identity or channel/u);
  await assert.rejects(findReleaseByTag({ ...expected, listPage: async () => null }), /release list/u);
  await assert.rejects(findReleaseByTag({ ...expected, listPage: async () => { throw new Error("HTTP 403"); } }), /HTTP 403/u);
  await assert.rejects(findReleaseByTag({ ...expected, listPage: async () => Array(100).fill({ tag_name: "other" }) }), /exceeded 100 pages/u);
});

test("maintenance publication binds existing artifacts to the exact local and remote release tag", () => {
  const original = { version: provenance.version, head: provenance.source, tagSource: provenance.source, remoteSource: provenance.source };
  assert.equal(publicationSource(original), provenance.source);
  const maintenance = { ...original, head: "b".repeat(40), fromTag: "v0.2.1", skipBuild: true };
  assert.equal(publicationSource(maintenance), provenance.source);
  assert.equal(publicationSource({ ...maintenance, skipBuild: false, verifyOnly: true }), provenance.source);
  assert.throws(() => publicationSource({ ...maintenance, fromTag: undefined }), /HEAD is not/u);
  assert.throws(() => publicationSource({ ...maintenance, skipBuild: false }), /must not rebuild/u);
  assert.throws(() => publicationSource({ ...maintenance, fromTag: "v0.2.0" }), /match the package version/u);
  assert.throws(() => publicationSource({ ...maintenance, remoteSource: "c".repeat(40) }), /remote release tag/u);
  assert.throws(() => publicationSource({ ...maintenance, tagSource: null }), /Invalid release tag provenance/u);
});

test("the builder qualifier omits the certificate prefix while retaining the signing team", () => {
  const full = `Developer ID Application: Fixture Developer (${SIGNING_TEAM})`;
  assert.equal(builderSigningIdentity(full), `Fixture Developer (${SIGNING_TEAM})`);
  assert.equal(full, `Developer ID Application: Fixture Developer (${SIGNING_TEAM})`, "the codesign identity remains unchanged");
  assert.equal(builderSigningIdentity(null), null);
  assert.throws(() => builderSigningIdentity("Apple Development: Fixture"), /Developer ID Application/u);
});

test("signing skips only the known Electron data resources through every framework alias", () => {
  const ignore = new RegExp(ELECTRON_DATA_SIGN_IGNORE);
  const framework = "/fixture/Moondog.app/Contents/Frameworks/Electron Framework.framework";
  for (const version of ["", "Versions/A/", "Versions/Current/"]) {
    for (const resource of ["en.lproj/locale.pak", "el_FEMININE.lproj/locale.pak", "zh_CN_NEUTER.lproj/locale.pak",
      "chrome_100_percent.pak", "chrome_200_percent.pak", "resources.pak", "icudtl.dat", "v8_context_snapshot.arm64.bin"]) {
      assert.equal(ignore.test(`${framework}/${version}Resources/${resource}`), true, resource);
    }
    for (const code of ["Electron Framework", "Libraries/libffmpeg.dylib", "Resources/native.node", "Resources/native.bin",
      "Helpers/chrome_crashpad_handler"]) assert.equal(ignore.test(`${framework}/${version}${code}`), false, code);
  }
  for (const code of [framework, "/fixture/Moondog.app", "/fixture/Moondog.app/Contents/MacOS/Moondog",
    "/fixture/Moondog.app/Contents/MacOS/moondog-music", "/fixture/Moondog.app/Contents/Resources/native.node",
    "/fixture/Moondog.app/Contents/Resources/locale.pak", "/fixture/Other.framework/Resources/icudtl.dat"]) {
    assert.equal(ignore.test(code), false, code);
  }
});

test("direct signing retries temporary timestamp failures at most three times", async () => {
  let attempts = 0;
  const delays = [], options = { wait: async ms => delays.push(ms), warn: () => {} };
  assert.equal(await retryTimestampSigning(async () => {
    if (++attempts < 3) throw new Error("The timestamp service is not available.");
    return "signed";
  }, options), "signed");
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [5000, 10000]);
  attempts = 0;
  await assert.rejects(retryTimestampSigning(async () => { attempts++; throw new Error("timestamp service unavailable"); }, options), /unavailable/u);
  assert.equal(attempts, 3);
  attempts = 0;
  await assert.rejects(retryTimestampSigning(async () => { attempts++; throw new Error("code object is not signed at all"); }, options), /not signed/u);
  assert.equal(attempts, 1, "deterministic signing failures do not retry");
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

test("assets upload together and the update feed goes up only after they are verified", async () => {
  const names = ["app.zip", "app.zip.blockmap", "app.dmg", "release.json", "latest-mac.yml"];
  const items = names.map((name, i) => ({ name, size: i + 1, sha256: name }));
  const release = { draft: true, assets: [] }, events = [];
  let running = 0, peak = 0;
  await uploadImmutableAssets({ items, getRelease: async () => structuredClone(release), remoteDigest: async asset => asset.hash,
    upload: async item => {
      events.push(`start ${item.name}`);
      peak = Math.max(peak, ++running);
      await new Promise(resolve => setTimeout(resolve, 10));
      release.assets.push({ name: item.name, size: item.size, hash: item.sha256, state: "uploaded" });
      running--;
      events.push(`end ${item.name}`);
    } });
  assert.equal(peak, 4);
  assert.deepEqual(events.slice(-2), ["start latest-mac.yml", "end latest-mac.yml"]);
});

test("a failed upload lets the others finish and never uploads the update feed", async () => {
  const items = ["app.zip", "app.dmg", "latest-mac.yml"].map(name => ({ name, size: 1, sha256: name }));
  const release = { draft: true, assets: [] }, uploads = [];
  await assert.rejects(uploadImmutableAssets({ items, getRelease: async () => structuredClone(release), remoteDigest: async asset => asset.hash,
    upload: async item => {
      uploads.push(item.name);
      if (item.name === "app.dmg") throw new Error("Network lost");
      await new Promise(resolve => setTimeout(resolve, 10));
      release.assets.push({ name: item.name, size: item.size, hash: item.sha256, state: "uploaded" });
    } }), /Network lost/u);
  assert.deepEqual(uploads, ["app.zip", "app.dmg"]);
  assert.deepEqual(release.assets.map(asset => asset.name), ["app.zip"], "the zip finished before the failure was reported");
});

test("waits share one deadline and stop as soon as the value appears", async () => {
  let clock = 0, reads = 0;
  const options = { deadline: 150_000, now: () => clock, sleep: async ms => { clock += ms; } };
  assert.equal(await waitFor(async () => ++reads >= 3 && "draft", options), "draft");
  assert.equal(reads, 3);
  assert.equal(clock, 120_000);
  assert.equal(await waitFor(async () => null, options), null);
  assert.equal(clock, 150_000, "a later wait ends at the shared deadline");
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
