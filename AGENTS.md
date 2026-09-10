# Moondog Agent Instructions

## Current Product Surface

- Build and evaluate the personal listening loop in the Pi-based TUI.
- GUI and Studio development is paused until the project owner explicitly reopens that scope.
- Keep existing browser prototypes as reference; do not make them the default entrypoint or expand them as part of general project advancement.
- Reuse the shared profile, correction, import, and agent services when adding terminal interactions.
- Treat listening-profile review as the step immediately after a successful TUI import, in the same terminal session; do not require a browser or a separate command to see the result.

## Development Pace

- Optimize for rapid iteration and short feedback loops.
- Ship working product slices quickly and let the project owner evaluate product behavior, interaction quality, and direction.
- Do not over-invest early in speculative security hardening, exhaustive unit tests, regression suites, benchmarks, or abstractions that are not required by observed product behavior.
- Use lightweight, targeted checks that confirm the primary user path works.
- Prefer reusing Pi's existing capabilities over rebuilding baseline agent, model, authentication, and TUI functionality.
- Add robustness and broader coverage when real usage exposes a need or before a public, destructive, costly, or otherwise high-impact release.
