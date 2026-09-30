import assert from "node:assert/strict";
import test from "node:test";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } from "@earendil-works/pi-ai";
import { MoondogApplication } from "../../src/core/moondog-application.mjs";
import { createSpotifyWebApiClient } from "../../src/integrations/spotify/web-api-client.mjs";
import { createSpotifyService } from "../../src/integrations/spotify/service.mjs";
import { PiAgentRuntime } from "../../src/runtime/pi/agent-runtime.mjs";

const privatePathName = ["", "Users", "Fictional", ""].join("/");
const song = (id, name = "Midnight Lines") => ({ item: { type: "track", id, uri: `spotify:track:${id}`, name,
  artists: [{ name: "Mara Vale" }], album: { name: "Night Transit" }, is_local: false }, is_local: false });
function fixture(t, options = {}) {
  const state = { name: "Night Drive", id: "fictionalplaylist", owner: "fictionaluser", public: false, collaborative: false,
    snapshot: "snapshot-1", items: [song("first"), song("second", "Glass Highway")], listExtra: [], ...options };
  const requests = [], writes = [];
  const metadata = () => ({ id: state.id, uri: `spotify:playlist:${state.id}`, name: state.name, owner: { id: state.owner },
    public: state.public, collaborative: state.collaborative, snapshot_id: state.snapshot, items: { total: state.items.length } });
  const client = createSpotifyWebApiClient({ tokenProvider: async () => "fictional-token", refreshAccessToken: async () => "refreshed-token",
    fetchImpl: async (url, request) => {
      const pathname = new URL(url).pathname;
      requests.push([request.method, pathname]);
      state.onRequest?.(pathname, request);
      if (request.method !== "GET") {
        writes.push({ path: pathname, method: request.method, body: JSON.parse(request.body) });
        if (state.writeHook) return state.writeHook(request);
        if (request.method === "PUT") { state.name = JSON.parse(request.body).name; return new Response(null, { status: 200 }); }
        return new Response(JSON.stringify({ snapshot_id: "snapshot-2" }));
      }
      if (pathname === "/v1/me") return new Response(JSON.stringify({ id: "fictionaluser" }));
      if (pathname === "/v1/me/playlists") {
        const items = [metadata(), ...state.listExtra];
        return new Response(JSON.stringify({ items, total: state.listTotal ?? items.length, offset: 0, limit: 50, next: state.listNext ?? null }));
      }
      if (pathname.endsWith("/items")) return new Response(JSON.stringify({ items: state.items, total: state.items.length, offset: 0, limit: 50 }));
      return new Response(JSON.stringify(metadata()));
    } });
  const application = new MoondogApplication({ importsRoot: "/tmp/moondog-fictional-absent-imports", spotifyConnection: {
    ready: () => true, missingScopes: () => state.missingScopes ?? [], publicStatus: () => ({ provider: "spotify", state: "ready" }), service: createSpotifyService({ client }),
  } });
  t.after(() => application.close());
  const prepare = async (text = 'Rename playlist "Night Drive" to "Late Lights".') => {
    application.beginPrompt({ text });
    const listed = await application.spotifyListEditablePlaylists({ limit: 50 });
    if (!listed.playlists.length) return {};
    const playlistRefId = listed.playlists[0].playlist_ref_id;
    const inspected = await application.spotifyInspectPlaylist({ playlistRefId });
    return { playlistRefId, playlistItemRefId: inspected.items[0]?.playlist_item_ref_id, inspected };
  };
  return { application, state, requests, writes, prepare, client };
}

test("exact quoted rename uses only the host-authorized name and current PUT endpoint", async (t) => {
  const f = fixture(t); const refs = await f.prepare();
  const receipt = await f.application.spotifyQuickEditPlaylist({ action: "rename", playlistRefId: refs.playlistRefId, name: "MODEL_INJECTED_NAME" });
  assert.deepEqual(f.writes, [{ path: "/v1/playlists/fictionalplaylist", method: "PUT", body: { name: "Late Lights" } }]);
  assert.equal(receipt.playlist.name, "Late Lights");
  assert.equal(receipt.action, "playlist.rename");
  await assert.rejects(f.application.spotifyQuickEditPlaylist({ action: "rename", playlistRefId: refs.playlistRefId }), /already attempted/u);
  assert.equal(f.writes.length, 1);
});

