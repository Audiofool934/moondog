# Terminal guide and reference

Moondog's current product is the Pi-based terminal listening room.
This guide covers the local listening loop, optional connected capabilities, and the detailed contracts behind them.
The browser prototypes remain available as archived reference material at the end.
For the predecessor's relationship to this project, see the public [DJ Claw lineage boundary](DJ_CLAW_LINEAGE.md).

- [Install and launch](#install-and-launch)
- [Use the listening room](#use-the-listening-room)
- [Try fictional history](#try-fictional-history)
- [Import and inspect listening history](#import-and-inspect-listening-history)
- [Read the evidence](#read-the-evidence)
- [Personal lyric library](#personal-lyric-library)
- [Public web research](#public-web-research-in-the-tui)
- [Enable agent conversation](#enable-agent-conversation)
- [Local music data control](#local-music-data-control)
- [Grounded catalog discovery](#grounded-catalog-discovery)
- [Spotify connected actions](#spotify-connected-actions)
- [Conversation and memory](#local-memory)
- [Verify a checkout](#verify-a-checkout)
- [Archived browser prototypes](#archived-gui-prototypes-paused)

## Install and launch

Use Node.js `>=22.19.0` on macOS or Linux and the npm version declared in `package.json`.
From a source checkout:

```bash
git clone https://github.com/Audiofool934/moondog.git
cd moondog
npm ci
npm start
```

To make the local `moondog` command available outside this directory, link the checkout once:

```bash
npm link --ignore-scripts
moondog
```

The commands below use this linked executable.
Without a link, use `npm run moondog -- <command>` from the checkout.
This is a source installation; the package is not published to the npm registry.

The launcher selects the first Node executable on `PATH` that satisfies Node `>=22.19.0`.
Set `MOONDOG_NODE` to an explicit compatible Node executable when an override is needed.
Run `moondog doctor` or `moondog status` to inspect the local runtime.

## Use the listening room

Every `moondog` or `npm start` launch starts a new conversation in the character-native listening room.
The lunar record, dog silhouette, and needle are drawn with Braille dots and geometric lines, with hand-lettered ASCII available as an alternative.
There are no embedded images or terminal image protocols.
Paper and charcoal colors carry through conversation, profile views, menus, input, and status details.
Use `/resume` to browse recent saved conversations, filter by title, and press Enter to continue one.
The list shows each conversation's last activity and message count; Escape returns without switching.
`/resume <session-id>` restores a conversation directly, and `/new` starts another while keeping the previous one saved.
Restoring a conversation loads its recent transcript and model context together.
Your listening profile and durable memories remain available across conversations.

Press Tab on an empty home input to explore the actions, then use the arrow keys and Enter.
Escape or Tab returns to typing; typing while an action is selected also goes directly to the input.
Press Ctrl+P anywhere while idle to search commands.
Menus filter by name and description as you type, scroll to keep the selection visible, and preserve the conversation draft when cancelled.
Escape from model selection returns to the provider list.

Command arguments complete as you type, including `/theme`, `/art`, `/motion`, `/web`, `/spotify`, `/auth`, and provider/model choices in `/model`.
Use Tab or Enter to accept a partial suggestion; a fully typed legal command executes on the first Enter.
File paths retain Pi's Tab completion and quoting behavior.
The header identifies the current provider and model when configured, giving the model priority on narrow terminals.

During a model request, the footer tracks the active tool, concurrent tool count, and elapsed time.
A short tool receipt remains below the answer in the current conversation, with completed, failed, or unconfirmed counts.
Unconfirmed means a tool started without a completion event, including interrupted work; cancellation does not undo actions that already completed.
These display receipts are not added to model context or restored with saved conversation history.
You can keep editing your next thought while work runs.
Ctrl+C cancels model and web requests; local commands that cannot be cancelled here show a waiting hint and finish their current step.
Import and profile views show a finishing hint while their local step is running.

```text
/home
/resume
/theme paper
/theme charcoal
/theme terminal
/art braille
/art ascii
/motion off
/import
```

`/home` revisits the opening without clearing your conversation.
`/theme` opens the appearance menu; changes apply to the current session.
Set `MOONDOG_THEME=paper`, `charcoal`, `terminal`, or `auto` before launch to choose a startup preference.
Auto uses the terminal's `COLORFGBG` hint when available and otherwise selects charcoal.
`MOONDOG_ART=ascii` chooses ASCII; `off` keeps the opening minimal.
`/art text` is an alias for ASCII.
The character logo animates on the idle home screen: lunar marks rotate around the record, a small highlight follows the groove, and the needle contact pulses.
The 64-frame loop lasts eight seconds, while the dog silhouette and wordmark stay still.
The animation clock stops during typing, navigation, menus, and conversation, then resumes on the idle home screen.
Minimal layouts can still scroll the lyric when there is room to display it.
`MOONDOG_MOTION=off` or `/motion off` disables animation.
`NO_COLOR` preserves monochrome character art, and `TERM=dumb` selects ASCII without styling or animation.
The layout reduces artwork before sacrificing room for the input, and works without Kitty or iTerm image support.
`/import` opens a native guide for music-service exports and public playlist links, with preview and confirmation before saving.
`/import "/path/to/history.zip"` opens the file preview directly.
`/help` shows the terminal guide; `/help all` includes the complete CLI reference.

The TUI reads the configured local profile and never loads fictional listening history automatically.
Profile viewing and correction work without a model or music-service connection.
Use `/auth` and `/model` only when you want agent conversation.

## Personal lyric library

The home opening can come from music in your listening profile.
Explicit likes and imported preferences have the most weight; saved songs, playlist anchors, and repeated listening also supply candidates.
Track and artist Avoid choices exclude songs, including exclusions beyond the profile's visible summary.
Repeated listening is a familiarity signal, not an explicit Like.

Moondog queries [LRCLIB](https://lrclib.net/docs) in the background using the selected song's title and artist.
It does not send your profile, listening events, credentials, or conversation to the lyric provider.
The library stores provider text, synchronized LRC when available, parsed timed lines, source identifiers, matched metadata, and retrieval times in `lyrics.sqlite` beside the local listening-history database.
It uses the same `MOONDOG_STATE_HOME` / `MOONDOG_CONFIG_HOME` state-directory rules.
An exact normalized title and artist match is required; missing lyrics, instrumentals, and mismatched versions do not supply home text.
When a trusted album or track duration is available through the library API, these also constrain the match.

Each startup reads cached lyrics first and checks up to twelve uncached or stale candidates in the background, with a thirty-second budget.
Successful entries remain fresh for thirty days; unavailable matches are checked again after seven days.
Requests are sequential and respect the provider's retry delay.
The home shows one short, original-language line at a time and omits the byline.
The opening pauses briefly, then scrolls from right to left in a single row.
After the line leaves the screen, another is picked at random from the eligible cached lyrics and enters from the right after a small gap.
Selections avoid recent lines and consecutive songs when possible, and never immediately repeat a line when another is available.
With no eligible cached lyrics, the default opening lines rotate instead.
Rotation uses the local library without starting new network requests; profile changes update the eligible pool.
Typing and menu navigation pause its movement; `/motion off` restores a static, wrapped line, as do plain terminals.
On an empty cache, the existing opening remains until the first suitable personal lyric arrives.
No model is used to invent, translate, or rewrite lyrics.

Use `/lyrics` for library counts and the current home line's song and source, or `/lyrics sync` to check the next batch.
Ctrl+C cancels a manual sync, and quitting cancels background work.
Set `MOONDOG_LYRICS=off` to disable online fetching while retaining cached home lyrics.
Profile import, correction, and refresh update the eligible songs.
The lyric library is separate from listening/profile export and reset scopes; those operations leave this cache intact.
Provider availability and coverage vary, so the default opening remains available offline or without a match.

```text
/taste
/taste report
/profile corrections
/profile correct --track "Track title" --by "Artist name" --avoid
/profile retract <correction-id>
```

`/taste` opens an interactive listening profile; `/profile` is an alias.
Type to filter tracks and artists, use the arrow keys to select a reading, and press Enter for evidence, Like, Avoid, or Retract my choice.
Tab switches between All, Tracks, Artists, and Your choices.
The selected reading shows observed listening separately from your explicit preference, and Avoid targets stay accessible for later revision.
Every change refreshes the profile in place without a model request or music-service connection.
Escape returns to the previous screen with your conversation draft preserved.
Ctrl+R refreshes local evidence, Page Up and Page Down scroll the selected detail, and Ctrl+O opens the full report.
`/taste report` retains the full Tasteprint, Listening Time Machine, and listening-pattern report.
The interactive list is a bounded selection of profile evidence, not a search of every historical play.
A correction records only the explicit stance you chose and preserves the original listening history.
An artist Avoid still applies when an individual track is marked Like; retract the artist choice separately to change that.
The explicit `/profile correct` and `/profile retract` commands also return to the refreshed profile.
Quote titles, artists, notes, and paths that contain spaces.
These are command arguments, not shell expressions.

When external discovery is ready, a track's Enter menu also offers **Discover around this**.
It returns to the conversation with an editable request for three songs and their recommendation reasons.
Your existing draft stays intact, with the selected title and artist added; choosing another track replaces that selection.
Press Enter to send, or keep editing first.
Without a connected model, the draft stays in the editor while you use `/model` to connect one.
If discovery services cannot be reached, press ↑ to recall the request and Enter to retry with the same selected track.
The selected profile track can come from Spotify history even when it is absent from your Apple library.
Changing or removing its displayed title or artist removes the automatic handoff of the original selection.
External discovery currently requires an imported Apple Music library to validate candidates; a history-only profile retains its local evidence and correction actions.
Recommendations show their listening-derived artist connections and release metadata.
The model proposes the selection and order; these connections do not establish audio similarity or prove that a song is new to you.
English and Chinese explanations follow your request text or explicit language instruction, while track and artist names retain their original language.

To add a saved Spotify archive from inside the TUI, use `/spotify import-history "/path/to/spotify-history.zip"`.
Every successful import keeps its receipt and full cumulative report in the conversation, then opens the interactive listening profile in the same TUI session.
This also happens for a repeated archive, without adding duplicate listening events.
Review or correct the reading there, or continue the conversation without a confirmation step.
`/taste` remains available when you want to revisit the profile later.
This explicitly imports into the cumulative local profile and works without Spotify OAuth.
For a temporary preview without importing, use `npm run moondog -- taste --from "/path/to/spotify-history.zip"` from the shell.

## Try fictional history

With Node.js `>=22.19.0`, run:

```bash
npm ci --ignore-scripts
npm run demo
```

The offline demo needs no personal data, OAuth credential, model API, or music-service connection.

It executes the same grounded path used by the real agent:

```text
profile.summary -> profile.explain -> library.search -> playlist.plan
```

You will see a six-track plan move from explicit preference anchors toward measured unfamiliarity, with each selection tied to bounded evidence and a host-validated candidate set.

Use `npm run --silent demo -- --json` to inspect the complete machine-readable trace and playlist plan.

## Exercise the real importer with fictional history

If you want to test the actual Spotify import path before using personal data, generate a deterministic fictional Extended Streaming History ZIP:

```bash
mkdir -p outputs
npm run generate:demo-history -- \
  --output "$PWD/outputs/moondog-fictional-history.zip"
npm run moondog -- taste \
  --from "$PWD/outputs/moondog-fictional-history.zip" \
  --json
```

From a linked source checkout, use `moondog demo-history --output /absolute/path/to/moondog-fictional-history.zip`.

The 52 synthetic plays span 2023 through 2026 and produce a real four-stop Listening Time Machine, a 36-month Listening Pulse with 15 active retained months, 13 fixed UTC quarters with 12 active Listening Seasons, four long-gap return tracks, three played-back-to-back tracks with three-play sequences, 15 approximate listening stretches with a four-play median, two multi-track release-depth records, continuity and change, recent movement, repeat listening, and rediscovery candidates through the production importer and profile projection.
Every artist, track, album, timestamp, and Spotify-shaped track identifier is fictional.
The ZIP contains no account, IP, country, platform, device, or username fields.

Generation reads no private store, makes no network request, performs no provider action, writes the result as mode `0600`, and refuses to replace an existing destination.
Repeated generations at fresh paths are byte-identical.
The one-off `taste --from` command above also leaves persistent profile state untouched.

Use `/import "/absolute/path/to/moondog-fictional-history.zip"` inside the TUI to exercise persistent import and immediate profile review.
That explicit action adds fictional listening events to your configured local profile, so use a separate `MOONDOG_STATE_HOME` when you want to keep demonstration state isolated.
The archived Studio also accepts this ZIP.
Studio then treats the fictional archive exactly like a user-selected history ZIP, so that action intentionally creates local profile state.
Keep the generated ZIP under the ignored `outputs/` directory rather than adding it to the source tree.

## Import and inspect listening history

Start with `/import`, or choose **Import your music** from the home screen.
Choose **Spotify**, **Apple Music**, **YouTube Music**, **QQ Music** or **NetEase Cloud Music** first.
The guide explains the available quick-start and past-history routes for that service.
All imports work without a model and open the cumulative Profile after confirmation.
Other existing sources remain available under **Other sources**.

| Service | Start with | Past listening |
| --- | --- | --- |
| Spotify | Connect for up to 50 recent plays, with current developer-app setup requirements | Account Data or Extended Streaming History ZIP |
| Apple Music | Export Library.xml from Music on Mac | Privacy-request guide only; archive parsing is not available |
| YouTube Music | Takeout music-library-songs.csv or a ZIP containing it | Takeout watch-history.json or a ZIP containing it |
| QQ Music | Paste a public playlist share link | Account history import is not available |
| NetEase Cloud Music | Paste a public playlist share link | Account history import is not available |

**YouTube Music:** open [Google Takeout](https://takeout.google.com/), deselect other products and select YouTube and YouTube Music.
Include music library songs and history, and set the history format to JSON.
Request a one-time ZIP download, wait for Google's email, and save the result in Downloads or a folder you choose.
Return to the YouTube Music guide and select the ZIP, or an extracted `music-library-songs.csv` or `watch-history.json`.
The library CSV uses Google's Video ID, Song Title, Artist Name and optional Album Title columns.
History requires a music-specific header or music.youtube.com watch URL, a valid video ID and timestamp, and an English or Chinese watched-action title.
Ordinary YouTube viewing, unrecognized action titles and incomplete entries are skipped and counted in the preview.
Channel names are not assumed to be recording artists, and missing played duration stays unknown.
General YouTube playlist CSVs, HTML history and uploaded audio files are not imported.
Limits are 256 MB per ZIP, 64 MB per selected file, 100 selected members and 100,000 music records per import.
For large exports, extract just the supported files and import them separately.
Google's [music export schema](https://developers.google.com/data-portability/schema-reference/youtube) and [activity schema](https://developers.google.com/data-portability/schema-reference/my_activity) describe the source fields.

**QQ Music and NetEase Cloud Music:** in the service, open a playlist you want represented in your profile and choose Share > Copy link.
Paste the link or copied share text into the corresponding Moondog guide.
The preview shows the playlist name, sample songs and the available count compared with the service's reported total, when supplied.
Only public metadata is read, without account passwords or cookies; private playlists require another supported source.
If a short link cannot be resolved, open it in your browser and copy the full playlist page URL.
These adapters use the services' public website metadata responses, which can change or limit results; availability is checked on each preview.
Importing a selected playlist does not imply you created it, liked every song or played any of its songs.
Collections and history keep their platform labels in the same cumulative profile, and repeating an identical import adds no duplicate evidence.
These imports add observations; they do not synchronize later playlist removals or replace existing preferences.

**Quick start** connects Spotify and previews up to 50 recent plays before you choose **Import into my profile**.
It requests only permission to read recent listening, and does not control playback or change your Spotify library.
Recent listening has playback timestamps but no actual played duration, and cannot reconstruct the full history.
This release needs a configured Spotify developer app; the guide provides setup instructions and a Client ID input if needed.
New development apps require Premium for the app owner and support at most five allowlisted users, as described in [Spotify's quota rules](https://developer.spotify.com/documentation/web-api/concepts/quota-modes).
File import remains available without Spotify authorization or developer-app setup.

If you need Spotify data, choose **Spotify > Add past listening history**, open [Spotify's account privacy page](https://www.spotify.com/account/privacy/) from the guide and use **Download your data**.
Extended Streaming History provides the longer listening history, while Account Data contains past-year history plus supported library and profile snapshots.
Both ZIP formats work; keep the downloaded ZIP intact.
The [Spotify download instructions](https://support.spotify.com/us/article/data-rights-and-privacy-settings/) and [data descriptions](https://support.spotify.com/us/article/understanding-your-data/) explain the available packages.
If Spotify is still preparing the export, return to `/import` when it is ready; an existing local profile remains usable meanwhile.
Spotify login and recent-play reads do not reconstruct the full exported history.

Save the downloaded ZIP on your computer, usually in the browser's Downloads folder or the location you choose.
Choose **Spotify > Add past listening history**, then **Choose my Spotify ZIP**, and paste or drag one file path into the terminal.
Tab completes paths, including quoted paths with spaces.
Plain paths, quoted paths, Finder-escaped paths, `~/` paths, and local `file://` URLs are accepted.
The original source is kept unchanged.
Missing files and unsupported inputs leave the path in place so you can fix it.

Enter inspects the file and shows its source, listening-record and track counts, retained listening dates, actual-duration coverage, and supported profile evidence.
This describes the selected file, not a prediction of its net contribution to existing history.
No listening history is added until you choose **Import into my profile**.
Back or Escape leaves the preview without importing.

To open a saved file directly, run this inside Moondog:

```text
/import "/path/to/spotify-history.zip"
```

The inspected data is imported into the cumulative private local profile, then the interactive profile opens in the same terminal session.
The receipt shows newly stored and already-present listening records, including reconciled overlaps when applicable.
The receipt and full cumulative report remain in the conversation, even if a later profile refresh needs another try.
Return to `/import` for later files; repeated files do not add duplicate listening events, and existing history and explicit corrections are kept.
Reading, saving, and profile refresh are shown as separate stages; this first version does not interrupt an active read or save step.
Use `/spotify import-history "/path/to/spotify-history.zip"` or `moondog spotify import-history "/path/to/spotify-history.zip"` for the existing direct persistent import without the guided preview.

## Bring independent ListenBrainz history

Moondog can also build the same persistent provider-neutral profile from an official saved ListenBrainz GET-listens response or `single` or `import` submission JSON.
Choose that JSON in `/import` to inspect it, import it, and review the profile without leaving the terminal session.
The direct shell route remains available:

```bash
moondog listenbrainz import-history /path/to/listen-history.json
moondog taste
```

The same JSON can be dropped directly into `moondog studio` alongside Spotify ZIPs.

This path is local and offline, needs no ListenBrainz token, leaves the source JSON unchanged, and adds idempotently to the same private local subject as existing Spotify history.
Provider-specific track identities remain separate unless they already share canonical recording identity, so cross-provider distinct-track totals can still include unresolved duplicates.

Moondog keeps the listen timestamp, track labels, optional release, optional played duration, and server-resolved recording identity needed for the profile.
It does not retain the ListenBrainz username, client metadata, tags, source URLs, or raw JSON.

ListenBrainz documents `listened_at` as playback start time and `duration_played` as the optional actual played duration.
Listens without `duration_played` still support play-count and recency evidence but do not add invented minutes to the listening-time total.

Only the read-only `track_metadata.mbid_mapping.recording_mbid` returned by the ListenBrainz server is treated as a resolved MusicBrainz recording.
Client-submitted MBIDs inside `additional_info` remain unvalidated source context and are not promoted into Moondog's canonical track identity.

The accepted envelope and identity boundary follow ListenBrainz's official [JSON documentation](https://github.com/metabrainz/listenbrainz-server/blob/master/docs/users/json.rst) and [GET-listens API](https://listenbrainz.readthedocs.io/en/latest/users/api/core.html#get-1-user-user-name-listens).

### Apple Music library

Choose `/import > Apple Music > Quick start with library XML`.
In Music on Mac, use **File > Library > Export Library**, save the XML somewhere easy to find, then choose that file in Moondog.
After preview and confirmation, Moondog saves the library snapshot, rebuilds its local profile and opens Profile immediately.
The direct `/import "/path/to/Library.xml"` shortcut also works.

For older detailed activity, choose **Apple Music > Past listening history guide**.
It opens [Apple Data & Privacy](https://privacy.apple.com/) and explains how to request Apple Media Services information, wait for the ready notification and download the prepared files.
Apple privacy archives cannot be imported by this release; the guide makes this clear and links back to the usable library XML route.

Follow [Apple Music Library Import](APPLE_MUSIC_LIBRARY_IMPORT.md) to inspect and import a private library XML.
Then run `npm run rebuild:apple-projection` to create the disposable local SQLite projection.
The rebuild infers one trusted subject only when all verified local Apple import batches agree.
Spotify-only and ListenBrainz-only users can skip these steps.
An Apple Music library is a catalog snapshot, not complete listening history.

### One-off previews and saved reports

Import one Spotify archive and write a private recap card:

```bash
npm run moondog -- taste \
  --from "/path/to/spotify-history.zip" \
  --save \
  --card
```

The command leaves the source ZIP unchanged, imports the supported music evidence into private local state, and prints the new private recap-card path.

Repeat `--from` once to reconcile standard and Extended Spotify exports in the same command:

```bash
npm run moondog -- taste \
  --from "/path/to/account-data.zip" \
  --from "/path/to/extended-history.zip" \
  --card
```

Without `--save`, the two-archive form exists only in memory and leaves no listening-history database behind.
The two-archive preview intentionally rejects `--save` so an invalid second file cannot leave a surprising partial persistent import.
To keep both archives, run `moondog spotify import-history` once for each ZIP in either order, then create the cumulative artifact with `moondog taste --html` or `--card`.

Moondog creates one stable local music identity, merges repeat imports idempotently, reconciles exact Account Data and Extended History overlaps regardless of import order, and renders the cumulative profile rather than a disposable snapshot.

When an exact overlap uniquely connects a provisional Account Data track to one resolved Extended History track, Moondog also joins any remaining effective plays under that resolved identity for behavioral aggregation.
The original events and TrackRefs remain intact, multi-target cases stay separate, and the CLI, Studio, and complete Tasteprint report both applied links and ambiguous identities deliberately withheld from linking.

Afterward, `moondog taste`, `/taste`, and the agent's `profile.summary` and `profile.explain` tools work from Spotify evidence even when no Apple library has been configured.

Omit `--save` for a one-off in-memory preview that leaves only the self-contained mode-`0600` recap card.

The card uses only three long-arc artists, two recent artist signals, two repeat tracks, and aggregate coverage from the same bounded profile.
It omits direct correction details, search strings, provider prose, evidence identifiers, and source paths, but it still reveals personal listening context and must be reviewed before sharing.

Replace `--card` with `--html` when you want the complete evidence-backed Tasteprint rather than the one-screen recap.

## Read the evidence

The complete Tasteprint now includes **Worth another listen**, a ranked set of tracks with meaningful historical attention that have not appeared inside a bounded 90-day quiet window.
The quiet window is measured against the latest retained listening event rather than today's date, so an older export is never presented as current activity.
Active artist or track avoidances are excluded, while play count and listening time remain evidence of attention rather than proof of liking.

The same projection includes **Music that came back**, a bounded set of tracks that reappeared after one or more gaps of at least 180 days in retained effective history.
Each candidate requires at least three effective plays, three plays without an explicit skip signal, ten listening minutes, and no active artist or track avoidance.
This is a recurrence pattern in the archive, not proof of liking, nostalgia, intentional absence, or current preference.

With the full local projection ready, the configured agent can turn those tracks directly into a trusted plan without requiring an exact Apple-library match:

```bash
moondog ask "Build a five-track listen-again plan from music I used to play."
```

The `moondog_rediscovery_candidates` tool creates a prompt-local `private_history` candidate set, and `moondog_playlist_plan` validates the selected order without writing to Spotify.
When Extended Streaming History supplied a Spotify Track URI, the host can later resolve that exact recording from its retained provider ID without catalog search, while the raw ID never enters model-visible output.

Long-gap returns have their own trusted Agent path:

```bash
moondog ask "Build a four-track path from music that came back after long gaps."
```

The `moondog_historical_return_candidates` tool returns only bounded recurrence evidence and opaque track references to the model.
The shared planner validates the selected order, while exact provider identity remains inside the host and no provider write occurs.

Spotify Extended Streaming History can also expose tracks that appear in immediate succession:

```bash
moondog ask "Build a short path from tracks I played back to back."
```

The **Played back to back** view requires at least two adjacent retained plays of the same exact track, with each play lasting at least 30 seconds, no explicit skip signal, and no gap longer than 30 minutes.
The `moondog_back_to_back_candidates` tool returns only bounded sequence counts and opaque track references to the model, while provider identity stays inside the host.
This is evidence of adjacent retained playback, not proof that repeat mode was active or that the listener intended, liked, or preferred the track.

The complete Tasteprint also includes a **Listening Time Machine** when at least two retained calendar years have enough listening evidence.
It chooses one representative track from evenly spaced years across the available span, keeps the stops chronological, prefers a different artist per year when the evidence permits, and excludes active artist or track avoidances.
Each selected year requires at least two engaged plays and five listening minutes, and the result is explicitly a bounded landmark rather than proof that one track defines that year.
The complete Tasteprint shows represented-year coverage, names retained years without a selected landmark, and explains the strongest-year, active-avoidance, and minimum-attention rules beside the route.

The configured agent can turn those landmarks into a trusted chronological plan:

```bash
moondog ask "Build a six-track Listening Time Machine across my years."
```

This planning path works from a persistent Spotify-only or ListenBrainz-only profile without an Apple Music projection.
The `moondog_time_capsule_candidates` tool exposes only opaque track references and bounded yearly evidence to the model, while exact Spotify identities remain inside the host for later resolution when Extended Streaming History supplied them.
Planning has no external effect, and a connected-service write still requires the normal explicit Spotify action boundary.

## See the pulse between the landmarks

**Listening Pulse** groups eligible effective events into continuous UTC calendar-month cells so a long archive keeps its changing density instead of collapsing into lifetime totals.
Each cell uses listening minutes for a profile-local intensity scale and exposes only aggregate event, minute, and distinct-track counts.
The complete Tasteprint represents up to the latest 240 retained months, while Studio previews at most the latest 72 and reports how many earlier months remain outside that bounded view.
A blank cell means no eligible retained event appears in that UTC month, not proof that no listening occurred, and raw timestamps, event sequences, source paths, evidence identifiers, and provider track identities remain outside both surfaces.

## Read the seasons inside the pulse

**Listening Seasons** groups the same eligible effective events into deterministic UTC calendar quarters.
Every represented quarter stays in chronological order, including empty and partially retained windows.
An active quarter reports aggregate listening time, event and track counts, the split between tracks first observed in retained history and tracks seen earlier, one leading artist, and one signature track.
First observed means first appearance in the retained eligible history, not discovery, and an empty quarter is not proof of no listening outside the available archive.
The profile keeps at most the latest 80 quarters, the complete Tasteprint shows the latest 12, Studio and Agent preview the latest six, and every layer reports what its bounded view omits.
Incognito events, raw timestamps, event sequences, source paths, evidence identifiers, TrackRefs, and provider track identities stay outside the public and model-visible projections.

## See what stayed and what changed

The complete Tasteprint adds a temporal layer beside the Listening Time Machine instead of reducing a long archive to lifetime totals.

**Artists across eras** lists artists that appear in at least two retained UTC calendar years and remain present in the latest retained year.
It reports active-year count and the first-to-last retained span, then ranks the result by active years, span, listening time, and plays.

**Year-to-year turnover** compares adjacent retained years using up to the ten artists with the most retained listening time in each year.
It shows how much of the later year's Top 10 carried forward, how many names entered that later set, and a bounded sample of both groups.

These are descriptions of the retained archive, not uninterrupted loyalty, discovery, genre breadth, or identity.
They do not claim permanent taste change, and they remain separate from direct listener corrections.

Studio exposes only a bounded preview of these relationships and aggregate transition counts.
The source path, evidence identifiers, and provider track identities stay out of the page and API response.

## See how listening gathers

Extended Streaming History contains enough sequence and release context to show more than rankings.

**Played back to back** finds adjacent retained plays of the same resolved Spotify track when each play lasted at least 30 seconds, no explicit skip was recorded, and no gap exceeded 30 minutes.
It reports bounded burst counts, the longest adjacent sequence, plays and listening time inside those sequences, and the latest observed date.
It does not claim repeat mode, intention, liking, or preference, and lower-resolution Account Data is not promoted into this view.

**Approximate sessions** group eligible Spotify Extended History track-stop timestamps until a gap longer than 30 minutes begins a new listening stretch.
The summary reports the number of stretches, median plays and listening minutes, and the share containing at least five plays.
It is explicitly an approximation, not a provider session log or a claim about activity, attention, mood, location, or intent.

**Records explored in depth** pair normalized artist and release metadata, require at least three distinct retained track identities, and rank the resulting multi-track releases by listening time.
The view reports track breadth, effective plays, listening time, and active retained years without claiming full-album playback, track order, completion, ownership, or preference.

Both views exclude incognito events and expose only bounded aggregates and music labels.
Raw timestamps, source paths, evidence identifiers, Spotify track identities, account fields, IP addresses, device fingerprints, and location fields remain outside the Studio response and rendered Tasteprint.

## Correct what Moondog gets wrong

Listening time proves familiarity, not preference.
When the projection gets that distinction wrong, record a direct listener assertion instead of editing or deleting history:

Inside the TUI, open `/taste` and press Enter on a track or artist to inspect its evidence or choose Like, Avoid, or Retract my choice.
Explicit `/profile correct` and `/profile retract` commands also return to the refreshed profile.
Use `/profile help` for options and quote names that contain spaces.
The existing **Correct the reading** panel in `moondog studio` remains a paused prototype.

For terminal automation, use:

```bash
moondog profile correct --artist "Pink Floyd" --avoid \
  --note "This listening was contextual."

moondog profile correct --track "Echoes" --by "Pink Floyd" --like
```

The next `moondog taste`, HTML Tasteprint, and agent profile projection apply the correction immediately.
The correction is a typed, provenance-backed local `TasteEvent`, while the original play records and familiarity evidence remain unchanged.

Inspect or retract it with:

```bash
moondog profile corrections --all
moondog profile retract <correction-id>
```

A newer stance for the same target supersedes the older stance.
Retracting the newer stance does not silently reactivate the superseded one.

## Private Tasteprint reports

`moondog taste` turns the bounded ProfileProjection into a readable first product surface.

It shows long-running artist patterns, recent movement, a year-by-year listening arc, cross-year continuity, approximate session shape, multi-track release depth, repeat tracks, bounded listen-again candidates, direct listener corrections, deliberate library choices, coverage, excluded incognito events, and interpretation boundaries.

The normal view stays compact and does not print verified search strings or provider-written narratives.

A script-free section navigator links only to panels present in that artifact, including direct listener corrections when they exist.

Use `moondog taste --json` when a complete bounded local projection is needed for inspection or debugging.

Use `moondog taste --html --output /private/path/tasteprint.html` to choose an explicit destination.

Use `moondog taste --card --output /private/path/tasteprint-card.html` for the bounded one-screen recap.

Without `--output`, Moondog creates a new mode-`0600` file under the private local state directory and never silently overwrites an existing Tasteprint or card.

Tasteprint works without a model, Spotify connection, or external request after the local profile projection exists.

Use `/taste report` for the full report in the TUI, or `/taste` for the interactive listening profile.

Read the [Private Tasteprint](PRIVATE_TASTEPRINT.md) contract before sharing an artifact or screenshot.

## Public web research in the TUI

Moondog can search reviews, music news, interviews and concert information, or summarize a public page, through a locally installed and signed-in Codex CLI.
Pi remains the main agent and TUI.
No separate search-service API key is required.

```text
/web status
/web search Moondog musician interview
/web read https://encyclopediaofarkansas.net/entries/moondog-2774/
```

These commands work without a listening import or a configured Pi conversation model.
After selecting a Pi model, ordinary conversation can also call `moondog_web_search` and `moondog_web_read`, with source links retained in the final response.
From the shell, use `npm run moondog -- web search "artist interview" --json` or the corresponding `status` and `read` commands.

Install a current [Codex CLI](https://developers.openai.com/codex/cli/) and run `codex login` if `/web status` reports unavailable, then restart Moondog.
This backend reuses the CLI's login, independently of Moondog's `/auth`, and consumes that Codex account's usage allowance.
`/web status` checks the executable and login only; it does not prove live web connectivity.
The adapter was exercised with Codex CLI 0.152.0.
An absolute `MOONDOG_CODEX_BIN` can select another executable; `MOONDOG_CODEX_MODEL` can optionally select the search model.
Otherwise Codex uses its default model with low reasoning effort; its user configuration is not loaded into the research subprocess.

Each request has a two-minute timeout and a maximum of six native web operations, returns up to five sources, and caches successful results for five minutes within the running process.
Ctrl+C cancels the active request.
Only the supplied public query or URL is added to the bounded subprocess prompt, with no automatic profile, history, conversation or local-file attachment.
Search queries and requested URLs are sent to Codex's remote service.
The subprocess starts in a temporary empty directory, disables local shell, app and plugin tools, and removes its temporary schema on completion.

Results are generated summaries with source links, retrieval times and publication dates when available, not full article exports or independent verification of every statement.
The adapter requires evidence that Codex invoked native web search or opened the requested URL before returning a result.
Source URLs themselves come from Codex's structured answer because CLI events do not expose the underlying web result bodies.
Page reading is limited to public content accessible to the native web tool; it cannot log in, bypass paywalls or operate an interactive website.
Web evidence does not become personal listening evidence or a trusted playlist candidate.

## Enable agent conversation

Start Moondog, connect a provider, and choose a model in the same terminal session:

```bash
moondog
# /auth opens the provider picker and a hidden API key prompt.
# /model opens the provider and model picker.
```

When a model is already selected, `/auth` connects that provider.
You can also name the provider directly, for example `/auth deepseek` followed by `/model deepseek`.
Switch providers at any time with `/model`; your conversation and listening profile remain available.
Selections are saved for the next launch.
A model without credentials stays offline and shows the matching authentication command.

| Model family | Provider ID | Environment variable instead of a saved API key |
| --- | --- | --- |
| GLM | `zai` | `ZAI_API_KEY` |
| Kimi, global API | `moonshotai` | `MOONSHOT_API_KEY` |
| Kimi, China API | `moonshotai-cn` | `MOONSHOT_API_KEY` |
| DeepSeek | `deepseek` | `DEEPSEEK_API_KEY` |
| Grok | `xai` | `XAI_API_KEY` |
| GPT, OpenAI API | `openai` | `OPENAI_API_KEY` |
| Claude | `anthropic` | `ANTHROPIC_API_KEY` |
| Gemini | `google` | `GEMINI_API_KEY` |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` |

The model picker reads Pi's bundled model catalog, so available model IDs follow the pinned Pi dependency.
Models still depend on provider availability and your account's access.
Moondog's `zai` provider uses the [standard Z.AI API endpoint](https://docs.z.ai/guides/develop/http/introduction), `https://api.z.ai/api/paas/v4`, for music conversation.
This differs from Pi's coding-plan default; use a standard API account and key for this entry.
Other Pi providers remain in the model picker and use their native environment-based authentication where available.

The same credential commands work outside the TUI:

```bash
moondog auth login deepseek
moondog auth status deepseek
moondog auth logout deepseek
```

API key login requires an interactive terminal and hides the pasted key.
Enter only the provider ID in commands; paste the key at the separate prompt.
Saving a key and checking its status make no model request; the provider validates it on your first conversation request.
Status distinguishes saved credentials from environment credentials, and never prints keys.
A saved key takes precedence over the corresponding environment variable.
Logout removes only that provider's saved credential; an environment key remains active until you unset it.

For scripts, set the provider's API key variable together with `MOONDOG_PROVIDER` and `MOONDOG_MODEL`.
Those two model variables override the saved selection at launch and on `/reload`.
An explicit `/model` selection takes effect immediately in the current session, including after authentication.

ChatGPT sign-in remains available separately from OpenAI API keys:

```bash
moondog auth login openai-codex
# Use --device-code in a headless terminal.
```

Inside the TUI, use `/auth openai-codex` and `/model openai-codex`.
This is a separate Moondog OAuth authorization.
It does not read, copy, modify, or log out the Codex CLI or ChatGPT desktop credential cache.

Moondog stores its API keys and OAuth credentials in `auth.json` under `MOONDOG_CONFIG_HOME`, `$XDG_CONFIG_HOME/moondog`, or the default `~/.config/moondog` directory, in that order.
On POSIX systems, Moondog creates or requires mode `0700` on the directory and `0600` on the credential file.
The file contains credentials and must be protected like a password.
Do not put credentials in this repository.

### Recover from a model connection failure

For providers other than Gemini and Google Vertex, temporary connection failures before a model HTTP response arrives are retried up to twice, with progress shown in the TUI footer.
Press Ctrl+C to cancel the retry.
This recovery retries the model request without repeating completed tool calls or restarting the conversation turn.
Service rejections and interruptions after a response begins are reported without automatic replay.
Gemini and Google Vertex use Pi's native connection handling and do not display Moondog's two-attempt retry indicator.

If the connection still fails, Moondog names the selected provider and shows a connection code when one is available.
Press ↑ to recall your message and Enter to try again.
If a capability already ran during the failed turn, check its result before repeating an action, especially playback or playlist changes.
Your earlier completed conversation remains available.

## Local music data control

Inspect exactly what Moondog manages before exporting or resetting it:

```bash
moondog data inspect --scope profile
```

The command is read-only, does not initialize an empty state directory, reports every selected component and excluded category, and prints a reset token bound to the current paths and file state.
Issuing the token reads the selected managed files and binds their relative paths, private modes, sizes, and SHA-256 content fingerprints without printing those fingerprints or copying the files.

Choose one explicit scope:

- `listening` covers listening history, the Spotify resolution cache, and saved Tasteprints.
- `apple` covers canonical Apple import batches and the disposable Apple projection.
- `profile` combines both scopes.

Create a private snapshot in a new directory whose parent already exists:

```bash
moondog data export \
  --scope profile \
  --output "/private/path/moondog-profile-export"
```

The export uses consistent SQLite snapshots, private permissions, per-file SHA-256 digests, and a manifest that records its subject and exclusions.

It leaves the source unchanged and fails without publishing a partial result if the selected state changes during export.

Reset requires the exact token from a current inspection:

```bash
moondog data reset \
  --scope profile \
  --confirm reset-profile-0123456789abcdef
```

Close Moondog Studio and other Moondog processes before reset.

Reset rechecks the token, refuses busy databases, moves each selected path to a timestamped sibling archive, and writes a private recovery manifest.

It performs no deletion and attempts to roll back completed moves if a later move fails.

Conversation memory, model settings, OAuth credentials, Spotify client configuration, and original provider ZIPs are excluded from every scope.

If Apple and listening sources resolve to different subjects, export and reset fail closed until the conflict is reviewed.

Add `--json` to any inspect, export, or reset command for machine-readable output.

## Grounded catalog discovery

Moondog uses a bounded read-only integration with the official [Apple iTunes Search API](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/index.html) for current artist releases and prompt-scoped external track candidates.

Reproduce the original latest-single question directly from a source checkout:

```bash
npm run moondog -- catalog latest-single \
  --artist "刘森" \
  --known-release "华北浪革"
```

The no-hint path can also resolve a public artist alias automatically:

```bash
npm run moondog -- catalog latest-single --artist "Hikki"
```

Moondog tries this path only after Apple's exact-name search remains ambiguous or finds no match.
It accepts only an exact Wikidata label or alias whose matching items collapse to one [MusicBrainz artist ID (P434)](https://www.wikidata.org/wiki/Property:P434) and one [Apple Music artist ID (P2850)](https://www.wikidata.org/wiki/Property:P2850), then uses Apple's documented [ID-based lookup](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/LookupExamples.html) instead of guessing from another name search.
The bounded result records the canonical name, MusicBrainz identity, Wikidata item, Apple identity, properties, license, and selection basis under `cross_catalog_identity`.
The same shared recovery runs behind `moondog_music_artist_releases`, so current-release questions asked through the Agent receive the same deterministic identity and fail-closed behavior as the direct CLI.
Missing or multiple MusicBrainz or Apple identities leave the original ambiguity intact.
An unavailable Wikidata service or an Apple ID that is absent from the selected storefront also leaves the original Apple result intact, so the optional recovery path cannot erase usable candidates.
Only the requested public artist name goes to Wikidata; private archive values, release hints, profile data, and credentials do not.

If the automatic public identity path cannot resolve the artist, copy one displayed Apple Music artist page directly into the recovery command:

```bash
npm run moondog -- catalog latest-single \
  --artist "刘森" \
  --artist-page "https://music.apple.com/us/artist/liu-sen/1502984832"
```

Moondog extracts only the public numeric catalog identity, looks it up directly, and requires the returned artist name to match the requested name before reading releases.
The full input URL is not copied into the bounded result, a mismatched page fails closed, and the lookup response shares the existing ten-minute in-memory cache with the release read.

If the artist already appears in an Account Data or Extended Streaming History ZIP, let that archive provide the identity evidence instead:

```bash
npm run moondog -- catalog latest-single \
  --artist "刘森" \
  --from "/path/to/spotify-history.zip"
```

From a linked source checkout, begin the same command with `moondog` instead of `npm run moondog --`.

Add `--json` for the same bounded result as machine-readable output.

This path makes a live read-only request to the Apple Music US storefront, does not configure or call a model, does not read or send the personal profile, and makes no provider write.

The optional known release stays inside the Moondog host, is used only to compare the public candidate releases returned by Apple, is omitted from the direct CLI result, and is never interpreted as a preference claim.

The `--from` path reads the explicitly supplied ZIP only in memory, derives at most three exact-artist release hints, and persists neither the archive nor a profile.

It sends neither its content nor derived release titles to Apple or a model, and private release titles, listening counts, and source path stay out of the result.

The public source format and the number of hints considered remain visible so the privacy boundary is auditable without revealing the underlying music history.

Use only one identity hint: `--artist-page`, `--known-release`, or `--from`.

Without one exact and unique cross-catalog identity or a sufficient explicit hint, exact-name ambiguity fails closed and shows up to four validated public artist pages instead of guessing.

The catalog computes an explicit `latest_released_single` across the complete bounded lookup result before the bounded general-release list is truncated, so a newer album or EP cannot hide the actual latest single.

For prompts such as `刘森最新的单曲是哪首？`, the host uses one exact-artist release from the private library when needed to distinguish same-name artists, then reads dated releases from the Apple Music US storefront.

Released and upcoming titles are separated before the result reaches the model.

The runtime appends a host-generated link to the validated Apple Music catalog page, together with the retrieval date and storefront boundary, so the answer never presents one catalog as proof of an all-platform latest release.

The structured result exposes these links only as `music_world_citations` with `evidence_scope: public_music_world`.

They remain separate from profile evidence, listening history, and the known private-library release used only for artist disambiguation.

Only HTTPS pages on `music.apple.com` or `itunes.apple.com` can enter this citation path, and an invalid catalog URL produces no citation.

The external requests send the bounded artist query and public catalog IDs needed for candidate lookup, but they do not send the release-name hint, the user's profile, listening history, or raw private library records to Apple.

Search and lookup responses are cached in memory for ten minutes to keep repeated local queries within the API's documented approximate rate limit.

For an explicit request to look outside the imported library, the Agent first reads the bounded Tasteprint and then sends at most three short keyword queries to the Apple Music US storefront.

Raw listening events, full profile records, private library rows, and provider credentials are never sent with those requests.

Catalog tracks receive opaque provider-neutral TrackRefs before they reach the model.

The host removes exact title-and-artist matches found in the imported library and registers the remainder in a prompt-local candidate set that expires when the turn ends.

This exact check does not prove that a track is absent from complete listening history or that the user has never heard it.

The local planner validates external and mixed plans with the same identity, candidate-set, count, and ordering checks used for library plans.

Selected Apple catalog tracks retain a bounded public catalog reference through planning and later draft reordering, and the CLI/TUI renders those references in a separate public-source appendix.

Private-library tracks never receive a public catalog citation merely because personal listening evidence helped select them.

Open-ended discovery plans select at most one track per release and two per artist unless the user's intent explicitly names that release or artist.

Apple search is lexical catalog retrieval, not semantic similarity or audio analysis.

External recommendation bases show the returned artist connection or catalog search terms, release, and catalog genre when available.
Search terms remain labeled as search terms and are not treated as sonic properties.
Those bases are retained when you reorder the draft, and unsupported model descriptions of tempo, instrumentation, or sound are omitted from the recommendation explanation.

For requests framed as similar to, adjacent to, or branching from a known track, Moondog can start from one trusted prompt-local library TrackRef and use a second read-only path:

1. Resolve the trusted artist credit through an exact [Wikidata](https://www.wikidata.org/wiki/Wikidata:Data_access) label or alias carrying a MusicBrainz artist ID.
2. Fetch listening-derived artist adjacency and bounded recording candidates from the [ListenBrainz artist-radio API](https://listenbrainz.readthedocs.io/en/latest/users/api/core.html).
3. Fetch only basic artist, recording, and release metadata, without requesting MusicBrainz tags or search indexes.
4. Exclude the seed artist, prefer lower-risk standard recordings within each adjacent artist, and register opaque provider-neutral TrackRefs in the same prompt-local planner.

[Wikidata structured identity data](https://www.wikidata.org/wiki/Wikidata:Licensing), [ListenBrainz public listen-derived data](https://listenbrainz.org/data/), and [MusicBrainz core artist, recording, and release metadata](https://musicbrainz.org/doc/MusicBrainz_Database) are CC0.

The default path deliberately avoids MusicBrainz tags, genre associations, and search indexes because those supplementary datasets use a non-commercial license.

The open similarity source is collaborative listening evidence, not audio similarity, a similarity score, proof of personal fit, or proof that a track is unheard.

If Wikidata cannot resolve exactly one artist identity, Moondog does not guess and can fall back to bounded Apple keyword retrieval.

ListenBrainz rate-limit headers and HTTP 429 responses are respected, and repeated identity, radio, and metadata reads use bounded in-memory caches.

Every resolved external discovery result remains an intermediate candidate set.

The agent must call the local planner before returning a track list, and the runtime fails closed if a model tries to render unplanned external candidates.

## Discovery evaluation

Run the three live read-only discovery scenarios against the configured model and local profile with:

```bash
npm run eval:discovery -- --seed Portishead
```

Use a seed artist that exists in the local imported library.

The command records the prompt, bounded tool trace, provider coverage, candidate set, planner result, checks, and score under the Git-ignored `runs/` directory.

Use `--scenario profile_grounded_external_catalog`, `--scenario trusted_seed_open_artist_similarity`, or `--scenario profile_grounded_open_artist_similarity` to run one scenario, and `--json` for machine-readable output.

The gate checks provider provenance, exact trusted candidate membership, requested count, track identity uniqueness, artist and release concentration, novelty-claim boundaries, and local-validation boundaries.

It intentionally does not claim to measure subjective music quality, actual personal novelty, or audio similarity.

Generate a private provider-blind human review packet from any completed discovery artifact with:

```bash
npm run eval:review -- create \
  --input runs/discovery-evaluation-<timestamp>.json
```

The command also writes a self-contained, no-network local review form that downloads a validator-compatible JSON review.

The packet scores every recommendation from 1 to 5 for relevance, serendipity, canonical-recording quality, and explanation usefulness, plus a `would_listen` answer.

Provider, model, tool trace, raw prompt, source identifiers, and the raw listening profile are withheld from the judge packet.

Profile-grounded runs can include a bounded provider-neutral view of preference tracks, familiar tracks, artist facets, and genre facets so an independent judge has enough visible context to evaluate relevance.

Counts, evidence IDs, provider signals, and raw history never enter that view.

Completed reviews are integrity-checked before an aggregate-only summary can be exported.

```bash
npm run eval:review -- status

npm run eval:review -- validate \
  --review runs/completed-<packet-id>-judge-01.json

npm run eval:review -- summarize \
  --review runs/completed-<packet-id>-judge-01.json \
  --manifest runs/discovery-human-review-<packet-id>.manifest.json
```

`status` inventories private packets, manifests, browser forms, completed reviews, invalid artifacts, and the remaining provider-level claim-gate gap without printing music titles, reviewer IDs, profile details, or absolute paths.

If a packet is missing its browser form, regenerate only that local surface without rerunning discovery:

```bash
npm run eval:review -- form \
  --packet runs/discovery-human-review-<packet-id>.json
```

The public summary contains no track, seed, reviewer, model, prompt, artifact-path, or profile details.

Read the full sampling, privacy, rubric, and interpretation contract in [Discovery Human Evaluation](DISCOVERY_HUMAN_EVALUATION.md).

## Spotify connected actions

Moondog can authorize a Spotify account, control an existing Spotify Connect player, resolve imported library tracks against the Spotify catalog, save tracks, create private playlists, and edit eligible existing private playlists through the official Web API.

Create an app in the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard), then register this exact redirect URI:

```text
http://127.0.0.1:43821/callback
```

Configure the public client ID and complete browser OAuth:

```bash
moondog spotify configure <client-id>
moondog spotify login
moondog spotify status --json
```

If Spotify was authorized before A4 S4, run `moondog spotify login` again to grant the private-playlist read scope in addition to the playlist, library, playback, and recent-listening scopes.

`moondog spotify status` reports whether the current authorization has the complete connected-action scope set.

Inspect the current player and available devices:

```bash
moondog spotify account
moondog spotify now
moondog spotify devices
moondog spotify queue
moondog spotify recent --limit 20
```

Control playback with `play`, `pause`, `next`, `previous`, `volume`, `seek`, `shuffle`, and `repeat`.

Use `moondog spotify transfer <device-id> --play` to move playback to a selected Connect device.

Use `moondog spotify queue-add <spotify-uri>` to append a track or episode URI.

Inspect deterministic catalog matching from the shell with:

```bash
moondog spotify resolve \
  --title "Midnight Lines" \
  --artist "Mara Vale" \
  --release "Night Transit" \
  --duration-ms 278000
```

The same commands are available inside the TUI under `/spotify`.

Existing-playlist editing is available through the agent conversation rather than a direct shell mutation command.
Moondog lists only playlists owned by the connected account that are private, non-collaborative, and contain at most 100 tracks.
It rejects local, unavailable, episode, and other unsupported items instead of silently dropping them.

The first turn lists and inspects the live playlist, then renders the complete proposed order and a change summary without writing to Spotify.
Spotify playlist IDs, track URIs, and snapshot IDs remain host-owned and never enter model-visible tool output.
A later explicit confirmation such as `可以，就按刚才预览的精确版本改` applies only that retained draft.

Immediately before the single replacement request, Moondog re-reads the playlist metadata and rejects the write if the Spotify snapshot changed.
It does not automatically retry a playlist edit.
This preflight closes ordinary stale-preview failures, but the Web API does not document an atomic compare-and-swap guarantee for full item replacement, so a narrow race can still exist between the final snapshot read and the write.

This slice follows Spotify's current [private playlist read scope](https://developer.spotify.com/documentation/web-api/concepts/scopes), [playlist item read endpoint](https://developer.spotify.com/documentation/web-api/reference/get-playlists-items), and [replace playlist items endpoint](https://developer.spotify.com/documentation/web-api/reference/reorder-or-replace-playlists-items).

Ingest at most 50 recent Spotify plays into Moondog's private local listening-history store with:

```bash
moondog spotify sync-recent
```

The first run reads Spotify's bounded recent window.

Later runs send the stored millisecond `after` cursor and insert only newly observed plays.

The sync converts Spotify payloads into provider-neutral `TrackRef v1` and `ListeningEvent v1` records before persistence.

Repeated events are deduplicated by a stable event fingerprint.

Import the music portion of either a standard Spotify Account Data ZIP or an Extended Streaming History ZIP directly with:

```bash
moondog spotify import-history /path/to/spotify-history.zip
```

The command detects the export format and leaves the source ZIP unchanged.

This persistent import creates one stable private local music subject when necessary and reuses it for later imports and recent-listening syncs.

If a canonical Apple import is also present, Moondog requires both providers to agree on that subject before combining their evidence.

Use `moondog taste --from /path/to/spotify-history.zip --html` when you want a standalone private preview without Apple setup or a persistent import.

Use `moondog taste --from /path/to/account-data.zip --from /path/to/extended-history.zip --html` when you want both Spotify exports reconciled in one order-independent, in-memory preview.

Use `moondog taste --from /path/to/spotify-history.zip --save --html` when you want the same archive to become the cumulative profile used by later CLI, TUI, and agent profile reads.

For a standard Account Data ZIP, it imports music history plus sanitized music-profile evidence from `YourLibrary.json`, `Playlist1.json`, clicked search results in `SearchQueries.json`, `TasteProfile.json`, `Wrapped2025.json`, and `YourSoundCapsule.json` when those files are present.

Search text is retained only when the export records an interaction with a music entity result.

Provider-generated prose is marked as quoted provider interpretation rather than a user assertion or instruction.

[Spotify documents](https://support.spotify.com/us/article/understanding-my-data/) this standard history as approximately the past year of UTC end times, artist names, track names, and milliseconds played.

Because this format has no Spotify track URI, album identity, device, playback start reason, or playback end reason, imported track references remain provisional and events remain `play_observed` with unknown interaction mode.

Extended Streaming History provides lifetime audio records with second-resolution UTC timestamps, Spotify Track URIs, album metadata, explicit skipped flags, playback reasons, shuffle, offline, and private-session state.

Extended music rows produce resolved Spotify `TrackRef v1` records.

Retained effective plays also support historical-return detection when the same track reappears after one or more gaps of at least 180 days.
The bounded result includes aggregate counts and gap lengths only, excludes active avoids, and does not claim liking, nostalgia, intentional absence, or current preference.

Album metadata now also supports a bounded multi-track release-depth view.
At least three distinct retained track identities must share the same normalized artist and release pair before the release appears.

Eligible effective-event timestamps support the UTC monthly Listening Pulse and fixed-quarter Listening Seasons, while eligible Extended History track-stop timestamps also support approximate listening sessions.
A gap longer than 30 minutes begins a new stretch, and the projection reports only aggregate session shape rather than per-session timestamps or raw event sequences.

Those timestamps and resolved track identities also support **Played back to back** when the same track appears in adjacent retained rows, both plays lasted at least 30 seconds, neither carries an explicit skip, and the gap is no longer than 30 minutes.
Only bounded sequence aggregates are exposed, and the result does not establish repeat mode, intention, liking, or preference.

The profile keeps separate field-coverage denominators for start reason, end reason, skip, shuffle, and offline state.

This makes direct-start, continued-playback, `trackdone`, skip, shuffle, and offline shares accurate even when the profile also contains sources that do not provide those Spotify fields.

An explicit `skipped=true` becomes `play_skipped`; other rows remain `play_observed` rather than inferring completion.

Exact overlaps supersede their lower-resolution standard-history events without deleting the original evidence, while uncertain differences remain separate.
This reconciliation is import-order independent: when Extended History arrives first, Moondog retains its exact upgrade candidates and applies them if matching Account Data arrives later.
Import receipts report both the effective event delta and the number of standard records reconciled, so a large overlap is visible rather than silently double-counted.

The same exact-overlap evidence can establish a cross-format track link when one provisional Account Data TrackRef points to exactly one resolved Extended History TrackRef.
At projection time, remaining effective events from that provisional TrackRef aggregate under the resolved identity, which prevents distinct-track counts and track histories from splitting across formats.
This link never rewrites stored records, and a provisional TrackRef that overlaps more than one resolved target remains separate.
The identity coverage ledger reports applied source links and affected effective events alongside ambiguous provisional identities and effective events deliberately kept separate.

Username, IP address, platform, country, user agent, `offline_timestamp`, raw Spotify URI strings, and raw source payloads are not persisted.

The bundled [field policy](SPOTIFY_EXTENDED_HISTORY_FIELD_POLICY.md) records how every Extended Streaming History field is used, bounded, or intentionally excluded.

The import is transactional, records a SHA-256-backed batch manifest, and is idempotent when the same archive or overlapping records are supplied again.

Unverified search rows, payment data, account identity, advertising segments, podcast history, audiobook history, and video history are not imported into the music profile.

The default store is `~/.local/state/moondog/listening-history.sqlite`, with the same `MOONDOG_STATE_HOME`, `MOONDOG_CONFIG_HOME`, and `XDG_STATE_HOME` overrides used by other local state.

The store is private local state, owns one stable local music subject, and supplies a deterministic `ProfileProjection v1` at read time.

The projection separates explicit saved and followed state, playlist curation, verified search intent, effective listening familiarity, explicit skip context, and provider-derived summaries.

Projection coverage reports the number of provisional track identities joined through exact cross-format evidence, the effective events that use those links, and the ambiguous provisional identities and effective events deliberately kept separate.

Effective history excludes superseded standard events, and incognito events are counted as excluded coverage without affecting taste rankings.

No `TasteEvent` or durable generic-memory claim is created automatically.

Use `moondog profile correct` only when you want to create a direct artist or track assertion.
Those explicit records can supersede or retract one another and affect the next profile projection without changing effective listening events.

Spotify's endpoint returns at most 50 recent tracks and does not support podcast episodes, so this is a bounded activity source rather than complete listening history.

Playback control requires Spotify Premium and an available Spotify Connect device.

The natural-language agent can resolve trusted tracks returned from the imported library, a prompt-local private-history rediscovery set, a long-gap historical-return set, a Spotify Extended History played-back-to-back set, or a chronological Listening Time Machine, check or save them in the Spotify library, queue or play them, and create a private Spotify playlist from the exact validated playlist plan.

When Spotify is the only connected playlist-write provider, a direct request to create, save, or sync a playlist defaults to one private Spotify write in the same turn.

If a turn ends with a validated plan but no write, that provider-neutral plan remains pending in the current process so a follow-up such as `可以`, `就这个`, or `保存它` writes the exact prior order instead of planning again.

Before approval, a later prompt can reorder, remove, replace, or add tracks.
The host exposes the prior draft as a one-prompt trusted candidate set, requires the complete revised order to pass `playlist.plan` again, and performs no provider write during a revision-only turn.
A failed or cancelled revision leaves the previous pending draft available, while a successful revision replaces it and becomes the only draft eligible for a later bare approval.
Replacement and addition may combine the retained draft with fresh private-library, private-history, or external-catalog candidate sets, and retained external discovery sources stay attached to the revised result.

Pending plans retain only the host-owned provider identity needed to resolve trusted private-history tracks, and no Spotify ID or URI enters model-visible output.
That process-local identity is cleared after a successful or partial write, a new plan, a new session, or process exit.

Resolution is prompt-scoped and compares meaningful core titles, complete credited-artist sets, and recognized recording-version markers before considering release, duration, or popularity.

Standard recordings do not silently fall through to recognized live, edit, remix, acoustic, demo, clean, mono, stereo, or collaboration variants.

When only the master differs, Moondog accepts an original-to-remaster or remaster-to-original fallback only with release or duration corroboration, labels it `alternate_master`, and keeps searching for the requested master first.

Resolution cache keys include the matching-policy version, so permissive results from an older policy are not reused after this upgrade.

For a trusted Extended Streaming History track, resolution uses the retained Spotify track ID directly, labels the match `provider_id`, and skips both catalog search and the fuzzy resolution cache.

Successful matches are cached outside the checkout in `~/.local/state/moondog/spotify-resolution-cache.sqlite` by default.

Spotify URIs remain host-side and are not exposed to the model.

The shell and TUI can show account, device, queue, and catalog-resolution data, but account and device metadata are not promoted into generic memory or the music Profile.

Playlist deletion, uncertain history-difference review, and reviewed promotion into revision-aware `TasteEvent` claims remain later Spotify slices.

## Local memory

Moondog now keeps its initial persistent relationship state in a local SQLite database outside the checkout by default.

The default path is `~/.local/state/moondog/memory.sqlite`.

`MOONDOG_STATE_HOME`, `MOONDOG_CONFIG_HOME`, and `XDG_STATE_HOME` can redirect that user-state location.

The stable local route is `local:main`.

Each launch starts a fresh conversation.
Use `/resume` to choose a saved conversation or `/resume <session-id>` to restore one directly.
Restoring a conversation loads its recent transcript and model context together.
Run `/new` to start another conversation while keeping the previous one saved.
Listening-profile state and durable memories remain available across conversations and model or authentication changes.

Only completed user and assistant exchanges are recorded.

Aborted turns, raw tool traces, and prompt-local candidate IDs are not persisted as the conversation transcript.

Each completed exchange also becomes a typed short-term dialogue episode.

`/memory` shows recent episodes, dialogue context, and active durable claims.

Memory tool mutations commit atomically with the completed authoritative exchange, so cancellation discards both.

Use `/remember [fact|preference|constraint|goal] <text>` to save an explicit claim and `/forget <memory-id>` to revise the relationship by removing one.

An explicit remember action records an `explicit_assertion` episode and promotes it into a linked durable claim, making the short-term-to-long-term boundary inspectable.

The non-interactive equivalents are `moondog remember <text>` and `moondog forget <memory-id>`.

These generic claims support conversational continuity, but they are not canonical evidence for musical taste.

Canonical music preferences remain in the `TasteEvent` and Profile domain, where authorized listening observations, evidence, corrections, and revisions can be modeled explicitly.

This A2-thin slice takes the resumable-session and durable-memory experience spine from OpenClaw while Pi continues to provide the agent runtime, model integration, and TUI.

### One-shot memory agent

Run the implemented reflection worker manually with:

```bash
moondog memory reflect
moondog memory reflect --dry-run
moondog memory reflect --json
```

The command checks for work before constructing a Pi model runtime, so an empty queue returns immediately without a model call.

A working run selects at most 24 unprocessed active episodes and creates a fresh dedicated Pi agent with exactly one structured submission tool.

SQLite `reflection_runs` records the bounded batch, lease, proposals, outcome, and checkpoint.

A failed run leaves its episodes unprocessed and retryable.

`--dry-run` records the proposed classifications in the run record but does not advance any episode promotion state.

A completed non-dry run automatically promotes only a general `candidate_memory` that is explicitly asserted and has confidence of at least `0.9`.

Host-side guards prevent time-bounded or expired episodes from becoming persistent claims, prevent a forgotten claim from being resurrected, and leave exact-text kind or horizon conflicts as candidates.

Inferred general claims and every `candidate_music_profile` remain candidates for later review or domain-specific promotion.

Transient material is ignored rather than turned into durable memory.

`moondog memory` and `/memory` expose pending episode count, candidate count, the latest reflection run, and a health state of `running`, `stale`, `degraded`, or `ready`.

No launchd job is installed yet.

Manual behavior should be evaluated first, and a future scheduler should invoke this same one-shot command rather than introduce a second worker path.

The current slice still has no embedding index, continuously running dreaming process, revision-aware `TasteEvent` promotion, or playlist-draft persistence.

With a valid local projection, A1 exposes bounded tools for profile summary with fixed-quarter Listening Seasons, profile evidence explanation, private-library search, private-history rediscovery, long-gap historical returns, Spotify Extended History played-back-to-back sequences, a chronological Listening Time Machine, and pure in-memory playlist planning.

Persistent Spotify-only and ListenBrainz-only profiles expose both private-history planning tools without pretending that an Apple library is present.

With the read-only Apple catalog configured, A3 adds current-release lookup and prompt-local external candidates without weakening the planner trust boundary.

Every selected track must come from a current prompt candidate set or the one-prompt host-retained candidate set for the validated pending draft.

Conversation persistence and explicit durable claims are enabled locally.

Durable playlist-draft persistence across process restarts, public or collaborative playlist editing, playlists above 100 tracks, Telegram, music generation, and revision-aware listening-data promotion are not enabled.

Direct Spotify Connect playback control, explicit private-playlist creation, and two-turn existing private-playlist editing are enabled only after explicit local OAuth setup.

## Verify a checkout

Run the complete public, deterministic gate in an existing checkout:

```bash
npm ci --ignore-scripts
npm run verify
```

The gate first verifies the exact Git-visible release tree and public branch history against path, secret, private-network, symlink, file-count, and byte ceilings.

It then verifies the zero-auth demo contract, public documentation and recording contracts, public roadmap and issue-form structure, and privacy boundaries, compiles every current schema, validates the synthetic fixtures, and runs the complete test suite.

It also packs an explicit reviewed runtime allowlist, installs that tarball into an empty consumer project through an isolated temporary npm cache, and exercises the installed `moondog` binary through CLI help, fictional history generation, one- and two-archive in-memory Taste projection, the six-track offline demo, Studio startup, its no-state production-importer fictional correction loop, one- and two-archive session-only Studio, first and repeated persistent Spotify and ListenBrainz imports, multi-source private Tasteprint rendering, temporary-upload cleanup, a visible retractable listener correction, read-only data inspection, checksummed export, and recoverable reset.

The isolated cache prevents a developer machine's stale or preloaded package metadata from standing in for a clean public dependency resolution.

Each CI matrix job rebuilds the reviewed public source tree in a private temporary directory on Ubuntu, installs the lockfile there, and runs the complete gate without copying Git metadata, ignored files, dependencies, or local state.

The matrix covers Node `22.19.0` and Node `24.x`.

These commands describe the verification paths, not a claim that every current revision has passed them.
Use the results attached to the revision under review for release evidence.

It does not read private imports, local databases, OAuth credentials, or a configured model runtime.

Run only the consumer-package proof with `npm run verify:package`.

Run the entire gate from a private source snapshot with no Git metadata, ignored files, dependencies, or local state copied into it:

```bash
npm run verify:clean-source
```

Create a persistent owner-reviewable bundle from the same verified release tree:

```bash
npm run export:public-source -- --output /absolute/path/to/moondog-public-source
```

The destination's parent directory must already exist, and the command refuses to replace an existing destination.

The bundle contains an exact `source/` tree plus `manifest.json` with relative paths, file modes, byte counts, per-file SHA-256 values, and the release-tree digest.

It contains no Git metadata or ignored local state, performs no publication, and does not infer a license decision.

The export command verifies source and copied release trees, but it does not repeat the locked clean-install proof recorded by `npm run verify:clean-source`.

Run the same isolated snapshot on Linux Node 22.19.0 through Docker:

```bash
npm run verify:clean-linux
```

The Linux proof mounts only the verified temporary snapshot, removes its container afterward, and keeps the downloaded base image in Docker's cache.

## Archived GUI prototypes (paused)

The following Studio and showcase material documents existing prototypes.
It is retained for reference and is outside the current TUI development scope.
`npm run demo:studio` explicitly opens the fictional browser demo; `npm start` opens the TUI.

### Tour the whole product with zero data and zero install

From a source checkout with Node.js `>=22.19.0`, run:

```bash
npm run showcase
```

No dependency installation is required for this first look.
This source-checkout command opens a script-free product overview on `127.0.0.1` with the real fictional Time Machine, Tasteprint, recap card, and grounded agent walkthrough.
It serves an exact allowlist of seven files, reads no private store, makes no external request, loads no analytics, and cannot bind to a public network interface.
Every visible Tasteprint and Time Machine name, track, date, and count is fictional demonstration data.
The dated catalog panel is the explicit exception: it records one public Apple Music US observation from 2026-09-03 and states its storefront boundary.

You can also inspect the [static page](../showcase/index.html) directly.
The complete interactive fictional path also starts before dependency installation with `npm run demo:studio`.
Install the locked dependencies only when you move on to the full CLI, real history, or connected integrations.

The tour also revisits the exact question that exposed the original product gap: `刘森最新的单曲是哪首？`.
A live read-only probe on 2026-09-03 returned four exact-name candidates, then resolved the intended artist by feeding one displayed Apple Music artist page back into the CLI.
The selected page produced 《天长地久》, dated 2026-05-09, as the newest already released single in the Apple Music US storefront.
The captured public-catalog answer records the identity-selection basis, retrieval date, and one-storefront limitation instead of presenting model memory as current fact.
It also shows that the disambiguation hint is not a preference claim and that private listening evidence remains separate from public music-world evidence.
An independent live `Hikki` probe on 2026-09-03 also exercised the automatic public alias path: an exact Wikidata alias linked one MusicBrainz identity to Apple Music artist `18756224`, whose direct lookup returned Hikaru Utada without choosing among Apple's same-name search candidates.
The catalog panel now shows the exact archive-assisted command that turns an explicitly supplied Spotify history ZIP into the same grounded answer without a model.
That command is inert text inside the showcase itself, which never opens or reads a ZIP.

Prepare an owner-reviewable, host-ready copy without publishing it:

```bash
npm run export:showcase -- --output /absolute/path/to/moondog-showcase
```

The exporter refuses an existing destination, rewrites only the verified local asset references for a root `index.html`, and records every public file's byte count and SHA-256 value in `manifest.json`.
The resulting directory contains only fictional public demonstration material and performs no hosting, upload, license decision, or repository change.

### Try the visual product with zero data

With Node.js `>=22.19.0`, run this directly from the source checkout:

```bash
npm run demo:studio
```

No dependency installation is required for this interactive first look.
The command opens a loopback-only fictional Listening Time Machine, monthly Listening Pulse, and fixed-quarter Listening Seasons through the real Studio interface.
At first use it creates the deterministic 52-play fictional Extended Streaming History ZIP in a private temporary directory, passes that file through the production Spotify importer, removes the file, and opens the resulting four-year route, 36-month Listening Pulse with 15 active retained months, 13 retained quarters with 12 active Listening Seasons, three played-back-to-back tracks, 15 approximate listening stretches, and two multi-track release-depth records.
It supports the real apply-and-retract correction loop and exposes the complete synthetic Tasteprint and compact recap card.
This mode never opens the private listening-history store, rejects every user-supplied history import, makes no network or provider request, writes no persistent profile, and disappears when the process stops.
Its dedicated source-checkout launcher keeps the production Spotify importer and profile projection while avoiding the model, Apple-library, and connected-service dependency graph.

From a linked source checkout, the equivalent command is `moondog studio --demo`.

### Open your real history without importing it

When you are ready to see your own listening arc, open one Spotify Account Data or Extended Streaming History ZIP directly from the source checkout:

```bash
npm --silent run demo:studio -- --from "/path/to/spotify-history.zip"
```

No dependency installation is required for this private session.
From a linked source checkout, use `moondog studio --from <spotify-history.zip>`.

If Spotify supplied both standard Account Data and Extended Streaming History, select both without creating persistent state:

```bash
npm --silent run demo:studio -- \
  --from "/path/to/account-data.zip" \
  --from "/path/to/extended-history.zip"
```

The linked-checkout form is `moondog studio --from <account-data.zip> --from <extended-history.zip>`.
Moondog imports both archives under one temporary identity, reconciles exact cross-format overlaps regardless of selection order, and projects the combined result from an in-memory SQLite database.
The two ZIPs must be distinct, their combined size must stay within Studio's displayed limit, and both original files remain unchanged.

This opens the full private Tasteprint, Listening Time Machine, Listening Pulse, Listening Seasons, and continuity-and-change map on `127.0.0.1`, but it does not create or open Moondog's persistent listening-history database.
The source path and private provider identifiers stay out of the page and API response, the import surface is disabled, and no OAuth, model, provider, cloud, or network request is made.
The `--silent` option also stops npm from repeating the expanded script command in its own output, although the path you type may still remain in your shell history.
You can apply and retract direct profile corrections, but those corrections stay only in the current process.
Stopping Studio discards the in-memory profile and corrections, while the original ZIP's bytes and modification time remain unchanged.

### Persistent Studio reference

No Apple Music import, Spotify OAuth, model, or external network request is required:

```bash
npm run studio
```

Studio opens a private `127.0.0.1` page where you can drag in Spotify Account Data, Extended Streaming History, or official saved ListenBrainz JSON, inspect the cumulative profile, and correct its reading without returning to the terminal.

Every qualifying ready profile exposes its Listening Time Machine as the primary visual action, with a monthly Listening Pulse, fixed-quarter Listening Seasons, Music that came back, continuity-and-change, listening-pattern, bounded one-screen recap-card, and complete evidence-backed Tasteprint views alongside it.
Eligible Spotify Extended Streaming History also adds a **Played back to back** view without treating adjacent playback as a declaration of taste.
Studio previews the chronological year landmarks, latest 72 retained UTC months, long-gap track returns, returning artists, approximate session shape, and multi-track release depth before asking for a correction, then links directly to the corresponding evidence inside the Tasteprint.
Both surfaces state how many retained years have a landmark and name any year that remains visible in the listening arc without one.
The adjacent download action saves the exact self-contained card as private HTML, so it remains usable after Studio stops without uploading it anywhere.
Before importing anything, Studio also links to a clearly fictional card rendered by the same production code.

The browser sends the selected history file only to the Moondog process on the same Mac, the working copy is removed after import, and the resulting Tasteprint joins one persistent local music identity.

After import, the same page can record a direct artist or track preference or avoidance, refresh the private Tasteprint, list every active correction, and retract one without changing the underlying plays.
Use **Correct this track** beside a chronological landmark, returning track, or back-to-back sequence to prefill the title and artist, choose a stance, and return to the updated listening view.
Temporary avoidances now filter every listen-again selection while retaining the historical record and explaining any unrepresented year.
Use **Refresh profile** after a CLI correction or local reset to bring the full Tasteprint and recap card up to date.
When a correction is active, Studio links directly to the corresponding evidence section in the refreshed Tasteprint.

No history file ready yet?
Choose **Try the real importer with fictional history** on the first screen to reach the differentiated multi-year result without leaving Studio.
Studio generates the same deterministic 52-play archive used by `moondog demo-history`, runs it through the production importer in memory, and removes the temporary ZIP before presenting the result.
The same in-memory profile exposes its fictional chronological landmarks and Tasteprint, supports apply and retract, and labels every artist, track, and aggregate as synthetic demonstration data.
That interactive profile and its corrections stay only in the Studio process, write no database or Tasteprint file, and disappear when Studio stops.

### First-run Usability Field Kit

This existing protocol evaluates the archived Studio entrypoint and CLI handoff.
It is not a validation protocol for the current terminal-first home and profile flow.

Create a versioned product-first protocol and a self-contained local observer form with:

```bash
npm run eval:usability -- create
```

The eight-task path uses only Moondog's fictional local experience and starts with the zero-install Studio, fictional Listening Time Machine and listening patterns, recap boundary, one correction and retraction, and portable HTML download before asking the newcomer to install the complete CLI, run the zero-auth agent demo, and exercise the real one-off Taste importer.

It records the first hesitation before assistance, the first successful product outcome, every bounded privacy or capability misunderstanding, the stopping point, elapsed time, and facilitator help.

Use an opaque participant label containing no name, email address, account handle, or other direct identifier.

Do not import a participant's music history, enter credentials, connect a provider, perform a provider write, or publish an artifact during the session.

Validate completed private session files and inspect the collection gate with:

```bash
npm run eval:usability -- validate \
  --protocol runs/first-run-usability-<protocol-id>.protocol.json \
  --session runs/completed-first-run-usability-<protocol-id>-newcomer-01.json

npm run eval:usability -- status
```

`status` reports protocols, forms, valid sessions, unique newcomer counts, duplicates, invalid artifacts, and the remaining three-session gap without printing participant IDs, private notes, absolute paths, or music data.

After three unique independent newcomer sessions against one protocol, create the aggregate-only result with `npm run eval:usability -- summarize`.

The public aggregate keeps task rates, time to first success, bounded observation task and category counts, environment counts, and repeated blocked tasks while omitting participant IDs, exact session timestamps, free text, paths, credentials, and music data.

Read the complete setup, collection, privacy, validation, and interpretation contract in [First-run Usability Evaluation](FIRST_RUN_USABILITY.md).
