import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import {
  DISCOVERY_REVIEW_CLAIM_THRESHOLDS,
  validateCompletedHumanReview,
  validateHumanReviewManifest,
  validateHumanReviewPacket,
} from "./discovery-human-review.mjs";

const REVIEW_PACKET_VERSION = "discovery-human-review/1";
const REVIEW_MANIFEST_VERSION = "discovery-human-review-manifest/1";
const REVIEW_SUMMARY_VERSION = "discovery-human-review-summary/1";

function artifactIssue(artifact, code, error) {
  return {
    artifact,
    code,
    message: error instanceof Error ? error.message : String(error),
  };
}

function isReviewArtifactName(name) {
  return (
    name.startsWith("discovery-human-review-") ||
    name.startsWith("completed-")
  );
}

function hasReviewAttempt(packet) {
  const reviewer = packet?.reviewer;
  if (
    reviewer &&
    (reviewer.reviewer_id !== null ||
      reviewer.reviewed_at !== null ||
      reviewer.independent !== null)
  ) {
    return true;
  }
  return (Array.isArray(packet?.cases) ? packet.cases : []).some((reviewCase) =>
    (Array.isArray(reviewCase?.recommendations)
      ? reviewCase.recommendations
      : []
    ).some(
      (recommendation) =>
        recommendation?.would_listen !== null ||
        Object.values(recommendation?.ratings ?? {}).some(
          (rating) => rating !== null,
        ),
    ),
  );
}

function formPacketId(name) {
  const match = /^discovery-human-review-(dhr-[A-Za-z0-9-]+)\.html$/u.exec(
    name,
  );
  return match?.[1] ?? null;
}

function addUniqueArtifact(map, record, issues, code) {
  const existing = map.get(record.packetId);
  if (existing) {
    issues.push(
      artifactIssue(
        record.name,
        code,
        new Error(
          `Duplicate artifact for packet ${record.packetId}; already found ${existing.name}.`,
        ),
      ),
    );
    return;
  }
  map.set(record.packetId, record);
}

function providerGateRows({ reviews, manifests }) {
  const providers = new Map();
  const acceptedReviewKeys = new Set();
  const acceptedReviews = [];
  const issues = [];

  for (const manifest of manifests.values()) {
    for (const mapping of manifest.value.cases) {
      if (!providers.has(mapping.provider)) {
        providers.set(mapping.provider, {
          provider: mapping.provider,
          recommendationRatings: 0,
          reviewerIds: new Set(),
          independentReviewerIds: new Set(),
        });
      }
    }
  }

  for (const review of reviews) {
    const reviewKey = `${review.packetId}:${review.validation.reviewer_id}`;
    if (acceptedReviewKeys.has(reviewKey)) {
      issues.push(
        artifactIssue(
          review.name,
          "duplicate_completed_review",
          new Error(`Duplicate completed review for packet ${review.packetId}.`),
        ),
      );
      continue;
    }
    const manifest = manifests.get(review.packetId);
    if (!manifest) {
      issues.push(
        artifactIssue(
          review.name,
          "completed_review_missing_manifest",
          new Error(
            `No valid private manifest was found for packet ${review.packetId}.`,
          ),
        ),
      );
      continue;
    }
    acceptedReviewKeys.add(reviewKey);
    acceptedReviews.push(review);
    const mappingByCase = new Map(
      manifest.value.cases.map((mapping) => [mapping.case_id, mapping]),
    );
    for (const reviewCase of review.value.cases) {
      const provider = mappingByCase.get(reviewCase.case_id).provider;
      const row = providers.get(provider);
      row.recommendationRatings += reviewCase.recommendations.length;
      row.reviewerIds.add(review.validation.reviewer_id);
      if (review.validation.independent) {
        row.independentReviewerIds.add(review.validation.reviewer_id);
      }
    }
  }

  const thresholds = DISCOVERY_REVIEW_CLAIM_THRESHOLDS;
  const gates = [...providers.values()]
    .sort((left, right) => left.provider.localeCompare(right.provider, "en"))
    .map((row) => {
      const independentReviewers = row.independentReviewerIds.size;
      const recommendationRatings = row.recommendationRatings;
      return {
        provider: row.provider,
        independent_reviewers: independentReviewers,
        recommendation_ratings: recommendationRatings,
        missing_independent_reviewers: Math.max(
          0,
          thresholds.minimum_independent_reviewers_per_provider -
            independentReviewers,
        ),
        missing_recommendation_ratings: Math.max(
          0,
          thresholds.minimum_recommendation_ratings_per_provider -
            recommendationRatings,
        ),
        passed:
          independentReviewers >=
            thresholds.minimum_independent_reviewers_per_provider &&
          recommendationRatings >=
            thresholds.minimum_recommendation_ratings_per_provider,
      };
    });

  return {
    acceptedReviews,
    issues,
    gate: {
      ready: gates.length > 0 && gates.every((gate) => gate.passed),
      thresholds: { ...thresholds },
      providers: gates,
    },
  };
}

