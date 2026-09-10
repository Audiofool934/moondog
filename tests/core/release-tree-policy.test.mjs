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
