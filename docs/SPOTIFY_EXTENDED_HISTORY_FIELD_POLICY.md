# Spotify Extended Streaming History Field Policy

Moondog uses Spotify Extended Streaming History as private music evidence, not as a reason to retain every field in the export.

The field definitions in the export's bundled `ReadMeFirst_ExtendedStreamingHistory.pdf` are the primary reference for this policy.

The source archive remains unchanged.

## Field map

| Export field | Moondog treatment | Product use |
| --- | --- | --- |
| `ts` | Normalize and persist as `occurred_at` | Canonical UTC track-stop time and listening chronology |
| `ms_played` | Validate and persist | Listening-time totals, rankings, and coverage |
| `master_metadata_track_name` | Sanitize and persist | Track display and provisional metadata |
| `master_metadata_album_artist_name` | Sanitize and persist | Artist credit and artist-level aggregation |
| `master_metadata_album_album_name` | Sanitize and persist when present | Release context |
| `spotify_track_uri` | Validate, derive a resolved TrackRef, then discard the raw URI string | Stable track identity and cross-import reconciliation |
| `reason_start` | Sanitize and persist as bounded provider extension | Direct-start and previous-track-ended flow counts |
| `reason_end` | Sanitize and persist as bounded provider extension | `trackdone` ending context |
| `skipped` | Validate and persist when supplied | Explicit navigation context and `play_skipped` event type |
| `shuffle` | Validate and persist when supplied | Shuffle playback context |
| `offline` | Validate and persist when supplied | Offline playback context |
| `incognito_mode` | Validate and persist when supplied | Coverage count only; true events are excluded from taste rankings |
| `username` | Ignore | Direct account identifier with no supported taste use |
| `ip_addr` or `ip_addr_decrypted` | Ignore | Direct network identifier with no supported taste use |
| `conn_country` | Ignore | Location data with no necessary use in the current product |
| `platform` | Ignore | Device and platform fingerprint with no necessary use in the current product |
| `user_agent_decrypted` | Ignore | Device and browser fingerprint with no necessary use in the current product |
| `offline_timestamp` | Ignore | `ts` remains the canonical event time; the additional offline-mode timestamp has no supported taste interpretation |
| Episode, show, and audiobook fields | Exclude from the music profile | Non-music history remains outside the current product scope |
| Video-history members | Do not read | Non-audio history remains outside the current importer scope |

## Cross-format track identity

An exact Account Data and Extended History event overlap can provide stronger track-identity evidence than title matching alone.

When every exact overlap for one provisional Account Data TrackRef points to the same resolved Extended History TrackRef, Moondog uses that resolved identity to aggregate any remaining effective events from the provisional TrackRef at projection time.

The store does not rewrite either TrackRef or any listening event.

If exact overlaps point to more than one resolved target, Moondog keeps the provisional identity separate rather than choosing a recording.

Profile coverage reports the number of applied source TrackRef links and affected effective events, plus the number of ambiguous provisional identities and effective events deliberately kept separate, without exposing the identifiers.

## Playback-flow projection

Moondog counts how many eligible events actually contain each optional playback field.

Direct-start and previous-track-ended start shares use only events with a recorded `reason_start`.

`trackdone` ending share uses only events with a recorded `reason_end`.

Skip, shuffle, and offline shares each use only events with the corresponding supplied boolean state.

This matters when Extended Streaming History is combined with Account Data, recent Spotify syncs, or ListenBrainz events that do not expose the same fields.

The direct-start group currently recognizes `clickrow`, `clickside`, `playbtn`, `remote`, `search`, and `uriopen` after Unicode normalization and case folding.

`trackdone` is retained as a provider reason rather than promoted into a universal claim that a song was completed.

A skip is contextual navigation evidence rather than a durable dislike.

Shuffle, offline, direct-start, and continuation counts do not establish attention, satisfaction, personality, location, travel, device use, or preference.

## Listening Pulse and Listening Seasons

Moondog aggregates eligible effective-event timestamps into continuous UTC calendar months for **Listening Pulse** and fixed UTC calendar quarters for **Listening Seasons**.
The monthly layer retains only event count, engaged-play count, listening minutes, and distinct-track count.
The quarterly layer adds active retained months, tracks first observed within retained eligible history versus tracks seen earlier, one aggregate leading artist, and one aggregate signature track.

The profile keeps at most the latest 240 months and latest 80 quarters.
The complete Tasteprint shows at most the latest 12 represented quarters, while Studio and the Agent profile summary show at most the latest six and report what their bounded views omit.

Incognito events do not contribute to either view.
Raw timestamps, event sequences, TrackRefs, evidence identifiers, source paths, and provider identity stay outside the rendered and model-visible projections.
A blank month or quarter means no eligible retained event appears in that UTC window, not proof of no listening.
First observed means first appearance in retained eligible history, not discovery, and within-quarter anchors do not establish mood, identity, life events, or permanent preference.

