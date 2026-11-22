import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";

import { MoondogApplication } from "../../src/core/moondog-application.mjs";
import { createLocalGenerator } from "../../src/integrations/stable-audio/local-generator.mjs";
import { PiAgentRuntime } from "../../src/runtime/pi/agent-runtime.mjs";

// A machine where Stable Audio 3's MLX build cannot run, as the generator sees a Windows PC.
async function windowsGenerator(t) {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-score-generation-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const generator = createLocalGenerator({ platform: "win32", arch: "x64",
    environment: { PATH: process.env.PATH, MOONDOG_CONFIG_HOME: path.join(root, "config"), MOONDOG_STATE_HOME: path.join(root, "state") } });
  await generator.check();
  return generator;
}

// A room's player that records what it was asked to play.
const player = () => {
  const played = [];
  return { played, play() {}, stop() {}, playGenerated: (track) => played.push(track) };
};

const domainServices = (recorded = []) => ({
  listenerChoices: () => ({ total: 1, items: [{ stance: "like", subject: "artist", name: "North Window" }] }),
  recentAttention: () => ({ from_date: "2026-10-01", through_date: "2026-10-28", plays: 9, top_artists: [{ name: "Drift Assembly", plays: 6 }] }),
  listenedNames: () => ({ artists: ["North Window", "Drift Assembly"], titles: ["Pale Signals"] }),
  filterDiscoveryTracks: (tracks) => tracks,
  recordMoondogSuggestions: (entries) => { recorded.push(...entries); return { recorded: entries.length }; },
  recordListenerChoice: () => { throw new Error("no choice should be saved"); },
});

function runtimeFor(app) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, runtime: new PiAgentRuntime({ application: app, models, model: faux.getModel(), provider: "faux", modelId: "faux-1", clock: () => new Date(2026, 10, 21, 23, 30) }) };
}
const toolResult = (context, name) => context.messages.filter((message) => message.role === "toolResult" && message.toolName === name).at(-1);

// The lead sheet the model writes. lead is the vibes line of the loop.
const sheet = (lead) => ({
  tempo: 96,
  key: "Db major",
  parts: [
    { name: "keys", role: "chords", sound: "rhodes", style: "rolled" },
    { name: "bass", role: "bass", sound: "round-bass", style: "push" },
    { name: "drums", role: "drums", sound: "lofi", beat: { kick: "x.........x.....", rim: "....x.......x...", hat: "x.o.x.o.x.o.x.o." } },
    { name: "lead", role: "line", sound: "vibes" },
  ],
  sections: [
    { name: "intro", chords: "Dbadd9 Dbadd9", plays: ["keys"] },
    { name: "loop", chords: "Dbadd9 Bbm7 Gbadd9 Ab7sus4", lines: [{ part: "lead", notes: lead }] },
    { name: "end", chords: "Dbadd9", plays: ["keys", "bass", "lead"], lines: [{ part: "lead", notes: "F5:4" }] },
  ],
});

test("the score tool is how music is made only where Stable Audio 3 is not ready, in a room that can play it", async (t) => {
  const generator = await windowsGenerator(t);
  const ids = (app) => app.agentCapabilityDescriptors().map((descriptor) => descriptor.capability_id);
  const room = new MoondogApplication({ localGenerator: generator, musicPreviewPlayer: player() });
  assert.equal(generator.status().state, "off");
  assert.ok(ids(room).includes("music.generate.score"));
  assert.ok(ids(room).includes("music.generate.replay"), "a track written as a score plays again like any made track");
  assert.ok(!ids(room).includes("music.generate.local") && !ids(room).includes("music.generate.stream"));
  assert.ok(!ids(new MoondogApplication({ localGenerator: generator })).includes("music.generate.score"), "a one-shot command has no player");
  // With Stable Audio 3 ready, that model makes the music and the score tool steps back.
  const ready = new MoondogApplication({ localGenerator: { ...generator, ready: () => true }, musicPreviewPlayer: player() });
  assert.ok(ids(ready).includes("music.generate.local") && !ids(ready).includes("music.generate.score"));
  assert.equal(ready.toolsStatus().capabilities.find((capability) => capability.id === "music.generate.score").blocked_by, "stable_audio_ready");
});

