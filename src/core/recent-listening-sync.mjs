// Spotify keeps only a listener's last 50 plays, about three hours of listening. The
// room reads them when it opens and every half hour while it runs, so few fall out unseen.
export const RECENT_LISTENING_SYNC_INTERVAL_MS = 30 * 60_000;

export function startRecentListeningSync({ sync, onSynced = () => {}, intervalMs = RECENT_LISTENING_SYNC_INTERVAL_MS }) {
  let running = null;
  let stopped = false;
  const run = async () => {
    if (stopped || running) return;
    running = new AbortController();
    try {
      const result = await sync({ signal: running.signal });
      if (!stopped && result) await onSynced(result);
    } catch {
      // Signed out, offline or rate limited: the next run tries again, and nothing waits on this one.
    } finally {
      running = null;
    }
  };
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  run();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
      running?.abort();
    },
  };
}
