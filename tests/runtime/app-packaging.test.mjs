import assert from "node:assert/strict";
import test from "node:test";
import { desktopConfig, desktopTarget } from "../../app/pack-config.mjs";

// A platform must carry its own dependencies and helper. Merely retargeting Electron on a Mac
// would produce an installer that can launch its window but cannot start the listening core.
test("desktop builds require a supported native host and select its installer and update feed", () => {
  assert.deepEqual(desktopTarget("darwin", "arm64"), { platform: "darwin", arch: "arm64", targets: ["dmg", "zip"], unpacked: "mac-arm64", feed: "latest-mac.yml" });
  assert.deepEqual(desktopTarget("win32", "x64"), { platform: "win32", arch: "x64", targets: ["nsis"], unpacked: "win-unpacked", feed: "latest.yml" });
  assert.deepEqual(desktopTarget("linux", "x64"), { platform: "linux", arch: "x64", targets: ["AppImage"], unpacked: "linux-unpacked", feed: "latest-linux.yml" });
  assert.throws(() => desktopTarget("darwin", "x64"), /No desktop build/u);
  assert.throws(() => desktopTarget("win32", "arm64"), /No desktop build/u);
});

test("only macOS carries MusicKit and all desktop packages carry the shared platform and shutdown code", () => {
  for (const [platform, arch] of [["darwin", "arm64"], ["win32", "x64"], ["linux", "x64"]]) {
    const config = desktopConfig({ root: "/fixture", version: "0.3.0-beta.1", target: desktopTarget(platform, arch), music: true });
    assert.equal(config.extraFiles.length, platform === "darwin" ? 1 : 0);
    assert.equal(config.extraMetadata.version, "0.3.0-beta.1");
    assert.ok(config.files.includes("platform.mjs"));
    assert.ok(config.files.includes("lifecycle.mjs"));
    assert.equal(config.publish[0].channel, "latest", "GitHub prereleases also need the standard per-OS feed");
    assert.ok(config.directories.output.endsWith(".noindex"));
    assert.equal(config.nsis.deleteAppDataOnUninstall, false);
  }
});
