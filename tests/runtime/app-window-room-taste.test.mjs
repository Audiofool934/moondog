import assert from "node:assert/strict";
import test from "node:test";
import { runWindowRoom } from "../../app/window-room.mjs";
import { createListeningProfileDomainServices } from "../../src/core/listening-profile-domain-services.mjs";
import { MoondogApplication } from "../../src/core/moondog-application.mjs";
import { projectSpotifyRecentActivity } from "../../src/integrations/spotify/recent-activity.mjs";
import { openEphemeralListeningHistoryStore } from "../../src/profile/listening-history-store.mjs";

const subjectId = "0b6f8a84-7d0a-5d3e-9a51-3f7f3c2b9e10";
const settle = () => new Promise((resolve) => { setTimeout(resolve, 80); });
const runtime = { publicStatus: () => ({ state: "offline" }), reset() {}, restoreSession() {} };

// Fictional plays as the recent-play sync reads them: one band played often, one song once.
function syncPlays(store) {
  const plays = [];
  for (let day = 1; day <= 12; day += 1) {
    plays.push([`hp${day % 3}`, ["Slow Static", "Pine Light", "Low Tide"][day % 3], ["The Hollow Pines"], `2026-10-${String(day).padStart(2, "0")}T21:00:00.000Z`]);
  }
  plays.push(["mv1", "Paper Boats", ["Mira Lune"], "2026-10-13T22:00:00.000Z"]);
  return store.ingest(projectSpotifyRecentActivity({
    subjectId,
    capturedAt: "2026-10-14T10:00:00.000Z",
    page: { provider: "spotify", items: plays.map(([id, name, artists, playedAt]) => ({
      played_at: playedAt, track: { id, name, artists, album: `${name} Record`, duration_ms: 200_000 }, context_type: "album" })) },
  }));
}

test("the taste page shows the real profile, saves a choice and its undoing, and explains a row", async (t) => {
  const store = await openEphemeralListeningHistoryStore();
  t.after(() => store.close());
  syncPlays(store);
  const application = new MoondogApplication({ importsRoot: "/tmp/fictional-taste-no-imports",
    domainServices: createListeningProfileDomainServices({ listeningHistoryStore: store, subjectId }) });
  const messages = [];
  let listener = null;
  const quit = new AbortController();
  t.after(() => quit.abort());
  runWindowRoom({ application, runtime, modelSettings: { async models() { return { models: [] }; } },
    openConversation: async () => { throw new Error("unused"); } }, {
    port: { on(_type, fn) { listener = fn; }, start() {} }, send: (message) => { messages.push(message); }, quit: quit.signal, focus: new EventTarget(),
  });
  await settle();
  const last = (type) => messages.findLast((message) => message.type === type);
  const ask = async (data) => { listener({ data }); await settle(); };

  await ask({ type: "taste" });
  const page = last("taste");
  assert.equal(page.state, "ready");
  assert.ok(page.overview.some((line) => /13 plays/u.test(line)), page.overview.join(" | "));
  assert.equal(page.canChoose, true);
  const band = page.subjects.find((subject) => subject.kind === "artist" && subject.label === "The Hollow Pines");
  assert.ok(band, page.subjects.map((subject) => subject.label).join(", "));
  assert.equal(band.stance, null);
  // The overview names no terminal command; the page draws the reading itself.
  assert.ok(!page.overview.some((line) => line.includes("/profile")));
  // The record: thirteen plays over thirteen local days, the band on twelve of them, nothing Moondog started.
  assert.equal(page.history.days.reduce((sum, [, plays]) => sum + plays, 0), 13);
  assert.equal(page.history.days.length, 13);
  assert.deepEqual(page.history.artists.map((artist) => [artist.name, artist.plays]), [["The Hollow Pines", 12], ["Mira Lune", 1]]);
  assert.equal(page.history.artists[0].days.length, 12);
  assert.deepEqual(page.history.moondog_days, []);

  await ask({ type: "taste-choice", key: band.key, target: band.target, stance: "like" });
  assert.equal(last("taste-saved").stance, "like");
  const liked = last("taste").subjects.find((subject) => subject.key === band.key);
  assert.deepEqual([liked.stance, liked.chosen], ["like", true]);

  await ask({ type: "taste-choice", key: band.key, target: band.target, stance: "retract" });
  const undone = last("taste").subjects.find((subject) => subject.key === band.key);
  assert.deepEqual([undone.stance, undone.chosen], [null, false]);

  const evidence = last("taste").subjects.find((subject) => subject.evidence.length)?.evidence[0];
  assert.ok(evidence, "a row with evidence");
  await ask({ type: "taste-why", key: "row", evidenceId: evidence.id });
  const why = last("taste-why");
  assert.equal(why.evidenceId, evidence.id);
  assert.ok(why.basis && why.limit, JSON.stringify(why));

  await ask({ type: "taste-report" });
  assert.match(last("local").markdown, /Hollow Pines/u);
  assert.equal(messages.filter((message) => message.type === "notice").length, 0, JSON.stringify(messages.filter((message) => message.type === "notice")));
});
