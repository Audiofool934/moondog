# Contributing to Moondog

Moondog welcomes changes that make the personal music loop more useful, understandable, private, and reproducible.

The project favors complete listener outcomes over isolated feature volume.
A strong contribution identifies the user path, preserves evidence boundaries, and includes the smallest proof that the outcome works.

## Pre-release governance boundary

Moondog does not yet have a selected public license.
The canonical repository is [Audiofool934/moondog](https://github.com/Audiofool934/moondog).
Until a license is published, this checkout is available for local evaluation and project development but does not grant redistribution rights.
External contribution acceptance begins only after the maintainers publish the license and canonical contribution route.

This boundary is an owner decision and must not be inferred from the source tree.

## Start with the listener outcome

Before changing code, describe:

1. The listener problem or confusion.
2. The exact user path that should improve.
3. The personal data, network, model, and music-service boundaries involved.
4. The observable evidence that would prove the change works.

Read the [product charter](docs/PRODUCT_CHARTER.md), [public roadmap](docs/ROADMAP.md), and [release-readiness checklist](docs/PUBLIC_RELEASE_READINESS.md) before proposing a new capability.

Use the structured bug or product-idea form in the canonical repository.
Do not attach private listening data to an issue or pull request.

## Run Moondog locally

Moondog requires Node.js `>=22.19.0` and uses the npm version declared in `package.json`.

Install the locked dependency set without lifecycle scripts:

```bash
npm ci --ignore-scripts
```

Run the deterministic zero-auth product loop:

```bash
npm run demo
```

Open the script-free product overview with only fictional public assets:

```bash
npm run showcase
```

The local showcase binds only to `127.0.0.1`, serves an exact public-file allowlist, and makes no analytics or external network request.

Create a private host-ready review bundle without publishing it:

```bash
npm run export:showcase -- --output /absolute/path/to/moondog-showcase
```

Inspect `manifest.json` and the exported root `index.html` before selecting or configuring any external hosting target.

Open the dedicated zero-data Studio tour with its fictional in-memory profile already prepared:

```bash
npm run demo:studio
```

Use the first-screen action to inspect the Time Machine, profile-correction loop, and Tasteprint path without reading or creating private local state.

Exercise the production Spotify importer with a generated fictional archive:

```bash
mkdir -p outputs
npm run generate:demo-history -- \
  --output "$PWD/outputs/moondog-fictional-history.zip"
npm run moondog -- taste \
  --from "$PWD/outputs/moondog-fictional-history.zip" \
  --json
```

The generator reads no private state and produces only the fixed fictional Moondog catalog through a deterministic ZIP writer.
It refuses relative paths and existing destinations.
Keep the generated ZIP under ignored `outputs/`; do not add generated archives to a commit or pull request.

## Protect private listener data

Tests, bug reports, fixtures, screenshots, terminal output, commits, and pull requests must not include:

- Spotify Account Data or Extended Streaming History exports.
- Apple Music Library XML from a real listener.
- Personal Tasteprints, review packets, or recommendation comments.
- Local profile databases, resolution caches, or generated run artifacts.
- OAuth credentials, provider tokens, client secrets, or authorization URLs containing credentials.
- Real user-directory paths, private-network addresses, device identifiers, or unsanitized logs.

Use synthetic fixtures under `tests/fixtures/` and fictional names in documentation.
Keep private experiments and generated evaluations under ignored paths such as `runs/`, `outputs/`, and `data/private/`.

If a failure can only be reproduced with private data, reduce it to a synthetic fixture or describe the behavior without publishing the source material.

## Change the smallest complete slice

Match the proof to the kind of change:

- Product behavior should include the closest end-to-end test that is practical.
- Profile logic should preserve provenance, uncertainty, and the distinction between familiarity and preference.
- Provider integrations should normalize data before it enters core contracts and should keep provider identifiers inside the host boundary.
- Music-service writes should remain explicit, validated, and protected by the existing confirmation and receipt model.
- UI changes should be checked at the affected desktop and narrow viewport, including the real interaction path.
- Contract changes should compile every supported schema version and include valid and invalid synthetic fixtures.
- Documentation changes should keep commands executable and claims narrower than their evidence.

Do not manually edit generated artifacts when a repository generator exists.
Regenerate the synthetic Tasteprint HTML with `npm run generate:tasteprint-demo` after changing its renderer or source profile.

## Verify the change

Run focused tests while iterating, then run the complete public gate:

```bash
npm run verify
```

Before proposing a release-facing change, also verify a private clean-source snapshot:

```bash
npm run verify:clean-source
```

When Docker is configured, verify the supported Linux path:

```bash
npm run verify:clean-linux
```

The complete gate checks the release tree, public demos, community surfaces, package installation, current contracts, and the test suite.
Do not dismiss a failing or flaky check as unrelated without recording concrete evidence.

## Pull request expectations

A pull request should explain:

- The listener outcome and why it matters.
- The exact behavior before and after the change.
- The privacy, model, network, and external-action boundaries.
- The commands and user paths used for verification.
- Any remaining limitation, owner decision, or unsupported platform.

Keep unrelated work out of the change.
Do not include generated private artifacts, real listener data, or credentials even if the repository ignore rules would normally hide them.

The [pull request template](.github/PULL_REQUEST_TEMPLATE.md) mirrors these requirements.
