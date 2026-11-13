import { compareReleaseVersions, releaseVersion } from "../src/core/application-update.mjs";

// electron-builder names an x64 AppImage x86_64, as AppImage tools expect.
const assetNames = {
  mac: (version) => `Moondog-${version}-arm64.dmg`,
  windows: (version) => `Moondog-${version}-win-x64.exe`,
  linux: (version) => `Moondog-${version}-linux-x86_64.AppImage`,
};

// The newest release with this platform's uploaded file, stable or, with beta, a prerelease.
function newestDownload(releases, assetName, { beta }) {
  const candidates = releases.flatMap(release => {
    const version = release.tag_name?.replace(/^v/u, "");
    if (release.draft || !releaseVersion(version)) return [];
    const isBeta = release.prerelease || version.includes("-");
    if (isBeta !== beta) return [];
    const asset = release.assets?.find(item => item.name === assetName(version) && item.state === "uploaded");
    return asset ? [{ url: asset.browser_download_url, version, ...(beta ? { beta: true } : {}) }] : [];
  });
  return candidates.sort((a, b) => compareReleaseVersions(b.version, a.version))[0] ?? null;
}

/**
 * Each platform's download. Each platform's file can arrive separately, so each is chosen on its own.
 * The Mac offers only a complete stable release. Windows and Linux offer their newest stable release,
 * or, until they have one, their newest beta, marked so the page can call it a test build.
 */
export function desktopDownloads(releases) {
  return Object.fromEntries(Object.entries(assetNames).map(([platform, assetName]) => [platform,
    newestDownload(releases, assetName, { beta: false })
      ?? (platform === "mac" ? null : newestDownload(releases, assetName, { beta: true }))]));
}