test("a score with wrong notes goes back once, then the fixed one plays as Moondog's own with the host's line", async (t) => {
  const generator = await windowsGenerator(t);
  const recorded = [];
  const room = player();
  const app = new MoondogApplication({ importsRoot: "/private/moondog-synthetic-missing-source", localGenerator: generator, musicPreviewPlayer: room,
    playbackService: "apple_music", domainServices: domainServices(recorded) });
  const { faux, runtime } = runtimeFor(app);
  const descriptors = [{ term: "warm keys", facet: "instrument", source: "choice", from: "North Window" }, { term: "north window haze", facet: "texture", source: "request" }];
  faux.setResponses([
    (context) => {
      const prompt = context.messages.map((message) => JSON.stringify(message)).join("\n") + context.systemPrompt;
      assert.match(prompt, /moondog_write_track writes an instrumental track as a score/u);
      assert.doesNotMatch(prompt, /moondog_make_track makes an instrumental track/u);
      // D natural held over Dbadd9: outside the key and a semitone above the root.
      return fauxAssistantMessage([fauxToolCall("moondog_write_track", { sheet: sheet("D5:4 Db5:4 Bb4:4 Eb5:4"), descriptors, title: "Small Hours" })], { stopReason: "toolUse" });
    },
    (context) => {
      const result = toolResult(context, "moondog_write_track");
      assert.equal(result.isError, false, result.content[0].text);
      const value = JSON.parse(result.content[0].text);
      assert.equal(value.state, "not_made");
      assert.equal(value.reason, "wrong_notes");
      assert.match(value.problems[0].where, /^lead, bar 3$/u);
      assert.match(value.problems[0].problem, /D is outside Db major/u);
      assert.equal(room.played.length, 0);
      return fauxAssistantMessage([fauxToolCall("moondog_write_track", { sheet: sheet("F5:4 Db5:4 Bb4:4 Eb5:4"), descriptors, title: "Small Hours" })], { stopReason: "toolUse" });
    },
    (context) => {
      const result = toolResult(context, "moondog_write_track");
      assert.equal(result.isError, false, result.content[0].text);
      const value = JSON.parse(result.content[0].text);
      assert.equal(value.state, "playing");
      assert.equal(value.written_as_score, true);
      assert.deepEqual(value.score, { key: "Db major", tempo: 96, bars: 7, form: "intro (2), loop (4), end (1)", sounds: ["rhodes", "round-bass", "lofi", "vibes"] });
      assert.deepEqual(value.score_notes, []);
      assert.deepEqual(value.shaped_by.map((entry) => [entry.term, entry.source.kind]), [["warm keys", "choice"]]);
      assert.deepEqual(value.left_out, [{ term: "north window haze", reason: "name" }]);
      assert.equal(value.track.title, "Small Hours");
      assert.doesNotMatch(result.content[0].text, /\/(?:Users|private|tmp|var)\//u);
      return fauxAssistantMessage([fauxText("A slow one in D flat, with the warm keys you like.")]);
    },
  ]);
  const reply = await runtime.prompt("write me something for late tonight");
  assert.match(reply.text, /^A slow one in D flat, with the warm keys you like\.\n\nWritten by Moondog as a score: "Small Hours" \(0:[12]\d\)\.$/u);
  const [track] = room.played;
  assert.equal(room.played.length, 1);
  assert.ok(path.isAbsolute(track.file) && track.file.endsWith(path.join(track.id, "track.wav")));
  assert.equal((await readFile(track.file)).toString("ascii", 0, 4), "RIFF");
  assert.deepEqual(recorded.map((entry) => [entry.action, entry.title]), [["generated.play", "Small Hours"]]);
  const receipt = await generator.receipt(track.id);
  assert.equal(receipt.generator.adapter, "dawn-score");
  assert.equal(receipt.generator.sheet.sections[1].lines[0].notes, "F5:4 Db5:4 Bb4:4 Eb5:4", "the receipt keeps the sheet, so the track can be rendered or changed again");
  assert.match(receipt.generator.prompt, /^Written as a score: Db major, 96 BPM, 7 bars\./u);
  assert.equal(receipt.request, "write me something for late tonight");
  // It is listed with Moondog's tracks, and plays again like one Stable Audio 3 made.
  await app.refreshMadeTracks();
  assert.deepEqual(app.madeTracks().map((made) => [made.title, made.written_as_score.key]), [["Small Hours", "Db major"]]);
  const again = await app.playMadeTrack({ id: track.id });
  assert.equal(again.state, "playing");
  assert.equal(room.played.length, 2);
});
