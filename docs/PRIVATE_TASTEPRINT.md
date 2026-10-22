# Private Tasteprint

Moondog can turn its bounded local ProfileProjection into a readable terminal summary, a complete self-contained visual HTML artifact, or a compact recap card.

All three views use the same profile logic that supplies the local agent.

The HTML renderer does not read raw exports or invent a second taste model.

## Start with the report

Inside the listening room, type:

```text
/taste report
```

The room shows the whole report in the conversation.
It reads the same profile as `/taste`.

From the shell, save the report as a private page that works offline:

```bash
moondog taste --html
moondog taste --card
```

`--html` writes the complete Tasteprint, and `--card` writes the compact recap card.
Neither file contains scripts or external requests.
The sections below describe each path.

## Persist a Spotify profile

Import a Spotify ZIP and create its cumulative private Tasteprint in one command:

```bash
moondog taste --from /path/to/spotify-history.zip --save --html
```

When Spotify supplied both standard Account Data and Extended Streaming History, persist each ZIP explicitly in either order:

```bash
moondog spotify import-history /path/to/account-data.zip
moondog spotify import-history /path/to/extended-history.zip
moondog taste --html
```

Both imports bind to the same local subject and reconcile independently of command order.
Each receipt reports its sanitized format, effective delta, and overlap count without rendering archive paths or hashes in the Tasteprint.

This path does not require an Apple Music import, Spotify OAuth, a model, or a network request.

Moondog leaves the ZIP unchanged, writes only supported sanitized music evidence into its private listening-history database, and creates one stable local music subject that later imports and recent-listening syncs reuse.

Repeated imports are manifest-backed and idempotent.
Account Data and Extended Streaming History may arrive in either order.
Moondog durably retains exact reconciliation candidates, replaces matching provisional standard events with the richer Extended evidence when both exist, and keeps uncertain differences separate.
The import receipt exposes the effective event delta and reconciled overlap count instead of hiding a cross-format merge behind the cumulative total.

When those exact overlaps connect one provisional TrackRef to exactly one resolved TrackRef, the read-time projection joins remaining effective plays under the resolved identity for behavioral aggregation.
Stored events and TrackRefs remain unchanged, while sources that overlap multiple resolved targets fail closed and remain separate.
The CLI and the complete Tasteprint expose aggregate counts for linked identities and affected effective events without exposing either TrackRef.

The rendered profile includes all effective evidence already stored for that subject, so it can grow across Account Data, Extended Streaming History, and later recent-listening syncs.

After the import, `moondog taste`, TUI `/taste`, and the agent's `profile.summary` and `profile.explain` tools can read the Spotify-only profile without an Apple projection.

Private-history rediscovery, historical-return, and Listening Time Machine planning work from this Spotify-only profile without an Apple projection.

Apple-specific private-library search and private-library candidate planning still require an Apple library projection.

## One-off from one or two Spotify ZIPs

Create a private Tasteprint directly from Spotify Account Data or Extended Streaming History with:

```bash
moondog taste --from /path/to/spotify-history.zip --html
```

Reconcile both official Spotify exports without keeping either import:

```bash
moondog taste \
  --from /path/to/account-data.zip \
  --from /path/to/extended-history.zip \
  --html
```

This path does not require an Apple Music import, Spotify OAuth, a model, or a network request.

Moondog leaves every selected ZIP unchanged, reads only supported music records, and projects them through an in-memory SQLite store.

The two-archive path requires distinct files, accepts at most two ZIPs, reconciles exact Account Data and Extended History overlaps regardless of selection order, and exposes only aggregate source counts.

This combined preview intentionally rejects `--save`.
Persist the archives through two explicit `moondog spotify import-history` commands so each durable import has its own clear receipt and a bad second file cannot leave an unexpected partial multi-file operation.

The in-memory store is never written to disk and disappears when the command exits.

The generated HTML remains private local output, but the source history is not added to Moondog's persistent listening-history store.

