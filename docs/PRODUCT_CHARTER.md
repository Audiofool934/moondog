# Moondog Product Charter

## Status

Moondog is a local listening room.
It turns the listening history and library data that a listener supplies into an evidence-based profile.
With a connected model, an agent uses that profile to talk about music, find music, and plan playlists.
It can also control Spotify after the listener connects Spotify.

Moondog has three surfaces:

- The terminal listening room is the main surface.
  It is a local CLI and TUI built on Pi.
- The desktop app in `app/` is a native client on the same core.
  It shares the profile, settings, and sign-ins with the terminal.
- The project page in `site/` runs the real terminal room in the browser on fictional data.

Pi supplies replaceable agent-loop, model, and terminal adapters, while Moondog owns profile, memory, policy, persistence, and connectors.

Moondog has the M0 foundation and a working A1 curator, with bounded A2 memory, A3 external discovery, and A4 connected-action slices in active development.
The provider-neutral contract foundation, private listening-evidence projection, bounded Agent tools, prompt-local external candidates, conversational playlist revision, and guarded Spotify creation and existing-playlist editing exist, but the product contract is not complete.

The current Spotify priority is a smooth conversational listening experience and useful device control.
Bounded track, album, playlist, podcast, and device metadata may be shown to the agent as untrusted data; metadata blindness is not a product goal.
Credential safety, correct action authority, explicit destructive intent, cancellation, and truthful receipts remain required.
Live results are conversation context rather than automatic durable preference assertions.

This document defines the initial product thesis, scope, and milestone sequence.

## Product Thesis

Music services know what was played.
General language models know many facts about music.
Creation models can generate audio.

Moondog should connect these capabilities around one persistent relationship with a listener.
It should understand the musical world, develop an evidence-based model of the individual, and take useful actions with tools.

## User Value

Moondog should help a user:

- Ask informed questions about music and follow paths of curiosity.
- Understand patterns in their own listening without reducing taste to a few genres.
- Discover music with transparent, context-aware reasons.
- Build and refine playlists through conversation.
- Move from listening references and intentions into assisted music creation.

## Capability Layers

### Music World Model

Ground conversations in reliable knowledge about artists, works, recordings, genres, scenes, eras, and musical relationships.

### Personal Music Profile

Turn authorized listening history and explicit feedback into a profile that is temporal, interpretable, revisable, and supported by evidence.

The first-build quality target, set on 2026-10-05, is a useful and reliable reading from the initial import and one requested profile build.
The listener should not need a sequence of manual reviews and rebuilds to correct basic errors before Moondog becomes useful.
The build may perform multiple internal analysis, verification, and repair stages within one user-initiated operation.
Development-time listener review should improve the general builder and provide evaluation evidence, rather than become a required onboarding step.

