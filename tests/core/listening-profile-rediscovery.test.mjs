import assert from "node:assert/strict";
import test from "node:test";

import { createListenerCorrection } from "../../src/profile/listener-corrections.mjs";
import { projectListeningProfile } from "../../src/profile/listening-profile-projection.mjs";

const subjectId = "11111111-1111-4111-8111-111111111111";

function track(trackRefId, title, artist, release = "Fictional release") {
  return {
    track_ref_id: trackRefId,
    revision: 1,
    identity_status: "resolved",
    title,
    artist_credits: [{ name: artist }],
    release: { title: release },
  };
}

function eventRow({ id, track: value, occurredAt, playedMs, skipped = false }) {
  return {
    track: value,
    event: {
      listening_event_id: id,
      subject_id: subjectId,
      track_ref_id: value.track_ref_id,
      occurred_at: occurredAt,
      event_type: skipped ? "play_skipped" : "play_observed",
      played_ms: playedMs,
      extensions: { "spotify.skipped": skipped },
      provenance: {
        external_ref: { system: "spotify_extended_streaming_history" },
        captured_at: "2026-09-01T00:00:00.000Z",
      },
    },
  };
}

function rowsFor(trackValue, prefix, dates, playedMs, skipped = false) {
  return dates.map((occurredAt, index) =>
    eventRow({
      id: `${prefix}-${index}`,
      track: trackValue,
      occurredAt,
      playedMs,
      skipped: Array.isArray(skipped) ? skipped[index] : skipped,
    }),
  );
}

test("rediscovery projection turns dormant attention into bounded listen-again prompts", () => {
  const explicit = track(
    "11111111-1111-4111-8111-111111111101",
    "Explicit Return",
    "Mara Vale",
  );
  const saved = track(
    "11111111-1111-4111-8111-111111111102",
    "Saved Return",
    "North Window",
  );
  const historical = track(
    "11111111-1111-4111-8111-111111111103",
    "Heavy Return",
    "Ash Meridian",
  );
  const avoided = track(
    "11111111-1111-4111-8111-111111111104",
    "Avoided Memory",
    "Static Bloom",
  );
  const thin = track(
    "11111111-1111-4111-8111-111111111105",
    "Too Thin",
    "Cinder Lake",
  );
  const skipped = track(
    "11111111-1111-4111-8111-111111111106",
    "Skipped Echo",
    "Low Lanterns",
  );
  const recent = track(
    "11111111-1111-4111-8111-111111111107",
    "Recent Spark",
    "Drift Assembly",
  );
  const oldDates = [
    "2024-01-01T00:00:00.000Z",
    "2024-02-01T00:00:00.000Z",
    "2024-03-01T00:00:00.000Z",
  ];
  const eventRows = [
    ...rowsFor(explicit, "explicit", oldDates, 240_000),
    ...rowsFor(saved, "saved", oldDates, 300_000),
    ...rowsFor(
      historical,
      "historical",
      [...oldDates, "2024-04-01T00:00:00.000Z", "2024-05-01T00:00:00.000Z"],
      600_000,
    ),
    ...rowsFor(avoided, "avoided", oldDates, 360_000),
    ...rowsFor(thin, "thin", oldDates.slice(0, 2), 360_000),
    ...rowsFor(
      skipped,
      "skipped",
      [...oldDates, "2024-04-01T00:00:00.000Z"],
      300_000,
      [false, true, true, true],
    ),
    ...rowsFor(recent, "recent", ["2026-08-30T00:00:00.000Z"], 240_000),
  ];
  const explicitLike = createListenerCorrection({
    subjectId,
    entityType: "track",
    label: explicit.title,
    artistCredit: explicit.artist_credits[0].name,
    stance: "like",
    occurredAt: "2026-08-30T00:00:00.000Z",
    correctionId: "22222222-2222-4222-8222-222222222201",
  }).record;
  const explicitAvoid = createListenerCorrection({
    subjectId,
    entityType: "artist",
    label: avoided.artist_credits[0].name,
    stance: "avoid",
    occurredAt: "2026-08-30T00:00:00.000Z",
    correctionId: "22222222-2222-4222-8222-222222222202",
  }).record;
  const profileEvidence = [
    {
      profile_evidence_id: "33333333-3333-4333-8333-333333333301",
      evidence_key: "saved-return",
      evidence_kind: "library_track_saved",
      direction: "supports",
      strength_class: "explicit",
      observed_at: "2026-08-01T00:00:00.000Z",
      entity: {
        entity_type: "track",
        track_ref_id: saved.track_ref_id,
        label: saved.title,
        artist_credit: saved.artist_credits[0].name,
        release: saved.release.title,
      },
      attributes: {},
      provenance: {
        captured_at: "2026-08-01T00:00:00.000Z",
        source_member: "Library.json",
      },
    },
  ];

  const projected = projectListeningProfile({
    subjectId,
    eventRows,
    profileEvidence,
    tasteEvents: [explicitLike, explicitAvoid],
    maxItems: 10,
  });
  const candidates = projected.summary.listening_behavior.rediscovery_tracks;

  assert.deepEqual(
    candidates.map((item) => item.label),
    ["Explicit Return", "Saved Return", "Heavy Return"],
  );
  assert.equal(candidates[0].rediscovery_signal, "explicit listener preference");
  assert.equal(candidates[1].rediscovery_signal, "saved-library state");
  assert.equal(candidates[2].rediscovery_signal, "historical attention only");
  assert.equal(candidates[1].peak_year, 2024);
  assert.equal(candidates[1].peak_year_play_count, 3);
  assert.equal(candidates[1].peak_year_listening_minutes, 15);
  assert.ok(candidates[0].quiet_days > 800);
  assert.equal(candidates.some((item) => item.label === "Avoided Memory"), false);
  assert.equal(candidates.some((item) => item.label === "Too Thin"), false);
  assert.equal(candidates.some((item) => item.label === "Skipped Echo"), false);
  assert.equal(candidates.some((item) => item.label === "Recent Spark"), false);

  const explanation = projected.explanations.get(candidates[0].evidence_id);
  assert.equal(explanation.claim.dimension, "listening.rediscovery_candidate");
  assert.match(explanation.basis_summary, /quiet for [0-9]+ days/iu);
  assert.match(explanation.interpretation_limit, /not proof of liking/iu);
});

