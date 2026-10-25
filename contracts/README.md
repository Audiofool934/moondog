# Moondog Core Contracts

## Purpose

This directory defines the record contracts that Moondog importers and stores share.
JSON Schema 2020-12 is the canonical representation.
Node and Ajv are development-only validation tools and do not determine the implementation language of the product runtime.

## Contracts

- `TrackRef v1` identifies a playable recording without making one provider canonical.
- `ListeningEvent v1` records an observed playback fact without inferring taste.
- `TasteEvent v1` records an explicit preference signal using immutable assert and retract operations.
- `LibraryTrackObservation v1` records one provider-neutral aggregate library snapshot without fabricating events.
- `ProfileEvidence v2` connects an interpretable profile claim to `ListeningEvent`, `TasteEvent`, or `LibraryTrackObservation` records of the same subject.

`v1/definitions.schema.json` holds the shared types, such as UUIDs, UTC timestamps, and external references.
Moondog-owned record identifiers use UUIDs.
All timestamps must be RFC3339 UTC values ending in `Z`.
Records reject unknown properties.
Namespaced `extensions` is the only open payload.
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
A Like or Avoid from chat is explicit in the listener's words, but the agent resolves a phrase such as "this song" to the title and artist, and the record keeps no quote.
System inference belongs in `ProfileEvidence`, not in `TasteEvent.explicitness`.
A final profile must be materialized from evidence rather than written as an unsupported persona.

Persisted records must not contain credentials, cookies, OAuth query strings, or raw provider payloads.

## Validation Layers

JSON Schema validates the shape of one record.
`scripts/contract-semantics.mjs` adds cross-field checks, canonical JSON, and a secret scanner for persisted records.
Its `ProfileEvidence` check also confirms that each basis record exists, belongs to the same subject, fits the evidence window, and is not a retracted taste assertion.
The Apple Music library importer runs both layers before it writes records.

Every record carries an explicit `schema_version`.
`ProfileEvidence v2` superseded v1, which is no longer registered.
No migration code exists, because no stored contract record needs an upgrade.

Some tables in the listening history store are internal to that store and outside these contracts.
One is `moondog_suggestions`, the ledger of what Moondog queued or played: it has no schema here and no `schema_version`.

## Validation

Install the locked development dependencies and run:

```bash
npm ci
npm run validate:contracts
npm test
```

`npm ci` may contact the configured npm registry unless the locked packages are already cached.
After dependencies are installed, `npm run validate:contracts` and `npm test` use only local schemas, reference code, and synthetic fixtures.
