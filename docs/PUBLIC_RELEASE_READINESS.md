# Public source status

Updated 2026-09-10.

The canonical repository is [Audiofool934/moondog](https://github.com/Audiofool934/moondog).
The current distribution is a source checkout with Node.js 22.19.0 or newer and locked npm dependencies.
The active product is the Pi-based TUI, with local listening-history import, interactive profile evidence and correction, fresh conversations, and explicit `/resume`.
GUI and Studio work is paused; the existing browser demos remain reference material.

## Source publication

The first public source snapshot starts with a new Git history.
It excludes the four internal predecessor and operational documents, imported data, local databases, model credentials, generated runs, and private verification output.
The original working files and private history remain local.
The release-tree verifier checks the exported allowlist and content markers; this is a bounded publication check, not a security audit.
Run `npm run verify:release-tree` to inspect that boundary directly.

The source is public, but no project license has been selected and no open-source license is granted yet.
`package.json` remains `private: true`; this publication does not publish an npm package.
Maintainer and contribution information is linked from [CONTRIBUTING.md](../CONTRIBUTING.md).

## Validation and limits

Run `npm run verify:clean-source` to rebuild an isolated source copy, install the lockfile, verify public artifacts and contracts, and run the full test suite.
Use [GitHub Actions](https://github.com/Audiofool934/moondog/actions/workflows/ci.yml) for hosted CI status on the published commit.
A local pass is not evidence of a successful hosted run.

The README terminal images show actual Pi output with fictional listening history, not a personal account or a live service demonstration.
Local profile checks do not establish live provider availability, native-terminal behavior on every platform, recommendation quality, or newcomer usability.
The [roadmap](ROADMAP.md) retains the human evaluation and TUI usability work still to be done.
Dated [verification records](verification/) preserve earlier local evidence and its limitations.
The [Linux Node 22.19.0 record](verification/linux-node-22.19.0.json) describes the historical 2026-09-04 snapshot, not the current published commit.

## Historical preparation record

The material below records preparation before the first public source push.
Its past repository status, numerical test counts, browser-first workflows, and unchecked owner decisions are historical context, not current release claims.
The current product surface and publication status are stated above.

This checklist separates a compelling local product from a repository that is safe and credible to publish.

Passing it does not guarantee GitHub growth, but failing a required gate means Moondog is not ready for a public launch.

### Current evidence

- The zero-auth `npm run demo` path exercises profile summary, evidence explanation, library search, and host-validated playlist planning with synthetic data.
- `npm run showcase` now opens directly from a source checkout without `node_modules` through a read-only `127.0.0.1` server whose exact seven-file allowlist contains the fictional Time Machine, Tasteprint, recap card, grounded walkthrough, approved brand asset, and one inert dated public-catalog proof, with no scripts, analytics, private store, public binding, or runtime external request.
- A live read-only Apple Music US probe on 2026-09-03 resolved the intended `刘森` identity from four exact-name candidates through one trusted release hint and returned 《天长地久》, dated 2026-05-09, as the newest already released single while retaining the retrieval-date and one-storefront limitation.
- `moondog catalog latest-single` now reproduces that question through a live public Apple Music US lookup without a model or personal-profile read, computes the explicit latest released single before the bounded general-release list is truncated, makes no provider write, and responds to unresolved same-name ambiguity with validated public artist pages instead of guessing.
- A second live read-only probe on 2026-09-03 began with the ambiguous public name `Hikki`, resolved one exact Wikidata alias through MusicBrainz artist `b539e453-c4fe-47e3-8a07-8517eac74429` and Apple Music artist `18756224`, then returned Hikaru Utada and the dated newest already released single from a direct Apple ID lookup without a model, private-profile read, or provider write.
- The automatic alias path records its Wikidata label-or-alias method, P434 and P2850 properties, canonical name, Wikidata item, MusicBrainz identity, Apple identity, license, and selection basis, while missing or multiple identities, provider failure, or a stale linked Apple ID retain the original Apple result and explicitly refuse to guess.
- The direct CLI and `moondog_music_artist_releases` Agent tool now share that identity recovery, the Pi boundary independently validates every projected identity field, and a host-derived private release hint is omitted from model-visible catalog results.
- `moondog catalog latest-single --artist-page <Apple Music artist URL>` now consumes one of those returned pages as an explicit public identity, extracts only the numeric catalog ID, validates the looked-up name against the requested artist, reuses one cached identity-and-release lookup, and fails closed on a mismatched or non-Apple page.
- `moondog catalog latest-single --from <spotify-history.zip>` now derives up to three in-memory exact-artist release hints from an explicitly supplied Account Data or Extended History ZIP, never persists the archive, never sends or renders the private hint, listening counts, or source path, and the zero-install showcase presents the exact runnable command as inert text while remaining unable to read a ZIP.
- `npm run export:showcase -- --output <absolute-path>` now converts the same allowlist into a host-ready root `index.html` and public asset tree, applies a static Content Security Policy, emits byte counts and per-file SHA-256 values, refuses existing destinations, and performs no publication.
- `moondog taste --html` now turns the same bounded local ProfileProjection into a self-contained visual artifact with no scripts, external assets, or network requests.
- `moondog taste --card` now renders a one-screen local recap from the same sanitized view, limits the visible personal surface to bounded artists, repeat tracks, dates, and aggregates, omits direct correction details and secondary profile fields, and requires in-frame review before sharing.
- `moondog taste --from <spotify-history.zip> --html` now provides a Spotify-only first-run path through in-memory projection without Apple setup, OAuth, a model, persistent import, or network access, while one repeated `--from` reconciles standard Account Data and Extended Streaming History under the same temporary identity independently of argument order.
- `npm --silent run demo:studio -- --from <spotify-history.zip>` now opens a session-only private Tasteprint, Listening Time Machine, monthly Listening Pulse, fixed-quarter Listening Seasons, Music that came back, Played back to back, continuity-and-change map, approximate listening-session shape, and multi-track release-depth view directly from a clean source checkout without dependency installation, while a second `--from` reconciles both Spotify exports in the same in-memory profile.
- The one- or two-archive Studio session supports in-memory apply-and-retract corrections, never opens or creates the persistent listening-history store, makes no model, provider, cloud, or network request, withholds source paths, archive hashes, and private provider IDs, enforces a combined size limit, and leaves every original archive's bytes and modification time unchanged.
- `moondog demo-history --output <absolute-file.zip>` now creates a deterministic 52-play fictional Extended Streaming History archive with four calendar years, a 36-month Listening Pulse containing 15 active retained months, 13 fixed UTC calendar quarters containing 12 active Listening Seasons, four long-gap return tracks, three played-back-to-back tracks, 15 approximate listening stretches, two multi-track release-depth records, synthetic Spotify-shaped identifiers, no direct account or device fields, mode-`0600` output, and no private read, network request, provider action, or persistent profile write.
- `moondog taste --from <spotify-history.zip> --save --html` now provides the parallel explicit persistence path, binds one private local music subject, and leaves `profile.summary` and `profile.explain` usable without an Apple projection.
- `moondog listenbrainz import-history <listen-history.json>` now accepts official saved response or submission JSON offline, preserves server-resolved recording identity and explicit played-duration coverage, excludes direct identifiers and noisy client fields, and enables the same cumulative profile without Apple or Spotify setup.
- `moondog studio` now imports Spotify ZIP or ListenBrainz JSON through the same session-token-protected `127.0.0.1` drag-and-drop surface, removes its private temporary source copy after import, recognizes an existing multi-source profile on startup, makes a qualifying Listening Time Machine the primary visual result, previews the latest six fixed-quarter Listening Seasons, provides visual create and retract controls for direct listener corrections, and exposes both the current compact recap card and complete Tasteprint plus a token-protected portable-card download.
- Studio now starts its interactive synthetic Time Machine from the first-screen no-data action by creating the deterministic 52-play archive, passing it through the production Spotify importer, deleting the temporary ZIP, and exposing bounded proof of that path before the correction form.
- Studio and the complete Tasteprint now show retained-versus-represented Time Machine year coverage, name years that remain in the listening arc without a selected landmark, and expose the strongest-year, active-avoidance, and minimum-attention rules beside the route.
- Studio and the complete Tasteprint now expose **Listening Pulse** as continuous UTC calendar-month aggregate cells, with a latest-72-month Studio preview and latest-240-month complete view, while a blank month is explicitly not proof of no listening and raw timestamps, event sequences, source paths, evidence IDs, and provider identities remain excluded.
- Studio, the complete Tasteprint, the CLI, and the Agent profile summary now expose **Listening Seasons** as deterministic UTC calendar quarters with explicit empty and partial windows, first-observed-versus-seen-earlier track mix, and bounded leading-artist and signature-track anchors.
- The projection keeps at most the latest 80 quarters, Tasteprint shows the latest 12, Studio and Agent show the latest six, every surface reports its omissions, and raw timestamps, TrackRefs, evidence IDs, provider identities, mood claims, and life-story claims remain excluded.
- Studio and the complete Tasteprint now expose **Music that came back** for tracks that clear minimum attention and reappear after at least one 180-day gap, while the dedicated Agent tool uses prompt-local candidates, keeps provider IDs host-side, excludes active avoidances, and rejects nostalgia or preference inference.
- Studio and the complete Tasteprint now expose **Played back to back** for adjacent same-track Extended History plays that clear the 30-second, non-skipped, and 30-minute-gap thresholds, while the dedicated Agent tool keeps provider IDs host-side and rejects repeat-mode, intention, liking, or preference inference.
- Studio and the complete Tasteprint now expose a continuity-and-change map with **Artists across eras** and year-to-year top-artist turnover, bounded relationship names and transition counts, explicit interpretation limits, and with no source path or provider identity in the Studio API.
- Studio and the complete Tasteprint now expose **Approximate sessions** and **Records explored in depth**, using a 30-minute gap over eligible Extended History track-stop timestamps and at least three distinct tracks per artist-release pair, while withholding raw sequences and rejecting claims about album completion, mood, routine, location, or intent.
- `npm run demo:studio` now opens that production-importer result directly from a clean source checkout without dependency installation, while `moondog studio --demo` provides the installed-package equivalent; both use the dedicated zero-data tour, never open the private history store, reject user-supplied history imports, permit only in-memory demo corrections, and retain the same loopback and session-token boundary.
- `npm run generate:studio-tour` now captures the same in-memory profile as a seven-frame 1240-by-840 README tour spanning the first screen, Time Machine, Listening Pulse, Listening Seasons, long-gap historical returns, listening patterns, and one retractable correction, with no private store or provider request and an exact structural media verifier.
- The deterministic demo now ends with a structured, bounded path into private Studio instead of leaving the user at a terminal boundary report.
- A concise public roadmap now separates verified behavior, issue-sized product outcomes, and owner-only release gates, while privacy-aware issue forms reject raw listening data and credentials by design.
- A contribution guide and pull request template now turn listener outcomes, privacy boundaries, focused evidence, visual checks, and the complete verification gate into one review contract.
- `npm run verify:community` now parses the issue-form YAML and verifies contribution guidance, the pull request checklist, required fields, private-data confirmations, disabled blank issues, roadmap structure, README navigation, and release-readiness evidence.
- `npm run verify:release-tree` now checks every Git-visible release file and every blob reachable from public branch, tag, or remote refs for unsafe paths, common credential markers, private-network addresses, symbolic links, dangerous file types, and bounded release size.
- `npm run verify:clean-source` now copies only that verified manifest into a private temporary directory without Git metadata or ignored local state, installs the exact lockfile, reruns the full gate, and removes the snapshot afterward.
- Each Ubuntu CI matrix entry now invokes that clean-source proof on Node 22.19.0 and Node 24.x, so the configured workflow tests the reviewed public tree rather than a dependency-bearing checkout.
- On 2026-09-04, the current clean public-source boundary passed 542 tests on macOS Node 24.3.0 with npm 11.7.0 and Linux aarch64 Node 22.19.0 with npm 11.16.0, including the dependency-free one- and two-ZIP private Studio entrypoints, shared CLI, two-archive in-memory reconciliation, application, Pi-agent path, Listening Pulse, Listening Seasons, Played back to back path, and all static product proofs.
- Both runs verified the same 237-file release tree with SHA-256 `31ff67dd9291646856a68c82bc64de3bef65c06dcd9788c14bda80ea2e611925`, no Git metadata, no private local state, and 542 passes with zero failures, cancellations, skips, or todo items.
- The Linux proof used the official `node:22.19.0-bookworm-slim` image bound to manifest digest `sha256:4a4884e8a44826194dff92ba316264f392056cbe243dcc9fd3551e71cea02b90`, installed the declared npm version and exact lockfile in a fresh container, and is preserved in a [machine-readable verification record](verification/linux-node-22.19.0.json); this remains pre-publication evidence rather than a canonical GitHub Actions run.
- `npm run export:public-source -- --output <absolute-path>` now creates a persistent private owner-review bundle with an exact source tree and a relative-path audit manifest containing modes, byte counts, per-file SHA-256 values, and the release-tree digest.
- The public-source exporter refuses existing destinations, preserves executable modes, reruns release-tree verification against the copy, includes no Git metadata or ignored local state, and records that it performed no publication or license decision.
- Four legacy planning and provenance documents containing private operational details or measurements from personal data are now excluded from the intended release tree while remaining preserved on the local filesystem.
- A concise public DJ Claw lineage document replaces links to private predecessor infrastructure, source hashes, and runtime risk notes.
- The installable runtime now uses an explicit reviewed file allowlist, moves schema validation dependencies into the runtime dependency set, declares its current macOS/Linux platform boundary, and excludes tests, CI, evaluation-only source, internal roadmap documents, large demo media, raw data, and local state from `npm pack`.
- `npm run verify:package` now packs the private package, installs its tarball into an empty consumer project through an isolated temporary npm cache, and verifies the installed CLI including its no-model exact-Wikidata-alias help path, fictional history generation, one- and two-archive in-memory Taste paths, six-track demo, Studio startup, one- and two-archive no-state Studio sessions, a no-state production-importer fictional correction loop, Extended-first cross-format Spotify reconciliation, fail-closed cross-format track linking with an identity coverage ledger, idempotent repeated Spotify and ListenBrainz imports, a multi-source private Tasteprint, a privacy-bounded recap card, temporary-upload cleanup, a visible retractable listener correction, read-only data inspection, checksummed export, and recoverable reset.
- `moondog data inspect|export|reset` now gives the listener explicit `listening`, `apple`, and combined `profile` scopes, binds reset to a current path-, mode-, size-, and SHA-256-content inspection token, fails closed on subject conflicts or busy state, and archives without deletion while leaving OAuth, configuration, conversation memory, and original ZIPs outside its scope.
- `moondog profile correct|corrections|retract` now records a typed direct artist or track assertion with user-input provenance, supersession, retraction, and an immediate visible effect on the next CLI, HTML Tasteprint, and agent profile projection without rewriting listening history.
- The 1240-by-840 public Tasteprint previews now use only one deterministic fictional profile, carry in-frame synthetic labels, link to their exact generated HTML sources, and exercise the complete lifetime Listening Arc, Listening Time Machine, Listening Pulse, Listening Seasons, listening-pattern view, and one-screen recap-card renderer.
- Every HTML Tasteprint now includes a script-free navigator whose links match only the sections present in that artifact.
- The complete Tasteprint now renders a **Worth another listen** panel from minimum attention and quiet-window thresholds measured against the latest retained event, excludes active avoidances, and labels each candidate as a bounded prompt rather than proof of liking.
- The agent can now register those results as a prompt-local `private_history` candidate set, validate an ordered plan with no provider effect, and resolve trusted Extended Streaming History recordings by host-retained Spotify ID without catalog search or model exposure.
- The real CLI/TUI, local Tasteprint, Apple, Spotify, and ListenBrainz importers, grounded catalog discovery, guarded Spotify actions, local memory, and discovery evaluator exist in the current worktree.
- A pending validated playlist can now be reordered, reduced, selectively replaced, or extended across turns without a provider write, and later approval resolves and writes only the newest exact draft.
- Artist-release answers now use a host-side exact-artist library hint when needed for catalog disambiguation, and those answers plus selected Apple catalog tracks carry host-rendered allowlisted links in a separate `music_world_citations` result with retrieval and storefront provenance that cannot be promoted into personal listening evidence.
- Automated tests and contract validation cover the current provider-neutral behavior.
- A least-privilege GitHub Actions workflow now runs the public demo verifier, contract validation, and complete tests on Node `22.19.0` and `24.x` with the declared npm version.
- The same 542-test gate passed locally on Node 24 and in an isolated Linux source copy on Node 22.19.0 with a clean locked dependency install and identical release-tree digest.
- A private provider-blind human review contract now validates bounded 1-to-5 ratings, detects recommendation-content changes, and exports aggregate-only provider statistics.
- Packet creation now emits a self-contained, no-network local review form that downloads validator-compatible JSON without exposing provider or model identity.
- A privacy-safe review status command now inventories packet readiness, validates completed-review operations, and reports provider-level reviewer and rating gaps without printing music titles, reviewer IDs, profile details, or absolute paths.
- A valid blind packet can now regenerate its browser review form without rerunning discovery or changing the packet digest.
- The first real four-recommendation review packet includes bounded provider-neutral Extended History profile anchors and remains intentionally unscored under the ignored `runs/` directory.
- `npm run eval:usability` now creates a versioned eight-task newcomer protocol that starts with the zero-install interactive product and later includes generated fictional history through the real one-off importer, renders a self-contained no-network observer form, preserves version-1 and version-2 protocol validation, inventories collection readiness without participant identifiers or notes, and exports aggregate-only task rates and bounded misunderstanding categories.
- The version-3 first-run field kit puts the zero-install interactive outcome before complete CLI setup, prohibits personal music data, provider credentials, provider actions, and publication during sessions, preserves version-1 and version-2 validation, requires unique independent non-builder participants, opens its evidence gate only at three valid sessions against one protocol, and identifies any task blocked in two or more sessions for later remediation.
- A 10-second, 1240-by-840 README recording now shows the actual zero-auth demo and remains below 3 MiB.
- The recording tape and complete verification gate passed after a locked install in an isolated source copy without Git metadata, private imports, generated runs, or local databases.
- The repository still has no configured Git remote, public CI run evidence, selected project license, security policy, or code of conduct.
- The current local Git history still contains internal operational material, so a public launch must begin from the verified clean snapshot or use a separately approved history rewrite.
- `package.json` remains private, so npm publication is intentionally disabled.

### Required owner decisions

- [ ] Confirm the legal owner or owners of the existing source, contracts, visual assets, and inherited DJ Claw material.
- [ ] Select an open-source license and add the corresponding `LICENSE` file.
- [ ] Decide whether the first distribution is source checkout, npm package, standalone binary, or more than one of these.
- [ ] Choose the canonical GitHub organization, repository name, public URL, and maintainer contacts.
- [ ] Approve the public product name and the current lunar-record visual package.

These decisions must not be inferred from implementation details or made implicitly during a push.

### Repository gates

- [ ] Review the complete tracked history and intended release tree for credentials, private paths, personal data, private server references, and assets without confirmed publication rights.
- [x] Confirm through an executable Git ignore contract that generated runs, local databases, imported listening history, OAuth files, and raw exports remain ignored.
- [x] Add Ubuntu CI that rebuilds the reviewed public source tree, installs its exact lockfile, validates contracts, runs all tests, and executes the offline showcase on the minimum Node line and current Node line.
- [x] Constrain the installable package to a reviewed runtime allowlist and verify the packed artifact from an empty consumer project.
- [x] Create a persistent owner-reviewable public-source snapshot with an exact relative-path manifest, deterministic tree digest, no Git metadata, and no ignored local state.
- [ ] Run the workflow on the canonical GitHub remote and record successful checks for both matrix entries.
- [x] Add a contribution guide and pull request template with executable setup, verification, and private-data boundaries.
- [ ] Add `CODE_OF_CONDUCT.md` and `SECURITY.md` with real maintainer and disclosure routes.
- [x] Add an issue-ready public product roadmap that keeps owner gates separate from implementation work.
- [x] Add structured bug and product-idea forms with explicit private-data boundaries.
- [x] Classify internal operational notes and keep private predecessor infrastructure, source hashes, personal-data measurements, and superseded internal sequencing outside the release tree.
- [ ] Verify every README command from a clean checkout on macOS and one additional supported platform.
- [ ] Decide whether `private: true` remains appropriate or whether npm publication metadata should be added.

### Product proof gates

- [x] A newcomer can run a meaningful deterministic product walkthrough without personal data, OAuth, a model provider, or a music service.
- [x] A newcomer can inspect the complete product thesis and its real fictional renderers directly from a clean source checkout without installing dependencies, through one script-free local showcase whose server cannot expose repository source or bind beyond loopback.
- [x] A newcomer can see the exact latest-single question that originally failed become a dated public-catalog answer with same-name artist disambiguation, released-versus-upcoming separation, and a visible boundary between public music-world evidence and private listening evidence.
- [x] A newcomer can run the same latest-single question directly from the CLI without configuring a model or reading a personal profile, receive an explicit already-released single that cannot be hidden by general-list truncation, and see public catalog choices instead of a guessed identity when exact-name ambiguity remains.
- [x] A listener can paste one returned Apple Music artist page into the next command, resolve that exact public identity without another name search, and receive releases only when the catalog's artist name still matches the requested name.
- [x] A listener can use an exact public artist alias when one Wikidata identity carries one MusicBrainz artist ID and one Apple Music artist ID, receive a direct Apple catalog lookup even when the canonical name differs, and retain the original ambiguity when either identity is missing or non-unique.
- [x] A listener can let one explicitly supplied Spotify history ZIP disambiguate a same-name public artist locally while the command withholds the archive path, private release titles, and listening counts, sends none of that private evidence to Apple or a model, and writes no persistent profile.
- [x] A listener can open one or two explicitly supplied Spotify history ZIPs as a complete session-only private Studio directly from a clean source checkout without dependency installation, reconcile Account Data and Extended History in memory, use the combined Tasteprint, Listening Time Machine, Listening Seasons, and correction loop immediately, then stop the process without creating persistent profile state or changing either source archive.
- [x] An owner can review or hand off an exact host-ready showcase bundle without granting a deployment credential or exposing private listener state.
- [x] A newcomer can inspect the real Tasteprint surface from Studio without preparing a ZIP or creating persistent local state.
- [x] A newcomer can generate an import-ready fictional Extended Streaming History ZIP, produce a four-year one-off Taste projection without persistent state, and feed the same artifact through the private Studio import path without supplying personal data.
- [x] A newcomer can apply and retract a direct correction against a clearly fictional Studio profile, open its refreshed bounded recap card or complete rendered evidence, and leave no database or artifact file behind.
- [x] A listener with imported history can create a private visual Tasteprint without a model, OAuth refresh, or external request.
- [x] A listener can create, open, or download a self-contained compact recap card from Studio, persistent history, or a one-off Spotify ZIP, keep private correction details and secondary profile fields out of it, and see an in-frame instruction to review every visible personal field before sharing.
- [x] A Spotify listener can create a one-off private Tasteprint directly from one Account Data or Extended Streaming History ZIP, or reconcile both exports through two `--from` options, without Apple setup or a persistent import.
- [x] A Spotify listener can explicitly persist the same ZIP, rerun the import idempotently, and continue using the cumulative profile across CLI, TUI, and agent sessions without Apple setup.
- [x] A listener can import Account Data and Extended Streaming History in either order, receive the same cumulative profile, retain exact lower-resolution evidence behind richer Extended events, and see the reconciled overlap count in the import result.
- [x] Remaining Account Data plays aggregate under a uniquely resolved Extended History track only when exact overlap evidence supports one target, while multi-target cases stay separate, their withheld identity and event counts remain visible, and stored evidence remains unchanged.
- [x] A ListenBrainz listener can import an official saved response or submission JSON offline through Studio or the CLI, rerun it idempotently, combine it with existing listening history, and continue using the cumulative provider-neutral profile without exposing direct identifiers or raw source fields.
- [x] A listener can inspect an explicit local music data scope, create a private checksummed export, and recoverably reset that scope without silent deletion or changes to OAuth, configuration, conversation memory, or original provider ZIPs.
- [x] A listener can correct an artist or track inference in Studio or the CLI through a typed direct assertion, inspect its provenance and history, see the next profile and private Tasteprint change, supersede it, and retract it without rewriting listening evidence.
- [x] The README demonstrates the real Tasteprint renderer without publishing personal listening data or presenting fictional values as a real user profile.
- [x] The walkthrough exposes its ordered tool trace, evidence boundary, validated playlist plan, and lack of external effects.
- [x] A listener can revise a validated pending playlist across turns without provider effects and approve only the newest host-revalidated order.
- [x] A listener can inspect official Apple Music pages for grounded release answers and selected external catalog tracks without treating those public pages as personal listening evidence.
- [x] A listener can turn qualifying older history into an inspectable listen-again plan while the host keeps provider IDs out of the Tasteprint and model-visible tool results.
- [x] A listener can inspect tracks that reappeared after long gaps and turn them into a prompt-local Agent plan while active avoidances are excluded, provider IDs remain host-only, and recurrence is not presented as nostalgia or preference.
- [x] A listener can inspect tracks played in adjacent retained Extended History rows and turn them into a prompt-local Agent plan while active avoidances are excluded, provider IDs remain host-only, and the sequence is not presented as repeat mode, intention, liking, or preference.
- [x] A listener can turn qualifying multi-year Spotify-only or ListenBrainz-only history into an inspectable chronological Listening Time Machine while the host excludes active avoidances and keeps provider IDs out of the Tasteprint and model-visible tool results.
- [x] A listener can see how many retained calendar years the Time Machine represents, identify unselected years without losing them from the listening arc, and inspect the selection thresholds in Studio and the complete Tasteprint.
- [x] A listener can inspect continuous UTC monthly activity in Studio and the complete Tasteprint through bounded aggregate-only Listening Pulse cells, while blank months are not treated as proof of no listening and raw timestamps remain excluded.
- [x] A listener can inspect fixed UTC calendar-quarter Listening Seasons in Studio, the complete Tasteprint, the CLI, and the Agent profile summary, including explicit empty and partial windows plus aggregate within-quarter anchors, while bounded previews report omissions and reject discovery, mood, identity, and life-event inference.
- [x] A listener can distinguish artists that recur across retained years from adjacent-year Top 10 turnover in Studio and the complete Tasteprint, while the product labels both as archive descriptions rather than identity or permanent taste change.
- [x] A listener can inspect aggregate approximate session shape and multi-track release depth in Studio and the complete Tasteprint, while per-session timestamps, raw event sequences, provider track IDs, incognito events, and invasive export metadata stay outside the view.
- [x] A newcomer can run the generated 52-play archive through the production importer directly from Studio's first screen, inspect the bounded fictional chronological route before making a correction, follow every Studio artifact link without relying on a popup-capable browser, and use the same path at a 390-by-844 mobile viewport without horizontal overflow.
- [x] A reviewer can launch the same production-importer fictional Time Machine through one dedicated command without reading existing local history or exposing an enabled user-import surface.
- [x] A newcomer can launch that complete interactive fictional Studio from a clean source checkout with no `node_modules`, reach the same production-importer profile, and leave no private state or configuration behind.
- [x] The README first screen states what Moondog does today, shows a production-rendered seven-frame Studio tour from one coherent fictional profile with an in-frame fictional-data label, and links claims to runnable behavior and the complete deterministic artifact.
- [x] Capture and visually inspect a short terminal recording of the real zero-auth demo from an isolated locked source install without private paths, account data, credentials, or listening history.
- [x] Add a private blinded rubric, integrity validator, and aggregate-only exporter for human recommendation review.
- [x] Remove manual JSON editing from the private judge path with an accessible local form and validated download flow.
- [x] Add a fictional-only product-first field kit with a self-contained observer form, zero-install Studio first task, strict newcomer validation, backward-compatible version-1 and version-2 protocol support, privacy-safe status, a three-session gate, and aggregate-only reporting.
- [ ] Complete a bounded human judge set for recommendation relevance, serendipity, canonical-recording quality, and explanation usefulness.
- [ ] Publish evaluator methodology and representative aggregate results without publishing personal profiles or raw histories.
- [ ] Run at least three clean-install usability sessions with people who did not build the project and record where they stop or misunderstand the product.

### Launch gate

Before a public push, record authoritative evidence for every required item above and rerun:

```bash
npm ci --ignore-scripts
npm run verify
npm run doctor
git diff --check
```

The static product showcase and offline agent walkthrough prove bounded local product paths.

It does not prove installation portability, public repository hygiene, legal permission, community readiness, recommendation quality, or deployment.
