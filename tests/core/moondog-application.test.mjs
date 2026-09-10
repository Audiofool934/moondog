import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { readAppleMusicSourceStatus } from "../../src/core/apple-library-source-status.mjs";
import { MoondogApplication } from "../../src/core/moondog-application.mjs";
import { createSyntheticDomainServices } from "../../src/core/synthetic-domain-services.mjs";

const batchId = "11111111-2222-4333-8444-555555555555";

function syntheticManifest() {
  return {
    schema_version: "apple-music-library-import-manifest/1",
    subject_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    source: {
      captured_at: "2026-08-25T00:00:00.000Z",
      sha256: "f".repeat(64),
    },
    counts: {
      source_tracks: 3,
      source_playlists: 1,
      source_playlist_item_references: 2,
      aggregate_track_snapshots: 3,
      core_listening_events: 0,
      core_taste_events: 0,
    },
    coverage: {
      loved_or_favorited: 1,
      aggregate_play_count: 1,
    },
    semantics: {
      source_is_library_snapshot: true,
      source_is_complete_listening_history: false,
      aggregate_counts_expanded_into_events: false,
      explicit_states_projected_into_taste_events: false,
    },
  };
}

async function withSyntheticImports(callback) {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-source-status-"));
  const batch = path.join(root, batchId);
  await mkdir(batch, { mode: 0o700 });
  await writeFile(
    path.join(batch, "manifest.json"),
    `${JSON.stringify(syntheticManifest(), null, 2)}\n`,
    { mode: 0o600 },
  );
  try {
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("source status returns aggregate readiness without personal identifiers", async () => {
  await withSyntheticImports(async (importsRoot) => {
    const status = await readAppleMusicSourceStatus(importsRoot);

    assert.equal(status.state, "ready");
    assert.equal(status.latest.tracks, 3);
    assert.equal(status.latest.listening_events, 0);
    assert.equal(status.latest.taste_events, 0);
    assert.equal(status.semantics.profile_materialization_ready, false);

    const serialized = JSON.stringify(status);
    assert.equal(serialized.includes(batchId), false);
    assert.equal(serialized.includes("aaaaaaaa-bbbb"), false);
    assert.equal(serialized.includes("f".repeat(64)), false);
  });
});

test("unscoped source status refuses to combine multiple subjects", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-source-subjects-"));
  const manifests = [
    syntheticManifest(),
    {
      ...syntheticManifest(),
      subject_id: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
      source: {
        ...syntheticManifest().source,
        captured_at: "2026-08-26T00:00:00.000Z",
      },
    },
  ];
  const batchIds = [
    batchId,
    "66666666-7777-4888-8999-aaaaaaaaaaaa",
  ];
  try {
    for (let index = 0; index < batchIds.length; index += 1) {
      const batch = path.join(root, batchIds[index]);
      await mkdir(batch, { mode: 0o700 });
      await writeFile(
        path.join(batch, "manifest.json"),
        `${JSON.stringify(manifests[index], null, 2)}\n`,
        { mode: 0o600 },
      );
    }

    const status = await readAppleMusicSourceStatus(root);

    assert.equal(status.state, "invalid");
    assert.equal(status.error, "multiple_subjects");
    assert.equal(status.latest, null);
    assert.equal(JSON.stringify(status).includes("bbbbbbbb"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a symlinked source root is rejected", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "moondog-source-link-"));
  const target = path.join(temporary, "target");
  const link = path.join(temporary, "link");
  await mkdir(target);
  await symlink(target, link);
  try {
    const status = await readAppleMusicSourceStatus(link);
    assert.equal(status.state, "invalid");
    assert.equal(status.error, "source_root_invalid");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("a root directory read race returns a stable error without leaking its path", async () => {
  const privateRoot = "/private/example/apple-music-library";
  const status = await readAppleMusicSourceStatus(privateRoot, {
    async lstat() {
      return {
        isDirectory: () => true,
        isSymbolicLink: () => false,
      };
    },
    async readdir() {
      const error = new Error(`EACCES: permission denied, scandir '${privateRoot}'`);
      error.code = "EACCES";
      throw error;
    },
  });

  assert.equal(status.state, "invalid");
  assert.equal(status.error, "source_unreadable");
  assert.equal(JSON.stringify(status).includes(privateRoot), false);
});

test("a source root disappearing before readdir returns a private missing status", async () => {
  const privateRoot = "/private/example/disappeared-apple-library";
  const status = await readAppleMusicSourceStatus(privateRoot, {
    async lstat() {
      return {
        isDirectory: () => true,
        isSymbolicLink: () => false,
      };
    },
    async readdir() {
      const error = new Error(`ENOENT: no such file or directory, scandir '${privateRoot}'`);
      error.code = "ENOENT";
      throw error;
    },
  });

  assert.equal(status.state, "missing");
  assert.equal("error" in status, false);
  assert.equal(JSON.stringify(status).includes(privateRoot), false);
});

test("profile status requires a disposable projection without fabricating events", async () => {
  await withSyntheticImports(async (importsRoot) => {
    const application = new MoondogApplication({ importsRoot });
    const profile = await application.profileStatus();

    assert.equal(profile.state, "not_materialized");
    assert.equal(profile.evidence_records, 0);
    assert.equal(profile.claims, 0);
    assert.match(profile.reason, /projection rebuild/iu);
    assert.ok(profile.next_contracts.includes("library_track_observation"));
  });
});

test("a projection startup failure is reported without leaking details", async () => {
  const application = new MoondogApplication({
    importsRoot: path.join(tmpdir(), "moondog-does-not-exist"),
    domainServicesError: "projection_digest_mismatch",
  });

  const profile = await application.profileStatus();
  const doctor = await application.doctor();

  assert.equal(profile.state, "invalid");
  assert.equal(profile.error, "projection_digest_mismatch");
  assert.match(profile.reason, /rebuild/iu);
  assert.equal(
    doctor.checks.find((check) => check.id === "profile.projection").ok,
    false,
  );
  assert.equal(JSON.stringify(profile).includes("/private/"), false);
});

test("capability catalog keeps external effects disabled", async () => {
  const application = new MoondogApplication({
    importsRoot: path.join(tmpdir(), "moondog-does-not-exist"),
  });
  const tools = application.toolsStatus().capabilities;

  assert.equal(
    tools.find((tool) => tool.id === "spotify.playlist.write").state,
    "blocked",
  );
  assert.equal(
    tools.find((tool) => tool.id === "spotify.catalog.resolve").state,
    "blocked",
  );
  assert.equal(
    tools.find((tool) => tool.id === "spotify.library.save").state,
    "blocked",
  );
  assert.equal(
    tools.find((tool) => tool.id === "music.generate").state,
    "disabled",
  );
  assert.equal(
    tools.find((tool) => tool.id === "source.apple_music.status").state,
    "enabled",
  );
  assert.equal(
    tools.find((tool) => tool.id === "library.search").state,
    "blocked",
  );
  assert.equal(
    tools.find((tool) => tool.id === "profile.rediscovery").state,
    "blocked",
  );
  assert.equal(
    tools.find((tool) => tool.id === "spotify.history.import").state,
    "enabled",
  );
});

test("ready domain services expose four descriptor-driven A1 capabilities", () => {
  const application = new MoondogApplication({
    domainServices: createSyntheticDomainServices({
      subjectScope: "trusted-synthetic-subject",
    }),
  });
  const tools = application.toolsStatus().capabilities;
  const descriptors = application.agentCapabilityDescriptors();

  for (const capabilityId of [
    "library.search",
    "profile.summary",
    "profile.explain",
    "playlist.plan",
  ]) {
    assert.equal(
      tools.find((capability) => capability.id === capabilityId).state,
      "enabled",
    );
    assert.ok(
      descriptors.some(
        (descriptor) => descriptor.capability_id === capabilityId,
      ),
    );
  }
  assert.equal(
    tools.find((capability) => capability.id === "playlist.plan").effect,
    "derive_local",
  );
  assert.ok(
    descriptors.every((descriptor) =>
      new Set(["read_local", "read_runtime", "derive_local"]).has(
        descriptor.effect,
      ),
    ),
  );

  descriptors[0].label = "mutated";
  assert.notEqual(application.agentCapabilityDescriptors()[0].label, "mutated");
});

test("rediscovery capability appears only when trusted history candidates are available", async () => {
  const domainServices = createSyntheticDomainServices({
    subjectScope: "trusted-synthetic-subject",
  });
  domainServices.getRediscoveryCandidates = async () => ({
    state: "empty",
    candidate_set_id: null,
    candidate_scope: "private_history",
    result_count: 0,
    limit_applied: 6,
    reference_date: "2026-08-29T04:00:00.000Z",
    quiet_days: 90,
    minimum_plays: 3,
    minimum_engaged_plays: 2,
    minimum_listening_minutes: 10,
    expires_on: "prompt_end",
    tracks: [],
  });
  domainServices.rediscoveryReady = () => true;
  const application = new MoondogApplication({ domainServices });

  assert.equal(application.rediscoveryServicesReady(), true);
  assert.equal(
    application
      .toolsStatus()
      .capabilities.find((capability) => capability.id === "profile.rediscovery")
      .state,
    "enabled",
  );
  assert.equal(
    application
      .agentCapabilityDescriptors()
      .some((descriptor) => descriptor.capability_id === "profile.rediscovery"),
    true,
  );
  assert.equal((await application.getRediscoveryCandidates({})).state, "empty");
  application.close();
});

test("Time Machine capability appears only with trusted cross-year candidates", async () => {
  const domainServices = createSyntheticDomainServices({
    subjectScope: "trusted-synthetic-subject",
  });
  domainServices.getTimeCapsuleCandidates = async () => ({
    state: "empty",
    candidate_set_id: null,
    candidate_scope: "private_history",
    result_count: 0,
    limit_applied: 6,
    reference_date: "2026-08-29T04:00:00.000Z",
    history_start_year: null,
    history_end_year: null,
    represented_years: [],
    minimum_years: 2,
    minimum_engaged_plays: 2,
    minimum_listening_minutes: 5,
    expires_on: "prompt_end",
    tracks: [],
  });
  domainServices.timeCapsuleReady = () => true;
  const application = new MoondogApplication({ domainServices });

  assert.equal(application.timeCapsuleServicesReady(), true);
  assert.equal(
    application
      .toolsStatus()
      .capabilities.find(
        (capability) => capability.id === "profile.time_capsule",
      ).state,
    "enabled",
  );
  assert.equal(
    application
      .agentCapabilityDescriptors()
      .some((descriptor) => descriptor.capability_id === "profile.time_capsule"),
    true,
  );
  assert.equal((await application.getTimeCapsuleCandidates({})).state, "empty");
  application.close();
});

test("taste is an offline local command over the bounded profile projection", async () => {
  const application = new MoondogApplication({
    domainServices: createSyntheticDomainServices({
      subjectScope: "trusted-synthetic-subject",
    }),
  });

  try {
    const taste = await application.runLocalCommand("taste");

    assert.equal(taste.profile_version, "profile_projection/0");
    assert.equal(taste.max_items_applied, 5);
    assert.ok(taste.strong_preferences.length > 0);
    assert.ok(taste.limitations.includes("Play count supports familiarity, not liking."));
  } finally {
    application.close();
  }
});

test("partial profile adapters enable profile reads without library or planning tools", async () => {
  const application = new MoondogApplication({
    importsRoot: path.join(tmpdir(), "moondog-does-not-exist"),
    domainServices: {
      async searchLibrary() {},
      async getProfileSummary() {},
      async explainProfileEvidence() {},
      async buildPlaylistPlan() {},
      beginPrompt() {},
      endPrompt() {},
    },
  });

  assert.equal(application.domainServicesReady(), false);
  assert.equal(application.profileServicesReady(), true);
  assert.equal(
    application
      .toolsStatus()
      .capabilities.find((capability) => capability.id === "library.search")
      .state,
    "blocked",
  );
  assert.equal(
    application
      .agentCapabilityDescriptors()
      .some((descriptor) => descriptor.capability_id === "playlist.plan"),
    false,
  );
  assert.equal(
    application
      .agentCapabilityDescriptors()
      .some((descriptor) => descriptor.capability_id === "profile.summary"),
    true,
  );
  await assert.rejects(
    application.searchLibrary({ query: "night" }),
    /projection is not ready/iu,
  );
});

test("application source status reflects a ready local profile projection", async () => {
  await withSyntheticImports(async (importsRoot) => {
    const application = new MoondogApplication({
      importsRoot,
      domainServices: createSyntheticDomainServices({
        subjectScope: "trusted-synthetic-subject",
      }),
    });

    const source = await application.sourceStatus();

    assert.equal(source.state, "ready");
    assert.equal(source.semantics.profile_materialization_ready, true);
  });
});

test("application delegates domain calls without accepting a model subject", async () => {
  const calls = [];
  const domainServices = {
    async searchLibrary(input) {
      calls.push(["search", input]);
      return { ok: true };
    },
    async getProfileSummary(input) {
      calls.push(["summary", input]);
      return { ok: true };
    },
    async explainProfileEvidence(input) {
      calls.push(["explain", input]);
      return { ok: true };
    },
    async buildPlaylistPlan(input) {
      calls.push(["plan", input]);
      return { ok: true };
    },
    getTrustedTracks(trackRefIds) {
      calls.push(["trusted", trackRefIds]);
      return trackRefIds.map((trackRefId) => ({ track_ref_id: trackRefId }));
    },
    registerRetainedPlaylistCandidateSet() {},
    beginPrompt() {},
    endPrompt() {},
    resetCandidateSets() {},
  };
  const application = new MoondogApplication({ domainServices });

  await application.searchLibrary({ query: "night" });
  await application.getProfileSummary({ maxItems: 4 });
  await application.explainProfileEvidence({ evidenceId: "evidence" });
  await application.buildPlaylistPlan({ intent: "night" });

  assert.deepEqual(calls, [
    ["search", { query: "night" }],
    ["summary", { maxItems: 4 }],
    ["explain", { evidenceId: "evidence" }],
    ["plan", { intent: "night" }],
  ]);
  assert.equal(JSON.stringify(calls).includes("subject"), false);
});

test("artist release lookup uses one exact local artist release as a bounded hint", async () => {
  const searches = [];
  const catalogCalls = [];
  const domainServices = {
    async searchLibrary(input) {
      searches.push(input);
      return {
        tracks: [
          {
            artist_credit: "刘森乐队",
            release: "Wrong Artist Release",
          },
          {
            artist_credit: "刘森",
            release: "华北浪革",
          },
          {
            artist_credit: "刘森",
            release: "Another Private Release",
          },
        ],
      };
    },
    async getProfileSummary() {},
    async explainProfileEvidence() {},
    async buildPlaylistPlan() {},
    getTrustedTracks() {},
    registerRetainedPlaylistCandidateSet() {},
    beginPrompt() {},
    endPrompt() {},
    resetCandidateSets() {},
  };
  const musicCatalog = {
    async findArtistReleases(input) {
      catalogCalls.push(input);
      return { state: "resolved" };
    },
  };
  const application = new MoondogApplication({
    domainServices,
    musicCatalog,
  });
  const input = { artistName: "刘森", limit: 4 };

  await application.findArtistReleases(input);
  await application.findArtistReleases({
    artistName: "刘森",
    knownRelease: "用户指定发行",
    limit: 2,
  });

  assert.deepEqual(input, { artistName: "刘森", limit: 4 });
  assert.deepEqual(searches, [
    {
      query: "刘森",
      limit: 12,
      offset: 0,
      filters: { artists: ["刘森"] },
    },
  ]);
  assert.deepEqual(catalogCalls, [
    {
      artistName: "刘森",
      knownRelease: "华北浪革",
      limit: 4,
    },
    {
      artistName: "刘森",
      knownRelease: "用户指定发行",
      limit: 2,
    },
  ]);
});

test("artist release lookup recovers one exact public alias across catalogs", async () => {
  const catalogCalls = [];
  const identityCalls = [];
  const musicCatalog = {
    async findArtistReleases(input) {
      catalogCalls.push(["name", input]);
      return {
        state: "ambiguous_artist",
        source: {
          provider: "apple_music",
          catalog: "itunes_search_api",
          storefront: "US",
          retrieved_at: "2026-09-03T11:23:19.147Z",
          coverage: "Apple Music US storefront catalog only.",
        },
        query: {
          artist_name: "Hikki",
        },
        candidates: [],
      };
    },
    async findArtistReleasesByCatalogId(input) {
      catalogCalls.push(["identity", input]);
      return {
        state: "resolved",
        source: {
          provider: "apple_music",
          catalog: "itunes_search_api",
          storefront: "US",
          retrieved_at: "2026-09-03T11:23:19.147Z",
          coverage: "Apple Music US storefront catalog only.",
        },
        query: {
          artist_catalog_id: "18756224",
        },
        artist: {
          catalog_id: "18756224",
          name: "Hikaru Utada",
          catalog_url: "https://music.apple.com/us/artist/18756224",
        },
        selection_basis: "explicit_artist_catalog_identity",
        releases: [],
        latest_released_single: null,
        upcoming_releases: [],
        candidates: [],
      };
    },
  };
  const artistIdentityResolver = {
    async resolveArtist(artistName) {
      identityCalls.push(artistName);
      return {
        state: "resolved",
        artist_name: "Hikki",
        canonical_name: "Hikaru Utada",
        artist_mbid: "b539e453-c4fe-47e3-8a07-8517eac74429",
        wikidata_ids: ["Q234598"],
        apple_music_artist_ids: ["18756224"],
        candidates: [
          {
            wikidata_id: "Q234598",
          },
        ],
      };
    },
  };
  const application = new MoondogApplication({
    musicCatalog,
    artistIdentityResolver,
  });

  const result = await application.findArtistReleases({
    artistName: "Hikki",
    limit: 4,
  });

  assert.deepEqual(identityCalls, ["Hikki"]);
  assert.deepEqual(catalogCalls, [
    ["name", { artistName: "Hikki", limit: 4 }],
    ["identity", { artistCatalogId: "18756224", limit: 8 }],
  ]);
  assert.equal(result.state, "resolved");
  assert.equal(result.artist.name, "Hikaru Utada");
  assert.deepEqual(result.query, { artist_name: "Hikki" });
  assert.equal(
    result.selection_basis,
    "wikidata_exact_label_or_alias_cross_catalog",
  );
  assert.equal(result.cross_catalog_identity.wikidata_ids[0], "Q234598");
  assert.equal(
    result.cross_catalog_identity.musicbrainz_artist_id,
    "b539e453-c4fe-47e3-8a07-8517eac74429",
  );
  application.close();
});

test("a ready Spotify connection enables bounded player capabilities", async () => {
  const calls = [];
  const service = {
    async currentPlayer() {
      return {
        provider: "spotify",
        state: "available",
        is_playing: true,
        shuffle_state: false,
        repeat_state: "off",
        currently_playing_type: "track",
        device: {
          id: "private-device",
          name: "Private speaker name",
          is_active: true,
          is_restricted: false,
        },
        item: {
          uri: "spotify:track:PrivateTrack",
          name: "Private track title",
        },
      };
    },
    async pause(input) {
      calls.push(["pause", input]);
      return {
        provider: "spotify",
        ok: true,
        effect: "write_external",
        action: "playback.pause",
        state: "accepted",
      };
    },
    async addToQueue(input) {
      calls.push(["queue", input]);
      return { ok: true };
    },
    async transfer(input) {
      calls.push(["transfer", input]);
      return { ok: true };
    },
  };
  const application = new MoondogApplication({
    spotifyConnection: {
      service,
      ready: () => true,
      publicStatus: () => ({
        provider: "spotify",
        state: "ready",
        external_effects: "spotify_control",
      }),
    },
  });

  const descriptors = application.agentCapabilityDescriptors();
  for (const capabilityId of [
    "spotify.player.status",
    "spotify.player.control",
    "spotify.queue.add",
    "spotify.device.transfer",
  ]) {
    assert.ok(
      descriptors.some(
        (descriptor) => descriptor.capability_id === capabilityId,
      ),
    );
  }

  const player = await application.spotifyPlayerStatus();
  assert.deepEqual(player, {
    provider: "spotify",
    state: "available",
    is_playing: true,
    shuffle_state: false,
    repeat_state: "off",
    currently_playing_type: "track",
    active_device: true,
    restricted_device: false,
    item_available: true,
  });
  assert.equal(JSON.stringify(player).includes("Private"), false);

  await application.spotifyControl({ action: "pause" });
  await application.spotifyAddToQueue({ uri: "spotify:track:one" });
  await application.spotifyTransfer({ deviceId: "device" });
  assert.deepEqual(calls, [
    ["pause", {}],
    ["queue", { uri: "spotify:track:one" }],
    ["transfer", { deviceId: "device" }],
  ]);
});

test("Spotify catalog resolution asks for a fresh login when search scope is missing", async () => {
  let resolverCalls = 0;
  const application = new MoondogApplication({
    domainServices: createSyntheticDomainServices({
      subjectScope: { subjectId: "trusted-synthetic-subject" },
    }),
    spotifyConnection: {
      service: {},
      resolver: {
        async resolve() {
          resolverCalls += 1;
          return { resolutions: [] };
        },
      },
      ready: () => true,
      missingScopes: () => ["user-read-private"],
    },
  });

  await assert.rejects(
    application.spotifyResolveTracks({ trackRefs: ["track-ref"] }),
    {
      code: "spotify_scopes_missing",
      message:
        "Spotify authorization is missing scopes: user-read-private. Run moondog spotify login again to grant them.",
    },
  );
  assert.equal(resolverCalls, 0);
});
