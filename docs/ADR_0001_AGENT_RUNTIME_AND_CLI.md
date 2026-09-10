# ADR 0001: Agent Runtime and CLI Boundary

## Status

Accepted on 2026-08-25.

This decision governs the first Moondog client and the boundary among Moondog, Pi, OpenClaw, and DJ Claw.

The A1 amendment recorded on 2026-08-25 preserves that runtime boundary while extending the first diagnostic slice with Moondog-owned library, profile, evidence, and playlist-planning interfaces.

The A2-thin amendment recorded on 2026-08-25 adds Moondog-owned local session and explicit-memory persistence without changing Pi's runtime role.

## Context

DJ Claw proved a useful music production and radio loop while running inside OpenClaw.

Its main conversational entry was Telegram through the OpenClaw Gateway.

Moondog has a broader product thesis and must own personal music memory, an evidence-backed profile, recommendation, playlist collaboration, and bounded creative tools.

Those states must remain stable when the client, LLM provider, or gateway changes.

The first client is now a local CLI with a simple TUI.

## Decision

Moondog will not use OpenClaw as its core runtime.

Moondog will use three released Pi packages behind Moondog-owned adapters:

- `@earendil-works/pi-agent-core` for the classic `Agent` loop, streaming events, and tool-call lifecycle.
- `@earendil-works/pi-ai` for LLM provider and model adaptation.
- `@earendil-works/pi-tui` for the terminal interface.

All three packages are pinned exactly to `0.84.3`.

Moondog follows a Pi-first baseline rule.

Generic agent-loop, provider, model-catalog, authentication, streaming, editor, and terminal-selection behavior should reuse Pi's released public surfaces before Moondog adds custom behavior.

Moondog-specific work starts at the product harness, music-domain capabilities, context construction, evidence boundaries, and interaction choices that distinguish the product.

Adapters around Pi should remain thin enough that future Pi improvements can replace local glue without a migration project.

Moondog will not depend on `@earendil-works/pi-coding-agent`.

Moondog will not fork Pi.

Moondog will not use the current experimental `AgentHarness` as its runtime because its public operation surface is still an explicit scaffold that throws `HarnessNotImplemented` for unfinished paths.

OpenClaw may return later as an optional Telegram, Gateway, delivery, and scheduler adapter.

The existing DJ Claw deployment remains a legacy reference and is not changed by this decision.

## Ownership

| Concern | Canonical owner |
| --- | --- |
| Music entities, events, snapshots, and provenance | Moondog |
| Personal music profile and evidence | Moondog |
| Explicit long-term memory and revisions | Moondog |
| Conversation sessions and summaries | Moondog |
| Capability registry, policy, confirmation, budget, invocation, and receipt | Moondog |
| Spotify, Apple Music, knowledge, and generation connectors | Moondog |
| LLM streaming and model protocol adaptation | Pi adapter |
| Terminal rendering and input editing | Pi TUI adapter |
| Telegram ingress, delivery state, and optional scheduling | Future OpenClaw adapter |

Pi types must not cross into profile, memory, policy, connector, or other domain modules.

An OpenClaw session key must not become the canonical Moondog session or subject identity.

OpenClaw generic memory must not maintain a second copy of the user's music profile.

## Runtime Shape

```text
CLI TUI                       future Telegram
   |                                |
   |                         OpenClaw adapter
   |                                |
   +------ ConversationApplication--+
                    |
          Context and retrieval
           /        |        \
      Profile     Memory    Knowledge
                    |
        Capability registry and policy
                    |
        Invocation, executor, receipt
                    |
       Spotify, library, playlist, generation
                    |
              Pi Agent adapter
```

The Pi `AgentTool` interface is an adapter for a Moondog capability, not the capability registry itself.

`beforeToolCall` can perform runtime preflight, but every real executor must still pass through the Moondog capability runner so that non-Pi entry points cannot bypass policy.

`afterToolCall` can bridge results into `ToolReceipt`, but Pi's transcript is not the canonical audit store.

