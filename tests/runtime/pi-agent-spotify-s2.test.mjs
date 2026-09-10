import assert from "node:assert/strict";
import test from "node:test";

import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";

import { listAgentCapabilityDescriptors } from "../../src/core/capability-catalog.mjs";
import { MoondogApplication } from "../../src/core/moondog-application.mjs";
import {
  createSyntheticDomainServices,
} from "../../src/core/synthetic-domain-services.mjs";
import { createSpotifyCatalogResolver } from "../../src/integrations/spotify/catalog-resolver.mjs";
import { PiAgentRuntime } from "../../src/runtime/pi/agent-runtime.mjs";

const fixtureTracks = {
  midnightLines: {
    track_ref_id: "10000000-0000-4000-8000-000000000001",
    title: "Midnight Lines",
    artist_credit: "Mara Vale",
    release: "Night Transit",
    duration_ms: 278_000,
  },
  glassHighway: {
    track_ref_id: "10000000-0000-4000-8000-000000000002",
    title: "Glass Highway",
    artist_credit: "North Window",
    release: "Slow Roads",
    duration_ms: 251_000,
  },
  blueExit: {
    track_ref_id: "10000000-0000-4000-8000-000000000003",
    title: "Blue Exit",
    artist_credit: "Kestrel Frame",
    release: "After Hours",
    duration_ms: 234_000,
  },
  distantHeadlights: {
    track_ref_id: "10000000-0000-4000-8000-000000000004",
    title: "Distant Headlights",
    artist_credit: "Mara Vale",
    release: "Unlit Maps",
    duration_ms: 305_000,
  },
};

function fakeSpotifyCatalogClient() {
  const catalog = [
    {
      uri: "spotify:track:midnight-lines",
      id: "midnight-lines",
      name: "Midnight Lines",
      artists: ["Mara Vale"],
      album: "Night Transit",
      duration_ms: 278_000,
      popularity: 55,
    },
    {
      uri: "spotify:track:glass-highway",
      id: "glass-highway",
      name: "Glass Highway",
      artists: ["North Window"],
      album: "Slow Roads",
      duration_ms: 251_000,
      popularity: 48,
    },
    {
      uri: "spotify:track:blue-exit",
      id: "blue-exit",
      name: "Blue Exit",
      artists: ["Kestrel Frame"],
      album: "After Hours",
      duration_ms: 234_000,
      popularity: 42,
    },
    {
      uri: "spotify:track:distant-headlights",
      id: "distant-headlights",
      name: "Distant Headlights",
      artists: ["Mara Vale"],
      album: "Unlit Maps",
      duration_ms: 305_000,
      popularity: 39,
    },
    {
      uri: "spotify:track:unrelated",
      id: "unrelated",
      name: "Unrelated Song",
      artists: ["Someone Else"],
      album: "Other",
      duration_ms: 180_000,
      popularity: 90,
    },
  ];
  return {
    async searchTracks({ query }) {
      const fielded = query.match(/track:"([^"]+)"/u);
      const needle = (fielded ? fielded[1] : query).toLocaleLowerCase("und");
      return {
        provider: "spotify",
        items: catalog.filter((item) =>
          item.name.toLocaleLowerCase("und").includes(needle),
        ),
      };
    },
  };
}

function fakeSpotifyService() {
  const calls = [];
  return {
    calls,
    async editablePlaylists(input) {
      calls.push(["playlist.list", input]);
      return {
        provider: "spotify",
        playlists: [
          {
            playlist_id: "existing-playlist-1",
            name: "Existing Night Drive",
            track_count: 2,
          },
        ],
        excluded: {
          public: 0,
          not_owned: 0,
          collaborative: 0,
          over_track_limit: 0,
          invalid: 0,
        },
        has_more: false,
        next_offset: null,
      };
    },
    async playlistSnapshot(input) {
      calls.push(["playlist.inspect", input]);
      return {
        provider: "spotify",
        playlist: {
          playlist_id: "existing-playlist-1",
          name: "Existing Night Drive",
          track_count: 2,
          snapshot_id: "snapshot-existing-1",
        },
        items: [
          {
            uri: "spotify:track:midnight-lines",
            title: "Midnight Lines",
            artists: ["Mara Vale"],
            album: "Night Transit",
            duration_ms: 278_000,
          },
          {
            uri: "spotify:track:glass-highway",
            title: "Glass Highway",
            artists: ["North Window"],
            album: "Slow Roads",
            duration_ms: 251_000,
          },
        ],
      };
    },
    async replacePlaylistItems(input) {
      calls.push(["playlist.edit", input]);
      return {
        provider: "spotify",
        ok: true,
        effect: "write_external",
        action: "playlist.edit",
        state: "accepted",
        playlist: {
          name: "Existing Night Drive",
          track_count: input.uris.length,
          is_public: false,
        },
        previous_track_count: 2,
      };
    },
    async createPlaylistWithTracks(input) {
      calls.push(["playlist.write", input]);
      return {
        provider: "spotify",
        ok: true,
        effect: "write_external",
        action: "playlist.write",
        state: "accepted",
        playlist: {
          name: input.name,
          track_count: input.uris.length,
          is_public: false,
        },
        playlist_uri: "spotify:playlist:fake-playlist",
        playlist_id: "fake-playlist",
      };
    },
    async saveTracks(input) {
      calls.push(["library.save", input]);
      return {
        provider: "spotify",
        ok: true,
        effect: "write_external",
        action: "library.save",
        state: "accepted",
        track_count: input.uris.length,
      };
    },
    async checkSavedTracks(input) {
      calls.push(["library.check", input]);
      return {
        provider: "spotify",
        checked: input.uris.map((uri, index) => ({ uri, saved: index === 0 })),
      };
    },
    async addToQueue(input) {
      calls.push(["queue.add", input]);
      return {
        provider: "spotify",
        ok: true,
        effect: "write_external",
        action: "playback.queue.add",
        state: "accepted",
      };
    },
    async resume(input) {
      calls.push(["resume", input]);
      return {
        provider: "spotify",
        ok: true,
        effect: "write_external",
        action: "playback.resume",
        state: "accepted",
      };
    },
    async currentPlayer() {
      return { provider: "spotify", state: "inactive" };
    },
  };
}

