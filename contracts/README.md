# Moondog Core Contracts

## Purpose

This directory defines the first framework-neutral contracts shared by Moondog components.

JSON Schema 2020-12 is the canonical representation.

Node and Ajv are development-only validation tools and do not determine the implementation language of the product runtime.

## Versioned Contracts

- `TrackRef` identifies a playable recording without making one provider canonical.
- `ListeningEvent` records an observed playback fact without inferring taste.
- `TasteEvent` records an explicit preference signal using immutable assert and retract operations.
- `LibraryTrackObservation v1` records one provider-neutral aggregate library snapshot observation without fabricating events.
- `ProfileEvidence v1` connects an interpretable profile claim to ListeningEvent or TasteEvent records.
- `ProfileEvidence v2` also permits a same-subject `LibraryTrackObservation` basis for the A1 profile projection.
- `CapabilityPolicy` defines a bounded rule for who may invoke a capability and under which constraints.
- `ToolInvocation` records an immutable tool intent.
- `ToolReceipt` records one append-only attempt and its observed effects.

Moondog-owned record identifiers use UUIDs.

Capability names, external identifiers, digests, and idempotency keys use contract-specific formats.

All timestamps must be RFC3339 UTC values ending in `Z`.

Core record and envelope fields reject unknown properties.

`arguments` and namespaced `extensions` are deliberate open payloads and require capability-specific validation and semantic inspection.

Provider names may occur as data inside `ExternalRef.system`, but provider-specific fields and enums do not belong in core contracts.

## Data Semantics

A `TrackRef` represents a recording, not a composition or an artist.

An unresolved provider item first becomes a sparse provisional `TrackRef`; its full provider payload is not embedded in a listening event.

Listening events bind the exact TrackRef revision visible at capture time, while later identity corrections use immutable supersede or merge records.

A `ListeningEvent` is an observation.

Provider aggregate counts, current library membership, and last-played timestamps are snapshots.

They must not be expanded or relabeled as a sequence of `ListeningEvent` records.

`LibraryTrackObservation` preserves those aggregate and library states as one bounded observation tied to an exact TrackRef revision and verified import batch.

A single skip does not automatically mean dislike.

A `TasteEvent` is an explicitly asserted signal.

System inference belongs in `ProfileEvidence`, not in `TasteEvent.explicitness`.

A final profile must be materialized from evidence rather than written as an unsupported persona.

## Tool Semantics

`CapabilityPolicy` is a constraint, `ToolInvocation` is an immutable intent, and `ToolReceipt` is an immutable fact.

Invocation effect and risk declarations are untrusted input.

The policy evaluator must resolve authoritative effects and risks from a trusted capability registry and deny a mismatch.

No matching policy, an unknown capability, an unknown schema version, a revoked grant, or incomplete context must fail closed.

Confirmation is not authorization.

A confirmation grant must be independently verified and bound to the subject, capability, account, target, semantic digest, budget, data egress, and expiry.

External writes, sends, publishing, deletion, and spending require an idempotency key and stable semantic digest.

Retries preserve the original invocation, idempotency key, semantic digest, confirmation scope, and budget reservation.

An unknown provider outcome must be reconciled before a non-idempotent action is retried.

Plan and dry-run mode cannot invoke a side-effecting executor.

They also cannot export raw listening history.

Receipts are written for simulation, denial, confirmation waits, success, failure, partial completion, unknown outcomes, cancellation, and human escalation.

An accepted provider request is not the same as a completed operation.

## Privacy and Audit

Raw listening history is local by default.

Tool arguments, receipts, errors, and logs must not contain credentials, cookies, OAuth query strings, raw provider payloads, or unnecessary listening history.

External data transfer records its purpose, data class, destination, and actual retained scope.

Authorization compares stable `purpose_id` values, while human-readable purpose text remains audit context.

Artifacts are referenced by controlled identifiers and hashes instead of embedding private or generated media in receipts.

Cross-user caches, idempotency records, policy grants, and receipts must remain isolated by subject.

## Execution Boundary

JSON Schema validates record shape only.

It cannot authenticate an actor, select the effective policy, verify a confirmation grant, reserve a cumulative budget, control idempotency state, or prove that an external effect occurred.

The reference validator in `scripts/contract-semantics.mjs` adds deterministic digest computation, trusted registry matching, policy scope checks, secret scanning, capability-specific argument and intent hooks, confirmation and rights hooks, budget reservation hooks, receipt consistency checks, and limited cross-record evidence checks.

It fails closed when a required trusted hook is absent.

The reference gate snapshots its inputs, gives hooks isolated copies, and rejects caller-side mutation detected during validation.

It is a conformance reference, not a production authorization engine.

A production runtime must resolve the effective policy from trusted state, including any higher-priority deny rule, and must back confirmation, rights, idempotency, and budget checks with transactional stores.

The current repository does not yet define a complete confirmation-grant store, policy resolver, execution-permit store, or provider executor.

External writes, sends, publishing, deletion, spending, and credential use must therefore remain disabled in a product runtime until those components exist and pass integration tests.

## Validation Layers

JSON Schema validates the shape of one record.

The repository reference validator checks deterministic and cross-field semantics over schema-valid synthetic records.

The future product runtime must independently enforce authorization and mutable state immediately before execution.

Repository and domain validators must separately enforce cross-record constraints, including:

- Referenced records exist and belong to the same subject.
- An evidence record does not depend on a retracted signal.
- Evidence windows and invocation deadlines are chronologically valid.
- External identities are unique within their system and entity type.
- Policy revisions, grants, account scopes, and capability registry versions match at execution time.
- Concurrent budget reservations do not exceed cumulative limits.
- A receipt belongs to the invocation and attempt it claims.
- Error and result summaries satisfy redaction policy.

Every contract uses an explicit `schema_version` and the fail-closed entry point in `scripts/contract-migrations.mjs`.

The registry validates `ProfileEvidence v1` and `ProfileEvidence v2` side by side.

No generic migration pipeline is implied because the canonical repository currently contains no ProfileEvidence records that require migration.

## Validation

Install the locked development dependencies and run:

```bash
npm ci
npm run validate:contracts
npm test
```

`npm ci` may contact the configured npm registry unless the locked packages are already cached.

After dependencies are installed, `npm run validate:contracts` and `npm test` use only local schemas, reference code, and synthetic fixtures.

They do not contact a private legacy host, a streaming service, a messaging service, or a generation provider.
