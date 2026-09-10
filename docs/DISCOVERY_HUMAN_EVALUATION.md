# Discovery Human Evaluation

Moondog separates deterministic discovery integrity from subjective recommendation quality.

`npm run eval:discovery` checks provenance, candidate membership, count, diversity, and rendered evidence boundaries.

The human review workflow evaluates relevance, serendipity, canonical-recording quality, and explanation usefulness without treating structural proxies as taste judgments.

## Privacy model

Human review packets contain private music context because even one seed and a short recommendation list can reveal taste.

Packets and their manifests belong under the Git-ignored `runs/` directory and must not be published.

The blind packet omits provider, model, tool trace, source identifiers, raw prompt, raw listening profile, and opaque track references.

Profile-grounded packets can include up to eight provider-neutral anchors in each of four groups: strong preferences, familiarity, artist facets, and genre facets.

The context projector removes play counts, evidence IDs, provider labels, provider signals, coverage totals, and raw history fields before the evaluation artifact is written.

If a run did not capture bounded profile anchors, its packet says that personal relevance was not fully testable from the visible context.

The separate private manifest retains only the mapping needed to compute provider-level aggregates.

The public summary exporter omits tracks, artists, releases, seeds, prompts, reviewer IDs, models, tool traces, artifact paths, and profile details.

## Rubric

Every recommendation receives four integer scores from 1 to 5 and one `would_listen` answer of `yes`, `maybe`, or `no`.

| Dimension | 1 | 3 | 5 |
| --- | --- | --- | --- |
| Relevance | Clearly irrelevant | Plausible but weak | Strongly relevant |
| Serendipity | Obvious or random | Some useful surprise | Unexpected and compelling |
| Canonical recording quality | Clearly poor version choice | Usable but uncertain | Clearly appropriate version |
| Explanation usefulness | Generic or unsupported | Partly useful | Specific and well bounded |

Canonical recording quality asks whether the chosen track and release are appropriate representative recordings.

It is designed to expose intros, interviews, bootlegs, duplicate editions, awkward live variants, and other choices that a metadata-only gate can miss.

Reviewers should listen to or independently verify the exact title and release when practical before assigning that score.

## Create a private blind packet

Run a live discovery evaluation first.

```bash
npm run eval:discovery -- --scenario profile_grounded_open_artist_similarity
```

Create a blind packet from the resulting artifact.

```bash
npm run eval:review -- create \
  --input runs/discovery-evaluation-<timestamp>.json
```

The command writes a review packet, private manifest, and self-contained local HTML review form into `runs/`.

Open the HTML file directly in a browser, enter an opaque reviewer ID, complete every required answer, and download the completed JSON review.

The form loads no external assets, makes no network requests, and preserves the packet's content digest in the downloaded review.

The form and downloaded review are private artifacts because both contain bounded personal music context.

Each reviewer must use an opaque local ID rather than a name or email address, record an ISO timestamp, state whether the review is independent, fill every score, and answer every `would_listen` field.

Moondog does not generate ratings on behalf of human judges.

## Inspect review operations

Run the local status inventory before distributing forms and again after collecting reviews.

```bash
npm run eval:review -- status
```

Use `--input-dir <dir>` for a non-default private artifact directory and `--json` for machine-readable output.

The report groups artifacts by opaque packet ID, verifies packets, manifests, and completed reviews, identifies missing forms or manifests, and shows the exact independent-reviewer and recommendation-rating gap for each represented provider.

It omits track, artist, release, seed, prompt, reviewer ID, model, profile details, and absolute artifact paths.

The status report is still a local operational artifact because provider labels are visible to the maintainer and must remain hidden from blind reviewers.

If an older valid packet has no HTML form, regenerate the form without changing the packet or its digest.

```bash
npm run eval:review -- form \
  --packet runs/discovery-human-review-<packet-id>.json
```

The form command validates the blind packet before writing a self-contained no-network review surface.

## Validate completed reviews

```bash
npm run eval:review -- validate \
  --review runs/completed-<packet-id>-judge-01.json
```

Validation rejects missing or out-of-range scores, invalid intent answers, unsupported reviewer metadata, and changes to the blind recommendation content.

The blind content digest allows comments and ratings to change while detecting changes to the request, seed, track, release, explanation, rubric, or case structure.

## Export an aggregate-only summary

```bash
npm run eval:review -- summarize \
  --review runs/completed-review-judge-01.json \
  --review runs/completed-review-judge-02.json \
  --review runs/completed-review-judge-03.json \
  --manifest runs/discovery-human-review-<packet-id>.manifest.json
```

The exporter reports sample counts, score means, score distributions, behavioral-intent counts, and provider-level aggregates.

It does not copy judge comments or any item-level music context into the output.

## Representative claim gate

The first bounded gate requires at least three independent reviewers and at least 12 recommendation ratings for every represented provider.

This is a release-claim floor, not a claim of statistical power or universal quality.

A credible comparison should use matched scenarios, similar recommendation counts, the same rubric, and reviewers who do not know which provider or model produced each packet.

Structurally failed runs remain failures and should not disappear merely because only completed recommendation plans can enter a human packet.

Small samples, owner-only reviews, unmatched requests, and provider-identifying explanations must be disclosed when interpreting results.

Human ratings do not prove that a recommendation is personally novel, universally good, or acoustically similar to the seed.
