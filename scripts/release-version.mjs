import { readFile, appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { releaseVersion, UPDATE_PACKAGE } from "../src/core/application-update.mjs";

export function releaseChannel({ name, version, lockVersion, tag }) {
  if (name !== UPDATE_PACKAGE || !releaseVersion(version) || lockVersion !== version || tag !== `v${version}`) {
    throw new Error("Release tag, package identity, package version and lockfile version must agree.");
  }
  return version.includes("-beta.") ? "beta" : "latest";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
  if (lock.version !== pkg.version) throw new Error("Top-level lockfile version differs from package.json.");
  const channel = releaseChannel({ ...pkg, lockVersion: lock.packages[""].version, tag: process.argv[2] });
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `channel=${channel}\nversion=${pkg.version}\n`);
  process.stdout.write(`${pkg.version} → ${channel}\n`);
}