## Memory and Profile

Moondog distinguishes four different concepts.

1. A conversation transcript records messages in one session.
2. A session summary exists to compress conversational context.
3. Long-term memory contains explicit, revisable user facts, goals, preferences, and constraints.
4. A music profile is a versioned materialization derived from authorized observations, events, feedback, and corrections.

A transcript or summary must not automatically become long-term memory.

A free-text persona must not become the canonical music profile.

Each model request should receive only the recent conversation, a compact profile projection, relevant explicit memories, and tool results needed for the current question.

Raw listening history and the complete private library must not be inserted into every model prompt.

### Implemented A2-thin Memory Boundary

The first memory slice stores Moondog relationship state in a local SQLite database under the user's state directory, outside the repository by default.

The local TUI uses the stable route key `local:main`.

Its active logical session resumes across process restarts and model or authentication changes, while `/new` closes that session and starts another.

The canonical stored transcript contains only completed user and assistant exchanges.

Aborted turns, raw tool traces, and prompt-local candidate IDs do not become stored dialogue history.

Each completed exchange also creates a typed short-term dialogue episode.

The context builder can retrieve bounded recent episodes, dialogue from earlier sessions, and active durable claims relevant to the current request.

Memory mutations requested by the model remain prompt-local until the authoritative user and assistant exchange commits in the same SQLite transaction.

An aborted or failed prompt therefore commits neither its staged memory mutation nor its canonical dialogue exchange.

The user can create an explicit fact, preference, constraint, or goal with `/remember`, inspect it with `/memory`, and mark it forgotten with `/forget`.

`/remember` records an `explicit_assertion` episode, promotes it into a durable claim, and keeps the supporting episode-to-claim reference.

`/forget` records a retraction episode before deactivating the claim, so the relationship change has provenance without retaining the claim as active context.

Durable claims are revisable relationship memory, not immutable truth.

Moondog borrows this resumable-session, recent-context, and explicit-memory experience spine from OpenClaw while retaining Pi as the agent runtime, model adapter, and TUI substrate.

It does not adopt the OpenClaw Gateway as the core runtime or make an OpenClaw workspace the canonical store.

The interactive slice intentionally has no embedding index, continuously running dreaming process, or automatic Spotify-to-Profile promotion.

Canonical music preference remains `TasteEvent` and Profile domain state rather than a generic memory claim.

An explicit conversational preference may help immediate recall, but it must not silently materialize or override an evidence-backed music profile.

### Implemented One-shot Memory Agent

Moondog provides `moondog memory reflect [--dry-run] [--json]` as the single entry point for background reflection work.

The worker checks for pending episodes before creating a Pi runtime.

If no work exists, it exits without loading a model, requiring authentication, or making a model request.

Each working invocation creates a fresh dedicated Pi `Agent` with no conversation persistence and exactly one structured submission tool.

The agent must cover the exact supplied episode batch in one submission and cannot execute general Moondog capabilities.

One batch contains at most 24 active, unexpired episodes whose promotion state is still `none`.

The SQLite `reflection_runs` table is the canonical lease and checkpoint record for the batch, worker version, model, proposals, counts, outcome, and timestamps.

Only one unexpired run lease may be active, and an expired lease is marked failed before another batch begins.

A model, validation, or worker failure marks the run failed while leaving its episodes unprocessed and eligible for retry.

A dry run records its normalized proposals with status `dry_run` but does not change episode promotion states.

A completed non-dry run automatically promotes only `candidate_memory` proposals with `assertion_mode=explicit` and confidence greater than or equal to `0.9`.

Host-side promotion guards reject persistence from time-bounded or expired episodes.

They also prevent a forgotten claim from being resurrected and leave an exact-text kind or horizon conflict in candidate state.

Inferred `candidate_memory` proposals and all `candidate_music_profile` proposals advance only to candidate state.

An `ignore` proposal marks transient or non-durable source episodes rejected without creating a claim.

Memory status exposes pending episodes, candidate episodes, the latest reflection run, and a health state of `running`, `stale`, `degraded`, or `ready`.

