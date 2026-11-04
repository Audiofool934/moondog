import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
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

// How notarytool signs in. An App Store Connect API key (a .p8 file, its key ID and the team's issuer ID) needs no
// Keychain item and no app-specific password, and lasts until it is revoked; the Keychain profile it replaces went
// missing three times on this Mac mini (2026-10-28, 2026-11-03, 2026-11-04). Without a key, the profile is used.
// The key can also be named once for every app of the team in ~/.config/apple-notary/api-key.json:
// { "key": "/full/path/AuthKey_XXXXXXXXXX.p8", "keyId": "XXXXXXXXXX", "issuer": "<issuer uuid>" }. The variables win.
export const NOTARY_KEY_FILE = path.join(homedir(), ".config", "apple-notary", "api-key.json");
export function notaryAuth(environment = process.env, { exists = existsSync, read = (file) => readFileSync(file, "utf8"), file = NOTARY_KEY_FILE } = {}) {
  let saved = null;
  if (!environment.MOONDOG_NOTARY_KEY && exists(file)) {
    try { saved = JSON.parse(read(file)); } catch { throw new Error(`${file} is not valid JSON.`); }
  }
  const key = (environment.MOONDOG_NOTARY_KEY ?? saved?.key)?.trim();
  if (key) {
    const keyId = (environment.MOONDOG_NOTARY_KEY_ID ?? saved?.keyId)?.trim() ?? "";
    const issuer = (environment.MOONDOG_NOTARY_ISSUER ?? saved?.issuer)?.trim() ?? "";
    if (!path.isAbsolute(key) || !exists(key)) throw new Error("MOONDOG_NOTARY_KEY must name the API key's .p8 file by its full path.");
    if (!/^[A-Z0-9]{10}$/u.test(keyId)) throw new Error("MOONDOG_NOTARY_KEY_ID must be the API key's 10-character key ID.");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(issuer)) throw new Error("MOONDOG_NOTARY_ISSUER must be the team's issuer ID.");
    return { kind: "api-key", args: ["--key", key, "--key-id", keyId, "--issuer", issuer] };
  }
  const profile = environment.MOONDOG_NOTARY_PROFILE ?? environment.APPLE_NOTARY_PROFILE ?? "mac-mini-notary";
  return { kind: "keychain-profile", args: ["--keychain-profile", profile] };
}

// Separate upload from waiting so an interrupted wait never creates a second submission.
// The unique, recorded filename lets history recover a response lost during submit.
export async function notarizeFile({ file, receiptFile, profile, credentials = null, run = command, digest = digestFile,
  read = readJson, save = saveJson, report = phase }) {
  const artifact = await digest(file);
  let receipt = await read(receiptFile, true);
  if (receipt && (receipt.sha256 !== artifact.sha256 || receipt.name !== path.basename(file))) {
    throw new Error("The notarization input changed. Restore the recorded artifact; do not resubmit a rebuilt release.");
  }
  receipt ??= { schema: 1, name: path.basename(file), sha256: artifact.sha256, startedAt: new Date().toISOString() };
  const auth = credentials?.args ?? ["--keychain-profile", profile];
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
