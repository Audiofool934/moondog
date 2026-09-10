import { createHash } from "node:crypto";

const riskDomains = ["privacy", "account", "copyright", "spend"];
const riskRank = new Map([
  ["none", 0],
  ["low", 1],
  ["medium", 2],
  ["high", 3],
]);
const effectKinds = new Set([
  "read_external",
  "write_local",
  "write_external",
  "send_message",
  "spend",
  "publish",
  "delete",
  "use_credentials",
]);
const executionModes = new Set(["plan", "dry_run", "execute"]);
const namespacedKeyPattern =
  /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const mutatingEffects = new Set([
  "write_local",
  "write_external",
  "send_message",
  "spend",
  "publish",
  "delete",
]);
const accountEffects = new Set([
  "write_external",
  "send_message",
  "spend",
  "publish",
  "delete",
  "use_credentials",
]);
const allowReceiptStatuses = new Set([
  "simulated",
  "accepted",
  "succeeded",
  "failed",
  "timed_out",
  "partial",
  "unknown",
  "cancelled",
]);
const executedReceiptStatuses = new Set([
  "accepted",
  "succeeded",
  "failed",
  "timed_out",
  "partial",
  "unknown",
]);
const sensitiveKeyNames = new Set([
  "accesstoken",
  "apikey",
  "authorization",
  "clientassertion",
  "clientsecret",
  "cookie",
  "cookies",
  "credential",
  "credentials",
  "idtoken",
  "password",
  "passwd",
  "privatekey",
  "providertoken",
  "rawproviderpayload",
  "refreshtoken",
  "sessiontoken",
  "setcookie",
]);
const sensitiveUrlParameterNames = new Set([
  ...sensitiveKeyNames,
  "code",
  "key",
  "secret",
  "signature",
  "token",
]);

function issue(code, path, message) {
  return { code, path, message };
}

function normalizeKey(value) {
  return value.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

function isSensitiveKeyName(value, sensitiveNames = sensitiveKeyNames) {
  const candidates = [
    normalizeKey(value),
    ...value.split(/[.:/\\-]+/).map((segment) => normalizeKey(segment)),
  ];
  return candidates.some((candidate) =>
    [...sensitiveNames].some(
      (sensitiveName) =>
        candidate === sensitiveName || candidate.endsWith(sensitiveName),
    ),
  );
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function canonicalizeJson(value) {
  if (value === null) return "null";

  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON cannot contain a non-finite number");
    }
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJson(item)).join(",")}]`;
  }

  if (!isPlainObject(value)) {
    throw new TypeError("Canonical JSON accepts only JSON-compatible values");
  }

  return `{${Object.keys(value)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}:${canonicalizeJson(value[key])}`,
    )
    .join(",")}}`;
}

export function sha256Hex(value) {
  const source = typeof value === "string" ? value : canonicalizeJson(value);
  return createHash("sha256").update(source, "utf8").digest("hex");
}

export function invocationSemanticPayload(invocation) {
  if (!isPlainObject(invocation)) {
    throw new TypeError("ToolInvocation must be an object");
  }

  const payload = structuredClone(invocation);
  delete payload.semantic_digest;
  delete payload.confirmation_grant_ref;

  for (const field of [
    "declared_effects",
    "declared_risk_flags",
    "rights_basis_refs",
  ]) {
    payload[field]?.sort(compareCanonicalValues);
  }
  for (const field of [
    "source_refs",
    "data_classes",
    "planned_destinations",
  ]) {
    payload.data_manifest?.[field]?.sort(compareCanonicalValues);
  }
  payload.budget_request?.sort(compareCanonicalValues);
  return payload;
}

function compareCanonicalValues(left, right) {
  const leftValue = canonicalizeJson(left);
  const rightValue = canonicalizeJson(right);
  if (leftValue < rightValue) return -1;
  if (leftValue > rightValue) return 1;
  return 0;
}

export function computeInvocationSemanticDigest(invocation) {
  return sha256Hex(invocationSemanticPayload(invocation));
}

export function computeConfirmationScopeDigest({
  invocationSemanticDigest,
  capabilityRegistryVersion,
}) {
  return sha256Hex({
    kind: "moondog.confirmation_scope",
    version: 1,
    invocation_semantic_digest: invocationSemanticDigest,
    capability_registry_version: capabilityRegistryVersion,
  });
}

function externalIdentity(externalRef) {
  if (!externalRef) return null;
  return {
    system: externalRef.system,
    entity_type: externalRef.entity_type,
    external_id: externalRef.external_id,
  };
}

export function computeIdempotencyKeyDigest(invocation) {
  if (typeof invocation?.idempotency_key !== "string") {
    throw new TypeError("Invocation idempotency key must be a string");
  }
  return sha256Hex({
    kind: "moondog.idempotency_scope",
    version: 1,
    subject_id: invocation.subject_id,
    capability_id: invocation.capability_id,
    capability_version: invocation.capability_version,
    account_identity: externalIdentity(invocation.account_ref),
    idempotency_key: invocation.idempotency_key,
  });
}

function inspectUrl(value, path, issues) {
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) return;

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return;
  }

  if (new Set(["data:", "javascript:", "file:"]).has(parsed.protocol)) {
    issues.push(
      issue(
        "secret.unsafe_uri_scheme",
        path,
        "Persisted contract records must not contain unsafe URI schemes.",
      ),
    );
  }

  if (parsed.username || parsed.password) {
    issues.push(
      issue(
        "secret.url_userinfo",
        path,
        "Persisted URLs must not contain credentials in userinfo.",
      ),
    );
  }

  for (const key of parsed.searchParams.keys()) {
    if (isSensitiveKeyName(key, sensitiveUrlParameterNames)) {
      issues.push(
        issue(
          "secret.url_query",
          path,
          "Persisted URLs must not contain credential query parameters.",
        ),
      );
      break;
    }
  }

  for (const key of parsed.hash.replace(/^#/, "").split(/[&;]/)) {
    const [name] = key.split("=", 1);
    if (isSensitiveKeyName(name, sensitiveUrlParameterNames)) {
      issues.push(
        issue(
          "secret.url_fragment",
          path,
          "Persisted URLs must not contain credential fragments.",
        ),
      );
      break;
    }
  }
}

export function findUnsafePersistedData(
  value,
  path = "$",
  { maxDepth = 64, maxNodes = 10_000, maxBytes = 1_000_000 } = {},
) {
  const issues = [];
  let nodeCount = 0;
  let limitReported = false;

  try {
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > maxBytes) {
      issues.push(
        issue(
          "record.byte_limit",
          path,
          "The persisted record exceeds the semantic inspection byte limit.",
        ),
      );
    }
  } catch {
    issues.push(
      issue(
        "record.not_json",
        path,
        "The persisted record must be finite JSON data.",
      ),
    );
  }

  function visit(current, currentPath, depth) {
    nodeCount += 1;
    if (depth > maxDepth || nodeCount > maxNodes) {
      if (!limitReported) {
        issues.push(
          issue(
            "record.inspection_limit",
            currentPath,
            "The persisted record exceeds semantic inspection limits.",
          ),
        );
        limitReported = true;
      }
      return;
    }
    if (typeof current === "string") {
      if (/^(?:basic|bearer)\s+[a-z0-9._~+\/-]+=*$/i.test(current)) {
        issues.push(
          issue(
            "secret.authorization_value",
            currentPath,
            "Persisted values must not contain authorization material.",
          ),
        );
      }
      if (/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(current)) {
        issues.push(
          issue(
            "secret.private_key_value",
            currentPath,
            "Persisted values must not contain private keys.",
          ),
        );
      }
      inspectUrl(current, currentPath, issues);
      return;
    }

    if (Array.isArray(current)) {
      current.forEach((item, index) =>
        visit(item, `${currentPath}/${index}`, depth + 1),
      );
      return;
    }

    if (!isPlainObject(current)) return;

    for (const [key, child] of Object.entries(current)) {
      const childPath = `${currentPath}/${key}`;
      if (isSensitiveKeyName(key)) {
        issues.push(
          issue(
            "secret.forbidden_field",
            childPath,
            "Persisted contract records must not contain credential fields or raw provider payloads.",
          ),
        );
      }
      visit(child, childPath, depth + 1);
    }
  }

  visit(value, path, 0);
  return issues;
}

function canonicalEqual(left, right) {
  return canonicalizeJson(left) === canonicalizeJson(right);
}

function exactSetEqual(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  if (leftSet.size !== left.length || rightSet.size !== right.length) return false;
  if (leftSet.size !== rightSet.size) return false;
  return [...leftSet].every((value) => rightSet.has(value));
}

