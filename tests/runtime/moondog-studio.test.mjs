import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { openListeningHistoryStore } from "../../src/profile/listening-history-store.mjs";
import { createPublicTasteprintDemoProfile } from "../../src/demo/moondog-tasteprint-demo.mjs";
import { startMoondogStudio } from "../../src/surfaces/web/studio.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

function extendedRecord(overrides = {}) {
  return {
    ts: "2026-08-29T04:00:42Z",
    ms_played: 305_000,
    master_metadata_track_name: "Roads",
    master_metadata_album_artist_name: "Portishead",
    master_metadata_album_album_name: "Dummy",
    spotify_track_uri: "spotify:track:1234567890123456789012",
    reason_start: "clickrow",
    reason_end: "trackdone",
    shuffle: false,
    skipped: false,
    offline: false,
    incognito_mode: false,
    ip_addr: "PRIVATE_IP_SENTINEL",
    platform: "PRIVATE_PLATFORM_SENTINEL",
    ...overrides,
  };
}

async function createExtendedArchive(root) {
  const dataRoot = path.join(root, "Spotify Extended Streaming History");
  const archivePath = path.join(root, "spotify-extended.zip");
  await mkdir(dataRoot);
  await writeFile(
    path.join(dataRoot, "Streaming_History_Audio_2026.json"),
    JSON.stringify([
      extendedRecord(),
      extendedRecord({
        ts: "2024-04-19T12:00:00Z",
        ms_played: 240_000,
        master_metadata_track_name: "Glory Box",
        spotify_track_uri: "spotify:track:abcdefghijklmnopqrstuv",
      }),
    ]),
  );
  await execFileAsync(
    "/usr/bin/zip",
    ["-q", "-r", archivePath, "Spotify Extended Streaming History"],
    { cwd: root },
  );
  return archivePath;
}

async function createAccountArchive(root) {
  const dataRoot = path.join(root, "Spotify Account Data");
  const archivePath = path.join(root, "spotify-account-data.zip");
  await mkdir(dataRoot);
  await writeFile(
    path.join(dataRoot, "StreamingHistory_music_0.json"),
    JSON.stringify([
      {
        endTime: "2026-08-29 04:00",
        artistName: "Portishead",
        trackName: "Roads",
        msPlayed: 305_000,
      },
      {
        endTime: "2024-04-19 12:00",
        artistName: "Portishead",
        trackName: "Glory Box",
        msPlayed: 240_000,
      },
    ]),
  );
  await execFileAsync(
    "/usr/bin/zip",
    ["-q", "-r", archivePath, "Spotify Account Data"],
    { cwd: root },
  );
  return archivePath;
}

async function createSupplementalAccountArchive(root) {
  const supplementalRoot = path.join(root, "supplemental-account");
  const dataRoot = path.join(supplementalRoot, "Spotify Account Data");
  const archivePath = path.join(root, "spotify-account-data-supplemental.zip");
  await mkdir(dataRoot, { recursive: true });
  await writeFile(
    path.join(dataRoot, "StreamingHistory_music_0.json"),
    JSON.stringify([
      {
        endTime: "2025-07-01 12:00",
        artistName: "Portishead",
        trackName: "Roads",
        msPlayed: 90_000,
      },
    ]),
  );
  await execFileAsync(
    "/usr/bin/zip",
    ["-q", "-r", archivePath, "Spotify Account Data"],
    { cwd: supplementalRoot },
  );
  return archivePath;
}

function listenBrainzHistory() {
  return {
    payload: {
      count: 2,
      user_id: "PRIVATE_LISTENBRAINZ_STUDIO_SENTINEL",
      listens: [
        {
          listened_at: 1_730_419_200,
          recording_msid: "fd0cad33-ea33-453b-8155-1292379277db",
          user_name: "PRIVATE_LISTENBRAINZ_STUDIO_SENTINEL",
          track_metadata: {
            artist_name: "Björk",
            track_name: "Jóga",
            release_name: "Homogenic",
            additional_info: {
              duration_ms: 307_000,
              duration_played: 280,
              origin_url: "https://private.example/studio-sentinel",
            },
            mbid_mapping: {
              recording_mbid: "30d08f4c-d825-4ae1-b79c-44242cddd7c0",
            },
          },
        },
        {
          listened_at: 1_733_011_200,
          track_metadata: {
            artist_name: "Massive Attack",
            track_name: "Teardrop",
          },
        },
      ],
    },
  };
}

function studioSession(studio) {
  return new URL(studio.url).searchParams.get("session");
}

async function postArchive(studio, archive, headers = {}) {
  return fetch(new URL("/api/import", studio.origin), {
    method: "POST",
    headers: {
      "Content-Type": "application/zip",
      Origin: studio.origin,
      "X-Moondog-Session": studioSession(studio),
      ...headers,
    },
    body: archive,
  });
}

async function postHistoryJson(studio, history, headers = {}) {
  return fetch(new URL("/api/import", studio.origin), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: studio.origin,
      "X-Moondog-Session": studioSession(studio),
      ...headers,
    },
    body: Buffer.isBuffer(history) ? history : JSON.stringify(history),
  });
}

async function getProfile(studio, headers = {}) {
  return fetch(new URL("/api/profile", studio.origin), {
    headers: {
      "X-Moondog-Session": studioSession(studio),
      ...headers,
    },
  });
}

async function postProfileJson(studio, pathname, value, headers = {}) {
  return fetch(new URL(pathname, studio.origin), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: studio.origin,
      "X-Moondog-Session": studioSession(studio),
      ...headers,
    },
    body: JSON.stringify(value),
  });
}

