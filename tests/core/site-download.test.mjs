import assert from "node:assert/strict";
import test from "node:test";
import { stableDesktopDownloads } from "../../site/download.mjs";

const asset = (name, version) => ({ name, state: "uploaded", browser_download_url: `https://example.invalid/${version}/${name}` });
const release = (version, changes = {}) => ({ tag_name: `v${version}`, draft: false, prerelease: version.includes("-"),
  assets: [asset(`Moondog-${version}-arm64.dmg`, version)], ...changes });

test("the default download selects the newest complete stable release by version", () => {
  const { mac } = stableDesktopDownloads([
    release("0.3.0-beta.1"), release("0.4.0", { draft: true }), release("0.2.0"),
    release("0.2.2", { assets: [] }), release("0.2.1"), release("0.5.0-beta.1", { prerelease: false }),
  ]);
  assert.deepEqual(mac, { url: "https://example.invalid/0.2.1/Moondog-0.2.1-arm64.dmg", version: "0.2.1" });
});

test("no complete stable release leaves the release-list fallback", () => {
  assert.equal(stableDesktopDownloads([release("0.3.0-beta.1"), release("0.2.1", { draft: true }),
    release("0.2.0", { assets: [{ name: "Moondog-0.2.0-arm64.dmg", state: "starter" }] })]).mac, null);
});

test("Windows and Linux each link the newest stable release that has their own file", () => {
  const downloads = stableDesktopDownloads([
    release("0.3.0", { assets: [asset("Moondog-0.3.0-arm64.dmg", "0.3.0"), asset("Moondog-0.3.0-win-x64.exe", "0.3.0")] }),
    release("0.2.1", { assets: [asset("Moondog-0.2.1-win-x64.exe", "0.2.1"), asset("Moondog-0.2.1-linux-x86_64.AppImage", "0.2.1")] }),
    release("0.4.0-beta.1", { assets: [asset("Moondog-0.4.0-beta.1-linux-x86_64.AppImage", "0.4.0-beta.1")] }),
  ]);
  assert.equal(downloads.mac.version, "0.3.0");
  assert.equal(downloads.windows.version, "0.3.0");
  assert.equal(downloads.linux.version, "0.2.1");
  assert.equal(stableDesktopDownloads([release("0.2.0")]).linux, null);
});
