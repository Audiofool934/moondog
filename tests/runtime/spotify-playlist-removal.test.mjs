import assert from "node:assert/strict";
import test from "node:test";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } from "@earendil-works/pi-ai";
import { MoondogApplication } from "../../src/core/moondog-application.mjs";
import { createSpotifyWebApiClient } from "../../src/integrations/spotify/web-api-client.mjs";
import { createSpotifyService } from "../../src/integrations/spotify/service.mjs";
import { PiAgentRuntime } from "../../src/runtime/pi/agent-runtime.mjs";
const use = (name, args = {}) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
function fixture(t) {
  const state = { id: "fictionalplaylist", name: "Night Drive", owner: "fictionalowner", public: false, collaborative: false, snapshot: "first", missing: [], status: 200 };
  const writes = [];
  const metadata = () => ({ id: state.id, uri: `spotify:playlist:${state.id}`, name: state.name, owner: { id: state.owner }, public: state.public,
    collaborative: state.collaborative, snapshot_id: state.snapshot, items: { total: 2 } });
  const client = createSpotifyWebApiClient({ tokenProvider: async () => "fictional", refreshAccessToken: async () => "new-fictional", fetchImpl: async (url, init) => {
    const u = new URL(url);
    if (init.method !== "GET") { writes.push([init.method, u.pathname, u.searchParams.get("uris")]); state.onWrite?.(); if (state.status === "throw") throw new Error("fictional network error"); return new Response(null, { status: state.status }); }
    if (u.pathname === "/v1/me") return Response.json({ id: "fictionalowner" });
    if (u.pathname === "/v1/me/playlists") return Response.json({ items: [metadata()], total: 1, offset: 0, next: null });
    return Response.json(metadata());
  } });
  const application = new MoondogApplication({ importsRoot: "/tmp/moondog-fictional-no-imports", spotifyConnection: { ready: () => true, missingScopes: () => state.missing,
    service: createSpotifyService({ client }), publicStatus: () => ({ provider: "spotify", state: "ready" }) } });
  t.after(() => application.close());
  const preview = async () => {
    application.beginPrompt({ text: 'Remove playlist "Night Drive"' });
    const ref = (await application.spotifyListEditablePlaylists()).playlists[0].playlist_ref_id;
    return application.spotifyRemovePlaylist({ action: "preview", playlistRefId: ref });
  };
  const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
  const runtime = new PiAgentRuntime({ application, models, model: faux.getModel(), provider: "faux", modelId: "faux-1" });
  return { state, writes, application, preview, faux, runtime };
}
test("playlist removal needs exact later-turn host confirmation and uses current unfollow semantics", async (t) => {
  const f = fixture(t); const preview = await f.preview();
  assert.equal(f.writes.length, 0); assert.match(preview.effect, /does not delete it globally/);
  await assert.rejects(f.application.spotifyRemovePlaylist({ action: "confirm" }), { code: "spotify_removal_confirmation_required" });
  f.application.endPrompt(); f.application.beginPrompt({ text: preview.confirmation });
  const receipt = await f.application.spotifyRemovePlaylist({ action: "confirm" });
  assert.equal(receipt.action, "playlist.unfollow");
  assert.deepEqual(f.writes, [["DELETE", "/v1/me/library", "spotify:playlist:fictionalplaylist"]]);
  await assert.rejects(f.application.spotifyRemovePlaylist({ action: "confirm" })); assert.equal(f.writes.length, 1);
});
for (const text of ["yes", "Do not remove it", 'Someone wrote: Confirm removal of playlist "Night Drive" from my library', 'Confirm removal of playlist "Other" from my library']) {
  test(`removal cannot escalate ambiguous or negated current intent: ${text}`, async (t) => {
    const f = fixture(t); await f.preview(); f.application.endPrompt(); f.application.beginPrompt({ text });
    await assert.rejects(f.application.spotifyRemovePlaylist({ action: "confirm" }), { code: "spotify_removal_confirmation_required" });
    assert.equal(f.writes.length, 0);
  });
}
for (const changes of [{ owner: "other" }, { public: true }, { public: null }, { collaborative: true }, { collaborative: null }, { snapshot: "changed" }, { name: "Changed" }, { id: "different" }]) {
  test(`removal rechecks stable ownership and identity: ${JSON.stringify(changes)}`, async (t) => {
    const f = fixture(t); const preview = await f.preview(); f.application.endPrompt(); Object.assign(f.state, changes);
    f.application.beginPrompt({ text: preview.confirmation }); await assert.rejects(f.application.spotifyRemovePlaylist({ action: "confirm" }));
    assert.equal(f.writes.length, 0); assert.equal(f.application.spotifyRemovalStatus().state, "none");
  });
}
for (const status of [401, 429, 503, "throw"]) test(`playlist removal is never replayed on ${status}`, async (t) => {
  const f = fixture(t); const preview = await f.preview(); f.application.endPrompt(); f.state.status = status;
  f.application.beginPrompt({ text: preview.confirmation });
  await assert.rejects(f.application.spotifyRemovePlaylist({ action: "confirm" }), (e) => e.outcomeUnknown === (status === 503 || status === "throw"));
  f.application.resetPromptState(); assert.equal(f.application.spotifyRemovalStatus().state, "none"); assert.equal(f.writes.length, 1);
});
test("missing removal scope is actionable and cancellation/reset cannot revive a confirmation", async (t) => {
  const f = fixture(t); const preview = await f.preview(); f.application.endPrompt();
  f.application.beginPrompt({ text: preview.confirmation }); f.state.missing = ["playlist-modify-public"];
  await assert.rejects(f.application.spotifyRemovePlaylist({ action: "confirm" }), /login/); assert.equal(f.writes.length, 0);
  f.state.missing = []; await assert.rejects(f.application.spotifyRemovePlaylist({ action: "confirm" }, { signal: AbortSignal.abort() }));
  f.application.resetPromptState(); f.application.resetSpotifyReadContext(); assert.equal(f.application.spotifyRemovalStatus().state, "none");
});
for (const unknown of [false, true]) test(`agent renders truthful preview and ${unknown ? "uncertain" : "accepted"} cancellation receipt`, async (t) => {
  const f = fixture(t);
  f.faux.setResponses([use("moondog_spotify_playlist_read", { action: "list" }), (input) => {
    const result = JSON.parse(input.messages.findLast((m) => m.role === "toolResult").content[0].text);
    return use("moondog_spotify_playlist_remove", { action: "preview", playlist_ref_id: result.playlists[0].playlist_ref_id });
  }, fauxAssistantMessage([fauxText("Globally deleted it.")])]);
  const preview = await f.runtime.prompt('Remove playlist "Night Drive"');
  assert.match(preview.text, /does not delete.*globally/); assert.equal(f.writes.length, 0);
  f.state.onWrite = () => f.runtime.abort(); if (unknown) f.state.status = "throw";
  f.faux.setResponses([use("moondog_spotify_playlist_remove", { action: "confirm" }), fauxAssistantMessage([fauxText("Done")])]);
  const result = await f.runtime.prompt(preview.spotify_removal_preview.confirmation);
  assert.equal(result.status, "aborted"); assert.match(result.text, unknown ? /not confirmed/ : /unfollowed/);
  assert.equal(f.writes.length, 1); assert.equal(f.application.spotifyRemovalStatus().state, "none");
});