function spotifyApplication({ missingScopes = [] } = {}) {
  const service = fakeSpotifyService();
  return {
    application: new MoondogApplication({
      importsRoot: "/private/moondog-synthetic-missing-source",
      domainServices: createSyntheticDomainServices({
        subjectScope: { subjectId: "trusted-synthetic-subject" },
      }),
      spotifyConnection: {
        ready: () => true,
        publicStatus: () => ({
          provider: "spotify",
          state: "ready",
          external_effects: "spotify_control",
          scopes: { granted: [], missing: missingScopes, sufficient: missingScopes.length === 0 },
        }),
        missingScopes: () => [...missingScopes],
        service,
        resolver: createSpotifyCatalogResolver({
          client: fakeSpotifyCatalogClient(),
        }),
      },
    }),
    service,
  };
}

function configuredRuntime(application, faux = fauxProvider()) {
  const models = createModels();
  models.setProvider(faux.provider);
  return {
    faux,
    runtime: new PiAgentRuntime({
      application,
      models,
      model: faux.getModel(),
      provider: "faux",
      modelId: "faux-1",
    }),
  };
}

function toolResults(context, toolName) {
  return context.messages
    .filter(
      (message) =>
        message.role === "toolResult" && message.toolName === toolName,
    )
    .map((message) => JSON.parse(message.content[0].text));
}

function trustedProductContext(context) {
  const message = context.messages.find(
    (entry) =>
      entry.role === "user" &&
      entry.content?.[0]?.type === "text" &&
      entry.content[0].text.startsWith("[Trusted Moondog product context]\n"),
  );
  assert.ok(message, "trusted product context should be present");
  return JSON.parse(message.content[0].text.split("\n")[1]);
}

test("S2 Spotify catalog capabilities register only with Spotify and domain services", () => {
  const ready = listAgentCapabilityDescriptors({
    domainServicesReady: true,
    spotifyReady: true,
  });
  for (const toolName of [
    "moondog_spotify_resolve_tracks",
    "moondog_spotify_library_check",
    "moondog_spotify_library_save",
    "moondog_spotify_playlist_write",
    "moondog_spotify_playlist_read",
    "moondog_spotify_playlist_edit_preview",
    "moondog_spotify_playlist_edit_apply",
  ]) {
    assert.equal(
      ready.some((descriptor) => descriptor.tool_name === toolName),
      true,
      `${toolName} should be registered`,
    );
  }

  const noSpotify = listAgentCapabilityDescriptors({
    domainServicesReady: true,
    spotifyReady: false,
  });
  assert.equal(
    noSpotify.some(
      (descriptor) => descriptor.tool_name === "moondog_spotify_playlist_write",
    ),
    false,
  );

  const spotifyOnly = listAgentCapabilityDescriptors({
    domainServicesReady: false,
    spotifyReady: true,
  });
  for (const toolName of [
    "moondog_spotify_playlist_read",
    "moondog_spotify_playlist_edit_preview",
    "moondog_spotify_playlist_edit_apply",
  ]) {
    assert.equal(
      spotifyOnly.some((descriptor) => descriptor.tool_name === toolName),
      true,
      `${toolName} should support existing-item-only edits without local domain services`,
    );
  }

  const noDomain = listAgentCapabilityDescriptors({
    domainServicesReady: false,
    spotifyReady: true,
  });
  assert.equal(
    noDomain.some(
      (descriptor) => descriptor.tool_name === "moondog_spotify_resolve_tracks",
    ),
    false,
  );
});