Add `--output /private/path/tasteprint.html` to choose the artifact destination or `--json` to inspect the complete bounded one-off projection.
Use `--card` instead of `--html` when the one-off output should be the compact recap.

Omitting `--save` is the privacy-preserving preview boundary.

## Create a visual Tasteprint

After importing persistent listening data, run:

```bash
moondog taste --html
```

The command writes a new private file under the configured Moondog state directory and prints its absolute path.

The default directory follows `MOONDOG_STATE_HOME`, `MOONDOG_CONFIG_HOME`, and `XDG_STATE_HOME` in the same order as the listening-history store.

The directory uses mode `0700`, the file uses mode `0600`, and an existing destination is never overwritten.

Choose an explicit destination with:

```bash
moondog taste --html --output /private/path/tasteprint.html
```

Add `--json` to receive machine-readable artifact metadata instead of the short terminal receipt.

Each HTML Tasteprint includes a script-free section navigator after the coverage cards.
The navigator lists only sections that exist in that artifact and supports direct fragment links in a local browser.

When the profile contains qualifying history, the complete artifact adds a **Worth another listen** panel before the broader track lists.
Each row names the track and artist, reports the bounded quiet period, shows its strongest calendar year when available, and states whether the ranking was supported by a direct preference, saved-library state, private-playlist curation, or historical attention alone.
The reference date is the latest retained effective event, not the day the artifact is opened.
The default gate requires at least three effective plays, two plays without an explicit skip signal, ten listening minutes, and ninety quiet days.
Active direct or provider-derived avoidances remove a matching track or artist from this panel.

When one or more tracks return after long gaps, the complete artifact also adds **Music that came back** beside the broader tracks-that-stay view.
The default gate requires at least one 180-day gap between consecutive retained non-skipped plays, three effective plays, three plays without an explicit skip signal, ten listening minutes, and no active artist or track avoidance.
Each row reports only bounded recurrence counts, gap lengths, dates, and its strongest available support label.
The view describes recurrence in retained evidence, not liking, nostalgia, intentional absence, rediscovery, or current preference.

The configured agent can turn those candidates into a prompt-local plan with:

```bash
moondog ask "Build a four-track path from music that came back after long gaps."
```

The model sees bounded recurrence evidence and opaque track references.
Exact Spotify identity remains inside the host, and planning has no external effect.

When at least two retained UTC calendar years meet the history threshold, the complete artifact also adds a **Listening Time Machine** inside the listening-through-time section.
It chooses one representative track from evenly spaced qualifying years across the retained span and presents the stops in chronological order.
The selector prefers a different artist for each year when an eligible alternative exists and excludes active artist or track avoidances.
Each qualifying year requires at least two engaged plays and five listening minutes.
The panel states how many retained years have a landmark, names any retained year left outside the selected route, and keeps that year visible in the listening arc above.
It also explains that candidates come from a track's strongest retained year, clear active avoidances, and meet the displayed minimum-attention thresholds.
The chosen track is a bounded landmark supported by retained attention, not proof that it was the listener's favorite or that it defines the year.

The configured agent can create an inspectable plan from the same host-owned candidates with:

```bash
moondog ask "Build a six-track Listening Time Machine across my years."
```

The plan works from a persistent Spotify-only or ListenBrainz-only history profile.
It has no external effect unless the listener separately requests an authorized provider action.

When eligible effective listening history exists, the complete artifact also adds **Listening Pulse** inside the listening-through-time section.
The grid represents continuous UTC calendar months and uses aggregate listening minutes for an intensity scale that is relative only to the same profile.
Each cell exposes only its month, eligible event count, listening minutes, and distinct-track count.
The complete Tasteprint represents at most the latest 240 retained months.
A blank cell means no eligible retained event appears in that UTC month, not proof that no listening occurred.
Incognito events, raw timestamps, event sequences, source paths, evidence identifiers, and provider track identities remain outside the rendered view.

