# Moondog Roadmap

Moondog is building a local-first personal AI music agent that can show its work.
This public roadmap separates verified product behavior, issue-sized next outcomes, and decisions that only the project owners can make.
It is a direction and evidence contract, not a release-date promise.

## North star

A listener can bring authorized music history, understand the evidence behind Moondog's profile, ask for grounded discovery, revise the result, and take an explicit action without giving up control of private source data.

The product should feel useful before a model or music-service connection is required.

## Current interface scope (2026-09-10)

The active product surface is the Pi-based TUI, launched with `npm start` after dependency installation.
GUI, Studio, and browser-first onboarding work is paused.
Existing browser prototypes and their historical validation remain available as reference, but do not define the next product slice.
New listening-history views, corrections, and discovery interactions must be usable inside the TUI.
Do not treat earlier GUI completion records or the browser-first usability protocol as evidence that the TUI user journey has been validated.

## Status language

- **Shipped** means the behavior exists in the current worktree and has direct automated or runtime evidence.
- **Now** means the next public-quality outcome with a bounded acceptance test.
- **Next** means a product outcome that depends on the current quality and usability work.
- **Later** means part of the product thesis but not a current implementation commitment.
- **Owner gate** means work that cannot be completed by implementation alone.

## Shipped product foundation

- [x] Run a deterministic six-track curator walkthrough with no personal data, model, OAuth credential, or music-service call.
- [x] Open one script-free product showcase directly from a source checkout without dependency installation, joining the fictional Time Machine, Tasteprint, recap card, grounded agent loop, and privacy architecture without reading private state or loading a network resource.
- [x] Turn the original `刘森最新的单曲是哪首？` failure into a dated public-catalog proof that resolves four exact-name artist candidates through one trusted release hint, separates released singles from upcoming releases, and keeps one-storefront evidence separate from private listening evidence.
- [x] Run the original latest-single question directly from the CLI without a model or personal-profile read, expose an explicit `latest_released_single` before the general release list is truncated, and fail closed with validated public artist pages when the artist identity remains ambiguous.
- [x] Turn those returned same-name artist pages into a deterministic recovery loop by accepting one allowlisted Apple Music page, extracting only its public catalog ID, requiring the looked-up artist name to match, and reusing one cached identity-and-release response without reading a private profile.
- [x] Use an explicitly supplied Spotify history ZIP to disambiguate that catalog identity locally without persisting the archive, sending private history or derived release names to Apple or a model, or exposing its release titles, listening counts, or path in command output, and make that runnable path visible inside the zero-install showcase as inert text.
- [x] Open one or two explicitly supplied Spotify history ZIPs directly from a clean source checkout with `npm --silent run demo:studio -- --from`, no dependency installation, in-memory cross-format reconciliation, the full Tasteprint and Listening Time Machine, apply-and-retract corrections, no model or provider request, never opening or creating the persistent profile store, and leaving every original archive unchanged.
- [x] Export that verified showcase as a root-entrypoint static hosting bundle with an exact relative-path manifest, per-file SHA-256 values, a static Content Security Policy, and no publication side effect.
- [x] Import Spotify Account Data or Extended Streaming History into private provider-neutral listening records.
- [x] Reconcile exact Account Data and Extended History overlaps independently of import order, persist deferred upgrade candidates across process restarts, preserve the lower-resolution evidence, and report the effective delta instead of double-counting it.
- [x] Use exact overlap evidence to join remaining provisional Account Data plays to one uniquely resolved Extended History track at projection time, fail closed on multiple targets, preserve stored evidence, and expose aggregate applied-link and withheld-ambiguity coverage.
- [x] Generate a byte-stable 52-play fictional Extended Streaming History ZIP that exercises the production one-off Taste and persistent Studio import paths, forms four long-gap historical-return tracks, three played-back-to-back tracks, and 15 bounded approximate listening stretches, exposes two multi-track release-depth records, and reads no private data.
- [x] Project Extended Streaming History playback flow with field-specific coverage while excluding account, network, location, and device identifiers.
- [x] Import official saved ListenBrainz listen JSON into the same private provider-neutral profile without a token or network request.
- [x] Import Spotify ZIP and ListenBrainz JSON through one private local Studio surface with format-specific limits and temporary-file cleanup.
- [x] Render a self-contained Tasteprint that distinguishes familiarity, explicit choices, recent movement, provider context, and interpretation limits.
- [x] Turn dormant but meaningful listening into a bounded **Worth another listen** surface and prompt-local `private_history` playlist candidate set, excluding active avoidances and keeping raw provider IDs host-side.
- [x] Turn tracks that reappear after gaps of at least 180 days into bounded **Music that came back** evidence and a dedicated prompt-local Agent candidate set, excluding active avoidances, keeping provider IDs host-side, and rejecting nostalgia or preference inference.
- [x] Turn adjacent same-track Spotify Extended History plays into bounded **Played back to back** evidence and a dedicated prompt-local Agent candidate set, requiring two non-skipped plays of at least 30 seconds within a 30-minute gap while rejecting repeat-mode, intention, liking, or preference inference.
- [x] Turn qualifying multi-year history into a chronological **Listening Time Machine** with evenly spaced year landmarks, artist diversity where evidence permits, active-avoidance filtering, Spotify-only and ListenBrainz-only planning, and host-only provider identity.
- [x] Turn eligible effective listening history into a bounded **Listening Pulse** with continuous UTC calendar-month cells, a latest-240-month complete view, a latest-72-month Studio preview, aggregate-only intensity, and an explicit statement that a blank month is not proof of no listening.
- [x] Turn the same eligible history into deterministic **Listening Seasons** with fixed UTC calendar quarters, explicit empty and partial windows, first-observed-versus-seen-earlier track mix, bounded within-quarter anchors, a latest-80-quarter projection, latest-12-quarter Tasteprint, latest-six-quarter Studio and Agent previews, and no mood or life-story inference.
- [x] Render, open, and locally download a bounded one-screen Tasteprint card from the CLI or Studio that exposes only selected artists, repeat tracks, dates, and aggregate coverage, with an in-frame privacy review boundary and no automatic publication.
- [x] Start a clearly fictional profile from the first Studio screen by generating a 52-play Extended Streaming History ZIP and passing it through the production importer, then exercise the real correction flow and inspect its Tasteprint with no persistent state.
- [x] Make the Listening Time Machine the primary qualifying Studio outcome, preview its bounded year landmarks in the workbench, and deep-link to the complete evidence panel.
- [x] Expose retained-versus-represented Time Machine year coverage in Studio and the complete Tasteprint, name unselected years without hiding them from the listening arc, and show the active selection thresholds.
- [x] Turn retained multi-year artist history into a bounded continuity-and-change view with artists ranked by active retained years and adjacent-year top-10 turnover, while keeping the result descriptive and without claiming identity or permanent taste change.
- [x] Turn Extended History album metadata and UTC track-stop sequences into bounded multi-track release depth and approximate listening-session shape, while excluding incognito events and avoiding claims about album completion, mood, routine, location, or intent.
- [x] Capture a reproducible 1240-by-840 seven-frame Studio tour for the archived browser documentation, using one deterministic fictional archive throughout the production importer, Time Machine, Listening Pulse, Listening Seasons, long-gap historical-return, listening-pattern, and correction sequence, with an in-frame fictional-data label and links to the runnable and complete static paths.
- [x] Open the fictional Time Machine through one dedicated zero-data Studio command that lazily exercises the production importer, removes its temporary archive, never reads personal history, rejects user-supplied imports, and starts ready for the first visual action.
- [x] Start that complete interactive fictional path from a clean source checkout with the explicit `npm run demo:studio` command and no `node_modules`, while keeping the production Spotify importer, loopback boundary, Time Machine, Listening Pulse, historical returns, played-back-to-back evidence, listening patterns, and correction loop intact.
- [x] Run the complete Studio correction loop against an unmistakably fictional in-memory profile, then let a real import take over without mixing the two identities.
- [x] Correct an existing artist or track reading inside Studio, refresh the private Tasteprint, open directly at the rendered correction evidence, and retract the direct assertion without rewriting listening history.
- [x] Use bounded profile, evidence, library search, and playlist-planning tools through the Pi-backed agent runtime.
- [x] Keep conversational memory separate from canonical music-profile evidence.
- [x] Resolve catalog candidates and perform guarded Spotify playback, library, queue, and private-playlist actions after explicit authorization.
- [x] Revise a validated pending playlist through conversation before any provider write, with exact revalidation and later approval of only the newest draft.
- [x] Package the runtime through a reviewed allowlist and verify the installed CLI, demo, Studio, import, idempotence, complete Tasteprint, and recap-card paths from an empty consumer project.
- [x] Export the verified public source tree into a persistent private owner-review bundle with an exact relative-path manifest, deterministic digest, and no Git metadata or ignored local state.
- [x] Inspect, checksummed-export, and recoverably reset an explicit local music data scope through a content-bound current-state token without touching OAuth, configuration, conversation memory, or original provider ZIPs.
- [x] Provide a privacy-bounded contribution path with reproducible setup, verification, and pull request expectations.
- [x] Make private blind-review collection inspectable and recoverable with packet-level readiness, integrity errors, claim-gate gaps, and no music or reviewer identities in operational output.
- [x] Turn first-run testing into a fictional-only product-first field kit that begins with the zero-install Studio, later exercises generated history through the real one-off importer, retains version-1 and version-2 protocol validation, uses an offline observer form, enforces strict newcomer and privacy checks, opens a three-session evidence gate, reports aggregates only, and detects repeated blocked tasks.