async function directoryEntries(directory) {
  try {
    return await readdir(directory);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

test("Studio page is loopback-only, token-protected, and carries no cross-origin capability", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-studio-page-"));
  const studio = await startMoondogStudio({
    environment: {
      ...process.env,
      MOONDOG_STATE_HOME: path.join(root, "state"),
      MOONDOG_CONFIG_HOME: path.join(root, "config"),
    },
    temporaryRoot: path.join(root, "temporary"),
  });
  context.after(async () => {
    await studio.close();
    await rm(root, { recursive: true, force: true });
  });

  assert.match(studio.origin, /^http:\/\/127\.0\.0\.1:[0-9]+$/u);
  const missingToken = await fetch(studio.origin);
  assert.equal(missingToken.status, 404);
  assert.equal(missingToken.headers.get("access-control-allow-origin"), null);

  const page = await fetch(studio.url);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /connect-src 'self'/u);
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/u);
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  assert.equal(page.headers.get("cache-control"), "no-store, max-age=0");
  assert.match(html, /Your history,<br>now useful\./u);
  assert.match(html, /No cloud upload, provider call, or model/u);
  assert.match(html, /The working copy is removed after import/u);
  assert.match(html, /Import and build Tasteprint/u);
  assert.match(html, /Spotify ZIP or ListenBrainz JSON/u);
  assert.match(html, /accept="\.zip,\.json,application\/zip,application\/json"/u);
  assert.match(html, /id="hero-demo-action"/u);
  assert.match(html, /Preview the fictional recap card/u);
  assert.match(html, /<link rel="icon" href="\/brand\.png\?session=[A-Za-z0-9_-]+" type="image\/png">/u);
  assert.match(html, /id="result-card-link"/u);
  assert.match(html, /id="profile-historical-returns"/u);
  assert.match(html, /Coming Back to Life/u);
  assert.match(html, /id="profile-listening-seasons"/u);
  assert.match(html, /New means new to your history/u);
  assert.match(html, /id="result-card-download-link"/u);
  assert.match(html, /Download private HTML/u);
  assert.match(html, /not automatically safe to share/u);
  assert.match(html, /id="profile-card-link"/u);
  assert.match(html, /id="profile-card-download-link"/u);
  assert.match(html, /Correct the reading\./u);
  assert.match(html, /Your word beats inference/u);
  assert.match(html, /Run the fictional archive through the real importer/u);
  assert.match(html, /Try the real importer with fictional history/u);
  assert.match(html, /id="profile-time-machine"/u);
  assert.match(html, /id="profile-time-machine-coverage"/u);
  assert.match(html, /id="profile-identity-link-coverage"/u);
  assert.match(html, /Anything unclear stays apart/u);
  assert.match(html, /" \+ retainedNoun \+ " have a song/u);
  assert.match(html, /is still in your history, but no song stood out enough to pick/u);
  assert.match(html, /id="profile-time-machine-link"/u);
  assert.match(
    html,
    /\.profile-artifact-link \{ min-height: 44px; padding: 10px 0; box-sizing: border-box; \}/u,
  );
  assert.match(html, /Open Listening Time Machine/u);
  assert.match(html, /Fictional real-import demo/u);
  assert.match(html, /overlapping standard records were reconciled/u);
  assert.match(html, /Apply to Tasteprint/u);
  assert.match(html, /Review corrections in Tasteprint/u);
  assert.match(html, /#listener-corrections/u);
  assert.match(html, /Review the direct signal in the updated Tasteprint/u);
  assert.match(html, /It is not sent as model profile context/u);
  assert.match(html, /Active corrections/u);
  assert.doesNotMatch(html, /target="_blank"/u);
  assert.doesNotMatch(html, /https?:\/\/(?!127\.0\.0\.1)/u);
  assert.doesNotMatch(html, /PRIVATE_(?:IP|PLATFORM)_SENTINEL/u);

  const brand = await fetch(
    new URL(`/brand.png?session=${studioSession(studio)}`, studio.origin),
  );
  assert.equal(brand.status, 200);
  assert.equal(brand.headers.get("content-type"), "image/png");
  assert.ok((await brand.arrayBuffer()).byteLength > 100_000);

  const missingDemoToken = await fetch(
    new URL("/demo-tasteprint", studio.origin),
  );
  assert.equal(missingDemoToken.status, 404);

  const demoTasteprint = await fetch(
    new URL(
      `/demo-tasteprint?session=${studioSession(studio)}`,
      studio.origin,
    ),
  );
  const demoHtml = await demoTasteprint.text();
  assert.equal(demoTasteprint.status, 200);
  assert.match(
    demoTasteprint.headers.get("content-security-policy"),
    /connect-src 'none'/u,
  );
  assert.match(demoHtml, /Moondog Synthetic Tasteprint Demo/u);
  assert.match(demoHtml, /A fictional demo/u);
  assert.match(demoHtml, /Fictional public profile/u);
  assert.doesNotMatch(demoHtml, /<script/iu);
  assert.doesNotMatch(demoHtml, /https?:\/\//iu);
  assert.doesNotMatch(demoHtml, /PRIVATE_(?:IP|PLATFORM)_SENTINEL/u);

  const missingDemoCardToken = await fetch(
    new URL("/demo-tasteprint-card", studio.origin),
  );
  assert.equal(missingDemoCardToken.status, 404);
  const demoTasteprintCard = await fetch(
    new URL(
      `/demo-tasteprint-card?session=${studioSession(studio)}`,
      studio.origin,
    ),
  );
  const demoCardHtml = await demoTasteprintCard.text();
  assert.equal(demoTasteprintCard.status, 200);
  assert.match(
    demoTasteprintCard.headers.get("content-security-policy"),
    /connect-src 'none'/u,
  );
  assert.match(demoCardHtml, /Moondog Synthetic Tasteprint Card Demo/u);
  assert.match(demoCardHtml, /A fictional demo/u);
  assert.match(demoCardHtml, /Fictional public profile/u);
  assert.match(demoCardHtml, /data-artifact="moondog-tasteprint-card\/1"/u);
  assert.doesNotMatch(demoCardHtml, /<script/iu);
  assert.doesNotMatch(demoCardHtml, /https?:\/\//iu);
  assert.doesNotMatch(demoCardHtml, /PRIVATE_(?:IP|PLATFORM)_SENTINEL/u);
  const demoTasteprintCardDownload = await fetch(
    new URL(
      `/demo-tasteprint-card?session=${studioSession(studio)}&download=1`,
      studio.origin,
    ),
  );
  assert.equal(demoTasteprintCardDownload.status, 200);
  assert.equal(
    demoTasteprintCardDownload.headers.get("content-disposition"),
    "attachment; filename=\"moondog-fictional-tasteprint-card.html\"",
  );
  assert.equal(await demoTasteprintCardDownload.text(), demoCardHtml);

  const missingProfileToken = await fetch(
    new URL("/api/profile", studio.origin),
  );
  assert.equal(missingProfileToken.status, 404);
  const emptyProfileResponse = await getProfile(studio);
  const emptyProfile = await emptyProfileResponse.json();
  assert.equal(emptyProfileResponse.status, 200);
  assert.deepEqual(emptyProfile, {
    state: "empty",
    coverage: {
      effective_listening_events: 0,
      listening_hours: 0,
      distinct_tracks: 0,
      cross_format_track_links: 0,
      cross_format_linked_events: 0,
      cross_format_ambiguous_tracks: 0,
      cross_format_ambiguous_events: 0,
    },
    time_machine: {
      ready: false,
      landmark_count: 0,
      retained_year_count: 0,
      represented_year_count: 0,
      unrepresented_years: [],
      minimum_engaged_plays: null,
      minimum_listening_minutes: null,
      landmarks: [],
    },
    listening_pulse: {
      ready: false,
      timezone: "UTC",
      retained_span_months: 0,
      represented_month_count: 0,
      active_month_count: 0,
      omitted_earlier_month_count: 0,
      preview_month_count: 0,
      preview_active_month_count: 0,
      preview_omitted_month_count: 0,
      peak_listening_minutes: 0,
      months: [],
    },
    listening_seasons: {
      ready: false,
      timezone: "UTC",
      retained_season_count: 0,
      represented_season_count: 0,
      active_season_count: 0,
      represented_active_season_count: 0,
      omitted_earlier_season_count: 0,
      omitted_earlier_active_season_count: 0,
      preview_season_count: 0,
      preview_active_season_count: 0,
      preview_omitted_season_count: 0,
      preview_omitted_active_season_count: 0,
      seasons: [],
    },
    historical_returns: {
      ready: false,
      return_track_count: 0,
      minimum_gap_days: null,
      tracks: [],
    },
    back_to_back: {
      ready: false,
      track_count: 0,
      minimum_consecutive_plays: null,
      minimum_played_seconds: null,
      maximum_gap_minutes: null,
      tracks: [],
    },
    continuity: {
      ready: false,
      relationship_count: 0,
      transition_count: 0,
      relationships: [],
      latest_transition: null,
    },
    listening_patterns: {
      ready: false,
      release_count: 0,
      releases: [],
      session: null,
    },
    active_corrections: 0,
    corrections: [],
    tasteprint_url: null,
    tasteprint_card_url: null,
  });
  await assert.rejects(
    access(path.join(root, "state", "listening-history.sqlite")),
    /ENOENT/u,
  );

  const crossOrigin = await postArchive(
    studio,
    Buffer.from("504b0304", "hex"),
    { Origin: "https://attacker.invalid" },
  );
  assert.equal(crossOrigin.status, 404);
  assert.equal(crossOrigin.headers.get("access-control-allow-origin"), null);

  const crossOriginCorrection = await postProfileJson(
    studio,
    "/api/corrections",
    { entity_type: "artist", label: "Portishead", stance: "like" },
    { Origin: "https://attacker.invalid" },
  );
  assert.equal(crossOriginCorrection.status, 404);
  const crossOriginDemo = await postProfileJson(
    studio,
    "/api/demo/start",
    {},
    { Origin: "https://attacker.invalid" },
  );
  assert.equal(crossOriginDemo.status, 404);
  await assert.rejects(
    access(path.join(root, "state", "listening-history.sqlite")),
    /ENOENT/u,
  );
});

test("Studio runs the fictional correction loop only in process memory", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-studio-demo-"));
  const stateRoot = path.join(root, "state");
  const temporaryRoot = path.join(root, "temporary");
  let instant = Date.parse("2026-09-03T08:00:00.000Z");
  const studio = await startMoondogStudio({
    environment: {
      ...process.env,
      MOONDOG_STATE_HOME: stateRoot,
      MOONDOG_CONFIG_HOME: path.join(root, "config"),
    },
    temporaryRoot,
    now: () => new Date(instant++),
  });
  context.after(async () => {
    await studio.close();
    await rm(root, { recursive: true, force: true });
  });

  const beforeStart = await postProfileJson(
    studio,
    "/api/demo/corrections",
    { entity_type: "artist", label: "Mara Vale", stance: "avoid" },
  );
  assert.equal(beforeStart.status, 409);

  const startedResponse = await postProfileJson(
    studio,
    "/api/demo/start",
    {},
  );
  const started = await startedResponse.json();
  assert.equal(startedResponse.status, 200);
  assert.equal(started.profile_kind, "synthetic_demo");
  assert.deepEqual(started.demo_proof, {
    kind: "fictional_spotify_extended_history",
    archive_schema: "moondog-fictional-spotify-history/2",
    source_format: "spotify_extended_streaming_history_music_v1",
    record_count: 52,
    years: [2023, 2024, 2025, 2026],
    production_importer: true,
    private_listener_data_read: false,
    persistent_profile_writes: false,
  });
  assert.equal(started.state, "ready");
  assert.deepEqual(started.coverage, {
    effective_listening_events: 52,
    listening_hours: 4.2,
    distinct_tracks: 14,
    cross_format_track_links: 0,
    cross_format_linked_events: 0,
    cross_format_ambiguous_tracks: 0,
    cross_format_ambiguous_events: 0,
  });
  assert.deepEqual(started.time_machine, {
    ready: true,
    landmark_count: 4,
    retained_year_count: 4,
    represented_year_count: 4,
    unrepresented_years: [],
    minimum_engaged_plays: 2,
    minimum_listening_minutes: 5,
    landmarks: [
      { year: 2023, title: "Midnight Lines", artist: "Mara Vale" },
      { year: 2024, title: "Glass Highway", artist: "North Window" },
      { year: 2025, title: "Blue Exit", artist: "Ash Meridian" },
      { year: 2026, title: "Northern Relay", artist: "Drift Assembly" },
    ],
  });
  assert.deepEqual(started.historical_returns, {
    ready: true,
    return_track_count: 4,
    minimum_gap_days: 180,
    tracks: [
      {
        title: "Quiet Coordinates",
        artist: "Sable Arcade",
        return_count: 2,
        longest_gap_days: 421,
        latest_return_gap_days: 316,
        latest_return_date: "2025-11-26",
      },
      {
        title: "Glass Highway",
        artist: "North Window",
        return_count: 2,
        longest_gap_days: 318,
        latest_return_gap_days: 318,
        latest_return_date: "2026-03-09",
      },
      {
        title: "Midnight Lines",
        artist: "Mara Vale",
        return_count: 1,
        longest_gap_days: 732,
        latest_return_gap_days: 732,
        latest_return_date: "2026-06-04",
      },
      {
        title: "Blue Exit",
        artist: "Ash Meridian",
        return_count: 1,
        longest_gap_days: 180,
        latest_return_gap_days: 180,
        latest_return_date: "2026-03-09",
      },
    ],
  });
  assert.deepEqual(started.back_to_back, {
    ready: true,
    track_count: 3,
    minimum_consecutive_plays: 2,
    minimum_played_seconds: 30,
    maximum_gap_minutes: 30,
    tracks: [
      {
        title: "Glass Highway",
        artist: "North Window",
        burst_count: 1,
        maximum_consecutive_plays: 3,
        plays_in_bursts: 3,
        listening_minutes_in_bursts: 16,
        latest_burst_date: "2024-01-11",
      },
      {
        title: "Blue Exit",
        artist: "Ash Meridian",
        burst_count: 1,
        maximum_consecutive_plays: 3,
        plays_in_bursts: 3,
        listening_minutes_in_bursts: 15,
        latest_burst_date: "2025-01-13",
      },
      {
        title: "Midnight Lines",
        artist: "Mara Vale",
        burst_count: 1,
        maximum_consecutive_plays: 3,
        plays_in_bursts: 3,
        listening_minutes_in_bursts: 15,
        latest_burst_date: "2023-09-01",
      },
    ],
  });
  assert.doesNotMatch(
    JSON.stringify({
      time_machine: started.time_machine,
      historical_returns: started.historical_returns,
      back_to_back: started.back_to_back,
    }),
    /spotify:track:|track_ref|evidence_id|external_refs/u,
  );
  assert.equal(started.active_corrections, 0);
  assert.deepEqual(started.corrections, []);
  assert.match(started.tasteprint_url, /^\/tasteprint\?session=/u);
  assert.match(started.tasteprint_card_url, /^\/tasteprint-card\?session=/u);

  const reloadedResponse = await getProfile(studio);
  const reloaded = await reloadedResponse.json();
  assert.equal(reloaded.profile_kind, "synthetic_demo");
  assert.deepEqual(reloaded.coverage, started.coverage);
  assert.deepEqual(reloaded.historical_returns, started.historical_returns);
  assert.deepEqual(reloaded.back_to_back, started.back_to_back);
  assert.equal(reloaded.tasteprint_url, started.tasteprint_url);
  assert.equal(reloaded.tasteprint_card_url, started.tasteprint_card_url);

  const correctionResponse = await postProfileJson(
    studio,
    "/api/demo/corrections",
    {
      entity_type: "artist",
      label: "Mara Vale",
      stance: "avoid",
      note: "Fictional correction for the guided demo.",
    },
  );
  const corrected = await correctionResponse.json();
  assert.equal(correctionResponse.status, 200);
  assert.equal(corrected.profile_kind, "synthetic_demo");
  assert.deepEqual(corrected.coverage, started.coverage);
  assert.equal(corrected.active_corrections, 1);
  assert.equal(corrected.mutation.state, "active");
  assert.equal(corrected.time_machine.landmark_count, 3);
  assert.deepEqual(corrected.time_machine.unrepresented_years, [2023]);
  assert.equal(corrected.time_machine.landmarks.some((track) => track.artist === "Mara Vale"), false);
  assert.equal(corrected.corrections[0].label, "Mara Vale");
  assert.equal(corrected.corrections[0].stance, "avoid");
  assert.equal(
    corrected.corrections[0].note,
    "Fictional correction for the guided demo.",
  );
  assert.notEqual(corrected.tasteprint_url, started.tasteprint_url);
  assert.notEqual(corrected.tasteprint_card_url, started.tasteprint_card_url);
  assert.equal(corrected.historical_returns.return_track_count, 3);
  assert.equal(
    corrected.historical_returns.tracks.some(
      (track) => track.artist === "Mara Vale",
    ),
    false,
  );
  assert.equal(corrected.back_to_back.track_count, 2);
  assert.equal(
    corrected.back_to_back.tracks.some(
      (track) => track.artist === "Mara Vale",
    ),
    false,
  );

  const staleTasteprint = await fetch(
    new URL(started.tasteprint_url, studio.origin),
  );
  assert.equal(staleTasteprint.status, 404);
  const staleTasteprintCard = await fetch(
    new URL(started.tasteprint_card_url, studio.origin),
  );
  assert.equal(staleTasteprintCard.status, 404);
  const tasteprintResponse = await fetch(
    new URL(corrected.tasteprint_url, studio.origin),
  );
  const tasteprint = await tasteprintResponse.text();
  assert.equal(tasteprintResponse.status, 200);
  assert.match(tasteprint, /A fictional demo/u);
  assert.match(tasteprint, /Fictional public profile/u);
  assert.match(tasteprint, /What you told me/u);
  assert.match(tasteprint, /Mara Vale/u);
  assert.match(tasteprint, /Fictional correction for the guided demo\./u);
  assert.match(tasteprint, /only in this Studio process/u);
  assert.match(tasteprint, /production Spotify history importer/u);
  assert.doesNotMatch(tasteprint, /<script/iu);
  assert.doesNotMatch(tasteprint, /https?:\/\//iu);

  const tasteprintCardResponse = await fetch(
    new URL(corrected.tasteprint_card_url, studio.origin),
  );
  const tasteprintCard = await tasteprintCardResponse.text();
  assert.equal(tasteprintCardResponse.status, 200);
  assert.match(tasteprintCard, /A fictional demo/u);
  assert.match(tasteprintCard, /data-artifact="moondog-tasteprint-card\/1"/u);
  assert.match(tasteprintCard, /1 of your own choice applied/u);
  assert.doesNotMatch(
    tasteprintCard,
    /Fictional correction for the guided demo\./u,
  );
  assert.doesNotMatch(tasteprintCard, /<script/iu);
  assert.doesNotMatch(tasteprintCard, /https?:\/\//iu);
  const tasteprintCardDownloadResponse = await fetch(
    new URL(`${corrected.tasteprint_card_url}&download=1`, studio.origin),
  );
  assert.equal(tasteprintCardDownloadResponse.status, 200);
  assert.equal(
    tasteprintCardDownloadResponse.headers.get("content-disposition"),
    "attachment; filename=\"moondog-fictional-tasteprint-card.html\"",
  );
  assert.equal(await tasteprintCardDownloadResponse.text(), tasteprintCard);

  const retractResponse = await postProfileJson(
    studio,
    "/api/demo/corrections/retract",
    { correction_id: corrected.corrections[0].correction_id },
  );
  const retracted = await retractResponse.json();
  assert.equal(retractResponse.status, 200);
  assert.equal(retracted.profile_kind, "synthetic_demo");
  assert.equal(retracted.mutation.state, "retracted");
  assert.equal(retracted.active_corrections, 0);
  assert.deepEqual(retracted.corrections, []);
  assert.deepEqual(retracted.coverage, started.coverage);
  assert.deepEqual(retracted.time_machine, started.time_machine);
  assert.deepEqual(retracted.historical_returns, started.historical_returns);
  assert.notEqual(
    retracted.tasteprint_card_url,
    corrected.tasteprint_card_url,
  );

  const repeatedRetraction = await postProfileJson(
    studio,
    "/api/demo/corrections/retract",
    { correction_id: corrected.corrections[0].correction_id },
  );
  assert.equal(repeatedRetraction.status, 409);

  assert.deepEqual(await directoryEntries(stateRoot), []);
  assert.deepEqual(await directoryEntries(temporaryRoot), []);
  await assert.rejects(
    access(path.join(stateRoot, "listening-history.sqlite")),
    /ENOENT/u,
  );
});

test("Studio demo-only mode starts ready without reading local history and rejects imports", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-studio-demo-only-"));
  const stateRoot = path.join(root, "state");
  const temporaryRoot = path.join(root, "temporary");
  let storeOpened = false;
  const studio = await startMoondogStudio({
    demoOnly: true,
    environment: {
      ...process.env,
      MOONDOG_STATE_HOME: stateRoot,
      MOONDOG_CONFIG_HOME: path.join(root, "config"),
    },
    temporaryRoot,
    openStore: async () => {
      storeOpened = true;
      throw new Error("The demo-only tour must not open the private store.");
    },
  });
  context.after(async () => {
    await studio.close();
    await rm(root, { recursive: true, force: true });
  });

  const pageResponse = await fetch(studio.url);
  const page = await pageResponse.text();
  assert.equal(pageResponse.status, 200);
  assert.match(page, /Moondog Studio - Fictional Listening Time Machine/u);
  assert.match(page, /data-demo-only="true"/u);
  assert.match(page, /A music life,<br>made legible\./u);
  assert.match(page, /No personal listening file is read or accepted in this tour\./u);
  assert.match(page, /production Spotify importer/u);
  assert.match(page, /id="profile-listening-seasons"/u);
  assert.match(page, /Listening Seasons/u);
  assert.match(page, /class="workspace"[^>]* hidden aria-hidden="true"/u);

  const captureUrl = new URL(studio.url);
  captureUrl.searchParams.set("capture", "1");
  const capturePageResponse = await fetch(captureUrl);
  const capturePage = await capturePageResponse.text();
  assert.equal(capturePageResponse.status, 200);
  assert.match(capturePage, /<html lang="en" data-capture="hero">/u);
  assert.match(capturePage, /html\[data-capture\]::-webkit-scrollbar/u);

  captureUrl.searchParams.set("capture", "time-machine");
  const timeMachineCaptureResponse = await fetch(captureUrl);
  const timeMachineCapturePage = await timeMachineCaptureResponse.text();
  assert.equal(timeMachineCaptureResponse.status, 200);
  assert.match(
    timeMachineCapturePage,
    /<html lang="en" data-capture="time-machine">/u,
  );
  assert.match(
    timeMachineCapturePage,
    /html\[data-capture="time-machine"\] \.time-machine-route/u,
  );

  captureUrl.searchParams.set("capture", "listening-pulse");
  const pulseCaptureResponse = await fetch(captureUrl);
  const pulseCapturePage = await pulseCaptureResponse.text();
  assert.equal(pulseCaptureResponse.status, 200);
  assert.match(
    pulseCapturePage,
    /<html lang="en" data-capture="listening-pulse">/u,
  );
  assert.match(
    pulseCapturePage,
    /html\[data-capture="listening-pulse"\] \.studio-pulse-grid/u,
  );

  captureUrl.searchParams.set("capture", "listening-seasons");
  const seasonsCaptureResponse = await fetch(captureUrl);
  const seasonsCapturePage = await seasonsCaptureResponse.text();
  assert.equal(seasonsCaptureResponse.status, 200);
  assert.match(
    seasonsCapturePage,
    /<html lang="en" data-capture="listening-seasons">/u,
  );
  assert.match(
    seasonsCapturePage,
    /html\[data-capture="listening-seasons"\] \.studio-seasons-grid/u,
  );

  captureUrl.searchParams.set("capture", "historical-returns");
  const returnsCaptureResponse = await fetch(captureUrl);
  const returnsCapturePage = await returnsCaptureResponse.text();
  assert.equal(returnsCaptureResponse.status, 200);
  assert.match(
    returnsCapturePage,
    /<html lang="en" data-capture="historical-returns">/u,
  );
  assert.match(
    returnsCapturePage,
    /html\[data-capture="historical-returns"\] \.historical-returns-preview/u,
  );
  assert.match(
    returnsCapturePage,
    /html\[data-capture="historical-returns"\] \.continuity-relationships/u,
  );

  captureUrl.searchParams.set("capture", "listening-patterns");
  const patternsCaptureResponse = await fetch(captureUrl);
  const patternsCapturePage = await patternsCaptureResponse.text();
  assert.equal(patternsCaptureResponse.status, 200);
  assert.match(
    patternsCapturePage,
    /<html lang="en" data-capture="listening-patterns">/u,
  );
  assert.match(
    patternsCapturePage,
    /html\[data-capture="listening-patterns"\] \.listening-patterns-metric strong/u,
  );

  captureUrl.searchParams.set("capture", "correction");
  const correctionCaptureResponse = await fetch(captureUrl);
  const correctionCapturePage = await correctionCaptureResponse.text();
  assert.equal(correctionCaptureResponse.status, 200);
  assert.match(
    correctionCapturePage,
    /<html lang="en" data-capture="correction">/u,
  );
  assert.match(
    correctionCapturePage,
    /html\[data-capture="correction"\] \.workspace/u,
  );

  const profileResponse = await getProfile(studio);
  const profile = await profileResponse.json();
  assert.equal(profileResponse.status, 200);
  assert.equal(profile.profile_kind, "synthetic_demo");
  assert.equal(profile.demo_proof.production_importer, true);
  assert.equal(profile.demo_proof.record_count, 52);
  assert.equal(profile.state, "ready");
  assert.equal(profile.time_machine.ready, true);
  assert.equal(profile.time_machine.landmark_count, 4);
  assert.equal(profile.time_machine.retained_year_count, 4);
  assert.equal(profile.time_machine.represented_year_count, 4);
  assert.deepEqual(profile.time_machine.unrepresented_years, []);
  assert.equal(profile.listening_pulse.ready, true);
  assert.equal(profile.listening_pulse.timezone, "UTC");
  assert.equal(profile.listening_pulse.retained_span_months, 36);
  assert.equal(profile.listening_pulse.represented_month_count, 36);
  assert.equal(profile.listening_pulse.active_month_count, 15);
  assert.equal(profile.listening_pulse.preview_month_count, 36);
  assert.equal(profile.listening_pulse.preview_active_month_count, 15);
  assert.equal(profile.listening_pulse.preview_omitted_month_count, 0);
  assert.equal(profile.listening_pulse.months.length, 36);
  assert.equal(profile.listening_seasons.ready, true);
  assert.equal(profile.listening_seasons.timezone, "UTC");
  assert.equal(profile.listening_seasons.retained_season_count, 13);
  assert.equal(profile.listening_seasons.represented_season_count, 13);
  assert.equal(profile.listening_seasons.active_season_count, 12);
  assert.equal(profile.listening_seasons.preview_season_count, 6);
  assert.equal(profile.listening_seasons.preview_active_season_count, 6);
  assert.equal(profile.listening_seasons.preview_omitted_season_count, 7);
  assert.equal(profile.listening_seasons.seasons[0].key, "2025-Q2");
  assert.equal(profile.listening_seasons.seasons.at(-1).key, "2026-Q3");
  assert.doesNotMatch(
    JSON.stringify(profile.listening_seasons),
    /track_ref|evidence|occurred_at|spotify:track:/u,
  );
  assert.equal(profile.historical_returns.ready, true);
  assert.equal(profile.historical_returns.return_track_count, 4);
  assert.equal(profile.historical_returns.minimum_gap_days, 180);
  assert.equal(
    profile.historical_returns.tracks[0].title,
    "Quiet Coordinates",
  );
  assert.equal(profile.listening_patterns.ready, true);
  assert.deepEqual(profile.listening_patterns, {
    ready: true,
    release_count: 2,
    releases: [
      {
        title: "Pale Signals",
        artist_credit: "North Window",
        distinct_tracks: 3,
        active_years: 3,
      },
      {
        title: "Night Transit",
        artist_credit: "Mara Vale",
        distinct_tracks: 3,
        active_years: 3,
      },
    ],
    session: {
      gap_minutes: 30,
      session_count: 15,
      median_plays: 4,
      median_listening_minutes: 21,
      extended_sequence_minimum_plays: 5,
      extended_sequence_percent: 26.7,
    },
  });
  assert.doesNotMatch(
    JSON.stringify(profile),
    /spotify:track:|evidence[_-]?id|occurred[_-]?at|PRIVATE_/u,
  );
  assert.equal(storeOpened, false);

  const importResponse = await postArchive(
    studio,
    Buffer.from("504b0304", "hex"),
  );
  const importBody = await importResponse.json();
  assert.equal(importResponse.status, 409);
  assert.match(importBody.message, /does not read or accept private listening history/u);

  const privateCorrectionResponse = await postProfileJson(
    studio,
    "/api/corrections",
    { entity_type: "artist", label: "Private Sentinel", stance: "like" },
  );
  const privateCorrectionBody = await privateCorrectionResponse.json();
  assert.equal(privateCorrectionResponse.status, 409);
  assert.match(privateCorrectionBody.message, /only in-memory demo corrections/u);

  const demoCorrectionResponse = await postProfileJson(
    studio,
    "/api/demo/corrections",
    { entity_type: "artist", label: "Mara Vale", stance: "avoid" },
  );
  const corrected = await demoCorrectionResponse.json();
  assert.equal(demoCorrectionResponse.status, 200);
  assert.equal(corrected.profile_kind, "synthetic_demo");
  assert.equal(corrected.active_corrections, 1);
  assert.equal(storeOpened, false);
  assert.deepEqual(await directoryEntries(stateRoot), []);
  assert.deepEqual(await directoryEntries(temporaryRoot), []);
});

test("Studio opens an explicitly supplied Spotify ZIP as a session-only private profile", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-studio-archive-session-"));
  const archivePath = await createExtendedArchive(root);
  const archiveBefore = await stat(archivePath);
  const stateRoot = path.join(root, "state");
  const temporaryRoot = path.join(root, "temporary");
  let storeOpened = false;
  let instant = Date.parse("2026-09-03T10:00:00.000Z");
  const studio = await startMoondogStudio({
    archivePath,
    environment: {
      ...process.env,
      MOONDOG_STATE_HOME: stateRoot,
      MOONDOG_CONFIG_HOME: path.join(root, "config"),
    },
    temporaryRoot,
    now: () => new Date(instant++),
    openStore: async () => {
      storeOpened = true;
      throw new Error("The archive session must not open the persistent store.");
    },
  });
  context.after(async () => {
    await studio.close();
    await rm(root, { recursive: true, force: true });
  });

  const pageResponse = await fetch(studio.url);
  const page = await pageResponse.text();
  assert.equal(pageResponse.status, 200);
  assert.match(page, /Moondog Studio - Session-only Spotify History/u);
  assert.match(page, /data-session-mode="archive"/u);
  assert.match(page, /Your whole history,<br>ready now\./u);
  assert.match(page, /original ZIP stays untouched/u);
  assert.match(page, /id="profile-listening-pulse"/u);
  assert.match(page, /id="profile-historical-returns"/u);
  assert.match(page, /id="profile-back-to-back"/u);
  assert.match(page, /id="profile-continuity"/u);
  assert.match(page, /id="profile-listening-patterns"/u);
  assert.match(page, /class="workspace"[^>]* hidden aria-hidden="true"/u);

  const profileResponse = await getProfile(studio);
  const profile = await profileResponse.json();
  assert.equal(profileResponse.status, 200);
  assert.equal(profile.profile_kind, "private_session");
  assert.equal(profile.state, "ready");
  assert.deepEqual(profile.coverage, {
    effective_listening_events: 2,
    listening_hours: 0.2,
    distinct_tracks: 2,
    cross_format_track_links: 0,
    cross_format_linked_events: 0,
    cross_format_ambiguous_tracks: 0,
    cross_format_ambiguous_events: 0,
  });
  assert.deepEqual(profile.source, {
    provider: "spotify",
    data_scope: "lifetime_extended_streaming_history",
    input_records: 2,
    persistent_import: false,
  });
  assert.deepEqual(profile.historical_returns, {
    ready: false,
    return_track_count: 0,
    minimum_gap_days: 180,
    tracks: [],
  });
  assert.equal(profile.listening_pulse.ready, true);
  assert.equal(profile.listening_pulse.timezone, "UTC");
  assert.equal(profile.listening_pulse.retained_span_months, 29);
  assert.equal(profile.listening_pulse.represented_month_count, 29);
  assert.equal(profile.listening_pulse.active_month_count, 2);
  assert.equal(profile.listening_pulse.preview_month_count, 29);
  assert.equal(profile.listening_pulse.preview_active_month_count, 2);
  assert.equal(profile.listening_pulse.preview_omitted_month_count, 0);
  assert.equal(profile.listening_pulse.months.length, 29);
  assert.equal(profile.listening_pulse.months[0].month, "2024-04");
  assert.equal(profile.listening_pulse.months.at(-1).month, "2026-08");
  assert.equal(profile.listening_seasons.ready, true);
  assert.equal(profile.listening_seasons.retained_season_count, 10);
  assert.equal(profile.listening_seasons.active_season_count, 2);
  assert.equal(profile.listening_seasons.preview_season_count, 6);
  assert.equal(profile.listening_seasons.preview_active_season_count, 1);
  assert.equal(profile.listening_seasons.preview_omitted_season_count, 4);
  assert.equal(profile.listening_seasons.seasons[0].key, "2025-Q2");
  assert.equal(profile.listening_seasons.seasons.at(-1).key, "2026-Q3");
  assert.deepEqual(profile.back_to_back, {
    ready: false,
    track_count: 0,
    minimum_consecutive_plays: 2,
    minimum_played_seconds: 30,
    maximum_gap_minutes: 30,
    tracks: [],
  });
  assert.equal(profile.continuity.ready, true);
  assert.deepEqual(profile.continuity.relationships, [
    {
      name: "Portishead",
      first_year: 2024,
      last_year: 2026,
      active_years: 2,
      span_years: 3,
    },
  ]);
  assert.deepEqual(profile.continuity.latest_transition, {
    from_year: 2024,
    to_year: 2026,
    retained_artist_count: 1,
    new_artist_count: 0,
    continuity_percent: 100,
  });
  assert.equal(profile.listening_patterns.ready, true);
  assert.deepEqual(profile.listening_patterns.releases, []);
  assert.equal(profile.listening_patterns.session.session_count, 2);
  assert.equal(profile.listening_patterns.session.gap_minutes, 30);
  assert.equal(profile.listening_patterns.session.extended_sequence_percent, 0);
  assert.match(profile.tasteprint_url, /^\/tasteprint\?session=/u);
  assert.match(profile.tasteprint_card_url, /^\/tasteprint-card\?session=/u);
  assert.doesNotMatch(JSON.stringify(profile), new RegExp(root, "u"));
  assert.doesNotMatch(
    JSON.stringify(profile),
    /spotify:track:|evidence[_-]?id|occurred[_-]?at|PRIVATE_/u,
  );
  assert.equal(storeOpened, false);

  const importResponse = await postArchive(
    studio,
    Buffer.from("504b0304", "hex"),
  );
  const importBody = await importResponse.json();
  assert.equal(importResponse.status, 409);
  assert.match(importBody.message, /does not accept another import/u);

  const demoResponse = await postProfileJson(studio, "/api/demo/start", {});
  const demoBody = await demoResponse.json();
  assert.equal(demoResponse.status, 409);
  assert.match(demoBody.message, /already contains the supplied private history/u);

  const correctionResponse = await postProfileJson(
    studio,
    "/api/session/corrections",
    {
      entity_type: "artist",
      label: "Portishead",
      stance: "like",
      note: "Session only.",
    },
  );
  const corrected = await correctionResponse.json();
  assert.equal(correctionResponse.status, 200);
  assert.equal(corrected.profile_kind, "private_session");
  assert.equal(corrected.active_corrections, 1);
  assert.equal(corrected.corrections[0].label, "Portishead");

  const correctedTasteprintResponse = await fetch(
    new URL(corrected.tasteprint_url, studio.origin),
  );
  const correctedTasteprint = await correctedTasteprintResponse.text();
  assert.equal(correctedTasteprintResponse.status, 200);
  assert.match(correctedTasteprint, /Portishead/u);
  assert.match(correctedTasteprint, /Session only\./u);
  assert.doesNotMatch(correctedTasteprint, /spotify:track:|PRIVATE_/u);

  const retractionResponse = await postProfileJson(
    studio,
    "/api/session/corrections/retract",
    { correction_id: corrected.corrections[0].correction_id },
  );
  const retracted = await retractionResponse.json();
  assert.equal(retractionResponse.status, 200);
  assert.equal(retracted.profile_kind, "private_session");
  assert.equal(retracted.active_corrections, 0);
  assert.deepEqual(retracted.corrections, []);

  const archiveAfter = await stat(archivePath);
  assert.equal(archiveAfter.size, archiveBefore.size);
  assert.equal(archiveAfter.mtimeMs, archiveBefore.mtimeMs);
  assert.equal(storeOpened, false);
  assert.deepEqual(await directoryEntries(stateRoot), []);
  assert.deepEqual(await directoryEntries(temporaryRoot), []);
});

test("Studio reconciles two supplied Spotify ZIPs in one session-only profile", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-studio-archive-set-"));
  const extendedPath = await createExtendedArchive(root);
  const accountPath = await createAccountArchive(root);
  const extendedBefore = await stat(extendedPath);
  const accountBefore = await stat(accountPath);
  const stateRoot = path.join(root, "state");
  const temporaryRoot = path.join(root, "temporary");
  let storeOpened = false;
  const studio = await startMoondogStudio({
    archivePaths: [accountPath, extendedPath],
    environment: {
      ...process.env,
      MOONDOG_STATE_HOME: stateRoot,
      MOONDOG_CONFIG_HOME: path.join(root, "config"),
    },
    temporaryRoot,
    now: () => new Date("2026-09-03T10:00:00.000Z"),
    openStore: async () => {
      storeOpened = true;
      throw new Error("The archive session must not open the persistent store.");
    },
  });
  context.after(async () => {
    await studio.close();
    await rm(root, { recursive: true, force: true });
  });

  const pageResponse = await fetch(studio.url);
  const page = await pageResponse.text();
  assert.equal(pageResponse.status, 200);
  assert.match(page, /Two ZIPs, one private session/u);
  assert.match(page, /reconciled the two explicitly supplied Spotify ZIPs/u);
  assert.match(page, /data-session-mode="archive"/u);
  assert.match(page, /data-archive-count="2"/u);
  assert.doesNotMatch(page, new RegExp(root, "u"));

  const profileResponse = await getProfile(studio);
  const profile = await profileResponse.json();
  assert.equal(profileResponse.status, 200);
  assert.equal(profile.profile_kind, "private_session");
  assert.equal(profile.coverage.effective_listening_events, 2);
  assert.deepEqual(profile.source, {
    provider: "spotify",
    data_scope: "combined_spotify_history",
    input_records: 4,
    persistent_import: false,
    archive_count: 2,
    sources: [
      {
        source_format: "spotify_account_data_streaming_history_v1",
        data_scope: "past_year_account_data",
        input_records: 2,
        profile_input_records: 0,
      },
      {
        source_format: "spotify_extended_streaming_history_music_v1",
        data_scope: "lifetime_extended_streaming_history",
        input_records: 2,
        profile_input_records: 0,
      },
    ],
    effective_listening_events: 2,
    reconciled_overlap_events: 2,
  });
  assert.equal(profile.listening_pulse.ready, true);
  assert.equal(profile.listening_pulse.timezone, "UTC");
  assert.equal(profile.listening_pulse.retained_span_months, 29);
  assert.equal(profile.listening_pulse.represented_month_count, 29);
  assert.equal(profile.listening_pulse.active_month_count, 2);
  assert.equal(profile.listening_pulse.preview_month_count, 29);
  assert.equal(profile.listening_pulse.preview_active_month_count, 2);
  assert.equal(profile.listening_pulse.preview_omitted_month_count, 0);
  assert.equal(profile.listening_pulse.months.length, 29);
  assert.equal(profile.listening_seasons.ready, true);
  assert.equal(profile.listening_seasons.retained_season_count, 10);
  assert.equal(profile.listening_seasons.active_season_count, 2);
  assert.equal(profile.listening_seasons.preview_season_count, 6);
  assert.equal(profile.listening_seasons.preview_active_season_count, 1);
  assert.doesNotMatch(JSON.stringify(profile), new RegExp(root, "u"));
  assert.doesNotMatch(
    JSON.stringify(profile),
    /spotify:track:|evidence[_-]?id|occurred[_-]?at|PRIVATE_/u,
  );
  assert.equal(storeOpened, false);

  const extendedAfter = await stat(extendedPath);
  const accountAfter = await stat(accountPath);
  assert.equal(extendedAfter.size, extendedBefore.size);
  assert.equal(extendedAfter.mtimeMs, extendedBefore.mtimeMs);
  assert.equal(accountAfter.size, accountBefore.size);
  assert.equal(accountAfter.mtimeMs, accountBefore.mtimeMs);
  assert.deepEqual(await directoryEntries(stateRoot), []);
  assert.deepEqual(await directoryEntries(temporaryRoot), []);
});