## Historical returns

Moondog compares consecutive retained plays for each normalized track identity after removing explicit skip signals from the gap sequence.
A track qualifies for **Music that came back** only when at least one observed gap reaches 180 days, the track has at least three effective plays, at least three plays without an explicit skip signal, at least ten listening minutes, engaged plays are not outnumbered by explicit skips, and no active artist or track avoidance applies.

The profile records only bounded music metadata, effective and engaged play counts, aggregate listening minutes, first and last retained timestamps, return count, longest gap, latest return gap, a bounded support label, and an evidence identifier.
Studio further reduces that result to at most four track labels, artist credits, return counts, gap lengths, and the latest return date.
The Agent candidate tool exposes bounded recurrence evidence and opaque track references while provider identifiers stay inside the host.

A long gap followed by another retained play is recurrence in the available archive.
It is not proof of liking, nostalgia, intentional absence, rediscovery, or current preference.
Incomplete exports, changed provider metadata, and provisional track identity can lengthen, shorten, split, or merge the observed pattern.

## Played back to back

Moondog builds **Played back to back** only from eligible Spotify Extended Streaming History events because this source supplies resolved track identity and a documented `ts` track-stop chronology.
A sequence begins when the same resolved track appears in adjacent retained rows and continues while each play lasted at least 30 seconds, no row carries an explicit skip signal, and each gap is between zero and 30 minutes.
At least two adjacent eligible plays are required.

The profile records only bounded music metadata, effective and engaged play counts, burst count, longest consecutive sequence, plays and listening minutes inside qualifying bursts, latest burst time, a sequence label, and an evidence identifier.
Studio further reduces that result to at most four music labels, sequence aggregates, and the latest observed date.
The Agent candidate tool exposes bounded sequence evidence and opaque track references while provider identifiers stay inside the host.

Active artist or track avoidances are excluded.
Spotify Account Data and ListenBrainz events are not promoted into this view because their current imported contracts do not jointly provide the required exact Spotify identity and `ts` semantics.
Adjacent retained plays do not prove that repeat mode was active or that the listener intended, liked, or preferred the track.
Incomplete exports, changed provider metadata, and retained-event filtering can split or remove an observed sequence.

## Temporal continuity and change

Moondog uses the retained UTC year of each eligible event and its sanitized artist credit to calculate two descriptive temporal views.

**Artists across eras** includes an artist only when that artist appears in at least two retained UTC calendar years and is also present in the latest retained year.
The view reports the first and last retained years, active-year count, total effective plays, and listening minutes.
It ranks artists by active years, retained span, listening time, plays, and normalized name.

**Year-to-year turnover** ranks up to the ten artists with the most retained listening time in each year, breaking ties by effective play count and normalized name.
It compares adjacent retained years and reports the later set's carried-forward count, new count, and overlap percentage.

Both calculations exclude incognito events because the base taste projection excludes them.
An active artist or track correction remains separate direct evidence and does not rewrite these historical aggregates.

This continuity view does not establish uninterrupted affinity, discovery, genre breadth, identity, or permanent taste change.
Missing years, incomplete exports, changed metadata, and provisional artist naming can all affect the result.

## Release depth and approximate sessions

Moondog pairs each retained release title with its sanitized artist credit before aggregating album metadata.
The **Records explored in depth** view requires at least three distinct effective track identities from that artist and release pair.
It reports bounded track breadth, effective plays, listening minutes, and active retained UTC years, then ranks releases by listening time, track breadth, engaged plays, artist, and title.

This release-level pattern does not establish full-album playback, track order, completion, ownership, release type, or liking.
Changed provider metadata and alternate release editions can split what a listener considers one record.

Moondog builds **Approximate sessions** only from eligible Spotify Extended History events, because their `ts` field has a consistent documented track-stop meaning.
Events stay in the same approximate session until a gap longer than 30 minutes begins a new one.
The projection reports only aggregate session count, median plays, median listening minutes, and counts for one-play, two-to-four-play, and five-or-more-play stretches.

The grouping is not a provider session log.
It does not establish continuous playback, activity, attention, satisfaction, mood, routine, location, time zone, or intent.
Per-session timestamps and raw event sequences are not placed in the Tasteprint or Studio response.

## Privacy boundary

The ProfileProjection and Tasteprint contain aggregates, bounded music metadata, and interpretation limits.

They do not contain raw export rows, the source ZIP path, Spotify account identity, IP addresses, country codes, platform strings, user agents, or raw Spotify URI strings.

Incognito events remain in immutable source history only as sanitized local event evidence and do not contribute to taste rankings.
