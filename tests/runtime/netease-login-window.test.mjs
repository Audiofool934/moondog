import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { openNeteaseLogin, isNeteaseLoginUrl } from "../../app/netease-login.mjs";

function windowFixture() {
  let latest;
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super(); latest = this; this.options = options; this.dead = false;
      this.cookies = new EventEmitter();
      this.webContents = new EventEmitter();
      this.webContents.session = { cookies: this.cookies, clearStorageData: async () => { this.cleared = true; } };
      this.webContents.setWindowOpenHandler = (handler) => { this.openHandler = handler; };
    }
    async loadURL(url) { this.url = url; }
    show() {}
    isDestroyed() { return this.dead; }
    destroy() { this.dead = true; this.emit("closed"); }
  }
  return { BrowserWindow, latest: () => latest };
}

test("NetEase login restricts navigation and remote-page privileges, and cleans up after a real cookie event", async () => {
  const { BrowserWindow, latest } = windowFixture();
  const pending = openNeteaseLogin({ BrowserWindow });
  const win = latest();
  assert.deepEqual([win.options.webPreferences.nodeIntegration, win.options.webPreferences.contextIsolation, win.options.webPreferences.sandbox], [false, true, true]);
  assert.equal(win.options.webPreferences.preload, undefined);
  assert.equal(isNeteaseLoginUrl("https://music.163.com.attacker.example"), false);
  assert.equal(isNeteaseLoginUrl("http://music.163.com"), false);
  let blocked = false;
  win.webContents.emit("will-redirect", { preventDefault() { blocked = true; } }, "https://attacker.example");
  assert.ok(blocked);
  assert.deepEqual(win.openHandler({ url: "https://attacker.example" }), { action: "deny" });
  win.cookies.emit("changed", null, { name: "MUSIC_U", value: "fictional", domain: ".music.163.com" }, "explicit", false);
  assert.equal(await pending, "MUSIC_U=fictional");
  assert.ok(win.dead && win.cleared);
  assert.equal(win.cookies.listenerCount("changed"), 0);
});

test("NetEase closing or aborting the login window settles once without a credential", async () => {
  for (const action of ["close", "abort"]) {
    const { BrowserWindow, latest } = windowFixture();
    const controller = new AbortController();
    const pending = openNeteaseLogin({ BrowserWindow, signal: controller.signal });
    if (action === "close") latest().destroy(); else controller.abort();
    assert.equal(await pending, null);
    assert.equal(latest().cookies.listenerCount("changed"), 0);
  }
});
