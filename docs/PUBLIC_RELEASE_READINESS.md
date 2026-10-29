# Public source status

Updated 2026-10-28.

The canonical repository is [Audiofool934/moondog](https://github.com/Audiofool934/moondog).
The source is open under the [Apache License 2.0](../LICENSE), selected by the owner on 2026-10-06.
Contribution information is in [CONTRIBUTING.md](../CONTRIBUTING.md).

## Distribution

The current distribution is a source checkout with Node.js 22.19.0 or newer and locked npm dependencies, on macOS or Linux.
The source version is `0.2.2`.
`@audiofool/moondog` is the public npm package name, and the registry serves 0.2.1 as `latest`.
Version 0.1.0 predates the updater, so its installs need a one-time manual upgrade; see [updates and maintainer setup](UPDATES.md).
A `v` tag publishes through npm trusted publishing with provenance, after the owner approves the `npm` environment.
The tagged release workflow runs the clean-source check before OIDC publication.
It prepares a draft GitHub release; verified Mac artifacts must be uploaded before that release becomes public.
The project page selects stable downloads and leaves preview releases on GitHub.

The desktop app has native build targets in [`app/`](../app/README.md): Mac DMG and zip for Apple silicon, a Windows x64 installer, and a Linux x64 AppImage.
Mac releases retain the Developer ID signing and Apple notarization workflow.
The desktop workflow builds and checks the Windows and Linux packages on their own operating systems, then keeps the files as CI artifacts.
Those artifacts are test builds, not a published release.
The [project page](https://moondog.audiofool.ai) offers each platform's download only after its file exists on a GitHub release.
Full Apple Music songs and Music app control remain macOS-only; Windows and Linux offer previews and Spotify playback.

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
