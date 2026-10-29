import assert from "node:assert/strict";
import test from "node:test";

import { stableAudioPrompt } from "../../src/integrations/stable-audio/local-generator.mjs";
import { openEphemeralListeningHistoryStore } from "../../src/profile/listening-history-store.mjs";
import { suggestionEntry, suggestionIdentities } from "../../src/profile/moondog-suggestions.mjs";
import { compileTaste, listenedNames, namedBy } from "../../src/profile/taste-compiler.mjs";

// A fictional listener: a saved finding about a scene, a Like, an Avoid and what they play lately.
const context = (extra = {}) => ({
  claim: (id) => ({ claim_ab: { claim_id: "claim_ab", statement: "A steady thread of hushed dream pop.", kind: "hypothesis" },
    claim_low: { claim_id: "claim_low", statement: "Low Lanterns carried the winter of 2024.", kind: "observation" } })[id] ?? null,
  revisionId: "revision-1",
  likes: [{ stance: "like", subject: "artist", name: "North Window" }, { stance: "like", subject: "track", name: "Pale Signals", artist: "Mira Vale" }],
  avoids: [{ stance: "avoid", subject: "artist", name: "Low Lanterns" }],
  recentArtists: [{ name: "Drift Assembly", plays: 4 }],
  historyArtists: ["Air", "Sea Glass Choir", "Boards Of Midnight"],
  moment: { local_hour: 23, part_of_day: "late_night" },
  request: "something hushed for the drive home",
  ...extra,
});
const reasons = (compiled) => Object.fromEntries(compiled.dropped.map((entry) => [entry.term, entry.reason]));

test("each sound descriptor keeps its traced source, and the compiler drops what names, avoids or cannot be traced", () => {
  const compiled = compileTaste({ descriptors: [
    { term: "Dream Pop", facet: "genre", source: "reading", from: "claim_ab" },
    { term: "slowcore", facet: "genre", source: "reading", from: "claim_low" },
    { term: "shoegaze", facet: "genre", source: "reading", from: "claim_missing" },
    { term: "chorus guitar", facet: "instrument", source: "choice", from: "North Window" },
    { term: "warm rhodes", facet: "instrument", source: "choice", from: "Pale Signals" },
    { term: "brushed drums", facet: "rhythm", source: "choice", from: "Low Lanterns" },
    { term: "tape hiss", facet: "texture", source: "recent", from: "Drift Assembly" },
    { term: "vinyl crackle", facet: "texture", source: "recent", from: "Somebody New" },
    { term: "unhurried", facet: "mood", source: "moment" },
    { term: "hushed", facet: "mood", source: "request" },
    { term: "pale signals swell", facet: "texture", source: "request" },
    { term: "boards of midnight pads", facet: "instrument", source: "request" },
    { term: "air", facet: "texture", source: "request" },
    { term: "airy", facet: "texture", source: "request" },
    { term: "\"glitch\"", facet: "texture", source: "request" },
    { term: "unhurried", facet: "mood", source: "request" },
  ], bpm: 72, bpm_source: "moment", title: "Drive home" }, context());
  assert.equal(compiled.usable, true);
  assert.deepEqual(compiled.descriptors.map((entry) => [entry.term, entry.source.kind]), [
    ["dream pop", "reading"], ["warm rhodes", "choice"], ["tape hiss", "recent"], ["unhurried", "moment"], ["hushed", "request"], ["airy", "request"]]);
  assert.deepEqual(reasons(compiled), {
    slowcore: "avoid", shoegaze: "not_a_saved_finding", "chorus guitar": "vocals", "brushed drums": "avoid", "vinyl crackle": "not_in_recent_attention",
    "pale signals swell": "name", "boards of midnight pads": "name", air: "name", "\"glitch\"": "shape", unhurried: "repeated" });
  assert.deepEqual(compiled.descriptors[0].source, { kind: "reading", claim_id: "claim_ab", revision_id: "revision-1" });
  assert.deepEqual(compiled.descriptors[1].source, { kind: "choice", stance: "like", subject: "track", label: "Pale Signals", artist: "Mira Vale" });
  assert.deepEqual([compiled.bpm, compiled.bpm_source, compiled.title], [72, "moment", "Drive home"]);
});