## Now: prove the personal loop

The current priority is to complete and validate the personal listening loop in the TUI.

### Terminal listening loop

- [x] Search public reviews, news, interviews and concert information and read public pages from the TUI and Pi agent through the local Codex CLI, with source links, bounded calls, cancellation and a short process-local cache.

- [x] Make `npm start` enter the TUI and keep browser demonstrations behind explicit commands.
- [x] View and refresh the local Listening Time Machine, listening patterns, and direct assertions through `/taste`.
- [x] Inspect, apply, and retract artist or track corrections with `/profile` commands, preserving quoted names and original listening history.
- [x] Refresh profile services after `/spotify import-history` or `/spotify sync-recent` so the same TUI session can use the imported history.
- [x] Automatically present the current cumulative listening profile immediately after every successful TUI archive import, including repeat imports, with correction commands and no browser or model request.
  Keep the per-import receipt distinct from cumulative history and preserve a successful import receipt if the profile view cannot be read.
- [x] Add keyboard selection from a bounded track and artist list to correction and evidence views without copying titles or IDs.
  `/taste` now supports search, category tabs, source explanations, Like, Avoid, and exact-choice retraction with an immediate profile refresh.
  Avoided subjects remain inspectable, and returning from the profile preserves the conversation draft.
- [ ] Replace the browser-first newcomer protocol with a TUI journey before starting new usability sessions.