test("time capsule projection selects diverse landmarks across retained years", () => {
  const first = track(
    "11111111-1111-4111-8111-111111111201",
    "First Landmark",
    "Shared Artist",
  );
  const middle = track(
    "11111111-1111-4111-8111-111111111202",
    "Middle Landmark",
    "Middle Artist",
  );
  const repeatedArtist = track(
    "11111111-1111-4111-8111-111111111203",
    "Louder Repeat",
    "Shared Artist",
  );
  const diverseAlternative = track(
    "11111111-1111-4111-8111-111111111204",
    "Different Window",
    "Other Artist",
  );
  const latest = track(
    "11111111-1111-4111-8111-111111111205",
    "Latest Landmark",
    "Present Artist",
  );
  const avoided = track(
    "11111111-1111-4111-8111-111111111206",
    "Avoided Landmark",
    "Avoided Artist",
  );
  const twoPlays = (trackValue, prefix, year, playedMs) =>
    rowsFor(
      trackValue,
      prefix,
      [
        `${year}-02-01T00:00:00.000Z`,
        `${year}-03-01T00:00:00.000Z`,
      ],
      playedMs,
    );
  const avoid = createListenerCorrection({
    subjectId,
    entityType: "track",
    label: avoided.title,
    artistCredit: avoided.artist_credits[0].name,
    stance: "avoid",
    occurredAt: "2026-08-30T00:00:00.000Z",
    correctionId: "22222222-2222-4222-8222-222222222301",
  }).record;

  const projected = projectListeningProfile({
    subjectId,
    eventRows: [
      ...twoPlays(first, "first", 2020, 240_000),
      ...twoPlays(middle, "middle", 2022, 240_000),
      ...twoPlays(repeatedArtist, "repeat", 2024, 360_000),
      ...twoPlays(diverseAlternative, "alternative", 2024, 300_000),
      ...twoPlays(latest, "latest", 2026, 240_000),
      ...twoPlays(avoided, "avoided", 2023, 600_000),
    ],
    tasteEvents: [avoid],
    maxItems: 3,
  });
  const candidates = projected.summary.listening_behavior.time_capsule_tracks;

  assert.deepEqual(
    candidates.map((item) => [item.capsule_year, item.label]),
    [
      [2020, "First Landmark"],
      [2024, "Different Window"],
      [2026, "Latest Landmark"],
    ],
  );
  assert.equal(
    candidates.some((item) => item.label === "Avoided Landmark"),
    false,
  );
  assert.equal(candidates[1].year_play_count, 2);
  assert.equal(candidates[1].year_engaged_play_count, 2);
  assert.equal(candidates[1].year_listening_minutes, 10);
  assert.equal(candidates[1].representative_signal, "historical attention only");
  const explanation = projected.explanations.get(candidates[1].evidence_id);
  assert.equal(
    explanation.claim.dimension,
    "listening.time_capsule_representative",
  );
  assert.match(explanation.interpretation_limit, /not proof that it defined/iu);
});
