# First-run Usability Evaluation

This workflow turns Moondog's newcomer test into a repeatable local protocol instead of an informal interview.

It records the first hesitation, the first successful product outcome, every misleading privacy or capability assumption, and the first task that was not completed.

The workflow does not claim that three sessions establish broad market usability.

It creates enough bounded evidence to find obvious first-run failures and decide what must be fixed or documented next.

## Privacy and eligibility boundary

Every session must use an independent participant who did not build Moondog.

Use an opaque participant label containing no name, email address, username, account handle, or other direct identifier.

The session uses only Moondog's built-in fictional experience and the deterministic fictional archive created by `moondog demo-history` or `npm run generate:demo-history`.

Do not import a participant's Spotify export, Apple Music library, ListenBrainz history, local music database, or Personal Tasteprint.
The only ZIP permitted in the session is the newly generated Moondog fictional archive.

Do not connect a provider, enter an OAuth credential, perform a provider write, or publish an artifact during the session.

The completed session JSON can contain private observer notes and stays under the Git-ignored `runs/` directory.

Only the aggregate summary produced by this workflow is designed for public use.

That summary omits participant IDs, exact session timestamps, free-text notes, artifact paths, credentials, and music data.

## Create the field kit

Create one versioned protocol and its self-contained local observer form with:

```bash
npm run eval:usability -- create
```

The command writes two private local files under `runs/`:

- `first-run-usability-<protocol-id>.protocol.json`
- `first-run-usability-<protocol-id>.html`

The HTML form has no external assets or network requests.

It embeds the exact protocol digest, guides the observer through every task, and downloads validator-compatible private session JSON.

Newly created field kits use protocol version 3 and put the zero-install interactive product before setup and advanced CLI tasks.
Existing version-1 and version-2 protocols and their bound sessions remain validator-compatible, but results from different protocol IDs must not be merged into one evidence gate.

If the form is missing, regenerate it without creating a new protocol:

```bash
npm run eval:usability -- form \
  --protocol runs/first-run-usability-<protocol-id>.protocol.json
```

## Prepare one clean session

Give the participant a clean source checkout plus the public README.
A verified package tarball may also be supplied for the later complete-install task, but it is not a substitute for testing the source checkout's zero-install path.

Do not teach the task sequence before the session.

Open the observer form on a separate screen when practical.

Let the participant speak aloud and work unaided until the first hesitation or stop has been recorded.

Record a hint or takeover before helping, then let the participant continue.

The bounded path covers these outcomes in order:

1. Run `npm run demo:studio` from the clean source checkout before dependency installation and open its loopback-only tour.
2. Use the first-screen action to find the fictional Listening Time Machine, 15 approximate listening stretches, and two multi-track releases.
3. Follow the chronological route, inspect the recap card, and identify the review-before-sharing boundary.
4. Add and retract one direct correction without mistaking it for a history rewrite.
5. Download and reopen the portable recap without mistaking download for publication.
6. Install the complete CLI from the clean copy without maintainer state.
7. Run the zero-auth offline agent demo and identify its fictional and no-write boundary.
8. Generate the documented fictional Extended Streaming History ZIP, run the real one-off Taste importer, and identify its 52 events, four retained years, and no-persistence boundary.

Mark each task as completed, blocked, or skipped.

Record elapsed seconds and whether the facilitator gave no help, a hint, or a takeover.

The downloaded filename begins with `completed-first-run-usability-` and must remain private.

## Validate and inspect collection status

Validate one or more completed sessions against the exact protocol before counting them:

```bash
npm run eval:usability -- validate \
  --protocol runs/first-run-usability-<protocol-id>.protocol.json \
  --session runs/completed-first-run-usability-<protocol-id>-newcomer-01.json
```

Validation fails closed when a participant built Moondog, the privacy confirmations are absent, a task is missing or reordered, an observation contradicts the task results, or the protocol digest changed.

Inspect the current collection without printing participant IDs, private notes, music data, or absolute paths:

```bash
npm run eval:usability -- status
```

The status view reports prepared protocols, local forms, valid sessions, unique newcomer counts, duplicate-participant sessions, invalid artifacts, and the remaining evidence-gate gap.

Three valid sessions must use three unique opaque participant IDs against one protocol.

Repeated sessions from the same participant do not increase that gate.

## Create the public aggregate

After validation, create an aggregate-only report with:

```bash
npm run eval:usability -- summarize \
  --protocol runs/first-run-usability-<protocol-id>.protocol.json \
  --session runs/completed-first-run-usability-<protocol-id>-newcomer-01.json \
  --session runs/completed-first-run-usability-<protocol-id>-newcomer-02.json \
  --session runs/completed-first-run-usability-<protocol-id>-newcomer-03.json
```

The report contains platform, install-source, and session-mode counts; task completion, blocking, assistance, and median-time aggregates; first-hesitation task and category counts; first-success task counts and median time to first success; misleading-assumption task and category counts; stopping tasks and reasons; and repeated blocked tasks.

The evidence gate becomes ready at three valid independent newcomer sessions.

The aggregate still describes only that bounded sample and must retain its limitations text when cited.

## Turn evidence into product work

A task blocked in two or more sessions appears under `repeated_failures` in the public-safe aggregate.

Reduce each repeated failure to either a product fix or a documented intentional boundary.

Run a later clean session against the updated experience before claiming that a blocker is resolved.

Do not publish private session files to prove the fix.

Keep the aggregate counts, the changed product behavior, and the later validation result as three separate pieces of evidence.
