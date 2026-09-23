# Listening-data import experience

The import journey should help a listener bring useful evidence into Moondog, understand what arrived, and return when more history becomes available.
It starts before the listener has a file and ends with an inspectable listening profile in the same Pi TUI session.

## Product direction: bring music from the services people use

Import is a user-facing product journey, and broad music-service coverage is an active product priority.
The target service set includes Spotify, Apple Music, YouTube Music, QQ Music and NetEase Cloud Music, with room for additional services.
This target list describes the direction; the implemented paths below describe what listeners can use today.

Start with the service name the listener recognizes, then explain what they can bring and how to bring it.
File formats, account setup and provider-specific requirements belong in the relevant step, after the listener understands the outcome.
Manual developer-app setup is a limitation of the current Spotify connection path, not the desired experience for ordinary listeners.

Keep two user goals across services:

- **Quick start:** build an initial profile from the easiest useful data available, such as favorite songs, playlists, a library snapshot or recent listening.
- **Add past listening:** bring older listening records where a verified export or authorized connection provides them.

A service does not need complete historical access before its useful library or playlist import can ship.
Label those imports by what they actually contain, and keep favorites, playlist membership, aggregate play counts and timestamped listening events distinct.
Missing timestamps or played duration remain unknown; a collection of songs does not become a fabricated play history.

## Acceptance for each service

- A listener can find their service and understand which data is supported before signing in or requesting a download.
- Each guide identifies the exact official website or app path, the data to select, any waiting or notification step, where the resulting file is saved and how to return to Moondog.
- The guide follows the provider's actual acquisition flow; some services may require an app or a support request instead of an export website.
- Every selectable import route has a verified path from source data through preview, explicit confirmation and cumulative-profile review.
- A guide-only route is clearly labeled before the listener spends time requesting data, and does not imply that its files can already be imported.
- A failed or unsupported import explains what happened and offers the next usable action while retaining the listener's input.
- Multiple services contribute to the same local profile, with source coverage and uncertain track matches kept visible.
- Keyboard navigation, narrow terminals and returning from the export website work throughout the journey.

## Expansion sequence

1. Add YouTube Music through official exported files, validating actual library, playlist and activity samples before declaring the corresponding data types supported.
   Separate music activity from ordinary YouTube viewing and retain only the listening facts supplied by the source.
2. Validate QQ Music and NetEase Cloud Music favorites and playlist acquisition, then ship the simplest reliable user path for each service.
   Confirm link accessibility, file contents and song identity with representative samples instead of assuming a shared export format.
3. Extend historical coverage as actual provider exports become available, including the Apple privacy archive path currently limited to guidance.
   A personal-information copy request alone does not establish that complete listening history will be supplied.

For each new service, ship a usable end-to-end import slice and update its visible support description together.

## First slice: getting started

`/import` first asks for **Spotify** or **Apple Music**, then offers quick start and a past-history path for that service.
The home action and command palette open that same guide.
An unfinished conversation draft remains available after leaving the guide.

Spotify quick start reads up to 50 recent plays and previews the retained dates and track count before saving.
It needs a Spotify connection, but no model or downloaded history archive.
The connection step requests only `user-read-recently-played`; playback and playlist permissions remain part of the separate full Spotify login.
This source does not include actual played duration, and it does not reconstruct older listening.
Empty results, expired authorization, app access denial, and quota failures keep the archive path available.
Repeated recent imports use the existing event fingerprints and do not duplicate the same recent observations.

This release uses a configured Spotify client ID rather than a shared public app.
The guide explains the one-time developer-app setup, opens Spotify Dashboard, and accepts the public Client ID in the TUI.
No client secret is requested.
Spotify currently limits new development apps to five allowlisted users and requires Premium for the app owner.
These platform prerequisites remain visible; the guide does not promise universal one-click connection.

Add past listening history supports an existing ZIP, a data-request guide, and a waiting screen that links back to Quick start.
The Spotify guide displays `https://www.spotify.com/account/privacy/` and opens that site from a dedicated action.
It directs the listener to Download your data and Extended Streaming History, explains the email confirmation and download, and returns them to `/import > Spotify > Add past listening history`.
Downloads normally go to the browser's Downloads folder or the location chosen by the listener.
Account Data contains past-year history and supported profile observations; Extended Streaming History provides longer coverage and more playback details.
Spotify prepares the archive asynchronously, so requesting it is separate from importing it.
Both routes open the cumulative Profile immediately after saving and preserve prior listening and explicit corrections.
Recent API observations and archive streams can overlap; their different timestamp semantics do not support a blanket cross-format deduplication claim.

