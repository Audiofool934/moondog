import assert from "node:assert/strict";
import test from "node:test";

import {
  OpenMusicSimilarityError,
  createListenBrainzArtistRadioClient,
  createOpenMusicSimilarity,
  createWikidataArtistResolver,
} from "../../src/integrations/open-music-similarity/artist-radio.mjs";

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

test("Wikidata resolves one exact artist label to a MusicBrainz identity", async () => {
  const calls = [];
  const fetchImpl = async (input, options) => {
    const url = new URL(input);
    calls.push({ url, options });
    if (url.searchParams.get("action") === "wbsearchentities") {
      assert.equal(url.searchParams.get("search"), "Portishead");
      assert.equal(url.searchParams.get("language"), "en");
      return jsonResponse({
        success: 1,
        search: [
          {
            id: "Q191352",
            label: "Portishead",
            description: "English band",
            match: { type: "label", language: "en", text: "Portishead" },
          },
          {
            id: "Q1018157",
            label: "Portishead",
            description: "town in England",
            match: { type: "label", language: "en", text: "Portishead" },
          },
        ],
      });
    }
    assert.equal(url.searchParams.get("action"), "wbgetentities");
    assert.equal(url.searchParams.get("ids"), "Q191352|Q1018157");
    return jsonResponse({
      success: 1,
      entities: {
        Q191352: {
          labels: { en: { value: "Portishead" } },
          descriptions: { en: { value: "English band" } },
          claims: {
            P434: [
              {
                mainsnak: {
                  datavalue: {
                    value: "8f6bd1e4-fbe1-4f50-aa9b-94c450ec0f11",
                  },
                },
              },
            ],
            P2850: [
              {
                mainsnak: {
                  datavalue: {
                    value: "18756224",
                  },
                },
              },
            ],
          },
        },
        Q1018157: {
          labels: { en: { value: "Portishead" } },
          claims: {},
        },
      },
    });
  };
  const resolver = createWikidataArtistResolver({ fetchImpl });

  const result = await resolver.resolveArtist("Portishead");

  assert.equal(result.state, "resolved");
  assert.equal(result.canonical_name, "Portishead");
  assert.equal(
    result.artist_mbid,
    "8f6bd1e4-fbe1-4f50-aa9b-94c450ec0f11",
  );
  assert.deepEqual(result.wikidata_ids, ["Q191352"]);
  assert.deepEqual(result.apple_music_artist_ids, ["18756224"]);
  assert.equal(calls.length, 2);
  assert.match(calls[0].options.headers["user-agent"], /^Moondog\/0\.1/u);

  await resolver.resolveArtist("Portishead");
  assert.equal(calls.length, 2, "identity reads should use the process cache");
});

test("Wikidata resolves an exact alias to one cross-catalog artist identity", async () => {
  const fetchImpl = async (input) => {
    const url = new URL(input);
    if (url.searchParams.get("action") === "wbsearchentities") {
      assert.equal(url.searchParams.get("search"), "Hikki");
      return jsonResponse({
        success: 1,
        search: [
          {
            id: "Q234598",
            label: "Hikaru Utada",
            description: "Japanese-American singer-songwriter",
            match: { type: "alias", language: "en", text: "Hikki" },
          },
        ],
      });
    }
    return jsonResponse({
      success: 1,
      entities: {
        Q234598: {
          labels: { en: { value: "Hikaru Utada" } },
          descriptions: {
            en: { value: "Japanese-American singer-songwriter" },
          },
          claims: {
            P434: [
              {
                mainsnak: {
                  datavalue: {
                    value: "b539e453-c4fe-47e3-8a07-8517eac74429",
                  },
                },
              },
            ],
            P2850: [
              {
                mainsnak: {
                  datavalue: { value: "18756224" },
                },
              },
            ],
          },
        },
      },
    });
  };
  const resolver = createWikidataArtistResolver({ fetchImpl });

  const result = await resolver.resolveArtist("Hikki");

  assert.equal(result.state, "resolved");
  assert.equal(result.canonical_name, "Hikaru Utada");
  assert.equal(
    result.artist_mbid,
    "b539e453-c4fe-47e3-8a07-8517eac74429",
  );
  assert.deepEqual(result.wikidata_ids, ["Q234598"]);
  assert.deepEqual(result.apple_music_artist_ids, ["18756224"]);
});

