# Moondog Roadmap

Moondog is a local-first personal music agent that shows its work.
This roadmap separates what works today, the next outcomes, and decisions that only the project owner can make.
It is a direction, not a release-date promise.

## North star

A listener can bring authorized music history, understand the evidence behind Moondog's profile, ask for grounded discovery, revise the result, and take an explicit action without giving up control of private source data.

The product should feel useful before a model or music-service connection is required.

## Current scope (2026-10-22)

- The listening room in the terminal is the main product, launched with `npm start` from a checkout or `moondog` when installed.
- The desktop app in [`app/`](../app/README.md) is a native window on the same core, first for the owner's daily use and then for developers.
- The project page in [`site/`](../site/README.md) runs the real room in a browser on fictional data.
- The earlier browser Studio and static showcase were removed on 2026-10-22.
  Git history keeps them for reference.

New listening views, corrections, and discovery interactions must work in the terminal room first.

## Status language

- **Shipped** means the behavior exists on `main` and has direct automated or runtime evidence.
- **Now** means the next outcome, with a bounded acceptance test.
- **Next** means an outcome that depends on the current work.
- **Later** means part of the product thesis but not a current commitment.
- **Owner gate** means work that implementation alone cannot finish.

## Shipped

- [x] Open the listening room in the terminal, with the record sleeve, the profile, the full report, and the agent in one place.
- [x] Import Spotify Account Data and Extended Streaming History ZIPs, recent Spotify plays, an Apple Music Library.xml, a YouTube Music Takeout, Last.fm scrobbles by username, a ListenBrainz listens file, and public QQ Music or NetEase playlists.
  Every import shows what is inside before anything is saved, and importing the same file twice changes nothing.
- [x] Reconcile overlapping Spotify Account Data and Extended History independently of import order, without double-counting plays.
- [x] Project a profile without a model: repeat tracks, enduring and recent artists, the Listening Time Machine, Listening Pulse, Listening Seasons, music that came back, songs played back to back, continuity and change, session shape, and release depth.
  Each view stays descriptive and names what the evidence cannot prove.
- [x] Build a saved profile reading with a connected model through `/profile build`, with a whole-profile check, one repair pass, resumable progress, and `/profile saved` and `/profile explain` after a restart.
- [x] Keep listening measures that a source never recorded unknown, in one shared place, so they never reach the model or the explanations as zeros.
- [x] Like, avoid, and retract artists or tracks without rewriting the original listening history, in the profile or by saying it to the agent in chat.
  An Avoid holds on every play path and every credited artist.
- [x] See how each artist's place in the listening moved across the years: a yearly series and a label such as rising, fading or returning, in the profile dossier, the summary, and the agent's exploration.
- [x] Keep the songs Moondog chose apart from the listener's own attention, show the agent what it suggested before, and name the mix under each set it plays.
  The [listening loop](LISTENING_LOOP.md) records the design and its limits.
- [x] Save the full report or a short recap card as a private page that works offline, with `/taste report`, `moondog taste --html`, or `moondog taste --card`.
- [x] Talk with an agent through Pi, with bounded profile, evidence, library, and playlist tools, memory kept apart from profile evidence, and `/web` research through DeepSeek, Brave Search, or the Codex CLI.
- [x] Play, queue, and build private Spotify playlists after explicit authorization, and edit an existing playlist only after a preview and a later confirmation.
  Without Spotify, play 30-second Apple Music previews.
- [x] Answer an artist's latest released single from public catalogs without a model, with deterministic identity recovery.
- [x] Inspect, export, and recoverably reset local music data through a content-bound confirmation token.
- [x] Update a global install or a clean checkout with `moondog update` and `/update`, on stable and preview channels.
- [x] Reply in ten languages, with screens in five.
- [x] Run the desktop app on the same core: conversations, now playing, up next, settings with in-app sign-in, and a signed and notarized build script.
- [x] Make an instrumental track on this Mac with the listener's own Stable Audio 3, once they turn it on in Settings or with `/generation on`.
  The taste compiler keeps only sound descriptors it can trace to the listener's evidence or the moment, and none that names an artist, a song or an Avoid; the track plays in Moondog's own player, keeps a receipt, and enters the ledger as Moondog's pick.
  This is the first step of [music decentralization](MUSIC_DECENTRALIZATION.md), and the first generation tool connected through an observable, permissioned interface.
  Each made track's plays come back as outcomes (played through, skipped, stopped, asked for again), which the agent reads before it makes the next one; the listener can ask to hear one again.
- [x] Run the real room on fictional data on the project page.
- [x] Run a deterministic offline demo and generate a fictional Spotify history ZIP, with no personal data, model, or credential.
- [x] Rebuild and verify the public source tree on Node 22.19.0 and Node 24 in CI, scan the full history for private material, and install the packed npm tarball into an empty project.

## Now

### First profile build quality