test("agent previews an exact existing-playlist edit and applies it only after next-turn confirmation", async () => {
  const { application, service } = spotifyApplication();
  const { faux, runtime } = configuredRuntime(application);
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("moondog_spotify_playlist_read", {
          action: "list",
          limit: 20,
        }),
      ],
      { stopReason: "toolUse" },
    ),
    (context) => {
      const [list] = toolResults(context, "moondog_spotify_playlist_read");
      assert.equal(list.state, "list");
      assert.equal(list.playlists[0].name, "Existing Night Drive");
      assert.doesNotMatch(
        JSON.stringify(list),
        /existing-playlist-1|spotify:|snapshot-existing/iu,
      );
      return fauxAssistantMessage(
        [
          fauxToolCall("moondog_spotify_playlist_read", {
            action: "inspect",
            playlist_ref_id: list.playlists[0].playlist_ref_id,
          }),
        ],
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      const reads = toolResults(context, "moondog_spotify_playlist_read");
      const inspection = reads[1];
      assert.equal(inspection.state, "inspection");
      assert.deepEqual(
        inspection.items.map((item) => item.title),
        ["Midnight Lines", "Glass Highway"],
      );
      assert.doesNotMatch(
        JSON.stringify(inspection),
        /existing-playlist-1|spotify:|snapshot-existing/iu,
      );
      return fauxAssistantMessage(
        [fauxToolCall("moondog_library_search", { query: "Blue Exit", limit: 1 })],
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      const [search] = toolResults(context, "moondog_library_search");
      return fauxAssistantMessage(
        [
          fauxToolCall("moondog_spotify_resolve_tracks", {
            track_refs: [
              { track_ref_id: search.tracks[0].track_ref_id },
            ],
          }),
        ],
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      const [list, inspection] = toolResults(
        context,
        "moondog_spotify_playlist_read",
      );
      const [search] = toolResults(context, "moondog_library_search");
      return fauxAssistantMessage(
        [
          fauxToolCall("moondog_spotify_playlist_edit_preview", {
            playlist_ref_id: list.playlists[0].playlist_ref_id,
            intent: "Keep the opener and replace only the second track.",
            items: [
              {
                playlist_item_ref_id:
                  inspection.items[0].playlist_item_ref_id,
              },
              { track_ref_id: search.tracks[0].track_ref_id },
            ],
          }),
        ],
        { stopReason: "toolUse" },
      );
    },
    fauxAssistantMessage([
      fauxText("I already changed Spotify and used a different order."),
    ]),
  ]);

  const previewed = await runtime.prompt(
    "把 Existing Night Drive 的第二首换成 Blue Exit，先给我看清楚再改。",
  );

  assert.equal(previewed.status, "completed");
  assert.equal(previewed.spotify_playlist_edit_preview.state, "preview");
  assert.deepEqual(
    previewed.spotify_playlist_edit_preview.items.map((item) => [
      item.status,
      item.title,
    ]),
    [
      ["retained", "Midnight Lines"],
      ["added", "Blue Exit"],
    ],
  );
  assert.deepEqual(
    previewed.spotify_playlist_edit_preview.removed_items.map(
      (item) => item.title,
    ),
    ["Glass Highway"],
  );
  assert.match(previewed.text, /Spotify 尚未发生变化/u);
  assert.doesNotMatch(previewed.text, /already changed|different order/iu);
  assert.equal(application.pendingSpotifyPlaylistEditStatus().confirmable, true);
  assert.deepEqual(
    service.calls.filter(([action]) => action === "playlist.edit"),
    [],
  );

  faux.setResponses([
    (context) => {
      const product = trustedProductContext(context);
      assert.equal(product.pending_spotify_playlist_edit.state, "available");
      assert.equal(product.pending_spotify_playlist_edit.confirmable, true);
      assert.equal(
        product.pending_spotify_playlist_edit.exact_draft_retained_by_host,
        true,
      );
      assert.doesNotMatch(
        JSON.stringify(product.pending_spotify_playlist_edit),
        /existing-playlist-1|spotify:|snapshot-existing/iu,
      );
      return fauxAssistantMessage(
        [fauxToolCall("moondog_spotify_playlist_edit_apply", {})],
        { stopReason: "toolUse" },
      );
    },
    fauxAssistantMessage([fauxText("I saved a reconstructed version.")]),
  ]);

  const applied = await runtime.prompt("可以，就按刚才预览的精确版本改。 ");

  assert.equal(applied.spotify_playlist_edit_write.action, "playlist.edit");
  assert.match(applied.text, /已按确认过的精确预览更新/u);
  assert.doesNotMatch(applied.text, /reconstructed/iu);
  assert.equal(application.pendingSpotifyPlaylistEditStatus().state, "none");
  assert.deepEqual(
    service.calls.filter(([action]) => action === "playlist.edit"),
    [
      [
        "playlist.edit",
        {
          playlistId: "existing-playlist-1",
          expectedSnapshotId: "snapshot-existing-1",
          uris: [
            "spotify:track:midnight-lines",
            "spotify:track:blue-exit",
          ],
        },
      ],
    ],
  );
});

test("existing-playlist edit blocks same-turn apply and invalidates a stale draft", async () => {
  const { application, service } = spotifyApplication();
  application.beginPrompt();
  const listed = await application.spotifyListEditablePlaylists({ limit: 20 });
  const playlistRefId = listed.playlists[0].playlist_ref_id;
  const inspected = await application.spotifyInspectPlaylist({ playlistRefId });
  await application.spotifyPreviewPlaylistEdit({
    playlistRefId,
    intent: "Reverse the two existing tracks.",
    items: [...inspected.items].reverse().map((item) => ({
      playlistItemRefId: item.playlist_item_ref_id,
    })),
  });

  await assert.rejects(application.spotifyApplyPendingPlaylistEdit(), {
    code: "spotify_playlist_edit_confirmation_required",
  });
  assert.deepEqual(
    service.calls.filter(([action]) => action === "playlist.edit"),
    [],
  );
  application.endPrompt();
  assert.equal(application.pendingSpotifyPlaylistEditStatus().confirmable, true);

  service.replacePlaylistItems = async (input) => {
    service.calls.push(["playlist.edit.preflight", input]);
    const error = new Error("The Spotify playlist changed after preview.");
    error.code = "playlist_snapshot_changed";
    throw error;
  };
  application.beginPrompt();
  await assert.rejects(application.spotifyApplyPendingPlaylistEdit(), {
    code: "playlist_snapshot_changed",
  });
  application.endPrompt();

  assert.equal(application.pendingSpotifyPlaylistEditStatus().state, "none");
  assert.equal(
    service.calls.filter(([action]) => action === "playlist.edit.preflight")
      .length,
    1,
  );
});

