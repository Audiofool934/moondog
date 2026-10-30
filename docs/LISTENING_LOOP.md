# The listening loop

Design date: 2026-10-25.
Status: the design behind Moondog's agent harness, with the first slice shipped and the next slices named.

Most music assistants keep one picture of the listener: a profile, a chat memory, or a list of top artists.
Moondog keeps six things, and it does not let one turn into another.
Each has its own writer, its own lifetime, and its own level of trust.
The agent reads all six on every turn, and the host enforces the ones that must hold.

This document records the design, the research behind it, and the limits of each part.
It complements the [listener profile harness research](LISTENER_PROFILE_HARNESS_RESEARCH.md), which covers how the reading is built, and the [runtime architecture](ADR_0001_AGENT_RUNTIME_AND_CLI.md), which covers how the pieces run.

## Six layers

| Layer | What it holds | Who writes it | How long it lasts | How the agent may use it |
| --- | --- | --- | --- | --- |
| The reading | Enduring taste: threads, scenes, smaller interests, curated music | The profile builder, from the evidence | Until the next revision | As taste up to its listening date, never as a current mood |
| Movement | How each artist's place in the listening changed across the years | Code, from play timestamps | Recomputed with the evidence | As an observation of plays, never as liking or dislike |
| Recent attention | What the listener played in the last four weeks | Imports, the recent-play sync, Spotify's short-term top artists | Rolling | As the present, when it disagrees with the reading |
| Choices | Like and Avoid for artists and tracks | Only the listener, in the profile or in their own words in chat | Until the listener changes it | Always visible to the model; Avoid is enforced by code on every play path |
| The moment | The current request, and the listener's local day and hour | The listener's message and the host's clock | One conversation | To shape an open request, never as a preference |
| Moondog's suggestions | What Moondog itself chose and queued or played, and which of those the listener later chose again | The host, from accepted receipts only, leaving out songs the listener named | Kept with the listening history | As outcome evidence; never counted as the listener's own attention |

The line between layers is the point of the design.
A play that Moondog started is not the listener's attention.
A faded interest is not a dislike.
A late-night request is not a lasting preference.
A choice the listener states is not an inference, and an inference never becomes a choice.

## Why each layer exists

### Choices must be restated and enforced, not described

