import {
  compileListenerProfile, listenerProfileOverview, LISTENER_PROFILE_SYNTHESIS_VERSION, modelEvidence, profileDigest, validateProfileReview,
} from "./listener-profile-build.mjs";
import { listenerProfileCandidate, searchListenerProfileEvidence, validateListenerProfileVerification } from "./listener-profile-verification.mjs";
import { createConfiguredProfileBuildRuntime } from "../runtime/pi/profile-build-runtime.mjs";

const MAX_REPAIRS_PER_BUILD = 2;
// Up to five focused check batches per draft, two repairs, and one spare context.
const MAX_FINALIZATION_SESSIONS = 18;

export async function runListenerProfileBuild({
  application, environment = process.env, signal, onProgress = () => {}, force = false,
  runtimeFactory = createConfiguredProfileBuildRuntime,
} = {}) {
  signal?.throwIfAborted();
  const { input, store } = application.getProfileBuildContext();
  if (!input.partitions.length) return { state: "no_evidence", reviewed_partitions: 0, total_partitions: 0 };
  const previous = store.current();
  if (!force && previous?.input_digest === input.input_digest && previous.synthesis_version === LISTENER_PROFILE_SYNTHESIS_VERSION &&
      previous.verification?.state === "passed") {
    return { state: "unchanged", revision: await application.getListenerProfile(),
      reviewed_partitions: input.partitions.length, total_partitions: input.partitions.length };
  }
  const runtime = await runtimeFactory(environment);
  const status = runtime.publicStatus();
  if (status.state !== "configured") throw new Error("Connect a model with /model, then use /profile build. Your imported profile is still available.");
  const model = { provider: status.provider, model: status.model, worker_version: status.worker_version };
  const build = store.begin(input, model, { force });
  const reviews = build.reviews;
  const seen = new Set(Object.keys(reviews));
  const inspectedFindings = new Set();
  const inspectedEvidence = new Set();
  // Drafts and checks are checkpoints, never current profile revisions.
  let finalization = build.finalization?.synthesis_version === LISTENER_PROFILE_SYNTHESIS_VERSION
    ? structuredClone(build.finalization)
    : { synthesis_version: LISTENER_PROFILE_SYNTHESIS_VERSION, draft: null, verification: null,
      repair_count: 0, verification_attempts: 0, reused_checks: 0 };
  let compiled = finalization.draft ? compileListenerProfile(input, reviews, finalization.draft) : null;
  let candidate = compiled ? listenerProfileCandidate(input, compiled) : null;
  if (finalization.verification) {
    // Revalidate the exact checkpoint after restart before accepting its decision.
    finalization.verification = { ...validateListenerProfileVerification(input, candidate, finalization.verification, { allowPartial: true }),
      checked_at: finalization.verification.checked_at };
  }
  let repairsThisRun = 0;
  let finalizationSessions = 0;
  let stageFinished = false;
  const phase = () => Object.keys(reviews).length !== input.partitions.length ? "review"
    : !candidate ? "synthesis" : !finalization.verification || finalization.verification.state === "checking" ? "verification"
    : finalization.verification.state === "passed" ? "complete" : "repair";
  const progress = () => ({
    phase: phase(), repair_attempt: repairsThisRun, max_repairs: MAX_REPAIRS_PER_BUILD,
    verification_attempts: finalization.verification_attempts,
    checked_targets: finalization.verification?.checks.length ?? 0,
    total_check_targets: candidate ? candidate.insights.length + 2 : 0,
    reviewed_partitions: Object.keys(reviews).length, total_partitions: input.partitions.length,
    reused_partitions: build.reused_partitions,
    pending: input.partitions.filter(part => !reviews[part.partition_id]).slice(0, 12)
      .map(({ partition_id, section, offset, total, items }) => ({ partition_id, section, offset, total, rows: items.length })),
  });
  const partitionSections = new Map(input.partitions.map(part => [part.partition_id, part.section]));
  const overview = listenerProfileOverview(input);
  const findings = (offset, { section, query } = {}) => {
    if (section !== undefined && !input.manifest.sections.some(item => item.section === section)) throw new TypeError("Unknown findings section");
    if (query !== undefined && (typeof query !== "string" || query.length > 200)) throw new TypeError("Invalid findings query");
    const needle = query?.normalize("NFKC").toLocaleLowerCase();
    const all = Object.values(reviews).filter(review => !section || partitionSections.get(review.partition_id) === section)
      .flatMap(review => review.claims.map(claim => ({ ...claim, section: partitionSections.get(review.partition_id) })))
      .filter(claim => !needle || JSON.stringify([claim.statement, claim.scope, claim.uncertainty,
        ...claim.supporting_refs.map(ref => modelEvidence(input.evidence.get(ref)).data)])
        .normalize("NFKC").toLocaleLowerCase().includes(needle));
    // A fresh model session picks up the unread findings instead of starting
    // synthesis from the first twelve again. Explicit offsets can revisit them.
    offset ??= Math.max(0, all.findIndex(claim => !inspectedFindings.has(claim.claim_id)));
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("Invalid findings offset");
    const items = all.slice(offset, offset + 12);
    for (const claim of items) inspectedFindings.add(claim.claim_id);
    return { total: all.length, offset, items,
      next_offset: offset + 12 < all.length ? offset + 12 : null };
  };
  const assertCurrentInput = () => {
    signal?.throwIfAborted();
    if (application.getProfileBuildContext().input.input_digest !== input.input_digest) {
      throw new Error("Your music or choices changed during the build. Use /profile build to read the updated evidence.");
    }
  };
  const abort = () => runtime.abort?.();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    onProgress(progress());
    const inspected = entry => { inspectedEvidence.add(profileDigest(entry)); return entry; };
    const session = {
      phase: "review", manifest: input.manifest, overview, progress, findings,
      get candidate() { return candidate; },
      get verification() { return finalization.verification; },
      search: args => {
        signal?.throwIfAborted();
        const result = searchListenerProfileEvidence(input, args);
        result.items.forEach(inspected);
        return result;
      },
      modelRetry: retry => { if (!signal?.aborted) onProgress({ ...progress(), model_retry: retry }); },
      read: (partitionId) => {
        signal?.throwIfAborted();
        const partition = input.partitions.find(part => part.partition_id === partitionId);
        if (!partition) throw new TypeError("Unknown profile digest partition");
        seen.add(partitionId);
        return { ...partition, semantics: input.manifest.sections.find(item => item.section === partition.section),
          items: partition.items.map(item => inspected(modelEvidence(item))) };
      },
      evidence: async (referenceId, offset = 0) => {
        signal?.throwIfAborted();
        if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("Invalid evidence offset");
        const entry = input.evidence.get(referenceId);
        if (!entry) throw new TypeError("Unknown profile evidence reference");
        const result = modelEvidence(entry, offset);
        if (entry.data.evidence_id) {
          try {
            const detail = await application.explainProfileEvidence({ evidenceId: entry.data.evidence_id });
            result.explanation = { basis: detail.basis_summary, limitation: detail.interpretation_limit ?? detail.limitation };
          } catch { /* The frozen digest remains the source for aggregate-only rows. */ }
        }
        return inspected(result);
      },
      review: (partitionId, value) => {
        signal?.throwIfAborted();
        if (session.phase !== "review") throw new Error("Page findings are fixed during final synthesis");
        if (!seen.has(partitionId)) throw new Error("Read a digest before reviewing it");
        if (reviews[partitionId]) throw new Error("This partition already has saved findings");
        const review = validateProfileReview(input, partitionId, value);
        store.checkpoint(build, review);
        reviews[partitionId] = review;
        const next = progress();
        onProgress(next);
        return { ...next, saved_claims: review.claims };
      },
      submit: (value) => {
        signal?.throwIfAborted();
        if (!["synthesis", "repair"].includes(session.phase)) throw new Error("Submit a candidate only during synthesis or repair");
        if (stageFinished) throw new Error("Submit only one candidate per synthesis or repair session");
        const next = compileListenerProfile(input, reviews, value);
        const nextCandidate = listenerProfileCandidate(input, next);
        // An unchanged claim keeps its raw-evidence check within this frozen input.
        // Summary and coverage always need another whole-candidate check.
        const unchanged = new Set(nextCandidate.insights.map(claim => claim.claim_id));
        const retained = session.phase === "repair" ? finalization.verification.checks
          .filter(check => check.status === "supported" && unchanged.has(check.target)) : [];
        const nextFinalization = { ...finalization,
          draft: { summary: nextCandidate.summary, insights: nextCandidate.insights },
          verification: retained.length ? validateListenerProfileVerification(input, nextCandidate,
            { candidate_id: nextCandidate.candidate_id, checks: retained }, { allowPartial: true }) : null,
          reused_checks: retained.length,
          repair_count: finalization.repair_count + Number(session.phase === "repair") };
        store.checkpointFinalization(build, nextFinalization);
        compiled = next;
        candidate = nextCandidate;
        finalization = nextFinalization;
        if (session.phase === "repair") repairsThisRun++;
        stageFinished = true;
        onProgress(progress());
      },
      repair: ({ summary, changes = [], additions = [] }) => {
        if (session.phase !== "repair") throw new Error("Repair a candidate only after its verification is complete");
        if (!Array.isArray(changes) || !Array.isArray(additions)) throw new TypeError("Repair needs change and addition arrays");
        const failed = new Set(finalization.verification.checks.filter(check => check.status === "revise").map(check => check.target));
        const replacements = new Map(changes.map(change => [change?.claim_id, change?.replacement]));
        if (replacements.size !== changes.length || changes.some(change => !failed.has(change?.claim_id) ||
            !candidate.insights.some(claim => claim.claim_id === change.claim_id)) ||
            (additions.length && !failed.has("coverage"))) {
          throw new TypeError("Change only failed claim IDs once; add insights only when coverage needs repair");
        }
        session.submit({ summary: summary ?? candidate.summary,
          insights: [...candidate.insights.map(claim => replacements.has(claim.claim_id)
            ? replacements.get(claim.claim_id) : claim).filter(claim => claim !== null), ...additions] });
      },
      verify: value => {
        signal?.throwIfAborted();
        if (session.phase !== "verification" || stageFinished) throw new Error("Verify once in the separate verification session");
        if (value?.candidate_id !== candidate.candidate_id) throw new TypeError("Verification must identify the current profile candidate");
        if (!Array.isArray(value.checks)) throw new TypeError("Verification needs check rows");
        const verification = validateListenerProfileVerification(input, candidate, {
          candidate_id: value.candidate_id, checks: [...(finalization.verification?.checks ?? []), ...value.checks],
        }, { allowPartial: true });
        const next = { ...finalization, verification,
          verification_attempts: finalization.verification_attempts + Number(verification.state !== "checking") };
        store.checkpointFinalization(build, next);
        finalization = next;
        stageFinished = true;
        onProgress(progress());
        return { state: verification.state, issues: verification.checks.filter(check => check.status === "revise").length };
      },
    };
    while (phase() !== "complete") {
      signal?.throwIfAborted();
      session.phase = phase();
      stageFinished = false;
      if (session.phase === "repair" && repairsThisRun >= MAX_REPAIRS_PER_BUILD) {
        throw new Error("The profile still has unsupported conclusions after two automatic repairs. Your previous reading and all checkpoints are kept. Retry /profile build or choose another model.");
      }
      if (["verification", "repair"].includes(session.phase) && ++finalizationSessions > MAX_FINALIZATION_SESSIONS) {
        throw new Error("The profile reached its automatic checking limit. Your previous reading and all checkpoints are kept. Use /profile build to continue.");
      }
      const reviewedBefore = Object.keys(reviews).length;
      const inspectedBefore = inspectedFindings.size + inspectedEvidence.size;
      await runtime.investigate(session);
      signal?.throwIfAborted();
      assertCurrentInput();
      if (!stageFinished && Object.keys(reviews).length === reviewedBefore &&
          inspectedFindings.size + inspectedEvidence.size === inspectedBefore) {
        throw new Error("The profile model stopped making progress. Saved findings and your previous reading are safe. Use /profile build to retry.");
      }
      // The turn limit bounds one model context, not the listener's build.
      // Saved reviews remain authoritative when the next fresh session starts.
    }
    store.complete(build, { ...compiled, verification: { ...finalization.verification,
      repair_count: finalization.repair_count, attempts: finalization.verification_attempts,
      reused_checks: finalization.reused_checks ?? 0 } }, assertCurrentInput);
    return { state: "ready", revision: await application.getListenerProfile(), ...progress() };
  } catch (error) {
    store.interrupt(build);
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    runtime.abort?.();
  }
}
