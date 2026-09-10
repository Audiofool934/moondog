function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function orderedSubsequence(actual, expected) {
  let cursor = 0;
  for (const value of actual) {
    if (value === expected[cursor]) cursor += 1;
    if (cursor === expected.length) return true;
  }
  return expected.length === 0;
}

function countMaximum(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Math.max(0, ...counts.values());
}

function check(id, passed, detail, { critical = false, weight = 1 } = {}) {
  return { id, passed: passed === true, critical, weight, detail };
}

export function createDiscoveryScenarios({ seedQuery } = {}) {
  const similaritySeed =
    typeof seedQuery === "string" && seedQuery.trim()
      ? `先在我的个人曲库中搜索 ${seedQuery.trim()}，选一首结果作为可信种子。`
      : "先从我的个人曲库中选一首高熟悉度或有显式偏好证据、且适合做外部身份解析的曲目作为可信种子。";
  return [
    {
      id: "profile_grounded_external_catalog",
      label: "Profile-grounded external catalog",
      prompt:
        "根据我的长期聆听资料，给我 3 首个人曲库外的候选。避免同一艺人或同一张专辑扎堆，并明确说明证据边界。",
      requested_track_count: 3,
      expected_provider: "apple_music",
      required_capabilities: [
        "profile.summary",
        "music.catalog.track_search",
        "playlist.plan",
      ],
      maximum_tracks_per_artist: 2,
      maximum_tracks_per_release: 1,
    },
    {
      id: "trusted_seed_open_artist_similarity",
      label: "Trusted-seed open artist similarity",
      prompt: `${similaritySeed} 再通过开放的协同艺人相似通道，给我 4 首曲库外候选。不要把协同相似描述成音频相似。`,
      requested_track_count: 4,
      expected_provider: "listenbrainz",
      required_capabilities: [
        "library.search",
        "music.discovery.artist_similarity",
        "playlist.plan",
      ],
      maximum_tracks_per_artist: 2,
      maximum_tracks_per_release: 1,
    },
    {
      id: "profile_grounded_open_artist_similarity",
      label: "Profile-grounded open artist similarity",
      prompt:
        "先读取我的长期聆听画像，从其中选择一位有明确偏好或长期关注证据、且能在个人曲库中找到曲目的艺人。用一首真实曲库结果作为可信种子，再通过开放的协同艺人相似通道给我 4 首曲库外候选。如果第一个种子无法解析外部身份，可以换一个画像支持且曲库可验证的种子。不要把协同相似描述成音频相似。",
      requested_track_count: 4,
      expected_provider: "listenbrainz",
      required_capabilities: [
        "profile.summary",
        "library.search",
        "music.discovery.artist_similarity",
        "playlist.plan",
      ],
      maximum_tracks_per_artist: 2,
      maximum_tracks_per_release: 1,
    },
  ];
}

