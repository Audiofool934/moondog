// Build on the target OS: macOS arm64 (DMG/zip), Windows x64 (NSIS), Linux x64 (AppImage).
// The window carries exactly the npm package's core with production dependencies for this host.
// `--dir` leaves an unpacked app for smoke tests; `--sign` signs/notarizes the macOS release.
// Nothing is published by this script.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Arch, build, Platform } from "electron-builder";
import { buildMusicHelper, MUSIC_USAGE } from "./native/build.mjs";
import { desktopConfig, desktopTarget } from "./pack-config.mjs";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const work = path.join(here, "build");
const room = path.join(work, "room");
const release = path.join(here, "release");
const output = path.join(release, "apps.noindex");
const flags = new Set(process.argv.slice(2));
for (const flag of flags) if (!["--dir", "--sign", "--no-notarize"].includes(flag)) throw new Error(`Unknown build option: ${flag}`);
const target = desktopTarget();
const sign = flags.has("--sign");
if (sign && target.platform !== "darwin") throw new Error("--sign is the macOS Developer ID release path. Windows signing uses electron-builder's CSC_LINK and CSC_KEY_PASSWORD.");
const notarize = sign && !flags.has("--no-notarize");

// npm.cmd cannot be execFile'd on Windows. Invoke npm's JavaScript entrypoint directly,
// including when Node/npm live in a directory containing spaces, without a command shell.
const npmCli = process.env.npm_execpath || (process.platform === "win32" ? [
  path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  ...(process.env.PATH || process.env.Path || "").split(path.delimiter).map((dir) => path.join(dir, "node_modules", "npm", "bin", "npm-cli.js")),
].find((file) => existsSync(file)) : null);
if (process.platform === "win32" && !npmCli) throw new Error("Could not find npm's entrypoint. Run this build with npm run pack.");
const npm = (args, options) => run(npmCli ? process.execPath : "npm", npmCli ? [npmCli, ...args] : args, { maxBuffer: 32 * 1024 * 1024, ...options });

await rm(work, { recursive: true, force: true });
await mkdir(room, { recursive: true });
const { stdout } = await npm(["pack", "--json", "--ignore-scripts", "--pack-destination", work], { cwd: root });
const [{ filename }] = JSON.parse(stdout);
// Windows 10 and newer include bsdtar in System32. A GNU tar earlier on PATH, such as Git's,
// would read the C: in an absolute path as a remote host.
const tar = process.platform === "win32" ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
await run(tar, ["-xzf", path.join(work, filename), "-C", room, "--strip-components=1"]);
await cp(path.join(root, "package-lock.json"), path.join(room, "package-lock.json"));
// The npm package lists macOS and Linux only, because its terminal launcher is a shell script.
// The Windows app carries the same core, so its install skips that platform check.
await npm(["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", ...(process.platform === "win32" ? ["--force"] : [])], { cwd: room });

await run(process.execPath, [path.join(here, "build.mjs")]);
const music = target.platform === "darwin" ? await buildMusicHelper({ bundle: false }) : null;
const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
if (notarize) process.env.APPLE_KEYCHAIN_PROFILE = process.env.MOONDOG_NOTARY_PROFILE ?? process.env.APPLE_NOTARY_PROFILE ?? "mac-mini-notary";
const platform = { darwin: Platform.MAC, win32: Platform.WINDOWS, linux: Platform.LINUX }[target.platform];
await rm(output, { recursive: true, force: true });
await build({
  projectDir: here,
  targets: platform.createTarget(flags.has("--dir") ? ["dir"] : target.targets, Arch[target.arch]),
  publish: "never",
  config: desktopConfig({ root, version, target, sign, notarize, identity: process.env.MOONDOG_SIGNING_IDENTITY, musicUsage: MUSIC_USAGE, music: Boolean(music) }),
});

if (flags.has("--dir")) console.log(path.relative(here, path.join(output, target.unpacked)));
else {
  // Only final deliverables move to release/, replacing a build of the same version. Earlier versions
  // stay, so an update can be tried between two builds. Unpacked Mac bundles stay inside .noindex while
  // building, and are removed once the archives are complete so Spotlight never offers them.
  for (const file of await readdir(output, { withFileTypes: true })) {
    if (!file.isFile() || !/\.(?:dmg|zip|exe|AppImage|blockmap|yml)$/u.test(file.name) || file.name.startsWith("builder-")) continue;
    await rename(path.join(output, file.name), path.join(release, file.name));
    console.log(path.join("release", file.name));
  }
  if (target.platform === "darwin") await rm(path.join(output, target.unpacked), { recursive: true, force: true });
}
