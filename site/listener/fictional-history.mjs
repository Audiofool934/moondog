// The fictional listener behind the website room and the online agent.
// The real CLI imports the fictional Spotify history into a folder of its own,
// so nothing here can touch a real listener's state.
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function fictionalEnvironment(work) {
  return {
    MOONDOG_STATE_HOME: path.join(work, "state"),
    MOONDOG_CONFIG_HOME: path.join(work, "config"),
    MOONDOG_APPLE_IMPORTS_ROOT: path.join(work, "apple", "imports"),
    MOONDOG_APPLE_PROJECTION_PATH: path.join(work, "apple", "projection.sqlite"),
    MOONDOG_LYRICS: "off",
  };
}

export async function prepareFictionalHistory(work) {
  const environment = fictionalEnvironment(work);
  await mkdir(work, { recursive: true });
  const cli = (...args) => promisify(execFile)(process.execPath, [
    "--disable-warning=ExperimentalWarning", path.join(root, "scripts", "moondog.mjs"), ...args,
  ], { env: { ...process.env, ...environment } });
  const archive = path.join(work, "fictional-spotify-history.zip");
  await cli("demo-history", "--output", archive);
  await cli("spotify", "import-history", archive);
  return { environment, databasePath: path.join(environment.MOONDOG_STATE_HOME, "listening-history.sqlite") };
}
