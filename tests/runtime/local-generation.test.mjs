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
import { createLocalGenerator, readGenerationSettings } from "../../src/integrations/stable-audio/local-generator.mjs";
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
  assert.deepEqual(events.find((event) => event.type === "playing").track, { title: "Night glass", artist_credit: "", generated: true });

  const port = new EventEmitter();
  const sent = [];
  port.postMessage = (message) => sent.push(message);
  const window = createWindowPreviewPlayer(port);
  window.playGenerated({ id: "../../etc", title: "Night glass", file });
  window.playGenerated({ id: "6f1c1b2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b", title: "Night glass", seconds: 15, file });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].tracks, [{ title: "Night glass", artist_credit: "", generated: true,
    media_url: "moondog-media://generated/6f1c1b2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b", duration_seconds: 15 }]);
  assert.doesNotMatch(JSON.stringify(sent), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
});