test("Studio and Tasteprint explain a retained year without a selected landmark", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-studio-time-machine-coverage-"));
  const profile = createPublicTasteprintDemoProfile();
  profile.listening_behavior.time_capsule_tracks =
    profile.listening_behavior.time_capsule_tracks.filter(
      (track) => track.capsule_year !== 2024,
    );
  const studio = await startMoondogStudio({
    demoOnly: true,
    environment: {
      ...process.env,
      MOONDOG_STATE_HOME: path.join(root, "state"),
      MOONDOG_CONFIG_HOME: path.join(root, "config"),
    },
    temporaryRoot: path.join(root, "temporary"),
    createDemo: async () => ({
      profile,
      proof: {
        kind: "fictional_selection_coverage",
        private_listener_data_read: false,
        persistent_profile_writes: false,
      },
    }),
  });
  context.after(async () => {
    await studio.close();
    await rm(root, { recursive: true, force: true });
  });

  const profileResponse = await getProfile(studio);
  const current = await profileResponse.json();
  assert.equal(profileResponse.status, 200);
  assert.deepEqual(current.time_machine, {
    ready: true,
    landmark_count: 3,
    retained_year_count: 4,
    represented_year_count: 3,
    unrepresented_years: [2024],
    minimum_engaged_plays: 2,
    minimum_listening_minutes: 5,
    landmarks: [
      { year: 2023, title: "Midnight Lines", artist: "Mara Vale" },
      { year: 2025, title: "Blue Exit", artist: "Ash Meridian" },
      { year: 2026, title: "Northern Relay", artist: "Drift Assembly" },
    ],
  });

  const tasteprintResponse = await fetch(
    new URL(current.tasteprint_url, studio.origin),
  );
  const tasteprint = await tasteprintResponse.text();
  assert.equal(tasteprintResponse.status, 200);
  assert.match(tasteprint, /3 of 4 years have a song/u);
  assert.match(
    tasteprint,
    /2024 is still in Year by year, but no song stood out enough to pick/u,
  );
});

