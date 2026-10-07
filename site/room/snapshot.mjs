// Builds the fictional listening data that the browser room reads.
// The real CLI imports the fictional Spotify history into a throwaway state folder,
// then the real application answers the questions the room asks, saved as JSON.
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const output = path.join(root, "site", "generated", "snapshot.json");
const work = await mkdtemp(path.join(tmpdir(), "moondog-web-room-"));

try {
  const environment = {
    MOONDOG_STATE_HOME: path.join(work, "state"),
    MOONDOG_CONFIG_HOME: path.join(work, "config"),
    MOONDOG_APPLE_IMPORTS_ROOT: path.join(work, "apple", "imports"),
    MOONDOG_APPLE_PROJECTION_PATH: path.join(work, "apple", "projection.sqlite"),
    MOONDOG_LYRICS: "off",
  };
  // Set before the stores load, so nothing can touch the real state.
  Object.assign(process.env, environment);
  const cli = (...args) => promisify(execFile)(process.execPath, [
    "--disable-warning=ExperimentalWarning", path.join(root, "scripts", "moondog.mjs"), ...args,
  ], { env: { ...process.env, ...environment } });

  const archive = path.join(work, "fictional-spotify-history.zip");
  await cli("demo-history", "--output", archive);
  await cli("spotify", "import-history", archive);

  const { openListeningHistoryStore } = await import("../../src/profile/listening-history-store.mjs");
  const { createListeningProfileDomainServices } = await import("../../src/core/listening-profile-domain-services.mjs");
  const { MoondogApplication } = await import("../../src/core/moondog-application.mjs");

  const listeningHistoryStore = await openListeningHistoryStore();
  const subjectId = listeningHistoryStore.localSubjectId();
  const application = new MoondogApplication({
    domainServices: createListeningProfileDomainServices({ listeningHistoryStore, subjectId }),
    locale: "en",
  });
  const runtimeStatus = { state: "offline", reason: "model_not_configured" };

  const profileSummary = await application.getProfileSummary({ maxItems: 10 });
  const evidenceIds = new Set();
  JSON.stringify(profileSummary, (key, value) => {
    if (key === "evidence_id" && typeof value === "string") evidenceIds.add(value);
    return value;
  });
  const evidence = {};
  for (const evidenceId of evidenceIds) {
    evidence[evidenceId] = await application.explainProfileEvidence({ evidenceId });
  }
  const localCommands = {};
  for (const command of ["taste", "status", "sources"]) {
    try { localCommands[command] = await application.runLocalCommand(command, runtimeStatus); } catch {}
  }
  // The model menu shows the real provider list, but nothing can connect from the page.
  const { listPiModels, listPiProviders } = await import("../../src/runtime/pi/model-catalog.mjs");
  const { supportedAuthProviderIds } = await import("../../src/runtime/pi/authentication.mjs");
  const providers = listPiProviders();
  const snapshot = {
    schema: "moondog.web-room-snapshot.v0",
    fictional: true,
    providers,
    models: Object.fromEntries(providers.map(({ id }) => [id, listPiModels(id)])),
    authProviderIds: [...supportedAuthProviderIds],
    profileSummary,
    evidence,
    lyricSeeds: await application.getLyricSeeds(),
    sourceStatus: await application.sourceStatus(),
    localCommands,
  };
  application.close?.();
  listeningHistoryStore.close();

  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(snapshot)}\n`);
  console.log(`Wrote ${path.relative(root, output)}: ${Object.keys(evidence).length} evidence entries, ${Object.keys(localCommands).join(", ")}.`);
} finally {
  await rm(work, { recursive: true, force: true });
}
