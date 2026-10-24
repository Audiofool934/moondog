import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { MoondogApplication } from "../../src/core/moondog-application.mjs";
import {
  createPlaybackSelection,
  readPlaybackPreference,
  resolvePlaybackPreferenceFile,
  resolvePlaybackService,
  watchPlaybackPreference,
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

test("a shared service selection saves before notifying every conversation and survives restart", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-service-selection-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const environment = { MOONDOG_CONFIG_HOME: root };
  const selection = createPlaybackSelection({ service: "spotify", save: (service) => writePlaybackPreference(service, environment) });
  const first = new MoondogApplication({ playbackSelection: selection });
  const second = new MoondogApplication({ playbackSelection: selection });
  const seen = [];
  const unsubscribe = selection.subscribe((service) => seen.push([service, first.playbackService, second.playbackService]));
  assert.equal(await selection.change("apple_music"), "apple_music");
  assert.deepEqual(seen, [["apple_music", "apple_music", "apple_music"]]);
  assert.equal(new MoondogApplication({ playbackService: await resolvePlaybackService(environment) }).playbackService, "apple_music");
  assert.equal(await selection.change("apple_music"), "apple_music");
  assert.equal(seen.length, 1, "choosing the current service is a no-op");
  unsubscribe();
  await selection.change("spotify");
  assert.equal(seen.length, 1);
});

// An application whose players record what they are told: Spotify, Apple Music previews and NetEase.
function players({ service = "spotify", spotify = true, netease = "ready" } = {}) {
  const actions = [];
  const application = new MoondogApplication({
    playbackSelection: createPlaybackSelection({ service }),
    ...(spotify ? { spotifyConnection: { ready: () => true, publicStatus: () => ({ state: "ready" }),
      service: { pause: async () => { actions.push("spotify:pause"); } } } } : {}),
    musicCatalog: { findArtistReleases() {}, findPreview() {} },
    musicPreviewPlayer: { play() {}, stop: () => { actions.push("apple_music:stop"); } },
    neteasePlayer: { ready: () => netease === "ready", status: () => ({ state: netease }), check: async () => ({ state: netease }),
      stop: async () => { actions.push("netease:stop"); } },
  });
  return { application, actions };
}

test("the picker may choose Spotify before it is connected, as Connect Spotify does; the agent may not", async () => {
  const { application, actions } = players({ service: "apple_music", spotify: false });
  try {
    const refused = await application.selectPlaybackService("spotify");
    assert.equal(refused.refused, "Spotify is not connected.");
    assert.equal(refused.changed, false);
    assert.equal(application.playbackService, "apple_music");
    const chosen = await application.selectPlaybackService("spotify", { strict: false });
    assert.equal(chosen.refused, undefined);
    assert.equal(chosen.changed, true);
    assert.equal(application.playbackService, "spotify");
    assert.deepEqual(actions, ["apple_music:stop"]);
  } finally { application.close(); }
});

test("NetEase needs a signed-in ncm-cli for the picker too, and says how to get there", async () => {
  for (const [state, hint] of [["missing", /npm install -g @music163\/ncm-cli, then ncm-cli login/u], ["signed_out", /Run ncm-cli login in a terminal/u]]) {
    const { application } = players({ netease: state });
    try {
      for (const strict of [true, false]) {
        const result = await application.selectPlaybackService("netease", { strict });
        assert.match(result.refused, hint);
        assert.equal(application.playbackService, "spotify");
      }
    } finally { application.close(); }
  }
});

test("leaving a music service stops what it plays, so two never play at once", async () => {
  const { application, actions } = players();
  try {
    await application.selectPlaybackService("apple_music");
    await application.selectPlaybackService("netease");
    await application.selectPlaybackService("spotify");
    await application.selectPlaybackService("spotify");
    assert.deepEqual(actions, ["spotify:pause", "apple_music:stop", "netease:stop"]);
  } finally { application.close(); }
});

test("a choice is saved even when this process already holds it, because the other surface may not", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-service-resave-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const environment = { MOONDOG_CONFIG_HOME: root };
  const save = (service) => writePlaybackPreference(service, environment);
  const window = createPlaybackSelection({ service: "spotify", save });
  const terminal = createPlaybackSelection({ service: "spotify", save });
  await window.change("apple_music");
  assert.equal(await readPlaybackPreference(environment), "apple_music");
  await terminal.change("spotify");
  assert.equal(await readPlaybackPreference(environment), "spotify");
});

test("a service saved by one surface reaches the other's selection through the file", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-service-watch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const environment = { MOONDOG_CONFIG_HOME: root };
  const save = (service) => writePlaybackPreference(service, environment);
  const window = createPlaybackSelection({ service: "spotify", save });
  const terminal = createPlaybackSelection({ service: "spotify", save });
  const heard = [];
  const published = [];
  terminal.subscribe((service) => published.push(service));
  const unwatch = watchPlaybackPreference(terminal, { environment, interval: 10, onChange: (service) => heard.push(service) });
  t.after(unwatch);
  const settled = async (expected) => {
    for (let wait = 0; wait < 200 && terminal.service !== expected; wait += 1) await new Promise((resolve) => { setTimeout(resolve, 10); });
    assert.equal(terminal.service, expected);
  };
  await window.change("apple_music");
  await settled("apple_music");
  await window.change("netease");
  await settled("netease");
  assert.deepEqual(heard, ["apple_music", "netease"]);
  assert.deepEqual(published, ["apple_music", "netease"]);
  // Its own saves are not heard back as changes from elsewhere.
  await terminal.change("spotify");
  await new Promise((resolve) => { setTimeout(resolve, 100); });
  assert.deepEqual(heard, ["apple_music", "netease"]);
});