test("aborted existing-playlist preview restores the prior host-owned exact draft", async () => {
  const { application, service } = spotifyApplication();
  application.beginPrompt();
  const firstList = await application.spotifyListEditablePlaylists({ limit: 20 });
  const firstPlaylistRefId = firstList.playlists[0].playlist_ref_id;
  const firstInspection = await application.spotifyInspectPlaylist({
    playlistRefId: firstPlaylistRefId,
  });
  await application.spotifyPreviewPlaylistEdit({
    playlistRefId: firstPlaylistRefId,
    intent: "Reverse the two tracks.",
    items: [...firstInspection.items].reverse().map((item) => ({
      playlistItemRefId: item.playlist_item_ref_id,
    })),
  });
  application.endPrompt();

  application.beginPrompt();
  const replacementList = await application.spotifyListEditablePlaylists({
    limit: 20,
  });
  const replacementPlaylistRefId =
    replacementList.playlists[0].playlist_ref_id;
  const replacementInspection = await application.spotifyInspectPlaylist({
    playlistRefId: replacementPlaylistRefId,
  });
  await application.spotifyPreviewPlaylistEdit({
    playlistRefId: replacementPlaylistRefId,
    intent: "Remove the second track instead.",
    items: [
      {
        playlistItemRefId:
          replacementInspection.items[0].playlist_item_ref_id,
      },
    ],
  });
  application.rollbackPendingPlaylistPrompt();
  application.endPrompt();

  assert.equal(application.pendingSpotifyPlaylistEditStatus().confirmable, true);
  application.beginPrompt();
  await application.spotifyApplyPendingPlaylistEdit();
  application.endPrompt();

  assert.deepEqual(
    service.calls.filter(([action]) => action === "playlist.edit"),
    [
      [
        "playlist.edit",
        {
          playlistId: "existing-playlist-1",
          expectedSnapshotId: "snapshot-existing-1",
          uris: [
            "spotify:track:glass-highway",
            "spotify:track:midnight-lines",
          ],
        },
      ],
    ],
  );
});

test("agent resolves, plans, and writes a private Spotify playlist in one prompt", async () => {
  const { application, service } = spotifyApplication();
  const { faux, runtime } = configuredRuntime(application);
  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("moondog_library_search", { query: "night", limit: 2 })],
      { stopReason: "toolUse" },
    ),
    (context) => {
      const [search] = toolResults(context, "moondog_library_search");
      return fauxAssistantMessage(
        [
          fauxToolCall("moondog_spotify_resolve_tracks", {
            track_refs: search.tracks.map((track) => ({
              track_ref_id: track.track_ref_id,
            })),
          }),
        ],
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      const [resolution] = toolResults(
        context,
        "moondog_spotify_resolve_tracks",
      );
      assert.equal(resolution.resolved_count, 2);
      assert.equal(resolution.not_found_count, 0);
      assert.equal(
        JSON.stringify(resolution).includes("spotify:"),
        false,
        "resolution results must not expose Spotify URIs",
      );
      assert.equal(
        resolution.resolutions[0].matched.title,
        "Midnight Lines",
      );
      const [search] = toolResults(context, "moondog_library_search");
      return fauxAssistantMessage(
        [
          fauxToolCall("moondog_playlist_plan", {
            intent: "Two night-drive tracks from the library.",
            requested_track_count: 2,
            candidate_set_ids: [search.candidate_set_id],
            track_refs: search.tracks.map((track) => ({
              track_ref_id: track.track_ref_id,
              selection_reason: "Matches the requested night-drive intent.",
            })),
            ordering_notes: "Familiar opener into a smoother exit.",
          }),
        ],
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      const [search] = toolResults(context, "moondog_library_search");
      return fauxAssistantMessage(
        [
          fauxToolCall("moondog_spotify_playlist_write", {
            name: "Night Drive",
            track_refs: search.tracks.map((track) => ({
              track_ref_id: track.track_ref_id,
            })),
          }),
        ],
        { stopReason: "toolUse" },
      );
    },
    fauxAssistantMessage([fauxText("Saved the playlist to Spotify.")]),
  ]);

  const result = await runtime.prompt(
    "Find two night-drive tracks and save them to a Spotify playlist called Night Drive.",
  );

  assert.equal(result.status, "completed");
  assert.equal(result.playlist_plan.track_count, 2);
  assert.equal(result.spotify_playlist_write.playlist.name, "Night Drive");
  assert.match(result.text, /2-track plan from your library/u);
  assert.match(
    result.text,
    /Saved as the private Spotify playlist "Night Drive" \(2 tracks\)/u,
  );
  assert.equal(
    result.text.includes("Saved the playlist to Spotify."),
    false,
    "the authoritative renderer must replace model narration of the plan",
  );
  assert.deepEqual(service.calls, [
    [
      "playlist.write",
      {
        name: "Night Drive",
        uris: [
          "spotify:track:midnight-lines",
          "spotify:track:glass-highway",
        ],
      },
    ],
  ]);
});

