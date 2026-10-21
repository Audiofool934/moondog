import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { MoondogApplication } from "../../src/core/moondog-application.mjs";
import {
  readPlaybackPreference,
  resolvePlaybackPreferenceFile,
  resolvePlaybackService,
  writePlaybackPreference,
} from "../../src/core/playback-preferences.mjs";
import { resolveLanguagePreferenceFile } from "../../src/i18n/preferences.mjs";

test("the chosen music service survives restarts, next to the language preference", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-playback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const environment = { MOONDOG_CONFIG_HOME: root };
  assert.equal(path.dirname(resolvePlaybackPreferenceFile(environment)), path.dirname(resolveLanguagePreferenceFile(environment)));
  assert.equal(await readPlaybackPreference(environment), null);
  assert.equal(await resolvePlaybackService(environment), "spotify");

  assert.equal(await writePlaybackPreference("apple_music", environment), "apple_music");
  assert.deepEqual(JSON.parse(await readFile(path.join(root, "playback.json"), "utf8")), { version: 1, service: "apple_music" });
  assert.equal(await resolvePlaybackService(environment), "apple_music");
  await writePlaybackPreference("spotify", environment);
  assert.equal(await resolvePlaybackService(environment), "spotify");

  await assert.rejects(writePlaybackPreference("tidal", environment), /Unsupported music service/u);
  assert.equal(await resolvePlaybackService(environment), "spotify", "a refused value leaves the saved one");
  for (const text of ["{", JSON.stringify({ version: 2, service: "apple_music" }), JSON.stringify({ version: 1, service: "tidal" })]) {
    await writeFile(path.join(root, "playback.json"), text);
    assert.equal(await resolvePlaybackService(environment), "spotify", text);
  }
});

test("the application starts with the saved service, and Spotify unless told otherwise", () => {
  assert.equal(new MoondogApplication({}).playbackService, "spotify");
  assert.equal(new MoondogApplication({ playbackService: "apple_music" }).playbackService, "apple_music");
  assert.equal(new MoondogApplication({ playbackService: "tidal" }).playbackService, "spotify");
  const application = new MoondogApplication({});
  assert.equal(application.setPlaybackService("apple_music"), "apple_music");
  assert.throws(() => application.setPlaybackService("tidal"), /Unsupported music service/u);
  assert.equal(application.playbackService, "apple_music");
});