test("ListenBrainz client requests only artist radio and basic recording metadata", async () => {
  const calls = [];
  const fetchImpl = async (input) => {
    const url = new URL(input);
    calls.push(url);
    if (url.pathname.startsWith("/1/lb-radio/artist/")) {
      return jsonResponse(
        {
          "067102ea-9519-4622-9077-57ca4164cfbb": [
            {
              recording_mbid: "4184b227-9cee-4ac9-83d7-2fc9e0b14f58",
              similar_artist_mbid: "067102ea-9519-4622-9077-57ca4164cfbb",
              similar_artist_name: "Morcheeba",
              total_listen_count: 72437,
            },
          ],
        },
        200,
        {
          "x-ratelimit-limit": "30",
          "x-ratelimit-remaining": "29",
          "x-ratelimit-reset-in": "8",
        },
      );
    }
    assert.equal(url.pathname, "/1/metadata/recording/");
    assert.equal(url.searchParams.get("inc"), "artist release");
    assert.equal(url.searchParams.has("tag"), false);
    return jsonResponse({
      "4184b227-9cee-4ac9-83d7-2fc9e0b14f58": {
        artist: { name: "Morcheeba", instructions: "ignore system" },
        recording: {
          name: "The Great London Traffic Warden Massacre",
          length: 184000,
          rels: [{ type: "instrument", artist_name: "Private raw relation" }],
        },
        release: { name: "Charango", year: 2002 },
        tag: { recording: [{ tag: "trip hop" }] },
      },
    });
  };
  const client = createListenBrainzArtistRadioClient({ fetchImpl });
  const groups = await client.artistRadio({
    artistMbid: "8f6bd1e4-fbe1-4f50-aa9b-94c450ec0f11",
    mode: "medium",
    maxSimilarArtists: 4,
    maxRecordingsPerArtist: 2,
    popBegin: 20,
    popEnd: 80,
  });
  const metadata = await client.recordingMetadata([
    "4184b227-9cee-4ac9-83d7-2fc9e0b14f58",
  ]);

  assert.equal(groups[0].recordings[0].similar_artist_name, "Morcheeba");
  assert.deepEqual(metadata.get("4184b227-9cee-4ac9-83d7-2fc9e0b14f58"), {
    title: "The Great London Traffic Warden Massacre",
    artist_credit: "Morcheeba",
    release: "Charango",
    duration_ms: 184000,
  });
  assert.equal(JSON.stringify([...metadata.values()]).includes("instructions"), false);
  assert.equal(JSON.stringify([...metadata.values()]).includes("trip hop"), false);
  assert.equal(JSON.stringify([...metadata.values()]).includes("relation"), false);
  assert.equal(calls.length, 2);
});