test("agent saves the exact pending plan after a bare next-turn approval", async () => {
  const { application, service } = spotifyApplication();
  const { faux, runtime } = configuredRuntime(application);
  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("moondog_library_search", { query: "night", limit: 2 })],
      { stopReason: "toolUse" },
    ),
    (context) => {
      const [search] = toolResults(context, "moondog_library_search");
      return fauxAssistantMessage(
        [
          fauxToolCall("moondog_playlist_plan", {
            intent: "Two night tracks for later approval.",
            requested_track_count: 2,
            candidate_set_ids: [search.candidate_set_id],
            track_refs: search.tracks.map((track) => ({
              track_ref_id: track.track_ref_id,
              selection_reason: "Matches the requested night intent.",
            })),
            ordering_notes: "Familiar opener into a smoother exit.",
          }),
        ],
        { stopReason: "toolUse" },
      );
    },
    fauxAssistantMessage([fauxText("Here is the plan for your approval.")]),
  ]);

  const proposed = await runtime.prompt(
    "先推荐两首夜间歌曲，只做方案，不要创建歌单。",
  );

  assert.equal(proposed.playlist_plan.track_count, 2);
  assert.match(proposed.text, /没有外部副作用/u);
  assert.equal(application.pendingSpotifyPlaylistStatus().state, "available");
  assert.deepEqual(service.calls, []);

  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("moondog_spotify_playlist_write", {
          name: "Night Approval",
          pending_plan: true,
        }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxText("Done with a different playlist.")]),
  ]);

  const saved = await runtime.prompt("可以，就这个，保存它。 ");

  assert.equal(saved.spotify_playlist_write.playlist.name, "Night Approval");
  assert.deepEqual(
    saved.playlist_plan.tracks.map((track) => track.title),
    proposed.playlist_plan.tracks.map((track) => track.title),
  );
  assert.match(saved.text, /已保存为 Spotify 私有歌单/u);
  assert.doesNotMatch(saved.text, /different playlist/u);
  assert.equal(application.pendingSpotifyPlaylistStatus().state, "none");
  assert.deepEqual(service.calls, [
    [
      "playlist.write",
      {
        name: "Night Approval",
        uris: [
          "spotify:track:midnight-lines",
          "spotify:track:glass-highway",
        ],
      },
    ],
  ]);
});

