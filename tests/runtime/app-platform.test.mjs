import assert from "node:assert/strict";
import test from "node:test";
import { needsLoginShell, playbackAccelerators, windowChrome } from "../../app/platform.mjs";

test("Windows and Linux keep native controls and do not launch a POSIX login shell", () => {
  for (const platform of ["win32", "linux"]) {
    const chrome = windowChrome(platform);
    assert.equal(chrome.titleBarStyle, undefined);
    assert.equal(chrome.trafficLightPosition, undefined);
    assert.equal(chrome.autoHideMenuBar, true);
    assert.equal(needsLoginShell(platform, true), false);
    assert(!Object.values(playbackAccelerators(platform)).some((key) => key.includes("Cmd")));
  }
  assert.equal(windowChrome("darwin").titleBarStyle, "hiddenInset");
  assert.equal(needsLoginShell("darwin", true), true);
  assert.equal(needsLoginShell("darwin", false), false);
});

test("desktop labels and conversation selection follow the host's modifier", async () => {
  const previous = globalThis.window;
  try {
    for (const platform of ["darwin", "win32", "linux"]) {
      globalThis.window = { moondogApp: { platform } };
      const renderer = await import(`../../app/renderer/platform.mjs?${platform}`);
      assert.equal(renderer.primaryModifier({ metaKey: true, ctrlKey: false }), platform === "darwin");
      assert.equal(renderer.primaryModifier({ metaKey: false, ctrlKey: true }), platform !== "darwin");
      assert.equal(renderer.shortcuts.new, platform === "darwin" ? "⌘N" : "Ctrl+N");
    }
    globalThis.window = { moondogApp: {} };
    const scene = await import("../../app/renderer/platform.mjs?scene");
    assert.equal(scene.platform, "darwin", "The project page keeps its existing Mac scene");
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
});
