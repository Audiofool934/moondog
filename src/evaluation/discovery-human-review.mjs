import { createHash } from "node:crypto";

const SCORE_MINIMUM = 1;
const SCORE_MAXIMUM = 5;
const FORBIDDEN_BLIND_KEYS = new Set([
  "candidate_scope",
  "discovery_basis",
  "expected_provider",
  "model",
  "prompt",
  "provider",
  "runtime",
  "scenario_id",
  "source_artifact",
  "tool_trace",
  "track_ref_id",
]);

export const DISCOVERY_REVIEW_DIMENSIONS = Object.freeze([
  Object.freeze({
    id: "relevance",
    label: "Relevance",
    question:
      "How well does this recommendation fit the stated request and visible seed context?",
    anchors: Object.freeze({
      1: "Clearly irrelevant",
      3: "Plausible but weak",
      5: "Strongly relevant",
    }),
  }),
  Object.freeze({
    id: "serendipity",
    label: "Serendipity",
    question:
      "Does this feel usefully surprising instead of obvious, random, or redundant?",
    anchors: Object.freeze({
      1: "Obvious or random",
      3: "Some useful surprise",
      5: "Unexpected and compelling",
    }),
  }),
  Object.freeze({
    id: "canonical_recording_quality",
    label: "Canonical recording quality",
    question:
      "Is the selected track and release version an appropriate representative recording rather than an intro, interview, bootleg, duplicate, or awkward edition?",
    anchors: Object.freeze({
      1: "Clearly poor version choice",
      3: "Usable but uncertain",
      5: "Clearly appropriate version",
    }),
  }),
  Object.freeze({
    id: "explanation_usefulness",
    label: "Explanation usefulness",
    question:
      "Does the explanation provide a specific, decision-useful reason without inventing evidence?",
    anchors: Object.freeze({
      1: "Generic or unsupported",
      3: "Partly useful",
      5: "Specific and well bounded",
    }),
  }),
]);

export const DISCOVERY_REVIEW_CLAIM_THRESHOLDS = Object.freeze({
  minimum_independent_reviewers_per_provider: 3,
  minimum_recommendation_ratings_per_provider: 12,
});

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function scoreMean(values) {
  if (values.length === 0) return null;
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  return Math.round(mean * 100) / 100;
}

function isoTimestamp(value, label) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${label} must be an ISO timestamp.`);
  }
  return value;
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be an object.`);
  return value;
}

function assertNonEmptyString(value, label, { maximum = 4000 } = {}) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  if (value.length > maximum) {
    throw new RangeError(`${label} must be at most ${maximum} characters.`);
  }
  return value;
}

