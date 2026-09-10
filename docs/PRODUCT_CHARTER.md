# Moondog Product Charter

## Status

As of 2026-09-05, the active product surface is the Pi-based TUI.
GUI and Studio development is paused.
Listening-history review, profile correction, and grounded discovery should be delivered and evaluated in the terminal.
Existing Studio descriptions below record prototype behavior and are not current interface commitments.

Moondog has the M0 foundation and a working A1 curator, with bounded A2 memory, A3 external discovery, and A4 connected-action slices in active development.

The provider-neutral contract foundation, private Apple and Spotify evidence projection, bounded Agent tools, prompt-local external candidates, conversational playlist revision, and guarded Spotify creation and existing-playlist editing exist, but the product contract is not complete.

The first temporal rediscovery loop now turns meaningful older attention into bounded listen-again candidates, gives them a prompt-local private-history scope, and preserves exact provider identity only inside the host.

The first historical-return loop now turns repeated long-gap recurrence into bounded Music that came back evidence and a dedicated prompt-local Agent candidate set.
It excludes active avoidances and treats recurrence as an archive pattern rather than liking, nostalgia, intentional absence, or current preference.

The first played-back-to-back loop now turns adjacent same-track Spotify Extended History plays into bounded sequence evidence and a dedicated prompt-local Agent candidate set.
It requires at least two non-skipped plays of 30 seconds within a 30-minute gap and does not infer repeat mode, intention, liking, or preference.

The first Listening Time Machine now turns qualifying multi-year history into deterministic chronological landmarks, balances selections across the retained year span, prefers different artists where the evidence permits, and works without an Apple Music projection.
Studio now presents that result as the primary qualifying first-run outcome and keeps the deeper correction workbench immediately adjacent.

The first Listening Pulse and Listening Seasons views now preserve the chronology between yearly landmarks through continuous UTC months and deterministic UTC calendar quarters.
They expose bounded aggregate attention, first-observed-versus-seen-earlier track mix, and within-quarter anchors without retaining raw event sequences or claiming discovery, mood, identity, or life events.

The source-checkout Studio now turns one or two explicitly supplied Spotify ZIPs into a complete session-only private profile without dependency installation.
It keeps the archives unchanged, reconciles both export formats in memory, opens no persistent profile store, and discards the profile and corrections when the process stops.

The first continuity-and-change view now distinguishes artists present across retained years from adjacent-year top-artist turnover.
It keeps recurring attention, movement between listening-time leaders, and direct listener preference as separate evidence rather than collapsing them into one persona score.

The first listening-pattern view now distinguishes multi-track release depth from approximate listening-session shape.
It turns album metadata and UTC track-stop gaps into bounded descriptive evidence without claiming full-album completion, attention, mood, routine, location, or intent.

The first client is now a local CLI with a simple TUI.

Pi supplies replaceable agent-loop, model, and terminal adapters, while Moondog owns profile, memory, policy, persistence, and connectors.

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

Current progress includes the provider-neutral v1 foundation, `LibraryTrackObservation v1`, `ListeningEvent v1`, coexisting `ProfileEvidence v1` and `ProfileEvidence v2`, synthetic fixtures, strict validation, local semantic conformance tests, and private Apple Music, Spotify, and ListenBrainz importers.

Apple Music Library XML is the first catalog and profile-seed source.

Apple Music Library XML does not provide complete event history.

Spotify Extended Streaming History now supplies lifetime effective listening evidence.

A Spotify-only or ListenBrainz-only persistent import now owns one stable private local subject and can supply profile tools without requiring an Apple library projection.

That same history-only subject now supplies prompt-local rediscovery, historical-return, and Listening Time Machine candidate sets, pure in-memory playlist planning, and host-retained exact Spotify identity when the source provided it.
A Spotify Extended Streaming History subject additionally supplies a played-back-to-back candidate set from adjacent retained same-track plays.

The same temporal projection now reports artists present across at least two retained UTC years including the latest year, plus adjacent-year top-artist turnover over bounded listening-time rankings.
These signals describe retained history and do not assert uninterrupted affinity, discovery, genre breadth, identity, or permanent taste change.

The projection now also reports releases with at least three distinct retained tracks and approximate Spotify Extended History sessions separated by gaps longer than 30 minutes.
It exposes only bounded release labels and aggregate session shape, while per-session timestamps, raw sequences, provider track identities, incognito events, and invasive export metadata remain outside the view.

The same Extended History projection reports played-back-to-back bursts when adjacent retained rows share one resolved track identity, both plays lasted at least 30 seconds, neither is explicitly skipped, and the gap is no longer than 30 minutes.
It exposes only bounded counts, listening time, latest observed date, and music labels, without asserting repeat mode, intention, liking, or preference.

Exact cross-format overlap evidence now joins remaining provisional Account Data plays to a uniquely resolved Extended History track for behavioral aggregation without rewriting stored records, while multi-target mappings remain separate and surface as aggregate withheld-identity coverage.

Official saved ListenBrainz response and submission JSON now provide the first independent portability proof for the Spotify-first listening-event model.
The importer is offline, uses service-resolved `mbid_mapping` recording identity when available, preserves missing played duration as unknown, and excludes usernames, client metadata, tags, URLs, and the raw source payload from persistent records.

Apple catalog retrieval, Wikidata artist identity, ListenBrainz listening-derived artist adjacency, and a durable live discovery evaluation command now form the first multi-source grounded discovery layer.

The public catalog CLI now closes the exact-name ambiguity loop by returning allowlisted Apple Music artist pages and accepting one selected page as a numeric catalog identity only after the looked-up artist name matches exactly.
One short-lived cached lookup supplies both artist identity and releases, while mismatched names, non-Apple pages, and conflicting identity hints fail closed without reading a personal profile.

A private provider-blind human review contract now covers relevance, serendipity, canonical-recording quality, explanation usefulness, tamper detection, and aggregate-only reporting.

Spotify write resolution now distinguishes recognized live, remastered, edited, and collaboration variants before provider identifiers can enter an action.

Existing Spotify playlist edits now retain playlist IDs, item URIs, and snapshot IDs inside the host, require a complete no-effect preview, and accept only a later confirmation of that exact draft.
The first slice is intentionally limited to owned private non-collaborative playlists of at most 100 ordinary tracks and fails closed on stale snapshots or unsupported items.

Completed independent human ratings, revision-aware profile materialization, and broader cross-catalog identity coverage remain open.

The target interface decision is now a local CLI/TUI.

The A1 plan supersedes the earlier requirement to build a complete profile revision layer first.

PF0 now promotes Apple aggregate snapshots into provider-neutral `LibraryTrackObservation v1` records and derives conservative `ProfileEvidence v2` records for a disposable SQLite projection.

This projection supports A1 without claiming that aggregate Play Count proves liking or that one library snapshot is complete listening history.

The broader profile claim, revision, feedback, correction, and persistence model remains deferred until A1 interaction provides concrete requirements.

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
