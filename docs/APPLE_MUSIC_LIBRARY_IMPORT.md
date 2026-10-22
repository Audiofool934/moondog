# Apple Music Library XML Import

## Status

Apple Music Library XML is Moondog's first real personal-data source.

It seeds recording candidates and an inspectable library-state snapshot.

It is not a complete listening-history source.

The importer is local-only and does not contact Apple, Spotify, a private legacy host, or any other network service.

## Import in the terminal

In Music on a Mac, choose File > Library > Export Library.
Save `Library.xml` outside the repository.

In the listening room, use `/import > Apple Music > Quick start with library XML`.
The guide explains the export and accepts the XML file.
You can also enter the path directly:

```text
/import "/absolute/path/to/Library.xml"
```

## Preview

Moondog reads and parses the whole file in memory before it saves anything.

The preview shows the file name, the number of songs, the export date, and a note that a library shows what you keep, not when you played each song.

It does not show track names, artists, albums, playlist names, provider identifiers, or local paths.

Nothing is written until you choose **Add to my profile**.

## Private Import

When you add the library, Moondog saves the exact snapshot it previewed, even if the file changes afterward.

Moondog creates or reuses one stable private local music subject automatically.

If Spotify history was imported first, the Apple batch reuses that subject.

If earlier verified Apple batches already exist, the import reuses their subject and requires it to match the local listening store.

The import writes one private batch into Moondog's local state directory, next to your listening history (`~/.local/state/moondog` unless `MOONDOG_STATE_HOME` or `XDG_STATE_HOME` says otherwise):

```text
apple-music-library/imports/<import-batch-id>/
  manifest.json
  track-refs.ndjson
  track-snapshots.ndjson
  warnings.ndjson
```

Nothing is written inside the source checkout.
`Library.xml`, Apple Music library bundles, and the checkout's `data/imports/` and `data/private/` folders stay ignored by Git.

Batch directories use mode `0700`, and files use mode `0600`.

Writes are staged in a private temporary directory and renamed into place only after every file succeeds.

An existing matching batch is verified and treated as an idempotent no-op.

An existing mismatched or corrupted batch fails closed and is never overwritten.

After the batch is saved, Moondog rebuilds the disposable A1 projection and opens the cumulative profile in the same terminal session.

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

Every Apple Music `/import` rebuilds the local A1 projection from all verified import batches.
Importing a library that is already saved adds no batch, but it still rebuilds the projection.

The rebuild infers the trusted subject only when all verified batches agree on one subject.

The projection is written to `apple-music-library/projection.sqlite` in the same state directory, with file mode `0600` inside private directories.

Runtime reads and local-data control can point at an isolated existing import root and disposable projection with `MOONDOG_APPLE_IMPORTS_ROOT` and `MOONDOG_APPLE_PROJECTION_PATH`.
Both overrides must be absolute paths.
When they are unset, the state-directory paths documented above remain the defaults.

It contains canonical TrackRefs, provider-neutral observations, conservative ProfileEvidence v2 records, profile summary rows, and a bounded FTS5 library index.

Rebuilds use a private temporary database, validate foreign keys and integrity, verify a logical digest, and atomically replace the prior projection only after success.

The same verified input produces the same logical projection digest.

The SQLite file is derived and disposable.

Deleting it does not delete the canonical import batches, and the next Apple Music `/import` recreates it.

The Moondog CLI opens this projection read-only and enables A1 library and profile tools only when validation succeeds.

Node currently marks its built-in `node:sqlite` module as experimental, so the launch scripts suppress that known warning while retaining normal errors.

## Removing an Import

Removing one batch means deleting only its exact UUID-named directory under `apple-music-library/imports/` in the state directory.

The original Apple Music XML export is not copied or changed by Moondog.

Verify the exact batch ID from its manifest before deleting anything.

Rebuild the disposable projection after removing an import batch so its derived view matches the remaining canonical inputs.
To rebuild it, use `/import` again with a Library.xml file whose batch you kept.

To set all Apple data aside instead, run `moondog data inspect --scope apple` and then `moondog data reset --scope apple --confirm <token>`.
The reset archives the import batches and the projection rather than deleting them.

## Next Data Source

Spotify Extended Streaming History remains the leading candidate for complete per-play events.

When that export arrives, it should feed `ListeningEvent` records while Apple Music Library XML continues to provide catalog, curation, and aggregate-state context.
