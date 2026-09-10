import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import {
  catalogHelpText,
  runCatalogCommand,
} from "../../src/surfaces/cli/catalog-command.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function captureStream() {
  let value = "";
  const stream = new PassThrough();
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    value += chunk;
  });
  stream.value = () => value;
  return stream;
}

function resolvedCatalogResult() {
  return {
    state: "resolved",
    source: {
      provider: "apple_music",
      catalog: "itunes_search_api",
      storefront: "US",
      retrieved_at: "2026-09-03T05:21:34.983Z",
      coverage:
        "Apple Music US storefront catalog only. This is not a claim about every music platform.",
    },
    query: {
      artist_name: "刘森",
      known_release: "华北浪革",
    },
    artist: {
      catalog_id: "1502984832",
      name: "刘森",
      catalog_url: "https://music.apple.com/us/artist/1502984832",
    },
    selection_basis: "exact_artist_name_and_known_release",
    releases: [
      {
        catalog_id: "1900000000",
        title: "Catalog Window",
        collection_name: "Catalog Window",
        artist_name: "刘森",
        release_type: "album",
        release_date: "2026-08-01",
      },
    ],
    latest_released_single: {
      catalog_id: "1895713664",
      title: "天长地久",
      collection_name: "天长地久 - Single",
      artist_name: "刘森",
      release_type: "single",
      release_date: "2026-05-09",
      catalog_url: "https://music.apple.com/us/album/1895713664",
    },
    upcoming_releases: [],
    candidates: [],
  };
}

test("catalog latest-single returns a bounded no-model result", async () => {
  const stdout = captureStream();
  const calls = [];
  const result = await runCatalogCommand({
    args: [
      "latest-single",
      "--artist",
      "刘森",
      "--known-release",
      "华北浪革",
    ],
    json: true,
    stdout,
    catalog: {
      async findArtistReleases(input) {
        calls.push(input);
        return resolvedCatalogResult();
      },
    },
  });

  assert.deepEqual(calls, [
    {
      artistName: "刘森",
      knownRelease: "华北浪革",
      limit: 8,
    },
  ]);
  assert.equal(result.state, "resolved");
  assert.equal(
    result.identity_selection_basis,
    "exact_artist_name_and_known_release",
  );
  assert.equal(result.latest_released_single.title, "天长地久");
  assert.equal(result.model_required, false);
  assert.equal(result.private_profile_read, false);
  assert.equal(result.private_profile_sent, false);
  assert.equal(result.external_effects, "none");
  assert.equal(JSON.stringify(result).includes("华北浪革"), false);
  assert.deepEqual(JSON.parse(stdout.value()), result);
});

test("catalog latest-single prints the dated storefront boundary", async () => {
  const stdout = captureStream();
  await runCatalogCommand({
    args: ["latest-single", "--artist", "刘森", "--known-release", "华北浪革"],
    stdout,
    catalog: {
      async findArtistReleases() {
        return resolvedCatalogResult();
      },
    },
  });

  assert.match(stdout.value(), /刘森 latest released single: 天长地久/u);
  assert.match(stdout.value(), /Released: 2026-05-09/u);
  assert.match(stdout.value(), /Retrieved: 2026-09-03T05:21:34\.983Z/u);
  assert.match(stdout.value(), /Apple Music US storefront catalog only/u);
  assert.match(stdout.value(), /did not read or send a personal profile/u);
  assert.match(stdout.value(), /No model provider was used/u);
});

test("catalog latest-single consumes one returned Apple Music artist page", async () => {
  const stdout = captureStream();
  const calls = [];
  const result = await runCatalogCommand({
    args: [
      "latest-single",
      "--artist",
      "刘森",
      "--artist-page",
      "https://music.apple.com/us/artist/%E5%88%98%E6%A3%AE/1502984832?uo=4",
    ],
    json: true,
    stdout,
    catalog: {
      async findArtistReleases(input) {
        calls.push(input);
        return {
          ...resolvedCatalogResult(),
          selection_basis: "explicit_artist_catalog_page",
        };
      },
    },
  });

  assert.deepEqual(calls, [
    {
      artistName: "刘森",
      artistCatalogId: "1502984832",
      limit: 8,
    },
  ]);
  assert.equal(result.query.artist_page_provided, true);
  assert.equal(result.identity_selection_basis, "explicit_artist_catalog_page");
  assert.equal(result.private_profile_read, false);
  assert.deepEqual(JSON.parse(stdout.value()), result);
});