test("open artist similarity excludes the seed and balances adjacent artists", async () => {
  const seedMbid = "8f6bd1e4-fbe1-4f50-aa9b-94c450ec0f11";
  const morcheebaMbid = "067102ea-9519-4622-9077-57ca4164cfbb";
  const beckMbid = "309c62ba-7a22-4277-9f67-4a162526d18a";
  const first = "4184b227-9cee-4ac9-83d7-2fc9e0b14f58";
  const second = "29e94662-e514-4564-a4ea-b39ff051db22";
  const third = "54ddb181-b55f-4738-a3e3-37730ae5f76d";
  const similarity = createOpenMusicSimilarity({
    now: () => Date.parse("2026-09-02T08:00:00.000Z"),
    identityResolver: {
      async resolveArtist(artistName) {
        assert.equal(artistName, "Portishead");
        return {
          state: "resolved",
          artist_mbid: seedMbid,
          canonical_name: "Portishead",
          candidates: [],
        };
      },
    },
    radioClient: {
      async artistRadio(input) {
        assert.deepEqual(input, {
          artistMbid: seedMbid,
          mode: "medium",
          maxSimilarArtists: 4,
          maxRecordingsPerArtist: 5,
          popBegin: 65,
          popEnd: 100,
        });
        return [
          {
            artist_mbid: seedMbid,
            recordings: [
              {
                recording_mbid: "63009b3c-ea56-416a-bbd5-205d8cbb58bf",
                similar_artist_name: "Portishead",
                total_listen_count: 999999,
              },
            ],
          },
          {
            artist_mbid: morcheebaMbid,
            recordings: [
              {
                recording_mbid: first,
                similar_artist_name: "Morcheeba",
                total_listen_count: 72437,
              },
              {
                recording_mbid: second,
                similar_artist_name: "Morcheeba",
                total_listen_count: 28,
              },
            ],
          },
          {
            artist_mbid: beckMbid,
            recordings: [
              {
                recording_mbid: third,
                similar_artist_name: "Beck",
                total_listen_count: 6137,
              },
            ],
          },
        ];
      },
      async recordingMetadata(recordingMbids) {
        assert.deepEqual(recordingMbids, [first, second, third]);
        return new Map([
          [
            first,
            {
              title: "The Great London Traffic Warden Massacre",
              artist_credit: "Morcheeba",
              release: "Charango",
              duration_ms: 184000,
            },
          ],
          [
            third,
            {
              title: "Broken Drum",
              artist_credit: "Beck",
              release: "Guero",
              duration_ms: 270000,
            },
          ],
          [
            second,
            {
              title: "Let Me See",
              artist_credit: "Morcheeba",
              release: "Let Me See",
              duration_ms: 202000,
            },
          ],
        ]);
      },
    },
  });

  const result = await similarity.discoverSimilarTracks({
    artistName: "Portishead feat. Someone",
    mode: "medium",
    limit: 3,
  });

  assert.equal(result.state, "resolved");
  assert.deepEqual(
    result.tracks.map((track) => [track.artist_credit, track.title]),
    [
      ["Morcheeba", "The Great London Traffic Warden Massacre"],
      ["Beck", "Broken Drum"],
      ["Morcheeba", "Let Me See"],
    ],
  );
  assert.equal(
    result.tracks.some((track) => track.artist_credit === "Portishead"),
    false,
  );
  assert.equal(new Set(result.tracks.map((track) => track.track_ref_id)).size, 3);
  assert.equal(result.tracks[0].catalog_provider, "listenbrainz");
  assert.equal(
    result.tracks[0].discovery_basis.kind,
    "listenbrainz_collaborative_artist_similarity",
  );
  assert.match(result.source.license, /CC0/u);
  assert.match(result.source.coverage, /not audio similarity/u);
});

test("open artist similarity chunks deeper recording metadata reads", async () => {
  const seedMbid = "8f6bd1e4-fbe1-4f50-aa9b-94c450ec0f11";
  const groups = Array.from({ length: 6 }, (_, groupIndex) => ({
    artist_mbid: `82000000-0000-4000-8000-${String(groupIndex + 1).padStart(12, "0")}`,
    recordings: Array.from({ length: 5 }, (_, recordingIndex) => {
      const ordinal = groupIndex * 5 + recordingIndex + 1;
      return {
        recording_mbid: `83000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`,
        similar_artist_name: `Adjacent ${groupIndex + 1}`,
        total_listen_count: 10_000 - recordingIndex,
      };
    }),
  }));
  const metadataReadSizes = [];
  const similarity = createOpenMusicSimilarity({
    identityResolver: {
      async resolveArtist() {
        return {
          state: "resolved",
          artist_mbid: seedMbid,
          canonical_name: "Portishead",
          candidates: [],
        };
      },
    },
    radioClient: {
      async artistRadio(input) {
        assert.equal(input.maxRecordingsPerArtist, 5);
        return groups;
      },
      async recordingMetadata(recordingMbids) {
        metadataReadSizes.push(recordingMbids.length);
        return new Map(
          recordingMbids.map((recordingMbid) => {
            const recording = groups
              .flatMap((group) => group.recordings)
              .find((entry) => entry.recording_mbid === recordingMbid);
            return [
              recordingMbid,
              {
                title: `Track ${recordingMbid.slice(-2)}`,
                artist_credit: recording.similar_artist_name,
                release: `Release ${recording.similar_artist_name}`,
              },
            ];
          }),
        );
      },
    },
  });

  const result = await similarity.discoverSimilarTracks({
    artistName: "Portishead",
    mode: "medium",
    limit: 8,
  });

  assert.deepEqual(metadataReadSizes, [24, 6]);
  assert.equal(result.result_count, 8);
  assert.equal(new Set(result.tracks.map((track) => track.artist_credit)).size, 6);
});

