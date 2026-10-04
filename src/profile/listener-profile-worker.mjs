import {
  compileListenerProfile, listenerProfileOverview, LISTENER_PROFILE_SYNTHESIS_VERSION, modelEvidence, validateProfileReview,
} from "./listener-profile-build.mjs";
import { createConfiguredProfileBuildRuntime } from "../runtime/pi/profile-build-runtime.mjs";

export async function runListenerProfileBuild({
  application, environment = process.env, signal, onProgress = () => {}, force = false,
  runtimeFactory = createConfiguredProfileBuildRuntime,
} = {}) {
  signal?.throwIfAborted();
  const { input, store } = application.getProfileBuildContext();
  if (!input.partitions.length) return { state: "no_evidence", reviewed_partitions: 0, total_partitions: 0 };
  const previous = store.current();
  if (!force && previous?.input_digest === input.input_digest && previous.synthesis_version === LISTENER_PROFILE_SYNTHESIS_VERSION) {
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
  let submission = null;
  const progress = () => ({
    phase: Object.keys(reviews).length === input.partitions.length ? "synthesis" : "review",
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
    const session = {
      phase: "review", manifest: input.manifest, overview, progress, findings,
      modelRetry: retry => { if (!signal?.aborted) onProgress({ ...progress(), model_retry: retry }); },
      read: (partitionId) => {
        signal?.throwIfAborted();
        const partition = input.partitions.find(part => part.partition_id === partitionId);
        if (!partition) throw new TypeError("Unknown profile digest partition");
        seen.add(partitionId);
        return { ...partition, semantics: input.manifest.sections.find(item => item.section === partition.section),
          items: partition.items.map(item => modelEvidence(item)) };
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
        return result;
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
        if (session.phase !== "synthesis") throw new Error("Finish page review before the separate synthesis session");
        if (submission) throw new Error("Submit the listener profile only once");
        submission = compileListenerProfile(input, reviews, value);
      },
    };
    while (!submission) {
      signal?.throwIfAborted();
      session.phase = Object.keys(reviews).length === input.partitions.length ? "synthesis" : "review";
      const reviewedBefore = Object.keys(reviews).length;
      const inspectedBefore = inspectedFindings.size;
      await runtime.investigate(session);
      signal?.throwIfAborted();
      if (submission) break;
      if (Object.keys(reviews).length === reviewedBefore && inspectedFindings.size === inspectedBefore) {
        throw new Error("The profile model stopped making progress. Saved findings and your previous reading are safe. Use /profile build to retry.");
      }
      // The turn limit bounds one model context, not the listener's build.
      // Saved reviews remain authoritative when the next fresh session starts.
      assertCurrentInput();
    }
    store.complete(build, submission, assertCurrentInput);
    return { state: "ready", revision: await application.getListenerProfile(), ...progress() };
  } catch (error) {
    store.interrupt(build);
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    runtime.abort?.();
  }
}
