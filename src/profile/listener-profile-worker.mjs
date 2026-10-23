import {
  CHECKED_PROFILE_STATES, compileListenerProfile, listenerProfileDossier, LISTENER_PROFILE_SYNTHESIS_VERSION, modelEvidence,
  sameListenerChoices,
} from "./listener-profile-build.mjs";
import {
  LISTENER_PROFILE_CHECK_VERSION, listenerProfileCandidate, searchListenerProfileEvidence, validateListenerProfileCheck,
} from "./listener-profile-verification.mjs";
import { createConfiguredProfileBuildRuntime } from "../runtime/pi/profile-build-runtime.mjs";

// One draft, one check, at most one revision and its check. Spare sessions let
// a model that hits its turn limit continue the same stage.
const MAX_REVISIONS = 1;
const MAX_SESSIONS = 8;

const HOUR_MS = 3_600_000;
// A reading that only new plays have overtaken is rebuilt after a week or 300 plays.
// Changed choices or analysis rebuild it at once. Any build attempt, the listener's
// or this one, holds off the next background attempt for half a day.
export const PROFILE_REFRESH = { listeningAgeMs: 7 * 24 * HOUR_MS, newPlays: 300, attemptGapMs: 12 * HOUR_MS };

/** Rebuild a saved reading that newer evidence has overtaken, without being asked. */
export async function refreshListenerProfileIfDue({ application, now = Date.now(), ...options } = {}) {
  // The first reading is the listener's to ask for.
  if (!application.profileBuildReady()) return { state: "unavailable" };
  const reading = await application.getListenerProfile({ limit: 1 });
  if (reading.state !== "stale") return { state: reading.state };
  const { input, store } = application.getProfileBuildContext();
  const lastAttempt = Date.parse(store.lastAttemptAt() ?? "");
  if (now - lastAttempt < PROFILE_REFRESH.attemptGapMs) return { state: "waiting" };
  if (reading.newer_listening_only) {
    const newPlays = (input.manifest.coverage?.effective_listening_events ?? 0) -
      (reading.coverage?.coverage?.effective_listening_events ?? 0);
    if (now - Date.parse(reading.built_at) < PROFILE_REFRESH.listeningAgeMs && newPlays < PROFILE_REFRESH.newPlays) {
      return { state: "waiting" };
    }
  }
  return runListenerProfileBuild({ ...options, application });
}