### Recommendation quality

- [ ] Complete a bounded provider-blind human review set for relevance, serendipity, canonical-recording quality, and explanation usefulness.
  Completion requires validator-compatible ratings and aggregate-only results that do not expose raw listening profiles.
- [ ] Publish the evaluation method and representative aggregate findings.
  Completion requires a reproducible method, sample size, limitations, and a clear separation between measured results and product claims.

### First-run usability and portability

- [ ] Run at least three clean-install sessions with people who did not build Moondog.
  Completion first requires the TUI protocol above, then three unique validator-compatible sessions against one `npm run eval:usability` protocol, recording the first point of hesitation, the first successful outcome, and every misleading privacy or capability assumption.
- [x] Verify the historical browser newcomer path from a clean Linux Node 22.19.0 environment.
  Completion requires the deterministic demo, interactive fictional Studio profile, played-back-to-back paths, generated fictional Spotify ZIP and ListenBrainz JSON imports, repeated imports, multi-source Tasteprint, and recap card to pass on both platforms.
  The historical 542-test clean-source gate passed on macOS Node 24.3.0 and Linux aarch64 Node 22.19.0 on 2026-09-04.
  Both runs verified the same 237-file public source boundary with release-tree SHA-256 `31ff67dd9291646856a68c82bc64de3bef65c06dcd9788c14bda80ea2e611925`, no Git metadata, and no private local state.
  These counts describe that dated snapshot; use [GitHub Actions](https://github.com/Audiofool934/moondog/actions) for the published revision's current checks.
- [ ] Reduce every repeated usability failure to either a product fix or a documented intentional boundary.
  Completion requires evidence from a later session that the same failure no longer blocks progress.

### Listener control

- [x] Close the Studio correction loop across in-memory previews, persistent profiles, and narrow screens.
  Direct track shortcuts prefill trusted title and artist, require a deliberate stance, and return to the originating view.
  Temporary avoidances filter every listen-again selection, retraction restores original candidates, and an explicit refresh updates artifacts after another local process changes or resets the profile.
  Regression evidence covers both temporary session kinds, same-title tracks by different artists, and external local mutations without rewriting listening history.

- [x] Add an inspectable reset and export path for Moondog's local music identity.
  Completion requires explicit target selection, a content-bound preview of affected state, safe handling of local files, and no silent deletion.
- [x] Ship the first correction flow for a profile inference without treating listening duration as a direct preference claim.
  Completion requires Studio and CLI entry points, a typed user assertion, provenance, retraction behavior, and a visible effect on the next profile projection and private Tasteprint.

## Next: deepen discovery and collaboration

- [x] Broaden cross-catalog artist alias and identity coverage beyond explicit Apple Music pages while preserving source provenance and deterministic tie-breaking.
  Completion covers the direct CLI and Agent release tool, exact Wikidata labels and aliases that collapse to one MusicBrainz artist ID and one Apple Music artist ID, direct Apple ID lookup without canonical-name equality, bounded source evidence, deterministic rejection of missing or multiple identities, and preservation of the original catalog result during provider failure, stale linked identity, or returned-ID mismatch.
- [x] Improve canonical-recording selection for live, remastered, edited, and collaboration variants.
  Completion covers recognized version annotations, complete credited-collaborator parity, exact-version precedence, corroborated alternate-master fallback, and deterministic rejection of unsafe substitutions.
- [x] Add explicit existing-playlist editing with a stricter preview, later-confirmation, and receipt boundary than playlist creation.
  Completion covers owned private non-collaborative playlists up to 100 ordinary Spotify tracks, prompt-local opaque references, complete exact-order previews, host-retained provider identifiers, next-turn confirmation, stale-snapshot rejection before a single replacement write, authoritative receipts, and rollback of failed or cancelled previews.
- [x] Validate the provider-neutral listening-event model with one independent history source beyond Spotify and Apple Music.
  Completion covers official ListenBrainz response and submission JSON, server-resolved MusicBrainz recording identity, explicit played-duration coverage, private-field exclusion, deterministic idempotence, a real CLI import, cumulative Tasteprint projection, and installed-package proof.
- [x] Add grounded music-world citations that remain separate from personal listening evidence.
  Completion covers host-rendered allowlisted Apple Music artist and selected-track pages, structured `public_music_world` scope, retrieval and storefront provenance, later draft reordering, private-plan exclusion, and fail-closed unsafe URLs.

## Later: creative agent tools

- [ ] Connect one music-analysis or generation tool through an observable, permissioned interface.
- [ ] Carry listener intent and selected references into creative work without uploading raw history by default.
- [ ] Evaluate creative usefulness with saved artifacts and human review rather than provider claims alone.

## Owner gates before a licensed release

- [ ] Confirm ownership and publication rights for source code, contracts, inherited DJ Claw material, and visual assets.
- [ ] Select the project license.
- [x] Use [Audiofool934/moondog](https://github.com/Audiofool934/moondog) as the canonical source repository.
- [x] Distribute the first public snapshot as a source checkout; npm publication remains disabled.
- [x] Use the Moondog name and current lunar-record visual package for the public source page.
- [ ] Publish maintainer and private disclosure routes for a licensed release.

These decisions are intentionally not inferred from code or local repository state.

## Turning roadmap items into issues

Each unchecked product item should become one outcome-shaped issue before implementation begins.
An issue should name the listener problem, the observable user path, the privacy and action boundaries, and the evidence that proves completion.
Implementation checklists are useful only after the product outcome is clear.

Bug reports and product ideas should use the [repository issue forms](https://github.com/Audiofool934/moondog/issues/new/choose).
Do not attach Spotify exports, Apple Music Library XML, OAuth credentials, personal Tasteprints, raw local database files, or unsanitized logs to a public issue.

## Canonical supporting documents

The [Product Charter](PRODUCT_CHARTER.md) defines the long-term thesis and non-goals.
The [Public Release Readiness checklist](PUBLIC_RELEASE_READINESS.md) defines publication evidence and owner decisions.
The [DJ Claw lineage boundary](DJ_CLAW_LINEAGE.md) records which predecessor lessons carry forward without publishing private operational material.