function includesCanonical(items, expected) {
  return Array.isArray(items) && items.some((item) => canonicalEqual(item, expected));
}

function includesExternalIdentity(items, expected) {
  return (
    Array.isArray(items) &&
    items.some((item) =>
      canonicalEqual(externalIdentity(item), externalIdentity(expected)),
    )
  );
}

function parseTimestamp(value) {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function appendUniqueKeyIssues(items, keyFor, path, code, issues) {
  const seen = new Set();
  for (const item of items ?? []) {
    const key = keyFor(item);
    if (seen.has(key)) {
      issues.push(issue(code, path, "Semantic keys must be unique."));
      return;
    }
    seen.add(key);
  }
}

export function validateCapabilityDescriptor(capability) {
  const issues = [];
  if (!isPlainObject(capability)) {
    issues.push(
      issue(
        "registry.descriptor_missing",
        "/capability",
        "A trusted capability descriptor is required.",
      ),
    );
    return { ok: false, issues };
  }

  if (
    typeof capability.registry_version !== "string" ||
    capability.registry_version.trim() === ""
  ) {
    issues.push(
      issue(
        "registry.version_invalid",
        "/capability/registry_version",
        "The trusted registry version must be a non-empty string.",
      ),
    );
  }
  if (
    typeof capability.capability_id !== "string" ||
    !namespacedKeyPattern.test(capability.capability_id)
  ) {
    issues.push(
      issue(
        "registry.capability_id_invalid",
        "/capability/capability_id",
        "The trusted capability identifier is invalid.",
      ),
    );
  }
  if (
    !Number.isInteger(capability.capability_version) ||
    capability.capability_version < 1
  ) {
    issues.push(
      issue(
        "registry.capability_version_invalid",
        "/capability/capability_version",
        "The trusted capability version must be a positive integer.",
      ),
    );
  }
  if (
    !isPlainObject(capability.tool_ref) ||
    typeof capability.tool_ref.tool_id !== "string" ||
    !namespacedKeyPattern.test(capability.tool_ref.tool_id) ||
    !Number.isInteger(capability.tool_ref.contract_version) ||
    capability.tool_ref.contract_version < 1
  ) {
    issues.push(
      issue(
        "registry.tool_ref_invalid",
        "/capability/tool_ref",
        "The trusted tool reference is invalid.",
      ),
    );
  }

  if (
    !Array.isArray(capability.effects) ||
    capability.effects.length === 0 ||
    capability.effects.some((effect) => !effectKinds.has(effect))
  ) {
    issues.push(
      issue(
        "registry.effects_invalid",
        "/capability/effects",
        "Trusted effects must be a non-empty array of known effect kinds.",
      ),
    );
  } else {
    appendUniqueKeyIssues(
      capability.effects,
      (value) => value,
      "/capability/effects",
      "registry.duplicate_effect",
      issues,
    );
  }

  if (
    !Array.isArray(capability.allowed_execution_modes) ||
    capability.allowed_execution_modes.length === 0 ||
    capability.allowed_execution_modes.some((mode) => !executionModes.has(mode))
  ) {
    issues.push(
      issue(
        "registry.execution_modes_invalid",
        "/capability/allowed_execution_modes",
        "Trusted execution modes must be a non-empty array of known modes.",
      ),
    );
  } else {
    appendUniqueKeyIssues(
      capability.allowed_execution_modes,
      (value) => value,
      "/capability/allowed_execution_modes",
      "registry.duplicate_execution_mode",
      issues,
    );
  }

  if (isPlainObject(capability.risk_levels)) {
    const keys = Object.keys(capability.risk_levels);
    if (!exactSetEqual(keys, riskDomains)) {
      issues.push(
        issue(
          "registry.risk_domains_incomplete",
          "/capability/risk_levels",
          "The trusted descriptor must assign a level to every v1 risk domain.",
        ),
      );
    }
    for (const level of Object.values(capability.risk_levels)) {
      if (!riskRank.has(level)) {
        issues.push(
          issue(
            "registry.risk_level_unknown",
            "/capability/risk_levels",
            "The trusted descriptor contains an unknown risk level.",
          ),
        );
        break;
      }
    }
  } else {
    issues.push(
      issue(
        "registry.risk_levels_invalid",
        "/capability/risk_levels",
        "The trusted descriptor must provide a risk-level object.",
      ),
    );
  }

  return { ok: issues.length === 0, issues };
}

function validateChronology(invocation, policy, now, issues) {
  const requestedAt = parseTimestamp(invocation.requested_at);
  const expiresAt = parseTimestamp(invocation.expires_at);
  const validFrom = parseTimestamp(policy.valid_from);
  const validUntil = policy.valid_until
    ? parseTimestamp(policy.valid_until)
    : Number.POSITIVE_INFINITY;
  const nowValue = now instanceof Date ? now.getTime() : parseTimestamp(now);

  if (
    requestedAt === null ||
    expiresAt === null ||
    validFrom === null ||
    validUntil === null ||
    nowValue === null ||
    !Number.isFinite(nowValue)
  ) {
    issues.push(
      issue(
        "time.invalid",
        "/requested_at",
        "Invocation, policy, and evaluation timestamps must be valid.",
      ),
    );
    return;
  }

  if (requestedAt >= expiresAt) {
    issues.push(
      issue(
        "time.invocation_order",
        "/expires_at",
        "Invocation expiry must follow its request time.",
      ),
    );
  }
  if (validFrom >= validUntil) {
    issues.push(
      issue(
        "time.policy_order",
        "/policy/valid_until",
        "Policy expiry must follow its start time.",
      ),
    );
  }
  if (nowValue < requestedAt || nowValue >= expiresAt) {
    issues.push(
      issue(
        "time.invocation_inactive",
        "/expires_at",
        "The invocation is not active at evaluation time.",
      ),
    );
  }
  if (nowValue < validFrom || nowValue >= validUntil) {
    issues.push(
      issue(
        "time.policy_inactive",
        "/policy/valid_until",
        "The policy is not active at evaluation time.",
      ),
    );
  }
}

function validatePrivacy(invocation, policy, issues) {
  if (invocation.purpose_id !== policy.privacy?.purpose_id) {
    issues.push(
      issue(
        "privacy.purpose_denied",
        "/purpose_id",
        "The invocation purpose is outside the selected policy.",
      ),
    );
  }
  const allowedDataClasses = new Set(policy.privacy?.allowed_data_classes ?? []);
  for (const dataClass of invocation.data_manifest?.data_classes ?? []) {
    if (!allowedDataClasses.has(dataClass)) {
      issues.push(
        issue(
          "privacy.data_class_denied",
          "/data_manifest/data_classes",
          "The invocation contains a data class outside the selected policy.",
        ),
      );
    }
  }

  for (const destination of invocation.data_manifest?.planned_destinations ?? []) {
    const allowed = (policy.privacy?.allowed_destinations ?? []).some(
      (candidate) =>
        candidate.destination_type === destination.destination_type &&
        candidate.system === destination.system &&
        candidate.purpose_id === destination.purpose_id,
    );
    if (!allowed) {
      issues.push(
        issue(
          "privacy.destination_denied",
          "/data_manifest/planned_destinations",
          "The invocation contains a destination outside the selected policy.",
        ),
      );
    }
  }

  if (
    invocation.data_manifest?.raw_data_included === true &&
    policy.privacy?.raw_data_egress_allowed !== true
  ) {
    issues.push(
      issue(
        "privacy.raw_egress_denied",
        "/data_manifest/raw_data_included",
        "The selected policy does not permit raw data egress.",
      ),
    );
  }

  if (
    policy.privacy?.rights_basis_required === true &&
    !(invocation.rights_basis_refs?.length > 0)
  ) {
    issues.push(
      issue(
        "privacy.rights_basis_missing",
        "/rights_basis_refs",
        "The selected policy requires a rights basis.",
      ),
    );
  }
}

function validateBudgets(invocation, policy, capability, issues) {
  appendUniqueKeyIssues(
    policy.budgets,
    (item) => item.resource,
    "/policy/budgets",
    "budget.policy_resource_duplicate",
    issues,
  );
  appendUniqueKeyIssues(
    invocation.budget_request,
    (item) => item.resource,
    "/budget_request",
    "budget.request_resource_duplicate",
    issues,
  );

  if (capability.effects?.includes("spend") && !invocation.budget_request?.length) {
    issues.push(
      issue(
        "budget.request_missing",
        "/budget_request",
        "A spending capability requires a non-empty budget request.",
      ),
    );
  }

  for (const requested of invocation.budget_request ?? []) {
    const limit = (policy.budgets ?? []).find(
      (candidate) => candidate.resource === requested.resource,
    );
    if (!limit || limit.unit !== requested.unit) {
      issues.push(
        issue(
          "budget.resource_denied",
          "/budget_request",
          "The requested budget resource is not allowed by the selected policy.",
        ),
      );
      continue;
    }
    if (
      limit.max_per_invocation !== undefined &&
      requested.quantity > limit.max_per_invocation
    ) {
      issues.push(
        issue(
          "budget.invocation_limit_exceeded",
          "/budget_request",
          "The requested quantity exceeds the per-invocation budget.",
        ),
      );
    }
  }
}

function trustedConfirmationContext(invocation, capability, computedDigest) {
  const scopeDigest = computeConfirmationScopeDigest({
    invocationSemanticDigest: computedDigest,
    capabilityRegistryVersion: capability.registry_version,
  });
  return {
    grant_ref: invocation.confirmation_grant_ref,
    subject_id: invocation.subject_id,
    actor: invocation.actor,
    capability_id: invocation.capability_id,
    capability_version: invocation.capability_version,
    policy_ref: invocation.policy_ref,
    account_ref: invocation.account_ref,
    target: invocation.target,
    semantic_digest: computedDigest,
    confirmation_scope_digest: scopeDigest,
    capability_registry_version: capability.registry_version,
    budget_request_digest: sha256Hex(invocation.budget_request ?? []),
    data_manifest_digest: sha256Hex(invocation.data_manifest ?? {}),
    invocation_expires_at: invocation.expires_at,
  };
}

function operationSucceeded(result) {
  return result === true || (result?.ok === true && result?.valid !== false);
}

function verificationValid(result) {
  return result === true || (result?.valid === true && result?.ok !== false);
}

function isolatedInvocationHookContext(invocation, capability) {
  const invocationSnapshot = structuredClone(invocation);
  return {
    arguments: invocationSnapshot.arguments,
    capability: structuredClone(capability),
    invocation: invocationSnapshot,
  };
}

async function validateToolInvocationSemanticsUnchecked({
  invocation,
  policy,
  capability,
  now = new Date(),
  validateArguments,
  inspectIntent,
  verifyRightsBasis,
  verifyConfirmation,
  reserveBudget,
}) {
  const issues = [...findUnsafePersistedData(invocation, "$")];
  let computedDigest = null;
  let confirmationVerification = null;
  let budgetReservation = null;
  let intentInspection = null;

  if (!isPlainObject(invocation)) {
    issues.push(
      issue(
        "record.invocation_invalid",
        "/",
        "Tool invocation semantics require a schema-valid object.",
      ),
    );
    return {
      ok: false,
      issues,
      computed_digest: null,
      confirmation_verification: null,
      intent_inspection: null,
      budget_reservation: null,
    };
  }

  const descriptorResult = validateCapabilityDescriptor(capability);
  issues.push(...descriptorResult.issues);
  if (!descriptorResult.ok) {
    return {
      ok: false,
      issues,
      computed_digest: null,
      confirmation_verification: null,
      intent_inspection: null,
      budget_reservation: null,
    };
  }

  try {
    computedDigest = computeInvocationSemanticDigest(invocation);
    if (invocation.semantic_digest !== computedDigest) {
      issues.push(
        issue(
          "digest.mismatch",
          "/semantic_digest",
          "The invocation semantic digest does not match its canonical payload.",
        ),
      );
    }
  } catch {
    issues.push(
      issue(
        "digest.uncomputable",
        "/semantic_digest",
        "The invocation cannot be represented as canonical JSON.",
      ),
    );
  }

  if (!isPlainObject(policy)) {
    issues.push(
      issue(
        "policy.missing",
        "/policy_ref",
        "The exact trusted policy revision is required.",
      ),
    );
  } else {
    if (
      invocation.policy_ref?.policy_id !== policy.policy_id ||
      invocation.policy_ref?.policy_version !== policy.policy_version
    ) {
      issues.push(
        issue(
          "policy.revision_mismatch",
          "/policy_ref",
          "The invocation does not bind the supplied policy revision.",
        ),
      );
    }
    if (policy.subject_id !== invocation.subject_id) {
      issues.push(
        issue(
          "policy.subject_mismatch",
          "/subject_id",
          "The selected policy belongs to another subject.",
        ),
      );
    }
    if (!policy.enabled || policy.effect !== "allow") {
      issues.push(
        issue(
          "policy.not_allowing",
          "/policy_ref",
          "The selected policy is disabled or does not allow execution.",
        ),
      );
    }
    if (!policy.capability_ids?.includes(invocation.capability_id)) {
      issues.push(
        issue(
          "policy.capability_denied",
          "/capability_id",
          "The selected policy does not include this exact capability.",
        ),
      );
    }
    if (!policy.actor_types?.includes(invocation.actor?.actor_type)) {
      issues.push(
        issue(
          "policy.actor_type_denied",
          "/actor",
          "The actor type is outside the selected policy.",
        ),
      );
    }
    if (!includesCanonical(policy.actor_refs, invocation.actor)) {
      issues.push(
        issue(
          "policy.actor_denied",
          "/actor",
          "The exact actor is outside the selected policy.",
        ),
      );
    }
    if (!policy.surfaces?.includes(invocation.surface)) {
      issues.push(
        issue(
          "policy.surface_denied",
          "/surface",
          "The invocation surface is outside the selected policy.",
        ),
      );
    }
    if (!policy.allowed_execution_modes?.includes(invocation.execution_mode)) {
      issues.push(
        issue(
          "policy.execution_mode_denied",
          "/execution_mode",
          "The execution mode is outside the selected policy.",
        ),
      );
    }
  }

  if (isPlainObject(capability)) {
    if (
      invocation.capability_id !== capability.capability_id ||
      invocation.capability_version !== capability.capability_version
    ) {
      issues.push(
        issue(
          "registry.capability_mismatch",
          "/capability_id",
          "The invocation does not bind the trusted capability revision.",
        ),
      );
    }
    if (!canonicalEqual(invocation.tool_ref, capability.tool_ref)) {
      issues.push(
        issue(
          "registry.tool_mismatch",
          "/tool_ref",
          "The invocation tool does not match the trusted capability descriptor.",
        ),
      );
    }
    if (!exactSetEqual(invocation.declared_effects, capability.effects)) {
      issues.push(
        issue(
          "registry.effects_mismatch",
          "/declared_effects",
          "Declared effects must exactly match the trusted capability descriptor.",
        ),
      );
    }
    const trustedRiskFlags = riskDomains.filter(
      (domain) => capability.risk_levels?.[domain] !== "none",
    );
    if (!exactSetEqual(invocation.declared_risk_flags, trustedRiskFlags)) {
      issues.push(
        issue(
          "registry.risks_mismatch",
          "/declared_risk_flags",
          "Declared risk flags must exactly match the trusted capability descriptor.",
        ),
      );
    }
    if (!capability.allowed_execution_modes?.includes(invocation.execution_mode)) {
      issues.push(
        issue(
          "registry.execution_mode_denied",
          "/execution_mode",
          "The trusted capability does not support this execution mode.",
        ),
      );
    }
  }

  if (isPlainObject(policy) && isPlainObject(capability)) {
    for (const effect of capability.effects ?? []) {
      if (!policy.allowed_effects?.includes(effect)) {
        issues.push(
          issue(
            "policy.effect_denied",
            "/declared_effects",
            "The trusted capability has an effect outside the selected policy.",
          ),
        );
      }
    }

    appendUniqueKeyIssues(
      policy.risk_limits,
      (item) => item.domain,
      "/policy/risk_limits",
      "policy.risk_domain_duplicate",
      issues,
    );
    const riskLimits = new Map(
      (policy.risk_limits ?? []).map((item) => [item.domain, item.max_level]),
    );
    if (!exactSetEqual([...riskLimits.keys()], riskDomains)) {
      issues.push(
        issue(
          "policy.risk_domains_incomplete",
          "/policy/risk_limits",
          "The selected policy must bound every v1 risk domain.",
        ),
      );
    }
    for (const domain of riskDomains) {
      const trustedLevel = capability.risk_levels?.[domain];
      const allowedLevel = riskLimits.get(domain);
      if (
        riskRank.has(trustedLevel) &&
        riskRank.has(allowedLevel) &&
        riskRank.get(trustedLevel) > riskRank.get(allowedLevel)
      ) {
        issues.push(
          issue(
            "policy.risk_limit_exceeded",
            `/policy/risk_limits/${domain}`,
            "The trusted capability risk exceeds the selected policy limit.",
          ),
        );
      }
    }
  }

  const needsAccount = (capability?.effects ?? []).some((effect) =>
    accountEffects.has(effect),
  );
  if (needsAccount) {
    if (!invocation.account_ref) {
      issues.push(
        issue(
          "account.missing",
          "/account_ref",
          "This capability requires an explicit account reference.",
        ),
      );
    }
  }

  if (
    invocation.account_ref &&
    !includesExternalIdentity(policy?.account_refs, invocation.account_ref)
  ) {
    issues.push(
      issue(
        "account.denied",
        "/account_ref",
        "The account is outside the selected policy.",
      ),
    );
  }

  const needsIdempotency = (capability?.effects ?? []).some((effect) =>
    mutatingEffects.has(effect),
  );
  if (needsIdempotency && !invocation.idempotency_key) {
    issues.push(
      issue(
        "idempotency.key_missing",
        "/idempotency_key",
        "Mutating capabilities require an idempotency key.",
      ),
    );
  }
  for (const effect of capability?.effects ?? []) {
    if (
      mutatingEffects.has(effect) &&
      !policy?.idempotency?.required_for?.includes(effect)
    ) {
      issues.push(
        issue(
          "policy.idempotency_effect_missing",
          "/policy/idempotency/required_for",
          "The selected policy does not require idempotency for every trusted mutating effect.",
        ),
      );
    }
  }

  if (isPlainObject(policy)) {
    validateChronology(invocation, policy, now, issues);
    validatePrivacy(invocation, policy, issues);
  }
  if (isPlainObject(policy) && isPlainObject(capability)) {
    validateBudgets(invocation, policy, capability, issues);
  }

  if (typeof validateArguments !== "function") {
    issues.push(
      issue(
        "arguments.validator_missing",
        "/arguments",
        "A trusted capability-specific argument validator is required.",
      ),
    );
  } else if (issues.length === 0) {
    try {
      const result = await validateArguments(
        isolatedInvocationHookContext(invocation, capability),
      );
      if (!operationSucceeded(result)) {
        issues.push(
          issue(
            "arguments.invalid",
            "/arguments",
            "Capability-specific argument validation failed.",
          ),
        );
      }
    } catch {
      issues.push(
        issue(
          "arguments.validator_error",
          "/arguments",
          "Capability-specific argument validation did not complete safely.",
        ),
      );
    }
  }

  if (typeof inspectIntent !== "function") {
    issues.push(
      issue(
        "intent.inspector_missing",
        "/arguments",
        "A trusted capability-specific intent inspector is required.",
      ),
    );
  } else if (issues.length === 0) {
    try {
      intentInspection = await inspectIntent(
        isolatedInvocationHookContext(invocation, capability),
      );
      const inspected = intentInspection?.intent ?? intentInspection;
      const declaredSecurityIntent = {
        account_identity: externalIdentity(invocation.account_ref),
        target: invocation.target ?? null,
        data_manifest: invocation.data_manifest,
        budget_request: invocation.budget_request,
      };
      const inspectedSecurityIntent = {
        account_identity: externalIdentity(inspected?.account_ref),
        target: inspected?.target ?? null,
        data_manifest: inspected?.data_manifest,
        budget_request: inspected?.budget_request,
      };
      if (
        !operationSucceeded(intentInspection) ||
        !canonicalEqual(declaredSecurityIntent, inspectedSecurityIntent)
      ) {
        issues.push(
          issue(
            "intent.mismatch",
            "/arguments",
            "Declared account, target, data movement, or budget does not match trusted intent inspection.",
          ),
        );
      }
    } catch {
      issues.push(
        issue(
          "intent.inspector_error",
          "/arguments",
          "Capability-specific intent inspection did not complete safely.",
        ),
      );
    }
  }

  const rightsBasisRequired = policy?.privacy?.rights_basis_required === true;
  if (rightsBasisRequired && typeof verifyRightsBasis !== "function") {
    issues.push(
      issue(
        "rights.verifier_missing",
        "/rights_basis_refs",
        "A trusted rights-basis verifier is required.",
      ),
    );
  } else if (rightsBasisRequired && issues.length === 0) {
    try {
      const verification = await verifyRightsBasis({
        subject_id: invocation.subject_id,
        rights_basis_refs: structuredClone(invocation.rights_basis_refs),
        capability_id: invocation.capability_id,
        data_manifest: structuredClone(invocation.data_manifest),
      });
      if (!verificationValid(verification)) {
        issues.push(
          issue(
            "rights.invalid",
            "/rights_basis_refs",
            "The rights basis could not be independently verified.",
          ),
        );
      }
    } catch {
      issues.push(
        issue(
          "rights.verifier_error",
          "/rights_basis_refs",
          "Rights-basis verification did not complete safely.",
        ),
      );
    }
  }

  const confirmationRequired = policy?.confirmation?.mode === "always";
  if (
    confirmationRequired &&
    !uuidPattern.test(invocation.confirmation_grant_ref ?? "")
  ) {
    issues.push(
      issue(
        invocation.confirmation_grant_ref
          ? "confirmation.reference_invalid"
          : "confirmation.reference_missing",
        "/confirmation_grant_ref",
        "An always-confirm policy requires a UUID confirmation grant reference.",
      ),
    );
  }
  if (
    policy?.confirmation?.mode === "never" &&
    invocation.confirmation_grant_ref
  ) {
    issues.push(
      issue(
        "confirmation.reference_unexpected",
        "/confirmation_grant_ref",
        "A never-confirm policy cannot accept a confirmation grant reference.",
      ),
    );
  }
  if (confirmationRequired && typeof verifyConfirmation !== "function") {
    issues.push(
      issue(
        "confirmation.verifier_missing",
        "/confirmation_grant_ref",
        "An independent confirmation verifier is required.",
      ),
    );
  } else if (confirmationRequired && issues.length === 0) {
    try {
      confirmationVerification = await verifyConfirmation(
        structuredClone(
          trustedConfirmationContext(invocation, capability, computedDigest),
        ),
      );
      if (!verificationValid(confirmationVerification)) {
        issues.push(
          issue(
            "confirmation.invalid",
            "/confirmation_grant_ref",
            "The confirmation grant did not match this invocation.",
          ),
        );
      }
    } catch {
      issues.push(
        issue(
          "confirmation.verifier_error",
          "/confirmation_grant_ref",
          "Confirmation verification did not complete safely.",
        ),
      );
    }
  }

  const needsBudgetReservation =
    invocation.execution_mode === "execute" &&
    (invocation.budget_request?.length ?? 0) > 0;
  if (needsBudgetReservation && typeof reserveBudget !== "function") {
    issues.push(
      issue(
        "budget.reserver_missing",
        "/budget_request",
        "An atomic budget reservation callback is required before execution.",
      ),
    );
  } else if (needsBudgetReservation && issues.length === 0) {
    try {
      budgetReservation = await reserveBudget({
        subject_id: invocation.subject_id,
        policy_ref: invocation.policy_ref,
        invocation_id: invocation.invocation_id,
        semantic_digest: computedDigest,
        requested: structuredClone(invocation.budget_request),
      });
      if (
        !operationSucceeded(budgetReservation) ||
        !budgetReservation.reservation_id
      ) {
        issues.push(
          issue(
            "budget.reservation_failed",
            "/budget_request",
            "The requested budget was not atomically reserved.",
          ),
        );
      }
    } catch {
      issues.push(
        issue(
          "budget.reserver_error",
          "/budget_request",
          "Budget reservation did not complete safely.",
        ),
      );
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    computed_digest: computedDigest,
    confirmation_verification: confirmationVerification,
    intent_inspection: intentInspection,
    budget_reservation: budgetReservation,
  };
}

export async function validateToolInvocationSemantics(context) {
  try {
    const sources = {
      invocation: context?.invocation,
      policy: context?.policy,
      capability: context?.capability,
    };
    const fingerprints = {
      invocation: canonicalizeJson(sources.invocation),
      policy: canonicalizeJson(sources.policy),
      capability: canonicalizeJson(sources.capability),
    };
    const snapshotContext = {
      ...(context ?? {}),
      invocation: structuredClone(sources.invocation),
      policy: structuredClone(sources.policy),
      capability: structuredClone(sources.capability),
    };
    const result =
      await validateToolInvocationSemanticsUnchecked(snapshotContext);
    const contextMutated =
      canonicalizeJson(sources.invocation) !== fingerprints.invocation ||
      canonicalizeJson(sources.policy) !== fingerprints.policy ||
      canonicalizeJson(sources.capability) !== fingerprints.capability;

    if (contextMutated) {
      return {
        ...result,
        ok: false,
        issues: [
          ...result.issues,
          issue(
            "record.context_mutated",
            "/",
            "Invocation, policy, and capability inputs must remain unchanged during validation.",
          ),
        ],
      };
    }
    return result;
  } catch {
    return {
      ok: false,
      issues: [
        issue(
          "record.invocation_invalid",
          "/",
          "Tool invocation semantics require a complete schema-valid context.",
        ),
      ],
      computed_digest: null,
      confirmation_verification: null,
      intent_inspection: null,
      budget_reservation: null,
    };
  }
}

function expectedPolicyDecision(status) {
  if (status === "denied") return "deny";
  if (status === "awaiting_confirmation") return "require_confirmation";
  if (status === "requires_human") return "escalate";
  if (allowReceiptStatuses.has(status)) return "allow";
  return null;
}

function budgetMap(items) {
  return new Map(
    (items ?? []).map((item) => [
      item.resource,
      { quantity: item.quantity, unit: item.unit },
    ]),
  );
}

function budgetArraysEqual(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  const leftMap = budgetMap(left);
  const rightMap = budgetMap(right);
  if (leftMap.size !== left.length || rightMap.size !== right.length) return false;
  if (leftMap.size !== rightMap.size) return false;
  for (const [resource, amount] of leftMap) {
    const other = rightMap.get(resource);
    if (!other || !canonicalEqual(amount, other)) return false;
  }
  return true;
}

function validateToolReceiptSemanticsUnchecked({
  receipt,
  invocation,
  capability,
  priorReceiptById,
}) {
  const issues = [...findUnsafePersistedData(receipt, "$")];
  let computedDigest = null;

  if (!isPlainObject(receipt) || !isPlainObject(invocation)) {
    issues.push(
      issue(
        "record.receipt_context_invalid",
        "/",
        "Receipt semantics require schema-valid receipt and invocation objects.",
      ),
    );
    return { ok: false, issues, computed_digest: null };
  }

  const descriptorResult = validateCapabilityDescriptor(capability);
  issues.push(...descriptorResult.issues);
  if (!descriptorResult.ok) {
    return { ok: false, issues, computed_digest: null };
  }
  for (const [path, items] of [
    ["/usage", receipt.usage],
    ["/budget_reservation/reserved", receipt.budget_reservation?.reserved],
    ["/budget_reservation/actual", receipt.budget_reservation?.actual],
  ]) {
    appendUniqueKeyIssues(
      items,
      (item) => item.resource,
      path,
      "receipt.budget_resource_duplicate",
      issues,
    );
  }

  try {
    computedDigest = computeInvocationSemanticDigest(invocation);
  } catch {
    issues.push(
      issue(
        "digest.uncomputable",
        "/invocation_semantic_digest",
        "The bound invocation cannot be represented as canonical JSON.",
      ),
    );
  }

  const exactBindings = [
    ["invocation_id", invocation.invocation_id],
    ["subject_id", invocation.subject_id],
    ["capability_id", invocation.capability_id],
    ["capability_version", invocation.capability_version],
  ];
  for (const [field, expected] of exactBindings) {
    if (receipt[field] !== expected) {
      issues.push(
        issue(
          "receipt.binding_mismatch",
          `/${field}`,
          "The receipt does not belong to the supplied invocation.",
        ),
      );
    }
  }

  if (
    receipt.invocation_semantic_digest !== computedDigest ||
    invocation.semantic_digest !== computedDigest
  ) {
    issues.push(
      issue(
        "receipt.digest_mismatch",
        "/invocation_semantic_digest",
        "The receipt and invocation do not bind the same canonical intent.",
      ),
    );
  }

  if (
    receipt.policy_decision?.policy_ref &&
    !canonicalEqual(receipt.policy_decision.policy_ref, invocation.policy_ref)
  ) {
    issues.push(
      issue(
        "receipt.policy_revision_mismatch",
        "/policy_decision/policy_ref",
        "The receipt cites a different policy revision.",
      ),
    );
  }
  if (
    receipt.policy_decision?.capability_registry_version !==
    capability.registry_version
  ) {
    issues.push(
      issue(
        "receipt.registry_version_mismatch",
        "/policy_decision/capability_registry_version",
        "The receipt cites a different capability registry snapshot.",
      ),
    );
  }

  const expectedDecision = expectedPolicyDecision(receipt.status);
  if (
    expectedDecision === null ||
    receipt.policy_decision?.decision !== expectedDecision
  ) {
    issues.push(
      issue(
        "receipt.status_decision_mismatch",
        "/policy_decision/decision",
        "Receipt status and policy decision are inconsistent.",
      ),
    );
  }

  for (const effect of receipt.effects ?? []) {
    if (!capability.effects?.includes(effect.effect_type)) {
      issues.push(
        issue(
          "receipt.effect_untrusted",
          "/effects",
          "The receipt reports an effect outside the trusted capability descriptor.",
        ),
      );
    }
    if (
      invocation.execution_mode !== "execute" &&
      effect.status !== "planned"
    ) {
      issues.push(
        issue(
          "receipt.non_execute_effect",
          "/effects",
          "Plan and dry-run invocations cannot report applied or unknown effects.",
        ),
      );
    }
  }

  if (
    invocation.execution_mode !== "execute" &&
    ((receipt.usage?.length ?? 0) > 0 ||
      (receipt.privacy_egress?.length ?? 0) > 0)
  ) {
    issues.push(
      issue(
        "receipt.non_execute_activity",
        "/status",
        "Plan and dry-run invocations cannot report usage or external data egress.",
      ),
    );
  }
  const nonExecuteStatuses = new Set([
    "simulated",
    "denied",
    "awaiting_confirmation",
    "failed",
    "timed_out",
    "cancelled",
    "requires_human",
  ]);
  if (
    invocation.execution_mode !== "execute" &&
    !nonExecuteStatuses.has(receipt.status)
  ) {
    issues.push(
      issue(
        "receipt.non_execute_status",
        "/status",
        "Plan and dry-run invocations must use a non-execution receipt status.",
      ),
    );
  }
  if (
    invocation.execution_mode !== "execute" &&
    (receipt.executor_ref ||
      receipt.idempotency ||
      receipt.confirmation?.consumed_at)
  ) {
    issues.push(
      issue(
        "receipt.non_execute_proof",
        "/status",
        "Plan and dry-run receipts cannot contain executor, idempotency, or consumed-confirmation evidence.",
      ),
    );
  }

  if (receipt.status === "simulated" && invocation.execution_mode === "execute") {
    issues.push(
      issue(
        "receipt.simulation_mode_mismatch",
        "/status",
        "A simulated receipt must belong to a plan or dry-run invocation.",
      ),
    );
  }

  if (
    new Set(["denied", "awaiting_confirmation", "requires_human"]).has(
      receipt.status,
    ) &&
    ((receipt.effects?.length ?? 0) > 0 ||
      (receipt.usage?.length ?? 0) > 0 ||
      (receipt.privacy_egress?.length ?? 0) > 0 ||
      receipt.budget_reservation?.state !== "none")
  ) {
    issues.push(
      issue(
        "receipt.pre_execution_activity",
        "/status",
        "A pre-execution receipt cannot report effects, usage, egress, or a reservation.",
      ),
    );
  }
  if (
    new Set(["denied", "awaiting_confirmation", "requires_human"]).has(
      receipt.status,
    ) &&
    (receipt.started_at ||
      receipt.executor_ref ||
      receipt.confirmation?.consumed_at ||
      (receipt.idempotency &&
        !(
          receipt.status === "denied" &&
          receipt.idempotency.disposition === "conflict"
        )))
  ) {
    issues.push(
      issue(
        "receipt.pre_execution_proof",
        "/status",
        "A pre-execution receipt cannot claim execution, consumed confirmation, or non-conflict idempotency state.",
      ),
    );
  }

  const mutating = capability.effects?.some((effect) =>
    mutatingEffects.has(effect),
  );
  if (receipt.idempotency) {
    if (!invocation.idempotency_key) {
      issues.push(
        issue(
          "receipt.unexpected_idempotency",
          "/idempotency",
          "A receipt cannot claim idempotency state when the invocation has no key.",
        ),
      );
    } else {
      const keyDigest = computeIdempotencyKeyDigest(invocation);
      if (
        receipt.idempotency.key_digest !== keyDigest ||
        receipt.idempotency.semantic_digest !== computedDigest
      ) {
        issues.push(
          issue(
            "receipt.idempotency_mismatch",
            "/idempotency",
            "The receipt idempotency record does not bind this invocation.",
          ),
        );
      }
    }
    if (
      receipt.idempotency.disposition === "conflict" &&
      receipt.status !== "denied"
    ) {
      issues.push(
        issue(
          "receipt.idempotency_conflict_executed",
          "/idempotency/disposition",
          "An idempotency conflict must be denied before execution.",
        ),
      );
    }
    if (receipt.idempotency.disposition === "replayed") {
      const prior =
        priorReceiptById instanceof Map
          ? priorReceiptById.get(receipt.deduplicated_from_receipt_id)
          : priorReceiptById?.[receipt.deduplicated_from_receipt_id];
      const priorRecordedAt = parseTimestamp(prior?.recorded_at);
      const replayRecordedAt = parseTimestamp(receipt.recorded_at);
      if (
        !isPlainObject(prior) ||
        prior.receipt_id !== receipt.deduplicated_from_receipt_id ||
        prior.receipt_id === receipt.receipt_id ||
        prior.subject_id !== receipt.subject_id ||
        prior.capability_id !== receipt.capability_id ||
        prior.capability_version !== receipt.capability_version ||
        prior.invocation_semantic_digest !== computedDigest ||
        prior.idempotency?.key_digest !== receipt.idempotency.key_digest ||
        prior.idempotency?.semantic_digest !== computedDigest ||
        !Number.isInteger(prior.attempt) ||
        prior.attempt >= receipt.attempt ||
        priorRecordedAt === null ||
        replayRecordedAt === null ||
        priorRecordedAt >= replayRecordedAt
      ) {
        issues.push(
          issue(
            "receipt.replay_source_invalid",
            "/deduplicated_from_receipt_id",
            "A replay must resolve to a prior receipt for the same subject and intent.",
          ),
        );
      }
      if (
        (receipt.usage?.length ?? 0) > 0 ||
        (receipt.privacy_egress?.length ?? 0) > 0
      ) {
        issues.push(
          issue(
            "receipt.replay_new_activity",
            "/idempotency/disposition",
            "A replay cannot report new usage or data egress.",
          ),
        );
      }
    }
  }
  if (
    mutating &&
    invocation.execution_mode === "execute" &&
    executedReceiptStatuses.has(receipt.status)
  ) {
    if (!receipt.idempotency) {
      issues.push(
        issue(
          "receipt.idempotency_missing",
          "/idempotency",
          "An executed mutating attempt requires an idempotency record.",
        ),
      );
    }
  }

  const confirmationRequired =
    Boolean(invocation.confirmation_grant_ref) ||
    capability.effects?.some((effect) => accountEffects.has(effect));
  if (
    confirmationRequired &&
    invocation.execution_mode === "execute" &&
    executedReceiptStatuses.has(receipt.status)
  ) {
    const scopeDigest = computeConfirmationScopeDigest({
      invocationSemanticDigest: computedDigest,
      capabilityRegistryVersion: capability.registry_version,
    });
    if (
      receipt.confirmation?.grant_id !== invocation.confirmation_grant_ref ||
      receipt.confirmation?.scope_digest !== scopeDigest
    ) {
      issues.push(
        issue(
          "receipt.confirmation_mismatch",
          "/confirmation",
          "The receipt confirmation does not bind this invocation.",
        ),
      );
    }
    const verifiedAt = parseTimestamp(receipt.confirmation?.verified_at);
    const consumedAt = parseTimestamp(receipt.confirmation?.consumed_at);
    const executionStartedAt = parseTimestamp(receipt.started_at);
    const invocationRequestedAt = parseTimestamp(invocation.requested_at);
    const invocationExpiresAt = parseTimestamp(invocation.expires_at);
    if (
      verifiedAt === null ||
      consumedAt === null ||
      verifiedAt > consumedAt ||
      (executionStartedAt !== null && consumedAt > executionStartedAt) ||
      (invocationRequestedAt !== null && verifiedAt < invocationRequestedAt) ||
      (invocationExpiresAt !== null && consumedAt >= invocationExpiresAt)
    ) {
      issues.push(
        issue(
          "receipt.confirmation_time_order",
          "/confirmation/consumed_at",
          "Executed account effects require confirmation consumption before execution starts.",
        ),
      );
    }
  }

  const budgetRequested = (invocation.budget_request?.length ?? 0) > 0;
  if (!budgetRequested) {
    if (
      receipt.budget_reservation?.state !== "none" ||
      (receipt.usage?.length ?? 0) > 0
    ) {
      issues.push(
        issue(
          "receipt.unrequested_budget",
          "/budget_reservation",
          "The receipt reports usage or a reservation without an approved request.",
        ),
      );
    }
  } else if (
    invocation.execution_mode === "execute" &&
    executedReceiptStatuses.has(receipt.status)
  ) {
    if (receipt.budget_reservation?.state === "none") {
      issues.push(
        issue(
          "receipt.budget_reservation_missing",
          "/budget_reservation",
          "An executed budgeted attempt must retain its reservation record.",
        ),
      );
    }
    if (
      !budgetArraysEqual(
        receipt.budget_reservation?.reserved,
        invocation.budget_request,
      )
    ) {
      issues.push(
        issue(
          "receipt.budget_reservation_mismatch",
          "/budget_reservation/reserved",
          "The receipt reservation does not match the invocation request.",
        ),
      );
    }
    const reservationRecordedAt = parseTimestamp(
      receipt.budget_reservation?.recorded_at,
    );
    const executionStartedAt = parseTimestamp(receipt.started_at);
    if (
      reservationRecordedAt === null ||
      executionStartedAt === null ||
      reservationRecordedAt > executionStartedAt
    ) {
      issues.push(
        issue(
          "receipt.budget_reserved_after_start",
          "/budget_reservation/recorded_at",
          "A budget reservation must be recorded before execution starts.",
        ),
      );
    }
    if (
      new Set(["succeeded", "failed", "timed_out", "partial"]).has(
        receipt.status,
      ) &&
      !new Set(["reconciled", "released"]).has(
        receipt.budget_reservation?.state,
      )
    ) {
      issues.push(
        issue(
          "receipt.budget_terminal_state",
          "/budget_reservation/state",
          "A known terminal budgeted attempt must reconcile or release its reservation.",
        ),
      );
    }
  }

  if (
    ["reconciled", "released"].includes(receipt.budget_reservation?.state) &&
    !budgetArraysEqual(receipt.budget_reservation.actual, receipt.usage)
  ) {
    issues.push(
      issue(
        "receipt.budget_reconciliation_mismatch",
        "/budget_reservation/actual",
        "Reconciled budget actuals must match recorded usage.",
      ),
    );
  }
  if (["reconciled", "released"].includes(receipt.budget_reservation?.state)) {
    const reconciledAt = parseTimestamp(
      receipt.budget_reservation?.reconciled_at,
    );
    const executionStartedAt = parseTimestamp(receipt.started_at);
    const receiptRecordedAt = parseTimestamp(receipt.recorded_at);
    if (
      reconciledAt === null ||
      (executionStartedAt !== null && reconciledAt < executionStartedAt) ||
      (receiptRecordedAt !== null && reconciledAt > receiptRecordedAt)
    ) {
      issues.push(
        issue(
          "receipt.budget_reconciliation_time",
          "/budget_reservation/reconciled_at",
          "Budget reconciliation must occur after execution starts and before the receipt is recorded.",
        ),
      );
    }
  }

  if (receipt.status === "unknown") {
    if (receipt.error?.retryable !== false) {
      issues.push(
        issue(
          "receipt.unknown_retryable",
          "/error/retryable",
          "An unknown external outcome cannot be automatically retried.",
        ),
      );
    }
    if (!new Set(["reconcile", "human_handoff"]).has(receipt.recovery?.action)) {
      issues.push(
        issue(
          "receipt.unknown_recovery",
          "/recovery/action",
          "An unknown outcome requires reconciliation or human handoff.",
        ),
      );
    }
    if (budgetRequested && receipt.budget_reservation?.state !== "held") {
      issues.push(
        issue(
          "receipt.unknown_budget_released",
          "/budget_reservation/state",
          "Budget must remain held until an unknown outcome is reconciled.",
        ),
      );
    }
  }

  if (
    receipt.status === "succeeded" &&
    (receipt.error ||
      (receipt.effects ?? []).some((effect) => effect.status === "unknown"))
  ) {
    issues.push(
      issue(
        "receipt.success_contradiction",
        "/status",
        "A successful receipt cannot contain an error or unknown effect.",
      ),
    );
  }
  if (
    receipt.status === "succeeded" &&
    (receipt.effects ?? []).some((effect) => effect.status === "planned")
  ) {
    issues.push(
      issue(
        "receipt.success_effect_incomplete",
        "/effects",
        "A successful receipt cannot leave an effect in planned state.",
      ),
    );
  }

  if (
    receipt.status === "accepted" &&
    (receipt.effects ?? []).some((effect) => effect.status !== "planned")
  ) {
    issues.push(
      issue(
        "receipt.accepted_effect_completed",
        "/effects",
        "An accepted request cannot claim that an effect already completed.",
      ),
    );
  }

  if (
    receipt.status === "timed_out" &&
    (receipt.effects ?? []).some((effect) => effect.status === "unknown")
  ) {
    issues.push(
      issue(
        "receipt.timeout_unknown_effect",
        "/status",
        "A timeout with an uncertain external effect must use unknown status.",
      ),
    );
  }

  if (
    receipt.status !== "unknown" &&
    (receipt.effects ?? []).some((effect) => effect.status === "unknown")
  ) {
    issues.push(
      issue(
        "receipt.unknown_effect_status",
        "/status",
        "Any uncertain external effect requires unknown receipt status.",
      ),
    );
  }

  if (
    receipt.status === "cancelled" &&
    (receipt.effects ?? []).some((effect) =>
      new Set(["applied", "unknown"]).has(effect.status),
    )
  ) {
    issues.push(
      issue(
        "receipt.cancelled_effect",
        "/effects",
        "A cancelled receipt cannot contain applied or unknown effects.",
      ),
    );
  }
  if (
    receipt.status === "cancelled" &&
    budgetRequested &&
    receipt.budget_reservation?.state !== "released"
  ) {
    issues.push(
      issue(
        "receipt.cancelled_budget_not_released",
        "/budget_reservation/state",
        "A cancelled budgeted attempt must release its reservation.",
      ),
    );
  }

  if (
    receipt.status === "requires_human" &&
    receipt.recovery?.action !== "human_handoff"
  ) {
    issues.push(
      issue(
        "receipt.human_recovery_missing",
        "/recovery/action",
        "A human escalation receipt requires human_handoff recovery.",
      ),
    );
  }

  const startedAt = parseTimestamp(receipt.started_at);
  const finishedAt = parseTimestamp(receipt.finished_at);
  const recordedAt = parseTimestamp(receipt.recorded_at);
  const invocationRequestedAt = parseTimestamp(invocation.requested_at);
  const invocationExpiresAt = parseTimestamp(invocation.expires_at);
  if (
    (startedAt !== null && finishedAt !== null && startedAt > finishedAt) ||
    (finishedAt !== null && recordedAt !== null && finishedAt > recordedAt)
  ) {
    issues.push(
      issue(
        "receipt.time_order",
        "/finished_at",
        "Receipt timestamps are not chronological.",
      ),
    );
  }
  if (
    executedReceiptStatuses.has(receipt.status) &&
    (startedAt === null ||
      invocationRequestedAt === null ||
      invocationExpiresAt === null ||
      startedAt < invocationRequestedAt ||
      startedAt >= invocationExpiresAt)
  ) {
    issues.push(
      issue(
        "receipt.execution_outside_invocation_window",
        "/started_at",
        "Execution must start within the bound invocation validity window.",
      ),
    );
  }

  const plannedDestinations = invocation.data_manifest?.planned_destinations ?? [];
  const plannedDataClasses = new Set(
    invocation.data_manifest?.data_classes ?? [],
  );
  for (const egress of receipt.privacy_egress ?? []) {
    if (!plannedDataClasses.has(egress.data_class)) {
      issues.push(
        issue(
          "receipt.egress_data_unplanned",
          "/privacy_egress",
          "The receipt reports an unplanned data class.",
        ),
      );
    }
    const planned = plannedDestinations.some(
      (destination) =>
        destination.destination_type === egress.destination?.destination_type &&
        destination.system === egress.destination?.system &&
        destination.purpose_id === egress.destination?.purpose_id,
    );
    if (!planned) {
      issues.push(
        issue(
          "receipt.egress_destination_unplanned",
          "/privacy_egress",
          "The receipt reports an unplanned destination.",
        ),
      );
    }
  }

  return { ok: issues.length === 0, issues, computed_digest: computedDigest };
}

export function validateToolReceiptSemantics(context) {
  try {
    return validateToolReceiptSemanticsUnchecked(context ?? {});
  } catch {
    return {
      ok: false,
      issues: [
        issue(
          "record.receipt_context_invalid",
          "/",
          "Receipt semantics require a complete schema-valid receipt and invocation context.",
        ),
      ],
      computed_digest: null,
    };
  }
}

export function validateTrackRefSemantics(trackRef) {
  const issues = [];
  const createdAt = parseTimestamp(trackRef.created_at);
  const resolvedAt = parseTimestamp(trackRef.resolved_at);

  if (resolvedAt !== null && createdAt !== null && resolvedAt < createdAt) {
    issues.push(
      issue(
        "track.resolution_time_order",
        "/resolved_at",
        "Track resolution cannot predate record creation.",
      ),
    );
  }
  if (trackRef.revision === 1 && trackRef.supersedes) {
    issues.push(
      issue(
        "track.initial_supersedes",
        "/supersedes",
        "An initial TrackRef revision cannot supersede another revision.",
      ),
    );
  }
  if (trackRef.revision > 1) {
    if (
      trackRef.supersedes?.track_ref_id !== trackRef.track_ref_id ||
      trackRef.supersedes?.revision !== trackRef.revision - 1
    ) {
      issues.push(
        issue(
          "track.supersedes_mismatch",
          "/supersedes",
          "A TrackRef revision must supersede the immediately preceding revision of the same identity.",
        ),
      );
    }
  }
  if (trackRef.merged_into?.track_ref_id === trackRef.track_ref_id) {
    issues.push(
      issue(
        "track.merge_cycle",
        "/merged_into",
        "A TrackRef cannot merge into itself.",
      ),
    );
  }
  if (trackRef.candidate_track_ref_ids?.includes(trackRef.track_ref_id)) {
    issues.push(
      issue(
        "track.ambiguous_self_candidate",
        "/candidate_track_ref_ids",
        "An ambiguous TrackRef cannot list itself as a candidate.",
      ),
    );
  }

  return { ok: issues.length === 0, issues };
}

export function validateListeningEventSemantics(listeningEvent) {
  const issues = [];
  const occurredAt = parseTimestamp(listeningEvent.occurred_at);
  const ingestedAt = parseTimestamp(listeningEvent.ingested_at);
  if (occurredAt !== null && ingestedAt !== null && occurredAt > ingestedAt) {
    issues.push(
      issue(
        "listening.time_order",
        "/ingested_at",
        "A listening event cannot be ingested before it occurred.",
      ),
    );
  }
  return { ok: issues.length === 0, issues };
}

export function validateTasteEventSemantics(tasteEvent) {
  const issues = [];
  const occurredAt = parseTimestamp(tasteEvent.occurred_at);
  const recordedAt = parseTimestamp(tasteEvent.recorded_at);
  if (occurredAt !== null && recordedAt !== null && occurredAt > recordedAt) {
    issues.push(
      issue(
        "taste.time_order",
        "/recorded_at",
        "A taste event cannot be recorded before it occurred.",
      ),
    );
  }

  if (tasteEvent.signal_type === "rating") {
    const { value, scale_min: scaleMin, scale_max: scaleMax } =
      tasteEvent.rating ?? {};
    if (
      typeof value !== "number" ||
      typeof scaleMin !== "number" ||
      typeof scaleMax !== "number" ||
      scaleMin >= scaleMax ||
      value < scaleMin ||
      value > scaleMax
    ) {
      issues.push(
        issue(
          "taste.rating_range",
          "/rating",
          "A rating value must fall within a strictly increasing scale.",
        ),
      );
    }
  }
  if (
    tasteEvent.operation === "retract" &&
    tasteEvent.retracts_taste_event_id === tasteEvent.taste_event_id
  ) {
    issues.push(
      issue(
        "taste.self_retraction",
        "/retracts_taste_event_id",
        "A taste event cannot retract itself.",
      ),
    );
  }

  return { ok: issues.length === 0, issues };
}

export function contractRecordKey(recordType, recordId) {
  return `${recordType}:${recordId}`;
}

function recordFromCollection(records, recordType, recordId) {
  const key = contractRecordKey(recordType, recordId);
  if (records instanceof Map) return records.get(key);
  return records?.[key];
}

function recordsFromCollection(records) {
  if (records instanceof Map) return [...records.values()];
  return Object.values(records ?? {});
}

function recordIdForType(record, recordType) {
  if (recordType === "library_track_observation") {
    return record.library_track_observation_id;
  }
  if (recordType === "listening_event") return record.listening_event_id;
  if (recordType === "taste_event") return record.taste_event_id;
  return undefined;
}

function basisTimestamp(record, recordType) {
  if (recordType === "library_track_observation") {
    return parseTimestamp(record.observed_at);
  }
  return parseTimestamp(record.occurred_at);
}

export function validateLibraryTrackObservationSemantics(
  observation,
  { trackRef } = {},
) {
  const issues = [];
  if (!isPlainObject(observation)) {
    return {
      ok: false,
      issues: [
        issue(
          "observation.record_invalid",
          "/",
          "LibraryTrackObservation semantics require an object.",
        ),
      ],
    };
  }

  if (
    observation.provenance?.source_kind !== "import" ||
    observation.source_batch_ref !== observation.provenance?.import_batch_id
  ) {
    issues.push(
      issue(
        "observation.provenance_mismatch",
        "/provenance",
        "A library observation must bind its exact import batch.",
      ),
    );
  }
  if (observation.observed_at !== observation.provenance?.captured_at) {
    issues.push(
      issue(
        "observation.capture_time_mismatch",
        "/observed_at",
        "Observation and provenance capture timestamps must match.",
      ),
    );
  }

  const observedAt = parseTimestamp(observation.observed_at);
  for (const [field, value] of [
    ["last_played_at", observation.aggregate_state?.last_played_at],
    ["last_skipped_at", observation.aggregate_state?.last_skipped_at],
    ["date_added", observation.library_state?.date_added],
    ["date_modified", observation.library_state?.date_modified],
  ]) {
    const stateTimestamp = parseTimestamp(value);
    if (
      observedAt !== null &&
      stateTimestamp !== null &&
      stateTimestamp > observedAt
    ) {
      issues.push(
        issue(
          "observation.state_after_capture",
          field.startsWith("date_")
            ? `/library_state/${field}`
            : `/aggregate_state/${field}`,
          "Observed provider state cannot be later than its snapshot capture.",
        ),
      );
    }
  }

  if (
    trackRef &&
    (trackRef.track_ref_id !== observation.track_ref_id ||
      trackRef.revision !== observation.track_ref_revision)
  ) {
    issues.push(
      issue(
        "observation.track_ref_mismatch",
        "/track_ref_id",
        "A library observation must bind the exact TrackRef revision supplied by the registry.",
      ),
    );
  }

  return { ok: issues.length === 0, issues };
}

function entityIdentity(entityRef) {
  const identity = {};
  for (const field of [
    "entity_type",
    "entity_id",
    "entity_revision",
    "entity_key",
  ]) {
    if (entityRef?.[field] !== undefined) identity[field] = entityRef[field];
  }
  return identity;
}

export function validateProfileEvidenceSemantics({ evidence, records }) {
  const issues = [];
  const resolvedBasis = [];

  for (const basisRef of evidence.basis_refs ?? []) {
    const record = recordFromCollection(
      records,
      basisRef.record_type,
      basisRef.record_id,
    );
    if (!record) {
      issues.push(
        issue(
          "evidence.basis_missing",
          "/basis_refs",
          "A referenced evidence record does not exist.",
        ),
      );
      continue;
    }
    if (recordIdForType(record, basisRef.record_type) !== basisRef.record_id) {
      issues.push(
        issue(
          "evidence.basis_identity_mismatch",
          "/basis_refs",
          "A referenced evidence record has a different identity.",
        ),
      );
    }
    if (record.subject_id !== evidence.subject_id) {
      issues.push(
        issue(
          "evidence.subject_mismatch",
          "/basis_refs",
          "Evidence cannot cross subject boundaries.",
        ),
      );
    }
    resolvedBasis.push({ basisRef, record });
  }

  const windowStart = parseTimestamp(evidence.evidence_window?.start_at);
  const windowEnd = parseTimestamp(evidence.evidence_window?.end_at);
  const createdAt = parseTimestamp(evidence.created_at);
  if (evidence.evidence_window && windowStart > windowEnd) {
    issues.push(
      issue(
        "evidence.window_order",
        "/evidence_window/end_at",
        "The evidence window end must follow its start.",
      ),
    );
  }
  if (
    evidence.evidence_window &&
    createdAt !== null &&
    windowEnd !== null &&
    windowEnd > createdAt
  ) {
    issues.push(
      issue(
        "evidence.window_after_creation",
        "/evidence_window/end_at",
        "The evidence window cannot extend past record creation.",
      ),
    );
  }
  for (const { basisRef, record } of resolvedBasis) {
    const occurredAt = basisTimestamp(record, basisRef.record_type);
    if (evidence.evidence_window) {
      if (
        occurredAt !== null &&
        (occurredAt < windowStart || occurredAt > windowEnd)
      ) {
        issues.push(
          issue(
            "evidence.basis_outside_window",
            "/basis_refs",
            "A referenced record falls outside the declared evidence window.",
          ),
        );
      }
    }
    if (occurredAt !== null && createdAt !== null && occurredAt > createdAt) {
      issues.push(
        issue(
          "evidence.basis_after_creation",
          "/basis_refs",
          "A profile claim cannot depend on a future record.",
        ),
      );
    }
  }

  const retractedTasteIds = new Set(
    recordsFromCollection(records)
      .filter(
        (record) =>
          record?.operation === "retract" &&
          record.subject_id === evidence.subject_id &&
          (createdAt === null ||
            parseTimestamp(record.recorded_at ?? record.occurred_at) <= createdAt),
      )
      .map((record) => record.retracts_taste_event_id)
      .filter(Boolean),
  );
  for (const { basisRef, record } of resolvedBasis) {
    if (
      basisRef.record_type === "taste_event" &&
      (record.operation !== "assert" ||
        retractedTasteIds.has(record.taste_event_id))
    ) {
      issues.push(
        issue(
          "evidence.taste_retracted",
          "/basis_refs",
          "A retracted taste assertion cannot support profile evidence.",
        ),
      );
    }
  }

  if (evidence.derivation?.kind === "direct") {
    if (resolvedBasis.length !== 1) {
      issues.push(
        issue(
          "evidence.direct_basis_count",
          "/basis_refs",
          "Direct evidence must bind exactly one record.",
        ),
      );
    } else {
      const [{ basisRef, record }] = resolvedBasis;
      if (basisRef.record_type !== "taste_event" || record.operation !== "assert") {
        issues.push(
          issue(
            "evidence.direct_basis_type",
            "/basis_refs",
            "Direct profile evidence must bind one explicit taste assertion.",
          ),
        );
      }
      if (
        evidence.claim?.value?.value_type !== "entity" ||
        !canonicalEqual(
          entityIdentity(evidence.claim?.value?.entity_ref),
          entityIdentity(record.target),
        )
      ) {
        issues.push(
          issue(
            "evidence.direct_target_mismatch",
            "/claim/value/entity_ref",
            "A direct entity claim must match the exact asserted target revision.",
          ),
        );
      }
    }
  }

  if (
    resolvedBasis.some(
      ({ basisRef }) =>
        basisRef.record_type === "library_track_observation",
    ) &&
    !new Set(["rule", "aggregate"]).has(evidence.derivation?.kind)
  ) {
    issues.push(
      issue(
        "evidence.observation_derivation_invalid",
        "/derivation/kind",
        "Observation-derived evidence must use a rule or aggregate derivation.",
      ),
    );
  }

  if (
    new Set(["rule", "aggregate", "model"]).has(evidence.derivation?.kind) &&
    !evidence.derivation?.parameters_digest
  ) {
    issues.push(
      issue(
        "evidence.parameters_digest_missing",
        "/derivation/parameters_digest",
        "Non-direct derivations must bind their parameters.",
      ),
    );
  }

  const expiresAt = parseTimestamp(evidence.expires_at);
  if (expiresAt !== null && createdAt !== null && expiresAt <= createdAt) {
    issues.push(
      issue(
        "evidence.expiry_order",
        "/expires_at",
        "Profile evidence expiry must follow its creation time.",
      ),
    );
  }

  if (evidence.supersedes_profile_evidence_id) {
    const superseded = recordFromCollection(
      records,
      "profile_evidence",
      evidence.supersedes_profile_evidence_id,
    );
    if (!superseded || superseded.subject_id !== evidence.subject_id) {
      issues.push(
        issue(
          "evidence.superseded_record_invalid",
          "/supersedes_profile_evidence_id",
          "Superseded profile evidence must exist for the same subject.",
        ),
      );
    }
  }

  return { ok: issues.length === 0, issues };
}
