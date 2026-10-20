// Sources record different measures for each play. Spotify's extended history
// records how long a play lasted and, for most plays, whether it was skipped.
// Spotify account data records only the length. Last.fm and most ListenBrainz
// listens record neither, and an Apple library counts plays for some tracks
// only. A measure that no play recorded is unknown: it never becomes a zero
// that reads as no listening time, never skipped, or unplayed.

/** Whether all, some or none of `total` items recorded a measure. */
export function recordedShare(total, recorded, atLeast = 1) {
  if (recorded >= total * atLeast) return "all";
  return recorded === 0 ? "none" : "some";
}

/**
 * What a set of plays recorded: its listening time and its skips, each "all",
 * "some" or "none". `timedPlayCount` counts plays with a recorded length, and
 * `skipKnownCount` counts plays that say whether they were skipped.
 */
export function recordedMeasures({ playCount, timedPlayCount, skipKnownCount }) {
  return {
    time: recordedShare(playCount, timedPlayCount),
    skips: recordedShare(playCount, skipKnownCount),
  };
}
