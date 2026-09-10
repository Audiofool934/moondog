import assert from "node:assert/strict";
import test from "node:test";

import {
  SPOTIFY_CATALOG_RESOLVER_LIMITS,
  createSpotifyCatalogResolver,
  SpotifyCatalogResolverError,
} from "../../src/integrations/spotify/catalog-resolver.mjs";
import {
  createInMemorySpotifyResolutionCache,
} from "../../src/integrations/spotify/resolution-cache.mjs";

function spotifyCandidate(overrides = {}) {
  return {
    uri: "spotify:track:abc123",
    id: "abc123",
    name: "Midnight Lines",
    artists: ["Mara Vale"],
    album: "Night Transit",
    duration_ms: 278_000,
    popularity: 55,
    ...overrides,
  };
}

function libraryTrack(overrides = {}) {
  return {
    track_ref_id: "10000000-0000-4000-8000-000000000001",
    title: "Midnight Lines",
    artist_credit: "Mara Vale",
    release: "Night Transit",
    duration_ms: 278_000,
    ...overrides,
  };
}

function fakeSearchClient(responses) {
  const calls = [];
  const markets = [];
  return {
    calls,
    markets,
    async searchTracks({ query, market }) {
      calls.push(query);
      markets.push(market);
      const response = responses.shift() ?? { items: [] };
      return {
        provider: "spotify",
        items: Array.isArray(response.items) ? response.items : [],
      };
    },
  };
}

test("resolver resolves an exact match with album and duration corroboration", async () => {
  const client = fakeSearchClient([
    { items: [spotifyCandidate()] },
  ]);
  const resolver = createSpotifyCatalogResolver({ client });

  const result = await resolver.resolve([libraryTrack()]);

  assert.equal(result.resolved_count, 1);
  assert.equal(result.not_found_count, 0);
  const resolution = result.resolutions[0];
  assert.equal(resolution.status, "resolved");
  assert.equal(resolution.match_quality, "exact");
  assert.deepEqual(resolution.spotify, {
    track_id: "abc123",
    uri: "spotify:track:abc123",
  });
  assert.equal(resolution.matched.album, "Night Transit");
});

test("resolver uses a trusted private-history Spotify identity without catalog search", async () => {
  const client = fakeSearchClient([]);
  const resolver = createSpotifyCatalogResolver({ client });
  const spotifyTrackId = "4uLU6hMCjMI75M1A2tKUQC";

  const result = await resolver.resolve([
    libraryTrack({
      candidate_scope: "private_history",
      external_refs: [
        {
          system: "spotify",
          entity_type: "spotify.track",
          external_id: spotifyTrackId,
        },
      ],
    }),
  ]);

  assert.equal(client.calls.length, 0);
  assert.equal(result.resolved_count, 1);
  assert.equal(result.resolutions[0].match_quality, "provider_id");
  assert.deepEqual(result.resolutions[0].spotify, {
    track_id: spotifyTrackId,
    uri: `spotify:track:${spotifyTrackId}`,
  });
  assert.deepEqual(result.resolutions[0].matched, {
    title: "Midnight Lines",
    artists: ["Mara Vale"],
    album: "Night Transit",
    duration_ms: 278_000,
  });
});

test("resolver returns a standard match when only title and artist agree", async () => {
  const client = fakeSearchClient([
    {
      items: [
        spotifyCandidate({
          album: "Greatest Hits",
          duration_ms: 290_000,
          uri: "spotify:track:deluxe",
          id: "deluxe",
        }),
      ],
    },
  ]);
  const resolver = createSpotifyCatalogResolver({ client });

  const result = await resolver.resolve([libraryTrack()]);

  assert.equal(result.resolutions[0].match_quality, "standard");
  assert.equal(result.resolutions[0].spotify.uri, "spotify:track:deluxe");
});

test("resolver labels a corroborated remaster fallback instead of calling it exact", async () => {
  const client = fakeSearchClient([
    {
      items: [
        spotifyCandidate({
          name: "Midnight Lines (2011 Remastered)",
          album: "Night Transit - Remastered",
        }),
      ],
    },
  ]);
  const resolver = createSpotifyCatalogResolver({ client });

  const result = await resolver.resolve([
    libraryTrack({ title: "Midnight Lines" }),
  ]);

  assert.equal(result.resolutions[0].status, "resolved");
  assert.equal(result.resolutions[0].match_quality, "alternate_master");
});