function packetBundleRows({ packets, manifests, forms, reviews }) {
  const packetIds = new Set([
    ...packets.keys(),
    ...manifests.keys(),
    ...forms.keys(),
    ...reviews.map((review) => review.packetId),
  ]);
  return [...packetIds]
    .sort((left, right) => left.localeCompare(right, "en"))
    .map((packetId) => {
      const packet = packets.get(packetId);
      const manifest = manifests.get(packetId);
      const form = forms.get(packetId);
      const packetReviews = reviews.filter(
        (review) => review.packetId === packetId,
      );
      const independentReviewers = new Set(
        packetReviews
          .filter((review) => review.validation.independent)
          .map((review) => review.validation.reviewer_id),
      );
      const issues = [];
      if (!packet) issues.push("missing_packet");
      if (!manifest) issues.push("missing_manifest");
      if (!form) issues.push("missing_review_form");
      if (packetReviews.length === 0) issues.push("no_completed_reviews");
      return {
        packet_id: packetId,
        cases:
          packet?.validation.case_count ??
          packetReviews[0]?.validation.case_count ??
          manifest?.validation.case_count ??
          0,
        recommendations:
          packet?.validation.recommendation_count ??
          packetReviews[0]?.validation.recommendation_count ??
          0,
        packet: packet?.name ?? null,
        private_manifest: manifest?.name ?? null,
        review_form: form?.name ?? null,
        completed_reviews: packetReviews.length,
        independent_reviewers: independentReviewers.size,
        distribution_ready: Boolean(packet && manifest && form),
        issues,
      };
    });
}

function nextActions(status) {
  const actions = [];
  if (!status.directory_exists || status.counts.packet_templates === 0) {
    actions.push({
      code: "create_packet",
      message:
        "Run a discovery evaluation, then create a private blind packet from its report.",
    });
  }
  for (const bundle of status.bundles) {
    if (bundle.packet && !bundle.review_form) {
      actions.push({
        code: "create_missing_form",
        packet_id: bundle.packet_id,
        message: `Generate the missing local HTML form from ${bundle.packet}.`,
      });
    }
    if (bundle.packet && !bundle.private_manifest) {
      actions.push({
        code: "recreate_missing_manifest",
        packet_id: bundle.packet_id,
        message:
          "Recreate this packet from its private discovery report because provider mappings cannot be recovered from the blind packet.",
      });
    }
  }
  const distributableWithoutReviews = status.bundles.filter(
    (bundle) => bundle.distribution_ready && bundle.completed_reviews === 0,
  ).length;
  if (distributableWithoutReviews > 0) {
    actions.push({
      code: "collect_reviews",
      message: `Give the ${distributableWithoutReviews} prepared local review form${distributableWithoutReviews === 1 ? "" : "s"} to independent human reviewers and validate every downloaded JSON file.`,
    });
  }
  if (status.invalid_artifacts.length > 0) {
    actions.push({
      code: "resolve_invalid_artifacts",
      message: `Resolve ${status.invalid_artifacts.length} invalid or duplicate review artifact${status.invalid_artifacts.length === 1 ? "" : "s"} before publishing aggregate findings.`,
    });
  }
  if (!status.claim_gate.ready && status.claim_gate.providers.length > 0) {
    actions.push({
      code: "close_claim_gate",
      message:
        "Collect enough independent completed reviews to close every provider-level reviewer and rating gap shown above.",
    });
  }
  if (status.claim_gate.ready) {
    actions.push({
      code: "publish_aggregate_only",
      message:
        "Create and inspect an aggregate-only summary before making any public recommendation-quality claim.",
    });
  }
  return actions;
}