test("agent revises a validated pending plan before exact later approval", async () => {
  const { application, service } = spotifyApplication();
  const { faux, runtime } = configuredRuntime(application);
  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("moondog_library_search", { query: "night", limit: 2 })],
      { stopReason: "toolUse" },
    ),
    (context) => {
      const [search] = toolResults(context, "moondog_library_search");
      return fauxAssistantMessage(
        [
          fauxToolCall("moondog_playlist_plan", {
            intent: "Two night tracks for later revision.",
            requested_track_count: 2,
            candidate_set_ids: [search.candidate_set_id],
            track_refs: search.tracks.map((track) => ({
              track_ref_id: track.track_ref_id,
              selection_reason: "Matches the requested night intent.",
            })),
            ordering_notes: "Familiar opener into a smoother exit.",
          }),
        ],
        { stopReason: "toolUse" },
      );
    },
    fauxAssistantMessage([fauxText("Here is the first draft.")]),
  ]);

  const proposed = await runtime.prompt(
    "先推荐两首夜间歌曲，只做方案，稍后我可能会修改。",
  );
  assert.deepEqual(
    proposed.playlist_plan.tracks.map((track) => track.title),
    ["Midnight Lines", "Glass Highway"],
  );
  assert.deepEqual(service.calls, []);

  faux.setResponses([
    (context) => {
      const product = trustedProductContext(context);
      const revision = product.pending_spotify_playlist.revision;
      assert.equal(revision.state, "ready");
      assert.equal(revision.requires_playlist_plan_validation, true);
      assert.deepEqual(
        revision.tracks.map((track) => track.title),
        ["Midnight Lines", "Glass Highway"],
      );
      return fauxAssistantMessage(
        [fauxToolCall("moondog_library_search", { query: "Blue Exit", limit: 1 })],
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      const product = trustedProductContext(context);
      const revision = product.pending_spotify_playlist.revision;
      const [replacement] = toolResults(context, "moondog_library_search");
      return fauxAssistantMessage(
        [
          fauxToolCall("moondog_playlist_plan", {
            intent: "Two night tracks after replacing the second track.",
            requested_track_count: 2,
            candidate_set_ids: [
              revision.candidate_set_id,
              replacement.candidate_set_id,
            ],
            track_refs: [
              {
                track_ref_id: revision.tracks[0].track_ref_id,
                selection_reason: revision.tracks[0].selection_reason,
              },
              {
                track_ref_id: replacement.tracks[0].track_ref_id,
                selection_reason: "The listener explicitly requested this replacement.",
              },
            ],
            ordering_notes: "Keep the opener and replace only the second position.",
          }),
        ],
        { stopReason: "toolUse" },
      );
    },
    fauxAssistantMessage([fauxText("I changed several other tracks too.")]),
  ]);

  const revised = await runtime.prompt("保留第一首，把第二首换成 Blue Exit，先别保存。 ");

  assert.deepEqual(
    revised.playlist_plan.tracks.map((track) => track.title),
    ["Midnight Lines", "Blue Exit"],
  );
  assert.match(revised.text, /尚未写入 Spotify/u);
  assert.doesNotMatch(revised.text, /several other tracks/u);
  assert.deepEqual(service.calls, []);
  assert.equal(application.pendingSpotifyPlaylistStatus().state, "available");

  faux.setResponses([
    (context) => {
      const product = trustedProductContext(context);
      const revision = product.pending_spotify_playlist.revision;
      assert.equal(revision.state, "ready");
      assert.deepEqual(
        revision.tracks.map((track) => track.title),
        ["Midnight Lines", "Blue Exit"],
      );
      return fauxAssistantMessage(
        [
          fauxToolCall("moondog_library_search", {
            query: "Distant Headlights",
            limit: 1,
          }),
        ],
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      const product = trustedProductContext(context);
      const revision = product.pending_spotify_playlist.revision;
      const [addition] = toolResults(context, "moondog_library_search");
      return fauxAssistantMessage(
        [
          fauxToolCall("moondog_playlist_plan", {
            intent: "Three night tracks after adding one requested track.",
            requested_track_count: 3,
            candidate_set_ids: [
              revision.candidate_set_id,
              addition.candidate_set_id,
            ],
            track_refs: [
              ...revision.tracks.map((track) => ({
                track_ref_id: track.track_ref_id,
                selection_reason: track.selection_reason,
              })),
              {
                track_ref_id: addition.tracks[0].track_ref_id,
                selection_reason: "The listener explicitly added this closer.",
              },
            ],
            ordering_notes: "Preserve the revised pair and append the requested closer.",
          }),
        ],
        { stopReason: "toolUse" },
      );
    },
    fauxAssistantMessage([fauxText("Added it without saving.")]),
  ]);

  const expanded = await runtime.prompt(
    "再加一首 Distant Headlights 放在最后，仍然先别保存。",
  );

  assert.deepEqual(
    expanded.playlist_plan.tracks.map((track) => track.title),
    ["Midnight Lines", "Blue Exit", "Distant Headlights"],
  );
  assert.deepEqual(service.calls, []);

  faux.setResponses([
    (context) => {
      const product = trustedProductContext(context);
      const revision = product.pending_spotify_playlist.revision;
      return fauxAssistantMessage(
        [
          fauxToolCall("moondog_playlist_plan", {
            intent: "Reverse 3 tracks from the pending plan.",
            requested_track_count: 3,
            candidate_set_ids: [revision.candidate_set_id],
            track_refs: [...revision.tracks].reverse().map((track) => ({
              track_ref_id: track.track_ref_id,
              selection_reason: "This aborted revision must not replace the draft.",
            })),
            ordering_notes: "This reversed draft will be aborted.",
          }),
        ],
        { stopReason: "toolUse" },
      );
    },
  ]);

  const aborted = await runtime.prompt("试着倒序，但我会立刻取消。", {
    onToolEnd(tool) {
      if (tool.toolName === "moondog_playlist_plan" && !tool.isError) {
        runtime.abort();
      }
    },
  });

  assert.equal(aborted.status, "aborted");
  assert.deepEqual(
    application
      .pendingSpotifyPlaylistPlan()
      .tracks.map((track) => track.title),
    ["Midnight Lines", "Blue Exit", "Distant Headlights"],
  );
  assert.deepEqual(service.calls, []);

  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("moondog_spotify_playlist_write", {
          name: "Revised Night",
          pending_plan: true,
        }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxText("Saved the earlier draft instead.")]),
  ]);

  const saved = await runtime.prompt("可以，就按修改后的版本保存。 ");

  assert.deepEqual(
    saved.playlist_plan.tracks.map((track) => track.title),
    ["Midnight Lines", "Blue Exit", "Distant Headlights"],
  );
  assert.deepEqual(service.calls, [
    [
      "playlist.write",
      {
        name: "Revised Night",
        uris: [
          "spotify:track:midnight-lines",
          "spotify:track:blue-exit",
          "spotify:track:distant-headlights",
        ],
      },
    ],
  ]);
  assert.doesNotMatch(saved.text, /earlier draft/u);
  assert.equal(application.pendingSpotifyPlaylistStatus().state, "none");
});