test("resolver keeps searching when a fielded result only offers a remaster fallback", async () => {
  const client = fakeSearchClient([
    {
      items: [
        spotifyCandidate({
          uri: "spotify:track:remaster",
          id: "remaster",
          name: "Midnight Lines (2011 Remastered)",
          album: "Night Transit - Remastered",
          popularity: 99,
        }),
      ],
    },
    {
      items: [
        spotifyCandidate({
          uri: "spotify:track:original-master",
          id: "original-master",
          popularity: 1,
        }),
      ],
    },
  ]);
  const resolver = createSpotifyCatalogResolver({ client });

  const result = await resolver.resolve([libraryTrack()]);

  assert.equal(
    result.resolutions[0].spotify.uri,
    "spotify:track:original-master",
  );
  assert.equal(result.resolutions[0].match_quality, "exact");
  assert.equal(client.calls.length, 2);
});

test("resolver rejects conflicting remaster years", async () => {
  const client = fakeSearchClient([
    {
      items: [
        spotifyCandidate({
          name: "Midnight Lines (2021 Remastered)",
          album: "Night Transit - 2021 Remastered",
        }),
      ],
    },
    { items: [] },
  ]);
  const resolver = createSpotifyCatalogResolver({ client });

  const result = await resolver.resolve([
    libraryTrack({
      title: "Midnight Lines (2011 Remastered)",
      release: "Night Transit - 2011 Remastered",
    }),
  ]);

  assert.equal(result.resolutions[0].status, "not_found");
});

test("resolver prefers a standard recording over a more popular live version", async () => {
  const client = fakeSearchClient([
    {
      items: [
        spotifyCandidate({
          uri: "spotify:track:popular-live",
          id: "popular-live",
          name: "Midnight Lines - Live at the Forum",
          album: "Night Transit",
          popularity: 99,
        }),
        spotifyCandidate({
          uri: "spotify:track:standard",
          id: "standard",
          popularity: 5,
        }),
      ],
    },
  ]);
  const resolver = createSpotifyCatalogResolver({ client });

  const result = await resolver.resolve([libraryTrack()]);

  assert.equal(result.resolutions[0].spotify.uri, "spotify:track:standard");
  assert.equal(result.resolutions[0].match_quality, "exact");
});

test("resolver fails closed when a live version is the only match for a standard recording", async () => {
  const client = fakeSearchClient([
    {
      items: [
        spotifyCandidate({
          uri: "spotify:track:live-only",
          id: "live-only",
          name: "Midnight Lines - Live at the Forum",
        }),
      ],
    },
    { items: [] },
  ]);
  const resolver = createSpotifyCatalogResolver({ client });

  const result = await resolver.resolve([libraryTrack()]);

  assert.equal(result.resolutions[0].status, "not_found");
});

test("resolver selects the requested live performance over the studio recording", async () => {
  const client = fakeSearchClient([
    {
      items: [
        spotifyCandidate({
          uri: "spotify:track:studio",
          id: "studio",
          popularity: 99,
        }),
        spotifyCandidate({
          uri: "spotify:track:forum-live",
          id: "forum-live",
          name: "Midnight Lines (Live at the Forum)",
          album: "Night Transit: Live at the Forum",
          popularity: 2,
        }),
      ],
    },
  ]);
  const resolver = createSpotifyCatalogResolver({ client });

  const result = await resolver.resolve([
    libraryTrack({
      title: "Midnight Lines - Live at the Forum",
      release: "Night Transit: Live at the Forum",
    }),
  ]);

  assert.equal(result.resolutions[0].spotify.uri, "spotify:track:forum-live");
});

test("resolver rejects an uncorroborated different live performance", async () => {
  const client = fakeSearchClient([
    {
      items: [
        spotifyCandidate({
          uri: "spotify:track:wembley-live",
          id: "wembley-live",
          name: "Midnight Lines - Live at Wembley",
          album: "Wembley Live",
          duration_ms: 240_000,
        }),
      ],
    },
    { items: [] },
  ]);
  const resolver = createSpotifyCatalogResolver({ client });

  const result = await resolver.resolve([
    libraryTrack({
      title: "Midnight Lines - Live at the Forum",
      release: "Forum Live",
    }),
  ]);

  assert.equal(result.resolutions[0].status, "not_found");
});

test("resolver selects the requested radio edit over the album recording", async () => {
  const client = fakeSearchClient([
    {
      items: [
        spotifyCandidate({
          uri: "spotify:track:album",
          id: "album",
          popularity: 99,
        }),
        spotifyCandidate({
          uri: "spotify:track:radio-edit",
          id: "radio-edit",
          name: "Midnight Lines (Radio Edit)",
          duration_ms: 218_000,
          popularity: 2,
        }),
      ],
    },
  ]);
  const resolver = createSpotifyCatalogResolver({ client });

  const result = await resolver.resolve([
    libraryTrack({
      title: "Midnight Lines - Radio Edit",
      duration_ms: 218_000,
    }),
  ]);

  assert.equal(result.resolutions[0].spotify.uri, "spotify:track:radio-edit");
});

