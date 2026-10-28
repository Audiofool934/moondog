import assert from "node:assert/strict";
import test from "node:test";
import { stableMacDownload } from "../../site/download.mjs";

const release = (version, changes = {}) => ({ tag_name: `v${version}`, draft: false, prerelease: version.includes("-"),
  assets: [{ name: `Moondog-${version}-arm64.dmg`, state: "uploaded", browser_download_url: `https://example.invalid/${version}.dmg` }], ...changes });

test("the default download selects the newest complete stable release by version", () => {
  const selected = stableMacDownload([
    release("0.3.0-beta.1"), release("0.4.0", { draft: true }), release("0.2.0"),
    release("0.2.2", { assets: [] }), release("0.2.1"), release("0.5.0-beta.1", { prerelease: false }),
  ]);
  assert.deepEqual(selected, { url: "https://example.invalid/0.2.1.dmg", version: "0.2.1" });
});

test("no complete stable release leaves the release-list fallback", () => {
  assert.equal(stableMacDownload([release("0.3.0-beta.1"), release("0.2.1", { draft: true }),
    release("0.2.0", { assets: [{ name: "Moondog-0.2.0-arm64.dmg", state: "starter" }] })]), null);
});
