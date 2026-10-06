import { modelEvidence, profileDigest } from "./listener-profile-build.mjs";

export const LISTENER_PROFILE_CHECK_VERSION = "listener-check/1";
const MAX_CHECK_ISSUES = 6;

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

function checkText(value, field) {
  if (typeof value !== "string" || !value.trim() || Array.from(value).length > 500 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/u.test(value)) {
    throw new TypeError(`Each check issue needs a ${field} of at most 500 characters`);
  }
  return value.trim();
}

/**
 * One judgment of the whole candidate. Only material problems are issues;
 * citation completeness and phrasing are deliberately out of scope.
 */
export function validateListenerProfileCheck(candidate, value) {
  if (value?.candidate_id !== candidate.candidate_id) {
    throw new TypeError("The check must identify the current profile candidate");
  }
  if (!["pass", "revise"].includes(value.verdict)) throw new TypeError("The check verdict must be pass or revise");
  const issues = value.issues ?? [];
  if (!Array.isArray(issues) || issues.length > MAX_CHECK_ISSUES) {
    throw new TypeError(`The check can list at most ${MAX_CHECK_ISSUES} material issues`);
  }
  if (value.verdict === "revise" && !issues.length) throw new TypeError("A revise verdict needs at least one material issue");
  if (value.verdict === "pass" && issues.length) throw new TypeError("A pass verdict lists no issues; return revise for a material problem");
  const targets = new Set(["summary", ...candidate.insights.map(claim => claim.claim_id)]);
  return {
    version: LISTENER_PROFILE_CHECK_VERSION,
    candidate_id: candidate.candidate_id,
    verdict: value.verdict,
    issues: issues.map(issue => {
      if (!targets.has(issue?.target)) {
        throw new TypeError(`Check issue target ${JSON.stringify(issue?.target)} must be "summary" or a claim_id of this candidate`);
      }
      return { target: issue.target, problem: checkText(issue.problem, "problem"), correction: checkText(issue.correction, "correction") };
    }),
    checked_at: new Date().toISOString(),
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