export async function inspectDiscoveryReviewDirectory(
  inputDirectory,
  { generatedAt = new Date().toISOString() } = {},
) {
  const directory = path.resolve(inputDirectory);
  let entries;
  let directoryExists = true;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    entries = [];
    directoryExists = false;
  }

  const issues = [];
  const packets = new Map();
  const rawManifests = new Map();
  const manifests = new Map();
  const forms = new Map();
  const reviews = [];
  let aggregateSummaries = 0;

  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name, "en"),
  )) {
    if (!entry.isFile()) continue;
    const packetId = formPacketId(entry.name);
    if (packetId) {
      forms.set(packetId, { packetId, name: entry.name });
      continue;
    }
    if (!entry.name.endsWith(".json")) continue;
    let value;
    try {
      value = JSON.parse(await readFile(path.join(directory, entry.name), "utf8"));
    } catch (error) {
      if (isReviewArtifactName(entry.name)) {
        issues.push(artifactIssue(entry.name, "invalid_json", error));
      }
      continue;
    }

    if (value?.review_packet_version === REVIEW_PACKET_VERSION) {
      if (hasReviewAttempt(value)) {
        try {
          const validation = validateCompletedHumanReview(value);
          reviews.push({
            packetId: validation.packet_id,
            name: entry.name,
            value,
            validation,
          });
        } catch (error) {
          issues.push(
            artifactIssue(entry.name, "invalid_completed_review", error),
          );
        }
      } else {
        try {
          const validation = validateHumanReviewPacket(value);
          addUniqueArtifact(
            packets,
            {
              packetId: validation.packet_id,
              name: entry.name,
              value,
              validation,
            },
            issues,
            "duplicate_packet",
          );
        } catch (error) {
          issues.push(artifactIssue(entry.name, "invalid_packet", error));
        }
      }
      continue;
    }

    if (value?.manifest_version === REVIEW_MANIFEST_VERSION) {
      addUniqueArtifact(
        rawManifests,
        {
          packetId: value.packet_id,
          name: entry.name,
          value,
        },
        issues,
        "duplicate_manifest",
      );
      continue;
    }

    if (value?.report_version === REVIEW_SUMMARY_VERSION) {
      aggregateSummaries += 1;
      continue;
    }

    if (isReviewArtifactName(entry.name)) {
      issues.push(
        artifactIssue(
          entry.name,
          "unsupported_review_artifact",
          new Error("The file does not use a supported human-review schema."),
        ),
      );
    }
  }

  for (const manifest of rawManifests.values()) {
    const anchor =
      packets.get(manifest.packetId)?.value ??
      reviews.find((review) => review.packetId === manifest.packetId)?.value;
    if (!anchor) {
      issues.push(
        artifactIssue(
          manifest.name,
          "manifest_missing_packet",
          new Error(
            `No packet or completed review was found for ${manifest.packetId}.`,
          ),
        ),
      );
      continue;
    }
    try {
      manifest.validation = validateHumanReviewManifest(manifest.value, anchor);
      manifests.set(manifest.packetId, manifest);
    } catch (error) {
      issues.push(artifactIssue(manifest.name, "invalid_manifest", error));
    }
  }

  const providerRows = providerGateRows({ reviews, manifests });
  issues.push(...providerRows.issues);
  const bundles = packetBundleRows({
    packets,
    manifests,
    forms,
    reviews: providerRows.acceptedReviews,
  });
  const reviewerIds = new Set(
    providerRows.acceptedReviews.map(
      (review) => review.validation.reviewer_id,
    ),
  );
  const independentReviewerIds = new Set(
    providerRows.acceptedReviews
      .filter((review) => review.validation.independent)
      .map((review) => review.validation.reviewer_id),
  );
  const status = {
    status_version: "discovery-human-review-status/1",
    generated_at: generatedAt,
    privacy: {
      classification: "private_local_operations",
      omitted:
        "Track, artist, release, seed, prompt, reviewer ID, model, profile details, and absolute artifact paths.",
    },
    input_directory: path.basename(directory),
    directory_exists: directoryExists,
    counts: {
      packet_templates: packets.size,
      private_manifests: manifests.size,
      review_forms: forms.size,
      completed_reviews: providerRows.acceptedReviews.length,
      reviewers: reviewerIds.size,
      independent_reviewers: independentReviewerIds.size,
      aggregate_summaries: aggregateSummaries,
      invalid_artifacts: issues.length,
      distribution_ready_bundles: bundles.filter(
        (bundle) => bundle.distribution_ready,
      ).length,
    },
    bundles,
    claim_gate: providerRows.gate,
    invalid_artifacts: issues,
  };
  status.next_actions = nextActions(status);
  return status;
}

export function summarizeDiscoveryReviewStatus(status) {
  const lines = [
    "Discovery human review status",
    `Directory: ${status.input_directory}${status.directory_exists ? "" : " (not created)"}`,
    `Prepared bundles: ${status.counts.distribution_ready_bundles}/${status.bundles.length}`,
    `Completed reviews: ${status.counts.completed_reviews}`,
    `Independent reviewers: ${status.counts.independent_reviewers}`,
    `Invalid artifacts: ${status.counts.invalid_artifacts}`,
    `Representative claim gate: ${status.claim_gate.ready ? "READY" : "NOT READY"}`,
  ];
  for (const provider of status.claim_gate.providers) {
    lines.push(
      `Provider ${provider.provider}: ${provider.independent_reviewers}/${status.claim_gate.thresholds.minimum_independent_reviewers_per_provider} independent reviewers, ${provider.recommendation_ratings}/${status.claim_gate.thresholds.minimum_recommendation_ratings_per_provider} recommendation ratings - ${provider.passed ? "READY" : "NOT READY"}`,
    );
  }
  for (const bundle of status.bundles) {
    lines.push(
      `Packet ${bundle.packet_id}: ${bundle.distribution_ready ? "prepared" : "incomplete"}, ${bundle.completed_reviews} completed review${bundle.completed_reviews === 1 ? "" : "s"}${bundle.issues.length > 0 ? ` (${bundle.issues.join(", ")})` : ""}`,
    );
  }
  if (status.next_actions.length > 0) {
    lines.push("Next actions:");
    status.next_actions.forEach((action, index) => {
      lines.push(`${index + 1}. ${action.message}`);
    });
  }
  lines.push(
    "Privacy: local operations only. No music titles, reviewer IDs, profile details, or absolute paths are shown.",
  );
  return lines.join("\n");
}
