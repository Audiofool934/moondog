import { cp, lstat, mkdir } from "node:fs/promises";
import path from "node:path";

import { legacyAppleMusicImportsRoot, resolveAppleMusicImportsRoot } from "./apple-library-source-status.mjs";
import { resolveAppleMusicProjectionPath } from "./apple-projection-domain-services.mjs";
import { legacyAppleMusicProjectionPath } from "../importers/apple-music-library/index.mjs";

async function kind(target) {
  try {
    const metadata = await lstat(target);
    return metadata.isSymbolicLink() ? "link" : metadata.isDirectory() ? "directory" : "file";
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function copyOnce(from, to, expected) {
  if ((await kind(from)) !== expected || (await kind(to)) !== null) return false;
  await mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
  await cp(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
  return true;
}

/**
 * Earlier versions kept Apple Music data inside the source checkout. Copy it
 * into the default private state directory once, leaving the original in
 * place. Runs with an explicit state or Apple location are never touched, so
 * isolated runs such as tests cannot pull private data into their directories.
 */
export async function migrateLegacyAppleMusicData(environment = process.env) {
  const explicit = [
    "MOONDOG_STATE_HOME",
    "MOONDOG_CONFIG_HOME",
    "MOONDOG_APPLE_IMPORTS_ROOT",
    "MOONDOG_APPLE_PROJECTION_PATH",
  ].some((name) => environment[name]?.trim());
  if (explicit) return { copied: [] };
  const copied = [];
  if (await copyOnce(legacyAppleMusicImportsRoot, resolveAppleMusicImportsRoot(environment), "directory")) {
    copied.push("imports");
  }
  if (await copyOnce(legacyAppleMusicProjectionPath, resolveAppleMusicProjectionPath(environment), "file")) {
    copied.push("projection");
    for (const suffix of ["-wal", "-shm"]) {
      await copyOnce(`${legacyAppleMusicProjectionPath}${suffix}`, `${resolveAppleMusicProjectionPath(environment)}${suffix}`, "file");
    }
  }
  return { copied };
}
