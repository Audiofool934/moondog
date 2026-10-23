// Spotify keeps only a listener's last 50 plays, about three hours of listening. The
// room runs its listening upkeep when it opens and every half hour while it runs: it
// reads recent plays before they fall out, then rebuilds the saved reading when due.
export const LISTENING_UPKEEP_INTERVAL_MS = 30 * 60_000;

export function startListeningUpkeep({ run, intervalMs = LISTENING_UPKEEP_INTERVAL_MS }) {
  let running = null;
  let stopped = false;
  const tick = async () => {
    // A rebuild can outlast the half hour; the next tick waits for the one after.
    if (stopped || running) return;
    running = new AbortController();
    try {
      await run({ signal: running.signal });
    } catch {
      // Signed out, offline or rate limited: the next tick tries again, and nothing waits on this one.
    } finally {
      running = null;
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  tick();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
      running?.abort();
    },
  };
}
