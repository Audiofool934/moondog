import assert from "node:assert/strict";
import test from "node:test";

import {
  AppleMusicCatalogError,
  createAppleMusicCatalog,
  createAppleMusicCatalogClient,
} from "../../src/integrations/apple-music/catalog.mjs";

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function artistResult(artistId, artistName, primaryGenreName) {
  return {
    wrapperType: "artist",
    artistId,
    artistName,
    primaryGenreName,
    artistLinkUrl: `https://music.apple.com/us/artist/${artistId}`,
  };
}

function releaseResult({
  artistId,
  collectionId,
  collectionName,
  releaseDate,
  trackCount = 1,
}) {
  return {
    wrapperType: "collection",
    collectionType: "Album",
    artistId,
    artistName: "刘森",
    collectionId,
    collectionName,
    releaseDate,
    trackCount,
    primaryGenreName: "Indie Rock",
    collectionViewUrl: `https://music.apple.com/us/album/${collectionId}`,
  };
}

function trackResult({
  trackId,
  trackName,
  artistName,
  collectionName,
  primaryGenreName = "Electronic",
}) {
  return {
    wrapperType: "track",
    kind: "song",
    trackId,
    trackName,
    artistName,
    collectionName,
    trackTimeMillis: 240000,
    primaryGenreName,
    releaseDate: "2025-04-18T07:00:00Z",
    trackViewUrl: `https://music.apple.com/us/album/${trackId}`,
  };
}

function liuSenFixture() {
  const calls = [];
  const fetchImpl = async (input) => {
    const url = new URL(input);
    calls.push(url);
    if (url.pathname === "/search") {
      return jsonResponse({
        resultCount: 3,
        results: [
          artistResult(1502984832, "刘森", "Mandopop"),
          artistResult(1581360981, "刘森", "Folk-Rock"),
          artistResult(1441422851, "刘森迪", "Mandopop"),
        ],
      });
    }
    if (url.pathname === "/lookup" && url.searchParams.get("id") === "1502984832") {
      return jsonResponse({
        resultCount: 5,
        results: [
          artistResult(1502984832, "刘森", "Mandopop"),
          releaseResult({
            artistId: 1502984832,
            collectionId: 2000000001,
            collectionName: "下一站 - Single",
            releaseDate: "2026-10-01T07:00:00Z",
          }),
          releaseResult({
            artistId: 1502984832,
            collectionId: 1895713664,
            collectionName: "天长地久 - Single",
            releaseDate: "2026-05-09T07:00:00Z",
          }),
          releaseResult({
            artistId: 1502984832,
            collectionId: 1888047163,
            collectionName: "无人保卫我 - Single",
            releaseDate: "2026-03-29T07:00:00Z",
          }),
          releaseResult({
            artistId: 1502984832,
            collectionId: 1861765849,
            collectionName: "华北浪革",
            releaseDate: "2021-07-11T07:00:00Z",
            trackCount: 10,
          }),
        ],
      });
    }
    if (url.pathname === "/lookup" && url.searchParams.get("id") === "1581360981") {
      return jsonResponse({
        resultCount: 2,
        results: [
          artistResult(1581360981, "刘森", "Folk-Rock"),
          releaseResult({
            artistId: 1581360981,
            collectionId: 1600000001,
            collectionName: "Fei Chai - Single",
            releaseDate: "2022-03-04T08:00:00Z",
          }),
        ],
      });
    }
    return jsonResponse({}, 404);
  };
  return { calls, fetchImpl };
}

test("Apple Music catalog disambiguates an artist with a known release", async () => {
  const fixture = liuSenFixture();
  const now = () => Date.parse("2026-09-02T05:00:00.000Z");
  const client = createAppleMusicCatalogClient({
    fetchImpl: fixture.fetchImpl,
    now,
  });
  const catalog = createAppleMusicCatalog({ client, now });

  const result = await catalog.findArtistReleases({
    artistName: "刘森",
    knownRelease: "华北浪革",
    limit: 4,
  });

  assert.equal(result.state, "resolved");
  assert.equal(result.artist.catalog_id, "1502984832");
  assert.equal(result.selection_basis, "exact_artist_name_and_known_release");
  assert.deepEqual(
    result.releases.map((release) => [
      release.title,
      release.release_type,
      release.release_date,
    ]),
    [
      ["天长地久", "single", "2026-05-09"],
      ["无人保卫我", "single", "2026-03-29"],
      ["华北浪革", "album", "2021-07-11"],
    ],
  );
  assert.deepEqual(
    result.upcoming_releases.map((release) => release.title),
    ["下一站"],
  );
  assert.deepEqual(
    [
      result.latest_released_single.title,
      result.latest_released_single.release_type,
      result.latest_released_single.release_date,
    ],
    ["天长地久", "single", "2026-05-09"],
  );
  assert.equal(result.source.storefront, "US");
  assert.equal(fixture.calls.length, 3);
  assert.equal(
    fixture.calls.some((url) =>
      [...url.searchParams.values()].some((value) => value.includes("华北浪革")),
    ),
    false,
    "the host-side release hint must not become an Apple request parameter",
  );

  await catalog.findArtistReleases({
    artistName: "刘森",
    knownRelease: "华北浪革",
    limit: 4,
  });
  assert.equal(fixture.calls.length, 3, "repeated reads should use the process cache");
});

