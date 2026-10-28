// Builds the Apple Music helper (music.swift) for Apple silicon.
//   native/build/moondog-music     the executable pack.mjs puts beside the app's own, in Contents/MacOS
//   native/build/apps.noindex/Moondog Music.app the executable in a bundle MusicKit knows as Moondog, for
//                                  `npm start`, signed with the Developer ID when the keychain has one
// Without Xcode's Swift compiler there is no helper, and the window keeps playing previews.
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "build");
const executable = path.join(out, "moondog-music");
const bundle = path.join(out, "apps.noindex", "Moondog Music.app");

export const MUSIC_USAGE = "Moondog plays the songs you ask for from Apple Music.";

// The helper's Info.plist. It is also linked into the executable itself, so the packaged copy in
// Contents/MacOS is signed as ai.audiofool.moondog like the app around it, however it is signed.
const INFO = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>ai.audiofool.moondog</string>
  <key>CFBundleExecutable</key><string>moondog-music</string>
  <key>CFBundleName</key><string>Moondog</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>NSAppleMusicUsageDescription</key><string>${MUSIC_USAGE}</string>
</dict></plist>
`;

/**
 * Compiles the helper. With bundle (the default), also puts it in the development bundle and signs
 * that; packaging asks for the executable alone and leaves the development bundle as it was.
 */
export async function buildMusicHelper({ bundle: withBundle = true } = {}) {
  if (process.platform !== "darwin") return null;
  await mkdir(out, { recursive: true });
  const info = path.join(out, "Info.plist");
  await writeFile(info, INFO);
  try {
    await run("xcrun", ["swiftc", "-O", "-parse-as-library", "-swift-version", "5", "-target", "arm64-apple-macos14.0",
      "-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", info,
      path.join(here, "music.swift"), "-o", executable], { maxBuffer: 8 * 1024 * 1024 });
  } catch (error) {
    console.warn(`The Apple Music helper was not built, so the app plays previews: ${String(error.stderr || error.message).trim().split("\n")[0]}`);
    return null;
  }
  if (!withBundle) return { executable };
  await rm(bundle, { recursive: true, force: true });
  await mkdir(path.join(bundle, "Contents", "MacOS"), { recursive: true });
  await copyFile(executable, path.join(bundle, "Contents", "MacOS", "moondog-music"));
  await chmod(path.join(bundle, "Contents", "MacOS", "moondog-music"), 0o755);
  await copyFile(info, path.join(bundle, "Contents", "Info.plist"));
  // MusicKit trusts the team's signature; an ad-hoc signature still runs, but Apple gives it no token.
  const identity = process.env.MOONDOG_SIGNING_IDENTITY || "Developer ID Application";
  await run("codesign", ["--force", "--options", "runtime", "--sign", identity, bundle]).catch(() =>
    run("codesign", ["--force", "--sign", "-", bundle]));
  return { executable, bundle };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const built = await buildMusicHelper();
  if (built) console.log(path.relative(process.cwd(), built.bundle));
}