for (const text of ['Remove "Midnight Lines" by "Mara Vale" from playlist "Night Drive".', '请从歌单「Night Drive」移除「Midnight Lines」歌手「Mara Vale」']) {
  test(`exact single removal uses one URI and the inspected snapshot: ${text}`, async (t) => {
    const f = fixture(t); const refs = await f.prepare(text);
    const receipt = await f.application.spotifyQuickEditPlaylist({ action: "remove_track", ...refs });
    assert.deepEqual(f.writes, [{ path: "/v1/playlists/fictionalplaylist/items", method: "DELETE", body: { items: [{ uri: "spotify:track:first" }], snapshot_id: "snapshot-1" } }]);
    assert.equal(receipt.playlist.track_count, 1); assert.equal(receipt.track_count, 1);
  });
}

test("single removal may empty a one-track playlist; Chinese rename preserves exact text", async (t) => {
  const f = fixture(t, { items: [song("first")] });
  const refs = await f.prepare('Remove "Midnight Lines" from playlist "Night Drive"');
  assert.equal((await f.application.spotifyQuickEditPlaylist({ action: "remove_track", ...refs })).playlist.track_count, 0);
  f.application.endPrompt();
  const next = await f.prepare('请把歌单「Night Drive」重命名为「夜灯」');
  assert.equal((await f.application.spotifyQuickEditPlaylist({ action: "rename", playlistRefId: next.playlistRefId })).playlist.name, "夜灯");
});

for (const prompt of ['Could we change this playlist?', 'Do not rename playlist "Night Drive" to "Late Lights".',
  'Someone wrote: Rename playlist "Night Drive" to "Late Lights".', 'Rename playlist "Night Drive" to "Late Lights" and remove everything.',
  'Rename playlist "Other" to "Late Lights".', 'Preview Rename playlist "Night Drive" to "Late Lights".']) {
  test(`unambiguous host intent rejects model escalation: ${prompt}`, async (t) => {
    const f = fixture(t); const refs = await f.prepare(prompt);
    await assert.rejects(f.application.spotifyQuickEditPlaylist({ action: "rename", playlistRefId: refs.playlistRefId }), { code: "spotify_quick_edit_requires_preview" });
    assert.equal(f.writes.length, 0);
  });
}

for (const items of [[song("first"), song("first")], [song("first"), song("differentRecording")]]) {
  test("duplicate occurrence or recording needs an exact preview; no same-turn write", async (t) => {
    const f = fixture(t, { items }); const refs = await f.prepare('Remove "Midnight Lines" by "Mara Vale" from playlist "Night Drive"');
    await assert.rejects(f.application.spotifyQuickEditPlaylist({ action: "remove_track", ...refs }), { code: "spotify_quick_edit_requires_preview" });
    const preview = await f.application.spotifyPreviewPlaylistEdit({ playlistRefId: refs.playlistRefId, intent: "Keep the second occurrence", items: [{ playlistItemRefId: refs.inspected.items[1].playlist_item_ref_id }] });
    assert.equal(preview.action, "playlist.edit");
    await assert.rejects(f.application.spotifyApplyPendingPlaylistEdit(), { code: "spotify_playlist_edit_confirmation_required" });
    assert.equal(f.writes.length, 0);
  });
}

for (const mutation of [{ public: true }, { public: null }, { collaborative: true }, { collaborative: null }, { owner: "another-user" }]) {
  test(`quick edit rejects changed privacy or ownership ${JSON.stringify(mutation)}`, async (t) => {
    const f = fixture(t); const refs = await f.prepare(); Object.assign(f.state, mutation);
    await assert.rejects(f.application.spotifyQuickEditPlaylist({ action: "rename", playlistRefId: refs.playlistRefId }), { code: "playlist_not_editable" });
    assert.equal(f.writes.length, 0);
  });
}

for (const mutation of [{ snapshot: "changed" }, { name: "Changed Name" }, { id: "wrongIdentity" }, { items: [song("first")] }]) {
  test(`stable target rejects provider changes ${JSON.stringify(mutation)}`, async (t) => {
    const f = fixture(t); const refs = await f.prepare(); Object.assign(f.state, mutation);
    await assert.rejects(f.application.spotifyQuickEditPlaylist({ action: "rename", playlistRefId: refs.playlistRefId }), { code: "playlist_snapshot_changed" });
    assert.equal(f.writes.length, 0);
  });
}