test("agent reports an empty playlist when adding its tracks fails", async () => {
  const { application, service } = spotifyApplication();
  service.createPlaylistWithTracks = async (input) => {
    service.calls.push(["playlist.write", input]);
    const error = new Error(
      "Spotify created the private playlist but did not accept its tracks.",
    );
    error.code = "playlist_created_without_tracks";
    throw error;
  };
  const { faux, runtime } = configuredRuntime(application);
  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("moondog_library_search", { query: "night", limit: 1 })],
      { stopReason: "toolUse" },
    ),
    (context) => {
      const [search] = toolResults(context, "moondog_library_search");
      return fauxAssistantMessage(
        [
          fauxToolCall("moondog_spotify_resolve_tracks", {
            track_refs: search.tracks.map((track) => ({
              track_ref_id: track.track_ref_id,
            })),
          }),
        ],
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      const [search] = toolResults(context, "moondog_library_search");
      return fauxAssistantMessage(
        [
          fauxToolCall("moondog_playlist_plan", {
            intent: "Save one night track.",
            requested_track_count: 1,
            candidate_set_ids: [search.candidate_set_id],
            track_refs: search.tracks.map((track) => ({
              track_ref_id: track.track_ref_id,
              selection_reason: "Matches the requested night intent.",
            })),
            ordering_notes: "One selected track.",
          }),
        ],
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      const [search] = toolResults(context, "moondog_library_search");
      return fauxAssistantMessage(
        [
          fauxToolCall("moondog_spotify_playlist_write", {
            name: "Partial Night",
            track_refs: search.tracks.map((track) => ({
              track_ref_id: track.track_ref_id,
            })),
          }),
        ],
        { stopReason: "toolUse" },
      );
    },
    fauxAssistantMessage([
      fauxText("The playlist was not created and nothing changed."),
    ]),
  ]);

  const result = await runtime.prompt(
    "Save one night track to a Spotify playlist called Partial Night.",
  );

  assert.equal(result.status, "completed");
  assert.equal(result.spotify_playlist_partial_effect.state, "partial");
  assert.equal(
    result.spotify_playlist_partial_effect.playlist.track_count,
    0,
  );
  assert.equal("spotify_playlist_write" in result, false);
  assert.match(result.text, /empty playlist now exists/u);
  assert.doesNotMatch(result.text, /no external effects/u);
  assert.doesNotMatch(result.text, /nothing changed/u);
  assert.deepEqual(service.calls, [
    [
      "playlist.write",
      {
        name: "Partial Night",
        uris: ["spotify:track:midnight-lines"],
      },
    ],
  ]);
});

test("playlist write fails safely without a validated plan", async () => {
  const { application, service } = spotifyApplication();
  const { faux, runtime } = configuredRuntime(application);
  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("moondog_library_search", { query: "night", limit: 1 })],
      { stopReason: "toolUse" },
    ),
    (context) => {
      const [search] = toolResults(context, "moondog_library_search");
      return fauxAssistantMessage(
        [
          fauxToolCall("moondog_spotify_playlist_write", {
            name: "Skipped Resolution",
            track_refs: search.tracks.map((track) => ({
              track_ref_id: track.track_ref_id,
            })),
          }),
        ],
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      const failed = context.messages.find(
        (message) =>
          message.role === "toolResult" &&
          message.toolName === "moondog_spotify_playlist_write",
      );
      assert.equal(failed.isError, true);
      assert.match(
        failed.content[0].text,
        /spotify_playlist_plan_required/u,
      );
      return fauxAssistantMessage([
        fauxText("I could not write the playlist without resolving the tracks."),
      ]);
    },
  ]);

  const result = await runtime.prompt("Save one track to Spotify directly.");

  assert.equal(result.status, "completed");
  assert.deepEqual(service.calls, []);
});

test("playlist write requires the exact validated order", async () => {
  const { application, service } = spotifyApplication();
  application.beginPrompt();
  try {
    const search = await application.searchLibrary({ query: "night", limit: 2 });
    const trackRefs = search.tracks.map((track) => track.track_ref_id);
    await application.spotifyResolveTracks({ trackRefs });
    await application.buildPlaylistPlan({
      intent: "Two night tracks.",
      requestedTrackCount: 2,
      candidateSetIds: [search.candidate_set_id],
      trackRefs: trackRefs.map((trackRefId) => ({
        trackRefId,
        selectionReason: "Selected for the requested sequence.",
      })),
      orderingNotes: "Keep the validated order.",
    });

    await assert.rejects(
      application.spotifyCreatePlaylist({
        name: "Wrong Order",
        trackRefs: [...trackRefs].reverse(),
      }),
      { code: "spotify_playlist_plan_required" },
    );
    assert.deepEqual(service.calls, []);
  } finally {
    application.endPrompt();
  }
});

test("playlist write reports missing OAuth scopes instead of calling Spotify", async () => {
  const { application, service } = spotifyApplication({
    missingScopes: ["playlist-modify-private"],
  });
  const { faux, runtime } = configuredRuntime(application);
  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("moondog_library_search", { query: "night", limit: 1 })],
      { stopReason: "toolUse" },
    ),
    (context) => {
      const [search] = toolResults(context, "moondog_library_search");
      return fauxAssistantMessage(
        [
          fauxToolCall("moondog_spotify_resolve_tracks", {
            track_refs: search.tracks.map((track) => ({
              track_ref_id: track.track_ref_id,
            })),
          }),
        ],
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      const [search] = toolResults(context, "moondog_library_search");
      return fauxAssistantMessage(
        [
          fauxToolCall("moondog_playlist_plan", {
            intent: "Save one track to Spotify.",
            requested_track_count: 1,
            candidate_set_ids: [search.candidate_set_id],
            track_refs: search.tracks.map((track) => ({
              track_ref_id: track.track_ref_id,
              selection_reason: "The user selected this track.",
            })),
            ordering_notes: "One selected track.",
          }),
        ],
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      const [search] = toolResults(context, "moondog_library_search");
      return fauxAssistantMessage(
        [
          fauxToolCall("moondog_spotify_playlist_write", {
            name: "No Scopes",
            track_refs: search.tracks.map((track) => ({
              track_ref_id: track.track_ref_id,
            })),
          }),
        ],
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      const failed = context.messages.find(
        (message) =>
          message.role === "toolResult" &&
          message.toolName === "moondog_spotify_playlist_write",
      );
      assert.equal(failed.isError, true);
      assert.match(failed.content[0].text, /spotify_write_scopes_missing/u);
      assert.match(failed.content[0].text, /playlist-modify-private/u);
      return fauxAssistantMessage([
        fauxText("Re-login is required before writing playlists."),
      ]);
    },
  ]);

  await runtime.prompt("Save this to a Spotify playlist.");

  assert.deepEqual(service.calls, []);
});

