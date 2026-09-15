# Listening-data import experience

The import journey should help a listener bring useful evidence into Moondog, understand what arrived, and return when more history becomes available.
It starts before the listener has a file and ends with an inspectable listening profile in the same Pi TUI session.

## First slice: getting started

`/import` is the shared entry for three situations: a file is ready, the listener needs to request Spotify data, or the platform is still preparing the download.
The home action and command palette open that same guide.
An unfinished conversation draft remains available after leaving the guide.

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
