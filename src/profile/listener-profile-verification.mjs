import { modelEvidence, profileDigest } from "./listener-profile-build.mjs";

export const LISTENER_PROFILE_VERIFICATION_VERSION = "listener-verification/1";

export function listenerProfileCandidate(input, profile) {
  const byId = new Map(profile.claims.map(claim => [claim.claim_id, claim]));
  const insights = profile.highlight_claim_ids.map(id => byId.get(id));
  const content = { summary: profile.summary, insights };
  const references = new Set(insights.flatMap(claim => [...claim.supporting_refs, ...claim.contradicting_refs]));
  return {
    candidate_id: profileDigest({ input_digest: input.input_digest, ...content }),
    ...content,
    cited_evidence: [...references].map(ref => modelEvidence(input.evidence.get(ref))),
  };
}

export function listenerProfileVerificationBatch(candidate, verification) {
  const checked = new Set(verification?.checks.map(check => check.target));
  const pending = candidate.insights.filter(claim => !checked.has(claim.claim_id));
  if (!pending.length) return { targets: ["summary", "coverage"].filter(target => !checked.has(target)), candidate };
  const insights = pending.slice(0, 3);
  const refs = new Set(insights.flatMap(claim => [...claim.supporting_refs, ...claim.contradicting_refs]));
  return { targets: insights.map(claim => claim.claim_id), candidate: {
    candidate_id: candidate.candidate_id, insights,
    cited_evidence: candidate.cited_evidence.filter(entry => refs.has(entry.reference_id)),
  } };
}

export function validateListenerProfileVerification(input, candidate, value, { allowPartial = false } = {}) {
  if (value?.candidate_id !== candidate.candidate_id) {
    throw new TypeError("Verification must identify the current profile candidate");
  }
  const targets = new Map([["summary", null], ["coverage", null],
    ...candidate.insights.map(claim => [claim.claim_id, claim])]);
  if (!Array.isArray(value.checks) || !value.checks.length || value.checks.length > targets.size ||
      (!allowPartial && value.checks.length !== targets.size) ||
      new Set(value.checks.map(check => check?.target)).size !== value.checks.length ||
      value.checks.some(check => !targets.has(check?.target))) {
    throw new TypeError("Verification must check the summary, coverage and every highlighted claim exactly once");
  }
  const referenceErrors = [];
  const checks = value.checks.map(check => {
    if (!["supported", "revise"].includes(check.status) || typeof check.reason !== "string" ||
        !check.reason.trim() || Array.from(check.reason).length > 700 ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(check.reason)) {
      throw new TypeError(`Verification target ${check.target} needs a valid decision and a reason of at most 700 characters`);
    }
    const refs = check.evidence_refs;
    const claim = targets.get(check.target);
    if (!Array.isArray(refs) || refs.length > 16 || new Set(refs).size !== refs.length) {
      throw new TypeError(`Verification target ${check.target} needs at most 16 unique evidence references`);
    }
    const unknown = refs.filter(ref => !input.evidence.has(ref));
    const missing = claim ? [...claim.supporting_refs, ...claim.contradicting_refs].filter(ref => !refs.includes(ref)) : [];
    if (unknown.length || missing.length) referenceErrors.push({ target: check.target, unknown_refs: unknown, missing_cited_refs: missing });
    return { target: check.target, status: check.status, reason: check.reason.trim(), evidence_refs: [...refs] };
  });
  if (referenceErrors.length) {
    throw new TypeError(`Verification must examine every cited reference, including incorrect support and counterexamples. Correct these check rows: ${JSON.stringify(referenceErrors)}`);
  }
  return {
    version: LISTENER_PROFILE_VERIFICATION_VERSION,
    candidate_id: candidate.candidate_id,
    state: checks.length < targets.size ? "checking" : checks.every(check => check.status === "supported") ? "passed" : "needs_repair",
    checked_at: new Date().toISOString(), checks,
  };
}

export function searchListenerProfileEvidence(input, { section, query, offset = 0 } = {}) {
  if (section !== undefined && !input.manifest.sections.some(item => item.section === section)) {
    throw new TypeError("Unknown evidence section");
  }
  if ((query !== undefined && (typeof query !== "string" || query.length > 200)) ||
      !Number.isSafeInteger(offset) || offset < 0) throw new TypeError("Invalid evidence search");
  const needle = query?.normalize("NFKC").toLocaleLowerCase();
  const matches = [...input.evidence.values()].filter(entry => !section || entry.section === section)
    .filter(entry => !needle || JSON.stringify(modelEvidence(entry, 0, Number.MAX_SAFE_INTEGER).data)
      .normalize("NFKC").toLocaleLowerCase().includes(needle));
  return { total: matches.length, offset, items: matches.slice(offset, offset + 12).map(entry => modelEvidence(entry)),
    next_offset: offset + 12 < matches.length ? offset + 12 : null };
}