function assertOptionalString(value, label, { maximum = 4000 } = {}) {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string.`);
  }
  if (value.length > maximum) {
    throw new RangeError(`${label} must be at most ${maximum} characters.`);
  }
  return value;
}

function assertNoForbiddenBlindKeys(value, path = "packet") {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertNoForbiddenBlindKeys(item, `${path}[${index}]`),
    );
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, nestedValue] of Object.entries(value)) {
    if (FORBIDDEN_BLIND_KEYS.has(key)) {
      throw new TypeError(`Blind review packet contains forbidden key ${path}.${key}.`);
    }
    assertNoForbiddenBlindKeys(nestedValue, `${path}.${key}`);
  }
}

function requestSummary(scenarioId, trackCount) {
  if (scenarioId === "profile_grounded_external_catalog") {
    return `Using long-term listening evidence, recommend ${trackCount} tracks outside the imported library.`;
  }
  if (scenarioId === "trusted_seed_open_artist_similarity") {
    return `Starting from one trusted track in the imported library, recommend ${trackCount} tracks outside it.`;
  }
  if (scenarioId === "profile_grounded_open_artist_similarity") {
    return `Using long-term listening evidence, choose one trusted library seed and recommend ${trackCount} tracks outside the imported library.`;
  }
  return `Evaluate a set of ${trackCount} music recommendations against the visible context.`;
}

function compactUnique(items, key, maximum = 8) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const value = typeof item?.[key] === "string" ? item[key].trim() : "";
    const normalized = value.normalize("NFKC").toLocaleLowerCase("und");
    if (!value || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(item);
    if (result.length === maximum) break;
  }
  return result;
}

export function createHumanReviewProfileContext(summary, { maximum = 8 } = {}) {
  if (!isPlainObject(summary)) return null;
  const boundedMaximum = Number.isInteger(maximum)
    ? Math.min(10, Math.max(1, maximum))
    : 8;
  const strongPreferences = compactUnique(
    (Array.isArray(summary.strong_preferences)
      ? summary.strong_preferences
      : []
    ).map((item) => ({ label: String(item?.label ?? "").trim() })),
    "label",
    boundedMaximum,
  );
  const familiarity = compactUnique(
    (Array.isArray(summary.familiarity) ? summary.familiarity : []).map(
      (item) => ({
        label: String(item?.label ?? "").trim(),
        level: new Set(["low", "medium", "high"]).has(item?.level)
          ? item.level
          : "unspecified",
      }),
    ),
    "label",
    boundedMaximum,
  );
  const artistFacets = compactUnique(
    (Array.isArray(summary.artist_facets) ? summary.artist_facets : []).map(
      (item) => ({ name: String(item?.name ?? "").trim() }),
    ),
    "name",
    boundedMaximum,
  );
  const genreFacets = compactUnique(
    (Array.isArray(summary.genre_facets) ? summary.genre_facets : []).map(
      (item) => ({ name: String(item?.name ?? "").trim() }),
    ),
    "name",
    boundedMaximum,
  );
  if (
    strongPreferences.length === 0 &&
    familiarity.length === 0 &&
    artistFacets.length === 0 &&
    genreFacets.length === 0
  ) {
    return null;
  }
  return {
    strong_preferences: strongPreferences,
    familiarity,
    artist_facets: artistFacets,
    genre_facets: genreFacets,
  };
}

function visibleProfileAnchors(rawRun) {
  const contexts = Array.isArray(rawRun.human_review_contexts)
    ? rawRun.human_review_contexts
    : [];
  const normalized = contexts
    .map((context) => createHumanReviewProfileContext(context, { maximum: 10 }))
    .filter(Boolean);
  if (normalized.length === 0) return null;
  return {
    strong_preferences: compactUnique(
      normalized.flatMap((context) => context.strong_preferences),
      "label",
      10,
    ),
    familiarity: compactUnique(
      normalized.flatMap((context) => context.familiarity),
      "label",
      10,
    ),
    artist_facets: compactUnique(
      normalized.flatMap((context) => context.artist_facets),
      "name",
      10,
    ),
    genre_facets: compactUnique(
      normalized.flatMap((context) => context.genre_facets),
      "name",
      10,
    ),
  };
}

function visibleSeed(discoveries, expectedProvider) {
  const discovery = discoveries.find(
    (entry) => entry?.source?.provider === expectedProvider && entry?.seed,
  );
  if (!discovery?.seed) return null;
  return {
    title: String(discovery.seed.title ?? ""),
    artist_credit: String(
      discovery.seed.artist_credit ?? discovery.seed.artist_name ?? "",
    ),
    release: String(discovery.seed.release ?? ""),
  };
}

function observedProvider(rawRun) {
  const discoveries = Array.isArray(rawRun.discoveries) ? rawRun.discoveries : [];
  const expectedProvider = rawRun.scenario?.expected_provider;
  const matched = discoveries.find(
    (entry) => entry?.source?.provider === expectedProvider,
  );
  return matched?.source?.provider ?? expectedProvider ?? "unknown";
}

function reviewRatingsTemplate() {
  return Object.fromEntries(
    DISCOVERY_REVIEW_DIMENSIONS.map((dimension) => [dimension.id, null]),
  );
}

function makeCase(rawRun, caseIndex) {
  const scenario = assertPlainObject(rawRun.scenario, "raw run scenario");
  const result = assertPlainObject(rawRun.result, "raw run result");
  const plan = assertPlainObject(
    result.playlist_plan,
    `playlist plan for ${scenario.id ?? caseIndex + 1}`,
  );
  const tracks = Array.isArray(plan.tracks) ? plan.tracks : [];
  if (result.status !== "completed" || tracks.length === 0) {
    throw new TypeError(
      `Raw run ${scenario.id ?? caseIndex + 1} has no completed playlist plan.`,
    );
  }
  const caseId = `case-${String(caseIndex + 1).padStart(2, "0")}`;
  const discoveries = Array.isArray(rawRun.discoveries) ? rawRun.discoveries : [];
  const profileAnchors = visibleProfileAnchors(rawRun);
  return {
    case_id: caseId,
    request_summary: requestSummary(scenario.id, tracks.length),
    context: {
      seed: visibleSeed(discoveries, scenario.expected_provider),
      profile_anchors: profileAnchors,
      personal_context_boundary:
        profileAnchors === null
          ? "No bounded profile anchors were captured for this run. Judge only the visible request, seed, recommendations, and explanations. Do not interpret this as a full personal-relevance test."
          : "Only bounded provider-neutral profile anchors are shown. The raw listening history, evidence identifiers, counts, and provider signals are intentionally omitted.",
    },
    recommendations: tracks.map((track, trackIndex) => ({
      recommendation_id: `${caseId}-rec-${String(trackIndex + 1).padStart(2, "0")}`,
      position: Number.isInteger(track.position) ? track.position : trackIndex + 1,
      title: String(track.title ?? ""),
      artist_credit: String(track.artist_credit ?? ""),
      release: String(track.release ?? ""),
      explanation: String(track.selection_reason ?? ""),
      ratings: reviewRatingsTemplate(),
      would_listen: null,
      comment: "",
    })),
    overall_comment: "",
  };
}

function blindContent(packet) {
  return {
    review_packet_version: packet.review_packet_version,
    packet_id: packet.packet_id,
    methodology: {
      blinding: packet.methodology?.blinding,
      scale: packet.methodology?.scale,
      dimensions: Array.isArray(packet.methodology?.dimensions)
        ? packet.methodology.dimensions.map((dimension) => ({
            id: dimension.id,
            label: dimension.label,
            question: dimension.question,
            anchors: dimension.anchors,
          }))
        : [],
    },
    cases: Array.isArray(packet.cases)
      ? packet.cases.map((reviewCase) => ({
          case_id: reviewCase.case_id,
          request_summary: reviewCase.request_summary,
          context: reviewCase.context,
          recommendations: Array.isArray(reviewCase.recommendations)
            ? reviewCase.recommendations.map((recommendation) => ({
                recommendation_id: recommendation.recommendation_id,
                position: recommendation.position,
                title: recommendation.title,
                artist_credit: recommendation.artist_credit,
                release: recommendation.release,
                explanation: recommendation.explanation,
              }))
            : [],
        }))
      : [],
  };
}

export function computeBlindContentDigest(packet) {
  return sha256(JSON.stringify(blindContent(packet)));
}

export function createHumanReviewBundle(
  report,
  { generatedAt = new Date().toISOString(), sourceArtifact = "discovery-evaluation.json" } = {},
) {
  assertPlainObject(report, "discovery evaluation report");
  isoTimestamp(generatedAt, "generatedAt");
  const rawRuns = Array.isArray(report.raw_runs) ? report.raw_runs : [];
  if (rawRuns.length === 0) {
    throw new TypeError("Discovery evaluation report contains no raw runs.");
  }
  const completedRuns = rawRuns.filter(
    (rawRun) =>
      rawRun?.result?.status === "completed" &&
      Array.isArray(rawRun?.result?.playlist_plan?.tracks) &&
      rawRun.result.playlist_plan.tracks.length > 0,
  );
  if (completedRuns.length === 0) {
    throw new TypeError("Discovery evaluation report contains no completed plans.");
  }
  const sourceDigest = sha256(JSON.stringify(report));
  const packetId = `dhr-${sourceDigest.slice(0, 16)}`;
  const cases = completedRuns.map(makeCase);
  const packet = {
    review_packet_version: "discovery-human-review/1",
    packet_id: packetId,
    created_at: generatedAt,
    privacy: {
      classification: "private_local_review",
      contains_personal_music_context: true,
      share_boundary:
        "Keep this packet local. Publish only aggregate summaries created from the private manifest.",
    },
    methodology: {
      blinding:
        "Provider, model, tool trace, source identifiers, raw prompt, and raw listening profile are omitted.",
      scale: {
        minimum: SCORE_MINIMUM,
        maximum: SCORE_MAXIMUM,
        integer_only: true,
      },
      dimensions: DISCOVERY_REVIEW_DIMENSIONS.map((dimension) => ({
        id: dimension.id,
        label: dimension.label,
        question: dimension.question,
        anchors: { ...dimension.anchors },
      })),
      instructions: [
        "Use an opaque reviewer ID instead of a name or email address.",
        "Listen to or verify the exact title and release when practical before scoring canonical recording quality.",
        "Score each recommendation independently from 1 to 5 on every dimension.",
        "Set would_listen to yes, maybe, or no.",
        "Do not infer hidden provider behavior or unpublished personal taste evidence.",
      ],
    },
    reviewer: {
      reviewer_id: null,
      reviewed_at: null,
      independent: null,
    },
    cases,
    blind_content_sha256: null,
  };
  packet.blind_content_sha256 = computeBlindContentDigest(packet);
  assertNoForbiddenBlindKeys(packet);

  const structuralRuns = new Map(
    (Array.isArray(report.runs) ? report.runs : []).map((run) => [
      run?.scenario_id,
      run,
    ]),
  );
  const manifest = {
    manifest_version: "discovery-human-review-manifest/1",
    packet_id: packetId,
    created_at: generatedAt,
    privacy: {
      classification: "private_local_manifest",
      share_boundary:
        "This manifest can reveal provider and private evaluation context. Do not publish it.",
    },
    source: {
      artifact_basename: String(sourceArtifact).split(/[\\/]/u).at(-1),
      report_sha256: sourceDigest,
    },
    blind_content_sha256: packet.blind_content_sha256,
    cases: completedRuns.map((rawRun, index) => {
      const scenarioId = String(rawRun.scenario?.id ?? `unknown-${index + 1}`);
      const structural = structuralRuns.get(scenarioId);
      return {
        case_id: cases[index].case_id,
        scenario_id: scenarioId,
        provider: observedProvider(rawRun),
        structural_score: Number.isFinite(structural?.score)
          ? structural.score
          : null,
        structural_passed:
          typeof structural?.passed === "boolean" ? structural.passed : null,
      };
    }),
  };
  return { packet, manifest };
}

function validatePacketStructure(packet) {
  assertPlainObject(packet, "review packet");
  if (packet.review_packet_version !== "discovery-human-review/1") {
    throw new TypeError("Unsupported discovery human review packet version.");
  }
  assertNonEmptyString(packet.packet_id, "packet_id", { maximum: 128 });
  if (!/^dhr-[a-f0-9]{16}$/u.test(packet.packet_id)) {
    throw new TypeError("packet_id must use the generated dhr- plus 16-hex format.");
  }
  if (packet.privacy?.classification !== "private_local_review") {
    throw new TypeError("Review packet must remain classified as private_local_review.");
  }
  const dimensions = Array.isArray(packet.methodology?.dimensions)
    ? packet.methodology.dimensions
    : [];
  const observedDimensionIds = dimensions.map((dimension) => dimension?.id);
  const expectedDimensionIds = DISCOVERY_REVIEW_DIMENSIONS.map(
    (dimension) => dimension.id,
  );
  if (JSON.stringify(observedDimensionIds) !== JSON.stringify(expectedDimensionIds)) {
    throw new TypeError("Review packet dimensions do not match the supported rubric.");
  }
  if (!Array.isArray(packet.cases) || packet.cases.length === 0) {
    throw new TypeError("Review packet must contain at least one case.");
  }
  assertNoForbiddenBlindKeys(packet);
  const expectedDigest = computeBlindContentDigest(packet);
  if (packet.blind_content_sha256 !== expectedDigest) {
    throw new TypeError("Review packet blind content digest does not match its content.");
  }
  return expectedDimensionIds;
}

export function validateHumanReviewPacket(packet) {
  validatePacketStructure(packet);
  return {
    packet_id: packet.packet_id,
    case_count: packet.cases.length,
    recommendation_count: packet.cases.reduce(
      (total, reviewCase) =>
        total +
        (Array.isArray(reviewCase.recommendations)
          ? reviewCase.recommendations.length
          : 0),
      0,
    ),
  };
}

export function validateCompletedHumanReview(packet) {
  const dimensionIds = validatePacketStructure(packet);
  const reviewer = assertPlainObject(packet.reviewer, "reviewer");
  const reviewerId = assertNonEmptyString(
    reviewer.reviewer_id,
    "reviewer.reviewer_id",
    { maximum: 64 },
  );
  if (!/^[A-Za-z0-9._-]+$/u.test(reviewerId)) {
    throw new TypeError(
      "reviewer.reviewer_id must be an opaque label using letters, numbers, dots, underscores, or hyphens.",
    );
  }
  isoTimestamp(reviewer.reviewed_at, "reviewer.reviewed_at");
  if (typeof reviewer.independent !== "boolean") {
    throw new TypeError("reviewer.independent must be true or false.");
  }

  let recommendationCount = 0;
  for (const reviewCase of packet.cases) {
    assertPlainObject(reviewCase, "review case");
    assertNonEmptyString(reviewCase.case_id, "case_id", { maximum: 128 });
    assertOptionalString(reviewCase.overall_comment, "overall_comment");
    if (
      !Array.isArray(reviewCase.recommendations) ||
      reviewCase.recommendations.length === 0
    ) {
      throw new TypeError(`${reviewCase.case_id} contains no recommendations.`);
    }
    for (const recommendation of reviewCase.recommendations) {
      assertPlainObject(recommendation, "recommendation");
      assertNonEmptyString(
        recommendation.recommendation_id,
        "recommendation_id",
        { maximum: 128 },
      );
      const ratings = assertPlainObject(
        recommendation.ratings,
        `${recommendation.recommendation_id}.ratings`,
      );
      for (const dimensionId of dimensionIds) {
        const score = ratings[dimensionId];
        if (
          !Number.isInteger(score) ||
          score < SCORE_MINIMUM ||
          score > SCORE_MAXIMUM
        ) {
          throw new RangeError(
            `${recommendation.recommendation_id}.${dimensionId} must be an integer from ${SCORE_MINIMUM} to ${SCORE_MAXIMUM}.`,
          );
        }
      }
      if (!new Set(["yes", "maybe", "no"]).has(recommendation.would_listen)) {
        throw new TypeError(
          `${recommendation.recommendation_id}.would_listen must be yes, maybe, or no.`,
        );
      }
      assertOptionalString(
        recommendation.comment,
        `${recommendation.recommendation_id}.comment`,
      );
      recommendationCount += 1;
    }
  }
  return {
    packet_id: packet.packet_id,
    reviewer_id: reviewerId,
    independent: reviewer.independent,
    case_count: packet.cases.length,
    recommendation_count: recommendationCount,
  };
}

function validateManifest(manifest, packet) {
  assertPlainObject(manifest, "review manifest");
  if (manifest.manifest_version !== "discovery-human-review-manifest/1") {
    throw new TypeError("Unsupported discovery human review manifest version.");
  }
  if (manifest.packet_id !== packet.packet_id) {
    throw new TypeError("Review manifest packet ID does not match the review packet.");
  }
  if (manifest.blind_content_sha256 !== packet.blind_content_sha256) {
    throw new TypeError("Review manifest digest does not match the review packet.");
  }
  if (manifest.privacy?.classification !== "private_local_manifest") {
    throw new TypeError("Review manifest must remain classified as private_local_manifest.");
  }
  if (!Array.isArray(manifest.cases) || manifest.cases.length === 0) {
    throw new TypeError("Review manifest contains no cases.");
  }
  const mappings = new Map();
  for (const mapping of manifest.cases) {
    assertPlainObject(mapping, "manifest case mapping");
    assertNonEmptyString(mapping.case_id, "manifest case_id", { maximum: 128 });
    assertNonEmptyString(mapping.provider, "manifest provider", { maximum: 128 });
    if (mappings.has(mapping.case_id)) {
      throw new TypeError(`Duplicate manifest case mapping ${mapping.case_id}.`);
    }
    mappings.set(mapping.case_id, mapping);
  }
  for (const reviewCase of packet.cases) {
    if (!mappings.has(reviewCase.case_id)) {
      throw new TypeError(`Manifest has no mapping for ${reviewCase.case_id}.`);
    }
  }
  const packetCaseIds = new Set(
    packet.cases.map((reviewCase) => reviewCase.case_id),
  );
  for (const mappedCaseId of mappings.keys()) {
    if (!packetCaseIds.has(mappedCaseId)) {
      throw new TypeError(`Manifest maps unknown review case ${mappedCaseId}.`);
    }
  }
  return mappings;
}

export function validateHumanReviewManifest(manifest, packet) {
  const mappings = validateManifest(manifest, packet);
  return {
    packet_id: manifest.packet_id,
    case_count: mappings.size,
  };
}

function aggregateDimensions(rows) {
  return Object.fromEntries(
    DISCOVERY_REVIEW_DIMENSIONS.map((dimension) => {
      const values = rows.map((row) => row.ratings[dimension.id]);
      const distribution = Object.fromEntries(
        Array.from(
          { length: SCORE_MAXIMUM - SCORE_MINIMUM + 1 },
          (_, index) => String(index + SCORE_MINIMUM),
        ).map((score) => [
          score,
          values.filter((value) => value === Number(score)).length,
        ]),
      );
      return [
        dimension.id,
        {
          mean: scoreMean(values),
          ratings: values.length,
          distribution,
        },
      ];
    }),
  );
}

function aggregateIntent(rows) {
  const counts = { yes: 0, maybe: 0, no: 0 };
  for (const row of rows) counts[row.would_listen] += 1;
  return {
    ...counts,
    responses: rows.length,
    yes_rate: rows.length === 0 ? null : Math.round((counts.yes / rows.length) * 1000) / 1000,
  };
}

export function createPublicHumanReviewSummary(
  { reviews, manifests },
  { generatedAt = new Date().toISOString() } = {},
) {
  if (!Array.isArray(reviews) || reviews.length === 0) {
    throw new TypeError("At least one completed review is required.");
  }
  if (!Array.isArray(manifests) || manifests.length === 0) {
    throw new TypeError("At least one private manifest is required.");
  }
  isoTimestamp(generatedAt, "generatedAt");
  const manifestByPacket = new Map();
  for (const manifest of manifests) {
    assertPlainObject(manifest, "review manifest");
    if (manifestByPacket.has(manifest.packet_id)) {
      throw new TypeError(`Duplicate manifest for packet ${manifest.packet_id}.`);
    }
    manifestByPacket.set(manifest.packet_id, manifest);
  }

  const rows = [];
  const caseRows = [];
  const reviewKeys = new Set();
  for (const review of reviews) {
    const validation = validateCompletedHumanReview(review);
    const manifest = manifestByPacket.get(validation.packet_id);
    if (!manifest) {
      throw new TypeError(`No manifest was supplied for packet ${validation.packet_id}.`);
    }
    const mappings = validateManifest(manifest, review);
    const reviewKey = `${validation.packet_id}:${validation.reviewer_id}`;
    if (reviewKeys.has(reviewKey)) {
      throw new TypeError(`Duplicate completed review ${reviewKey}.`);
    }
    reviewKeys.add(reviewKey);
    for (const reviewCase of review.cases) {
      const mapping = mappings.get(reviewCase.case_id);
      caseRows.push({
        provider: mapping.provider,
        reviewer_id: validation.reviewer_id,
        independent: validation.independent,
      });
      for (const recommendation of reviewCase.recommendations) {
        rows.push({
          provider: mapping.provider,
          reviewer_id: validation.reviewer_id,
          independent: validation.independent,
          ratings: recommendation.ratings,
          would_listen: recommendation.would_listen,
        });
      }
    }
  }

  const providers = [...new Set(rows.map((row) => row.provider))]
    .sort((left, right) => left.localeCompare(right, "en"))
    .map((provider) => {
      const providerRows = rows.filter((row) => row.provider === provider);
      const providerCases = caseRows.filter((row) => row.provider === provider);
      const reviewerIds = new Set(providerRows.map((row) => row.reviewer_id));
      const independentReviewerIds = new Set(
        providerRows
          .filter((row) => row.independent)
          .map((row) => row.reviewer_id),
      );
      return {
        provider,
        completed_cases: providerCases.length,
        recommendation_ratings: providerRows.length,
        reviewers: reviewerIds.size,
        independent_reviewers: independentReviewerIds.size,
        dimensions: aggregateDimensions(providerRows),
        behavioral_intent: aggregateIntent(providerRows),
      };
    });
  const minimumIndependentReviewers =
    DISCOVERY_REVIEW_CLAIM_THRESHOLDS.minimum_independent_reviewers_per_provider;
  const minimumRatingsPerProvider =
    DISCOVERY_REVIEW_CLAIM_THRESHOLDS.minimum_recommendation_ratings_per_provider;
  const providerGates = providers.map((provider) => ({
    provider: provider.provider,
    passed:
      provider.independent_reviewers >= minimumIndependentReviewers &&
      provider.recommendation_ratings >= minimumRatingsPerProvider,
    independent_reviewers: provider.independent_reviewers,
    recommendation_ratings: provider.recommendation_ratings,
  }));
  const reviewerIds = new Set(rows.map((row) => row.reviewer_id));
  const independentReviewerIds = new Set(
    rows.filter((row) => row.independent).map((row) => row.reviewer_id),
  );
  return {
    report_version: "discovery-human-review-summary/1",
    generated_at: generatedAt,
    privacy: {
      classification: "aggregate_only",
      omitted:
        "Track, artist, release, seed, prompt, reviewer ID, model, tool trace, artifact path, and personal profile details.",
    },
    counts: {
      completed_reviews: reviews.length,
      completed_cases: caseRows.length,
      recommendation_ratings: rows.length,
      reviewers: reviewerIds.size,
      independent_reviewers: independentReviewerIds.size,
    },
    dimensions: aggregateDimensions(rows),
    behavioral_intent: aggregateIntent(rows),
    providers,
    representative_claim_gate: {
      ready: providerGates.length > 0 && providerGates.every((gate) => gate.passed),
      thresholds: {
        minimum_independent_reviewers_per_provider: minimumIndependentReviewers,
        minimum_recommendation_ratings_per_provider: minimumRatingsPerProvider,
      },
      providers: providerGates,
    },
    interpretation_limit:
      "These are subjective human judgments from a bounded sample. The aggregate does not prove personal novelty, universal recommendation quality, or audio similarity.",
  };
}

export function summarizeHumanReviewSummary(report) {
  const dimensionText = DISCOVERY_REVIEW_DIMENSIONS.map((dimension) => {
    const aggregate = report.dimensions?.[dimension.id];
    return `${dimension.label}: ${aggregate?.mean ?? "n/a"} (${aggregate?.ratings ?? 0} ratings)`;
  });
  return [
    "Discovery human review summary",
    `Completed reviews: ${report.counts.completed_reviews}`,
    `Reviewers: ${report.counts.reviewers} (${report.counts.independent_reviewers} independent)`,
    `Recommendation ratings: ${report.counts.recommendation_ratings}`,
    ...dimensionText,
    `Representative claim gate: ${report.representative_claim_gate.ready ? "READY" : "NOT READY"}`,
    "Privacy: aggregate only. Track, seed, reviewer, model, prompt, path, and profile details are omitted.",
  ].join("\n");
}
