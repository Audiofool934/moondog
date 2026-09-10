import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { openSpotifyConnection } from "../../src/integrations/spotify/connection.mjs";
import { writeSpotifyConfiguration } from "../../src/integrations/spotify/settings.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-spotify-connection-"));
  return {
    environment: { MOONDOG_CONFIG_HOME: root },
    close: () => rm(root, { recursive: true, force: true }),
  };
}

test("Spotify connection stays disabled until a client ID is configured", async (context) => {
  const value = await fixture();
  context.after(value.close);

  const connection = await openSpotifyConnection({
    environment: value.environment,
  });

  assert.equal(connection.ready(), false);
  assert.deepEqual(connection.publicStatus(), {
    provider: "spotify",
    state: "not_configured",
    reason: "client_id_required",
    authentication: "not_configured",
    client_id_configured: false,
    external_effects: "disabled",
  });
  assert.equal(connection.service, null);
});

test("Spotify connection exposes an unauthenticated service without making a request", async (context) => {
  const value = await fixture();
  context.after(value.close);
  await writeSpotifyConfiguration("spotifyClientId123", value.environment);

  const connection = await openSpotifyConnection({
    environment: value.environment,
    fetchImpl: async () => {
      throw new Error("unexpected request");
    },
  });

  assert.equal(connection.ready(), false);
  assert.equal(connection.publicStatus().state, "not_authenticated");
  assert.equal(typeof connection.service.currentPlayer, "function");
});