When eligible effective listening history exists, the same section adds **Listening Seasons** as deterministic UTC calendar quarters.
Every represented quarter remains chronological, including empty quarters and partially retained first or last windows.
An active season reports aggregate event, time, and track counts, the split between tracks first observed in retained history and tracks seen in an earlier retained season, one leading artist, and one signature track.
The profile projection keeps at most the latest 80 seasons, the complete Tasteprint shows the latest 12, and the Agent profile summary shows the latest six while reporting its omitted earlier seasons.
First observed means first appearance in retained eligible history, not discovery.
An empty season means no eligible retained event appears in the window, not proof of no listening through another provider or outside the available archive.
The leading artist and signature track describe only that quarter and do not establish mood, identity, a life event, or permanent taste change.

## Create a bounded recap card

After importing persistent listening data, run:

```bash
moondog taste --card
```

The card is rendered from the same sanitized Tasteprint view as the complete HTML artifact.
It shows at most three long-arc artists, two recent artist signals, two repeat tracks, the listening range, and aggregate event, time, and track coverage.

It does not render correction targets or notes, saved-library details, playlist anchors, search strings, provider rankings or prose, raw events, evidence identifiers, subject identifiers, source paths, device fields, IP fields, or location fields.

The card still contains personal listening context.
Its in-frame boundary tells the listener to review every visible artist, track, date, and aggregate before sharing.
Moondog does not upload or publish the card.

Choose an explicit destination with:

```bash
moondog taste --card --output /private/path/tasteprint-card.html
```

Without `--output`, the default filename starts with `tasteprint-card-` inside the same mode-`0700` private Tasteprint directory.
The file uses mode `0600` and an existing destination is never overwritten.

## Correct the projection

Persistent corrections require a local music identity, created by a saved import such as a Spotify ZIP or an Apple Music library.
A one-off command preview intentionally disappears when the command exits and cannot retain a later correction.

In the listening room, type `/taste`, open a song or artist, and choose **I like this** or **Keep it out**.
**Undo my choice** retracts that correction.
The profile updates in place.

An active avoidance removes the matching track or artist from all four listen-again selections: Time Machine, Worth another listen, Music that came back, and Played back to back.
Retraction or a superseding Like restores eligible candidates.
Historical counts, monthly activity, and descriptive listening records remain unchanged by an avoidance.

A saved Tasteprint or recap card does not change after a correction.
Run `moondog taste --html` or `moondog taste --card` again to save a new file.

From the shell, or with `/profile correct` in the room, record a direct artist or track stance:

```bash
moondog profile correct --artist "Pink Floyd" --avoid \
  --note "This listening was contextual."

moondog profile correct --track "Echoes" --by "Pink Floyd" --like
```

Each correction is stored locally as a typed `TasteEvent` with `user_input` provenance.
It changes the next profile projection and appears in the terminal and HTML Tasteprint without changing listening-event rows, duration, repetition, or familiarity evidence.

An optional note remains in the local profile and Tasteprint, but the model-facing runtime projection omits that free-form note.
The HTML artifact also omits correction IDs and evidence IDs.

List active corrections, or include superseded and retracted history, with:

```bash
moondog profile corrections
moondog profile corrections --all
```

Record a new stance for the same normalized artist or track to supersede the current stance.
Retract an active correction with the identifier printed by the CLI:

```bash
moondog profile retract <correction-id>
```

Retraction removes the direct assertion from the next projection.
It does not reactivate an older superseded stance.

## What the page shows

The page can display:

