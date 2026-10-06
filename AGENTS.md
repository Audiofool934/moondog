# Moondog Agent Instructions

## Current Product Surface

- Build and evaluate the personal listening loop in the Pi-based TUI.
- GUI and Studio development is paused until the project owner explicitly reopens that scope.
- Keep existing browser prototypes as reference; do not make them the default entrypoint or expand them as part of general project advancement.
- Reuse the shared profile, correction, import, and agent services when adding terminal interactions.
- Present the listening-profile result immediately after a successful TUI import, in the same terminal session; do not require a browser or a separate command to see it.

## First Profile Build Quality

- Prioritize a useful, reliable profile from the listener's first import and requested build, without requiring repeated inspection, feedback, or rebuilding to repair basic interpretation errors.
- Aim for a plausible, multidimensional, internally coherent working understanding of the listener.
  Reasonable inference error and local factual imperfections are acceptable; exhaustive correctness is not the quality target.
- Keep the builder and its evaluation simple.
  Prefer evidence-aware synthesis and a bounded whole-profile coherence check; add narrower checks only when an observed failure materially changes the musical interpretation or usefulness.
  Correct invented explicit preferences and material contradictions, while keeping minor defects proportionate instead of expanding the pipeline to eliminate every error.
- A single user-initiated build may perform multiple internal analysis, verification, and repair stages with bounded work and visible progress.
- Keep enduring preference, recent attention, collection evidence, subjective importance, and listening context distinct.
  Missing platform history or personal context must remain unknown rather than becoming an invented explanation.
- Use development-time listener feedback to improve general build behavior and evaluate fresh builds; do not make that feedback loop part of required onboarding or hard-code one listener's answers.
  Evaluate whether the model's interpretation makes sense from its evidence, rather than requiring exact agreement with the listener's self-description.
- A dedicated user-facing profile inspection experience is a possible later feature, not the current priority or a prerequisite for first-build quality.
  Preserve existing evidence and correction commands without expanding an inspection workflow ahead of the build itself.

## Development Pace

- Optimize for rapid iteration and short feedback loops.
- Ship working product slices quickly and let the project owner evaluate product behavior, interaction quality, and direction.
- Do not over-invest early in speculative security hardening, exhaustive unit tests, regression suites, benchmarks, or abstractions that are not required by observed product behavior.
- Use lightweight, targeted checks that confirm the primary user path works.
- Prefer reusing Pi's existing capabilities over rebuilding baseline agent, model, authentication, and TUI functionality.
- Add robustness and broader coverage when real usage exposes a need or before a public, destructive, costly, or otherwise high-impact release.

## Git And Remote Maintenance

- Maintain Git and the configured GitHub remote as part of ongoing Moondog work.
- Inspect the current branch, working tree, and upstream before editing, and preserve unrelated changes.
- After a coherent task is complete, run proportionate checks, commit only its scoped files, and push the intended branch to its configured remote unless the user requests local-only work.
- Verify the remote commit and report synchronization status and any relevant pending or failed checks accurately.
- Keep ignored personal data and local history backups out of public pushes; push the specific branch rather than all branches or a mirror.
