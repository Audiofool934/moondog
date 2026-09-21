# Listening-data import experience

The import journey should help a listener bring useful evidence into Moondog, understand what arrived, and return when more history becomes available.
It starts before the listener has a file and ends with an inspectable listening profile in the same Pi TUI session.

## First slice: getting started

`/import` starts with two Spotify paths: **Quick start** and **Add past listening history**.
The home action and command palette open that same guide.
An unfinished conversation draft remains available after leaving the guide.

Quick start reads up to 50 recent Spotify plays and previews the retained dates and track count before saving.
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
Account Data contains past-year history and supported profile observations; Extended Streaming History provides longer coverage and more playback details.
Spotify prepares the archive asynchronously, so requesting it is separate from importing it.
Both routes open the cumulative Profile immediately after saving and preserve prior listening and explicit corrections.
Recent API observations and archive streams can overlap; their different timestamp semantics do not support a blanket cross-format deduplication claim.

The file step accepts the existing Spotify ZIP and ListenBrainz JSON formats.
It uses Pi's editor and path completion, accepts pasted or dragged local paths, and retains the input when a file cannot be read.
Extracted Spotify folders or individual Spotify JSON files receive guidance to use the original ZIP.
Apple Music XML remains a separate library-import workflow and is described as a library snapshot rather than streaming history.

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
An automatic recent-play collector, broader source support, and per-import undo are separate product decisions rather than implied promises of the first-import guide.

## Source guidance

Spotify documents its download entry on the [account privacy page](https://support.spotify.com/us/article/data-rights-and-privacy-settings/) and the difference between [Account Data and Extended Streaming History](https://support.spotify.com/us/article/understanding-your-data/).
Apple documents [exporting library information as XML on Mac](https://support.apple.com/guide/music/mus27cd5060f/mac).
Current commands and format limits are described in the [terminal guide](TERMINAL_GUIDE.md#import-and-inspect-listening-history).
