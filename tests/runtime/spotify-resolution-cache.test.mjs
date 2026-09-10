import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  openSpotifyResolutionCache,
  resolveSpotifyResolutionCachePath,
  spotifyResolutionCacheKey,
} from "../../src/integrations/spotify/resolution-cache.mjs";

const resolvedEntry = {
  status: "resolved",
  match_quality: "exact",
  matched: {
    title: "Midnight Lines",
    artists: ["Mara Vale"],
    album: "Night Transit",
    duration_ms: 278_000,
  },
  spotify: {
    track_id: "abc123",
    uri: "spotify:track:abc123",
  },
};

test("cache key is stable across field order and whitespace", () => {
  const left = spotifyResolutionCacheKey({
    title: "Midnight Lines",
    artist_credit: "Mara Vale",
    release: "Night Transit",
  });
  const right = spotifyResolutionCacheKey({
    release: "Night Transit",
    title: "  Midnight   Lines ",
    artist_credit: "Mara Vale",
  });
  assert.equal(left, right);
  assert.match(left, /^[0-9a-f]{64}$/u);
});

test("cache key separates different releases of the same track", () => {
  const left = spotifyResolutionCacheKey({
    title: "Midnight Lines",
    artist_credit: "Mara Vale",
    release: "Night Transit",
  });
  const right = spotifyResolutionCacheKey({
    title: "Midnight Lines",
    artist_credit: "Mara Vale",
    release: "Night Transit (Deluxe)",
  });
  assert.notEqual(left, right);
});

test("resolution cache persists resolved entries across reopen", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-resolution-cache-"));
  const databasePath = path.join(root, "spotify-resolution-cache.sqlite");
  try {
    const cache = await openSpotifyResolutionCache({ databasePath });
    const cacheKey = spotifyResolutionCacheKey({
      title: "Midnight Lines",
      artist_credit: "Mara Vale",
      release: "Night Transit",
    });
    assert.equal(await cache.get(cacheKey), null);
    await cache.put(cacheKey, resolvedEntry, 1_788_000_000_000);
    const stored = await cache.get(cacheKey);
    assert.deepEqual(stored, resolvedEntry);
    const remasterKey = "alternate-master-key";
    const remasterEntry = {
      ...resolvedEntry,
      match_quality: "alternate_master",
      matched: {
        ...resolvedEntry.matched,
        title: "Midnight Lines (2011 Remastered)",
      },
    };
    await cache.put(remasterKey, remasterEntry, 1_788_000_000_001);
    assert.deepEqual(await cache.get(remasterKey), remasterEntry);
    cache.close();

    const reopened = await openSpotifyResolutionCache({ databasePath });
    assert.deepEqual(await reopened.get(cacheKey), resolvedEntry);
    assert.deepEqual(await reopened.get(remasterKey), remasterEntry);
    reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolution cache ignores entries without a Spotify identity", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-resolution-cache-"));
  const databasePath = path.join(root, "spotify-resolution-cache.sqlite");
  try {
    const cache = await openSpotifyResolutionCache({ databasePath });
    await cache.put(
      "not-found-key",
      { status: "not_found" },
      1_788_000_000_000,
    );
    await cache.put(
      "identity-less-key",
      { status: "resolved", matched: { title: "x" } },
      1_788_000_000_000,
    );
    assert.equal(await cache.get("not-found-key"), null);
    assert.equal(await cache.get("identity-less-key"), null);
    cache.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolution cache path honors explicit state directories", () => {
  const explicit = resolveSpotifyResolutionCachePath({
    MOONDOG_STATE_HOME: "/tmp/moondog-state",
  });
  assert.equal(
    explicit,
    path.join("/tmp/moondog-state", "spotify-resolution-cache.sqlite"),
  );

  const xdg = resolveSpotifyResolutionCachePath({
    XDG_STATE_HOME: "/tmp/xdg-state",
  });
  assert.equal(
    xdg,
    path.join("/tmp/xdg-state", "moondog", "spotify-resolution-cache.sqlite"),
  );

  assert.throws(
    () =>
      resolveSpotifyResolutionCachePath({
        MOONDOG_STATE_HOME: "relative/path",
      }),
    TypeError,
  );
});
