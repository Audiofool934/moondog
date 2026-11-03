import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { repairToolArguments } from "../../src/runtime/pi/tool-arguments.mjs";

const song = Type.Object({ title: Type.String({ minLength: 1 }), artist: Type.String({ minLength: 1 }) }, { additionalProperties: false });
const player = { name: "moondog_spotify_player_control", parameters: Type.Union([
  Type.Object({ action: Type.Literal("resume"), item_ref_id: Type.Optional(Type.String({ minLength: 1 })),
    songs: Type.Optional(Type.Array(song, { minItems: 1 })), device_name: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("pause"), device_name: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("volume"), percent: Type.Integer({ minimum: 0, maximum: 100 }) }, { additionalProperties: false }),
]) };
const nude = { title: "Nude", artist: "Radiohead" };

test("valid arguments pass through unchanged", () => {
  const args = { action: "resume", songs: [nude] };
  assert.equal(repairToolArguments(player, args), args);
});

test("mistakes with one clear reading are repaired", () => {
  assert.deepEqual(repairToolArguments(player, { action: "play", songs: [nude] }), { action: "resume", songs: [nude] });
  assert.deepEqual(repairToolArguments(player, { action: "Play", title: "Nude", artist: "Radiohead", type: "track" }), { action: "resume", songs: [nude] });
  assert.deepEqual(repairToolArguments(player, { action: "resume", songs: nude, device_name: "" }), { action: "resume", songs: [nude] });
  assert.deepEqual(repairToolArguments(player, { songs: [nude] }), { action: "resume", songs: [nude] });
  assert.deepEqual(repairToolArguments(player, { action: "stop", item_ref_id: "x" }), { action: "pause" });
  assert.deepEqual(repairToolArguments(player, { action: "set_volume", volume: 30 }), { action: "volume", percent: 30 });
  assert.deepEqual(repairToolArguments(player, '{"action":"pause"}'), { action: "pause" });
});

test("arguments without a clear repair are left for validation to report", () => {
  const args = { action: "dance" };
  assert.equal(repairToolArguments(player, args), args);
  const noArtist = { action: "resume", songs: [{ title: "Nude" }] };
  assert.equal(repairToolArguments(player, noArtist), noArtist);
  // A song's extra field may be a constraint: it is kept, so validation refuses the call.
  const live = { action: "resume", songs: [{ title: "Nude", artist: "Radiohead", version: "Live" }] };
  assert.equal(repairToolArguments(player, live), live);
});

test("search types are read in their plural and song forms", () => {
  const search = { name: "moondog_spotify_search", parameters: Type.Object({ query: Type.String({ minLength: 1 }),
    type: Type.Optional(Type.Union(["track", "album"].map((value) => Type.Literal(value)))) }, { additionalProperties: false }) };
  assert.deepEqual(repairToolArguments(search, { query: "Nude", type: "songs" }), { query: "Nude", type: "track" });
  assert.deepEqual(repairToolArguments(search, { query: "Nude", type: "Albums" }), { query: "Nude", type: "album" });
  // An unknown key is not dropped: it may carry a meaning the tool must refuse.
  const unknown = { query: "Nude", type: "songs", subject_id: "someone-else" };
  assert.equal(repairToolArguments(search, unknown), unknown);
});