export async function runListenerProfileBuild({
  application, environment = process.env, signal, onProgress = () => {}, force = false,
  runtimeFactory = createConfiguredProfileBuildRuntime,
} = {}) {
  signal?.throwIfAborted();
  const { input, store } = application.getProfileBuildContext();
  if (!input.evidence.size) return { state: "no_evidence" };
  const previous = store.current();
  if (!force && previous?.input_digest === input.input_digest && previous.synthesis_version === LISTENER_PROFILE_SYNTHESIS_VERSION &&
      CHECKED_PROFILE_STATES.has(previous.verification?.state)) {
    return { state: "unchanged", revision: await application.getListenerProfile() };
  }
  const runtime = await runtimeFactory(environment);
  const status = runtime.publicStatus();
  if (status.state !== "configured") throw new Error("Connect a model with /model, then use /profile build. Your imported profile is still available.");
  const model = { provider: status.provider, model: status.model, worker_version: status.worker_version };
  const build = store.begin(input, model, { force });
  // Drafts and checks are checkpoints, never current profile revisions.
  let finalization = build.finalization?.synthesis_version === LISTENER_PROFILE_SYNTHESIS_VERSION
    ? structuredClone(build.finalization)
    : { synthesis_version: LISTENER_PROFILE_SYNTHESIS_VERSION, draft: null, checks: [], revisions: 0 };
  let compiled = finalization.draft ? compileListenerProfile(input, finalization.draft) : null;
  let candidate = compiled ? listenerProfileCandidate(input, compiled) : null;
  const latestCheck = () => finalization.checks.at(-1) ?? null;
  const phase = () => !candidate ? "synthesis"
    : latestCheck()?.candidate_id !== candidate.candidate_id ? "check"
    : latestCheck().verdict === "revise" && finalization.revisions < MAX_REVISIONS ? "revision" : "complete";
  const progress = () => ({ phase: phase(), checks: finalization.checks.length, revisions: finalization.revisions,
    evidence_rows: input.evidence.size, resumed: build.resumed });
  const inspected = new Set();
  let stageFinished = false;
  // Plays synced during a long build do not stop it: the reading is saved as current up to the
  // plays it read. A changed Like or Avoid does, since the reading could contradict it.
  const assertCurrentInput = () => {
    signal?.throwIfAborted();
    if (!sameListenerChoices(input.evidence, application.getProfileBuildContext().input.evidence)) {
      throw new Error("Your choices changed during the build. Use /profile build to read the updated evidence.");
    }
  };
  // The checkpoint commits before memory changes, so a lost lease leaves both unchanged.
  const save = (next, apply = () => {}) => {
    store.checkpointFinalization(build, next);
    apply();
    finalization = next;
    stageFinished = true;
    onProgress(progress());
  };
  const session = {
    phase: phase(), manifest: input.manifest, dossier: listenerProfileDossier(input), progress,
    language: application.locale ?? "en",
    get candidate() { return candidate; },
    get check() { return latestCheck(); },
    search: args => {
      signal?.throwIfAborted();
      const result = searchListenerProfileEvidence(input, args);
      for (const item of result.items) inspected.add(item.reference_id);
      return result;
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
          // The prose basis restates the row's measures, including any this input leaves out as unrecorded.
          result.explanation = { ...(input.unrecorded?.has(referenceId) ? {} : { basis: detail.basis_summary }),
            limitation: detail.interpretation_limit ?? detail.limitation };
        } catch { /* The frozen row remains the source for aggregate-only evidence. */ }
      }
      inspected.add(referenceId);
      return result;
    },
    modelRetry: retry => { if (!signal?.aborted) onProgress({ ...progress(), model_retry: retry }); },
    submit: value => {
      signal?.throwIfAborted();
      if (!["synthesis", "revision"].includes(session.phase)) throw new Error("Submit a profile only while writing or revising it");
      if (stageFinished) throw new Error("Submit one complete profile per session");
      const next = compileListenerProfile(input, value);
      const nextCandidate = listenerProfileCandidate(input, next);
      save({ ...finalization, draft: { summary: nextCandidate.summary, insights: nextCandidate.insights },
        revisions: finalization.revisions + Number(session.phase === "revision") }, () => {
        compiled = next;
        candidate = nextCandidate;
      });
      return { state: "draft_saved", next: "check" };
    },
    record: value => {
      signal?.throwIfAborted();
      if (session.phase !== "check" || stageFinished) throw new Error("Record one check in the separate check session");
      const check = validateListenerProfileCheck(candidate, value);
      save({ ...finalization, checks: [...finalization.checks, check] });
      return { verdict: check.verdict, issues: check.issues.length };
    },
  };
  const abort = () => runtime.abort?.();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    onProgress(progress());
    let sessions = 0;
    while (phase() !== "complete") {
      signal?.throwIfAborted();
      session.phase = phase();
      stageFinished = false;
      if (++sessions > MAX_SESSIONS) {
        throw new Error("The profile build reached its session limit. Your previous reading and the saved draft are kept. Use /profile build to continue.");
      }
      const inspectedBefore = inspected.size;
      await runtime.investigate(session);
      signal?.throwIfAborted();
      assertCurrentInput();
      if (!stageFinished && inspected.size === inspectedBefore) {
        throw new Error("The profile model stopped making progress. Your previous reading and any saved draft are kept. Use /profile build to retry.");
      }
    }
    const check = latestCheck();
    store.complete(build, { ...compiled, verification: {
      version: LISTENER_PROFILE_CHECK_VERSION,
      state: check.verdict === "pass" ? (finalization.revisions ? "revised" : "passed") : "flagged",
      revisions: finalization.revisions, checks: finalization.checks,
    } }, assertCurrentInput);
    return { state: "ready", revision: await application.getListenerProfile(), ...progress() };
  } catch (error) {
    store.interrupt(build);
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    runtime.abort?.();
  }
}
