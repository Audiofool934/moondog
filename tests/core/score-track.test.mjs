import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { renderScore } from "../../src/integrations/score/render-score.mjs";
import { buildTrackScore, describeScore } from "../../src/integrations/score/track-score.mjs";

// A short lead sheet in the shape Moondog's agent writes: four parts, an intro and a loop.
const sheet = () => ({
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
    { name: "loop", chords: "Dbadd9 Bbm7 Gbadd9 Ab7sus4", lines: { lead: "-:0.5 Ab4:1 -:0.5 F5:1.5 Eb5:0.5 Db5:2 -:0.5 Bb4:1.5 -:0.5 Ab4:1 Bb4:0.5 Db5:2 Eb5:3" } },
    { name: "end", chords: "Dbadd9", plays: ["keys", "bass", "lead"], lines: { lead: "F5:4" } },
  ],
});

test("a lead sheet becomes a score with every part's notes", () => {
  const built = buildTrackScore(sheet());
  assert.equal(built.ok, true);
  assert.equal(built.bars, 7);
  assert.equal(Math.round(built.seconds), 18);
  assert.deepEqual(built.summary.parts.map((part) => part.sound), ["rhodes", "round-bass", "lofi", "vibes"]);
  assert.deepEqual(built.summary.chords, ["Dbadd9", "Bbm7", "Gbadd9", "Ab7sus4"]);
  assert.equal(built.wrong_notes, 0);
  assert.match(describeScore(built.summary), /Db major, 96 BPM, 7 bars/u);
  // Each part of the score holds notes: chords for seven bars, bass and drums where they play, the line where written.
  const tracks = new Map(built.score.tracks.map((entry) => [entry.name, entry]));
  assert.deepEqual([...tracks.keys()], ["keys", "bass", "drums", "lead"]);
  const counts = Object.fromEntries(built.score.tracks.map((entry) => [entry.name, built.score.notes.filter((note) => note.trackId === entry.id).length]));
  assert.ok(counts.keys >= 7 * 3, "a chord of at least three notes in each bar");
  assert.equal(counts.bass, 5 * 2, "two bass notes a bar in the loop and the ending");
  assert.equal(counts.drums, 4 * 12, "twelve hits a bar in the loop");
  assert.equal(counts.lead, 9 + 1);
});

test("a sheet that cannot be played says what to fix", () => {
  const problemsOf = (change) => {
    const broken = sheet();
    change(broken);
    const built = buildTrackScore(broken);
    assert.equal(built.ok, false);
    return built.problems.map((entry) => `${entry.where}: ${entry.problem}`).join("\n");
  };
  assert.match(problemsOf((broken) => { broken.sections[1].chords = "Dbadd9 Hm7"; }), /sections\[1\]\.chords: "Hm7" is not a chord symbol/u);
  assert.match(problemsOf((broken) => { broken.sections[2].lines.lead = "F5:4 Eb5:2"; }), /6 beats long, but the section's 1 bars hold 4\. Shorten it by 2 beats/u);
  assert.match(problemsOf((broken) => { broken.sections[1].plays = ["keys", "strings"]; }), /"strings" is not one of the parts/u);
  assert.match(problemsOf((broken) => { broken.parts[2].beat.kick = "x...x..."; }), /16 steps a bar/u);
  assert.match(problemsOf((broken) => { broken.parts[3].sound = "saxophone"; }), /A line part's sound is one of vibes/u);
  assert.match(problemsOf((broken) => { broken.sections = [broken.sections[2]]; }), /runs 3 seconds .* it can be 15 to 300/u);
  assert.match(problemsOf((broken) => { broken.sections[1].lines.lead = "Ab4 F5"; }), /is not pitch:beats/u);
});

test("the lint hears a wrong note, and the track is still built", () => {
  const off = sheet();
  // D natural, held over Dbadd9: a semitone above the root and outside the key.
  off.sections[2].lines.lead = "D5:4";
  const built = buildTrackScore(off);
  assert.equal(built.ok, true);
  assert.ok(built.notes.length > 0);
  assert.ok(built.notes.every((entry) => entry.problem && ["error", "warn"].includes(entry.severity)));
});

test("a score renders to a WAV that ends soon after its last note", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "moondog-score-"));
  try {
    const built = buildTrackScore(sheet());
    const file = path.join(folder, "track.wav");
    const rendered = await renderScore(built.score, file);
    const bytes = await readFile(file);
    assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
    assert.equal(bytes.readUInt32LE(24), 44_100);
    assert.equal(bytes.readUInt16LE(22), 2);
    assert.equal(bytes.length, 44 + rendered.frames * 4);
    const seconds = rendered.frames / rendered.sample_rate;
    // 17.5 seconds of written music, then the last chord rings out; never the renderer's long silent tail.
    assert.ok(seconds > built.seconds && seconds < built.seconds + 8, `ran ${seconds} seconds`);
    assert.equal(rendered.clipped, 0);
    // It is music, not silence: the loudest sample is well above the noise floor.
    let peak = 0;
    for (let offset = 44; offset < bytes.length; offset += 2) peak = Math.max(peak, Math.abs(bytes.readInt16LE(offset)));
    assert.ok(peak > 3_000, `peak ${peak}`);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("a stop ends the render", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "moondog-score-"));
  try {
    const controller = new AbortController();
    const rendering = renderScore(buildTrackScore(sheet()).score, path.join(folder, "track.wav"), { signal: controller.signal });
    controller.abort();
    await assert.rejects(rendering, { code: "generation_stopped" });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
