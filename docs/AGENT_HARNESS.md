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
7. **History shows how actions were done.**
   A finished turn keeps its calls that changed something, each with a one-line outcome.
   A history of replies alone teaches a model that saying an action does it.
8. **Measure per model, repeatedly.**
   A change is judged by the playback evaluation on each model, with several runs per scenario, not by one model or one run.

## What follows from the rules

| Rule | In the code |
| --- | --- |
| One intent, one call; names in | `moondog_spotify_player_control` takes `songs: [{title, artist}]` with action `resume`; `MoondogApplication.spotifyResolveSongs` searches and matches each song. Apple Music (`moondog_music_preview`) and NetEase (`moondog_netease_play`) already took songs by title and artist. |
| Never guess silently | A song without a clear match comes back as `not_found` with `not_sent: true` and up to five candidates with `item_ref_id`. The match needs the same artist (equal names, or one credited artist of a joint credit; "Adele Tribute Band" is not Adele), then the exact title, or the same song in another version when the listener named no version. A version asked for must match as named, and a title that only starts the same way is another song. A title in the other Chinese script (被动 for 被動) is not guessed: it comes back as a candidate. |
| Repair with one reading | `src/runtime/pi/tool-arguments.mjs` runs as Pi's `prepareArguments` step before validation. |
| The model knows its setup | `moondog_settings` reads the model (with the listener's model menu), the music service and the reply language. It sets the reply language, and it switches to another signed-in model from the menu, which the window or the terminal applies when the reply ends (`src/runtime/pi/model-switch.mjs`). `moondog_playback_service` changes the music service. A reply language asked for in words holds whatever language the listener writes in, until the picker or `/language` chooses another. |
| Replies in the chosen language | `src/runtime/pi/reply-language.mjs`: a final reply clearly in another language than the one chosen for the message is restated once by the same model, without tools. A few Chinese names among more Latin words are names, not the reply's language. |
| History shows actions | `compactCompletedPromptHistory` keeps the turn's play, queue, move, make and settings calls with "Done." or "Failed."; reads and their results leave the history as before. |
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
The first run after the change found these harness problems, which the last column includes fixes for:

- Italian such as "sposta la musica sul PC" read as Spanish, so the host asked for a Spanish reply.
- After Spotify refused a device move both ways, the error did not say to stop, and the model tried a third way.
- A queue pick skipped as a duplicate left the batch one song short, with no way to fill it.
- The evaluation itself read English replies with Chinese song names as Chinese.

One failure looked like the model's alone: a reply claimed a skip without calling the tool, in 3 of 9 runs on V4 Pro.
Its cause was the harness: finished turns kept only their reply text, so the history showed actions done by words alone.
Keeping those calls in the history took the scenario to 8 of 8 runs on V4 Pro.
Once, a Spanish request got a Chinese reply; a reply clearly in another language is now restated once in the chosen one.
A clean run is evidence, not proof of 100%: rerun the evaluation for each change and each model.
Claude and OpenAI models were not run: the owner judged them able to handle Moondog's tools, and the point is the models other listeners use.

### Other models (2026-11-03)

Keys came from the Hermes Agent on the same Mac, in a throwaway Moondog config folder (`MOONDOG_CONFIG_HOME`), so the listener's settings were never touched.

| Model | Provider | First run (23 scenarios × 3) | After the fixes below (23 × 1) |
| --- | --- | --- | --- |
| GLM 5.3 Flash | Z.ai | 69/69 | 23/23 |
| Hunyuan hy4-preview | Tencent TokenHub | 69/69 | 21/23, then 6/6 on the scenario that failed |
| Qwen 3.8 Max | Alibaba Bailian (US) | 67/69, both failures Alibaba's content filter | 23/23 |
| MiniMax M3 | MiniMax China | 66/69 | 19 of 20 answered runs passed; the account then ran out of balance |
| Kimi K3 | Moonshot China | not measured at first: the account allows 3 requests a minute and 1 at a time | 18/23 with `MOONDOG_EVAL_REQUEST_INTERVAL_MS=21000`; 2 network resets, 2 low-balance refusals, 1 invented reference it recovered from |
| DeepSeek V4.1 Flash | DeepSeek | 69/69 | 23/23 |

The models' failures pointed at the harness, not only at the models:

- MiniMax leaked its own tool-call markup into the arguments (`"/invoke": …`); repair now drops keys that are no identifier.
- A queue batch that came up short could not be filled by a single add of the missing song; it can now, one per missing song.
- One mistyped reference made a whole queue batch fail; the usable references are now queued and the others counted.
- Hunyuan quoted "HTTP 403" to the listener; the status in a tool error is now labelled as diagnosis only.
- The simulated Spotify lacked the saved tracks and albums endpoints.

Doubao Seed 2.1 (Volcengine) could not be reached from this Mac at the time, directly or through its proxy.
An account with a low request limit is measured with `MOONDOG_EVAL_REQUEST_INTERVAL_MS`, which sends model requests one at a time, at least that many milliseconds apart.

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

- **Fewer tools per turn, only with evidence.**
  A turn declares about 35 tools and a system prompt of about 41,000 characters.
  The sources put the point where tool choice degrades at 30 to 50 tools, and the evaluation has found no wrong-tool failure at 35.
  Deferring tools behind a search adds a step every model must get right, so it waits for a measured tool-choice failure.
- **A schema adapter per provider.**
  Declare each tool once and translate it for each provider's strict mode and schema subset, when a provider's schema rules break a call.
- **A profile per model.**
  Record per model what it supports (strict schemas, tool search, examples) and how many core tools it gets.
- **More models measured.**
  Run the evaluation on Claude, OpenAI and Gemini models once their keys are on the machine.
