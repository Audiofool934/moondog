# Apple Music Library XML Import

## Status

Apple Music Library XML is Moondog's first real personal-data source.

It seeds recording candidates and an inspectable library-state snapshot.

It is not a complete listening-history source.

The importer is local-only and does not contact Apple, Spotify, a private legacy host, or any other network service.

## Safe Inspection

Export `Library.xml` from Apple Music, keep it outside the repository, and run:

```bash
npm run inspect:apple-library -- --input /absolute/path/to/Library.xml
```

Inspection reads the file and prints only aggregate counts, field coverage, source size, and data-semantics flags.

It does not print track names, artists, albums, playlist names, provider identifiers, or local paths.

It does not write files.

## Private Import

Run:

```bash
npm run import:apple-library -- \
  --input /absolute/path/to/Library.xml
```

Moondog creates or reuses one stable private local music subject automatically.

If Spotify history was imported first, the Apple batch reuses that subject.

If earlier verified Apple batches already exist, the import reuses their subject and requires it to match the local listening store.

`--subject-id <uuid>` remains an advanced explicit override and must agree with both existing sources.

The command writes one private batch under:

```text
data/imports/apple-music-library/<import-batch-id>/
  manifest.json
  track-refs.ndjson
  track-snapshots.ndjson
  warnings.ndjson
```

`data/imports/`, `data/private/`, `Library.xml`, and Apple Music library bundles are ignored by Git.

Batch directories use mode `0700`, and files use mode `0600`.

Writes are staged in a private temporary directory and renamed into place only after every file succeeds.

An existing matching batch is verified and treated as an idempotent no-op.

An existing mismatched or corrupted batch fails closed and is never overwritten.

## Output Semantics

Each source track becomes a provisional `TrackRef` candidate plus one provider-specific aggregate snapshot.

Candidate `TrackRef` identifiers are unique to an import batch.

This prevents two exports with changed metadata from reusing the same immutable `track_ref_id + revision` pair.

The hashed `ExternalRef` is the stable cross-batch identity anchor when Apple persistent IDs are available.

The disposable A1 projection uses exact matching on that anchor to create canonical TrackRef revisions.

It does not perform fuzzy identity merges.

Raw Apple Library Persistent IDs, track Persistent IDs, playlist Persistent IDs, `Music Folder`, `Location`, comments, grouping values, and the original XML are not written into normalized output.

The current mapping includes:

- Track name, artist, album, release date, duration, genre, composer, and valid ISRC values in provisional TrackRef candidates.
- Aggregate play count and last-played time in a private snapshot.
- Aggregate skip count and last-skipped time in a private snapshot.
- Rating, Loved, Favorited, date-added, date-modified, and selected library flags in a private snapshot.
- Counts only for playlists and playlist-item references.

Artist strings are not split on commas, ampersands, or collaboration markers because those separators are ambiguous.

Album Artist is used as an artist fallback only when Artist is missing, and that fallback produces a warning.

Missing Apple persistent identities use a batch-scoped fallback and produce an `identity_fallback_unstable` warning.

## What Is Deliberately Not Generated

The importer generates zero core `ListeningEvent` records.

`Play Count` is cumulative, and `Play Date UTC` is only the latest observed playback time.

Expanding a count of 50 into 50 fabricated events would invent timestamps and contexts that the export does not contain.

`Skip Count` and `Skip Date` have the same limitation.

The importer also generates zero core `TasteEvent` records.

Loved, Favorited, ratings, and playlist membership are current snapshot states without trustworthy action timestamps.

They remain provider-neutral observation state rather than being relabeled as explicit actions.

The A1 projection may derive conservative supporting preference evidence from Loved and Favorited, plus direction-aware evidence from ratings that are not marked computed.

It may derive familiarity evidence from aggregate Play Count, but that evidence never supports liking.

`Total Time` is recording duration and is never treated as played duration.

Missing values mean unknown, not zero.

## Parser and Privacy Boundaries

The importer accepts the standard Apple plist doctype and removes it before parsing so no DTD is fetched.

Custom doctypes, entity declarations, internal entities, CDATA sections, duplicate dictionary keys, invalid UTF-8, unbalanced containers, oversized inputs, excessive nesting, excessive node counts, and oversized text values are rejected.

The default input limit is 64 MiB.

Contract and snapshot records are validated before writing.

Persisted records also pass Moondog's unsafe-data inspection.

Tests use only the synthetic fixture under `tests/fixtures/apple-music-library/`.

The real export must never be copied into Git or converted into a committed fixture.

## Disposable A1 Projection

After at least one verified private import exists, rebuild the local A1 projection with:

```bash
npm run rebuild:apple-projection
```

The command infers the trusted subject only when all selected verified batches agree on one subject.

An optional `--subject-id` value can explicitly select one subject when multiple subjects are present.

The command does not print subject identifiers, provider identifiers, track metadata, or private paths.

The projection is written to `data/private/apple-music-library/projection.sqlite` with file mode `0600` inside private directories.

Runtime reads and local-data control can point at an isolated existing import root and disposable projection with `MOONDOG_APPLE_IMPORTS_ROOT` and `MOONDOG_APPLE_PROJECTION_PATH`.
Both overrides must be absolute paths.
When they are unset, the repository-local paths documented above remain the defaults.

It contains canonical TrackRefs, provider-neutral observations, conservative ProfileEvidence v2 records, profile summary rows, and a bounded FTS5 library index.

Rebuilds use a private temporary database, validate foreign keys and integrity, verify a logical digest, and atomically replace the prior projection only after success.

The same verified input produces the same logical projection digest.

The SQLite file is derived and disposable.

Deleting it does not delete the canonical import batches, and rerunning the rebuild recreates it.

The Moondog CLI opens this projection read-only and enables A1 library and profile tools only when validation succeeds.

Node currently marks its built-in `node:sqlite` module as experimental, so the launch scripts suppress that known warning while retaining normal errors.

## Removing an Import

Removing one batch means deleting only its exact UUID-named directory under `data/imports/apple-music-library/`.

The original Apple Music XML export is not copied or changed by Moondog.

Verify the exact batch ID from its manifest or the import command output before deleting anything.

Rebuild the disposable projection after removing an import batch so its derived view matches the remaining canonical inputs.

## Next Data Source

Spotify Extended Streaming History remains the leading candidate for complete per-play events.

When that export arrives, it should feed `ListeningEvent` records while Apple Music Library XML continues to provide catalog, curation, and aggregate-state context.