No launchd schedule is installed by this amendment.

The project will evaluate manual reflection behavior before scheduling it, and any future scheduler will invoke the same one-shot command rather than create a separate reflection implementation.

## Apple Music Contract Gap

The current Apple Music importer correctly creates provisional `TrackRef` records and aggregate track snapshots.

It correctly creates zero `ListeningEvent` and zero `TasteEvent` records.

The current `ProfileEvidence.basis_refs` accepts only `ListeningEvent` and `TasteEvent` records.

Therefore the Apple Music snapshot cannot yet produce valid `ProfileEvidence`.

Moondog must add a provider-neutral library or track-state observation contract and an explicit profile revision model before materializing the first personal profile.

Moondog will not turn play counts, last-played fields, Loved, Favorited, ratings, or library membership into fabricated historical events.

The A1 plan supersedes only the sequencing requirement for a complete profile revision model.

`LibraryTrackObservation v1` and `ProfileEvidence v2` now close the minimum evidence-basis gap for a disposable `ProfileProjection v0`.

Profile claim, revision, feedback, and correction contracts remain deferred, and the zero-event rule remains unchanged.

## First CLI Slice

The first committed slice is intentionally safe and diagnostic.

It provides a Pi TUI using `TuiMainScreen`, local slash commands, aggregate Apple Music source status, profile and memory readiness, a capability catalog, and a local doctor command.

Free-text conversation activates only after an explicit TUI model selection or equivalent environment override.

The model receives only a minimal runtime context and can call read-only diagnostic tools.

Spotify writes, paid generation, publishing, deletion, external messages, and credential-bearing tools remain disabled.

Conversation persistence, long-term memory, profile materialization, private library search, and playlist planning remain subsequent vertical slices.

That paragraph records the original first committed slice.

A1 now enables bounded private-library search, compact profile summary, evidence explanation, and pure in-memory playlist planning when the validated local projection is ready.

The same planner now accepts prompt-local rediscovery, historical-return, and chronological Time Machine candidate sets while exact provider identity remains inside the host.

These tools remain behind Moondog-owned domain interfaces and a descriptor-driven safe-effect allowlist.

Tool-loop preview text is replaceable so a validated playlist plan becomes the only final plan visible in the TUI.

Completed prompt history retains the visible user and assistant exchange while removing prompt-local candidate IDs and raw tool traces, and aborted or exceptional turns are discarded.

A2-thin now supersedes the original slice's lack of conversation persistence and long-term memory.

It adds only the local memory boundary described above and does not yet add persistent playlist drafts or Profile correction contracts.

## Authentication Boundary

Moondog supports Pi's `openai-codex` provider through an explicit `moondog auth login openai-codex` OAuth flow.

This authorization belongs to Moondog and is intentionally separate from the Codex CLI and ChatGPT desktop credential caches.

Moondog does not parse or copy `~/.codex/auth.json`, and `moondog auth logout openai-codex` removes only Moondog's credential.

The credential store is selected from `MOONDOG_CONFIG_HOME`, then absolute `XDG_CONFIG_HOME`, then `~/.config/moondog`.

On POSIX systems, the store creates or requires a private `0700` directory and a `0600` credential file.

Credential updates use same-directory atomic replacement and a cross-process lock so OAuth refresh-token rotation cannot race across Moondog processes.

Symlinked credential paths, foreign ownership, malformed documents, unknown providers, and unexpected credential fields fail closed.

Status output reports only provider, storage state, and credential type, and it does not refresh or print bearer credentials.

Moondog persists the user's explicit provider and model selection separately from credentials.

The TUI reads Pi's built-in provider and model catalog through `/model` and starts OpenAI Codex login through `/auth`.

`MOONDOG_PROVIDER` and `MOONDOG_MODEL` remain non-interactive runtime overrides.

## Why OpenClaw Is an Adapter

OpenClaw already uses `@earendil-works/pi-tui` for its own TUI and then adds a long-running Gateway, channels, sessions, authentication, scheduling, plugins, sandboxing, and delivery machinery.