In PrefEval, models followed a stated preference less than 10% of the time after about 10 turns.
A plain reminder of the preference raised one model from 13% to 99%, which beat self-critique and chain-of-thought ([PrefEval, ICLR 2025](https://arxiv.org/abs/2502.09597)).
Ramos and colleagues found that editing a natural-language profile to add a preference changed recommendations, but editing it to negate one barely moved them ([Ramos et al., 2024](https://arxiv.org/abs/2402.05810)).

So Moondog restates every active choice in every turn's context, including in the moment just after a correction, when the saved reading is out of date.
Avoid is not left to the prompt.
One host function matches it against every credited artist of every song Moondog sends, including collaborations such as "A feat. B".
A listener who says "never play this again" in chat can make that choice in their own words; the host checks that the words are the listener's before it records anything.
The quote must name the artist or the title, or point to what is playing or was just named, near or far, in each supported language ("this", "that", "him", "这首", "那首", "この", "あの", "그거", "spiel das", "eso", "quella"), and one message saves at most three choices.
Articles that double as pronouns (das, la, le, lo) count only in pointing phrases such as "spiel das" or "no lo pongas", so "je n'aime pas le jazz" binds nothing.
A Latin name written straight into Chinese, Japanese or Korean text counts, as in "我不想再听Coldplay了", because a change of script ends a word, and a band can be named without its leading article.
When the gate blocks a play, the tool refuses it, and the agent tells the listener that they asked to keep it out and offers to lift the Avoid.
A saved plan is checked again when it plays, queues or is saved, and it reads each credit as the candidate check did, so "Earth, Wind & Fire" stays one artist.
A plan song avoided since the plan is left out and named under the reply, and the rest goes through; only a plan with nothing left is refused.

### Movement is the part of taste that a ranking hides

A lifetime ranking shows an artist who fell from 500 plays a year to 8 as an artist near the top.
That was the remaining known gap in the first-build quality target.
The per-artist yearly counts were already computed and then dropped.

Moondog now keeps a short yearly series for each leading artist, the first and last play, a recency-weighted activation, and a deterministic label: rising, steady, fading, returning, burst, or unknown.
The activation is ACT-R's base-level learning equation: the log of the sum over plays of age to the power -0.5.
In studies of Last.fm histories, it was the strongest single predictor of what a person plays again ([Reiter-Haas et al., 2021](https://arxiv.org/abs/2108.02138)).
It is measured from the date of the latest stored play, not from today, so an old archive does not read as one long fade.
Sparse years and aggregate library play counts give unknown, not a guess.

The labels describe plays.
They do not say why the listening changed, and they never stand for liking or dislike.

### The agent must not learn its own picks as the listener's taste

Plays that Moondog queues come back through the recent-play sync, and later through a Spotify export, as ordinary plays.
Without a mark, a heavy week of agent queues becomes "recent movement", and after enough plays it can reach the enduring reading.
OpenClaw's memory design states the general rule: a fact recalled one hundred times stays one fact ([OpenClaw memory architecture](https://docs.openclaw.ai/concepts/memory-architecture)).

Moondog keeps a ledger of what it started, written only from accepted receipts.
A song is Moondog's only when Moondog chose it.
A song the listener named in their current message or the two before it is their own choice, and it never enters the ledger.
Named means that one message names the title together with one of the song's credited artists ("play Pink Moon by Nick Drake", "放周杰伦的晴天"), or puts the title in quotes, including 「」, 『』 and 《》.
The rule applies song by song on every service and every path, queue batches included, so the songs a listener dictated stay theirs and Moondog's fill-ins stay Moondog's.
A mood word that happens to be a title ("a rainy day", "home", "安静") names nothing.
When the profile counts attention, plays that match a suggestion by track, ISRC, title and artist, or release, from one minute before it to six hours after it, count as Moondog's, apart from the listener's own.
Spotify records a play when it ends, so the minute before only absorbs clock skew.
The match runs when the profile is computed, so the stored history is never rewritten and a later export is handled the same way.
A later play of the same song, outside that window, is the listener's own choice; the ledger shows that suggestion as adopted.
Adoption is outcome evidence, not proof of liking, and it does not enter the reading as taste.
A track Moondog made on this Mac goes in the same ledger with the service moondog, the action generated.play and its own id, with no artist and no song key, so it can never claim a play of a real song.

The ledger also lets the agent see what it already suggested.
Language models repeat themselves across sessions: one study measured an effective diversity of about 0.2 to 0.3 across five samples for strong general models ([WeMusic-Agent, 2025](https://arxiv.org/abs/2512.16108)).

### Curation is a mix, and the listener should see it

Most listening is repetition.
In a Spotify experiment with 15 million users, moving a session from no discovery to about 10% discovery kept satisfaction, while much more cost it ("Algorithmic balancing of familiarity, similarity and discovery in music recommendations", Spotify, CIKM 2021).
People also tend to pick familiar music more than their stated wish for novelty predicts, more so when busy.
Studies of calibrated recommendation found that people seldom notice a balanced list unless the system says so.

So the host classifies each queued or planned song from the listener's own plays: one they know well, one back after a while, one they heard once or twice, a new song from an artist they know, or new to them.
It writes the blend in one plain line under the receipt, for example "The mix: 4 you know well, 2 back after a while, 6 new to you."
The line appears under Spotify queues and plans, and under Apple Music and NetEase plays of more than one song.
Knownness ignores version suffixes, so a remaster is not new music.
The model still chooses the songs; the host makes the blend visible and true.

### The moment shapes a request without becoming taste

Requests carry a situation: late at night, a weekday morning, "for work".
The host now gives the agent the listener's local day, hour, and part of the day.
The clock can shape an open request.
It is not a preference, and the listener's words always win.

### The context is engineered for attention and cost

The trusted context goes in front of the history on every model request, including each step of a tool loop.
If it changes between steps, a provider's prompt cache cannot reuse the history after it ([Manus, context engineering](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)).
A millisecond timestamp in that context changed it on every step.
The context is now byte-stable within a turn unless the state really changed, the clock changes at most once an hour, and recalled conversation turns are clipped instead of carrying replies of up to 20,000 characters.

## What the layers cannot know

The dark side of the moon applies to every layer.

- The reading and the movement see stored plays, saves, and choices; they cannot see why a person listened or what the music meant.
- Recent attention covers only the sources that were imported or connected; a gap in the records is unknown, not silence.
- Spotify's own four-week ranking of top artists includes plays Moondog started; the ledger cannot take them out, so only the stored plays count Moondog's plays apart.
- Movement labels describe yearly plays as of the latest stored listening, which can be long before today; the movement note carries that date, and recent attention says what is happening now.
- Moondog's suggestions are matched by track identity and time; a song that the listener chose themselves outside Moondog, inside the window, can be counted as Moondog's, and the code records how each match was made.
- A title alone with no artist and no quotes ("play Pink Moon") is not a name, so that song counts as Moondog's pick; requiring the artist or quotes is what keeps mood words from claiming Moondog's picks for the listener.
- The mix line counts plays, not love; from stored plays, "you know well" means at least three of the listener's own plays, one of them within a year of the latest, and that is the most it claims.
- In Apple Music sessions, "you know well" can also come from a library play count of three or more; that count has no dates and can include plays Moondog started, so it makes no claim about recency.
- On Spotify, an album or a playlist context, and a single song that Moondog starts inside its album, go on to play songs that the Avoid gate never sees; the gate checks only the songs Moondog sends and the album's own artists.
- A Like or Avoid from chat is saved when the agent records it, so it stays in force when the listener cancels the turn; a cancelled or interrupted turn still shows the host's line.
- The clock is the host's local time; it does not know where the listener is.

## What shipped on 2026-10-25

- The saved reading and every active choice stay in the agent's context after a correction, with the choices made since the reading listed apart and marked as winning.
- One Avoid gate checks every song Moondog sends: Spotify songs, queue adds, plan plays and playlist writes, Apple Music previews and songs, NetEase, similar-artist queues, and external candidate sets. It matches each credited artist, and a blocked play returns a refusal the agent explains. A plan leaves out a song avoided since it was made, names it, and sends the rest. Songs that a Spotify album or playlist context goes on to play are not checked.
- The agent can record a Like or an Avoid from the listener's own words in chat, with an exact-quote check that the quote names the artist or title, also inside Chinese, Japanese or Korean text and without a band's article, or points to what is playing or was just named in any supported language, at most three a message. The profile, the gate, and the context see it at once, and the host confirms it in its own line.
- Apple Music candidate sets from storefronts other than the United States are accepted.
- Artist rows carry first play, a yearly series, activation, and a trajectory label; the builder gets a movement section, the checker treats a faded interest called current as a material problem, and saved readings rebuild once.
- The agent can explore artists by trajectory and sees a compact movement view in the profile summary, with its reference date.
- A suggestions ledger records accepted queues, plays, and playlist writes of songs Moondog chose, on every service; a song the listener named by title and artist, or by a quoted title, in the current or two previous messages stays theirs, song by song, queue batches included. Moondog-started plays are counted apart from the listener's own attention, and adopted suggestions are marked.
- Discovery results say when a song was suggested before, queue batches skip a remaster of a song already queued, and Spotify queue and plan receipts and Apple Music and NetEase plays of more than one song carry a one-line mix.
- The trusted context is stable within a turn, has a listener clock, clips recalled turns, keeps saved facts in view, and recalls memories by whole words.
- The system prompt has a short curation craft section: start from an anchor the listener knows, shape an open set as a mix, let movement guide the choice, give a reason for each pick in a plan and name one or two highlights in a queue, and offer fewer songs in a queue or an open pick when the candidates do not fit. A playlist with a stated size keeps its size, or the agent asks before planning fewer.

The exact behavior and its tests are in the commits that introduced it.

### Evidence

A live run on 2026-10-25 used DeepSeek Flash on a fictional listener with ten years of history and planted traits.
The fresh build named the steady core, a faded former favourite, a returning artist, a one-year burst, and a rising artist.
It kept the plays Moondog started apart from the listener's own and named the two adoptions among them.
It invented no preferences.
One fictional listener and one model is not proof of stable quality.

## Next slices

These are the next steps in order of leverage.
None of them is started.

1. **The moment, as a card.** A host-owned card for the current conversation: the request, the situation, session-only likes and avoids, and what is queued. It expires after a few silent hours and never becomes taste. The memory store already has an expiring situational episode kind with no writer.
2. **Service rule packs.** About half of the system prompt is Spotify-specific and loads in Apple Music and NetEase sessions too, followed by an instruction to ignore it. Split the prompt into a service-neutral core and a pack per service on the existing session section, and move each one-off incident rule into a playback eval scenario before deleting it.
3. **Outcome signals.** A song that Moondog started and that changed within 30 seconds is a skip proxy; a song played to its end is a completion. The window player and the Music app poll already see these transitions. Keep them as outcomes of suggestions, never as dislikes.
4. **An open descriptor layer.** MusicBrainz artist tags cover about 92% of popular artists, and Wikidata links almost all MusicBrainz genres to a CC0 parent-genre and origin graph. Release-group dates give the era of the music, apart from the year it was played. Each descriptor needs its coverage, level, and license, and lookups of a listener's history need opt-in.
5. **A taste eval.** Fictional listeners with planted traits (an enduring core, a faded love, a saved but unplayed tail, a recent burst, Avoids on collaborations, agent-started plays) and deterministic checks on what the model receives, then one binary judge per material failure, calibrated by the owner.

## Owner decisions

- **Listening conversations and memory.** A Spotify read marks the whole conversation as transient, so a listening conversation leaves no episode and no turns in memory, including the listener's own words. Spotify's developer policy forbids ingesting Spotify content, which its terms define to include metadata, into an AI model ([Spotify Developer Policy](https://developer.spotify.com/policy)). A narrower line would keep the listener's text and host receipts with counts, and keep provider metadata out. That is a policy judgment for the owner, so this slice does not change it.
- **Spotify-verified tracks as playlist candidates.** This would remove a lossy detour through Apple and ListenBrainz search for Spotify playlists, but it puts more Spotify metadata in the model's context. It waits for the same decision.