test("a term credited to the clock that names another time of day came from the listener's words", () => {
  const compiled = compileTaste({ descriptors: [{ term: "midnight hush", facet: "mood", source: "moment" },
    { term: "unhurried", facet: "mood", source: "moment" }] }, context({ moment: { local_hour: 11, part_of_day: "morning" } }));
  assert.deepEqual(compiled.descriptors.map((entry) => [entry.term, entry.source.kind]), [["midnight hush", "request"], ["unhurried", "moment"]]);
});

test("a song Avoid keeps out that song, not its artist's Like", () => {
  const compiled = compileTaste({ descriptors: [
    { term: "dream pop", facet: "genre", source: "choice", from: "North Window" },
    { term: "glassy synths", facet: "instrument", source: "choice", from: "Unwanted Song" },
    { term: "hushed", facet: "mood", source: "reading", from: "claim_song" },
  ] }, context({
    avoids: [{ stance: "avoid", subject: "track", name: "Unwanted Song", artist: "North Window" }],
    claim: (id) => (id === "claim_song" ? { claim_id: "claim_song", statement: "Unwanted Song by North Window was on repeat in May." } : null),
  }));
  assert.deepEqual(compiled.descriptors.map((entry) => entry.term), ["dream pop"]);
  assert.deepEqual(reasons(compiled), { "glassy synths": "avoid", hushed: "avoid" });
});

test("a Like of a song whose artist is now avoided shapes nothing", () => {
  const compiled = compileTaste({ descriptors: [{ term: "glassy synths", facet: "instrument", source: "choice", from: "Pale Signals" },
    { term: "ambient", facet: "genre", source: "request" }] }, context({
    likes: [{ stance: "like", subject: "track", name: "Pale Signals", artist: "Low Lanterns" }],
    avoids: [{ stance: "avoid", subject: "artist", name: "Low Lanterns" }],
  }));
  assert.deepEqual(reasons(compiled), { "glassy synths": "avoid" });
});

test("a term that lists several sounds becomes several descriptors with one source", () => {
  const compiled = compileTaste({ descriptors: [{ term: "hushed, unhurried", facet: "mood", source: "moment" },
    { term: "close; distant room", facet: "texture", source: "request" }] }, context());
  assert.deepEqual(compiled.descriptors.map((entry) => [entry.term, entry.facet, entry.source.kind]),
    [["hushed", "mood", "moment"], ["unhurried", "mood", "moment"], ["close", "texture", "request"], ["distant room", "texture", "request"]]);
});

test("a request that names an Avoid shapes nothing, and a title that names anyone gives way to the sound", () => {
  const compiled = compileTaste({ descriptors: [
    { term: "ambient", facet: "genre", source: "request" },
    { term: "glacial", facet: "mood", source: "moment" },
  ], title: "For North Window" }, context({ request: "something like Low Lanterns" }));
  assert.equal(compileTaste({ descriptors: [{ term: "ambient", facet: "genre", source: "request" }], title: "Pale Signals after midnight" },
    context({ historyTitles: ["Pale Signals", "Home"] })).title, "Ambient", "an album the listener played is a name too");
  assert.equal(compileTaste({ descriptors: [{ term: "ambient", facet: "genre", source: "request" }], title: "Home by midnight" },
    context({ historyTitles: ["Pale Signals", "Home"] })).title, "Home by midnight", "a one-word title is an ordinary word");
  assert.deepEqual(reasons(compiled), { ambient: "avoid" });
  assert.equal(compiled.title, "Glacial", "a mood alone names the record");
  const nothing = compileTaste({ descriptors: [{ term: "four on the floor", facet: "rhythm", source: "request" }] }, context());
  assert.equal(nothing.usable, false, "a rhythm alone describes no music");
  assert.equal(compileTaste({ descriptors: [{ term: "dub techno", facet: "genre", source: "moment" }] }, context({ moment: null })).usable, false,
    "a host without a clock gives no moment");
});

