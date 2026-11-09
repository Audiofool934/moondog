import assert from "node:assert/strict";
import test from "node:test";

import { notaryAuth } from "../../app/release-notary.mjs";

const key = { key: "/Users/example/.config/apple-notary/AuthKey_ABCDE12345.p8", keyId: "ABCDE12345", issuer: "69a6de7e-1111-47e3-e053-5b8c7c11a4d1" };

test("notarization signs in with an App Store Connect API key when one is set, else the Keychain profile", () => {
  // No key anywhere: the shared Keychain profile, as before.
  assert.deepEqual(notaryAuth({}, { exists: () => false }), { kind: "keychain-profile", args: ["--keychain-profile", "mac-mini-notary"] });
  assert.deepEqual(notaryAuth({ MOONDOG_NOTARY_PROFILE: "other" }, { exists: () => false }).args, ["--keychain-profile", "other"]);
  // The key named once in the team's file.
  assert.deepEqual(notaryAuth({}, { exists: () => true, read: () => JSON.stringify(key) }),
    { kind: "api-key", args: ["--key", key.key, "--key-id", key.keyId, "--issuer", key.issuer] });
  // A variable overrides only its own field: a moved .p8 keeps the file's key ID and issuer.
  assert.deepEqual(notaryAuth({ MOONDOG_NOTARY_KEY: "/moved/AuthKey_ABCDE12345.p8" }, { exists: () => true, read: () => JSON.stringify(key) }).args,
    ["--key", "/moved/AuthKey_ABCDE12345.p8", "--key-id", key.keyId, "--issuer", key.issuer]);
  // The variables win over the file.
  assert.equal(notaryAuth({ MOONDOG_NOTARY_KEY: "/elsewhere/AuthKey_ZZZZZ99999.p8", MOONDOG_NOTARY_KEY_ID: "ZZZZZ99999", MOONDOG_NOTARY_ISSUER: key.issuer },
    { exists: () => true, read: () => JSON.stringify(key) }).args[1], "/elsewhere/AuthKey_ZZZZZ99999.p8");
});

test("a half-set or broken API key is refused before anything is sent to Apple", () => {
  assert.throws(() => notaryAuth({}, { exists: () => true, read: () => "{" }), /not valid JSON/u);
  assert.throws(() => notaryAuth({}, { exists: (file) => !file.endsWith(".p8"), read: () => JSON.stringify(key) }), /full path/u);
  assert.throws(() => notaryAuth({}, { exists: () => true, read: () => JSON.stringify({ ...key, keyId: "short" }) }), /key ID/u);
  assert.throws(() => notaryAuth({}, { exists: () => true, read: () => JSON.stringify({ ...key, issuer: "team" }) }), /issuer/u);
});