The target is the quality of a carefully reviewed profile wherever the permitted input supports that quality.
Incomplete platform history and unreported personal circumstances must produce appropriately scoped conclusions, not invented facts.
Preserve useful, supported musical detail while separating persistent observed interests, recent attention, explicit preferences, subjective importance, and listening context.
Neither a recent listening peak nor a play-duration ranking establishes a change in enduring taste.
See the [first-build acceptance target](LISTENER_PROFILE_HARNESS_RESEARCH.md#first-build-quality-target-2026-10-05) for the evaluation boundary.

### Recommendation and Curation

Use both world knowledge and personal context to generate recommendations, explain tradeoffs, and collaborate on playlists.

### Creative Tool Use

Call music analysis, transformation, editing, and generation tools through explicit interfaces with observable inputs and outputs.

## First Vertical Slice

The first useful version should support one user and one bounded workflow:

1. Import or supply a small, user-authorized listening dataset.
2. Build an interpretable profile with evidence and uncertainty.
3. Discuss a listening intent in natural language.
4. Recommend a short set of tracks with specific reasons.
5. Produce a playlist plan that the user can inspect and revise.

Explicit private Spotify playlist writes are now available behind local OAuth and an exact validated plan.

A validated process-local draft can now be reordered, shortened, extended, or selectively replaced in later turns without writing to a provider.
Each successful revision is validated against host-owned candidate sets and replaces the prior pending draft, while a failed or cancelled revision leaves the prior draft intact.

The same planner can now accept a private-history rediscovery set whose tracks passed minimum attention, quiet-window, and active-avoidance checks.
This flow treats historical attention as a reason to revisit rather than a claim of preference, and it remains plan-only unless the listener explicitly requests a provider action.

The planner can also accept a private-history historical-return set whose tracks passed minimum attention, a 180-day gap, and active-avoidance checks.
Only bounded recurrence counts and gap evidence reach the model, while exact provider identity remains inside the host.

The planner can also accept a private-history played-back-to-back set whose tracks passed exact-identity, minimum-duration, skip, adjacency, and active-avoidance checks.
Only bounded burst and sequence evidence reaches the model, while exact provider identity remains inside the host.

The planner can also accept one representative private-history track from each selected Listening Time Machine year.
The selection is deterministic, spans evenly spaced qualifying UTC years, excludes active avoidances, and treats each track as a bounded landmark rather than proof that it defines the listener or the year.
Persistent Spotify-only and ListenBrainz-only profiles can use the rediscovery, historical-return, and Listening Time Machine paths without fabricating Apple library readiness.
Profiles backed by Spotify Extended Streaming History can additionally use the played-back-to-back path because that source supplies the required exact identity and track-stop chronology.

Existing-playlist editing is now available for owned private, non-collaborative Spotify playlists with at most 100 ordinary Spotify tracks.
The model receives only prompt-local opaque playlist and item references.
The first turn produces a complete exact-order preview with no external effect, and only a later explicit confirmation can apply the host-retained draft after a live snapshot preflight.
Public or collaborative playlists, unsupported items, clearing a playlist to zero tracks, playlists above 100 tracks, durable drafts across restarts, publishing, and generated music remain later capabilities.

## Product Principles

### Evidence Before Persona

Moondog should not claim to understand a listener more deeply than its data supports.

### User Control

Users should be able to inspect, correct, reset, export, and revoke personal profile data.
These controls do not make profile inspection or correction a mandatory onboarding step.
A dedicated profile inspection experience remains a possible later product decision; first-build quality takes priority over expanding it.

### Local-First Privacy

Keep raw listening data local by default where technically practical.
Send only the minimum required context to external services.

### Explanations That Matter

Recommendation explanations should identify concrete musical, historical, contextual, or personal reasons.
They should not merely restate metadata or invent emotional certainty.

### Tools With Boundaries

Tool calls should expose permissions, provenance, failures, and generated artifacts.

### Taste Over Volume

A small set of carefully selected recommendations is more valuable than a large undifferentiated feed.

## Milestones

### M0: Product Contract

Choose the first listening-data source, profile schema, knowledge sources, and evaluation tasks, and establish the first client.

Current progress includes the provider-neutral v1 foundation, `LibraryTrackObservation v1`, `ListeningEvent v1`, `ProfileEvidence v2`, synthetic fixtures, strict validation, local semantic conformance tests, and private Apple Music, Spotify, and ListenBrainz importers.

Apple Music Library XML is the first catalog and profile-seed source.

Apple Music Library XML does not provide complete event history.

Spotify Extended Streaming History now supplies lifetime effective listening evidence.

A Spotify-only or ListenBrainz-only persistent import now owns one stable private local subject and can supply profile tools without requiring an Apple library projection.

That same history-only subject now supplies prompt-local rediscovery, historical-return, and Listening Time Machine candidate sets, pure in-memory playlist planning, and host-retained exact Spotify identity when the source provided it.
A Spotify Extended Streaming History subject additionally supplies a played-back-to-back candidate set from adjacent retained same-track plays.

The same temporal projection now reports artists present across at least two retained UTC years including the latest year, plus adjacent-year top-artist turnover over bounded listening-time rankings.
These signals describe retained history and do not assert uninterrupted affinity, discovery, genre breadth, identity, or permanent taste change.

The same projection reports Listening Pulse over continuous UTC calendar months and Listening Seasons over fixed UTC calendar quarters.
They expose bounded aggregate attention, the mix of first-observed and seen-earlier tracks, and within-quarter anchors without retaining raw event sequences or claiming discovery, mood, identity, or life events.

The projection now also reports releases with at least three distinct retained tracks and approximate Spotify Extended History sessions separated by gaps longer than 30 minutes.
It exposes only bounded release labels and aggregate session shape, while per-session timestamps, raw sequences, provider track identities, incognito events, and invasive export metadata remain outside the view.

The same Extended History projection reports played-back-to-back bursts when adjacent retained rows share one resolved track identity, both plays lasted at least 30 seconds, neither is explicitly skipped, and the gap is no longer than 30 minutes.
It exposes only bounded counts, listening time, latest observed date, and music labels, without asserting repeat mode, intention, liking, or preference.

Exact cross-format overlap evidence now joins remaining provisional Account Data plays to a uniquely resolved Extended History track for behavioral aggregation without rewriting stored records, while multi-target mappings remain separate and surface as aggregate withheld-identity coverage.

Official saved ListenBrainz response and submission JSON now provide the first independent portability proof for the Spotify-first listening-event model.
The importer is offline, uses service-resolved `mbid_mapping` recording identity when available, preserves missing played duration as unknown, and excludes usernames, client metadata, tags, URLs, and the raw source payload from persistent records.

Apple catalog retrieval, Wikidata artist identity, and ListenBrainz listening-derived artist adjacency now form the first multi-source grounded discovery layer.

The public catalog CLI now closes the exact-name ambiguity loop by returning allowlisted Apple Music artist pages and accepting one selected page as a numeric catalog identity only after the looked-up artist name matches exactly.
One short-lived cached lookup supplies both artist identity and releases, while mismatched names, non-Apple pages, and conflicting identity hints fail closed without reading a personal profile.

Spotify write resolution now distinguishes recognized live, remastered, edited, and collaboration variants before provider identifiers can enter an action.

Existing Spotify playlist edits now retain playlist IDs, item URIs, and snapshot IDs inside the host, require a complete no-effect preview, and accept only a later confirmation of that exact draft.
The first slice is intentionally limited to owned private non-collaborative playlists of at most 100 ordinary tracks and fails closed on stale snapshots or unsupported items.

Broader cross-catalog identity coverage remains open.

The first client is a local CLI and TUI.

The A1 plan supersedes the earlier requirement to build a complete profile revision layer first.

PF0 now promotes Apple aggregate snapshots into provider-neutral `LibraryTrackObservation v1` records and derives conservative `ProfileEvidence v2` records for a disposable SQLite projection.

This projection supports A1 without claiming that aggregate Play Count proves liking or that one library snapshot is complete listening history.

A listener correction records a direct like or avoid stance for an artist or track as a typed `TasteEvent`.
It changes the next profile projection without changing listening events, and the listener can supersede or retract it.
The agent can also record a correction from the listener's own words in chat, such as "never play this again", after the host checks that the quoted words are in the listener's message.
It never records a correction it inferred from listening behavior.
Corrections cover artists and tracks only.

With a connected model, a requested profile build saves a revisable reading of the evidence.
A cancelled build can resume, and new imports or corrections mark the saved reading for an update.
Each saved finding can be traced to its evidence.

### M1: Music Knowledge Conversation

Build a grounded music exploration experience with citations, source provenance, and an initial evaluation set.

### M2: Personal Profile

Import authorized listening data and produce an inspectable, correctable profile.

### M3: Personalized Discovery

Combine the music world model and personal profile in recommendation and playlist collaboration.

### M4: Creative Tools

Add a stable tool interface and connect the first music analysis or generation capability.

## Initial Non-Goals

- Replacing a full music streaming service.
- Training a frontier music generation model from scratch.
- Building a public social network.
- Automating irreversible actions without explicit user approval.
- Treating one provider's recommendation API as the product.

## Open Decisions

- What profile dimensions are useful without becoming reductive?
- Which knowledge sources can provide reliable identity, release, credit, and relationship data?
- How should each concrete product capability be classified for risk, confirmation, budget, and execution mode?
- How should recommendation and profile quality be evaluated with a small Lab team?
- Which generation model or tool protocol should be integrated first?

## Repository Boundary

Product code, connectors, agent runtime, evaluation, and technical demos belong here.
求索育研 administration, presentations, meeting records, and Lab-wide sharing materials belong in the AI Music Lab integration repository.