function providerChecks(discovery, scenario) {
  if (!isPlainObject(discovery)) {
    return [
      check(
        "provider_result_captured",
        false,
        `No ${scenario.expected_provider} discovery result was captured.`,
        { critical: true, weight: 2 },
      ),
    ];
  }
  const tracks = Array.isArray(discovery.tracks) ? discovery.tracks : [];
  const checks = [
    check(
      "provider_result_captured",
      discovery.source?.provider === scenario.expected_provider,
      `Expected ${scenario.expected_provider}, observed ${discovery.source?.provider ?? "none"}.`,
      { critical: true, weight: 2 },
    ),
    check(
      "provider_resolved",
      discovery.state === "resolved" && tracks.length > 0,
      `Provider state ${discovery.state ?? "missing"} with ${tracks.length} tracks.`,
      { critical: true, weight: 2 },
    ),
    check(
      "knownness_scope_safe",
      tracks.every(
        (track) =>
          track.knownness?.imported_library ===
            "not_found_by_exact_title_artist" &&
          track.knownness?.listening_history === "not_checked",
      ),
      "Every external candidate must state exact-library exclusion and unchecked listening history.",
      { weight: 2 },
    ),
  ];
  if (scenario.expected_provider === "apple_music") {
    checks.push(
      check(
        "lexical_provenance",
        tracks.every(
          (track) =>
            track.catalog_provider === "apple_music" &&
            Array.isArray(track.matched_queries) &&
            track.matched_queries.length > 0,
        ),
        "Apple candidates must retain one or more matched lexical queries.",
        { weight: 2 },
      ),
      check(
        "catalog_coverage_boundary",
        /not proof of personal fit|not proof of.*novelty/iu.test(
          discovery.source?.coverage ?? "",
        ),
        "Apple source coverage must refuse personal-fit or novelty proof.",
      ),
    );
  }
  if (scenario.expected_provider === "listenbrainz") {
    const seedName = normalizeText(discovery.seed?.canonical_artist_name);
    checks.push(
      check(
        "collaborative_provenance",
        tracks.every(
          (track) =>
            track.catalog_provider === "listenbrainz" &&
            track.discovery_basis?.kind ===
              "listenbrainz_collaborative_artist_similarity",
        ),
        "ListenBrainz candidates must retain collaborative artist-adjacency provenance.",
        { weight: 2 },
      ),
      check(
        "seed_artist_excluded",
        seedName.length > 0 &&
          tracks.every(
            (track) => normalizeText(track.artist_credit) !== seedName,
          ),
        "The trusted seed artist must not be returned as its own adjacent candidate.",
      ),
      check(
        "open_data_boundary",
        /CC0/u.test(discovery.source?.license ?? "") &&
          /not audio similarity/iu.test(discovery.source?.coverage ?? "") &&
          discovery.source?.identity_provider === "wikidata",
        "Open similarity must state CC0 input, Wikidata identity, and non-audio coverage.",
        { weight: 2 },
      ),
    );
  }
  return checks;
}