test("catalog latest-single stops when the supplied page names another artist", async () => {
  const stdout = captureStream();
  const result = await runCatalogCommand({
    args: [
      "latest-single",
      "--artist",
      "刘森",
      "--artist-page",
      "https://music.apple.com/us/artist/jack-johnson/909253",
    ],
    stdout,
    catalog: {
      async findArtistReleases() {
        return {
          state: "artist_identity_mismatch",
          source: resolvedCatalogResult().source,
          query: {
            artist_name: "刘森",
            artist_catalog_id: "909253",
          },
          artist: {
            catalog_id: "909253",
            name: "Jack Johnson",
            catalog_url:
              "https://music.apple.com/us/artist/jack-johnson/909253",
          },
          candidates: [],
        };
      },
    },
  });

  assert.equal(result.state, "artist_identity_mismatch");
  assert.equal(result.query.artist_page_provided, true);
  assert.match(stdout.value(), /resolves to Jack Johnson, not 刘森/u);
  assert.match(stdout.value(), /Moondog did not continue/u);
  assert.doesNotMatch(stdout.value(), /latest released single:/u);
});

test("catalog latest-single follows one exact Wikidata alias across public identities", async () => {
  const stdout = captureStream();
  const nameSearchCalls = [];
  const identityLookupCalls = [];
  const resolverCalls = [];
  const result = await runCatalogCommand({
    args: ["latest-single", "--artist", "Hikki"],
    json: false,
    stdout,
    identityResolver: {
      async resolveArtist(artistName) {
        resolverCalls.push(artistName);
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
    },
    catalog: {
      async findArtistReleases(input) {
        nameSearchCalls.push(input);
        return {
          ...resolvedCatalogResult(),
          state: "ambiguous_artist",
          artist: undefined,
          selection_basis: undefined,
          latest_released_single: undefined,
          candidates: [],
        };
      },
      async findArtistReleasesByCatalogId(input) {
        identityLookupCalls.push(input);
        return {
          ...resolvedCatalogResult(),
          query: {
            artist_catalog_id: "18756224",
          },
          artist: {
            catalog_id: "18756224",
            name: "Hikaru Utada",
            catalog_url: "https://music.apple.com/us/artist/18756224",
          },
          selection_basis: "explicit_artist_catalog_identity",
          latest_released_single: {
            catalog_id: "1900000001",
            title: "Public Alias Proof",
            artist_name: "Hikaru Utada",
            release_type: "single",
            release_date: "2026-08-31",
            catalog_url: "https://music.apple.com/us/album/1900000001",
          },
        };
      },
    },
  });

  assert.deepEqual(nameSearchCalls, [
    {
      artistName: "Hikki",
      limit: 8,
    },
  ]);
  assert.deepEqual(resolverCalls, ["Hikki"]);
  assert.deepEqual(identityLookupCalls, [
    {
      artistCatalogId: "18756224",
      limit: 8,
    },
  ]);
  assert.equal(result.state, "resolved");
  assert.equal(result.artist.name, "Hikaru Utada");
  assert.equal(
    result.identity_selection_basis,
    "wikidata_exact_label_or_alias_cross_catalog",
  );
  assert.deepEqual(result.cross_catalog_identity, {
    provider: "wikidata",
    method: "exact_label_or_alias",
    state: "resolved",
    candidate_count: 1,
    properties: ["P434", "P2850"],
    license: "CC0",
    canonical_name: "Hikaru Utada",
    musicbrainz_artist_id: "b539e453-c4fe-47e3-8a07-8517eac74429",
    wikidata_ids: ["Q234598"],
    apple_music_artist_id: "18756224",
  });
  assert.equal(result.query.cross_catalog_identity_attempted, true);
  assert.match(stdout.value(), /Cross-catalog identity:/u);
  assert.match(stdout.value(), /MusicBrainz b539e453/u);
  assert.match(stdout.value(), /Apple Music 18756224/u);
  assert.doesNotMatch(stdout.value(), /did not guess/u);
});

test("catalog latest-single refuses multiple Apple identities from one exact alias", async () => {
  const stdout = captureStream();
  let identityLookupCount = 0;
  const result = await runCatalogCommand({
    args: ["latest-single", "--artist", "Hikki"],
    stdout,
    identityResolver: {
      async resolveArtist() {
        return {
          state: "resolved",
          artist_name: "Hikki",
          canonical_name: "Hikaru Utada",
          artist_mbid: "b539e453-c4fe-47e3-8a07-8517eac74429",
          wikidata_ids: ["Q234598"],
          apple_music_artist_ids: ["18756224", "123456789"],
          candidates: [
            {
              wikidata_id: "Q234598",
            },
          ],
        };
      },
    },
    catalog: {
      async findArtistReleases() {
        return {
          ...resolvedCatalogResult(),
          state: "ambiguous_artist",
          artist: undefined,
          selection_basis: undefined,
          latest_released_single: undefined,
          candidates: [
            {
              artist: {
                name: "Hikki",
                catalog_url: "https://music.apple.com/us/artist/100000001",
              },
              recent_releases: [],
            },
            {
              artist: {
                name: "Hikki",
                catalog_url: "https://music.apple.com/us/artist/100000002",
              },
              recent_releases: [],
            },
          ],
        };
      },
      async findArtistReleasesByCatalogId() {
        identityLookupCount += 1;
        throw new Error("The fail-closed path must not look up either identity.");
      },
    },
  });

  assert.equal(identityLookupCount, 0);
  assert.equal(result.state, "ambiguous_artist");
  assert.equal(
    result.cross_catalog_identity.state,
    "apple_music_identity_ambiguous",
  );
  assert.deepEqual(result.cross_catalog_identity.apple_music_artist_ids, [
    "18756224",
    "123456789",
  ]);
  assert.match(stdout.value(), /more than one linked Apple Music artist identity/u);
  assert.match(stdout.value(), /Moondog did not guess/u);
  assert.doesNotMatch(stdout.value(), /latest released single:/u);
});

test("catalog latest-single retains Apple candidates when Wikidata is unavailable", async () => {
  const stdout = captureStream();
  const providerError = new Error("Wikidata could not be reached.");
  providerError.name = "OpenMusicSimilarityError";
  providerError.provider = "wikidata";
  providerError.code = "wikidata_request_failed";
  const result = await runCatalogCommand({
    args: ["latest-single", "--artist", "Hikki"],
    stdout,
    identityResolver: {
      async resolveArtist() {
        throw providerError;
      },
    },
    catalog: {
      async findArtistReleases() {
        return {
          ...resolvedCatalogResult(),
          state: "ambiguous_artist",
          artist: undefined,
          selection_basis: undefined,
          latest_released_single: undefined,
          candidates: [],
        };
      },
    },
  });

  assert.equal(result.state, "ambiguous_artist");
  assert.equal(result.cross_catalog_identity.state, "unavailable");
  assert.match(stdout.value(), /Wikidata was unavailable/u);
  assert.match(stdout.value(), /retained the original catalog result/u);
});

test("catalog latest-single retains Apple candidates when a linked ID is stale", async () => {
  const stdout = captureStream();
  const result = await runCatalogCommand({
    args: ["latest-single", "--artist", "Hikki"],
    stdout,
    identityResolver: {
      async resolveArtist() {
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
    },
    catalog: {
      async findArtistReleases() {
        return {
          ...resolvedCatalogResult(),
          state: "ambiguous_artist",
          artist: undefined,
          selection_basis: undefined,
          latest_released_single: undefined,
          candidates: [],
        };
      },
      async findArtistReleasesByCatalogId() {
        return {
          state: "not_found",
          source: resolvedCatalogResult().source,
          query: {
            artist_catalog_id: "18756224",
          },
          candidates: [],
        };
      },
    },
  });

  assert.equal(result.state, "ambiguous_artist");
  assert.equal(
    result.cross_catalog_identity.state,
    "apple_music_identity_not_found",
  );
  assert.match(stdout.value(), /not found in the US storefront/u);
  assert.match(stdout.value(), /retained the original catalog result/u);
});

test("catalog latest-single rejects a linked lookup that returns another identity", async () => {
  const stdout = captureStream();
  const result = await runCatalogCommand({
    args: ["latest-single", "--artist", "Hikki"],
    stdout,
    identityResolver: {
      async resolveArtist() {
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
    },
    catalog: {
      async findArtistReleases() {
        return {
          ...resolvedCatalogResult(),
          state: "ambiguous_artist",
          artist: undefined,
          selection_basis: undefined,
          latest_released_single: undefined,
          candidates: [],
        };
      },
      async findArtistReleasesByCatalogId() {
        return {
          ...resolvedCatalogResult(),
          artist: {
            catalog_id: "999999999",
            name: "Another artist",
          },
          selection_basis: "explicit_artist_catalog_identity",
        };
      },
    },
  });

  assert.equal(result.state, "ambiguous_artist");
  assert.equal(
    result.cross_catalog_identity.state,
    "apple_music_identity_mismatch",
  );
  assert.match(stdout.value(), /did not return the uniquely linked artist identity/u);
  assert.match(stdout.value(), /retained the original catalog result/u);
});

test("catalog latest-single derives withheld disambiguation from an explicit local archive", async () => {
  const stdout = captureStream();
  const catalogCalls = [];
  const hintCalls = [];
  const result = await runCatalogCommand({
    args: ["latest-single", "--artist", "刘森"],
    archivePath: "/private/spotify-extended.zip",
    json: true,
    stdout,
    deriveArchiveHints: async (input) => {
      hintCalls.push(input);
      return {
        source_format: "spotify_extended_streaming_history_music_v1",
        exact_artist_track_count: 12,
        exact_artist_event_count: 37,
        release_titles: ["Shared Title", "华北浪革"],
      };
    },
    catalog: {
      async findArtistReleases(input) {
        catalogCalls.push(input);
        if (input.knownRelease === "Shared Title") {
          return {
            ...resolvedCatalogResult(),
            state: "ambiguous_artist",
            artist: undefined,
            selection_basis: undefined,
            latest_released_single: undefined,
            candidates: [],
          };
        }
        return resolvedCatalogResult();
      },
    },
  });

  assert.deepEqual(hintCalls, [
    {
      archivePath: "/private/spotify-extended.zip",
      artistName: "刘森",
      maximumHints: 3,
    },
  ]);
  assert.deepEqual(
    catalogCalls.map((call) => call.knownRelease),
    ["Shared Title", "华北浪革"],
  );
  assert.equal(result.state, "resolved");
  assert.equal(
    result.identity_selection_basis,
    "exact_artist_name_and_withheld_local_history_release",
  );
  assert.equal(result.private_archive_read, true);
  assert.equal(result.private_archive_sent, false);
  assert.deepEqual(result.local_archive_evidence, {
    source_format: "spotify_extended_streaming_history_music_v1",
    private_values_withheld: true,
    release_hints_considered: 2,
    selected_release_withheld: true,
    persisted: false,
  });
  assert.equal(JSON.stringify(result).includes('"exact_artist_track_count"'), false);
  assert.equal(JSON.stringify(result).includes('"exact_artist_event_count"'), false);
  assert.equal(JSON.stringify(result).includes("Shared Title"), false);
  assert.equal(JSON.stringify(result).includes("华北浪革"), false);
  assert.equal(JSON.stringify(result).includes("spotify-extended.zip"), false);
  assert.deepEqual(JSON.parse(stdout.value()), result);
});

test("catalog latest-single fails closed on same-name ambiguity", async () => {
  const stdout = captureStream();
  const result = await runCatalogCommand({
    args: ["latest-single", "--artist", "刘森"],
    stdout,
    catalog: {
      async findArtistReleases() {
        return {
          ...resolvedCatalogResult(),
          state: "ambiguous_artist",
          artist: undefined,
          selection_basis: undefined,
          releases: undefined,
          latest_released_single: undefined,
          candidates: [
            {
              artist: {
                catalog_id: "1502984832",
                name: "刘森",
                catalog_url: "https://music.apple.com/us/artist/1502984832",
              },
              recent_releases: [
                {
                  title: "天长地久",
                  artist_name: "刘森",
                  release_type: "single",
                  release_date: "2026-05-09",
                },
              ],
            },
            {
              artist: {
                catalog_id: "1581360981",
                name: "刘森",
                catalog_url: "https://music.apple.com/us/artist/1581360981",
              },
              recent_releases: [
                {
                  title: "Fei Chai",
                  artist_name: "刘森",
                  release_type: "single",
                  release_date: "2022-03-04",
                },
              ],
            },
          ],
        };
      },
    },
  });

  assert.equal(result.state, "ambiguous_artist");
  assert.equal(result.candidate_count, 2);
  assert.equal("latest_released_single" in result, false);
  assert.match(stdout.value(), /multiple exact-name artist candidates \(2\)/u);
  assert.match(stdout.value(), /music\.apple\.com\/us\/artist\/1502984832/u);
  assert.match(stdout.value(), /--artist-page/u);
  assert.doesNotMatch(stdout.value(), /latest released single:/u);
});

test("catalog command validates its exact argument surface", async () => {
  assert.match(catalogHelpText(), /catalog latest-single --artist/u);
  assert.match(catalogHelpText(), /--artist-page/u);
  assert.match(catalogHelpText(), /exact Wikidata label or alias/u);
  await assert.rejects(
    runCatalogCommand({ args: ["latest-single"] }),
    /--artist/u,
  );
  await assert.rejects(
    runCatalogCommand({
      args: ["latest-single", "--artist", "one", "--artist", "two"],
    }),
    /only once/u,
  );
  await assert.rejects(
    runCatalogCommand({
      args: ["latest-single", "--artist", "刘森", "extra"],
    }),
    /Usage: moondog catalog latest-single/u,
  );
  await assert.rejects(
    runCatalogCommand({
      args: ["latest-single", "--artist", "刘森", "--known-release", "华北浪革"],
      archivePath: "/private/history.zip",
    }),
    /only one identity hint/u,
  );
  await assert.rejects(
    runCatalogCommand({
      args: [
        "latest-single",
        "--artist",
        "刘森",
        "--artist-page",
        "https://example.com/artist/1502984832",
      ],
    }),
    /artist page is invalid/u,
  );
  await assert.rejects(
    runCatalogCommand({
      args: [
        "latest-single",
        "--artist",
        "刘森",
        "--artist-page",
        "https://music.apple.com/us/artist/%E5%88%98%E6%A3%AE/1502984832",
        "--known-release",
        "华北浪革",
      ],
    }),
    /only one identity hint/u,
  );
  await assert.rejects(
    runCatalogCommand({
      args: ["latest-single", "--artist", "Hikki"],
      identityResolver: {
        async resolveArtist() {
          return {
            state: "not_found",
            artist_name: "Another artist",
            candidates: [],
          };
        },
      },
      catalog: {
        async findArtistReleases() {
          return {
            ...resolvedCatalogResult(),
            state: "ambiguous_artist",
            artist: undefined,
            selection_basis: undefined,
            latest_released_single: undefined,
            candidates: [],
          };
        },
      },
    }),
    /cross-catalog artist identity is invalid/u,
  );
});

test("real catalog help reads no local profile and needs no model", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-catalog-help-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const stateRoot = path.join(root, "state");
  const configRoot = path.join(root, "config");
  const result = await execFileAsync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      path.join(repositoryRoot, "scripts/moondog.mjs"),
      "catalog",
      "help",
    ],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        MOONDOG_STATE_HOME: stateRoot,
        MOONDOG_CONFIG_HOME: configRoot,
        NO_COLOR: "1",
      },
      encoding: "utf8",
      timeout: 30_000,
    },
  );

  assert.match(result.stdout, /moondog catalog latest-single/u);
  assert.equal(result.stderr, "");
  await assert.rejects(access(stateRoot), /ENOENT/u);
  await assert.rejects(access(configRoot), /ENOENT/u);
});