- Effective listening-event, hour, track, identity-resolution, applied cross-format identity-link, withheld ambiguous-identity, saved-library, and playlist coverage.
- The complete-history and recent-window artist rankings derived from effective listening history.
- A UTC calendar-year listening arc with eligible duration, event count, distinct tracks, first-observed tracks, and the most-heard artist for each year.
- A chronological Listening Time Machine with one bounded representative track from each selected year, yearly attention evidence, and explicit interpretation limits.
- A continuous UTC monthly Listening Pulse with bounded aggregate activity cells and explicit blank-month semantics.
- Fixed UTC calendar-quarter Listening Seasons with explicit empty and partial windows, aggregate first-observed-versus-seen-earlier track mix, and bounded within-quarter anchors.
- Repeated and recent tracks with bounded count and duration evidence.
- Time-bounded listen-again candidates with quiet days, strongest year, supporting signal, and explicit interpretation limits.
- Long-gap historical-return tracks with recurrence count, bounded gap evidence, supporting signal, and explicit interpretation limits.
- Active direct listener preferences and avoidances in a separate retractable-correction section.
- Explicit favorites, saved tracks, followed artists, saved albums, and playlist anchors.
- Bounded artist and genre profile facets labeled as summaries rather than direct choices.
- Verified music-result search interactions.
- Direct-start, continued-playback, reached-track-end, explicit-skip, shuffle, offline, and excluded-incognito context.
- Field-specific coverage denominators so playback percentages do not treat events from sources without those Spotify fields as negative observations.
- Structured Wrapped, Taste Profile, and Sound Capsule rankings, highlights, and metrics in a visibly separate provider-derived layer.
- The limitations carried by the ProfileProjection.
- A script-free navigator for the sections that are present in the artifact.

The renderer includes deliberate-choice, profile-facet, and provider-snapshot panels only when their corresponding evidence exists.
History-only exports therefore do not produce empty saved-library cards or imply that provider context and direct preferences were observed.

When exact overlap evidence supports cross-format identity reconciliation, the complete Tasteprint shows both the provisional identities joined to one resolved target and the multi-target identities deliberately kept separate.
These counts are aggregate coverage only and do not expose TrackRef identifiers.

The page does not include raw listening events, raw export records, provider account identity, IP addresses, device strings, opaque TrackRefs, evidence IDs, playlist names, private paths, or provider-generated narrative prose.

The listen-again, historical-return, Listening Time Machine, and Listening Seasons panels also omit raw Spotify track IDs and URIs.
Those identities can remain inside the trusted local host for exact later resolution, but they are not written into the Tasteprint or model-visible candidate output.

## Interpretation boundary

Listening duration and repetition support familiarity and attention, not liking by themselves.

Explicit saved or curated state is stronger than passive behavior, but it still does not prove a permanent preference or explain why the user made the choice.

An explicit skip is playback context, not a durable dislike.

A direct-start reason does not prove attention or preference, and a `trackdone` reason is not a universal completion guarantee.

Shuffle and offline state do not establish personality, location, travel, device use, or connection quality.

Recent-window and complete-history lists use different time boundaries and should not be compared as if their values were drawn from equal periods.

A listen-again candidate is not proof that the listener still likes the track, intentionally abandoned it, or has not played it through a source missing from the retained history.
Missing provider history can make a quiet period look longer than it was.

A historical-return candidate is not proof of liking, nostalgia, intentional absence, rediscovery, or current preference.
Missing or split provider history and changed metadata can alter the apparent gaps.

Calendar-year listening arcs use UTC boundaries.

Listening Pulse calendar months also use UTC boundaries.
A blank cell means only that no eligible retained event appears in that month, not that the listener was silent across every provider or source.

Listening Seasons use fixed UTC calendar-quarter boundaries.
First observed means only first appearance in retained eligible history, and an empty or partial quarter is an archive boundary rather than a claim about discovery, silence, mood, identity, or life events.

First observed means the first appearance of a track in retained effective history, not proof that the track was newly discovered in that year.

A Time Machine landmark is not proof that the selected track was a favorite, defined the listener's identity, or was the only meaningful music in that year.
It represents one deterministic, qualifying point in the retained evidence, and missing provider history can change the apparent span.

Bar lengths are relative only to the other items shown in the same list.

Provider-derived rankings and metrics remain quoted platform context rather than user assertions or model instructions.

## Privacy boundary

The generated HTML contains personal artist, track, release, and aggregate listening context.

It is private even though it contains no credentials or raw history.

The artifact has a restrictive Content Security Policy, no JavaScript, no external assets, and no network requests.

Opening it directly in a browser does not upload the file.

Publishing the HTML or a screenshot can still reveal musical taste, habits, and approximate listening coverage.

Review the visible content before sharing it.