test("resolver preserves meaningful parentheticals in the core song title", async () => {
  const client = fakeSearchClient([
    {
      items: [
        spotifyCandidate({ name: "Midnight Lines (At Dawn)" }),
      ],
    },
    { items: [] },
  ]);
  const resolver = createSpotifyCatalogResolver({ client });

  const result = await resolver.resolve([
    libraryTrack({ title: "Midnight Lines (After Dark)" }),
  ]);

  assert.equal(result.resolutions[0].status, "not_found");
});

test("resolver does not substitute a collaboration for a solo recording", async () => {
  const client = fakeSearchClient([
    {
      items: [
        spotifyCandidate({
          uri: "spotify:track:collaboration",
          id: "collaboration",
          artists: ["Mara Vale", "Guest Vocalist"],
          popularity: 99,
        }),
        spotifyCandidate({
          uri: "spotify:track:solo",
          id: "solo",
          popularity: 2,
        }),
      ],
    },
  ]);
  const resolver = createSpotifyCatalogResolver({ client });

  const result = await resolver.resolve([libraryTrack()]);

  assert.equal(result.resolutions[0].spotify.uri, "spotify:track:solo");
});

test("resolver requires the requested collaborator to be present", async () => {
  const client = fakeSearchClient([
    {
      items: [
        spotifyCandidate({
          uri: "spotify:track:solo",
          id: "solo",
          popularity: 99,
        }),
        spotifyCandidate({
          uri: "spotify:track:collaboration",
          id: "collaboration",
          artists: ["Mara Vale", "Guest Vocalist"],
          popularity: 2,
        }),
      ],
    },
  ]);
  const resolver = createSpotifyCatalogResolver({ client });

  const result = await resolver.resolve([
    libraryTrack({ artist_credit: "Mara Vale feat Guest Vocalist" }),
  ]);

  assert.equal(result.resolutions[0].spotify.uri, "spotify:track:collaboration");
});

test("resolver recognizes a collaborator credited in the source title", async () => {
  const client = fakeSearchClient([
    {
      items: [
        spotifyCandidate({
          uri: "spotify:track:solo",
          id: "solo",
          popularity: 99,
        }),
        spotifyCandidate({
          uri: "spotify:track:title-collaboration",
          id: "title-collaboration",
          artists: ["Mara Vale", "Guest Vocalist"],
          popularity: 2,
        }),
      ],
    },
  ]);
  const resolver = createSpotifyCatalogResolver({ client });

  const result = await resolver.resolve([
    libraryTrack({ title: "Midnight Lines (feat. Guest Vocalist)" }),
  ]);

  assert.equal(
    result.resolutions[0].spotify.uri,
    "spotify:track:title-collaboration",
  );
});

test("resolver reports not_found when no candidate is eligible", async () => {
  const client = fakeSearchClient([
    {
      items: [
        spotifyCandidate({ name: "Different Song", artists: ["Someone Else"] }),
        spotifyCandidate({ name: "Midnight Lines", artists: ["Another Artist"] }),
      ],
    },
    { items: [] },
  ]);
  const resolver = createSpotifyCatalogResolver({ client });

  const result = await resolver.resolve([libraryTrack()]);

  assert.equal(result.resolutions[0].status, "not_found");
  assert.equal(result.resolved_count, 0);
  assert.equal(result.not_found_count, 1);
});

test("resolver falls back to a plain query when the fielded search is empty", async () => {
  const client = fakeSearchClient([
    { items: [] },
    { items: [spotifyCandidate()] },
  ]);
  const resolver = createSpotifyCatalogResolver({ client });

  const result = await resolver.resolve([libraryTrack()]);

  assert.equal(result.resolutions[0].status, "resolved");
  assert.equal(client.calls.length, 2);
  assert.match(client.calls[0], /track:/u);
  assert.equal(client.calls[0].includes("track:"), true);
  assert.equal(client.calls[1].includes("track:"), false);
  assert.deepEqual(client.markets, [undefined, undefined]);
});

test("resolver falls back when fielded results do not contain an eligible match", async () => {
  const client = fakeSearchClient([
    {
      items: [
        spotifyCandidate({
          name: "Different Song",
          artists: ["Someone Else"],
        }),
      ],
    },
    { items: [spotifyCandidate()] },
  ]);
  const resolver = createSpotifyCatalogResolver({ client });

  const result = await resolver.resolve([libraryTrack()]);

  assert.equal(result.resolutions[0].status, "resolved");
  assert.equal(client.calls.length, 2);
});

test("resolver splits primary artists and accepts credited collaborations", async () => {
  const client = fakeSearchClient([
    {
      items: [
        spotifyCandidate({
          artists: ["Mara Vale", "Guest Vocalist"],
          album: "Night Transit",
        }),
      ],
    },
  ]);
  const resolver = createSpotifyCatalogResolver({ client });

  const result = await resolver.resolve([
    libraryTrack({ artist_credit: "Mara Vale feat. Guest Vocalist" }),
  ]);

  assert.equal(result.resolutions[0].status, "resolved");
  assert.deepEqual(client.calls[0], 'track:"Midnight Lines" artist:"Mara Vale"');
});