This means OpenClaw and Pi are not equivalent alternatives at the same layer.

Direct Pi usage gives the CLI the needed lower-level substrate without making the Moondog product a special case inside a general Gateway system.

OpenClaw remains valuable when Telegram, always-on delivery, or unattended scheduling becomes a concrete requirement.

## Security Consequences

Pi explicitly does not provide a built-in permission system for filesystem, process, network, or credential access.

Moondog must preserve its own fail-closed `CapabilityPolicy`, `ToolInvocation`, and `ToolReceipt` boundary.

Model-provided actor, subject, permission, account, confirmation, or budget fields are untrusted.

Those values must come from trusted runtime context and the capability registry.

External effects remain disabled until policy evaluation, confirmation, budget reservation, idempotency, execution, and receipt persistence form one tested path.

## Dependency Policy

Pi is a fast-moving `0.x` project.

The three Pi packages must upgrade together and remain exact versions in the lockfile.

Every upgrade requires the Pi adapter compatibility tests and a real terminal smoke test.

The repository now requires Node `>=22.19.0`, matching Pi `0.84.3`.

The audited local runtime used Node `24.18.0`.

Pi is MIT licensed and is consumed as a dependency.

No Pi or OpenClaw source code was copied into this slice.

## Primary Sources

- [OpenAI Codex authentication](https://learn.chatgpt.com/docs/auth)

Pi was audited at commit [`dcd461925db2edf69a43c8135db1180d418afd54`](https://github.com/earendil-works/pi/commit/dcd461925db2edf69a43c8135db1180d418afd54), with published release [`v0.84.3`](https://github.com/earendil-works/pi/releases/tag/v0.84.3).

- [Pi Agent quick start](https://github.com/earendil-works/pi/blob/dcd461925db2edf69a43c8135db1180d418afd54/packages/agent/README.md#quick-start)
- [Pi Agent tool and hook types](https://github.com/earendil-works/pi/blob/dcd461925db2edf69a43c8135db1180d418afd54/packages/agent/src/types.ts)
- [Pi AgentHarness scaffold](https://github.com/earendil-works/pi/blob/dcd461925db2edf69a43c8135db1180d418afd54/packages/agent/src/harness/agent-harness.ts)
- [Pi TUI documentation](https://github.com/earendil-works/pi/blob/dcd461925db2edf69a43c8135db1180d418afd54/packages/tui/README.md)
- [Pi permission boundary](https://github.com/earendil-works/pi/blob/dcd461925db2edf69a43c8135db1180d418afd54/README.md#permissions)
- [Pi license](https://github.com/earendil-works/pi/blob/dcd461925db2edf69a43c8135db1180d418afd54/LICENSE)

OpenClaw memory was revalidated at commit [`03a7e5b000c444ef6d8fa439e945f7ca22bb93d3`](https://github.com/openclaw/openclaw/commit/03a7e5b000c444ef6d8fa439e945f7ca22bb93d3).

- [OpenClaw SQLite agent schema](https://github.com/openclaw/openclaw/blob/03a7e5b000c444ef6d8fa439e945f7ca22bb93d3/src/state/openclaw-agent-schema.sql)
- [OpenClaw memory](https://docs.openclaw.ai/concepts/memory)
- [OpenClaw memory architecture](https://docs.openclaw.ai/concepts/memory-architecture)
- [OpenClaw session management and compaction](https://docs.openclaw.ai/reference/session-management-compaction)
- [OpenClaw dreaming and short-term promotion](https://docs.openclaw.ai/concepts/dreaming)
- [OpenClaw Telegram channel](https://docs.openclaw.ai/channels/telegram)
- [OpenClaw sandbox and tool policy](https://docs.openclaw.ai/gateway/sandbox-vs-tool-policy-vs-elevated)

The public boundary between Moondog and its private predecessor is recorded in [`DJ_CLAW_LINEAGE.md`](DJ_CLAW_LINEAGE.md).
