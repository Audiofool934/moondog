import assert from "node:assert/strict";
import test from "node:test";
import { createFirstRun, firstRunLeft } from "../../app/renderer/first-run.mjs";

// A stand-in for the Settings sheet: what it was last asked, and whether Settings is open by hand.
function sheet() {
  return {
    asked: null, open: false, asking: false,
    ask(flow) { this.asked = flow; this.asking = Boolean(flow); this.open = Boolean(flow); },
  };
}
function room(run, { modelReady = false } = {}) {
  const settings = sheet();
  const sent = [];
  const core = { run, modelReady };
  const firstRun = createFirstRun({ settings, send: (message) => sent.push(message), read: () => core });
  return { settings, sent, core, firstRun };
}

test("the first run asks what the core still misses, and nothing until the core says", () => {
  assert.deepEqual(firstRunLeft(null), [], "unknown, or the project page with no first run");
  assert.deepEqual(firstRunLeft({ needed: false, service: null, model: false }), []);
  assert.deepEqual(firstRunLeft({ needed: true, service: null, model: false }), ["playback", "model"]);
  assert.deepEqual(firstRunLeft({ needed: true, service: "spotify", model: false }), ["model"], "a service saved in the terminal");
  assert.deepEqual(firstRunLeft({ needed: true, service: null, model: false }, { modelReady: true }), ["playback"], "a model that answers already");
  assert.deepEqual(firstRunLeft({ needed: true, service: null, model: false }, { answered: ["playback"] }), ["model"]);
});

test("the window asks for the service, then the model, and steps aside once both are answered", () => {
  const { settings, sent, core, firstRun } = room({ needed: true, service: null, model: false });
  firstRun.update();
  assert.equal(settings.asked.step, "playback");
  assert.deepEqual([settings.asked.at, settings.asked.of], [0, 2]);

  // Choosing a service moves on at once, before the core's status confirms it.
  settings.asked.answer("playback");
  assert.equal(settings.asked.step, "model");
  assert.deepEqual([settings.asked.at, settings.asked.of], [1, 2]);

  // A sign-in gives the core a model; it ends the first run itself, so the window sends nothing.
  core.modelReady = true;
  firstRun.update();
  assert.equal(settings.asked, null);
  core.run = { needed: false, service: "apple_music", model: true };
  firstRun.update();
  assert.equal(settings.asked, null);
  assert.deepEqual(sent, []);
});

test("one step left asks it alone, and the terminal can end the first run while it shows", () => {
  const { settings, sent, core, firstRun } = room({ needed: true, service: "spotify", model: false });
  firstRun.update();
  assert.equal(settings.asked.step, "model");
  assert.equal(settings.asked.of, 1);
  core.run = { needed: false, service: "spotify", model: true };
  firstRun.update();
  assert.equal(settings.asked, null);
  assert.deepEqual(sent, []);
});

test("skipping ends the first run for both surfaces, and it never asks again here", () => {
  const { settings, sent, firstRun } = room({ needed: true, service: null, model: false });
  firstRun.update();
  settings.asked.skip();
  assert.deepEqual(sent, [{ type: "first-run-done", skipped: true }]);
  assert.equal(settings.asked, null);
  // A status that still says needed, sent before the core read the skip, asks nothing.
  firstRun.update();
  settings.asked?.skip();
  assert.equal(settings.asked, null);
  assert.equal(sent.length, 1);
});

test("Settings opened by hand keeps the sheet, and the first run comes back when it closes", () => {
  const { settings, firstRun } = room({ needed: true, service: null, model: false });
  settings.open = true;
  firstRun.update();
  assert.equal(settings.asked, null);
  settings.open = false;
  firstRun.update();
  assert.equal(settings.asked.step, "playback");
});
