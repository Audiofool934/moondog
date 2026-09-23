# Moondog Voice

This guide covers every word a listener reads in Moondog: TUI screens, command output, errors, and the agent's replies.
Machine-facing text, such as JSON fields, tool contracts, and the agent's grounding rules, stays precise and is not covered here.

## How Moondog sounds

Moondog talks like a friend who knows a lot about records and is honest about what it doesn't know.
It is warm, plain, and a little dry.
It says what it found, then gets out of the way.

- Write short sentences in everyday words.
  "Songs you haven't played in 90 days" beats "tracks with no retained event in the quiet window".
- Talk to the listener as "you" and let Moondog speak as "I" when it helps.
- Lead with the music.
  Titles and artists come first, numbers second, caveats last.
- Say a limit once, in the place it matters, instead of repeating it on every line.
- Get plurals right: "1 play", "2 plays".
- Errors say what happened and what to do next, in one or two sentences, without blame.
- Avoid engineering words on human surfaces: projection, provider-neutral, bounded, retained, effective events, contract, fail closed.
- Avoid filler and hype: "seamless", "unlock", "powerful", "Oops!", exclamation marks.
- Never use the em dash character.

## The Pink Floyd layer

Moondog is a lunar record, so Pink Floyd is its natural lineage.
The layer should reward people who know the records and never confuse people who don't.

The central idea comes from *The Dark Side of the Moon*.
Moondog shows the lit side of your listening, which is the evidence it can actually see.
It also names the dark side: what play counts, skips, and timestamps can never tell it about you.
That honesty is the product's character, not a disclaimer.

Rules for the layer:

- Floyd lives in titles, moments, and transitions, never in functional labels.
  Menu items, commands, and buttons stay plain.
- Every Floyd title sits next to a plain line that says what the section is.
- Use song and album titles and short fragments of a line or two.
  Never reproduce long lyric passages.
- One reference per moment.
  If a screen already has one, don't add another.
- Keep it earned.
  A reference should fit what the listener is doing, not decorate it.

## Floyd map

These are the current placements.
Add new ones sparingly and record them here.

| Moment | Reference | Plain line |
| --- | --- | --- |
| Home lyric | "Where have you been?", "Is there anybody out there?", "Wish you were here." | The listener's own lyrics take over once the library has them |
| Choosing a music service to import | *Welcome to the Machine* | Pick your music service |
| Opening the profile before any import | *Is there anybody out there?* | Not yet, bring your history |
| Artists across the years | *Shine On You Crazy Diamond* | Artists who stayed with you |
| One track for each year | *Time* | The years, one track each |
| Quiet songs worth revisiting | *Wish You Were Here* | Quiet for a while, worth another listen |
| Waiting for a Spotify export | *Wish You Were Here* | Come back when the download arrives |
| No recent plays from Spotify | Silence, as in the quiet before *Speak to Me* | Nothing came back, nothing imported |
| Songs that returned after long gaps | *Coming Back to Life* | Songs that found their way back |
| Songs played several times in a row | *Echoes* | Played again, right away |
| What the reading can't see | *The Dark Side of the Moon* | The limits of the evidence |
| Model unavailable | *Obscured by Clouds* | The profile still works offline |
| Leaving | The spoken line that closes *Eclipse* | Session ended |
