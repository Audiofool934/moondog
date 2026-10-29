# Music Decentralization

## Status

Vision, not a commitment.
This document states where Moondog goes after the streaming-first product.
The roadmap in [ROADMAP.md](ROADMAP.md) stays the authority on current scope.
This document explains why streaming is a starting point, and what the later stages are.

Set down on 2026-10-26, after a discussion with the project owner.
Extended on 2026-10-29 with the hardware premise, the atmosphere stream, the taste compiler, and the continuum.
Revised the same day after a review of its claims.
Revised again the same day with the owner's definition of decentralization, the two loops back from listening, and the owner's decision on later plays of generated tracks.

## What decentralization means here

Here, decentralization means that the center moves from the platform to the listener.
Platforms become sources, and the listener's taste comes first.
The listener does not leave the platforms; they stop being bound to one or two of them.
They can still use Spotify, but their taste no longer lives inside Spotify.

One test applies to every stage: can the listener drop any one source and keep their center?
The center is the profile, the memory, and the receipts, kept on the listener's machine, with each item marked by its source.
A source that holds none of the center is a supplier, even when it is a closed service.

Moondog already passes this test inside streaming.
One profile draws on imports from Spotify, Apple Music, YouTube Music, QQ Music, NetEase Music, Last.fm, and ListenBrainz, and Moondog plays through Spotify, Apple Music, and NetEase Music.

Where Moondog can read one, the lever is the platform's own data export.
Spotify's history ZIP, YouTube Music's Takeout, an Apple Music Library.xml file, and a ListenBrainz listens file are such exports today.
Other sources come in on their own terms: Last.fm through its API, and QQ Music and NetEase Music through public playlist links.
The export gives the listener their own records, and in the EU, data portability is a legal right (GDPR Article 20).
A platform's Web API is different, because the platform's developer terms govern it.
So the export is the backbone of the center wherever one exists, and API data comes on the platform's terms (see Owner gates).

Two limits apply:

- The center is partly made by the platforms.
  The first profile comes from platform histories, and many of those plays were the platform's own recommendations.
  The listener's own judgment enters most clearly through choices and corrections.
