import path from "node:path";

// Install production dependencies on the same OS and architecture that will run them.
// Cross-compiling Electron alone would carry the build machine's optional native modules.
export function desktopTarget(platform = process.platform, arch = process.arch) {
  if (platform === "darwin" && arch === "arm64") return { platform, arch, targets: ["dmg", "zip"], unpacked: "mac-arm64", feed: "latest-mac.yml" };
  if (platform === "win32" && arch === "x64") return { platform, arch, targets: ["nsis"], unpacked: "win-unpacked", feed: "latest.yml" };
  if (platform === "linux" && arch === "x64") return { platform, arch, targets: ["AppImage"], unpacked: "linux-unpacked", feed: "latest-linux.yml" };
  throw new Error(`No desktop build for ${platform}/${arch}. Build on macOS arm64, Windows x64, or Linux x64.`);
}

export function desktopConfig({ root, version, target, sign = false, notarize = false, identity, musicUsage, music = false }) {
  const icon = path.join(root, "assets/brand/moondog-app-icon.png");
  return {
    appId: "ai.audiofool.moondog",
    productName: "Moondog",
    extraMetadata: { version },
    directories: { output: "release/apps.noindex", buildResources: "build-resources" },
    files: ["package.json", "main.mjs", "preload.cjs", "core-process.mjs", "window-room.mjs", "preview-player.mjs", "strings.mjs", "updates.mjs", "platform.mjs", "lifecycle.mjs",
      "dist/**/*", "!dist/**/*.map"],
    // GitHub prereleases use the same per-platform feed names as stable releases.
    publish: [{ provider: "github", owner: "Audiofool934", repo: "moondog", channel: "latest" }],
    asar: false,
    extraResources: [
      { from: "build/room", to: ".", filter: ["**/*"] },
      { from: "build/room/node_modules", to: "node_modules", filter: ["**/*"] },
      { from: path.join(root, "assets/brand"), to: "brand", filter: ["moondog-app-icon.png", "moondog-app-icon-dark.png"] },
    ],
    extraFiles: target.platform === "darwin" && music ? [{ from: "native/build/moondog-music", to: "MacOS/moondog-music" }] : [],
    mac: {
      category: "public.app-category.music",
      icon,
      hardenedRuntime: true,
      gatekeeperAssess: false,
      entitlements: "build-resources/entitlements.mac.plist",
      entitlementsInherit: "build-resources/entitlements.mac.plist",
      extendInfo: { NSAppleMusicUsageDescription: musicUsage, NSAppleEventsUsageDescription: "Moondog reads what you play in Music, and the playlist it comes from." },
      identity: sign ? identity : null,
      notarize,
    },
    dmg: { title: "Moondog ${version}" },
    win: { icon, artifactName: "Moondog-${version}-win-${arch}.${ext}" },
    nsis: { oneClick: true, perMachine: false, deleteAppDataOnUninstall: false },
    linux: {
      icon,
      executableName: "moondog",
      category: "AudioVideo",
      artifactName: "Moondog-${version}-linux-${arch}.${ext}",
      desktop: { entry: { Comment: "A personal listening room", Categories: "AudioVideo;Audio;" } },
    },
  };
}
