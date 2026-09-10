## Listener outcome

Describe the concrete listener problem and the observable result this change provides.

## What changed

Describe the smallest complete product or engineering slice included in this pull request.

## Evidence

List the commands, tests, screenshots, or user paths that prove the result.

## Boundaries and limitations

State the personal-data, model, network, provider, and external-action boundaries that apply.
Record any unsupported path or owner decision that remains open.

## Checklist

- [ ] I used only synthetic or explicitly sanitized fixtures, screenshots, and logs.
- [ ] I included no listening-history export, personal Tasteprint, private review packet, credential, provider token, local database, or real user path.
- [ ] I added or updated the closest practical test for the changed behavior.
- [ ] I ran the focused checks relevant to this change.
- [ ] I ran `npm run verify`, or explained why the complete gate could not run.
- [ ] I checked affected UI states at desktop and narrow widths when the change is visual.
- [ ] I documented any authorized live provider action used during verification.
- [ ] I kept unrelated changes outside this pull request.