test("Studio refreshes both artifacts after a correction from another local process", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-studio-refresh-"));
  const archivePath = await createExtendedArchive(root);
  const environment = { MOONDOG_STATE_HOME: path.join(root, "state") };
  const studio = await startMoondogStudio({ environment, temporaryRoot: path.join(root, "temp") });
  context.after(async () => {
    await studio.close();
    await rm(root, { recursive: true, force: true });
  });
  const imported = await (await postArchive(studio, await readFile(archivePath))).json();
  const initial = await (await getProfile(studio)).json();
  assert.equal(initial.tasteprint_url, imported.tasteprint_url);
  const store = await openListeningHistoryStore({ environment });
  const subjectId = store.localSubjectId();
  const correction = store.recordListenerCorrection({
    subjectId, entityType: "artist", label: "Portishead", stance: "avoid",
    note: "Recorded outside the browser.",
  });
  store.close();

  const refreshed = await (await getProfile(studio)).json();
  assert.equal(refreshed.active_corrections, 1);
  assert.notEqual(refreshed.tasteprint_url, initial.tasteprint_url);
  assert.notEqual(refreshed.tasteprint_card_url, initial.tasteprint_card_url);
  const html = await (await fetch(new URL(refreshed.tasteprint_url, studio.origin))).text();
  assert.match(html, /Recorded outside the browser\./u);
  const card = await (await fetch(new URL(refreshed.tasteprint_card_url, studio.origin))).text();
  assert.match(card, /1 of your own choice applied/u);
  assert.doesNotMatch(card, /Recorded outside the browser\./u);
  assert.equal((await fetch(new URL(initial.tasteprint_url, studio.origin))).status, 404);
  const unchanged = await (await getProfile(studio)).json();
  assert.equal(unchanged.tasteprint_url, refreshed.tasteprint_url);

  const reopened = await openListeningHistoryStore({ environment });
  reopened.retractListenerCorrection({ subjectId, correctionId: correction.correction_id });
  reopened.close();
  const retracted = await (await getProfile(studio)).json();
  assert.equal(retracted.active_corrections, 0);
  assert.notEqual(retracted.tasteprint_url, refreshed.tasteprint_url);
  assert.deepEqual(retracted.coverage, initial.coverage);
  await rm(environment.MOONDOG_STATE_HOME, { recursive: true });
  const reset = await (await getProfile(studio)).json();
  assert.equal(reset.state, "empty");
  assert.equal(reset.tasteprint_url, null);
  assert.equal((await fetch(new URL(retracted.tasteprint_url, studio.origin))).status, 404);
});