test("resolver prefers album and duration corroboration over popularity", async () => {
  const client = fakeSearchClient([
    {
      items: [
        spotifyCandidate({
          uri: "spotify:track:popular",
          id: "popular",
          album: "Greatest Hits",
          duration_ms: 278_200,
          popularity: 90,
        }),
        spotifyCandidate({ popularity: 10 }),
      ],
    },
  ]);
  const resolver = createSpotifyCatalogResolver({ client });

  const result = await resolver.resolve([libraryTrack()]);

  assert.equal(result.resolutions[0].spotify.uri, "spotify:track:abc123");
});

test("resolver is deterministic between equal-scoring candidates", async () => {
  const candidates = [
    spotifyCandidate({ uri: "spotify:track:bbb", id: "bbb", popularity: 50 }),
    spotifyCandidate({ uri: "spotify:track:aaa", id: "aaa", popularity: 50 }),
  ];
  const first = createSpotifyCatalogResolver({
    client: fakeSearchClient([{ items: candidates }]),
  });
  const second = createSpotifyCatalogResolver({
    client: fakeSearchClient([{ items: [...candidates].reverse() }]),
  });

  const firstResult = await first.resolve([libraryTrack()]);
  const secondResult = await second.resolve([libraryTrack()]);

  assert.equal(firstResult.resolutions[0].spotify.uri, "spotify:track:aaa");
  assert.equal(secondResult.resolutions[0].spotify.uri, "spotify:track:aaa");
});

test("resolver serves repeated content from the cache without new searches", async () => {
  const client = fakeSearchClient([
    { items: [spotifyCandidate()] },
    { items: [] },
  ]);
  const cache = createInMemorySpotifyResolutionCache();
  const resolver = createSpotifyCatalogResolver({ client, cache });

  const first = await resolver.resolve([
    libraryTrack({ track_ref_id: "ref-a" }),
  ]);
  const second = await resolver.resolve([
    libraryTrack({ track_ref_id: "ref-b", duration_ms: 279_000 }),
  ]);

  assert.equal(first.resolutions[0].status, "resolved");
  assert.equal(second.resolutions[0].status, "resolved");
  assert.equal(second.resolutions[0].track_ref_id, "ref-b");
  assert.equal(client.calls.length, 1);
});

test("resolver does not cache unresolved tracks", async () => {
  const client = fakeSearchClient([
    { items: [] },
    { items: [] },
    { items: [spotifyCandidate()] },
  ]);
  const cache = createInMemorySpotifyResolutionCache();
  const resolver = createSpotifyCatalogResolver({ client, cache });

  const first = await resolver.resolve([libraryTrack()]);
  const second = await resolver.resolve([libraryTrack()]);

  assert.equal(first.resolutions[0].status, "not_found");
  assert.equal(second.resolutions[0].status, "resolved");
  assert.equal(client.calls.length, 3);
});

test("resolver rejects invalid resolution requests", async () => {
  const resolver = createSpotifyCatalogResolver({
    client: fakeSearchClient([]),
  });

  await assert.rejects(resolver.resolve([]), {
    code: "invalid_tracks",
  });
  await assert.rejects(
    resolver.resolve(
      Array.from({ length: SPOTIFY_CATALOG_RESOLVER_LIMITS.tracksPerCallMax + 1 }, (_, index) =>
        libraryTrack({ track_ref_id: `ref-${index}` }),
      ),
    ),
    { code: "invalid_tracks" },
  );
  await assert.rejects(
    resolver.resolve([libraryTrack(), libraryTrack()]),
    { code: "invalid_tracks" },
  );
  await assert.rejects(
    resolver.resolve([libraryTrack({ title: "" })]),
    SpotifyCatalogResolverError,
  );
  await assert.rejects(
    resolver.resolve([{ track_ref_id: "x", title: "T" }]),
    { code: "invalid_track_artist" },
  );
});

test("resolver deduplicates identical content tuples inside one call", async () => {
  const client = fakeSearchClient([{ items: [spotifyCandidate()] }]);
  const resolver = createSpotifyCatalogResolver({ client });

  const result = await resolver.resolve([
    libraryTrack({ track_ref_id: "ref-a" }),
    libraryTrack({ track_ref_id: "ref-b" }),
  ]);

  assert.equal(result.resolutions.length, 2);
  assert.equal(client.calls.length, 1);
  assert.equal(result.resolutions[0].track_ref_id, "ref-a");
  assert.equal(result.resolutions[1].track_ref_id, "ref-b");
});