test("resolutions expire at prompt end and cannot be reused in the next prompt", async () => {
  const { application, service } = spotifyApplication();
  const { faux, runtime } = configuredRuntime(application);
  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("moondog_library_search", { query: "night", limit: 1 })],
      { stopReason: "toolUse" },
    ),
    (context) => {
      const [search] = toolResults(context, "moondog_library_search");
      return fauxAssistantMessage(
        [
          fauxToolCall("moondog_spotify_resolve_tracks", {
            track_refs: search.tracks.map((track) => ({
              track_ref_id: track.track_ref_id,
            })),
          }),
        ],
        { stopReason: "toolUse" },
      );
    },
    fauxAssistantMessage([fauxText("Resolved the track for later.")]),
  ]);
  await runtime.prompt("Resolve the first night track.");

  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("moondog_library_search", { query: "night", limit: 1 })],
      { stopReason: "toolUse" },
    ),
    (context) => {
      const [search] = toolResults(context, "moondog_library_search");
      return fauxAssistantMessage(
        [
          fauxToolCall("moondog_spotify_queue_add", {
            track_ref_id: search.tracks[0].track_ref_id,
          }),
        ],
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      const failed = context.messages.find(
        (message) =>
          message.role === "toolResult" &&
          message.toolName === "moondog_spotify_queue_add",
      );
      assert.equal(failed.isError, true);
      assert.match(failed.content[0].text, /spotify_track_not_resolved/u);
      return fauxAssistantMessage([
        fauxText("The previous resolution expired; resolving again."),
      ]);
    },
  ]);
  await runtime.prompt("Queue that track from last time.");

  assert.deepEqual(service.calls, []);
});

test("agent queues and plays resolved tracks by track reference", async () => {
  const { application, service } = spotifyApplication();
  const { faux, runtime } = configuredRuntime(application);
  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("moondog_library_search", { query: "night", limit: 2 })],
      { stopReason: "toolUse" },
    ),
    (context) => {
      const [search] = toolResults(context, "moondog_library_search");
      return fauxAssistantMessage(
        [
          fauxToolCall("moondog_spotify_resolve_tracks", {
            track_refs: search.tracks.map((track) => ({
              track_ref_id: track.track_ref_id,
            })),
          }),
        ],
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      const [search] = toolResults(context, "moondog_library_search");
      return fauxAssistantMessage(
        [
          fauxToolCall("moondog_spotify_queue_add", {
            track_ref_id: search.tracks[0].track_ref_id,
          }),
        ],
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      const [receipt] = toolResults(context, "moondog_spotify_queue_add");
      assert.deepEqual(receipt, {
        provider: "spotify",
        ok: true,
        effect: "write_external",
        action: "playback.queue.add",
        state: "accepted",
      });
      const [search] = toolResults(context, "moondog_library_search");
      return fauxAssistantMessage(
        [
          fauxToolCall("moondog_spotify_player_control", {
            action: "resume",
            track_refs: search.tracks.map((track) => track.track_ref_id),
          }),
        ],
        { stopReason: "toolUse" },
      );
    },
    fauxAssistantMessage([fauxText("Queued and started playback.")]),
  ]);

  const result = await runtime.prompt(
    "Queue the first night track and then play both resolved tracks.",
  );

  assert.equal(result.status, "completed");
  assert.deepEqual(service.calls, [
    ["queue.add", { uri: "spotify:track:midnight-lines" }],
    [
      "resume",
      {
        uris: ["spotify:track:midnight-lines", "spotify:track:glass-highway"],
      },
    ],
  ]);
});

test("agent checks saved tracks through resolved references", async () => {
  const { application, service } = spotifyApplication();
  const { faux, runtime } = configuredRuntime(application);
  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("moondog_library_search", { query: "night", limit: 2 })],
      { stopReason: "toolUse" },
    ),
    (context) => {
      const [search] = toolResults(context, "moondog_library_search");
      return fauxAssistantMessage(
        [
          fauxToolCall("moondog_spotify_resolve_tracks", {
            track_refs: search.tracks.map((track) => ({
              track_ref_id: track.track_ref_id,
            })),
          }),
        ],
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      const [search] = toolResults(context, "moondog_library_search");
      return fauxAssistantMessage(
        [
          fauxToolCall("moondog_spotify_library_check", {
            track_refs: search.tracks.map((track) => ({
              track_ref_id: track.track_ref_id,
            })),
          }),
        ],
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      const [check] = toolResults(context, "moondog_spotify_library_check");
      assert.deepEqual(check.checked, [
        { track_ref_id: fixtureTracks.midnightLines.track_ref_id, saved: true },
        { track_ref_id: fixtureTracks.glassHighway.track_ref_id, saved: false },
      ]);
      assert.equal(JSON.stringify(check).includes("spotify:"), false);
      return fauxAssistantMessage([fauxText("Checked the library.")]);
    },
  ]);

  const result = await runtime.prompt(
    "Check whether my two night tracks are already saved on Spotify.",
  );

  assert.equal(result.status, "completed");
  assert.deepEqual(service.calls, [
    [
      "library.check",
      { uris: ["spotify:track:midnight-lines", "spotify:track:glass-highway"] },
    ],
  ]);
});