- The center also changes over time.
  What the listener hears changes what they like, and Moondog is one of the things they hear (see [The loops back from listening](#the-loops-back-from-listening)).

## Why streaming is only the start

Streaming services gave Moondog a fast way in.
They hold the listening history and they reach many listeners.
Importing from them needs no music files or new hardware.
A full Spotify history export can still take up to 30 days to arrive.
But they limit the product in three ways:

- The audio lives on their platform.
  Listening is never free of the service.
- Deep analysis of the music itself stops where the platform stops.
  The agent can read metadata, but it cannot hear the recordings.
- The services carry their own problems: artist exposure, rights, and payouts.

Moondog's real assets are not the connectors.
They are the evidence-based profile, the correctable memory, and the rule that every claim shows its work.
They also include Moondog's character: a radio host with the listener's taste and a voice of its own, as [VOICE.md](VOICE.md) describes.
These assets are meant to carry over to a local library and to generated music.
For generated music, the evidence chain is still open (see Generative music).
Streaming is one evidence source among several, not the product.

## Three later stages

### 1. The local personal library

Some listeners own large collections that they have already digitized.
Thousands of tracks can sit on a hard drive with no system that understands them.
Moondog can close that gap.

Other players already analyze the sound of a local library.
Plexamp has done so since 2021: it maps local files by sound, builds radio from similar tracks, and walks from one chosen track to another.
None of them keeps a profile that shows its evidence, accepts corrections, and explains a pick against the listener's whole history.
Three capabilities let Moondog bring that profile to a local library:

- A general model with retrieval and world knowledge reduces the metadata problem.
  Acoustic fingerprints and MusicBrainz lookups identify the files.
  The model resolves ambiguous cases and reads cover art, liner notes, and scans.
  An identity that nothing can confirm stays unknown.
- Music embedding models such as MuQ-MuLan give the agent measured signals from the sound itself, not only words about the sound.
  These signals are similarity and descriptor scores, and the agent treats them as hypotheses.
  Tempo and key need a separate analysis pass.
- Moondog already has the profile, evidence, and correction machinery that no local library manager has.

The stage starts from the Apple Music Library.xml import that Moondog already has.
By design, that importer drops file locations and contacts no network service.
Analysis of the audio needs file paths and audio reads, and fingerprint lookups need the network.
So opening this stage changes the data policy, not only the scope.

The first cut is analysis and management.
Local-library playback stays with the operating system or an existing player until the owner decides otherwise (see Owner gates).
Fingerprinting for identification and duplicate detection, and fast scans of very large directories, are known engineering costs.

The comparison points are Roon and Plexamp.
Roon shows that some listeners pay for a library and playback system that knows their collection.
It already merges local files with TIDAL and Qobuz in one library, so its center is the collection rather than one service.
Roon's understanding stops at metadata, listening behavior, and signal measurements such as loudness and dynamic range.
Plexamp adds analysis of the sound.
Neither shows the evidence for a recommendation.
Moondog's center is the listener's taste, kept as a profile with its evidence.
So it can explain why an album fits a listener's trajectory.

### 2. Generative music

Generation enters as one more content source for the same system.

- A model guided by the listener's profile can make music for that listener.
- Stable Audio 3 is instrumental only.
  Sung songs need another model: an open local one such as ACE-Step 1.5, or a closed service whose prompts leave the machine.
  A closed service is then a source, not the center.
  Each prompt still carries part of the listener's taste to it.
  That costs privacy, but it does not bind the listener to the service.
- Moondog can also make music for itself as a radio host: station idents, music to play under its own voice, and records of its own.
  Moondog's own plays of this music stay out of the listener's taste, as the suggestions ledger keeps Moondog's picks apart today.
  Only the listener's own acts can bring one of these tracks into their taste, as for any generated track (see [The loops back from listening](#the-loops-back-from-listening)).
- Generated output is local by definition, so library management and the analysis stack treat it like any other library item.

The first milestone of this stage is one loop: generate, analyze, and recommend with evidence.
The open product question is the evidence chain.
A profile claim is trustworthy because it shows its evidence, and a generated track has no listening evidence yet.
The profile must keep "Moondog made this" separate from "the listener chose this", as the listening loop already does for agent suggestions.

The hardware premise for this stage is no longer hypothetical.
On 2026-10-29, Stable Audio 3 Medium, in Stability AI's optimized MLX build, made 380 seconds of audio in about 35 seconds on the project owner's Mac mini (Apple M6, 24 GB).
That is about ten times faster than real time, with a peak of 4.5 GB of memory as the tool reports it.
Stability AI's own table shows the same model at about twice real time on an 8 GB M1, for a 10-second clip.
Stability AI publishes the weights under its Community License (see Owner gates).
Generation throughput now exceeds consumption on ordinary hardware.

This makes an atmosphere stream possible: non-stop background music, composed locally and guided by the listener's profile and the time of day.
Every prompt is recorded as a receipt.
Because generation outpaces listening, the analysis stack can score several candidates before one plays, so recommendation applies to generated music too.
The candidates should differ in their prompts, not only in their seeds, so the scoring has real choices.
A non-stop stream comes close to the large undifferentiated feed that the charter's [Taste Over Volume](PRODUCT_CHARTER.md#taste-over-volume) principle warns against.
Scoring each candidate against the profile before it plays is what keeps the stream selected.
Whether a background stream fits that principle is an owner decision (see Owner gates).
The stream also needs a player for local files (see Owner gates).

Atmosphere music is the limit of disintermediation at run time: the music is made and heard on the same machine.
The supply chain does not vanish.
Training compressed it into the model's weights, and each further track costs almost nothing.
Open weights on the listener's machine are a frozen dependency, not a live center.
They cannot watch the listener or change the files that the listener already has; the license binds by law, not by control at run time.
So local generation passes the test above, as long as the compiler can move to another model.

Whether it helps the artist stage is a hypothesis to test, not a given.
The hope is that generated streams absorb background listening, so the listener's attention goes to music with an author.
The risk is the opposite.
Background and functional listening is where stock music has already replaced named artists.
In 2024, Liz Pelly reported in Harper's that Spotify filled mood playlists with commissioned tracks ([The Fader](https://www.thefader.com/2024/12/19/report-spotify-is-populating-its-playlists-with-ghost-artists)).
Many ambient and experimental artists are independents, the same artists that stage 3 wants to reach.
The profile is the one place that knows both needs.
Moondog, informed by the profile, decides which one the moment calls for.

### 3. Independent artists, as a protocol, not a platform

Small and independent artists need exposure.
Many sell through services such as Bandcamp and sit outside the mainstream catalogs ([BANDCAMP_NOTES.md](BANDCAMP_NOTES.md)).
The problem is real.

Moondog does not solve it by becoming a marketplace.
A marketplace brings artist onboarding, moderation, rights handling, payments, and promotion.
That work needs a different organization from a local-first product.
It also conflicts with the charter's rule to keep raw listening data local by default.

Moondog solves it with a format instead.
An artist publishes a self-describing package: recordings and metadata, and optionally a cached embedding tagged with its model, version, and preprocessing.
Moondog computes its own embeddings from the recordings and trusts only those.
Moondog's agent can then discover, index, and recommend that music with grounded reasons, wherever it lives.
The artist gains a channel to listeners who use Moondog.
Moondog carries no marketplace duties.

Open carriers already exist, and the format should extend them rather than replace them.
Podcasting 2.0 defines a music medium for album-shaped feeds, and the Podcast Index lists such feeds through an open API.
Faircamp builds self-hosted artist sites with RSS feeds.
The format adds only what these carriers lack, such as sound descriptors.
Discovery runs through those feeds and indexes; Moondog does not run a central index of its own.
Bandcamp's terms forbid automated reading and AI use of its site, so an artist publishes the package from their own masters, outside Bandcamp.

## Order

The stages feed each other:

1. Local library, analysis and management first.
   Local playback stays with existing players until the owner decides otherwise.
2. Generative music, as one source of local content.
3. Independent artists, through the open format, once local analysis and discovery work.

Each stage supplies the next.
No stage carries marketplace duties.
Stage 2 does carry the generator's license terms (see Owner gates).

## Generation in more depth

### The profile as a taste compiler

For recommendation and playlists, the profile filters a given candidate space.
For generation, the candidate space has no bounds, and the profile changes role.
It compiles taste into the prompt that shapes what gets made.
Enduring attention sets the baseline.
Recent attention, from the last four weeks, shows where the listening is now.
The moment, the listener's request and local time of day, sets the variation within a day.

Like and Avoid name artists and tracks, and names never go into a generation prompt.
The compiler first translates each choice into sound descriptors, for example by ranking the analysis stack's descriptor terms for that artist.
The descriptors do not depend on any one model.
A small adapter for each model turns them into that model's prompt, so taste is not bound to one model's prompt habits.
A Like adds those descriptors to the prompt.
An Avoid can supply descriptors for a negative prompt, but only with guidance turned on, which costs a second pass through the model at each step.
Stability AI's own docs disagree on whether the released Medium model responds to a negative prompt, so an Avoid also acts as a filter when candidates are scored.
A retraction removes the choice from the compiler's input.

Every prompt component traces back to a profile entry or to the moment.
A receipt can then say which season, which correction, and which moment shaped this sound.
The moment shapes the prompt but does not become a profile entry.

Recent attention is partly built from live Spotify Web API data.
Spotify's Developer Policy bars feeding Spotify content, metadata included, into an AI model.
Whether those layers may shape a generation prompt is an owner decision (see Owner gates).

Two extensions are needed before the compiler is honest:

- The profile today is linguistic: genres, artists, scenes.
  Taste also lives in sound itself: tempo, timbre, and space.
  Library analysis gives the profile a sound dimension: MuQ-MuLan for timbre and style, and a separate pass for tempo and key.
  That dimension feeds generation as sharper prompts, or as a seed track for audio-to-audio.
  A seed track comes only from a source whose terms allow it, such as a CD rip or the listener's own recording (see Owner gates).
  Derivatives of commercial recordings stay private to the listener.
- A way back from listening, through two loops that show their work (see the next section).

### The loops back from listening

Plays of generated tracks flow back through the same evidence pipeline as service plays, with their own source mark.
There are two loops, and they close in different ways:

- The calibration loop adjusts how the compiler translates taste into prompts.
  Its evidence is the outcome of each generated track: skipped, completed, saved, or adopted.
  It changes the translation and never the taste, so it can close freely.
- The taste loop carries generated tracks into the profile.
  It closes only through the listener's own acts: a Like or an Avoid on a generated track, saving it, or playing it again later.

The taste loop is strict because of volume.
Eight hours of atmosphere stream a day is dozens to more than a hundred tracks, and Moondog started every one of them.
If those plays counted as recent attention, they would outweigh the listener's own plays within days.
Moondog would then make more of the same music for a taste that it had made itself.
In simulations, a recommender trained on data that its own picks shaped made user behavior more uniform without making it more useful ([Chaney et al., 2018](https://arxiv.org/abs/1710.11214)).
The listening loop already prevents this for stored streaming plays, because a play that Moondog started is not the listener's attention ([The listening loop](LISTENING_LOOP.md#the-agent-must-not-learn-its-own-picks-as-the-listeners-taste)).
Spotify's own ranking of top artists still includes those plays, and the ledger cannot take them out.
Generated tracks follow the same rule, and no outside ranking counts them, so the rule holds for them in full.

A later play follows the streaming rule as well; the owner decided this on 2026-10-29.
A play of a generated track outside the six-hour window after Moondog played it is the listener's own choice and counts as their attention.
The ledger then marks that suggestion as adopted.
Adoption is outcome evidence, not proof of liking.
The adoption mark itself never enters the profile as taste; only the later play counts, as the listener's attention.

Generated tracks give the most readable feedback.
A Like on a streaming track says that the listener likes it, but not why.
A generated track has a receipt that records what was asked for, and the analysis stack can measure what came out.
So a Like on a generated track can attach to measured sound descriptors, for example warm tape saturation near 70 BPM.
The evidence attaches to the measured sound, not to the prompt, because a model does not always follow its prompt.
This may be the most direct way to give the profile its sound dimension.

In the background, a completed track says little.
The listening loop plans outcome signals but has not built them yet ([Next slices](LISTENING_LOOP.md#next-slices)).
In that plan, a change within 30 seconds is a skip proxy, and a play to the end is a completion.
A background track that plays to its end often means only that the listener did not notice it.
So in the atmosphere stream, skips and saves are the signals, completions are mostly noise, and the calibration loop weights them that way.

The center also changes over time.
People come to like what they hear often, an effect known as mere exposure ([Zajonc, 1968](https://doi.org/10.1037/h0025848)).
In one study, liking for music rose with repetition when people heard it in the background, but rose and then fell when they listened closely ([Szpunar et al., 2004](https://doi.org/10.1037/0278-7393.30.2.370)).
So even when no stream play enters the profile, the stream changes the listener, and their Likes and saves then reflect that change.
This is not a defect.
Radio hosts have always shaped their listeners' ears.
Alan Freed, who went on the air in 1951 as the Moondog, helped give rock and roll its name ([VOICE.md](VOICE.md)).
The requirement is that the influence stays visible.
Unchecked, exposure can carry a listener's interest ever further from where it began, which recommender research calls a degenerate feedback loop ([Jiang et al., 2019](https://arxiv.org/abs/1902.10730)).
The profile should be able to say how the listener's saved tracks moved after the stream began.
This is the rule that every claim shows its work, applied to Moondog itself.

### The continuum, for exploration, not to fill

Music is continuous.
Between any two recordings lie uncountable forms that no release has ever sampled.
Streaming catalogs give an illusion of completeness, but they are sparse points in this space.
The distribution industry decided where those points fall.

Generation models make this space navigable.
Each model learns its own latent space, and that space works as a coordinate system for the music the model can make.
The model learns that space from its training recordings.
Its output likely stays near that music.
Two purposes must be kept apart:

- Filling is canonical thinking: it tries to cover every gap, and it treats the space as territory to claim track by track.
  Moondog does not do this.
- Exploring is curiosity thinking: wandering is its own goal, and each step goes toward nearby, unheard music that the listener's evidence points to.
  The profile works as a compass, not a map.
  It says which direction is worth a step, and it never claims to know the whole space.

Interpolation is the most honest form of exploration.
It walks from one owned recording toward another and generates the ground between them.
The endpoints are grounded; only the middle is new.
Plexamp already walks between two chosen tracks by playing real recordings; generation adds the middle that no recording covers.

This is an experiment, not a feature.
Analysis embeddings and a generator's latent space are different spaces.
Stable Audio 3 is conditioned only on text, duration, and audio, so it cannot take a MuQ-MuLan embedding.
Two routes could work.
One decodes points between two MuQ-MuLan embeddings with a generator conditioned on those embeddings.
The other approximates the walk with Stable Audio 3 audio-to-audio, while the prompt moves from one recording's descriptors to the other's.
The endpoints come only from sources that clear the source-terms gate.

## Owner gates

- Choosing when to open the local-library stage against the streaming-first roadmap.
  The stage needs new data: file paths, audio reads, and any fingerprint lookups, starting from the existing Apple Music library import.
- Settling how a public product uses MuQ-MuLan, the working choice for the analysis stack.
  Its code is MIT, but its weights are CC BY-NC 4.0, which allows only non-commercial use.
  A separate download that the listener fetches keeps those terms out of Moondog's Apache-2.0 package, but it does not lift the non-commercial limit.
  Commercial use needs a replacement model or a license from Tencent.
  The tools for tempo, key, and fingerprinting are still open.
- Choosing the generation models and accepting their licenses for a public product.
  Stable Audio 3 is under the Stability AI Community License, with four terms that matter here:
  - Use is free below US$1M in annual revenue.
  - Commercial use needs registration.
  - The Acceptable Use Policy applies, and Stability AI can update it after the download.
  - Outputs may not be used to create or improve foundation models.

  The license also sets attribution duties when Moondog distributes or makes available the weights, a derivative of them, or a product or service that uses any portion of them.
  The duties are a copy of the license, a Notice file, and a prominent "Powered by Stability AI" display.
  A Moondog release that runs Stable Audio 3 likely counts as such a product, even when listeners fetch the weights themselves.
  Its T5Gemma text encoder is under the Gemma Terms of Use.
  Sung songs need a second model, local or a closed service.
- Deciding whether profile layers that hold live Spotify Web API data (the recent-play sync and top artists) may shape a generation prompt, given Spotify Developer Policy sections III.13 and III.14.
  Building prompts only from export-derived evidence is one option.
  The listening loop's [Owner decisions](LISTENING_LOOP.md#owner-decisions) hold the same question for conversations.
- Checking each audio source's terms before its recordings are embedded, fingerprinted, or used as generation seeds or interpolation endpoints.
  Apple's Media Services Terms bar measurement or analysis of Content from Apple's services, iTunes Store purchases included.
  They also bar using that Content or its outputs to train, fine-tune, or improve AI models.
  Bandcamp's acceptable-use policy may reach downloaded purchases.
- Deciding whether Moondog plays local-library and generated files with a player of its own, as the atmosphere stream needs, or hands that playback to the operating system or an existing player.
  Moondog already plays preview files itself, through afplay or ffplay in the terminal and an audio element in the window.
- Deciding whether a non-stop background stream fits the charter's Taste Over Volume principle.
- Getting Bandcamp's written permission before any Moondog tooling reads Bandcamp pages or endpoints (see [BANDCAMP_NOTES.md](BANDCAMP_NOTES.md)).
- Approving the artist package format before anyone outside the project publishes against it.
  The review first checks the existing carriers, and the embedding model must allow commercial use.
