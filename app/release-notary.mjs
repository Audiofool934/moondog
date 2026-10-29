import { randomUUID } from "node:crypto";
import { copyFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { command, digestFile, parseReleaseJson, phase, readJson, saveJson } from "./release-tools.mjs";

// Keep the final DMG name stable, but give Apple's upload a unique recoverable name.
// Save that name before copying. A crash can leave only the same retryable temp file.
export async function prepareDmgUpload({ file, receipt, receiptFile, copy = copyFile, uuid = randomUUID }) {
  const expected = receipt.dmg;
  const matches = value => value.sha256 === expected?.sha256 && value.size === expected?.size;
  if (!matches(await digestFile(file))) throw new Error("The signed DMG changed before its notarization copy.");
  if (!receipt.dmgInputName) {
    receipt.dmgInputName = `Moondog-${receipt.version}-${uuid()}.dmg`;
    await saveJson(receiptFile, receipt);
  }
  if (path.basename(receipt.dmgInputName) !== receipt.dmgInputName) throw new Error("Invalid DMG upload filename in the build receipt.");
  const target = path.join(path.dirname(receiptFile), receipt.dmgInputName);
  let existing;
  try { existing = await digestFile(target); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (existing) {
    if (!matches(existing)) throw new Error("The saved DMG upload copy changed; restore the recorded bytes.");
    return target;
  }
  const temporary = `${target}.tmp`;
  try {
    await copy(file, temporary);
    if (!matches(await digestFile(temporary))) throw new Error("The DMG upload copy does not match the signed DMG.");
    await rename(temporary, target);
  } finally { await rm(temporary, { force: true }); }
  return target;
}

// Separate upload from waiting so an interrupted wait never creates a second submission.
// The unique, recorded filename lets history recover a response lost during submit.
export async function notarizeFile({ file, receiptFile, profile, run = command, digest = digestFile,
  read = readJson, save = saveJson, report = phase }) {
  const artifact = await digest(file);
  let receipt = await read(receiptFile, true);
  if (receipt && (receipt.sha256 !== artifact.sha256 || receipt.name !== path.basename(file))) {
    throw new Error("The notarization input changed. Restore the recorded artifact; do not resubmit a rebuilt release.");
  }
  receipt ??= { schema: 1, name: path.basename(file), sha256: artifact.sha256, startedAt: new Date().toISOString() };
  const auth = ["--keychain-profile", profile];
  const json = async args => parseReleaseJson((await run("xcrun", ["notarytool", ...args, ...auth, "--output-format", "json"], { timeout: 60 * 60_000 })).stdout);
  if (!receipt.id && receipt.submitting) {
    const history = await json(["history"]);
    // The persisted filename is unique. Apple's timestamps need not share this host's
    // precision or clock, so time must not exclude the matching upload.
    const matches = history.history?.filter(item => item.name === receipt.name) ?? [];
    if (matches.length !== 1) throw new Error(`The previous upload outcome is unknown. Inspect notarytool history for ${receipt.name}; no new upload was made.`);
    receipt.id = matches[0].id;
    await save(receiptFile, receipt);
  }
  if (!receipt.id) {
    receipt.submitting = true;
    await save(receiptFile, receipt);
    const submitted = await report(`Upload ${receipt.name} to Apple`, () => json(["submit", file]));
    if (!submitted.id) throw new Error("Apple did not return a submission ID. The upload receipt was retained for recovery.");
    receipt.id = submitted.id;
    await save(receiptFile, receipt);
  }
  console.log(`Apple submission: ${receipt.id}`);
  let result = await json(["info", receipt.id]);
  if (result.status === "In Progress") {
    try { result = await report(`Wait for Apple ${receipt.id}`, () => json(["wait", receipt.id, "--timeout", "30m"])); }
    catch (error) {
      throw new Error(`Apple wait did not finish for ${receipt.id}. Run the same command again to resume this submission.\n${error.message}`);
    }
  }
  receipt.status = result.status;
  await save(receiptFile, receipt);
  if (result.status !== "Accepted") {
    const diagnostic = await run("xcrun", ["notarytool", "log", receipt.id, ...auth]).then(result => parseReleaseJson(result.stdout), () => null);
    if (diagnostic) await save(`${receiptFile}.log.json`, diagnostic);
    throw new Error(`Apple submission ${receipt.id}: ${result.status}. See ${receiptFile}.log.json; the artifact was not resubmitted.`);
  }
  return receipt;
}
