# DJ Claw Lineage

DJ Claw is a private predecessor to Moondog, not a second public product line or a source subtree of this repository.

It demonstrated that a music agent can connect listener context, planning, generation tools, library operations, curation, and playback into one continuing loop.

Moondog carries those product lessons forward through a new local-first architecture with provider-neutral contracts, bounded evidence, explicit effects, and synthetic tests.

## What carries forward

- The listener is a continuing collaborator rather than a one-shot prompt source.
- Taste evidence and uncertainty must remain visible to the user.
- Planning, external writes, account actions, and spending need distinct capability boundaries.
- Creative tools can join the product after the personal profile and discovery loop are trustworthy.
- Failures that require identity checks, account recovery, money, or a major creative choice return to the user.

## What does not enter this repository

- Private source code or deployment configuration from the predecessor.
- Credentials, sessions, browser state, account identifiers, or service logs.
- Personal taste memory, listening history, library data, media, or generated artifacts.
- Runtime databases, queues, caches, or host-specific paths.
- Provider adapters copied without a new interface, privacy review, and synthetic tests.

## Clean-room boundary

Moondog code is implemented against the contracts and product boundaries in this repository.

Legacy behavior may inform a requirement, but any implementation must be independently structured, use synthetic fixtures, avoid private runtime dependencies, and pass the current release-tree and test gates.

Detailed private infrastructure audits, source hashes, and historical personal-data measurements are intentionally excluded from the public release tree.