test("only whole names count as names, and short everyday ones only as the whole term", () => {
  const names = { artists: ["The Lanterns"], titles: ["Home"], historyArtists: ["Low", "Mira Vale"], historyTitles: ["Pale Signals"] };
  assert.equal(namedBy("lanterns-style drums", names), "The Lanterns", "a band is named without its article");
  assert.equal(namedBy("home studio", names), "Home");
  assert.equal(namedBy("low end", names), null);
  assert.equal(namedBy("low", names), "Low");
  assert.equal(namedBy("mira vale strings", names), "Mira Vale");
  assert.equal(namedBy("pale signals swell", names), "Pale Signals");
  assert.deepEqual(listenedNames([{ artist_credit: "Mira Vale feat. North Window", title: "Glass Harbor - 2011 Remaster", release: "Pale Signals" }, { artist_credit: "" }]),
    { artists: ["Mira Vale feat. North Window", "Mira Vale", "North Window"], titles: ["glass harbor", "Pale Signals"] });
});

test("Stable Audio 3's prompt puts instrumental first, then genres, instruments, the sound and the tempo", () => {
  assert.equal(stableAudioPrompt({ descriptors: [
    { term: "dream pop", facet: "genre" }, { term: "post-rock", facet: "genre" }, { term: "rhodes piano", facet: "instrument" },
    { term: "tape saturation", facet: "texture" }, { term: "slow sway", facet: "rhythm" }, { term: "nostalgic", facet: "mood" },
  ], bpm: 92 }), "TrackType: Music, VocalType: Instrumental, Genre: Dream Pop, Genre: Post-Rock, Instruments: Rhodes Piano. Tape saturation, slow sway, nostalgic. 92 BPM.");
  assert.equal(stableAudioPrompt({ descriptors: [{ term: "ambient", facet: "genre" }] }), "TrackType: Music, VocalType: Instrumental, Genre: Ambient.");
});

test("a track Moondog made enters the ledger by its own id and can never claim a play of a real song", async () => {
  const id = "6f1c1b2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
  const entry = suggestionEntry({ service: "moondog", action: "generated.play", providerTrackId: `moondog:generated:${id}`,
    title: "Hushed drive", artistCredit: "", requestedAt: "2026-10-29T06:00:00.000Z" });
  assert.deepEqual(entry, { service: "moondog", action: "generated.play", provider_track_id: `moondog:generated:${id}`, isrc: null,
    track_key: null, release_key: null, title: "Hushed drive", artist_credit: "", requested_at: "2026-10-29T06:00:00.000Z", mix_slot: null });
  assert.deepEqual(suggestionIdentities(entry), [`moondog:generated:${id}`]);
  assert.equal(suggestionEntry({ service: "moondog", action: "generated.play", providerTrackId: "moondog:generated:not-an-id", title: "x", requestedAt: "2026-10-29T06:00:00.000Z" }), null);
  // "Moondog" is also a real composer, so a song of his with the same title stays the listener's own.
  assert.equal(suggestionEntry({ service: "moondog", action: "generated.play", providerTrackId: `moondog:generated:${id}`,
    title: "Hushed drive", artists: ["Moondog"], requestedAt: "2026-10-29T06:00:00.000Z" }).track_key, null);

  const store = await openEphemeralListeningHistoryStore();
  try {
    assert.deepEqual(store.recordMoondogSuggestions({ entries: [{ service: "moondog", action: "generated.play",
      providerTrackId: `moondog:generated:${id}`, title: "Hushed drive", artistCredit: "", requestedAt: "2026-10-29T06:00:00.000Z" }] }), { recorded: 1 });
  } finally {
    store.close();
  }
});
