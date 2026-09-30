import assert from "node:assert/strict";
import test from "node:test";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } from "@earendil-works/pi-ai";
import { MoondogApplication } from "../../src/core/moondog-application.mjs";
import { createSyntheticDomainServices } from "../../src/core/synthetic-domain-services.mjs";
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
    if (init.method !== "GET") { writes.push([init.method, u.pathname, u.searchParams.get("uris")]); state.onWrite?.(); if (state.status === "throw") throw new Error("fictional network error");
      if (u.pathname === "/v1/me/playlists") return Response.json({ ...metadata(), id: "newfictionalplaylist", uri: "spotify:playlist:newfictionalplaylist", name: JSON.parse(init.body).name });
      return u.pathname.endsWith("/items") && state.status === 200 ? Response.json({ snapshot_id: "second" }) : new Response(null, { status: state.status }); }
    if (u.pathname === "/v1/me") return Response.json({ id: "fictionalowner" });
    if (u.pathname === "/v1/me/playlists") return Response.json({ items: [metadata()], total: 1, offset: 0, next: null });
    if (u.pathname.endsWith("/items")) return Response.json({ items: ["First", "Second"].map((name) => ({ item: { type: "track", id: name,
      uri: `spotify:track:${name}`, name, artists: [{ name: "Fictional Artist" }], album: { name: "Fictional Album" }, is_local: false } })), total: 2, offset: 0, limit: 50 });
    return Response.json(metadata());
  } });
  const application = new MoondogApplication({ importsRoot: "/tmp/moondog-fictional-no-imports",
    domainServices: createSyntheticDomainServices({ subjectScope: { subjectId: "trusted-synthetic-subject" } }),
    spotifyConnection: { ready: () => true, missingScopes: () => state.missing,
    resolver: { async resolve(tracks) { return { resolutions: tracks.map((track, index) => ({ track_ref_id: track.track_ref_id, status: "resolved", spotify: { uri: `spotify:track:fictional${index}` } })) }; } },
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


test("a removal preview preserves another accepted write receipt in the same turn", async (t) => {
  const f = fixture(t);
  f.faux.setResponses([use("moondog_spotify_player_control", { action: "pause" }), use("moondog_spotify_playlist_read", { action: "list" }), (input) => {
    const value = JSON.parse(input.messages.findLast((m) => m.role === "toolResult").content[0].text);
    return use("moondog_spotify_playlist_remove", { action: "preview", playlist_ref_id: value.playlists[0].playlist_ref_id });
  }, fauxAssistantMessage([fauxText("Done.")])]);
  const result = await f.runtime.prompt('Pause and remove playlist "Night Drive"');
  assert.match(result.text, /pause request/); assert.match(result.text, /No removal has been sent/);
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0][1], "/v1/me/player/pause");
});

test("ordinary completed unfollow cannot claim global playlist deletion", async (t) => {
  const f = fixture(t); const preview = await f.preview(); f.application.endPrompt();
  f.faux.setResponses([use("moondog_spotify_playlist_remove", { action: "confirm" }), fauxAssistantMessage([fauxText("Globally deleted Night Drive for everyone.")])]);
  const result = await f.runtime.prompt(preview.confirmation);
  assert.match(result.text, /unfollowed/); assert.match(result.text, /not globally deleted/);
  assert.doesNotMatch(result.text, /Globally deleted Night Drive for everyone/); assert.equal(f.writes.length, 1);
});

const removalConfirmation = 'Confirm removal of playlist "Night Drive" from my library';
const lastResult = (input) => JSON.parse(input.messages.findLast((m) => m.role === "toolResult").content[0].text);
function previewResponses(f, order) {
  let ref, item;
  const edit = () => use("moondog_spotify_playlist_edit_preview", { playlist_ref_id: ref,
    intent: "Keep the second track", items: [{ playlist_item_ref_id: item }] });
  const remove = () => use("moondog_spotify_playlist_remove", { action: "preview", playlist_ref_id: ref });
  f.faux.setResponses([use("moondog_spotify_playlist_read", { action: "list" }), (input) => {
    ref = lastResult(input).playlists[0].playlist_ref_id;
    return use("moondog_spotify_playlist_read", { action: "inspect", playlist_ref_id: ref });
  }, (input) => { item = lastResult(input).items[1].playlist_item_ref_id; return order[0] === "edit" ? edit() : remove(); },
  ...order.slice(1).map((kind) => kind === "edit" ? edit : remove), fauxAssistantMessage([fauxText("Here is the preview.")])]);
}

for (const order of [["edit", "remove"], ["remove", "edit"]]) test(`runtime exposes and arms only the first confirmation flow: ${order.join(" then ")}`, async (t) => {
  const f = fixture(t); previewResponses(f, order);
  const result = await f.runtime.prompt("Preview removing the first track and removing the playlist from my library.");
  assert.equal(Boolean(result.spotify_playlist_edit_preview), order[0] === "edit");
  assert.equal(Boolean(result.spotify_removal_preview), order[0] === "remove");
  assert.equal(f.application.pendingSpotifyPlaylistEditStatus().state, order[0] === "edit" ? "available" : "none");
  assert.equal(f.application.spotifyRemovalStatus().state, order[0] === "remove" ? "preview" : "none");
  assert.equal(f.writes.length, 0);
  f.faux.setResponses([use("moondog_spotify_playlist_edit_apply"), fauxAssistantMessage([fauxText("No edit sent.")])]);
  await f.runtime.prompt(removalConfirmation);
  assert.equal(f.writes.length, 0, "the removal phrase must never authorize track replacement");
});

for (const outcome of ["accepted", "accepted_cancel", "unknown_cancel"]) test(`a later removal replaces the edit draft and cannot revive it after ${outcome}`, async (t) => {
  const f = fixture(t); previewResponses(f, ["edit"]); await f.runtime.prompt("Preview keeping the second track.");
  assert.equal(f.application.pendingSpotifyPlaylistEditStatus().confirmable, true);
  previewResponses(f, ["remove"]); const result = await f.runtime.prompt('Remove playlist "Night Drive" from my library.');
  assert.equal(f.application.pendingSpotifyPlaylistEditStatus().state, "none");
  if (outcome.endsWith("cancel")) f.state.onWrite = () => f.runtime.abort();
  if (outcome === "unknown_cancel") f.state.status = "throw";
  f.faux.setResponses([use("moondog_spotify_playlist_remove", { action: "confirm" }), fauxAssistantMessage([fauxText("Done.")])]);
  const receipt = await f.runtime.prompt(result.spotify_removal_preview.confirmation);
  assert.match(receipt.text, outcome === "unknown_cancel" ? /not confirmed/ : /unfollowed/);
  assert.equal(f.application.pendingSpotifyPlaylistEditStatus().state, "none");
  assert.equal(f.application.spotifyRemovalStatus().state, "none");
  assert.deepEqual(f.writes, [["DELETE", "/v1/me/library", "spotify:playlist:fictionalplaylist"]]);
});

test("a later edit replaces removal authority and still applies its own displayed preview", async (t) => {
  const f = fixture(t); previewResponses(f, ["remove"]); await f.runtime.prompt('Remove playlist "Night Drive"');
  previewResponses(f, ["edit"]); const preview = await f.runtime.prompt("Instead, preview keeping only the second track.");
  assert.ok(preview.spotify_playlist_edit_preview); assert.equal(f.application.spotifyRemovalStatus().state, "none");
  f.faux.setResponses([use("moondog_spotify_playlist_remove", { action: "confirm" }), fauxAssistantMessage([fauxText("No removal sent.")])]);
  await f.runtime.prompt(removalConfirmation); assert.equal(f.writes.length, 0);
  f.faux.setResponses([use("moondog_spotify_playlist_edit_apply"), fauxAssistantMessage([fauxText("Done.")])]);
  const result = await f.runtime.prompt("Yes, apply the displayed track edit.");
  assert.match(result.text, /exact confirmed preview/); assert.deepEqual(f.writes, [["PUT", "/v1/playlists/fictionalplaylist/items", null]]);
});

test("cancelling a replacement preview restores only the previously displayed flow", async (t) => {
  const f = fixture(t); previewResponses(f, ["edit"]); await f.runtime.prompt("Preview keeping the second track.");
  await f.preview(); assert.equal(f.application.pendingSpotifyPlaylistEditStatus().state, "none");
  f.application.resetPromptState();
  assert.equal(f.application.pendingSpotifyPlaylistEditStatus().confirmable, true);
  assert.equal(f.application.spotifyRemovalStatus().state, "none"); assert.equal(f.writes.length, 0);
});

const planResponses = () => [use("moondog_library_search", { query: "night", limit: 2 }), (input) => {
  const search = lastResult(input);
  return use("moondog_playlist_plan", { intent: "Two night songs for later.", requested_track_count: 2,
    candidate_set_ids: [search.candidate_set_id], track_refs: search.tracks.map((track) => ({ track_ref_id: track.track_ref_id, selection_reason: "Matches the request." })),
    ordering_notes: "Keep the selected order." });
}];
const removalResponses = () => [use("moondog_spotify_playlist_read", { action: "list" }), (input) =>
  use("moondog_spotify_playlist_remove", { action: "preview", playlist_ref_id: lastResult(input).playlists[0].playlist_ref_id })];
const endResponse = () => fauxAssistantMessage([fauxText("Done.")]);

test("a removal preview replaces a retained new plan and its confirmation cannot create a playlist", async (t) => {
  const f = fixture(t); f.faux.setResponses([...planResponses(), endResponse()]);
  const plan = await f.runtime.prompt("Recommend two night songs. Do not save them."); assert.equal(plan.playlist_plan.track_count, 2);
  f.faux.setResponses([...removalResponses(), endResponse()]); const removal = await f.runtime.prompt('Instead remove playlist "Night Drive".');
  assert.equal(f.application.pendingSpotifyPlaylistStatus().state, "none");
  f.faux.setResponses([use("moondog_spotify_playlist_write", { name: "Unrequested Playlist", pending_plan: true }), endResponse()]);
  await f.runtime.prompt(removal.spotify_removal_preview.confirmation); assert.equal(f.writes.length, 0);
  f.faux.setResponses([use("moondog_spotify_playlist_remove", { action: "confirm" }), endResponse()]);
  const receipt = await f.runtime.prompt(removal.spotify_removal_preview.confirmation);
  assert.match(receipt.text, /unfollowed/); assert.deepEqual(f.writes, [["DELETE", "/v1/me/library", "spotify:playlist:fictionalplaylist"]]);
});

for (const first of ["plan", "remove"]) test(`new-plan and removal previews are exclusive with ${first} first`, async (t) => {
  const f = fixture(t);
  f.faux.setResponses([...(first === "plan" ? [...planResponses(), ...removalResponses()] : [...removalResponses(), ...planResponses()]), endResponse()]);
  const result = await f.runtime.prompt('Recommend two songs and preview removing playlist "Night Drive".');
  assert.equal(Boolean(result.playlist_plan), first === "plan"); assert.equal(Boolean(result.spotify_removal_preview), first === "remove");
  assert.equal(f.application.pendingSpotifyPlaylistStatus().state, first === "plan" ? "available" : "none");
  assert.equal(f.application.spotifyRemovalStatus().state, first === "remove" ? "preview" : "none"); assert.equal(f.writes.length, 0);
});

test("a later new plan replaces removal authority and can be explicitly saved", async (t) => {
  const f = fixture(t); f.faux.setResponses([...removalResponses(), endResponse()]); await f.runtime.prompt('Remove playlist "Night Drive".');
  f.faux.setResponses([...planResponses(), endResponse()]); await f.runtime.prompt("Instead recommend two night songs.");
  assert.equal(f.application.spotifyRemovalStatus().state, "none");
  f.faux.setResponses([use("moondog_spotify_playlist_write", { name: "Requested Night Songs", pending_plan: true }), endResponse()]);
  await f.runtime.prompt('Save the shown plan as "Requested Night Songs".');
  assert.deepEqual(f.writes.map((write) => write.slice(0, 2)), [["POST", "/v1/me/playlists"], ["POST", "/v1/playlists/newfictionalplaylist/items"]]);
});

test("cancelled removal preview restores the prior displayed new plan without removal authority", async (t) => {
  const f = fixture(t); f.faux.setResponses([...planResponses(), endResponse()]); await f.runtime.prompt("Recommend two night songs.");
  await f.preview(); assert.equal(f.application.pendingSpotifyPlaylistStatus().state, "none"); f.application.resetPromptState();
  assert.equal(f.application.pendingSpotifyPlaylistStatus().state, "available"); assert.equal(f.application.spotifyRemovalStatus().state, "none");
  assert.equal(f.writes.length, 0);
});

test("exact removal confirmation cannot authorize any other Spotify write arm", async (t) => {
  const f = fixture(t); await f.preview(); f.application.endPrompt(); f.application.beginPrompt({ text: removalConfirmation });
  const item = { item_ref_id: "fictional-item-ref", type: "track", uri: "spotify:track:First", name: "First", artists: [] };
  f.application.spotifyReadSelections.set("search", [item]);
  const operations = [
    () => f.application.spotifyControl({ action: "pause" }), () => f.application.spotifyTransfer({ deviceId: "fictionaldevice" }),
    () => f.application.spotifyAddToQueue({ itemRefId: item.item_ref_id }), () => f.application.spotifyQueueSimilar(),
    () => f.application.spotifyPlayPendingPlan(), () => f.application.spotifyQueuePendingPlan(),
    () => f.application.spotifyCreatePlaylist({ name: "Wrong", trackRefs: [] }), () => f.application.spotifyCreatePendingPlaylist({ name: "Wrong" }),
    () => f.application.writeSpotifyPlaylist({ name: "Wrong" }, [item.uri]),
    () => f.application.spotifySaveLibraryTracks({ trackRefs: [] }), () => f.application.spotifySaveLibraryItems({ itemRefs: [item.item_ref_id] }),
    () => f.application.buildPlaylistPlan({}),
  ];
  for (const operation of operations) await assert.rejects(async () => operation(), { code: "spotify_confirmation_flow_conflict" });
  assert.equal(f.writes.length, 0);
  assert.equal((await f.application.spotifyRemovePlaylist({ action: "confirm" })).action, "playlist.unfollow");
  assert.equal(f.writes.length, 1);
});
