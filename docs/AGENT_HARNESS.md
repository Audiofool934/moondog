# The agent harness

Design date: 2026-11-03.
Status: the rules Moondog's tools follow so that every supported model completes everyday requests, with the first slice shipped and the next slices named.

Moondog runs on many models: DeepSeek, OpenAI, Anthropic, Google, Moonshot, Z.ai, xAI and others through OpenRouter.
A request such as "play this song" must work on each of them, not only on the strongest.
The harness is the code around the model: its tools, their arguments and results, the instructions, and the checks the host makes.
This document records how the harness keeps the model's part small, and how it measures success per model.

## Rules

1. **One intent, one call.**
   A request the listener makes in one sentence should take one tool call.
   The host does the steps that need no judgment: search, match, play and verify.
2. **Names in, names out.**
   The model passes what the listener said (a title and an artist), not an opaque ID it must copy.
   References remain for choosing among results the model has already seen.
3. **Never guess silently.**
   When the host cannot match a request clearly, it plays nothing and returns its closest results to choose from.
   A wrong song reported as a success is worse than one more call.
4. **Repair mistakes with one reading, refuse the rest.**
   The host fixes argument mistakes that have one clear meaning before validation, such as "play" for "resume" or one song where a list is asked for.
   It never drops an unknown key in general, because a key can carry a meaning the tool must refuse.
5. **Errors name the fix.**
   A refused call says what to change, so the model can correct it in one try.
6. **The model knows its own setup.**
   The model can read which model answers, which service plays and which language it replies in, and it changes the settings the listener may change by asking.
   A setting asked for in words holds, as if it was chosen in the settings.
7. **Measure per model, repeatedly.**
   A change is judged by the playback evaluation on each model, with several runs per scenario, not by one model or one run.

## What follows from the rules

| Rule | In the code |
| --- | --- |
| One intent, one call; names in | `moondog_spotify_player_control` takes `songs: [{title, artist}]` with action `resume`; `MoondogApplication.spotifyResolveSongs` searches and matches each song. Apple Music (`moondog_music_preview`) and NetEase (`moondog_netease_play`) already took songs by title and artist. |
| Never guess silently | A song without a clear match comes back as `not_found` with `not_sent: true` and up to five candidates with `item_ref_id`. The match needs the artist, then the exact title, the same song in another version, or a title that starts with the one asked for. A title in the other Chinese script (被动 for 被動) is not guessed: it comes back as a candidate. |
| Repair with one reading | `src/runtime/pi/tool-arguments.mjs` runs as Pi's `prepareArguments` step before validation. |
| The model knows its setup | `moondog_settings` reads the model, the music service and the reply language, and sets the reply language. `moondog_playback_service` changes the music service. A reply language asked for in words holds whatever language the listener writes in, until the picker or `/language` chooses another. |
| Measure per model | `scripts/eval-spotify-playback.mjs` runs everyday requests against a simulated Spotify. Each tool call in the local trace records its provider and model, so a real failure can be traced to the model that made it. |

## Evaluating a change

Run the playback evaluation for each model with a key on the machine:

```sh
MOONDOG_PROVIDER=deepseek MOONDOG_MODEL=deepseek-flash node scripts/eval-spotify-playback.mjs --runs 3 --out <folder>
```

The report lists each scenario's passes, tool errors and turn times, and every call and reply of each run.
Nothing reaches a Spotify account, and the script checks that the listener's settings stay unchanged.
Add a scenario for each real failure a listener reports, written as the listener said it.

## Measured results

The playback evaluation on 2026-11-03, against a simulated Spotify, three runs per scenario:

| Model | Before (14 scenarios) | After, first run (22 scenarios) | After the fixes below (22 scenarios) |
| --- | --- | --- | --- |
| DeepSeek V4.1 Flash | 39/42 | 62/66 | 66/66 |
| DeepSeek V4 Pro | not run | 59/66 | 66/66 |

Before the change, every failure was the same: the listener recalled a duet version, and the model described it without playing it.
The first run after the change found four harness problems, which the last column includes fixes for:

- Italian such as "sposta la musica sul PC" read as Spanish, so the host asked for a Spanish reply.
- After Spotify refused a device move both ways, the error did not say to stop, and the model tried a third way.
- A queue pick skipped as a duplicate left the batch one song short, with no way to fill it.
- The evaluation itself read English replies with Chinese song names as Chinese.

Two failures in that run were the model's alone, and no harness change targets them: once a reply claimed a skip without calling the tool, and once a Spanish request got a Chinese reply.
A clean run is evidence, not proof of 100%: rerun the evaluation for each change and each model.
Claude and OpenAI models were not run, because this Mac had no usable key for them at the time.

## Sources

- Anthropic, [Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents): merge tools called in sequence, return readable names rather than IDs, and write errors that name the fix.
- Anthropic, [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents): shape arguments so mistakes are hard to make.
- Anthropic, [Tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool): tool choice degrades past 30 to 50 tools; defer the rest.
- OpenAI, [Function calling](https://developers.openai.com/api/docs/guides/function-calling): fewer than about 20 tools at the start of a turn, combine functions always called in sequence, and do not ask the model for what the code knows.
- OpenAI Codex, [model capability profiles](https://github.com/openai/codex/blob/main/codex-rs/models-manager/src/model_info.rs): tools chosen per model, with a conservative default for unknown models.
- Nous Research, [Hermes Agent](https://github.com/NousResearch/hermes-agent): toolsets, provider-specific schema rewriting, and host-side repair of bad tool calls.
- DeepSeek, [Tool calls](https://api-docs.deepseek.com/guides/tool_calls) and [thinking mode](https://api-docs.deepseek.com/guides/thinking_mode): strict mode is beta, and reasoning must be passed back while tools are in use. Pi passes it back.
- Yao et al., [τ-bench](https://arxiv.org/abs/2406.12045): reliability is the chance of succeeding on every one of k tries, not once.

## Next slices

- **Fewer tools per turn.**
  A turn declares about 35 tools and a system prompt of about 41,000 characters.
  Keep a small core always declared, and load rare tools and their instructions on demand.
- **A schema adapter per provider.**
  Declare each tool once and translate it for each provider's strict mode and schema subset.
- **A profile per model.**
  Record per model what it supports (strict schemas, tool search, examples) and how many core tools it gets.
- **More settings by words.**
  Extend `moondog_settings` to further settings a listener changes in the window or the terminal.
