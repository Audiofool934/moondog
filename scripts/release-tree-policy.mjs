import path from "node:path";

const allowedUserPathPlaceholders = new Set([
  "example",
  "private",
  "synthetic",
]);

const userPathPatterns = [
  {
    label: "macOS user path",
    pattern: /(?:file:\/\/)?\/Users\/([A-Za-z0-9._-]+)\//gu,
  },
  {
    label: "Linux user path",
    pattern: /(?:file:\/\/)?\/home\/([A-Za-z0-9._-]+)\//gu,
  },
  {
    label: "Windows user path",
    pattern: /[A-Za-z]:\\Users\\([^\\\s]+)\\/giu,
  },
];

const exactContentPatterns = [
  {
    label: "private key",
    pattern: new RegExp(
      ["-----BEGIN ", "(?:RSA |EC |OPENSSH )?", "PRIVATE KEY-----"].join(""),
      "u",
    ),
  },
  {
    label: "GitHub access token",
    pattern: new RegExp(["gh", "[pousr]", "_", "[A-Za-z0-9]{20,}"].join(""), "u"),
  },
  {
    label: "OpenAI API key",
    pattern: new RegExp(["sk", "-", "[A-Za-z0-9_-]{20,}"].join(""), "u"),
  },
  {
    label: "AWS access key",
    pattern: new RegExp(["AK", "IA", "[0-9A-Z]{16}"].join(""), "u"),
  },
  {
    label: "npm access token",
    pattern: new RegExp(["npm", "_", "[A-Za-z0-9]{20,}"].join(""), "u"),
  },
  {
    label: "credential-bearing URL",
    pattern: /https?:\/\/[^/@\s:]+:[^/@\s]+@/iu,
  },
  {
    label: "personal Spotify export name",
    pattern: new RegExp(["my", "spotify", "data"].join("_"), "iu"),
  },
  {
    label: "private IPv4 address",
    pattern:
      /\b(?:10\.(?:[0-9]{1,3}\.){2}[0-9]{1,3}|192\.168\.[0-9]{1,3}\.[0-9]{1,3}|172\.(?:1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3})\b/u,
  },
];

const exactAllowedPaths = new Set([
  ".gitignore",
  "AGENTS.md",
  "CONTRIBUTING.md",
  "README.md",
  "package-lock.json",
  "package.json",
  "showcase/index.html",
  "tests/fixtures/apple-music-library/minimal.xml",
]);

const allowedPathPrefixes = [
  ".github/",
  "assets/",
  "contracts/",
  "docs/",
  "scripts/",
  "src/",
  "tests/",
];

const forbiddenExtensions = new Set([
  ".db",
  ".env",
  ".key",
  ".log",
  ".musiclibrary",
  ".p12",
  ".pem",
  ".sqlite",
  ".sqlite3",
  ".temp",
  ".tgz",
  ".tmp",
  ".xml",
  ".zip",
]);

const forbiddenBasenames = new Set([
  ".ds_store",
  ".spotify_pkce.json",
  ".spotify_token.json",
  "auth-profiles.json",
  "credentials.json",
  "secrets.json",
]);

export const maximumReleaseEntries = 350;
export const maximumReleaseFileBytes = 5 * 1024 * 1024;
export const maximumReleaseTreeBytes = 15 * 1024 * 1024;

export const requiredReleasePaths = new Set([
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/ISSUE_TEMPLATE/bug.yml",
  ".github/ISSUE_TEMPLATE/config.yml",
  ".github/ISSUE_TEMPLATE/product-idea.yml",
  ".github/workflows/ci.yml",
  ".gitignore",
  "AGENTS.md",
  "CONTRIBUTING.md",
  "README.md",
  "assets/brand/moondog-lunar-record/EXPORT_MANIFEST.md",
  "assets/brand/moondog-lunar-record/moondog-logo-1x1.png",
  "assets/demo/moondog-offline-demo.gif",
  "assets/demo/moondog-studio-tour.gif",
  "assets/demo/moondog-tasteprint-demo.html",
  "contracts/v1/definitions.schema.json",
  "contracts/v2/profile-evidence.schema.json",
  "docs/PRIVATE_TASTEPRINT.md",
  "docs/PRODUCT_CHARTER.md",
  "docs/PUBLIC_RELEASE_READINESS.md",
  "docs/ROADMAP.md",
  "docs/verification/linux-node-22.19.0.json",
  "package-lock.json",
  "package.json",
  "scripts/export-public-source.mjs",
  "scripts/export-showcase.mjs",
  "scripts/capture-studio-tour.mjs",
  "scripts/demo-studio.mjs",
  "scripts/moondog",
  "scripts/public-source-tree.mjs",
  "scripts/showcase.mjs",
  "scripts/verify-clean-source.mjs",
  "scripts/verify-release-tree.mjs",
  "scripts/verify-showcase.mjs",
  "src/demo/fictional-spotify-history.mjs",
  "src/demo/moondog-demo.mjs",
  "src/integrations/spotify/extended-streaming-history.mjs",
  "src/profile/listener-corrections.mjs",
  "src/profile/local-music-data.mjs",
  "src/surfaces/cli/data-command.mjs",
  "src/surfaces/cli/profile-command.mjs",
  "src/surfaces/web/showcase.mjs",
  "src/surfaces/web/studio.mjs",
  "tests/runtime/moondog-showcase.test.mjs",
  "tests/runtime/moondog-demo-history.test.mjs",
  "tests/core/showcase-export.test.mjs",
]);

export const requiredIgnoredPaths = [
  ".env",
  ".spotify_pkce.json",
  ".spotify_token.json",
  "Library.xml",
  "auth-profiles.json",
  "data/imports/account-data.zip",
  "data/private/listening-history.json",
  "docs/DJ_CLAW_LINEAGE_AND_MIGRATION.md",
  "docs/DJ_CLAW_MIGRATION_MANIFEST.md",
  "docs/NEXT_PHASE_AGENT_DEVELOPMENT.md",
  "docs/NEXT_PHASE_PROFILE_FOUNDATION.md",
  "local.musiclibrary/Library.musicdb",
  "moondog.log",
  "outputs/tasteprint.html",
  "profile.db",
  "profile.sqlite",
  "profile.sqlite3",
  "runs/discovery/private-review.json",
];

export function validateReleasePath(relativePath) {
  const issues = [];
  const normalized = relativePath.split(path.sep).join("/");
  const segments = normalized.split("/");
  const basename = segments.at(-1)?.toLocaleLowerCase("en-US") ?? "";
  const extension = path.posix.extname(normalized).toLocaleLowerCase("en-US");

  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.includes("\0") ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    issues.push("unsafe path");
  }
  if (
    !exactAllowedPaths.has(normalized) &&
    !allowedPathPrefixes.some((prefix) => normalized.startsWith(prefix))
  ) {
    issues.push("unexpected release-tree path");
  }
  if (
    !exactAllowedPaths.has(normalized) &&
    normalized !== ".env.example" &&
    (forbiddenBasenames.has(basename) || forbiddenExtensions.has(extension))
  ) {
    issues.push("private or generated file type");
  }
  return issues;
}

export function scanForbiddenContent(buffer) {
  const source = Buffer.isBuffer(buffer) ? buffer.toString("latin1") : String(buffer);
  const issues = [];

  for (const { label, pattern } of userPathPatterns) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const username = match[1].toLocaleLowerCase("en-US");
      if (!allowedUserPathPlaceholders.has(username)) issues.push(label);
    }
  }
  for (const { label, pattern } of exactContentPatterns) {
    if (pattern.test(source)) issues.push(label);
  }
  return [...new Set(issues)];
}