test("Studio persistently imports a real ZIP, removes its working copy, and serves a bounded Tasteprint", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-studio-import-"));
  const archivePath = await createExtendedArchive(root);
  const archive = await readFile(archivePath);
  const accountArchivePath = await createAccountArchive(root);
  const accountArchive = await readFile(accountArchivePath);
  const supplementalAccountArchivePath =
    await createSupplementalAccountArchive(root);
  const supplementalAccountArchive = await readFile(
    supplementalAccountArchivePath,
  );
  const stateRoot = path.join(root, "state");
  const temporaryRoot = path.join(root, "temporary");
  const environment = {
    ...process.env,
    MOONDOG_STATE_HOME: stateRoot,
    MOONDOG_CONFIG_HOME: path.join(root, "config"),
  };
  let instant = Date.parse("2026-09-02T10:00:00.000Z");
  const studio = await startMoondogStudio({
    environment,
    temporaryRoot,
    now: () => new Date(instant++),
  });
  context.after(async () => {
    await studio.close();
    await rm(root, { recursive: true, force: true });
  });

  const demoResponse = await postProfileJson(studio, "/api/demo/start", {});
  const demo = await demoResponse.json();
  assert.equal(demoResponse.status, 200);
  assert.equal(demo.profile_kind, "synthetic_demo");

  const firstResponse = await postArchive(studio, archive);
  const first = await firstResponse.json();
  assert.equal(firstResponse.status, 200);
  assert.equal(first.profile_kind, "private");
  assert.deepEqual(first.coverage, {
    effective_listening_events: 2,
    listening_hours: 0.2,
    distinct_tracks: 2,
    cross_format_track_links: 0,
    cross_format_linked_events: 0,
    cross_format_ambiguous_tracks: 0,
    cross_format_ambiguous_events: 0,
  });
  assert.equal(first.source.data_scope, "lifetime_extended_streaming_history");
  assert.equal(first.source.already_imported, false);
  assert.equal(first.source.effective_event_delta, 2);
  assert.equal(first.source.superseded_events, 0);
  assert.deepEqual(first.time_machine, {
    ready: false,
    landmark_count: 0,
    retained_year_count: 2,
    represented_year_count: 0,
    unrepresented_years: [2024, 2026],
    minimum_engaged_plays: 2,
    minimum_listening_minutes: 5,
    landmarks: [],
  });
  assert.match(first.tasteprint_url, /^\/tasteprint\?session=/u);
  assert.match(first.tasteprint_card_url, /^\/tasteprint-card\?session=/u);
  assert.doesNotMatch(JSON.stringify(first), new RegExp(root, "u"));
  assert.doesNotMatch(JSON.stringify(first), /spotify:track:|PRIVATE_/u);
  assert.deepEqual(await directoryEntries(temporaryRoot), []);
  await access(archivePath);

  const tasteprintResponse = await fetch(
    new URL(first.tasteprint_url, studio.origin),
  );
  const tasteprint = await tasteprintResponse.text();
  assert.equal(tasteprintResponse.status, 200);
  assert.match(tasteprint, /Private Moondog Tasteprint/u);
  assert.match(tasteprint, /Year by year/u);
  assert.match(tasteprint, /2024/u);
  assert.match(tasteprint, /2026/u);
  assert.doesNotMatch(tasteprint, /<script/iu);
  assert.doesNotMatch(tasteprint, /https?:\/\//iu);
  assert.doesNotMatch(tasteprint, /spotify:track:|PRIVATE_/u);

  const tasteprintCardResponse = await fetch(
    new URL(first.tasteprint_card_url, studio.origin),
  );
  const tasteprintCard = await tasteprintCardResponse.text();
  assert.equal(tasteprintCardResponse.status, 200);
  assert.match(tasteprintCard, /Private Moondog Tasteprint Card/u);
  assert.match(tasteprintCard, /data-artifact="moondog-tasteprint-card\/1"/u);
  assert.match(tasteprintCard, /Read it before you share it/u);
  assert.match(tasteprintCard, /Private listening recap/u);
  assert.doesNotMatch(tasteprintCard, /<script/iu);
  assert.doesNotMatch(tasteprintCard, /https?:\/\//iu);
  assert.doesNotMatch(tasteprintCard, /spotify:track:|PRIVATE_/u);
  const tasteprintCardDownloadResponse = await fetch(
    new URL(`${first.tasteprint_card_url}&download=1`, studio.origin),
  );
  assert.equal(tasteprintCardDownloadResponse.status, 200);
  assert.equal(
    tasteprintCardDownloadResponse.headers.get("content-disposition"),
    "attachment; filename=\"moondog-private-tasteprint-card.html\"",
  );
  assert.equal(await tasteprintCardDownloadResponse.text(), tasteprintCard);

  const currentResponse = await getProfile(studio);
  const current = await currentResponse.json();
  assert.equal(currentResponse.status, 200);
  assert.equal(current.profile_kind, "private");
  assert.equal(current.state, "ready");
  assert.deepEqual(current.coverage, first.coverage);
  assert.equal(current.active_corrections, 0);
  assert.deepEqual(current.corrections, []);
  assert.equal(current.tasteprint_url, first.tasteprint_url);
  assert.equal(current.tasteprint_card_url, first.tasteprint_card_url);

  const staleDemoTasteprint = await fetch(
    new URL(demo.tasteprint_url, studio.origin),
  );
  assert.equal(staleDemoTasteprint.status, 404);
  const staleDemoTasteprintCard = await fetch(
    new URL(demo.tasteprint_card_url, studio.origin),
  );
  assert.equal(staleDemoTasteprintCard.status, 404);
  const restartDemo = await postProfileJson(studio, "/api/demo/start", {});
  assert.equal(restartDemo.status, 409);

  const accountResponse = await postArchive(studio, accountArchive);
  const accountImport = await accountResponse.json();
  assert.equal(accountResponse.status, 200);
  assert.deepEqual(accountImport.coverage, first.coverage);
  assert.equal(accountImport.source.data_scope, "past_year_account_data");
  assert.equal(accountImport.source.already_imported, false);
  assert.equal(accountImport.source.effective_event_delta, 0);
  assert.equal(accountImport.source.superseded_events, 2);
  assert.deepEqual(await directoryEntries(temporaryRoot), []);
  await access(accountArchivePath);

  const supplementalResponse = await postArchive(
    studio,
    supplementalAccountArchive,
  );
  const supplemental = await supplementalResponse.json();
  assert.equal(supplementalResponse.status, 200);
  assert.deepEqual(supplemental.coverage, {
    effective_listening_events: 3,
    listening_hours: 0.2,
    distinct_tracks: 2,
    cross_format_track_links: 1,
    cross_format_linked_events: 1,
    cross_format_ambiguous_tracks: 0,
    cross_format_ambiguous_events: 0,
  });
  assert.equal(supplemental.source.effective_event_delta, 1);
  assert.equal(supplemental.source.superseded_events, 0);
  await access(supplementalAccountArchivePath);
  assert.deepEqual(await directoryEntries(temporaryRoot), []);
  const linkedTasteprintResponse = await fetch(
    new URL(supplemental.tasteprint_url, studio.origin),
  );
  const linkedTasteprint = await linkedTasteprintResponse.text();
  assert.equal(linkedTasteprintResponse.status, 200);
  assert.match(
    linkedTasteprint,
    /1 track matched across your two Spotify exports/u,
  );
  assert.match(
    linkedTasteprint,
    /1 plays now count toward the same songs|1 play now counts toward the same songs|so 1 play/u,
  );
  assert.match(linkedTasteprint, /Anything unclear stays apart/u);
  assert.match(linkedTasteprint, /Your original history is unchanged/u);
  assert.doesNotMatch(linkedTasteprint, /spotify:track:|PRIVATE_/u);

  const correctionResponse = await postProfileJson(
    studio,
    "/api/corrections",
    {
      entity_type: "track",
      label: "Roads",
      artist_credit: "Portishead",
      stance: "like",
      note: "Keep this as a direct anchor.",
    },
  );
  const corrected = await correctionResponse.json();
  assert.equal(correctionResponse.status, 200);
  assert.equal(corrected.state, "ready");
  assert.deepEqual(corrected.coverage, supplemental.coverage);
  assert.equal(corrected.active_corrections, 1);
  assert.equal(corrected.mutation.state, "active");
  assert.equal(corrected.corrections.length, 1);
  assert.deepEqual(
    {
      correction_id: corrected.corrections[0].correction_id,
      entity_type: corrected.corrections[0].entity_type,
      label: corrected.corrections[0].label,
      artist_credit: corrected.corrections[0].artist_credit,
      stance: corrected.corrections[0].stance,
      note: corrected.corrections[0].note,
    },
    {
      correction_id: corrected.mutation.correction.correction_id,
      entity_type: "track",
      label: "Roads",
      artist_credit: "Portishead",
      stance: "like",
      note: "Keep this as a direct anchor.",
    },
  );
  assert.notEqual(corrected.tasteprint_url, first.tasteprint_url);
  assert.notEqual(corrected.tasteprint_card_url, first.tasteprint_card_url);
  assert.doesNotMatch(JSON.stringify(corrected), new RegExp(root, "u"));

  const correctedTasteprintResponse = await fetch(
    new URL(corrected.tasteprint_url, studio.origin),
  );
  const correctedTasteprint = await correctedTasteprintResponse.text();
  assert.equal(correctedTasteprintResponse.status, 200);
  assert.match(correctedTasteprint, /What you told me/u);
  assert.match(correctedTasteprint, /<h3>You like<\/h3>/u);
  assert.match(correctedTasteprint, /Roads/u);
  assert.match(correctedTasteprint, /Keep this as a direct anchor\./u);
  assert.doesNotMatch(correctedTasteprint, /spotify:track:|PRIVATE_/u);

  const correctedTasteprintCardResponse = await fetch(
    new URL(corrected.tasteprint_card_url, studio.origin),
  );
  const correctedTasteprintCard = await correctedTasteprintCardResponse.text();
  assert.equal(correctedTasteprintCardResponse.status, 200);
  assert.match(
    correctedTasteprintCard,
    /1 of your own choice applied/u,
  );
  assert.doesNotMatch(correctedTasteprintCard, /Keep this as a direct anchor\./u);
  assert.doesNotMatch(correctedTasteprintCard, /spotify:track:|PRIVATE_/u);

  const retractResponse = await postProfileJson(
    studio,
    "/api/corrections/retract",
    { correction_id: corrected.corrections[0].correction_id },
  );
  const retracted = await retractResponse.json();
  assert.equal(retractResponse.status, 200);
  assert.equal(retracted.state, "ready");
  assert.equal(retracted.mutation.state, "retracted");
  assert.equal(retracted.active_corrections, 0);
  assert.deepEqual(retracted.corrections, []);
  assert.deepEqual(retracted.coverage, supplemental.coverage);
  assert.notEqual(retracted.tasteprint_url, corrected.tasteprint_url);
  assert.notEqual(
    retracted.tasteprint_card_url,
    corrected.tasteprint_card_url,
  );

  const repeatedRetraction = await postProfileJson(
    studio,
    "/api/corrections/retract",
    { correction_id: corrected.corrections[0].correction_id },
  );
  assert.equal(repeatedRetraction.status, 409);

  const secondResponse = await postArchive(studio, archive);
  const second = await secondResponse.json();
  assert.equal(secondResponse.status, 200);
  assert.equal(second.coverage.effective_listening_events, 3);
  assert.equal(second.coverage.cross_format_track_links, 1);
  assert.equal(second.coverage.cross_format_linked_events, 1);
  assert.equal(second.source.already_imported, true);
  assert.equal(second.source.effective_event_delta, 0);
  assert.equal(second.source.superseded_events, 0);
  assert.deepEqual(await directoryEntries(temporaryRoot), []);

  const databasePath = path.join(stateRoot, "listening-history.sqlite");
  assert.equal((await stat(databasePath)).mode & 0o777, 0o600);
  const tasteprints = await directoryEntries(path.join(stateRoot, "tasteprints"));
  assert.equal(tasteprints.length, 6);
  for (const name of tasteprints) {
    assert.equal(
      (await stat(path.join(stateRoot, "tasteprints", name))).mode & 0o777,
      0o600,
    );
  }

  const store = await openListeningHistoryStore({ environment });
  const subjectId = store.localSubjectId();
  assert.equal(
    store.subjectDataStatus({ subjectId }).effective_listening_events,
    3,
  );
  assert.equal(
    store.subjectDataStatus({ subjectId }).active_taste_assertions,
    0,
  );
  assert.equal(
    store.listListenerCorrections({ subjectId, includeInactive: true }).length,
    1,
  );
  store.close();
});

test("Studio adds ListenBrainz JSON to the same private profile without retaining source-only fields", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-studio-multi-source-"));
  const archivePath = await createExtendedArchive(root);
  const archive = await readFile(archivePath);
  const historyPath = path.join(root, "listenbrainz-history.json");
  await writeFile(historyPath, JSON.stringify(listenBrainzHistory()));
  const history = await readFile(historyPath);
  const historyBefore = await stat(historyPath);
  const stateRoot = path.join(root, "state");
  const temporaryRoot = path.join(root, "temporary");
  const environment = {
    ...process.env,
    MOONDOG_STATE_HOME: stateRoot,
    MOONDOG_CONFIG_HOME: path.join(root, "config"),
  };
  let instant = Date.parse("2026-09-02T11:00:00.000Z");
  const studio = await startMoondogStudio({
    environment,
    temporaryRoot,
    now: () => new Date(instant++),
  });
  context.after(async () => {
    await studio.close();
    await rm(root, { recursive: true, force: true });
  });

  const spotifyResponse = await postArchive(studio, archive);
  const spotify = await spotifyResponse.json();
  assert.equal(spotifyResponse.status, 200);
  assert.equal(spotify.source.provider, "spotify");
  assert.equal(spotify.coverage.effective_listening_events, 2);

  const firstResponse = await postHistoryJson(studio, history);
  const first = await firstResponse.json();
  assert.equal(firstResponse.status, 200);
  assert.equal(first.profile_kind, "private");
  assert.deepEqual(first.coverage, {
    effective_listening_events: 4,
    listening_hours: 0.2,
    distinct_tracks: 4,
    cross_format_track_links: 0,
    cross_format_linked_events: 0,
    cross_format_ambiguous_tracks: 0,
    cross_format_ambiguous_events: 0,
  });
  assert.deepEqual(first.source, {
    provider: "listenbrainz",
    data_scope: "saved_listen_json_selection",
    already_imported: false,
    effective_event_delta: 2,
    mapped_track_refs: 1,
    events_with_played_duration: 1,
  });
  assert.doesNotMatch(
    JSON.stringify(first),
    /PRIVATE_LISTENBRAINZ_STUDIO_SENTINEL|private\.example/u,
  );
  assert.doesNotMatch(JSON.stringify(first), new RegExp(root, "u"));
  assert.deepEqual(await directoryEntries(temporaryRoot), []);

  const repeatedResponse = await postHistoryJson(studio, history);
  const repeated = await repeatedResponse.json();
  assert.equal(repeatedResponse.status, 200);
  assert.equal(repeated.source.already_imported, true);
  assert.equal(repeated.source.effective_event_delta, 0);
  assert.equal(repeated.coverage.effective_listening_events, 4);
  assert.deepEqual(await directoryEntries(temporaryRoot), []);

  const tasteprintResponse = await fetch(
    new URL(repeated.tasteprint_url, studio.origin),
  );
  const tasteprint = await tasteprintResponse.text();
  assert.equal(tasteprintResponse.status, 200);
  assert.match(tasteprint, /Plays from different services are combined/u);
  assert.doesNotMatch(
    tasteprint,
    /PRIVATE_LISTENBRAINZ_STUDIO_SENTINEL|private\.example/u,
  );

  const tasteprintCardResponse = await fetch(
    new URL(repeated.tasteprint_card_url, studio.origin),
  );
  const tasteprintCard = await tasteprintCardResponse.text();
  assert.equal(tasteprintCardResponse.status, 200);
  assert.match(tasteprintCard, /Private listening recap/u);
  assert.match(tasteprintCard, /Read it before you share it/u);
  assert.doesNotMatch(
    tasteprintCard,
    /PRIVATE_LISTENBRAINZ_STUDIO_SENTINEL|private\.example/u,
  );
  assert.doesNotMatch(tasteprintCard, /<script|https?:\/\//iu);

  const store = await openListeningHistoryStore({ environment });
  const subjectId = store.localSubjectId();
  const profile = store.profileSummary({ subjectId, maxItems: 10 });
  assert.deepEqual(profile.source.providers, ["listenbrainz", "spotify"]);
  assert.equal(profile.coverage.events_with_played_duration, 3);
  assert.equal(
    store.subjectDataStatus({ subjectId }).effective_listening_events,
    4,
  );
  store.close();

  const database = await readFile(path.join(stateRoot, "listening-history.sqlite"));
  assert.equal(
    database.includes(Buffer.from("PRIVATE_LISTENBRAINZ_STUDIO_SENTINEL")),
    false,
  );
  assert.equal(database.includes(Buffer.from("private.example")), false);
  const historyAfter = await stat(historyPath);
  assert.equal(historyAfter.size, historyBefore.size);
  assert.equal(historyAfter.mtimeMs, historyBefore.mtimeMs);
});

test("Studio rejects invalid and oversized bodies without retaining upload files", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-studio-invalid-"));
  const temporaryRoot = path.join(root, "temporary");
  const studio = await startMoondogStudio({
    environment: {
      ...process.env,
      MOONDOG_STATE_HOME: path.join(root, "state"),
      MOONDOG_CONFIG_HOME: path.join(root, "config"),
    },
    temporaryRoot,
    maximumArchiveBytes: 32,
    maximumHistoryJsonBytes: 64,
  });
  context.after(async () => {
    await studio.close();
    await rm(root, { recursive: true, force: true });
  });

  const unsupported = await postArchive(
    studio,
    Buffer.from("unsupported", "utf8"),
    { "Content-Type": "application/octet-stream" },
  );
  const unsupportedBody = await unsupported.json();
  assert.equal(unsupported.status, 415);
  assert.equal(
    unsupportedBody.message,
    "Choose a Spotify .zip or ListenBrainz .json history file.",
  );
  assert.deepEqual(await directoryEntries(temporaryRoot), []);

  const wrongSignature = await postArchive(
    studio,
    Buffer.from("not a zip file", "utf8"),
  );
  assert.equal(wrongSignature.status, 422);
  assert.deepEqual(await directoryEntries(temporaryRoot), []);

  const oversized = await postArchive(studio, Buffer.alloc(33, 1));
  const oversizedBody = await oversized.json();
  assert.equal(oversized.status, 413);
  assert.equal(oversizedBody.message, "That ZIP is larger than Studio supports.");
  assert.deepEqual(await directoryEntries(temporaryRoot), []);

  const fakeZip = await postArchive(
    studio,
    Buffer.concat([Buffer.from("504b0304", "hex"), Buffer.alloc(12)]),
  );
  const fakeZipBody = await fakeZip.json();
  assert.equal(fakeZip.status, 422);
  assert.match(fakeZipBody.message, /ZIP/u);
  assert.doesNotMatch(JSON.stringify(fakeZipBody), new RegExp(root, "u"));
  assert.deepEqual(await directoryEntries(temporaryRoot), []);

  const invalidJson = await postHistoryJson(studio, Buffer.from("{", "utf8"));
  const invalidJsonBody = await invalidJson.json();
  assert.equal(invalidJson.status, 422);
  assert.match(invalidJsonBody.message, /invalid JSON/u);
  assert.deepEqual(await directoryEntries(temporaryRoot), []);

  const oversizedJson = await postHistoryJson(studio, Buffer.alloc(65, 32));
  const oversizedJsonBody = await oversizedJson.json();
  assert.equal(oversizedJson.status, 413);
  assert.equal(
    oversizedJsonBody.message,
    "That ListenBrainz JSON is larger than Studio supports.",
  );
  assert.deepEqual(await directoryEntries(temporaryRoot), []);

  const playingNow = await postHistoryJson(
    studio,
    {
      listen_type: "playing_now",
      payload: [],
    },
    { "Content-Type": "application/json; charset=utf-8" },
  );
  const playingNowBody = await playingNow.json();
  assert.equal(playingNow.status, 422);
  assert.match(playingNowBody.message, /not persistent listening history/u);
  assert.deepEqual(await directoryEntries(temporaryRoot), []);
});

test("Studio CLI rejects unrelated global options without starting a server", async () => {
  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["scripts/moondog.mjs", "studio", "--json"],
      { cwd: repositoryRoot },
    ),
    (error) => {
      assert.match(
        error.stderr,
        /Usage: moondog studio \[--demo \| --from <spotify-history\.zip> \[--from <spotify-history\.zip>\]\]\./u,
      );
      return true;
    },
  );
});

test("Studio CLI accepts --from and rejects an unreadable archive before binding", async () => {
  const missingArchive = path.join(
    tmpdir(),
    `moondog-missing-studio-archive-${process.pid}.zip`,
  );
  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["scripts/moondog.mjs", "studio", "--from", missingArchive],
      { cwd: repositoryRoot },
    ),
    (error) => {
      assert.match(error.stderr, /Spotify history ZIP could not be read safely/u);
      assert.doesNotMatch(error.stderr, /Usage: moondog studio/u);
      return true;
    },
  );
});
