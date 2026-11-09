import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { drawCover, LOUDNESS_POINTS, readLoudness, trackFolderCover } from "../../src/integrations/stable-audio/cover.mjs";

// A 16-bit stereo WAV that is silent for its first half and loud for its second.
function wav(seconds = 2, rate = 8000) {
  const frames = seconds * rate;
  const data = Buffer.alloc(frames * 4);
  for (let frame = frames / 2; frame < frames; frame += 1) {
    const value = Math.round(Math.sin(frame / 5) * 20000);
    data.writeInt16LE(value, frame * 4);
    data.writeInt16LE(value, frame * 4 + 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii"); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii"); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 4, 28); header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii"); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const receipt = {
  generated_track_id: "0b6c1d3e-8f2a-4c5b-9d7e-1a2b3c4d5e6f",
  created_at: "2026-11-02T08:29:25.473Z",
  title: "夜半磁带循环 · 2",
  shaped_by: [{ term: "lofi hip hop", facet: "genre" }, { term: "tape saturation", facet: "texture" }, { term: "vinyl crackle", facet: "texture" }],
  bpm: 74,
  stream: { position: 2, featured: ["tape saturation", "vinyl crackle"] },
  generator: { seed: 730704551, seconds: 120 },
  audio: { duration_seconds: 120 },
};

test("a WAV's loudness runs from its quiet start to its loud end", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "moondog-cover-"));
  try {
    await writeFile(path.join(folder, "track.wav"), wav());
    const loudness = await readLoudness(path.join(folder, "track.wav"));
    assert.equal(loudness.length, LOUDNESS_POINTS);
    assert.equal(loudness[0], 0);
    assert.ok(loudness.at(-1) >= 0.99);
    await writeFile(path.join(folder, "not.wav"), "not a wav");
    assert.equal(await readLoudness(path.join(folder, "not.wav")), null);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("one receipt always draws one cover, in the look its sound asks for, with its readout", () => {
  const loudness = Array.from({ length: LOUDNESS_POINTS }, (_, index) => index / (LOUDNESS_POINTS - 1));
  const first = drawCover(receipt, { loudness });
  assert.equal(drawCover(receipt, { loudness }).svg, first.svg, "the same receipt draws the same cover");
  assert.notEqual(drawCover({ ...receipt, generator: { ...receipt.generator, seed: 1 } }, { loudness }).svg, first.svg);
  assert.equal(first.look.ramp, "grain", "tape and crackle draw in grain");
  assert.equal(first.look.banded, true);
  assert.match(first.svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="600" height="600"/u);
  assert.doesNotMatch(first.svg, /<script|foreignObject|href=/u, "a cover is only shapes and text");
  assert.equal(first.lines.length, 24);
  assert.ok(first.lines.every((line) => [...line].length <= 40));
  assert.match(first.lines[0], /^moondog\s+on air #02$/u);
  assert.equal(first.lines.at(-2), "// tape saturation, vinyl crackle");
  assert.equal(first.lines.at(-1), "2:00  74 bpm  seed 730704551");
  // Without loudness the field alone is the cover.
  assert.equal(drawCover({ ...receipt, shaped_by: [] }).look.banded, false);
});

test("a track folder's cover is drawn from its receipt, measuring older tracks' audio", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "moondog-cover-"));
  try {
    assert.equal(await trackFolderCover(folder), null, "no receipt, no cover");
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "receipt.json"), JSON.stringify(receipt));
    await writeFile(path.join(folder, "track.wav"), wav());
    const measured = await trackFolderCover(folder);
    assert.equal(measured, drawCover(receipt, { loudness: await readLoudness(path.join(folder, "track.wav")) }).svg);
    // The audio a stream let go leaves the field alone.
    await rm(path.join(folder, "track.wav"));
    assert.equal(await trackFolderCover(folder), drawCover(receipt).svg);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
