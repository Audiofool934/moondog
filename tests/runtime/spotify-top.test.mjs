import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { SPOTIFY_DEFAULT_SCOPES } from "../../src/integrations/spotify/authentication.mjs";
import { createSpotifyWebApiClient } from "../../src/integrations/spotify/web-api-client.mjs";
import { createSpotifyService } from "../../src/integrations/spotify/service.mjs";
import { createSpotifyCredentialStore } from "../../src/integrations/spotify/credential-store.mjs";
import { writeSpotifyConfiguration } from "../../src/integrations/spotify/settings.mjs";
import { openSpotifyConnection } from "../../src/integrations/spotify/connection.mjs";
import { MoondogApplication } from "../../src/core/moondog-application.mjs";

for (const type of ["artists", "tracks"]) for (const range of ["short_term", "medium_term", "long_term"]) {
  test(`top ${type} uses current endpoint and bounded ${range} affinity semantics`, async () => {
    let requests = 0;
    const service = createSpotifyService({ client: createSpotifyWebApiClient({ tokenProvider: async () => "fictional-token", fetchImpl: async (url, options) => {
      requests++;
      const parsed = new URL(url);
      assert.equal(parsed.pathname, `/v1/me/top/${type}`);
      assert.equal(parsed.searchParams.get("time_range"), range);
      assert.equal(parsed.searchParams.get("offset"), "0");
      assert.equal(parsed.searchParams.get("limit"), "3");
      assert.equal(options.method, "GET");
      return new Response(JSON.stringify({ total: 200, next: "untrusted-url", items: Array.from({ length: 50 }, (_, i) => ({
        id: `fictional${i}`, uri: `spotify:track:fictional${i}`, name: `Affinity ${i}`, artists: [{ name: "Fictional Artist" }], images: [{ url: "PRIVATE_IMAGE" }], followers: { total: 500 }, genres: ["UNTRUSTED"],
      })) }));
    } }) });
    const value = await service.topItems({ type, timeRange: range, limit: 3 });
    assert.equal(requests, 1);
    assert.equal(value.items.length, 3);
    assert.equal(value.truncated, true);
    assert.equal(value.time_range, range);
    assert.deepEqual(value.items.map((i) => i.affinity_rank), [1, 2, 3]);
    assert.doesNotMatch(JSON.stringify(value), /PRIVATE_IMAGE|followers|UNTRUSTED|play_count/u);
  });
}

test("top request rejects unsupported ranges/types/limits and honors cancellation without HTTP", async () => {
  let requests = 0;
  const service = createSpotifyService({ client: { getTopItems: async () => { requests++; return { items: [] }; } } });
  for (const input of [{ type: "albums" }, { timeRange: "all_time" }, { limit: 0 }, { limit: 11 }, { limit: 1.5 }]) await assert.rejects(service.topItems(input));
  await assert.rejects(service.topItems({}, { signal: AbortSignal.abort() }));
  assert.equal(requests, 0);
  assert.deepEqual((await service.topItems()).items, []);
});

test("existing authorization reports missing user-top-read without granting it or disabling other features", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-top-scopes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const environment = { MOONDOG_CONFIG_HOME: root };
  await writeSpotifyConfiguration("fictional-client", environment);
  const store = createSpotifyCredentialStore({ environment });
  const credential = { type: "oauth", accessToken: "fictional-access", refreshToken: "fictional-refresh", accessExpiresAt: Date.now() + 3600_000,
    refreshExpiresAt: Date.now() + 86400_000, tokenType: "Bearer", scope: SPOTIFY_DEFAULT_SCOPES.filter((s) => s !== "user-top-read").join(" ") };
  await store.write(credential);
  let requests = 0;
  const connection = await openSpotifyConnection({ environment, fetchImpl: async () => { requests++; return new Response(JSON.stringify({ items: [] })); } });
  const application = new MoondogApplication({ importsRoot: path.join(root, "missing"), spotifyConnection: connection });
  t.after(() => application.close());
  assert.equal(connection.ready(), true);
  assert.deepEqual(connection.missingScopes(), ["user-top-read"]);
  await assert.rejects(application.spotifyTopItems({}), (e) => e.code === "spotify_top_scope_missing" && /login/u.test(e.message));
  assert.equal(requests, 0);
  assert.equal((await store.read()).scope, credential.scope);
  await store.write({ ...credential, scope: SPOTIFY_DEFAULT_SCOPES.join(" ") });
  await connection.refreshStatus();
  assert.deepEqual((await application.spotifyTopItems({})).items, []);
  assert.equal(requests, 1);
});
