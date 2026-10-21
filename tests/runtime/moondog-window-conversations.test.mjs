import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { projectSpotifyExtendedStreamingHistory } from "../../src/integrations/spotify/extended-streaming-history.mjs";
import { openListeningHistoryStore } from "../../src/profile/listening-history-store.mjs";

const execFileAsync = promisify(execFile);
const cliEntry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/moondog.mjs");

// Stands in for the desktop app: it registers a host, so the launcher hands its room services
// here, opens conversations through them, and prints what it saw once the launcher has closed.
const host = `
const report = {};
globalThis[Symbol.for("moondog.host")] = {
  musicPreviewPlayer: null,
  closed() { process.stdout.write("REPORT " + JSON.stringify(report) + "\\n"); },
  async runRoom(services) {
    const { application } = services;
    const first = await services.openConversation();
    const second = await services.openConversation({ reason: "app_start" });
    first.application.recordCompletedTurn("FIRST_REQUEST", "FIRST_ANSWER");
    second.application.recordCompletedTurn("SECOND_REQUEST", "SECOND_ANSWER");
    const firstSession = first.application.memorySession.session_id;
    const secondSession = second.application.memorySession.session_id;
    report.sessions = { distinct: firstSession !== secondSession,
      listed: application.listSavedSessions().map((row) => row.session_id).filter((id) => [firstSession, secondSession].includes(id)).length };
    report.shared = [first, second].every(({ application: open }) => open.ownsServices === false &&
      open.memoryStore === application.memoryStore && open.musicCatalog === application.musicCatalog &&
      open.webResearch === application.webResearch && open.spotifyConnection === application.spotifyConnection &&
      open.locale === application.locale);
    report.forked = first.application.domainServices !== application.domainServices &&
      first.application.domainServices !== second.application.domainServices &&
      first.application.domainServices.constructor === application.domainServices.constructor;
    report.runtime = first.runtime.publicStatus().state;
    report.duplicate = await services.openConversation({ sessionId: firstSession }).then(() => "opened", (error) => error.message);

    second.close();
    const reopened = await services.openConversation({ sessionId: secondSession });
    report.reopened = reopened.application.currentConversationTurns().map((turn) => turn.text);
    report.rebuilt = (await services.rebuildRuntime(undefined, reopened.application)).publicStatus().state;

    const oldFork = first.application.domainServices;
    await services.refreshImportedData();
    const newFork = first.application.domainServices;
    report.refreshed = { replaced: newFork !== oldFork && newFork !== application.domainServices,
      oldClosed: (() => { try { oldFork.profileStatus(); return false; } catch { return true; } })(),
      newState: newFork.profileStatus().state };

    const previous = application.spotifyConnection;
    await services.runSpotify(["status"]);
    report.spotify = application.spotifyConnection !== previous &&
      [first, reopened].every(({ application: open }) => open.spotifyConnection === application.spotifyConnection);

    first.close();
    reopened.close();
    report.afterClose = application.listSavedSessions().length;
    return {};
  },
};
await import(process.env.MOONDOG_TEST_ENTRY);
`;

test("the launcher opens window conversations on its shared services and keeps them current", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-window-conversations-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const environment = {
    PATH: path.dirname(process.execPath),
    HOME: path.join(root, "home"),
    MOONDOG_STATE_HOME: path.join(root, "state"),
    MOONDOG_CONFIG_HOME: path.join(root, "config"),
    MOONDOG_APPLE_IMPORTS_ROOT: path.join(root, "apple-imports"),
    MOONDOG_APPLE_PROJECTION_PATH: path.join(root, "apple-projection.sqlite"),
    MOONDOG_CODEX_BIN: path.join(root, "no-codex"),
    MOONDOG_UPDATE_CHECK: "off",
    MOONDOG_LYRICS: "off",
    MOONDOG_TEST_ENTRY: pathToFileURL(cliEntry).href,
  };
  // Fictional listening, so the launcher builds real domain services the conversations fork.
  const store = await openListeningHistoryStore({ environment });
  const subjectId = store.localSubjectId({ create: true });
  const record = (ts) => ({ ts, ms_played: 300_000, master_metadata_track_name: "Fictional Window Song",
    master_metadata_album_artist_name: "Fictional Window Artist", master_metadata_album_album_name: "Fictional Window Album",
    spotify_track_uri: "spotify:track:0000000000000000000001", reason_start: "clickrow", reason_end: "trackdone",
    shuffle: false, skipped: false, offline: false, incognito_mode: false });
  store.ingestImport(projectSpotifyExtendedStreamingHistory({ subjectId, capturedAt: "2026-10-01T00:00:00.000Z",
    archiveSha256: "b".repeat(64), archiveSizeBytes: 4096, memberNames: ["Streaming_History_Audio_2026.json"],
    records: [record("2026-09-20T04:00:00Z"), record("2026-09-21T04:00:00Z")] }));
  store.close();

  const { stdout } = await execFileAsync(process.execPath,
    ["--disable-warning=ExperimentalWarning", "--input-type=module", "--eval", host],
    { env: environment, maxBuffer: 2 * 1024 * 1024 });
  const report = JSON.parse(stdout.split("\n").find((line) => line.startsWith("REPORT ")).slice("REPORT ".length));
  assert.deepEqual(report, {
    sessions: { distinct: true, listed: 2 },
    shared: true,
    forked: true,
    runtime: "offline",
    duplicate: "That conversation is already open.",
    reopened: ["SECOND_REQUEST", "SECOND_ANSWER"],
    rebuilt: "offline",
    refreshed: { replaced: true, oldClosed: true, newState: "ready" },
    spotify: true,
    afterClose: 2,
  });
});