test("incomplete pages and duplicate names including public targets require preview", async (t) => {
  for (const options of [{ listTotal: -1 }, { listTotal: 1_000_001 }, { listTotal: 99, listNext: "untrusted-next" }, { listExtra: [{ id: "publicTwin", uri: "spotify:playlist:publicTwin", name: "Night Drive", owner: { id: "fictionaluser" }, public: true, collaborative: false, items: { total: 1 } }] }]) {
    const f = fixture(t, options); const refs = await f.prepare();
    await assert.rejects(f.application.spotifyQuickEditPlaylist({ action: "rename", playlistRefId: refs.playlistRefId }), { code: "spotify_quick_edit_requires_preview" });
    assert.equal(f.writes.length, 0);
  }
});

test("wrong item, forged or expired refs and missing write scope cannot authorize edits", async (t) => {
  const f = fixture(t); const refs = await f.prepare('Remove "Midnight Lines" from playlist "Night Drive"');
  await assert.rejects(f.application.spotifyQuickEditPlaylist({ action: "remove_track", playlistRefId: refs.playlistRefId, playlistItemRefId: refs.inspected.items[1].playlist_item_ref_id }));
  await assert.rejects(f.application.spotifyQuickEditPlaylist({ action: "remove_track", playlistRefId: "forged", playlistItemRefId: refs.playlistItemRefId }));
  f.state.missingScopes = ["playlist-modify-private"];
  await assert.rejects(f.application.spotifyQuickEditPlaylist({ action: "remove_track", ...refs }), { code: "spotify_write_scopes_missing" });
  f.state.missingScopes = [];
  f.application.endPrompt(); f.application.beginPrompt({ text: 'Remove "Midnight Lines" from playlist "Night Drive"' });
  await assert.rejects(f.application.spotifyQuickEditPlaylist({ action: "remove_track", ...refs }));
  assert.equal(f.writes.length, 0);
});

for (const status of [401, 429, 500]) {
  test(`quick writes are never replayed on ${status}`, async (t) => {
    for (const action of ["rename", "remove_track"]) {
      const f = fixture(t, { writeHook: async () => new Response(JSON.stringify({ error: { message: "fictional" } }), { status }) });
      const refs = await f.prepare(action === "rename" ? undefined : 'Remove "Midnight Lines" from playlist "Night Drive"');
      await assert.rejects(f.application.spotifyQuickEditPlaylist({ action, playlistRefId: refs.playlistRefId, ...(action === "remove_track" ? { playlistItemRefId: refs.playlistItemRefId } : {}) }));
      assert.equal(f.writes.length, 1);
      await assert.rejects(f.application.spotifyQuickEditPlaylist({ action, playlistRefId: refs.playlistRefId, ...(action === "remove_track" ? { playlistItemRefId: refs.playlistItemRefId } : {}) }));
      assert.equal(f.writes.length, 1);
    }
  });
}

for (const phase of ["preflight", "dispatch"]) test(`cancellation ${phase} preserves write truth`, async (t) => {
  const f = fixture(t); const refs = await f.prepare(); const controller = new AbortController();
  if (phase === "preflight") f.state.onRequest = () => controller.abort();
  else f.state.writeHook = async (request) => { assert.ok(request.signal instanceof AbortSignal); assert.notEqual(request.signal, controller.signal); controller.abort(); return new Response(null, { status: 200 }); };
  const pending = f.application.spotifyQuickEditPlaylist({ action: "rename", playlistRefId: refs.playlistRefId }, { signal: controller.signal });
  if (phase === "preflight") { await assert.rejects(pending); assert.equal(f.writes.length, 0); }
  else { assert.equal((await pending).state, "accepted"); assert.equal(f.writes.length, 1); }
});