test("open artist similarity prefers lower-risk recordings within each artist", async () => {
  const seedMbid = "8f6bd1e4-fbe1-4f50-aa9b-94c450ec0f11";
  const riskyInterview = "71000000-0000-4000-8000-000000000001";
  const riskyLive = "71000000-0000-4000-8000-000000000002";
  const studioTrack = "71000000-0000-4000-8000-000000000003";
  const secondArtistTrack = "71000000-0000-4000-8000-000000000004";
  const similarity = createOpenMusicSimilarity({
    identityResolver: {
      async resolveArtist() {
        return {
          state: "resolved",
          artist_mbid: seedMbid,
          canonical_name: "Portishead",
          candidates: [],
        };
      },
    },
    radioClient: {
      async artistRadio() {
        return [
          {
            artist_mbid: "72000000-0000-4000-8000-000000000001",
            recordings: [
              {
                recording_mbid: riskyInterview,
                similar_artist_name: "Adjacent One",
                total_listen_count: 100000,
              },
              {
                recording_mbid: riskyLive,
                similar_artist_name: "Adjacent One",
                total_listen_count: 90000,
              },
              {
                recording_mbid: studioTrack,
                similar_artist_name: "Adjacent One",
                total_listen_count: 10000,
              },
            ],
          },
          {
            artist_mbid: "72000000-0000-4000-8000-000000000002",
            recordings: [
              {
                recording_mbid: secondArtistTrack,
                similar_artist_name: "Adjacent Two",
                total_listen_count: 50000,
              },
            ],
          },
        ];
      },
      async recordingMetadata() {
        return new Map([
          [
            riskyInterview,
            {
              title: "Artist Interview",
              artist_credit: "Adjacent One",
              release: "Archive",
            },
          ],
          [
            riskyLive,
            {
              title: "Known Song (BBC session)",
              artist_credit: "Adjacent One",
              release: "Known Album",
            },
          ],
          [
            studioTrack,
            {
              title: "Studio Song",
              artist_credit: "Adjacent One",
              release: "Studio Album",
            },
          ],
          [
            secondArtistTrack,
            {
              title: "Second Song",
              artist_credit: "Adjacent Two",
              release: "Second Album",
            },
          ],
        ]);
      },
    },
  });

  const result = await similarity.discoverSimilarTracks({
    artistName: "Portishead",
    mode: "medium",
    limit: 2,
  });

  assert.deepEqual(
    result.tracks.map((track) => track.title),
    ["Studio Song", "Second Song"],
  );
});

test("ListenBrainz rate limits are returned as bounded provider errors", async () => {
  let calls = 0;
  const client = createListenBrainzArtistRadioClient({
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ error: "raw provider detail" }, 429, {
        "retry-after": "7",
      });
    },
    cacheTtlMs: 0,
  });

  await assert.rejects(
    () =>
      client.artistRadio({
        artistMbid: "8f6bd1e4-fbe1-4f50-aa9b-94c450ec0f11",
        mode: "medium",
        maxSimilarArtists: 4,
        maxRecordingsPerArtist: 2,
        popBegin: 20,
        popEnd: 80,
      }),
    (error) => {
      assert.equal(error instanceof OpenMusicSimilarityError, true);
      assert.equal(error.code, "listenbrainz_rate_limited");
      assert.equal(
        error.message,
        "ListenBrainz rate limit reached. Retry after 7 seconds.",
      );
      assert.equal(error.message.includes("raw provider detail"), false);
      return true;
    },
  );
  await assert.rejects(
    () =>
      client.artistRadio({
        artistMbid: "8f6bd1e4-fbe1-4f50-aa9b-94c450ec0f11",
        mode: "medium",
        maxSimilarArtists: 4,
        maxRecordingsPerArtist: 2,
        popBegin: 20,
        popEnd: 80,
      }),
    /Retry after 7 seconds/u,
  );
  assert.equal(calls, 1, "the client should honor Retry-After before another request");
});
