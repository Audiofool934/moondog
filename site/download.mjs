import { compareReleaseVersions, releaseVersion } from "../src/core/application-update.mjs";

export function stableMacDownload(releases) {
  const candidates = releases.flatMap(release => {
    const version = release.tag_name?.replace(/^v/u, "");
    if (release.draft || release.prerelease || !releaseVersion(version) || version.includes("-")) return [];
    const dmg = release.assets?.find(asset => asset.name === `Moondog-${version}-arm64.dmg` && asset.state === "uploaded");
    return dmg ? [{ url: dmg.browser_download_url, version }] : [];
  });
  return candidates.sort((a, b) => compareReleaseVersions(b.version, a.version))[0] ?? null;
}