test("Apple Music catalog resolves an explicit public artist identity without a name search", async () => {
  const fixture = liuSenFixture();
  const now = () => Date.parse("2026-09-02T05:00:00.000Z");
  const catalog = createAppleMusicCatalog({
    client: createAppleMusicCatalogClient({
      fetchImpl: fixture.fetchImpl,
      now,
    }),
    now,
  });

  const result = await catalog.findArtistReleases({
    artistName: "刘森",
    artistCatalogId: "1581360981",
    limit: 4,
  });

  assert.equal(result.state, "resolved");
  assert.equal(result.artist.catalog_id, "1581360981");
  assert.equal(result.selection_basis, "explicit_artist_catalog_page");
  assert.equal(result.latest_released_single.title, "Fei Chai");
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0].pathname, "/lookup");
  assert.equal(fixture.calls[0].searchParams.get("id"), "1581360981");
});

test("Apple Music catalog resolves a trusted cross-catalog ID without requiring the query alias", async () => {
  const fixture = liuSenFixture();
  const now = () => Date.parse("2026-09-02T05:00:00.000Z");
  const catalog = createAppleMusicCatalog({
    client: createAppleMusicCatalogClient({
      fetchImpl: fixture.fetchImpl,
      now,
    }),
    now,
  });

  const result = await catalog.findArtistReleasesByCatalogId({
    artistCatalogId: "1581360981",
    limit: 4,
  });

  assert.equal(result.state, "resolved");
  assert.equal(result.artist.name, "刘森");
  assert.equal(result.selection_basis, "explicit_artist_catalog_identity");
  assert.equal(result.latest_released_single.title, "Fei Chai");
  assert.deepEqual(result.query, { artist_catalog_id: "1581360981" });
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0].pathname, "/lookup");
});

test("Apple Music catalog rejects an explicit identity whose artist name differs", async () => {
  const now = () => Date.parse("2026-09-02T05:00:00.000Z");
  const catalog = createAppleMusicCatalog({
    now,
    client: {
      async searchTracks() {
        return [];
      },
      async searchArtists() {
        throw new Error("explicit identity must not fall back to name search");
      },
      async artistIdentity() {
        return {
          catalog_id: "909253",
          name: "Jack Johnson",
          catalog_url: "https://music.apple.com/us/artist/jack-johnson/909253",
        };
      },
      async artistReleases() {
        throw new Error("mismatched identity must not load releases");
      },
    },
  });

  const result = await catalog.findArtistReleases({
    artistName: "刘森",
    artistCatalogId: "909253",
  });

  assert.equal(result.state, "artist_identity_mismatch");
  assert.equal(result.artist.name, "Jack Johnson");
  assert.equal(result.query.artist_catalog_id, "909253");
});

test("latest released single survives the bounded general release list", async () => {
  const now = () => Date.parse("2026-09-03T05:00:00.000Z");
  const catalog = createAppleMusicCatalog({
    now,
    client: {
      async searchTracks() {
        return [];
      },
      async searchArtists() {
        return [
          {
            catalog_id: "1502984832",
            name: "刘森",
            catalog_url: "https://music.apple.com/us/artist/1502984832",
          },
        ];
      },
      async artistReleases() {
        return [
          {
            catalog_id: "2000000001",
            title: "Newest Album",
            collection_name: "Newest Album",
            artist_name: "刘森",
            release_type: "album",
            release_date: "2026-08-01",
          },
          {
            catalog_id: "2000000002",
            title: "Future Single",
            collection_name: "Future Single - Single",
            artist_name: "刘森",
            release_type: "single",
            release_date: "2026-10-01",
          },
          {
            catalog_id: "1895713664",
            title: "天长地久",
            collection_name: "天长地久 - Single",
            artist_name: "刘森",
            release_type: "single",
            release_date: "2026-05-09",
          },
        ];
      },
    },
  });

  const result = await catalog.findArtistReleases({
    artistName: "刘森",
    limit: 1,
  });

  assert.deepEqual(result.releases.map((release) => release.title), [
    "Newest Album",
  ]);
  assert.equal(result.upcoming_releases[0].title, "Future Single");
  assert.equal(result.latest_released_single.title, "天长地久");
  assert.equal(result.latest_released_single.release_type, "single");
});