- [ ] Make the first requested profile build useful and reliable without a listener-led correction cycle.
  This is the highest-priority profile outcome.
  Success means a plausible, multidimensional, and internally coherent understanding that supports listening and discovery, with reasonable tolerance for inference error.
  Completion requires fresh-build evidence against the [first-build acceptance target](LISTENER_PROFILE_HARNESS_RESEARCH.md#first-build-quality-target-2026-10-05), with later listener feedback withheld from the builder's input.
  Fictional builds on 2026-10-14 avoided every planted trap once unrecorded measures stayed unknown.
  The remaining known gap was a fading older interest; the dossier now gives each artist its yearly plays and a trajectory label such as fading or returning.
  On 2026-10-25, a fresh DeepSeek Flash build on one fictional ten-year listener named the faded former favourite, the returning and rising artists, and the one-year burst, with no invented preferences.
  One fictional listener and one model is not proof of stable quality.

### Daily use

- [ ] Use the desktop app daily on the owner's Mac and fix what that use finds.
- [ ] Make `moondog doctor` exit non-zero when a required check fails, and describe an empty new install as "no library yet" with import hints instead of a missing Apple Music batch.
- [ ] Fix the Spotify refresh timeout test that failed once on Node 24 in CI ("timeout fences a late response and explicit replacement").
- [ ] Move `fast-uri` past its current security advisory, or move Ajv to a release that does, then rerun contract validation.
- [ ] Replace the `Moondog/0.1 (https://ai.ruc.edu.cn/)` identity on Wikidata and ListenBrainz requests with the project's own contact.

### First-run journey

- [ ] Write a short newcomer journey for the terminal room: install, open, import fictional history, read the profile, make one correction.
- [ ] Run at least three clean-install sessions with people who did not build Moondog, and record the first hesitation, the first success, and every misleading privacy or capability assumption.
- [ ] Turn every repeated failure from those sessions into a product fix or a documented boundary.

## Next

- [ ] Judge a build on the owner's real archive, and fresh fictional builds with more than one model, with the per-artist trajectory now in the profile dossier.
- [ ] Take the next [listening loop](LISTENING_LOOP.md#next-slices) slices in order: the moment as a card, service rule packs, outcome signals, an open descriptor layer, and a taste eval.
- [ ] Add a type boundary at the profile edge, for listening measures, evidence rows, and tool results that reach the agent runtime, without a repository-wide TypeScript migration.
- [ ] Split the terminal room along the screens it already has (sleeve, import, profile, conversation), with identical behavior.
- [ ] Show what each import changed: the dates it covers, when it arrived, and which plays were new, duplicate, or richer replacements.
  The [import experience](IMPORT_EXPERIENCE.md) describes this slice and the recovery slice after it.
- [ ] Decide whether people who only want playback must create their own Spotify developer app.
- [ ] Evaluate recommendation quality with people, then publish the method and aggregate results only.
- [ ] Show album covers where the listener already looks (the sleeve lyric, a recommendation, now playing), as character art by default.
  [Issue #56](https://github.com/Audiofool934/moondog/issues/56) records the prototype's findings, including two search misses that need a test first.

## Later

- [ ] Move beyond streaming-first toward music decentralization: the local personal library, generative music, and an open format for independent artists.
  [Music decentralization](MUSIC_DECENTRALIZATION.md) records the stages; the owner opened stage 2 on 2026-10-29, and its first slice is shipped above.
  An atmosphere stream keeps making tracks for background listening, a new one queued while the last plays, steered away from what the listener skips.
  Next for it are Likes on generated tracks, a listener's replay counted as their attention, and an analysis stack that can score a stream's candidates.
- [ ] Carry listener intent and selected references into creative work without uploading raw history by default.
- [ ] Write a SQLite schema migration path before any release that changes stored data.
- [ ] Decide whether Windows belongs in the product; a port needs a player, paths, and the credential store.

## Owner gates

- [x] Confirm ownership and publication rights for source code, contracts, inherited DJ Claw material, and visual assets (2026-10-06).
- [x] Select the [Apache License 2.0](../LICENSE) (2026-10-06).
- [x] Use [Audiofool934/moondog](https://github.com/Audiofool934/moondog) as the canonical repository.
- [x] Use the Moondog name and the lunar-record visual identity.
- [ ] Publish the current source version to npm: choose the channel, configure npm trusted publishing, and tag the release.
  The npm registry still serves 0.1.0, which predates the updater.
- [ ] Publish a security contact in `SECURITY.md` and a maintainer route.
- [x] Before the next public release that contains local generation, accept the Stability AI Community License for a public product and ship its copy and a Notice file ([Owner gates](MUSIC_DECENTRALIZATION.md#owner-gates)).
  The copy and the `NOTICE` file are in the repository and the package since 2026-10-30; the owner accepted the license by publishing 0.3.0-beta.1, the first release that contains them (2026-10-30).
- [x] Confirm which recent attention may shape a generation prompt, given Spotify's Developer Policy: stored plays, recent-play sync rows included; Spotify's own top artists stay out (2026-10-29, [Owner gates](MUSIC_DECENTRALIZATION.md#owner-gates)).

These decisions are intentionally not inferred from code or local repository state.

## Turning roadmap items into issues

Each unchecked item should become one outcome-shaped issue before implementation begins.
An issue should name the listener problem, the observable user path, the privacy and action boundaries, and the evidence that proves completion.

Bug reports and product ideas should use the [repository issue forms](https://github.com/Audiofool934/moondog/issues/new/choose).
Do not attach Spotify exports, Apple Music Library XML, OAuth credentials, personal Tasteprints, raw local database files, or unsanitized logs to a public issue.

## Supporting documents

- The [Product Charter](PRODUCT_CHARTER.md) defines the long-term thesis and non-goals.
- The [import experience](IMPORT_EXPERIENCE.md) sets the direction and acceptance rules for each music service.
- [Release readiness](PUBLIC_RELEASE_READINESS.md) records the current release status and the checks behind it.
- The [DJ Claw lineage boundary](DJ_CLAW_LINEAGE.md) records which predecessor lessons carry forward.
