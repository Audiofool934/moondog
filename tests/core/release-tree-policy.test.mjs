import assert from "node:assert/strict";
import test from "node:test";

import {
  scanForbiddenContent,
  validateReleasePath,
} from "../../scripts/release-tree-policy.mjs";

test("release-tree content policy allows bounded synthetic user paths", () => {
  assert.deepEqual(
    scanForbiddenContent(Buffer.from(["/Users", "synthetic", "private", "fixture.json"].join("/"))),
    [],
  );
});

test("release-tree content policy rejects a real local user path", () => {
  const content = Buffer.from(["/Users", "listener", "private", "history.zip"].join("/"));
  assert.deepEqual(scanForbiddenContent(content), ["macOS user path"]);
});

test("release-tree content policy rejects credential and private-network markers", () => {
  const privateKey = ["-----BEGIN ", "PRIVATE KEY-----"].join("");
  const privateHost = ["192", "168", "50", "14"].join(".");
  assert.deepEqual(scanForbiddenContent(`${privateKey}\n${privateHost}`), [
    "private key",
    "private IPv4 address",
  ]);
});

test("release-tree content policy rejects provider token formats without echoing their values", () => {
  // Assemble fictional shapes at runtime so the test source contains no complete token.
  const cases = [
    [["github", "_pat_", "a".repeat(82)].join(""), "GitHub fine-grained access token"],
    [["AS", "IA", "A".repeat(16)].join(""), "AWS access key"],
    [["AK", "IA", "A".repeat(16)].join(""), "AWS access key"],
    [["AI", "za", "a".repeat(35)].join(""), "Google API key"],
    [["ya", "29.", "a".repeat(40)].join(""), "Google OAuth access token"],
  ];
  for (const [token, label] of cases) {
    const issues = scanForbiddenContent(Buffer.from(`prefix ${token} suffix`));
    assert.deepEqual(issues, [label]);
    assert.equal(issues.join(" ").includes(token), false);
  }
  assert.deepEqual(scanForbiddenContent("Configure API_KEY, auth.json or .env.example locally."), []);
});

test("release-tree path policy rejects private artifacts but permits the XML fixture", () => {
  assert.deepEqual(validateReleasePath("data/private/history.zip"), [
    "unexpected release-tree path",
    "private or generated file type",
  ]);
  assert.deepEqual(
    validateReleasePath("tests/fixtures/apple-music-library/minimal.xml"),
    [],
  );
  assert.deepEqual(validateReleasePath("CONTRIBUTING.md"), []);
  assert.deepEqual(validateReleasePath(".github/PULL_REQUEST_TEMPLATE.md"), []);
});

test("credential files remain forbidden inside otherwise permitted release folders", () => {
  for (const file of [
    "src/core/auth.json", "src/core/endpoints.json", "src/runtime/.npmrc",
    "app/.env", "app/.env.local", "site/.env.production", "app/signing.p8",
    "app/AUTH.JSON", "app/SIGNING.P8", "tests/.env.example.backup",
  ]) {
    assert.deepEqual(validateReleasePath(file), ["private or generated file type"], file);
  }
});

test("only the explicit environment example is allowed as a template", () => {
  for (const file of [".env.example", "app/.env.example", "site/.env.example"]) {
    assert.deepEqual(validateReleasePath(file), [], file);
  }
  assert.deepEqual(validateReleasePath("contracts/v1/auth.schema.json"), []);
  assert.deepEqual(validateReleasePath("src/core/endpoints.mjs"), []);
});