export function evaluateDiscoveryRun(run) {
  if (!isPlainObject(run) || !isPlainObject(run.scenario)) {
    throw new TypeError("A discovery evaluation run and scenario are required.");
  }
  const scenario = run.scenario;
  const result = isPlainObject(run.result) ? run.result : {};
  const plan = isPlainObject(result.playlist_plan) ? result.playlist_plan : null;
  const toolTrace = Array.isArray(run.tool_trace) ? run.tool_trace : [];
  const capabilityTrace = toolTrace
    .filter((entry) => entry?.event === "start")
    .map((entry) => entry.capability_id);
  const toolErrors = toolTrace.filter(
    (entry) => entry?.event === "end" && entry.is_error === true,
  );
  const discoveries = Array.isArray(run.discoveries) ? run.discoveries : [];
  const discovery =
    discoveries.find(
      (entry) =>
        entry?.source?.provider === scenario.expected_provider &&
        entry?.state === "resolved",
    ) ??
    discoveries.find(
      (entry) => entry?.source?.provider === scenario.expected_provider,
    );
  const planTracks = Array.isArray(plan?.tracks) ? plan.tracks : [];
  const planTrackIds = planTracks.map((track) => track.track_ref_id);
  const providerTrackIds = new Set(
    (Array.isArray(discovery?.tracks) ? discovery.tracks : []).map(
      (track) => track.track_ref_id,
    ),
  );
  const artistKeys = planTracks.map((track) => normalizeText(track.artist_credit));
  const releaseKeys = planTracks.map(
    (track) =>
      `${normalizeText(track.artist_credit)}|${normalizeText(track.release)}`,
  );
  const outputText = typeof result.text === "string" ? result.text : "";
  const sourceBoundaryRendered =
    scenario.expected_provider === "apple_music"
      ? /Apple Music US.*(?:检索于|retrieved)/iu.test(outputText)
      : /ListenBrainz.*Wikidata/iu.test(outputText) &&
        /CC0/u.test(outputText) &&
        /不是音频相似|not audio similarity/iu.test(outputText);

  const checks = [
    check(
      "run_completed",
      result.status === "completed",
      `Runtime status ${result.status ?? "missing"}.`,
      { critical: true, weight: 2 },
    ),
    check(
      "tools_succeeded",
      toolErrors.length === 0,
      `${toolErrors.length} tool executions reported errors.`,
      { critical: true, weight: 2 },
    ),
    check(
      "required_tool_order",
      orderedSubsequence(capabilityTrace, scenario.required_capabilities),
      `Observed ${capabilityTrace.join(" -> ") || "no tools"}.`,
      { critical: true, weight: 2 },
    ),
    ...providerChecks(discovery, scenario),
    check(
      "validated_plan_present",
      plan !== null,
      plan ? "A validated local playlist plan is present." : "No validated plan is present.",
      { critical: true, weight: 2 },
    ),
    check(
      "requested_count_exact",
      plan?.track_count === scenario.requested_track_count &&
        planTracks.length === scenario.requested_track_count,
      `Expected ${scenario.requested_track_count}, observed ${planTracks.length}.`,
      { critical: true, weight: 2 },
    ),
    check(
      "unique_track_refs",
      new Set(planTrackIds).size === planTrackIds.length,
      `${new Set(planTrackIds).size} unique refs across ${planTrackIds.length} selections.`,
      { critical: true },
    ),
    check(
      "trusted_provider_membership",
      planTrackIds.length > 0 &&
        planTrackIds.every((trackRefId) => providerTrackIds.has(trackRefId)),
      "Every plan track must belong to the captured external provider candidate set.",
      { critical: true, weight: 2 },
    ),
    check(
      "external_scope_only",
      plan?.candidate_scope === "external_catalog" &&
        planTracks.every(
          (track) => track.candidate_scope === "external_catalog",
        ),
      `Observed plan scope ${plan?.candidate_scope ?? "missing"}.`,
    ),
    check(
      "artist_concentration_bounded",
      countMaximum(artistKeys) <= scenario.maximum_tracks_per_artist,
      `Maximum tracks per artist: ${countMaximum(artistKeys)}.`,
      { weight: 2 },
    ),
    check(
      "release_concentration_bounded",
      countMaximum(releaseKeys) <= scenario.maximum_tracks_per_release,
      `Maximum tracks per artist-release pair: ${countMaximum(releaseKeys)}.`,
      { weight: 2 },
    ),
    check(
      "novelty_claim_bounded",
      /不代表你从未听过|does not mean you have never heard/iu.test(outputText),
      "Rendered output must refuse an unheard-status claim.",
      { weight: 2 },
    ),
    check(
      "user_facing_source_boundary",
      sourceBoundaryRendered,
      "Rendered output must identify the external source, retrieval boundary, and provider-specific interpretation limit.",
      { weight: 2 },
    ),
    check(
      "validation_scope_rendered",
      /校验范围|Validation scope/iu.test(outputText),
      "Rendered output must distinguish local validation from model judgment.",
    ),
  ];
  const earned = checks.reduce(
    (total, item) => total + (item.passed ? item.weight : 0),
    0,
  );
  const possible = checks.reduce((total, item) => total + item.weight, 0);
  const criticalFailures = checks.filter(
    (item) => item.critical && !item.passed,
  );
  const score = possible === 0 ? 0 : Math.round((earned / possible) * 100);
  return {
    evaluator_version: "discovery-evaluator/1",
    scenario_id: scenario.id,
    score,
    passed: score >= 85 && criticalFailures.length === 0,
    checks,
    critical_failures: criticalFailures.map((item) => item.id),
    metrics: {
      requested_tracks: scenario.requested_track_count,
      planned_tracks: planTracks.length,
      distinct_artists: new Set(artistKeys).size,
      distinct_artist_releases: new Set(releaseKeys).size,
      maximum_tracks_per_artist: countMaximum(artistKeys),
      maximum_tracks_per_artist_release: countMaximum(releaseKeys),
      tool_error_count: toolErrors.length,
    },
    interpretation_limit:
      "This evaluator measures provenance, trusted candidate membership, diversity, and boundary fidelity. It does not establish subjective music quality, personal novelty, or audio similarity.",
  };
}

export function summarizeDiscoveryEvaluation(report) {
  const lines = [
    `Discovery evaluation: ${report.passed ? "PASS" : "FAIL"}`,
    `Overall score: ${report.score}`,
  ];
  for (const run of report.runs) {
    const failed = run.checks.filter((item) => !item.passed).map((item) => item.id);
    lines.push(
      `${run.passed ? "PASS" : "FAIL"} ${run.scenario_id}: ${run.score}`,
      `  Tracks: ${run.metrics.planned_tracks}/${run.metrics.requested_tracks}, artists: ${run.metrics.distinct_artists}, artist-releases: ${run.metrics.distinct_artist_releases}`,
      `  Failed checks: ${failed.length > 0 ? failed.join(", ") : "none"}`,
    );
  }
  lines.push(
    "Limit: this gate does not score subjective music quality, personal novelty, or audio similarity.",
  );
  return lines.join("\n");
}