Apple Music quick start uses Music on Mac's File > Library > Export Library to produce a local XML.
The same preview and confirmation flow imports the exact retained snapshot, rebuilds its shared Apple projection, and opens the cumulative Profile in the current terminal.
Favorites, ratings and aggregate play counts remain library observations; the importer creates no fabricated listening events.
An identical XML is an idempotent import, and an existing Spotify profile keeps its local subject and listening events.
If rebuilding the projection fails after the library was saved, the receipt is retained and `/reload` retries that rebuild.

The Apple past-history guide displays and opens `https://privacy.apple.com/`.
It explains Request a copy of your data, Apple Media Services information, the ready notification, downloading from Data & Privacy within 14 days, and locating the saved files.
It explicitly states that Apple privacy archive import is not implemented and offers the working XML route instead.
Opening either website does not submit a request, download a file, or import data automatically.
If browser opening fails, the guide keeps its place and displays the exact URL for manual use.

The file step accepts Spotify ZIP, Apple Music library XML and ListenBrainz JSON formats.
It uses Pi's editor and path completion, accepts pasted or dragged local paths, and retains the input when a file cannot be read.
Extracted Spotify folders or individual Spotify JSON files receive guidance to use the original ZIP.
ListenBrainz remains available under Other sources.

Inspection shows the source, file name, record and track counts, listening dates, supplied played durations, and other supported music observations.
The dates describe listening retained in the selected file, not when the file was imported or how current the listener's complete profile is.
This preview describes the file's contents; it does not estimate its net effect against an existing profile.
No listening records are added until the listener chooses **Import into my profile**.
The host commits the same parsed bundle that was inspected, without reading a changed source file again.

The process names the actual reading, saving, and profile-refresh stages without invented percentages.
An active read or save step is not interruptible in this slice.
Before saving, the listener can return to the file step or leave the guide.

The completed receipt reports newly stored records, already-present records, and reconciled overlaps when applicable.
Newly stored records are not presented as an equal increase in effective plays, because a richer record can replace an overlapping observation.
The receipt is kept before profile refresh, so a display failure cannot conceal a successful import.
The cumulative profile then opens immediately for evidence inspection and Like, Avoid, or retraction.
Repeated imports preserve existing history and explicit corrections.

## Next slice: understand each update

A source-history view should separate **listening through**, **imported on**, and **what this file changed**.
It should show which sources and date ranges contribute to the profile, including unknown actual played durations.
Corrections or a new import must not make older listening appear current.

An incremental preview should compare against the current profile and distinguish new effective plays, duplicate records, richer replacements, and newly covered dates.
A repeated file should explain that the profile is already up to date with that file rather than celebrate an empty import.
Imported saved-library snapshots must retain their observation date; a missing item in a later snapshot is not yet implemented as an unsave event.
Cross-provider identity gaps must stay visible rather than being hidden behind an assumed universal deduplication count.

## Next slice: recover and keep listening

Cancellation should stop work before the transactional save boundary and clearly distinguish **nothing saved** from **saved, profile refresh failed**.
Progress should come from actual archive members or records once the readers expose those stages.
Large-file optimization should follow measurements of representative archives.

The return path should make the next useful step obvious: inspect an unexpected profile reading, correct one preference, or explore a grounded listening plan.
Later history can then add evidence to the same profile and improve the next listening session.
Broader service support follows the expansion sequence above.
An automatic recent-play collector and per-import undo remain separate product decisions rather than implied promises of the first-import guide.

## Source guidance

Spotify documents its download entry on the [account privacy page](https://support.spotify.com/us/article/data-rights-and-privacy-settings/) and the difference between [Account Data and Extended Streaming History](https://support.spotify.com/us/article/understanding-your-data/).
Apple documents [exporting library information as XML on Mac](https://support.apple.com/guide/music/mus27cd5060f/mac).
Current commands and format limits are described in the [terminal guide](TERMINAL_GUIDE.md#import-and-inspect-listening-history).