for (const kind of ["accepted_abort", "unknown_abort", "malformed_receipt", "private_name_abort"]) test(`runtime keeps authoritative quick-edit receipt after ${kind}`, async (t) => {
  const f = fixture(t); const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
  const runtime = new PiAgentRuntime({ application: f.application, models, model: faux.getModel(), provider: "faux", modelId: "faux-1" });
  f.state.writeHook = async () => {
    if (kind !== "malformed_receipt") runtime.abort();
    if (kind === "unknown_abort") throw new Error("fictional network interrupted after dispatch");
    return kind === "malformed_receipt" ? new Response("{}") : new Response(null, { status: 200 });
  };
  const call = (name, args) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
  const result = (context, name) => JSON.parse(context.messages.filter((m) => m.role === "toolResult" && m.toolName === name).at(-1).content[0].text);
  let ref;
  faux.setResponses([call("moondog_spotify_playlist_read", { action: "list", limit: 50 }), (c) => {
    ref = result(c, "moondog_spotify_playlist_read").playlists[0].playlist_ref_id;
    return call("moondog_spotify_playlist_read", { action: "inspect", playlist_ref_id: ref });
  }, (c) => call("moondog_spotify_playlist_edit_quick", { action: kind === "malformed_receipt" ? "remove_track" : "rename", playlist_ref_id: ref,
    ...(kind === "malformed_receipt" ? { playlist_item_ref_id: result(c, "moondog_spotify_playlist_read").items[0].playlist_item_ref_id } : {}) }),
    fauxAssistantMessage([fauxText("The tool result determines the outcome.")])]);
  const value = await runtime.prompt(kind === "private_name_abort" ? `Rename playlist "Night Drive" to "${privatePathName}"` : kind === "malformed_receipt" ? 'Remove "Midnight Lines" from playlist "Night Drive"' : 'Rename playlist "Night Drive" to "Late Lights"');
  assert.equal(f.writes.length, 1);
  assert.equal(value.spotify_write_receipts[0].state, ["accepted_abort", "private_name_abort"].includes(kind) ? "accepted" : "unknown");
  if (!["accepted_abort", "private_name_abort"].includes(kind)) { assert.match(value.text, /not confirmed/u); assert.equal(value.spotify_write_receipts[0].target_name, "Night Drive"); }
  if (kind === "private_name_abort") { assert.doesNotMatch(value.text, /\/Users\//u); assert.equal(value.spotify_write_receipts[0].playlist.name, "[name withheld]"); }
  assert.equal(f.application.pendingSpotifyPlaylistEdit, null);
});

for (const order of ["preview_first", "quick_first"]) test(`quick and preview edit flows cannot obscure each other: ${order}`, async (t) => {
  const f = fixture(t); const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
  const runtime = new PiAgentRuntime({ application: f.application, models, model: faux.getModel(), provider: "faux", modelId: "faux-1" });
  const call = (name, args) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
  const result = (c) => JSON.parse(c.messages.filter((m) => m.role === "toolResult" && m.toolName === "moondog_spotify_playlist_read").at(-1).content[0].text);
  let ref, items;
  const preview = () => call("moondog_spotify_playlist_edit_preview", { playlist_ref_id: ref, intent: "Remove the first track", items: [{ playlist_item_ref_id: items[1].playlist_item_ref_id }] });
  const quick = () => call("moondog_spotify_playlist_edit_quick", { action: "remove_track", playlist_ref_id: ref, playlist_item_ref_id: items[0].playlist_item_ref_id });
  faux.setResponses([call("moondog_spotify_playlist_read", { action: "list", limit: 50 }), (c) => { ref = result(c).playlists[0].playlist_ref_id;
    return call("moondog_spotify_playlist_read", { action: "inspect", playlist_ref_id: ref }); }, (c) => {
    items = result(c).items; return order === "preview_first" ? preview() : quick();
  }, () => order === "preview_first" ? quick() : preview(), fauxAssistantMessage([fauxText("The recorded receipt determines the outcome.")])]);
  const value = await runtime.prompt('Remove "Midnight Lines" from playlist "Night Drive"');
  assert.equal(f.writes.length, order === "preview_first" ? 0 : 1);
  if (order === "preview_first") assert.match(value.text, /Spotify has not changed/u);
  else { assert.equal(value.spotify_write_receipts[0].state, "accepted"); assert.doesNotMatch(value.text, /has not changed|Explicitly confirm/u); }
});

for (const prompt of ["Rename my playlist Night Drive to Late Lights", "Please rename playlist Night Drive to Late Lights."]) test(`ordinary exact rename needs no quoted-name ceremony: ${prompt}`, async (t) => {
  const f = fixture(t); const refs = await f.prepare(prompt);
  await f.application.spotifyQuickEditPlaylist({ action: "rename", playlistRefId: refs.playlistRefId });
  assert.equal(f.writes[0].body.name, "Late Lights");
});
test("ordinary exact single-track removal is authorized without quotes", async (t) => {
  const f = fixture(t); const refs = await f.prepare("Remove Midnight Lines from my playlist Night Drive");
  await f.application.spotifyQuickEditPlaylist({ action: "remove_track", ...refs });
  assert.equal(f.writes.length, 1);
});
