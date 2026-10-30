import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";

import { createWindowPreviewPlayer } from "../../app/preview-player.mjs";
import { MoondogApplication } from "../../src/core/moondog-application.mjs";
import { createTerminalPreviewPlayer } from "../../src/integrations/apple-music/terminal-preview-player.mjs";
import { createAtmosphereStream, createLocalGenerator, readGenerationSettings } from "../../src/integrations/stable-audio/local-generator.mjs";
import { PiAgentRuntime } from "../../src/runtime/pi/agent-runtime.mjs";

// A stand-in for Stability AI's MLX build: its Python prints the stage lines the real script
// prints, writes a short WAV where --out says, and logs its arguments. FAKE_SA3 makes it fail or hang.
async function fakeInstall(t, { weights = true, environment = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-generation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const install = path.join(root, "mlx");
  await mkdir(path.join(install, "scripts"), { recursive: true });
  await writeFile(path.join(install, "scripts", "sa3_mlx.py"), "# stand-in\n");
  if (environment) {
    await mkdir(path.join(install, ".venv", "bin"), { recursive: true });
    const python = path.join(install, ".venv", "bin", "python");
    await writeFile(python, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
fs.writeFileSync(${JSON.stringify(path.join(root, "args.json"))}, JSON.stringify({ args, cwd: process.cwd(), offline: process.env.HF_HUB_OFFLINE }));
// A stubborn run ignores the request to stop from its first line on.
if (process.env.FAKE_SA3 === "stubborn") process.on("SIGTERM", () => {});
console.log("  [1/5] T5Gemma encode ···· 10 ms");
if (process.env.FAKE_SA3 === "hang") { setInterval(() => {}, 1000); return; }
if (process.env.FAKE_SA3 === "stubborn") { setInterval(() => {}, 1000); return; }
if (process.env.FAKE_SA3 === "fail") { console.error("Traceback: " + value("--out")); process.exit(1); }
console.log("  [3/5] DiT \\u2014 load + sample (8 steps, \\u03c3max=1.00)");
console.log("  [4/5] Decoder (same-l, FP32)");
const seconds = Number(value("--seconds"));
const data = Buffer.alloc(Math.round(seconds * 44100) * 4);
const header = Buffer.alloc(44);
header.write("RIFF", 0, "ascii"); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8, "ascii");
header.write("fmt ", 12, "ascii"); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22);
header.writeUInt32LE(44100, 24); header.writeUInt32LE(176400, 28); header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34);
header.write("data", 36, "ascii"); header.writeUInt32LE(data.length, 40);
fs.writeFileSync(value("--out"), Buffer.concat([header, data]));
console.log("  [5/5] Unpatch + write WAV ···· 1 ms");
console.log("  done   0.20s wall  \\u2192  " + seconds.toFixed(1) + "s audio  \\u2192  75.00\\u00d7 realtime   peak RAM  4.49 GB   seed " + value("--seed"));
console.log("  \\u25b8 saved  " + value("--out"));
`);
    await chmod(python, 0o755);
  }
  if (weights) {
    await mkdir(path.join(install, "models", "mlx"), { recursive: true });
    for (const name of ["t5gemma_f16.npz", "dit_medium_f16.npz", "same_l_decoder_f32.npz"]) {
      await writeFile(path.join(install, "models", "mlx", name), Buffer.alloc(2048));
    }
  }
  const env = {
    PATH: process.env.PATH,
    MOONDOG_CONFIG_HOME: path.join(root, "config"),
    MOONDOG_STATE_HOME: path.join(root, "state"),
    MOONDOG_SA3_DIR: install,
  };
  const generator = (extra = {}) => createLocalGenerator({ environment: { ...env, ...extra }, platform: "darwin", arch: "arm64" });
  const args = async () => JSON.parse(await readFile(path.join(root, "args.json"), "utf8"));
  const generated = () => readdir(path.join(root, "state", "generated")).catch(() => []);
  return { root, install, env, generator, args, generated };
}

test("music making stays off until the listener turns it on, and says what the install lacks", async (t) => {
  const ready = await fakeInstall(t);
  const generator = ready.generator();
  assert.equal((await generator.check()).state, "off");
  assert.equal(generator.status().install, "ready");
  assert.equal(generator.ready(), false);
  assert.equal((await generator.save({ enabled: true })).state, "ready");
  assert.equal((await readGenerationSettings(ready.env)).source, "environment", "MOONDOG_SA3_DIR points at the install but never turns it on");

  const noWeights = await fakeInstall(t, { weights: false });
  const missingModel = noWeights.generator();
  await missingModel.save({ enabled: true });
  assert.deepEqual([missingModel.status().state, missingModel.status().missing], ["incomplete", "weights"]);

  const noEnvironment = await fakeInstall(t, { environment: false });
  assert.deepEqual([(await noEnvironment.generator().save({ enabled: true })).missing], ["environment"]);

  const elsewhere = createLocalGenerator({ environment: { ...ready.env, MOONDOG_SA3_DIR: path.join(ready.root, "nothing") }, platform: "darwin", arch: "arm64" });
  assert.equal((await elsewhere.check()).install, "missing");
  const linux = createLocalGenerator({ environment: ready.env, platform: "linux", arch: "x64" });
  assert.equal((await linux.check()).install, "unsupported");
});

test("a track is made with every choice passed, offline, and kept with a receipt that holds no path", async (t) => {
  const install = await fakeInstall(t);
  const generator = install.generator();
  await generator.save({ enabled: true });
  const stages = [];
  const made = await generator.generate({ prompt: "TrackType: Music, VocalType: Instrumental, Genre: Dream Pop.", seconds: 15, seed: 42, title: "Glass harbor",
    receipt: { shaped_by: [{ term: "dream pop", facet: "genre", source: { kind: "request" } }] } }, { onProgress: ({ stage }) => stages.push(stage) });
  assert.deepEqual(stages, ["starting", "reading", "composing", "decoding", "writing"]);
  assert.equal(made.duration_seconds, 15);
  assert.equal(made.measured.peak_memory_mb, Math.round(4.49 * 1024));

  const { args, cwd, offline } = await install.args();
  assert.equal(cwd, await realpath(install.install));
  assert.equal(offline, "1", "missing weights fail instead of downloading");
  for (const [flag, value] of [["--dit", "medium"], ["--decoder", "same-l"], ["--seconds", "15"], ["--seed", "42"], ["--steps", "8"]]) {
    assert.equal(args[args.indexOf(flag) + 1], value, flag);
  }
  assert.ok(!args.includes("--play"), "Moondog plays the track itself");
  assert.ok(path.isAbsolute(args[args.indexOf("--out") + 1]));

  assert.deepEqual(await install.generated(), [made.id], "the run's working folder became the track's folder");
  const receipt = await generator.receipt(made.id);
  assert.equal(receipt.moondog_id, `moondog:generated:${made.id}`);
  assert.equal(receipt.generator.prompt, "TrackType: Music, VocalType: Instrumental, Genre: Dream Pop.");
  assert.deepEqual(receipt.audio, { file: "track.wav", sample_rate: 44100, channels: 2, bit_depth: 16, size_bytes: 44 + 15 * 176400, duration_seconds: 15 });
  assert.ok(!JSON.stringify(receipt).includes(path.basename(install.root)), "the receipt keeps no folder of this Mac");
  assert.ok(await generator.trackFile(made.id));
  assert.equal(await generator.trackFile("../config"), null);
});

test("a stopped, failed or second run leaves no track behind", async (t) => {
  const hanging = await fakeInstall(t);
  const generator = hanging.generator({ FAKE_SA3: "hang" });
  await generator.save({ enabled: true });
  const controller = new AbortController();
  const run = assert.rejects(generator.generate({ prompt: "ambient", seconds: 15 }, { signal: controller.signal,
    onProgress: ({ stage }) => { if (stage === "reading") controller.abort(); } }), { code: "generation_stopped" });
  await assert.rejects(generator.generate({ prompt: "ambient", seconds: 15 }), { code: "generation_busy" });
  await run;
  assert.deepEqual(await hanging.generated(), []);

  // A stop that comes before the model starts frees the slot at once, and starts nothing.
  const early = new AbortController();
  await assert.rejects(generator.generate({ prompt: "ambient", seconds: 15 }, { signal: early.signal,
    onProgress: ({ stage }) => { if (stage === "starting") early.abort(); } }), { code: "generation_stopped" });
  assert.equal(generator.busy(), false);
  assert.deepEqual(await hanging.generated(), []);

  // A run that ignores the request to stop keeps the slot until it is ended, so two never overlap.
  const stubborn = await fakeInstall(t);
  const holding = stubborn.generator({ FAKE_SA3: "stubborn" });
  await holding.save({ enabled: true });
  const stopping = new AbortController();
  const held = assert.rejects(holding.generate({ prompt: "ambient", seconds: 15 }, { signal: stopping.signal,
    onProgress: ({ stage }) => { if (stage === "reading") stopping.abort(); } }), { code: "generation_stopped" });
  await new Promise((resolve) => setTimeout(resolve, 500));
  await assert.rejects(holding.generate({ prompt: "ambient", seconds: 15 }), { code: "generation_busy" });
  await held;
  assert.deepEqual(await stubborn.generated(), []);

  const failing = await fakeInstall(t);
  const broken = failing.generator({ FAKE_SA3: "fail" });
  await broken.save({ enabled: true });
  await assert.rejects(broken.generate({ prompt: "ambient", seconds: 15 }), (error) =>
    error.code === "generation_failed" && !error.message.includes(failing.root));
  assert.deepEqual(await failing.generated(), []);
  await assert.rejects(broken.generate({ prompt: "ambient", seconds: 5 }), { code: "generation_seconds_invalid" });
});

test("the sweep clears a crashed run's folder and keeps one another surface is making", async (t) => {
  const install = await fakeInstall(t);
  const generator = install.generator();
  const folder = path.join(install.root, "state", "generated");
  await mkdir(folder, { recursive: true });
  const live = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"]);
  t.after(() => live.kill());
  const crashed = spawn(process.execPath, ["-e", ""]);
  await new Promise((resolve) => crashed.once("exit", resolve));
  const keep = `.6f1c1b2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b.tmp-${live.pid}-abc`;
  const clear = `.7f1c1b2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b.tmp-${crashed.pid}-abc`;
  await mkdir(path.join(folder, keep));
  await mkdir(path.join(folder, clear));
  await generator.sweep();
  assert.deepEqual(await install.generated(), [keep]);
});

// A room's player that records what it was asked to play.
const player = () => {
  const played = [];
  return { played, play() {}, stop() {}, playGenerated: (track) => played.push(track) };
};

// Fictional listening: a Like, an Avoid, an artist played lately, and a short artist name that is an ordinary word.
const domainServices = (recorded = []) => ({
  listenerChoices: () => ({ total: 2, items: [{ stance: "like", subject: "artist", name: "North Window" }, { stance: "avoid", subject: "artist", name: "Low Lanterns" }] }),
  recentAttention: () => ({ from_date: "2026-10-01", through_date: "2026-10-28", plays: 9, top_artists: [{ name: "Drift Assembly", plays: 6 }] }),
  listenedNames: () => ({ artists: ["North Window", "Low Lanterns", "Drift Assembly", "Air"], titles: ["Pale Signals", "Home"] }),
  filterDiscoveryTracks: (tracks) => tracks.filter((track) => !/low lanterns/iu.test(`${track.artist_credit ?? ""} ${(track.artists ?? []).join(" ")}`)),
  recordMoondogSuggestions: (entries) => { recorded.push(...entries); return { recorded: entries.length }; },
  recordListenerChoice: () => { throw new Error("no choice should be saved"); },
});

test("the tool exists only while music making is ready in a room that can play what it makes", async (t) => {
  const install = await fakeInstall(t);
  const generator = install.generator();
  await generator.check();
  const ids = (app) => app.agentCapabilityDescriptors().map((descriptor) => descriptor.capability_id);
  const off = new MoondogApplication({ localGenerator: generator, musicPreviewPlayer: player() });
  assert.ok(!ids(off).includes("music.generate.local"));
  assert.equal(off.toolsStatus().capabilities.find((capability) => capability.id === "music.generate.local").blocked_by, "local_generation_not_ready");
  await generator.save({ enabled: true });
  assert.ok(ids(off).includes("music.generate.local"));
  assert.ok(!ids(new MoondogApplication({ localGenerator: generator })).includes("music.generate.local"), "a one-shot command has no player");
  assert.equal(off.toolsStatus().capabilities.find((capability) => capability.id === "music.generate").state, "disabled", "paid generation stays off");
});

function runtimeFor(app, { clock = () => new Date(2026, 9, 29, 23, 30) } = {}) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, runtime: new PiAgentRuntime({ application: app, models, model: faux.getModel(), provider: "faux", modelId: "faux-1", clock }) };
}
const toolResult = (context, name) => context.messages.filter((message) => message.role === "toolResult" && message.toolName === name).at(-1);

test("a track Moondog makes is shaped only by traceable taste, plays as its own, and gets the host's line", async (t) => {
  const install = await fakeInstall(t);
  const generator = install.generator();
  await generator.save({ enabled: true });
  const recorded = [];
  const room = player();
  const app = new MoondogApplication({ importsRoot: "/private/moondog-synthetic-missing-source", localGenerator: generator, musicPreviewPlayer: room,
    playbackService: "apple_music", domainServices: domainServices(recorded) });
  const { faux, runtime } = runtimeFor(app);
  faux.setResponses([
    (context) => {
      assert.match(context.messages.map((message) => JSON.stringify(message)).join("\n") + context.systemPrompt, /moondog_make_track makes an instrumental track/u);
      return fauxAssistantMessage([fauxToolCall("moondog_make_track", {
        descriptors: [
          { term: "dream pop", facet: "genre", source: "choice", from: "North Window" },
          { term: "north window guitars", facet: "instrument", source: "choice", from: "North Window" },
          { term: "dusty drum machine", facet: "rhythm", source: "choice", from: "Low Lanterns" },
          { term: "tape saturation", facet: "texture", source: "recent", from: "Drift Assembly" },
          { term: "air", facet: "texture", source: "request" },
          { term: "airy pads", facet: "instrument", source: "request" },
          { term: "unhurried", facet: "mood", source: "moment" },
          { term: "soft choir", facet: "texture", source: "request" },
          { term: "shimmer", facet: "texture", source: "reading", from: "claim_00000000000000000000000000000000" },
        ],
        bpm: 84, bpm_source: "moment", seconds: 15, title: "Low Lanterns at midnight",
      })], { stopReason: "toolUse" });
    },
    (context) => {
      const result = toolResult(context, "moondog_make_track");
      assert.equal(result.isError, false, result.content[0].text);
      const value = JSON.parse(result.content[0].text);
      assert.equal(value.state, "playing");
      assert.deepEqual(value.shaped_by.map((entry) => [entry.term, entry.source.kind]),
        [["dream pop", "choice"], ["tape saturation", "recent"], ["airy pads", "request"], ["unhurried", "moment"]]);
      assert.deepEqual(Object.fromEntries(value.left_out.map((entry) => [entry.term, entry.reason])),
        { "north window guitars": "name", "dusty drum machine": "avoid", air: "name", "soft choir": "vocals", shimmer: "not_a_saved_finding" });
      assert.equal(value.prompt, "TrackType: Music, VocalType: Instrumental, Genre: Dream Pop, Instruments: Airy Pads. Tape saturation, unhurried. 84 BPM.");
      assert.doesNotMatch(value.prompt, /north window|lanterns|drift/iu);
      assert.equal(value.track.title, "Unhurried dream pop", "a title that names an avoided artist gives way to the host's");
      assert.doesNotMatch(result.content[0].text, /\/(?:Users|private|tmp|var)\//u);
      return fauxAssistantMessage([fauxText("Something unhurried for late at night, out of your love of North Window.")]);
    },
  ]);
  const reply = await runtime.prompt("make me something for late tonight");
  const [track] = room.played;
  assert.match(reply.text, /^Something unhurried for late at night, out of your love of North Window\.\n\nMade on this Mac with Stable Audio 3: "Unhurried dream pop" \(0:15, seed \d+\)\.$/u);
  assert.ok(path.isAbsolute(track.file) && track.file.endsWith(path.join(track.id, "track.wav")), "the terminal gets the file; the window asks by id");
  assert.deepEqual(recorded, [{ service: "moondog", action: "generated.play", providerTrackId: `moondog:generated:${track.id}`,
    title: "Unhurried dream pop", artistCredit: "", requestedAt: recorded[0].requestedAt }]);
  const receipt = await generator.receipt(track.id);
  const { time_zone: _zone, ...moment } = receipt.shaped_by.find((entry) => entry.source.kind === "moment").source;
  assert.deepEqual(moment, { kind: "moment", local_date: "2026-10-29", weekday: "thursday", local_hour: 23, part_of_day: "late_night" });
  assert.equal(receipt.request, "make me something for late tonight");
  assert.equal(receipt.avoids_in_force, 1);
});

test("an Avoid older than the newest choices still keeps its artist out of a track", async (t) => {
  const install = await fakeInstall(t);
  const generator = install.generator();
  await generator.save({ enabled: true });
  const app = new MoondogApplication({ importsRoot: "/private/moondog-synthetic-missing-source", localGenerator: generator, musicPreviewPlayer: player(),
    playbackService: "apple_music", domainServices: { ...domainServices(), activeAvoids: () => [{ stance: "avoid", subject: "artist", name: "Glass Choir Collective" }] } });
  const made = await app.makeTrack({ descriptors: [{ term: "slow organ", facet: "instrument", source: "request" }, { term: "ambient", facet: "genre", source: "moment" }],
    seconds: 15 }, { moment: { part_of_day: "evening" }, request: "something like Glass Choir Collective" });
  assert.deepEqual(made.left_out, [{ term: "slow organ", reason: "avoid" }]);
  assert.deepEqual(made.shaped_by.map((entry) => entry.term), ["ambient"]);
});

test("a reply stopped while other players pause plays nothing, and a closing room keeps the last outcome", async (t) => {
  const install = await fakeInstall(t);
  const generator = install.generator();
  await generator.save({ enabled: true });
  const room = player();
  const stopping = new AbortController();
  // The Music app answers slowly, and the listener stops the reply meanwhile.
  const musicApp = { nowPlaying: async () => { stopping.abort(); return { state: "stopped" }; } };
  const app = new MoondogApplication({ importsRoot: "/private/moondog-synthetic-missing-source", localGenerator: generator, musicPreviewPlayer: room,
    musicApp, playbackService: "apple_music", domainServices: domainServices() });
  await assert.rejects(app.makeTrack({ descriptors: [{ term: "ambient", facet: "genre", source: "request" }], seconds: 15 }, { signal: stopping.signal }),
    { code: "generation_stopped" });
  assert.deepEqual(room.played, []);

  // A replay stopped while the other players pause plays nothing and records no replay.
  const replaying = new AbortController();
  musicApp.nowPlaying = async () => { replaying.abort(); return { state: "stopped" }; };
  const [made] = generator.recentTracks();
  await assert.rejects(app.playMadeTrack({ id: made.id }, { signal: replaying.signal }), { code: "generation_stopped" });
  assert.deepEqual(room.played, []);
  assert.equal(generator.recentTracks()[0].outcomes.replayed_by_moondog, 0);

  generator.observe({ type: "playing", track: { generated: true, id: made.id, title: made.title } });
  generator.observe({ type: "stopped" });
  await generator.flush();
  assert.match(await readFile(path.join(install.root, "state", "generated", made.id, "outcomes.jsonl"), "utf8"), /"outcome":"skipped"/u);
});

test("one message makes one track, and a Like said while it plays is not saved as a real song's", async (t) => {
  const install = await fakeInstall(t);
  const generator = install.generator();
  await generator.save({ enabled: true });
  const app = new MoondogApplication({ importsRoot: "/private/moondog-synthetic-missing-source", localGenerator: generator, musicPreviewPlayer: player(),
    playbackService: "apple_music", domainServices: domainServices() });
  const { faux, runtime } = runtimeFor(app);
  const make = (title) => fauxToolCall("moondog_make_track", { descriptors: [{ term: "ambient", facet: "genre", source: "request" }], seconds: 15, title });
  faux.setResponses([
    fauxAssistantMessage([make("Night glass")], { stopReason: "toolUse" }),
    fauxAssistantMessage([make("Night glass again")], { stopReason: "toolUse" }),
    (context) => {
      assert.match(toolResult(context, "moondog_make_track").content[0].text, /^generation_turn_limit:/u);
      return fauxAssistantMessage([fauxText("Here it is.")]);
    },
  ]);
  await runtime.prompt("make an ambient track");
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("moondog_taste_choice", { subject: "track", artist: "Moondog", title: "Night glass", stance: "like", source_text: "I love this one" })], { stopReason: "toolUse" }),
    (context) => {
      assert.match(toolResult(context, "moondog_taste_choice").content[0].text, /^taste_choice_generated_track:/u);
      return fauxAssistantMessage([fauxText("Choices about my own tracks aren't saved yet.")]);
    },
  ]);
  assert.equal((await runtime.prompt("I love this one")).text, "Choices about my own tracks aren't saved yet.");

  // The real composer Moondog is a choice like any other, even after Moondog made a track.
  const saved = [];
  app.domainServices.recordListenerChoice = (choice) => { saved.push(choice); return { state: "recorded", stance: choice.stance, entity_type: choice.entityType, label: choice.label, artist_credit: choice.artistCredit }; };
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("moondog_taste_choice", { subject: "track", artist: "Moondog", title: "Bird's Lament", stance: "like", source_text: "I love Bird's Lament by Moondog" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("Noted.")]),
  ]);
  await runtime.prompt("I love Bird's Lament by Moondog");
  assert.deepEqual(saved.map((choice) => [choice.label, choice.artistCredit]), [["Bird's Lament", "Moondog"]]);
});

test("a made track's plays come back as outcomes, and the agent sees them before it makes the next", async (t) => {
  const install = await fakeInstall(t);
  const generator = install.generator();
  await generator.save({ enabled: true });
  const first = await generator.generate({ prompt: "ambient", seconds: 15, title: "Night glass",
    receipt: { shaped_by: [{ term: "ambient", facet: "genre", source: { kind: "request" } }] } });
  const second = await generator.generate({ prompt: "dub techno", seconds: 15, title: "Low tide",
    receipt: { shaped_by: [{ term: "dub techno", facet: "genre", source: { kind: "request" } }] } });
  const playing = (id) => ({ type: "playing", track: { title: "x", artist_credit: "", generated: true, id } });
  generator.observe(playing(first.id));
  generator.observe({ type: "finished", track: { generated: true, id: first.id } });
  generator.observe({ type: "stopped" });
  generator.observe(playing(second.id));
  generator.observe({ type: "stopped" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const outcomes = (track) => Object.entries(track.outcomes).filter(([, count]) => count).map(([kind]) => kind);
  const [newest, older] = generator.recentTracks();
  assert.deepEqual([newest.title, outcomes(newest), older.title, outcomes(older)], ["Low tide", ["skipped"], "Night glass", ["completed"]]);
  assert.deepEqual(newest.sound, ["dub techno"]);

  // A new room reads the same record back from the tracks' folders.
  const again = install.generator();
  await again.load();
  assert.deepEqual(again.recentTracks().map((track) => [track.title, track.last_outcome]), [["Low tide", "skipped"], ["Night glass", "completed"]]);

  const recorded = [];
  const room = player();
  const app = new MoondogApplication({ importsRoot: "/private/moondog-synthetic-missing-source", localGenerator: again, musicPreviewPlayer: room,
    playbackService: "apple_music", domainServices: domainServices(recorded) });
  await again.check();
  const { faux, runtime } = runtimeFor(app);
  faux.setResponses([
    (context) => {
      const made = context.messages.map((message) => JSON.stringify(message)).join("\n");
      assert.match(made, /made_tracks/u);
      assert.match(made, /Low tide/u);
      return fauxAssistantMessage([fauxToolCall("moondog_play_made_track", { id: older.id })], { stopReason: "toolUse" });
    },
    (context) => {
      const value = JSON.parse(toolResult(context, "moondog_play_made_track").content[0].text);
      assert.deepEqual([value.track.title, value.chosen_by], ["Night glass", "listener"]);
      return fauxAssistantMessage([fauxText("Night glass again.")]);
    },
  ]);
  assert.equal((await runtime.prompt("play \"Night glass\" again")).text, "Night glass again.");
  assert.deepEqual(room.played.map((track) => track.title), ["Night glass"]);
  assert.equal(recorded.length, 0, "a track the listener named is their pick, not Moondog's");
  assert.equal(again.recentTracks().find((track) => track.id === older.id).outcomes.asked_for_again, 1);

  // An open request that shares words with a plain title ("low tide") is Moondog's pick, not the listener's naming it.
  faux.setResponses([fauxAssistantMessage([fauxToolCall("moondog_play_made_track", { id: second.id })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("Here's one of mine.")])]);
  await runtime.prompt("play me something you made for low tide");
  assert.deepEqual(recorded.map((entry) => [entry.providerTrackId, entry.title]), [[`moondog:generated:${second.id}`, "Low tide"]]);
  const lowTide = again.recentTracks().find((track) => track.id === second.id);
  assert.deepEqual([lowTide.outcomes.asked_for_again, lowTide.outcomes.replayed_by_moondog, lowTide.last_outcome], [0, 1, "skipped"]);

  // A replay of the track already playing starts it over; that is not a skip.
  again.observe(playing(second.id));
  await again.recordReplay(second.id, "moondog");
  again.observe({ type: "stopped" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(again.recentTracks().find((track) => track.id === second.id).outcomes.skipped, 1);

  // A Like said while a replayed track plays is about Moondog's own record.
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("moondog_taste_choice", { subject: "track", artist: "Moondog", title: "Low tide", stance: "like", source_text: "I love Low tide by you" })], { stopReason: "toolUse" }),
    (context) => {
      assert.match(toolResult(context, "moondog_taste_choice").content[0].text, /^taste_choice_generated_track:/u);
      return fauxAssistantMessage([fauxText("Not saved yet.")]);
    },
  ]);
  await runtime.prompt("I love Low tide by you");
});

// A room's player for the stream: records what it was asked to do; the test reports its events.
const streamPlayer = () => {
  const calls = [];
  return { calls, play() {}, stop: () => calls.push(["stop"]), playGenerated: (track) => calls.push(["play", track.id]), enqueueGenerated: (track) => calls.push(["enqueue", track.id]) };
};
const until = async (check) => { for (let tries = 0; tries < 200 && !check(); tries += 1) await new Promise((resolve) => setTimeout(resolve, 25)); assert.ok(check()); };
const compiledTaste = { descriptors: [
  { term: "dream pop", facet: "genre", source: { kind: "request" } }, { term: "rhodes piano", facet: "instrument", source: { kind: "request" } },
  { term: "tape hiss", facet: "texture", source: { kind: "request" } }, { term: "brushed drums", facet: "rhythm", source: { kind: "request" } },
  { term: "hushed", facet: "mood", source: { kind: "request" } }, { term: "warm pads", facet: "instrument", source: { kind: "request" } },
  { term: "slow sway", facet: "rhythm", source: { kind: "request" } } ], bpm: 80 };

test("a stream makes each next track while the last plays, steers away from a skip, and ends when stopped", async (t) => {
  const install = await fakeInstall(t);
  const generator = install.generator();
  await generator.save({ enabled: true });
  let clock = 1_000_000;
  const player = streamPlayer();
  const stream = createAtmosphereStream({ generator, player, now: () => clock, keepAudio: 2 });
  const tracks = [];
  const { made } = await stream.start({ compiled: compiledTaste, title: "Late tide", seconds: 15, minutes: 10, receipt: {} }, { onTrack: (track) => tracks.push(track.id) });
  assert.deepEqual(player.calls[0], ["play", made.id]);
  await until(() => player.calls.length === 2);
  const second = player.calls[1][1];
  assert.equal(player.calls[1][0], "enqueue", "the next track waits behind the one playing");
  const prompts = async (id) => (await generator.receipt(id)).generator.prompt;
  assert.notEqual(await prompts(made.id), await prompts(second), "each track features different sounds");

  // The listener skips the first ten seconds in: what it featured stays out from now on.
  clock += 10_000;
  stream.observe({ type: "playing", track: { generated: true, id: second } });
  assert.deepEqual(stream.status().steering_away_from.sort(), (await generator.receipt(made.id)).stream.featured.sort());
  await until(() => player.calls.length === 3);
  const third = player.calls[2][1];
  const featured = new Set((await generator.receipt(made.id)).stream.featured);
  assert.ok((await generator.receipt(third)).stream.featured.every((term) => !featured.has(term)));

  // The second plays through; with the third already queued it moves on, and the queue never runs dry.
  clock += 20_000;
  stream.observe({ type: "finished", track: { generated: true, id: second } });
  stream.observe({ type: "playing", track: { generated: true, id: third } });
  await until(() => player.calls.length === 4);
  // Only the newest two started tracks keep their audio.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await generator.trackFile(made.id), null);
  assert.ok(await generator.receipt(made.id), "the receipt stays");
  assert.ok(await generator.trackFile(third));

  // Other music ends the stream.
  stream.observe({ type: "queue", tracks: [{ title: "Pink Moon", artist_credit: "Nick Drake" }] });
  assert.equal(stream.status(), null);
  assert.equal(tracks.length, 4, "every track went to the ledger as Moondog's");
});

test("a stream whose queue runs dry starts again with the next track, and ends at its time limit", async (t) => {
  const install = await fakeInstall(t);
  const generator = install.generator();
  await generator.save({ enabled: true });
  let clock = 1_000_000;
  const player = streamPlayer();
  const stream = createAtmosphereStream({ generator, player, now: () => clock });
  const { made } = await stream.start({ compiled: compiledTaste, title: "Late tide", seconds: 15, minutes: 10, receipt: {} });
  // It played through before the next was made: the room's player reports finished, then stopped.
  stream.observe({ type: "finished", track: { generated: true, id: made.id } });
  stream.observe({ type: "stopped" });
  assert.ok(stream.status(), "a queue that ran dry is not the listener stopping");
  await until(() => player.calls.length === 2);
  assert.equal(player.calls[1][0], "play", "the next track starts the queue again");
  const second = player.calls[1][1];
  stream.observe({ type: "playing", track: { generated: true, id: second } });
  await until(() => player.calls.length === 3);
  const third = player.calls[2][1];
  // Past the time limit nothing more is made, and the stream ends with the track that plays out.
  clock += 11 * 60_000;
  stream.observe({ type: "finished", track: { generated: true, id: second } });
  stream.observe({ type: "playing", track: { generated: true, id: third } });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(player.calls.length, 3);
  stream.observe({ type: "finished", track: { generated: true, id: third } });
  assert.equal(stream.status(), null);
  // The listener's stop also ends one.
  const again = await stream.start({ compiled: compiledTaste, title: "Late tide", seconds: 15, minutes: 10, receipt: {} });
  assert.ok(again.made.id);
  await until(() => !generator.busy());
  stream.observe({ type: "stopped" });
  assert.equal(stream.status(), null);
});

test("music from before a stream's first track does not end it, a skip past its last track moves it on, and a stop while it waits ends it", async (t) => {
  const install = await fakeInstall(t);
  const generator = install.generator();
  await generator.save({ enabled: true });
  let clock = 1_000_000;
  const player = streamPlayer();
  const stream = createAtmosphereStream({ generator, player, now: () => clock });
  // The room's previews move on, then end, while the first track is made: that is the music before it.
  const before = () => { stream.observe({ type: "playing", track: { title: "Pink Moon", artist_credit: "Nick Drake" } }); stream.observe({ type: "stopped" }); };
  const { made } = await stream.start({ compiled: compiledTaste, title: "Late tide", seconds: 15, minutes: 10, receipt: {} }, { onProgress: before });
  assert.ok(stream.status(), "the stream outlives the music it replaces");
  assert.deepEqual(player.calls[0], ["play", made.id]);

  // Skipped five seconds in, before the next track is made: the player's queue runs out and stops,
  // which is not the listener stopping, and the next track starts the queue again once it is made.
  clock += 5_000;
  stream.observe({ type: "skipped", track: { generated: true, id: made.id } });
  stream.observe({ type: "stopped" });
  assert.ok(stream.status());
  assert.deepEqual(stream.status().steering_away_from.sort(), (await generator.receipt(made.id)).stream.featured.sort());
  await until(() => player.calls.length === 2);
  assert.equal(player.calls[1][0], "play");
  stream.stop();

  // Skipped again while nothing else is made yet, then stopped by the listener: nothing more plays.
  const again = await stream.start({ compiled: compiledTaste, title: "Late tide", seconds: 15, minutes: 10, receipt: {} });
  const calls = player.calls.length;
  stream.observe({ type: "skipped", track: { generated: true, id: again.made.id } });
  stream.observe({ type: "stopped" });
  assert.deepEqual(stream.stop(), { tracks_made: 1 });
  await until(() => !generator.busy());
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(player.calls.slice(calls), [["stop"]]);
  assert.equal(stream.status(), null);
});

test("a stream counts only the time a track was heard toward an early skip, pauses left out", async (t) => {
  const install = await fakeInstall(t);
  const generator = install.generator();
  await generator.save({ enabled: true });
  let clock = 1_000_000;
  const player = streamPlayer();
  const stream = createAtmosphereStream({ generator, player, now: () => clock });
  const { made } = await stream.start({ compiled: compiledTaste, title: "Late tide", seconds: 15, minutes: 10, receipt: {} });
  const track = { generated: true, id: made.id };
  // Five seconds, a minute's pause, then a skip one second after it plays again: six seconds heard.
  clock += 5_000;
  stream.observe({ type: "paused", track });
  clock += 60_000;
  stream.observe({ type: "playing", track });
  clock += 1_000;
  stream.observe({ type: "skipped", track });
  assert.deepEqual(stream.status().steering_away_from.sort(), (await generator.receipt(made.id)).stream.featured.sort());
  await until(() => !generator.busy());
  stream.stop();
});

test("the terminal player reports a made track skipped past the end of its queue, and /stop is no skip", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-generated-skip-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "afplay"), "#!/bin/sh\nexec sleep 5\n");
  await chmod(path.join(bin, "afplay"), 0o755);
  const file = path.join(root, "track.wav");
  await writeFile(file, "RIFF");
  const terminal = await createTerminalPreviewPlayer({ platform: "darwin", environment: { PATH: `${bin}:${process.env.PATH}` }, temporaryRoot: root });
  t.after(() => terminal.close());
  const run = async (end) => {
    const events = [];
    const playing = new Promise((resolve) => { const off = terminal.subscribe((event) => { if (event.type === "playing") { off(); resolve(); } }); });
    const over = new Promise((resolve) => { const off = terminal.subscribe((event) => { events.push(event.type); if (event.type === "stopped") { off(); resolve(); } }); });
    terminal.playGenerated({ id: "x", title: "Night glass", file });
    await playing;
    end();
    await over;
    return events;
  };
  assert.deepEqual((await run(() => terminal.skip())).filter((type) => type !== "queue"), ["playing", "skipped", "stopped"]);
  assert.ok(!(await run(() => terminal.stop())).includes("skipped"));
});

test("the agent starts a stream when the listener asks for music to keep going, and stops it on request", async (t) => {
  const install = await fakeInstall(t);
  const generator = install.generator();
  await generator.save({ enabled: true });
  const recorded = [];
  const player = streamPlayer();
  const stream = createAtmosphereStream({ generator, player });
  const ids = (app) => app.agentCapabilityDescriptors().map((descriptor) => descriptor.capability_id);
  assert.ok(!ids(new MoondogApplication({ localGenerator: generator, atmosphereStream: stream, musicPreviewPlayer: { ...player, enqueueGenerated: undefined } }))
    .includes("music.generate.stream"), "a player that cannot queue a made track runs no stream");
  const app = new MoondogApplication({ importsRoot: "/private/moondog-synthetic-missing-source", localGenerator: generator, atmosphereStream: stream,
    musicPreviewPlayer: player, playbackService: "apple_music", domainServices: domainServices(recorded) });
  assert.ok(ids(app).includes("music.generate.stream") && ids(app).includes("music.generate.stream.stop"));
  const { faux, runtime } = runtimeFor(app);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("moondog_start_stream", { descriptors: [
      { term: "ambient", facet: "genre", source: "request" }, { term: "soft pads", facet: "instrument", source: "request" },
      { term: "tape hiss", facet: "texture", source: "request" }, { term: "unhurried", facet: "mood", source: "moment" }], seconds: 60, minutes: 30 })], { stopReason: "toolUse" }),
    (context) => {
      const value = JSON.parse(toolResult(context, "moondog_start_stream").content[0].text);
      assert.deepEqual([value.state, value.minutes], ["streaming", 30]);
      return fauxAssistantMessage([fauxText("Something quiet to work to; stop it whenever.")]);
    },
  ]);
  const reply = await runtime.prompt("keep some quiet music going while I work");
  assert.match(reply.text, /Made on this Mac with Stable Audio 3: "[^"]+ · 1" \(1:00, seed \d+\)\.\nThe stream keeps going on this Mac, a new track each time, for up to 30 minutes\. Stop it any time\.$/u);
  assert.ok(app.streamStatus());
  await until(() => player.calls.length === 2);
  faux.setResponses([fauxAssistantMessage([fauxToolCall("moondog_stop_stream", {})], { stopReason: "toolUse" }),
    (context) => {
      assert.equal(JSON.parse(toolResult(context, "moondog_stop_stream").content[0].text).state, "stopped");
      return fauxAssistantMessage([fauxText("Stopped.")]);
    }]);
  await runtime.prompt("stop the stream");
  assert.equal(app.streamStatus(), null);
  assert.deepEqual(player.calls.at(-1), ["stop"]);
  assert.equal(recorded.filter((entry) => entry.action === "generated.play").length, 2, "both tracks went to the ledger as Moondog's");
});

test("the terminal plays a made track from its folder and keeps it; the window asks for it by id", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-generated-play-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  await mkdir(bin);
  const log = path.join(root, "played.log");
  await writeFile(path.join(bin, "afplay"), `#!/bin/sh\nfor last; do :; done\nprintf '%s\\n' "$last" >> "${log}"\n`);
  await chmod(path.join(bin, "afplay"), 0o755);
  const file = path.join(root, "track.wav");
  await writeFile(file, "RIFF");
  const terminal = await createTerminalPreviewPlayer({ platform: "darwin", environment: { PATH: bin }, temporaryRoot: root });
  const events = [];
  const stopped = new Promise((resolve) => terminal.subscribe((event) => { events.push(event); if (event.type === "stopped") resolve(); }));
  terminal.playGenerated({ id: "x", title: "Night glass", file });
  await stopped;
  terminal.close();
  assert.equal((await readFile(log, "utf8")).trim(), file);
  assert.equal(await readFile(file, "utf8"), "RIFF", "the track outlives its play");
  assert.deepEqual(events.find((event) => event.type === "playing").track, { title: "Night glass", artist_credit: "", generated: true, id: "x" });
  assert.ok(events.some((event) => event.type === "finished"), "a track that plays to its end is reported finished");

  // A player that cannot play the file reports a failure, which is no outcome at all.
  const broken = path.join(root, "broken-bin");
  await mkdir(broken);
  await writeFile(path.join(broken, "afplay"), "#!/bin/sh\nexit 1\n");
  await chmod(path.join(broken, "afplay"), 0o755);
  const failing = await createTerminalPreviewPlayer({ platform: "darwin", environment: { PATH: broken }, temporaryRoot: root });
  const failed = [];
  const over = new Promise((resolve) => failing.subscribe((event) => { failed.push(event.type); if (event.type === "stopped") resolve(); }));
  failing.playGenerated({ id: "c", title: "Three", file });
  await over;
  failing.close();
  assert.ok(failed.includes("failed") && !failed.includes("finished"));
  const quiet = createLocalGenerator({ environment: { MOONDOG_STATE_HOME: root, MOONDOG_CONFIG_HOME: root } });
  quiet.observe({ type: "playing", track: { generated: true, id: "6f1c1b2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b" } });
  quiet.observe({ type: "failed", track: { generated: true, id: "6f1c1b2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b" } });
  quiet.observe({ type: "stopped" });
  await quiet.flush();
  await assert.rejects(readFile(path.join(root, "generated", "6f1c1b2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b", "outcomes.jsonl"), "utf8"));

  // A made track queued behind the one playing plays after it, and a preview queue takes no made track.
  const second = path.join(root, "second.wav");
  await writeFile(second, "RIFF");
  const queued = await createTerminalPreviewPlayer({ platform: "darwin", environment: { PATH: bin }, temporaryRoot: root });
  const order = [];
  const done = new Promise((resolve) => queued.subscribe((event) => {
    if (event.type === "finished") order.push(event.track.id);
    if (event.type === "stopped") resolve();
  }));
  queued.playGenerated({ id: "a", title: "One", file });
  queued.enqueueGenerated({ id: "b", title: "Two", file: second });
  await done;
  queued.close();
  assert.deepEqual(order, ["a", "b"]);

  const port = new EventEmitter();
  const sent = [];
  port.postMessage = (message) => sent.push(message);
  const window = createWindowPreviewPlayer(port);
  window.playGenerated({ id: "../../etc", title: "Night glass", file });
  window.playGenerated({ id: "6f1c1b2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b", title: "Night glass", seconds: 15, file });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].tracks, [{ title: "Night glass", artist_credit: "", generated: true,
    media_url: "moondog-media://generated/6f1c1b2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b", duration_seconds: 15 }]);
  window.enqueueGenerated({ id: "7f1c1b2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b", title: "Low tide", seconds: 20, file });
  assert.deepEqual(sent[1], { type: "preview-enqueue", id: sent[0].id, track: { title: "Low tide", artist_credit: "", generated: true,
    media_url: "moondog-media://generated/7f1c1b2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b", duration_seconds: 20 } });
  assert.doesNotMatch(JSON.stringify(sent), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
});
