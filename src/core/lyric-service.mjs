import { setTimeout as delay } from "node:timers/promises";
import { createLrclibProvider } from "../integrations/lyrics/lrclib.mjs";
import { openLyricLibrary } from "./lyric-library.mjs";

/** Background enrichment; rendering and model prompts never fetch lyrics. */
export async function createLyricService({ environment = process.env, library, provider = createLrclibProvider(), now = Date.now, throttleMs = 300 } = {}) {
  const store = library ?? await openLyricLibrary({ environment });
  let lastRefresh = { state: "idle", fetched: 0 };
  return {
    selectHome(seeds) { return store.selectHome(seeds); },
    status() { return { ...store.status(), refresh: lastRefresh }; },
    async refresh({ tracks }, { signal, onUpdate = () => {} } = {}) {
      if (environment.MOONDOG_LYRICS === "off") return lastRefresh = { state: "offline", fetched: 0 };
      if (store.retryAt() > now()) return lastRefresh = { state: "deferred", fetched: 0 };
      const boundedSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
      lastRefresh = { state: "refreshing", fetched: 0 };
      try {
        for (const track of tracks) {
          boundedSignal.throwIfAborted();
          const cached = store.get(track);
          const ttl = cached?.state === "ready" || cached?.state === "instrumental" ? 30 * 86_400_000 : 7 * 86_400_000;
          if (cached && now() - cached.fetchedAt < ttl) continue;
          if (lastRefresh.fetched >= 12) break;
          // Requests remain sequential, including batches started in later sessions.
          await delay(throttleMs, undefined, { signal: boundedSignal });
          const record = await provider.lookup(track, { signal: boundedSignal });
          boundedSignal.throwIfAborted();
          store.put(track, record, now());
          lastRefresh.fetched++;
          onUpdate();
        }
        lastRefresh.state = "ready";
      } catch (error) {
        lastRefresh.state = boundedSignal.aborted ? "cancelled" : "unavailable";
        if (!boundedSignal.aborted) store.deferUntil(now() + Math.max(60_000, error.retryAfterMs ?? 60_000));
      }
      return { ...lastRefresh };
    },
    close() { if (!library) store.close(); },
  };
}
