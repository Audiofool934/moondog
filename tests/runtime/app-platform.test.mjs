import assert from "node:assert/strict";
import test from "node:test";
import { accelerators, keyLabel, needsLoginShell, windowChrome } from "../../app/platform.mjs";

test("Windows and Linux keep native controls and do not launch a POSIX login shell", () => {
  for (const platform of ["win32", "linux"]) {
    const chrome = windowChrome(platform);
    assert.equal(chrome.titleBarStyle, undefined);
    assert.equal(chrome.trafficLightPosition, undefined);
    assert.equal(chrome.autoHideMenuBar, true);
    assert.equal(needsLoginShell(platform, true), false);
  }
  assert.equal(windowChrome("darwin").titleBarStyle, "hiddenInset");
  assert.equal(needsLoginShell("darwin", true), true);
  assert.equal(needsLoginShell("darwin", false), false);
});

test("menu keys type nothing and avoid AltGr and GNOME's workspace keys", () => {
  for (const platform of ["win32", "linux"]) {
    for (const [name, keys] of Object.entries(accelerators(platform))) {
      assert(!keys.includes("Cmd") || keys.startsWith("CmdOrCtrl+"), `${platform} ${name}`);
      // Control with Alt is AltGr on many Windows keyboards.
      assert(!(/(?:Ctrl|CmdOrCtrl)\+/u.test(keys) && keys.includes("Alt")), `${platform} ${name}: ${keys}`);
      assert(/(?:Ctrl|CmdOrCtrl|Alt)\+/u.test(keys), `${platform} ${name} needs a modifier that types nothing`);
    }
  }
  const mac = accelerators("darwin");
  assert.deepEqual([mac.play, mac.next, mac.previous], ["Ctrl+Cmd+P", "Ctrl+Cmd+Right", "Ctrl+Cmd+Left"]);
  assert.equal(keyLabel(mac.sidebar, "darwin"), "⌥⌘S");
  assert.equal(keyLabel(mac.next, "darwin"), "⌃⌘→");
  assert.equal(keyLabel(accelerators("linux").next, "linux"), "Alt+Shift+→");
  assert.equal(keyLabel(accelerators("win32").sidebar, "win32"), "Ctrl+Shift+S");
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
      assert.equal(renderer.shortcuts.play, keyLabel(accelerators(platform).play, platform), "Labels read the menu's own keys");
    }
    globalThis.window = { moondogApp: {} };
    const scene = await import("../../app/renderer/platform.mjs?scene");
    assert.equal(scene.platform, "darwin", "The project page keeps its existing Mac scene");
    assert.equal(scene.shortcuts.play, "⌃⌘P");
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
});
