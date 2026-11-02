# Updating Moondog

The original npm release, **0.1.0**, predates the updater: those installs need one manual `npm install --global @audiofool/moondog@latest` to reach the current release.
From 0.2.0 on, `moondog update` does it.
Merging code does not publish a package.

## Everyday use

```sh
moondog --version
moondog update --check
moondog update
```

In the listening room, `/update --check` keeps the session open. `/update` waits its turn behind current work, saves the conversation and queued drafts, closes the room and its stores, then prepares the update. Open `moondog` again afterward. It never restarts a session automatically.

Startup checks use the public npm registry, at most once per day per installed version and channel. They run in the background with a five-second deadline; failed checks do not block listening. They send no profile, credentials or conversation. Set `MOONDOG_UPDATE_CHECK=off` to disable automatic checks; explicit checks still work.

`latest` selects stable releases; `moondog update --channel beta` opts into previews. The selection is saved when an update succeeds or the installed version is already current. `--check --channel beta` previews without changing your preference. `moondog update --channel latest` switches back; it never silently downgrades a newer beta. It waits until a stable release catches up.

From 0.2.1, the beta preference selects the newer valid release from `beta` and `latest`.
It receives a stable successor without losing the preference for future previews.
A newer beta still takes precedence over an older stable release.

## Supported installations

- Global npm installs on macOS/Linux: Moondog recognizes the package and its launcher under the same npm prefix. It prepares an exact version with nested dependencies in a sibling directory, verifies the CLI, preserves the previous package, then replaces it. Node and the launcher remain in place. The prefix must be writable by your user; this command does not request sudo.
- Official source checkout: requires a clean `main` branch with the official origin, Git, npm and tar. The published npm version's source commit must match its Git release tag and descend from your current HEAD. Dependencies are prepared in a separate directory before a fast-forward. Local edits, custom branches, diverged history and development commits ahead of the published release stop installation. A developer who intentionally follows main can still use `git pull --ff-only` and `npm ci` manually when sessions are closed.
- Local project dependencies, transient `npx` installs and other package managers: use the tool that installed them. Moondog will not replace an unrecognized layout.

Close other Moondog sessions before updating. An installation-wide lock prevents concurrent updaters and blocks new normal launches during replacement; process checks also detect sessions running older versions. An uncertain process check stops the update.

## Data and interrupted updates

Updates replace program files and dependencies only. Profile databases, corrections, sign-ins, imported history and saved conversations are not migrated, copied or erased. CLI verification uses empty temporary config/state directories. Cancellation during preparation leaves the installed program intact. Once replacement begins, the updater finishes or restores its own change before returning.

The success message gives the preserved previous-program path. `updates/last-update.json` in Moondog's config directory records the source commits and backup location. Keep this backup until the new version works for you. It can then be removed manually; it contains program files, not a backup of your music data.

A hard kill or power loss during replacement can require manual recovery. The error points to a sibling `.lock.recovery.json` file with `installation`, `mode`, `previousHead`, `targetHead`, `stage` and `backup`. Do not rerun an install over this state:

1. Close Moondog and verify that the PID in the sibling lock's `owner.json` has exited. Keep the recovery record and both program directories.
2. For npm, restore the preserved `backup` directory to the recorded `installation` path, first moving any incomplete replacement aside. For source, inspect Git status and both commits before restoring the recorded previous commit and dependencies. Preserve any edits made after the interrupted update; do not use a blind hard reset.
3. Verify `moondog --version`, then remove the matching recovery record and lock directory. If no recovery record exists, an abandoned lock means replacement had not started (or finished completely); after verifying its owner has exited, remove only that lock.

Automatic rollback is limited to a failure inside this update operation. This release introduces no database migration and does not promise rollback of future data schemas. Any future schema-changing release must define its own backup and compatibility procedure before publication.

## Maintainer release procedure

One-time owner setup: configure the npm package's **trusted publisher** for GitHub Actions, repository `Audiofool934/moondog`, workflow `release.yml`, environment `npm`. Create that GitHub environment and protect it with the desired reviewer policy. This uses npm OIDC on hosted runners; no long-lived npm token belongs in the repository. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

1. Bump `package.json` and both root versions in `package-lock.json` together in a reviewed PR. Use `X.Y.Z-beta.N` for previews or `X.Y.Z` for stable releases. Record user-visible changes and validation in the PR.
2. Merge only after CI passes for that exact head; wait for main CI. Tag that verified main commit as `vX.Y.Z` (or `vX.Y.Z-beta.N`) and push that specific tag. Never move a published tag or reuse a version.
3. `Publish release` rechecks tag/version/lockfile identity and main ancestry, runs the clean-source suite on Node 22.19.0 and 24, then publishes with provenance to the matching `latest` or `beta` dist-tag.
   It rejects a release older than the current channel or GitHub latest.
   An existing npm version must match the source commit and both the local and remote package hashes before a retry can continue.
   Publication confirmation waits up to three minutes for registry metadata, the tarball and the channel to become visible, without publishing again.
   It prepares a GitHub draft after npm confirms publication.
   Draft recovery finds the exact tag in the authenticated release list, then checks the release ID and channel again.
4. Complete the [Mac publication procedure](../app/README.md#updates) from that tag.
   Start it as soon as the tag is pushed; it waits for the npm approval and the draft after its build.
   The draft becomes public only after the publisher has verified and uploaded the app and update metadata.
   Retry the same command after an interruption; do not rebuild or replace an already published version.
5. Verify the registry version, `gitHead`, channel, provenance, GitHub assets, a fresh install, and an update from the previous version.
   A green npm workflow alone is not desktop publication evidence.
   If npm succeeded but draft creation failed, rerun the workflow to verify the existing immutable package and finish the draft.
   A mismatched existing package or channel stops recovery and needs investigation.

The workflow requires the configured trusted publisher and environment approval; its presence alone is not publication evidence.
Existing 0.1.0 users cannot receive in-app prompts until they bootstrap a release containing this updater.
