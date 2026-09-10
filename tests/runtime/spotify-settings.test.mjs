import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  readSpotifyConfiguration,
  resolveSpotifySettingsFile,
  writeSpotifyConfiguration,
} from "../../src/integrations/spotify/settings.mjs";

async function fixture(context) {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-spotify-settings-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    environment: { MOONDOG_CONFIG_HOME: root },
  };
}

test("Spotify client ID is stored separately from model settings", async (context) => {
  const value = await fixture(context);
  assert.equal(await readSpotifyConfiguration(value.environment), undefined);

  const written = await writeSpotifyConfiguration(
    "spotifyClientId1234567890",
    value.environment,
  );

  assert.deepEqual(written, {
    clientId: "spotifyClientId1234567890",
    source: "settings",
  });
  assert.deepEqual(await readSpotifyConfiguration(value.environment), written);
  assert.deepEqual(
    JSON.parse(await readFile(resolveSpotifySettingsFile(value.environment))),
    {
      version: 1,
      client_id: "spotifyClientId1234567890",
    },
  );
});

test("Spotify client ID environment override does not mutate settings", async (context) => {
  const value = await fixture(context);
  await writeSpotifyConfiguration("savedSpotifyClient123", value.environment);

  assert.deepEqual(
    await readSpotifyConfiguration({
      ...value.environment,
      MOONDOG_SPOTIFY_CLIENT_ID: "overrideSpotifyClient456",
    }),
    {
      clientId: "overrideSpotifyClient456",
      source: "environment",
    },
  );
});

test("Spotify settings reject unexpected fields", async (context) => {
  const value = await fixture(context);
  const settingsFile = resolveSpotifySettingsFile(value.environment);
  await writeSpotifyConfiguration("spotifyClientId123", value.environment);
  await writeFile(
    settingsFile,
    JSON.stringify({
      version: 1,
      client_id: "spotifyClientId123",
      client_secret: "must-not-live-here",
    }),
  );

  await assert.rejects(
    readSpotifyConfiguration(value.environment),
    (error) => error?.code === "spotify_settings_invalid",
  );
});