test("Apple Music catalog refuses to guess between exact same-name artists", async () => {
  const fixture = liuSenFixture();
  const now = () => Date.parse("2026-09-02T05:00:00.000Z");
  const catalog = createAppleMusicCatalog({
    client: createAppleMusicCatalogClient({
      fetchImpl: fixture.fetchImpl,
      now,
    }),
    now,
  });

  const result = await catalog.findArtistReleases({ artistName: "刘森" });

  assert.equal(result.state, "ambiguous_artist");
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.artist.catalog_id),
    ["1502984832", "1581360981"],
  );
  assert.equal(fixture.calls.length, 1, "ambiguity should not fan out without a hint");
});

test("Apple Music catalog reports bounded provider errors", async () => {
  const client = createAppleMusicCatalogClient({
    fetchImpl: async () => jsonResponse({ error: "rate limited" }, 429),
    cacheTtlMs: 0,
  });

  await assert.rejects(
    () => client.searchArtists("刘森"),
    (error) => {
      assert.equal(error instanceof AppleMusicCatalogError, true);
      assert.equal(error.code, "apple_music_catalog_http_error");
      assert.equal(error.message, "Apple Music catalog returned HTTP 429.");
      assert.equal(error.message.includes("刘森"), false);
      return true;
    },
  );
});

test("Apple Music catalog interleaves opaque external track candidates", async () => {
  const calls = [];
  const shared = trackResult({
    trackId: 1700000001,
    trackName: "Shared Horizon",
    artistName: "Aster North",
    collectionName: "Night Forms",
  });
  const fetchImpl = async (input) => {
    const url = new URL(input);
    calls.push(url);
    const term = url.searchParams.get("term");
    assert.equal(url.searchParams.get("entity"), "song");
    assert.equal(url.searchParams.get("explicit"), "No");
    if (term === "ambient piano") {
      return jsonResponse({
        resultCount: 2,
        results: [
          shared,
          trackResult({
            trackId: 1700000002,
            trackName: "Quiet Geometry",
            artistName: "Mara Vale",
            collectionName: "Rooms at Night",
          }),
        ],
      });
    }
    return jsonResponse({
      resultCount: 2,
      results: [
        shared,
        trackResult({
          trackId: 1700000003,
          trackName: "Slow Meridian",
          artistName: "North Window",
          collectionName: "After Hours",
          primaryGenreName: "Jazz",
        }),
      ],
    });
  };
  const now = () => Date.parse("2026-09-02T05:00:00.000Z");
  const catalog = createAppleMusicCatalog({
    client: createAppleMusicCatalogClient({ fetchImpl, now }),
    now,
  });

  const result = await catalog.searchTracks({
    queries: ["ambient piano", "late night jazz"],
    limit: 3,
  });

  assert.equal(result.state, "resolved");
  assert.deepEqual(
    result.tracks.map((track) => track.title),
    ["Shared Horizon", "Quiet Geometry", "Slow Meridian"],
  );
  assert.deepEqual(result.tracks[0].matched_queries, [
    "ambient piano",
    "late night jazz",
  ]);
  assert.match(result.tracks[0].track_ref_id, /^[0-9a-f-]{36}$/u);
  assert.equal("catalog_id" in result.tracks[0], false);
  assert.notEqual(result.tracks[0].track_ref_id, "1700000001");
  assert.match(result.source.coverage, /not proof of personal fit/u);
  assert.equal(calls.length, 2);

  await catalog.searchTracks({
    queries: ["ambient piano", "late night jazz"],
    limit: 3,
  });
  assert.equal(calls.length, 2, "repeated discovery reads should use the cache");
});

test("Apple Music discovery candidates are diverse by release and artist", async () => {
  const fetchImpl = async () =>
    jsonResponse({
      resultCount: 5,
      results: [
        trackResult({
          trackId: 1800000001,
          trackName: "Movement One",
          artistName: "Single Artist",
          collectionName: "Shared Release",
        }),
        trackResult({
          trackId: 1800000002,
          trackName: "Movement Two",
          artistName: "Single Artist",
          collectionName: "Shared Release",
        }),
        trackResult({
          trackId: 1800000003,
          trackName: "Second Shape",
          artistName: "Single Artist",
          collectionName: "Second Release",
        }),
        trackResult({
          trackId: 1800000004,
          trackName: "Third Shape",
          artistName: "Single Artist",
          collectionName: "Third Release",
        }),
        trackResult({
          trackId: 1800000005,
          trackName: "Different Voice",
          artistName: "Another Artist",
          collectionName: "Separate Release",
        }),
      ],
    });
  const catalog = createAppleMusicCatalog({
    client: createAppleMusicCatalogClient({ fetchImpl }),
  });

  const result = await catalog.searchTracks({
    queries: ["night writing"],
    limit: 5,
  });

  assert.deepEqual(
    result.tracks.map((track) => [track.artist_credit, track.release]),
    [
      ["Single Artist", "Shared Release"],
      ["Single Artist", "Second Release"],
      ["Another Artist", "Separate Release"],
    ],
  );
});
