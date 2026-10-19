# Moondog health check and roadmap (19 October 2026)

Point-in-time review of `main` at `42ec03c` (`Show one explanation each time Why it's here opens`, pull request #63). This document records what was installed and run, what still blocks daily use and a public launch, and a three-horizon roadmap. It does not replace [the public roadmap](../ROADMAP.md).

The product on this commit is a local-first listening room in the terminal, version `0.2.0-beta.1`, built on Pi `1.0.1`. A listener can import history, read an evidence-backed profile, correct it, and, with a signed-in model, talk and play. The copy a stranger gets from npm is still `0.1.0`, published 24 September 2026. That gap is the main reason other people cannot yet use the product that exists in this repository.

## Do these three first

1. **Publish the product that is already on `main`.** Source is `0.2.0-beta.1`. The npm registry has only `0.1.0` on dist-tag `latest`, and this repository has no Git tags. The release workflow in `.github/workflows/release.yml` is written and unproven. Effort: **M**. A cloud agent can prepare the version, notes, and a dry run of the checks. The owner has to choose beta versus stable and turn on npm trusted publishing (the open owner gate in `docs/ROADMAP.md`).
2. **Make unrecorded listening measures impossible to collapse into zeros.** Pull requests #61, #62, #63, and #64, merged 14–15 October, are four repairs of one invariant: a source that never recorded minutes, skips, or duration must stay unknown. The rule lives in prose, prompts, and scattered branches. Put one shared helper on the path every profile, explanation, and ranking uses, with a fixture that fails if a zero comes back. Effort: **S**. Cloud agent. This is the highest-leverage agent-friendliness fix, because recent agent branches are where this class of bug keeps landing.
3. **Give the desktop window one real listening session, then decide.** Draft pull request [#57](https://github.com/Audiofool934/moondog/pull/57) (`prototype/app`) is the bet for an app people leave open. It is even with `main` plus seven commits, CI is green, and the pull request itself says live model-chosen previews, physical media keys, in-app sign-in, native Quit, and a signed build are still out of scope. Effort: **S** of owner time on a Mac, then a yes or no. Signing and notarization are **L** and wait on that yes. A cloud agent can rebase and fix code; it cannot hear the room or press the Mac media keys.

If the npm trust setup is waiting on the owner, the agent should start item 2 and the small doctor fix in the first week below on the same days.

## 1. Current state

### What works end to end

Checked on Linux, Node `22.23.3`, npm `10.9.9`, after `npm ci --ignore-scripts` (99 packages). The declared package manager is npm `11.16.0`; CI installs that version. This run used the npm that shipped with Node 22.23 and the lockfile still installed cleanly.

| Check | Result |
| --- | --- |
| `npm test` | **1437 pass, 0 fail, 0 skipped, 0 todo.** `duration_ms` 25967. 117 test files, 43,980 lines under `tests/`. |
| Slow tests | 12 tests over 1 second. Slowest: "home artwork and lyrics animate…" at 3.7s. Nothing over 5s. |
| `moondog demo --offline` | Exit 0. Six-track synthetic walkthrough: `profile.summary`, `profile.explain`, `library.search`, `playlist.plan`. Anchor "Midnight Lines" by Mara Vale. No service writes. |
| `moondog demo-history` | Exit 0. 52-play fictional Extended Streaming History ZIP, 24,566 bytes, sha256 `f35444e655a768466897b21dd6cf894e9a3702324f954ea7dce4e35bb41aed13`, years 2023–2026. |
| `moondog taste --from <zip> --save --json` | Exit 0. Profile version `profile-projection/listening-history/1`. Coverage: 52 effective events, 4.2 hours, 14 tracks, provider `spotify`. |
| `moondog doctor --json` after that save | `ok: true`. Apple Music source missing and Spotify not configured, both optional once a profile exists. Model runtime `offline` (`model_not_configured`), also optional. |
| Listening room in a pseudo-terminal | Opened on the saved scratch state with `MOONDOG_UPDATE_CHECK=off` and motion off. Header: `local profile · model offline`. Sleeve lyric: "Is there anybody out there?". `/taste` showed `1/21`, `52 plays · 4.2 h · 14 tracks`, range 2023-09-01 to 2026-08-24, and `Build a saved reading: /profile build`. `/import` listed Apple Music, YouTube Music, Last.fm, QQ Music, and NetEase. Closing the import printed `Import closed. Nothing changed.` `/quit` returned. |
| `site/` build | `npm ci --ignore-scripts` added 4 packages, audit clean. `node build.mjs --snapshot` finished in about 1 second. Snapshot: 56 evidence entries. Bundle: `page.js` 1,493 KB, `page.css` 5 KB, `dist/` 5.8 MB across 8 files. |
| Public-agent tests | `node --test site/server/agent-server.test.mjs`: **7 pass, 0 fail**, about 5 seconds, fake model, no key. |
| Preview player on this machine | `ffplay` is on `PATH`, which is the Linux player `src/integrations/apple-music/terminal-preview-player.mjs` looks for (`afplay` on macOS, else `ffplay` or `mpv`). This run did not download or play an Apple preview. |

Scratch state used empty directories for `MOONDOG_STATE_HOME` and `MOONDOG_CONFIG_HOME`. After the save, `listening-history.sqlite` and `memory.sqlite` were mode `600` inside a directory mode `700`.

Hosted CI for this exact commit is green: [run 38768451442](https://github.com/Audiofool934/moondog/actions/runs/38768451442). Clean public source took about 70 seconds on Node 24 and about 90 seconds on Node 22.19.0. The project-page workflow for the same push also succeeded. A main run for pull request #64 was cancelled about nine seconds after it started because `.github/workflows/ci.yml` uses `cancel-in-progress` on the ref; the later commit's run is the one that passed. Local tests showed no flakes.

This run did not execute `npm run verify` or `npm run verify:clean-source`. Those are what CI runs, and they also pack the npm tarball and reinstall it into an empty consumer project (`scripts/verify-package.mjs`). It also did not call a live model, complete `/auth`, or connect Spotify.

### Setup friction for a new person

The README path is honest and short: Node `>=22.19.0`, macOS or Linux, `npm ci`, `npm start`. The room, the profile, and the offline demo do not need a model or a music-service login. After that, daily use picks up several walls.

- **The installable package is the old one.** `npm view @audiofool/moondog` on 19 October 2026 returned version `0.1.0`, dist-tag `latest` only, published `2026-09-24T08:31:45Z`. `docs/UPDATES.md` says `0.1.0` predates the in-app updater, so those installs cannot see `0.2.0-beta.1` until someone publishes a release that contains the updater, and the owner configures a trusted publisher. There are no tags in this clone.
- **Node floor is declared, then not enforced.** `package.json` and the Pi packages require Node `>=22.19.0`. `npm ci` on Node `22.14.0` printed `EBADENGINE` and installed anyway. `moondog doctor` on 22.14.0 set `node.version` to `ok: false` (`actual` `22.14.0`) and the process still exited 0.
- **`moondog doctor` on an empty machine says the product is unhealthy, and succeeds.** On a fresh scratch directory with Node 22.23.3, `doctor` printed `"ok": false` and exited 0. `apple_music.source` is not optional until a profile is ready, and `profile.projection` is `invalid` with `projection_subject_unavailable`. `moondog status` then says: "Rebuild it from the verified Apple import batch before using library-aware tools." A Spotify, Last.fm, or ListenBrainz listener has not failed. The same command after the fictional ZIP save printed `ok: true` and exited 0, which is the right exit only because the profile existed. `scripts/moondog.mjs` writes the doctor JSON and returns without looking at `ok`.
- **A model is a second install.** `/auth`, then `/model`. Providers in the terminal guide: GLM (`ZAI_API_KEY`), Kimi (`MOONSHOT_API_KEY`), DeepSeek, Grok, OpenAI, Anthropic, Gemini, OpenRouter, plus `openai-codex` via ChatGPT sign-in. Nothing is configured until the listener does that. `moondog ask` with no model exits with "No model is connected."
- **Spotify playback needs a developer app the listener creates.** `docs/TERMINAL_GUIDE.md` tells them to register `http://127.0.0.1:43821/callback` and run `moondog spotify configure <client-id>`. Sign-in is PKCE (`src/integrations/spotify/authentication.mjs`). A ZIP import does not need this. Full-song playback and private playlists do.
- **Apple library import is a Mac Music.app export.** `Library.xml`. The privacy download, and full QQ or NetEase history, are still unsupported (README). Last.fm import by username is on `main` (#59, #60).
- **Terminal previews need a system player.** Without `afplay`, `ffplay`, or `mpv`, the agent says it cannot play. With Spotify connected, playback goes to Spotify instead.
- **`/web` needs a signed-in Codex CLI** on the machine. Doctor reports it unavailable and treats it as optional.
- **The newcomer script still starts in Studio.** `docs/FIRST_RUN_USABILITY.md` task 1 is `npm run demo:studio` before `npm ci`. `AGENTS.md` and `docs/ROADMAP.md` say GUI and Studio work is paused, and the unchecked roadmap item is to replace that browser-first protocol with a TUI journey before any new sessions. The field kit therefore rehearses a surface the project has stopped building. Studio remains large: `src/surfaces/web/studio-page.mjs` is 4,148 lines and `studio.mjs` is 2,288.

`moondog profile --json` after the 52-event save reported `evidence_records: 0` next to `effective_listening_events: 52`, with a reason that Apple setup is optional. The events are there. The first field reads like an empty import.

### Test and CI health

The suite is fast and, on this run, strict: zero skips, zero todos, under half a minute. CI's clean-source gate on Ubuntu is about a minute and a half of job time and has been green on recent `main` pushes. Flakes did not show up in the runs inspected (local suite once; GitHub Actions history for mid-October, where failures were absent and the one cancellation was the concurrency rule).

Gaps in what the suite covers:

- The default `npm test` script does not run `site/server/agent-server.test.mjs`. The project-page workflow does.
- There is no typecheck and no linter. `npm test` is the gate.
- There is no coverage tool. The proof is 1437 behavioral tests, about 44k lines, against about 74k lines of `src/**/*.mjs` (123 files).
- Live model profile builds, Spotify OAuth, and Apple preview audio are outside the automated gate by design. `docs/LISTENER_PROFILE_HARNESS_RESEARCH.md` records fresh fictional builds on 14 October 2026. This health check did not repeat them.

## 2. Product gaps

Daily use for the owner, on a machine where Node and a model are already set up, is close. The terminal room imports, projects a profile without a model, and offers `/profile build` when a model exists. Public use, and a second person installing "Moondog" and leaving it open, is not close.

| Gap | Why it blocks | Where it stands |
| --- | --- | --- |
| npm still ships 0.1.0 | Other people, and the updater, never see the October product. | Workflow exists. Trusted publishing is an open owner gate. No tags. |
| First-run doctor and Apple-shaped empty copy | A healthy new checkout looks broken, and the process exit code agrees that it is fine. | Measured above. |
| Newcomer protocol is the paused Studio | Usability evidence cannot start until the script matches the TUI. Roadmap item is unchecked. | `docs/FIRST_RUN_USABILITY.md`, `docs/ROADMAP.md`. |
| Model and Spotify developer setup | Conversation and full playback are real, and each needs an account ritual a non-developer will bounce off. | Terminal guide. PKCE avoids a client secret. The listener still creates a Spotify app. |
| Profile build still has one known blind spot | Fictional first builds on 14 October avoided the planted traps after unrecorded measures stayed unknown. A fading older interest is still easy to miss, because the dossier has no per-artist trend across years. The roadmap checkbox for first-build quality is still open. | `docs/LISTENER_PROFILE_HARNESS_RESEARCH.md` section "Varied fictional listeners (2026-10-14)". |
| No human recommendation review, no three newcomer sessions | The launch gates in `docs/PUBLIC_RELEASE_READINESS.md` and `docs/ROADMAP.md` are still open. | Tooling exists (`npm run eval:review`, `npm run eval:usability`). Results do not. |
| Windows | `package.json` `os` is `darwin` and `linux` only. | Explicit. |
| Security contact and code of conduct | Required launch docs are missing. `SECURITY.md` and `CODE_OF_CONDUCT.md` are not in the tree. | Owner gate: "Publish maintainer and private disclosure routes." |

### Pull request #57, the window

[#57](https://github.com/Audiofool934/moondog/pull/57) is a draft, "Prototype: the listening room in its own window", branch `prototype/app`, updated 15 October 2026. `git rev-list --left-right --count origin/main...origin/prototype/app` is `0 7`: the branch contains `main`, plus the prototype. CI on that head is green (clean source on Node 22.19.0 and 24, and the project page).

The window runs the same room as `scripts/moondog.mjs` in an Electron process (`electron` `^44.7.0` in `app/package.json` on that branch). It adds preview audio with media keys and Now Playing, a room that keeps playing after the window hides, file drops that type a path, and an `OSC 7717` hook so the seasons chart in `/taste report` can be drawn as graphics while the text remains. `app/README.md` on the branch is clear about the rest: `/auth` is off inside the app because it wants a terminal prompt, so the listener signs in once with `moondog` and the app reuses that file; Spotify login steps do not render; Quit kills the room process; there is no packaged or signed build.

That is the right shape for a daily-use trial and the wrong shape to merge as the way other people install Moondog. The owner's listening session is the decision. Album art and a signed Mac app can wait on the outcome.

### Issue #56, album covers

[#56](https://github.com/Audiofool934/moondog/issues/56) is open, labeled `enhancement`, and parked. Branch `prototype/album-cover-art` is one commit ahead of the merge base (`b499799`, "Draw album covers in the terminal with /cover") and seven commits behind `main` (the Last.fm import, the project Last.fm key, terminal previews, and the four evidence-measure fixes). No pull request is open. CI has not run on the branch. The issue records local tests at 1404 of 1409, with the failures blamed on the worktree rather than cover code.

The prototype's own notes are the spec to keep: character art works over SSH, tmux, and xterm.js; half-block color is recognizable at 32 columns for covers such as *The Dark Side of the Moon*; ASCII and braille lose most covers; the image stays on the host and off the model; Apple's catalog misses some famous albums on `entity=album`, so song search has to rank candidates, and 2 of 12 test queries were wrong ("Radiohead Creep" hit a karaoke version, "My Bloody Valentine Loveless" hit a different album). `findCover` has no ranking test. The browser room answers that covers are unavailable. Pi's `Image` widget can do Kitty and iTerm2 graphics, and the sleeve currently refuses image protocols on purpose.

Covers are polish on top of a room that already plays. They become worth doing after the install and the window decision, and only in a place the listener is already looking (the sleeve lyric, a recommendation, now playing). A `/cover` command can stay a prototype.

## 3. Code health and agent-friendliness

The architecture in `docs/ADR_0001_AGENT_RUNTIME_AND_CLI.md` is the right one for agents. Moondog owns profile, memory, capabilities, and connectors. Pi owns the agent loop, model adapters, and the TUI, pinned exactly at `1.0.1`, with no fork and no dependency on `pi-coding-agent`. Profile, conversation memory, and explicit `/remember` facts are different stores. `AGENTS.md` tells an agent which surface is in play. Contracts under `contracts/v1` and `contracts/v2` are JSON Schema with valid and invalid fixtures, checked by `npm run validate:contracts`.

The implementation is harder to change safely than that design suggests.

**A few files are the product.** Line counts on this commit:

| Lines | File | Role |
| ---: | --- | --- |
| 7717 | `src/runtime/pi/agent-runtime.mjs` | Pi adapter, tools, prompt assembly |
| 4148 | `src/surfaces/web/studio-page.mjs` | Paused Studio page |
| 3575 | `src/surfaces/html/tasteprint.mjs` | Tasteprint HTML |
| 3277 | `src/core/moondog-application.mjs` | Capability facade, doctor, status |
| 2639 | `src/profile/listening-profile-projection.mjs` | Profile math |
| 2465 | `src/core/apple-projection-domain-services.mjs` | Apple projection |
| 2355 | `src/profile/listening-history-store.mjs` | SQLite history |
| 2288 | `src/surfaces/web/studio.mjs` | Paused Studio server |
| 2272 | `src/surfaces/cli/tui.mjs` | The listening room |
| 1046 | `scripts/moondog.mjs` | Composition root |

`src/**/*.mjs` is 73,997 lines across 123 files. An agent asked to change "how a play count is explained" has to find the rule inside the projection, the history store, the TUI model, the profile builder, and the skill at `src/runtime/pi/skills/listener-profile/SKILL.md`.

**There are no types.** No `tsconfig`, no TypeScript sources, no JSDoc `@param` or `@typedef` under `src/`. Invariants are naming conventions, JSON Schema at the contract boundary, and tests. That is enough for the suite to stay green, and it is why unknown-versus-zero survived until a listener-shaped fixture caught it. Pinned Pi packages are themselves typed; Moondog's side of the adapter is not, so a wrong field shape fails at runtime inside a 7,717-line file.

**Tests are the real spec, and they are good.** 117 files, parity checks for screen strings and message catalogs (`tests/core/i18n.test.mjs` asserts every locale has the English keys, including the four 947-line screen catalogs). The missing rail is a linter or a typecheck that fails before review. Recent history is the evidence: of 165 commits, `git log` subjects include 14 with "fix", 2 with "crash", and a run of "Keep …" repairs. The October cluster is the pattern to design against:

- #61 unrecorded measures were sent to the model as zeros
- #62 those zeros were repeated in evidence explanations
- #64 songs to hear again ranked on missing duration
- #63 "Why it's here" could stack explanations

Earlier subjects show the same families: Spotify credential refresh races, a late model-catalog failure crashing the process, a late terminal cell size crashing the room, Enter arriving before the last key was committed. They are boundary and timing bugs in large untyped modules. Agents (`claude/…` branches on many of the October pulls) can add a test for the case they see. They will keep missing the next case until the invariant has one function and one fixture.

**Docs drift in ways that send an agent the wrong way.** `docs/ROADMAP.md` "Current interface scope" is dated 2026-09-10 and still accurate that the TUI is the product, then the usability section still starts from Studio. `docs/PUBLIC_RELEASE_READINESS.md` leads with the real 2026-10-01 status, then a "Historical preparation record" that still says the repository has no Git remote, no license, and no CI. `moondog status` reports `"milestone": "A3-S3+A4-S4"`. The ListenBrainz and Wikidata client in `src/integrations/open-music-similarity/artist-radio.mjs` sends `User-Agent: Moondog/0.1 (https://ai.ruc.edu.cn/)`, while lyrics and Last.fm identify `https://github.com/Audiofool934/moondog`. Worth confirming which identity should be on the wire.

**i18n is tested, and it is wide.** Screen copy is an English source string used as the key, duplicated in `src/i18n/screen/{es,ja,pt,zh}.mjs`. The parity test fails the build when a sentence is missing. An agent still edits four files and one very long help string for every command change.

**Paused Studio is still in the hot tree.** It is reference, and it is also 6,400 lines of `studio.mjs` plus `studio-page.mjs` that a search for "import" or "taste" will open. `AGENTS.md` already says not to extend it. The health issue is navigation, not a request to delete it this week.

What is already agent-friendly, and should stay: the ADR ownership table, scratch-state environment variables (`MOONDOG_STATE_HOME`, `MOONDOG_CONFIG_HOME`), fictional ZIP generation, contract fixtures, the clean-source CI gate, `AGENTS.md`, and the habit of small pull requests with a listener-visible outcome.

## 4. Risks

### Listener data and tokens

The design matches the claim that the profile stays on the machine. State defaults to `~/.local/state/moondog` (`src/core/state-directory.mjs`), overridable with absolute `MOONDOG_STATE_HOME` or `MOONDOG_CONFIG_HOME`. Credentials go through `src/runtime/pi/persistent-credential-store.mjs`: directory mode `0700`, file mode `0600`, a size cap, and a lock. Spotify tokens use that store. `.gitignore` covers `.env`, Spotify token files, `auth-profiles.json`, SQLite, `Library.xml`, `data/private/`, `runs/`, and `outputs/`. The release-tree scanner (`scripts/release-tree-policy.mjs`) rejects private keys, common token shapes, private IPv4 addresses, and home-directory paths, and CI scans blobs reachable from branches and remotes.

Boundaries that are implemented and worth keeping:

- A profile build sends a compact dossier to the configured model when the listener asks. Raw history is not the prompt (`docs/ADR_0001_AGENT_RUNTIME_AND_CLI.md`, the listener-profile skill).
- `/web` is the Codex CLI and is documented as sending only the question or URL the listener gives.
- Lyrics use LRCLIB and are documented as not sending the profile.
- The public agent (`site/server/agent-server.mjs`) copies fictional history per session, allows only read and preview effects, caps turns, sessions, output tokens, and a daily budget (default 3 USD), and can require a Cloudflare Turnstile token. It binds `0.0.0.0` by default and trusts `MOONDOG_AGENT_ADDRESS_HEADER` when a proxy is in front. Message text is documented as not logged. This run executed the fake-model tests, not the production host.

Residual risk:

- **Last.fm.** `src/integrations/lastfm/settings.mjs` ships Moondog's own API key so a username import works with no signup. The comment says the shared secret is not included, and an environment variable or a mode-`0600` settings file overrides it. A key in a public repository can be copied until Last.fm revokes it or the quota is someone else's. Treat rotation as an owner action, and keep the secret off the tree.
- **`doctor` exit 0 when `ok` is false** will let a script or an agent proceed on a broken or empty setup.
- **No `SECURITY.md`.** There is no published disclosure route. The roadmap already lists that as an owner gate.
- **Updater.** Startup checks hit the public npm registry at most once a day and send no profile (`docs/UPDATES.md`). Install is explicit. The trusted-publisher path uses GitHub OIDC and npm provenance, which avoids a long-lived npm token in the repo. It has not published this source version, so the safety of the path is designed, not observed.
- **`@earendil-works/pi-telemetry@1.0.1`** is a transitive dependency of `pi-ai`. Its package description is "vendor-neutral telemetry contracts and typed schema utilities." Moondog source does not import it. No `fetch` or URL showed up in that package. It is not evidence of a phone-home SDK. It is a dependency to remember when reading Pi updates.
- **Identity string** `Moondog/0.1 (https://ai.ruc.edu.cn/)` on Wikidata and ListenBrainz requests. Confirm it is still the intended contact before a wider launch.

### Dependencies and licensing

Moondog is Apache-2.0. The lockfile's 99 packages report licenses MIT (50), Apache-2.0 (34), BSD-3-Clause (12), Unlicense, 0BSD, and ISC. Direct dependencies: Pi packages MIT at exactly `1.0.1`, `ajv` `8.20.0` MIT, `ajv-formats` `3.0.1` MIT, `plist` MIT, `yaml` ISC (dev). No copyleft license showed up in the lockfile license field.

`npm audit` on the root install reports one high finding: `fast-uri@3.1.6`, pulled in by `ajv@8.20.0` (also via `ajv-formats`). Advisories: [GHSA-qw65-cvwx-89v3](https://github.com/advisories/GHSA-qw65-cvwx-89v3) (authority injection, fixed in 3.1.7), [GHSA-58mr-gqgx-xq4g](https://github.com/advisories/GHSA-58mr-gqgx-xq4g) (host confusion, affects 3.1.6), and a moderate host-case issue fixed in 3.1.8. Ajv uses this to validate URI formats in contracts. Moondog's own outbound URL checks are separate allowlists (Apple preview hosts, Last.fm API root, and similar). The practical exposure for a local listener is small. The fix is still a lockfile bump once `ajv` accepts a patched `fast-uri`, with `npm run validate:contracts` afterwards. The site install reported zero vulnerabilities.

Exact Pi pins are a good reproducibility choice. They also mean security fixes in Pi wait on a deliberate bump, which matches the ADR and should stay a reviewed change.

### Distribution, packaging, signing

Today's supported distribution is a source checkout on macOS or Linux, plus a stale global npm package. `scripts/verify-package.mjs` caps the packed tarball (2.6 MB, 137 entries, 5.14 MB unpacked). The release tree cap is 450 files and 20 MB (`scripts/release-tree-policy.mjs`); this commit tracks 388 files. Those caps are doing their job.

There is no standalone binary, no Windows build, and no signed Electron app. Pull request #57 runs Electron from `app/` via `npm start` and says packaging is out of scope. A signed, notarized Mac build needs an Apple Developer ID, a notarization path, and the owner's machine. Auto-update for that app does not exist; the npm updater in `docs/UPDATES.md` only understands a global npm install or a clean `main` checkout. Shipping a window without that story means two update mechanisms or a window that goes stale.

`node:sqlite` (`DatabaseSync`) is the database. Scripts pass `--disable-warning=ExperimentalWarning`. That is another reason to keep the Node floor real: the engine field is the compatibility promise, and 22.14 still launches.

## 5. Roadmap

Effort: **S** is one focused change and one review. **M** crosses several modules or needs an owner step in the middle. **L** is a new distribution channel, signing, or a structural split of the large modules.

"Agent" means a cloud agent can implement and test it on this repository. "Owner" means it needs the owner's accounts, a Mac, a real listening session, or a product decision.

### Next one to two weeks

| Item | Why | Effort | Who |
| --- | --- | --- | --- |
| **Publish `0.2.0-beta.1` (or a stable `0.2.0` if the owner wants one) from `main`.** Tag the verified commit, run the existing release workflow, confirm registry `gitHead`, provenance, and a clean global install. | The product people can `npm install` is five weeks and a whole listening room behind `main`. The updater cannot reach anyone still on 0.1.0 until this exists. | M | Owner chooses the channel and configures the npm trusted publisher (`docs/UPDATES.md`). Agent prepares notes, version alignment, and the verification commands. |
| **One helper for unrecorded measures, used by projection, explanations, rankings, and the profile dossier.** Fixture: a source with no duration and no skips must not become zero plays, zero minutes, or "unplayed." | #61–#64 are the same bug in four places. The next agent branch will find a fifth. | S | Agent |
| **Owner listening session on [#57](https://github.com/Audiofool934/moondog/pull/57).** Same profile as the terminal, fictional or personal, with a model already signed in via `moondog`. Try pause, `/skip`, `/stop`, a failed preview, file drop into `/import`, and the seasons chart. Write the yes or no on the pull request. | The draft is waiting on daily-use judgment. Merging, or starting notarization, before that session skips the evaluation the pull request asked for. | S | Owner, on macOS. Agent can rebase onto `main` when asked. |
| **`doctor` tells the truth.** Exit non-zero when `ok` is false. An empty state is "no library yet", with import hints, and Apple is optional. `evidence_records: 0` beside a non-zero event count gets a label a person can read. | Measured: empty doctor is `ok: false`, exit 0, and the copy blames a missing Apple batch. | S | Agent |
| **Point the usability protocol at the TUI.** Retire Studio as task 1, or mark the whole protocol paused until the TUI script exists. Do not run newcomer sessions on `demo:studio`. | The open roadmap item says this, and the current script trains the wrong product. | S | Agent drafts. Owner accepts the task list, because it defines what "a new person succeeds" means. |
| **Bump `fast-uri` past the advisory** if the `ajv` range allows it. Re-run contract validation and `npm test`. | One high audit finding, low practical exposure, easy to clear before a release. | S | Agent |
| **Add `SECURITY.md` with a real contact.** | Launch gate already written down. Disclosure otherwise arrives as a public issue. | S | Owner supplies the address. Agent adds the file. |
| **Rebase `prototype/album-cover-art` and add the `findCover` ranking test.** Leave it parked. | Seven commits behind, and the issue already says the ranking test is the missing proof. | S | Agent. Owner decides later where a cover is allowed to appear. |

### Next month

| Item | Why | Effort | Who |
| --- | --- | --- | --- |
| If the listening session says yes: in-app `/auth` prompt, Quit that closes the room, Spotify login text visible in the window. | `app/README.md` lists these as the reasons the prototype is not a daily driver yet. | M | Agent. Owner retests sign-in and Quit on a Mac. |
| Signed, notarized Mac build of that window, plus one update story. | "Others use it daily" does not survive `cd app && npm ci && npm start`. | L | Owner for the Apple Developer ID and notarization. Agent for the build pipeline. Linux CI can compile; it cannot notarize. |
| Per-artist trend in the profile dossier, then one fresh fictional build and one build on the owner's real archive. | The 14 October note: fading interests are still easy to miss. This is the remaining first-build quality hole. | M | Agent implements. Owner judges whether the reading matches the archive. Do not hard-code that listener's corrections. |
| Start a type boundary at the profile edge. JSDoc or a checked `.d.ts` for listening measures, evidence rows, and tool results that cross into `agent-runtime.mjs`. New code in those types. No repository-wide TypeScript migration. | Gives agents a compiler failure on the bug class above without boiling the 74k lines. | M | Agent |
| Split `tui.mjs` along the screens it already has (sleeve, import, taste, conversation) once the type boundary exists. Leave behavior identical. | 2,272 lines is where input races have already landed (`#51`, late cell size). | M | Agent |
| Run the blinded recommendation review on fictional packets and publish the method plus aggregates only. | Open launch gate. The validator and forms already exist. | M | Owner rates. Agent runs the kit and writes the public note with no titles from a personal library. |
| Three TUI newcomer sessions after the protocol matches the room. | Open launch gate. Sessions are how the remaining setup lies get caught. | M | Owner finds the people. Agent fixes what the notes show. |
| Decide the Spotify developer-app requirement for people who only want playback. | A personal dashboard app is the steepest non-npm wall for a friend. ZIP import and Apple previews already work without it. | M | Owner. Platform rules and the product promise are the owner's call. Agent can implement whatever policy is chosen. |

### Later

| Item | Why | Effort | Who |
| --- | --- | --- | --- |
| Album covers where the listener is already looking, character art by default, real images only as an option. | [#56](https://github.com/Audiofool934/moondog/issues/56). Half-block art is the portable choice. Placement is a design decision. The two known search misses need a test before any default-on behavior. | M | Owner for placement and taste. Agent for the port and the tests. |
| Windows. | `os` excludes it. A real port includes the player, paths, and the credential store. | L | Agent can survey. Owner decides if it is in the product. |
| Creative tools, Telegram, Studio revival. | Already "later" or paused in the roadmap and `AGENTS.md`. | L | Owner reopens the scope. |
| Schema migration story, before any release that changes SQLite. | `docs/UPDATES.md` already says this release does not migrate data and will not promise rollback. | M when the schema changes | Agent writes the migration. Owner backs up a real library first. |
| On-demand loading for skills if more than the listener-profile skill ships. | The profile skill is inlined into the prompt on purpose. A second long skill should not be. | S | Agent, using Pi's own loader if it fits. |

### What not to do in these horizons

- Do not merge #57, and do not start notarization, before the owner's listening session.
- Do not build the cover browser path, or Kitty images, before the placement decision.
- Do not expand Studio, and do not run the current Studio-first usability protocol as evidence about the TUI.
- Do not add a second profile-inspection product. Corrections and `/profile explain` stay; the builder gets the invariant and the trend first.
- Do not rewrite the runtime in TypeScript as a project of its own. Types belong on the boundaries that have already produced bad merges.

## Evidence index

Commands were run from this checkout on 19 October 2026. State and output stayed in scratch directories outside the repository.

- `npm ci --ignore-scripts` on Node 22.23.3, then `npm test`: 1437 pass, 25967 ms.
- Same CLI on Node 22.14.0: `doctor` reports `node.version` `ok: false`, process exit 0. `npm ci` on 22.14.0 warned `EBADENGINE` and completed.
- `moondog doctor --json` on empty scratch state, Node 22.23.3: `"ok": false`, exit 0.
- `moondog demo --offline`: exit 0, six-track trace.
- `moondog demo-history` then `moondog taste --from … --save --json` then `doctor`: `"ok": true`, 52 events, 4.2 hours.
- Pseudo-terminal `scripts/moondog.mjs` against that state: sleeve, `/taste` summary, `/import` service list, `/quit`.
- `npm ci --ignore-scripts` in `site/`, `node build.mjs --snapshot`, `node --test site/server/agent-server.test.mjs`.
- `npm view @audiofool/moondog version dist-tags time --json`
- `npm audit` at the repository root (`fast-uri`) and in `site/` (clean).
- `gh pr view 57`, `gh issue view 56`, `git rev-list --left-right --count` for `prototype/app` and `prototype/album-cover-art`.
- `gh run view 38768451442` for CI on `42ec03c`.

Personal listening archives, OAuth tokens, and model keys were not used.
