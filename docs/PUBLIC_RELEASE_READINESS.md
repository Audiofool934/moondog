# Public source status

Updated 2026-10-22.

The canonical repository is [Audiofool934/moondog](https://github.com/Audiofool934/moondog).
The source is open under the [Apache License 2.0](../LICENSE), selected by the owner on 2026-10-06.
Contribution information is in [CONTRIBUTING.md](../CONTRIBUTING.md).

## Distribution

The current distribution is a source checkout with Node.js 22.19.0 or newer and locked npm dependencies, on macOS or Linux.
The source version is `0.2.0-beta.1`.
`@audiofool/moondog` is the public npm package name, and the registry still serves 0.1.0.
Version 0.1.0 predates the updater, so its installs need a one-time manual upgrade; see [updates and maintainer setup](UPDATES.md).
A new npm release needs the owner to choose a channel and configure npm trusted publishing.
The tagged release workflow runs the clean-source check before OIDC publication.

The desktop app builds as an unsigned or signed and notarized Mac app from [`app/`](../app/README.md).
It is not yet distributed outside the owner's machines.

## Source boundary

The public history starts with a new Git history that excludes internal planning documents, imported data, local databases, credentials, generated runs, and private verification output.
`npm run verify:release-tree` checks the tracked tree and every blob reachable from branches, tags, and remotes against a path allowlist and content markers such as user paths, keys, and tokens.
This is a bounded publication check, not a security audit.

## Checks

`npm run verify` runs the release-tree check, the fictional-history and demo checks, the documentation link check, the installed-package check, contract validation, and the full test suite.
`npm run verify:clean-source` rebuilds an isolated source copy, installs the lockfile, and runs `npm run verify` there.
CI runs that clean-source check on Node 22.19.0 and Node 24.
Use [GitHub Actions](https://github.com/Audiofool934/moondog/actions/workflows/ci.yml) for the hosted status of a published commit.
A local pass is not evidence of a successful hosted run.

## Limits

The README terminal images show real output with fictional listening history, not a personal account or a live service.
Local checks do not establish live provider availability, native-terminal behavior on every platform, recommendation quality, or newcomer usability.
The [roadmap](ROADMAP.md) lists the human evaluation and first-run work still to be done.
