import { compareReleaseVersions, releaseVersion } from "../src/core/application-update.mjs";

// electron-builder names an x64 AppImage x86_64, as AppImage tools expect.
const assetNames = {
  mac: (version) => `Moondog-${version}-arm64.dmg`,
  windows: (version) => `Moondog-${version}-win-x64.exe`,
  linux: (version) => `Moondog-${version}-linux-x86_64.AppImage`,
};

function stableDownload(releases, assetName) {
  const candidates = releases.flatMap(release => {
    const version = release.tag_name?.replace(/^v/u, "");
    if (release.draft || release.prerelease || !releaseVersion(version) || version.includes("-")) return [];
    const asset = release.assets?.find(item => item.name === assetName(version) && item.state === "uploaded");
    return asset ? [{ url: asset.browser_download_url, version }] : [];
  });
  return candidates.sort((a, b) => compareReleaseVersions(b.version, a.version))[0] ?? null;
}

/** Each platform's newest complete stable release. Each platform's file can arrive separately. */
export function stableDesktopDownloads(releases) {
  return Object.fromEntries(Object.entries(assetNames).map(([platform, assetName]) => [platform, stableDownload(releases, assetName)]));
}
