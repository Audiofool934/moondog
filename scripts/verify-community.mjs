#!/usr/bin/env node

// Checks the public documentation and contribution surfaces for broken links,
// private-data boundaries, and the CI shape. It does not pin documentation
// wording, so docs can change without editing this script.

import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { parse } from "yaml";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function assert(condition, message) {
  if (!condition) throw new Error(`Community surface verification failed: ${message}`);
}

async function read(relativePath) {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}

async function exists(absolutePath) {
  try {
    await stat(absolutePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function readYaml(relativePath) {
  const text = await read(relativePath);
  const value = parse(text);
  assert(value && typeof value === "object" && !Array.isArray(value), `${relativePath} is not a YAML object`);
  return { text, value };
}

const localUserPath = /\/Users\/(?!example\/|private\/|synthetic\/)[A-Za-z0-9._-]+\//u;

// These planning notes stay private and ignored; public files must not link them.
const privateDocuments = [
  "DJ_CLAW_LINEAGE_AND_MIGRATION.md",
  "DJ_CLAW_MIGRATION_MANIFEST.md",
  "NEXT_PHASE_AGENT_DEVELOPMENT.md",
  "NEXT_PHASE_PROFILE_FOUNDATION.md",
];

function linkTargets(markdown) {
  // Fenced code holds example commands and paths, not links.
  const prose = markdown.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gmu, "");
  const targets = [];
  for (const match of prose.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/gu)) {
    targets.push(match[1]);
  }
  for (const match of prose.matchAll(/\b(?:href|src)="([^"]+)"/gu)) {
    targets.push(match[1]);
  }
  return targets;
}

// A clean-source copy has no Git metadata; it passes the release-tree file list instead.
async function releasePaths() {
  const manifestPath = process.env.MOONDOG_RELEASE_TREE_MANIFEST;
  if (manifestPath) return (await readFile(manifestPath, "utf8")).split("\0");
  const { stdout } = await execFileAsync("git", ["ls-files", "-z"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.split("\0");
}

const markdownFiles = (await releasePaths()).filter((relativePath) => relativePath.endsWith(".md"));
assert(markdownFiles.includes("README.md"), "README.md is not tracked");

let checkedLinks = 0;
for (const relativePath of markdownFiles) {
  const text = await read(relativePath);
  assert(!localUserPath.test(text), `${relativePath} contains a local user path`);
  for (const internalDocument of privateDocuments) {
    assert(!text.includes(internalDocument), `${relativePath} names private document ${internalDocument}`);
  }
  for (const target of linkTargets(text)) {
    if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/iu.test(target)) continue;
    const [targetPath] = target.split("#");
    if (!targetPath) continue;
    const resolved = path.resolve(
      repositoryRoot,
      path.dirname(relativePath),
      decodeURIComponent(targetPath),
    );
    assert(
      resolved.startsWith(`${repositoryRoot}${path.sep}`) && (await exists(resolved)),
      `${relativePath} links to a missing file: ${target}`,
    );
    checkedLinks += 1;
  }
}

const readme = await read("README.md");
for (const relativePath of [
  "docs/TERMINAL_GUIDE.md",
  "docs/ROADMAP.md",
  "CONTRIBUTING.md",
  "app/README.md",
  "site/README.md",
]) {
  assert(readme.includes(relativePath), `README does not link ${relativePath}`);
}
const license = await read("LICENSE");
assert(
  readme.includes("Apache License 2.0") && license.includes("Apache License") && license.includes("Version 2.0"),
  "README and LICENSE do not grant the Apache License 2.0",
);

const tuiMedia = [
  "assets/demo/moondog-tui-home.png",
  "assets/demo/moondog-tui-profile.png",
];
for (const relativePath of tuiMedia) {
  assert(readme.includes(relativePath), `README does not show ${relativePath}`);
  const png = await readFile(path.join(repositoryRoot, relativePath));
  assert(
    png.length >= 20 * 1024 && png.length <= 4 * 1024 * 1024 &&
      png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      png.toString("ascii", 12, 16) === "IHDR",
    `${relativePath} is not a bounded PNG terminal capture`,
  );
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  assert(
    width >= 800 && width <= 3200 && height >= 400 && height <= 2200,
    `${relativePath} has implausible terminal-capture dimensions`,
  );
}

const contributing = await read("CONTRIBUTING.md");
assert(
  contributing.includes("Spotify Account Data or Extended Streaming History exports") &&
    contributing.includes("OAuth credentials") &&
    contributing.includes("Personal Tasteprints"),
  "CONTRIBUTING.md has no concrete private-data boundary",
);
const roadmap = await read("docs/ROADMAP.md");
assert(
  roadmap.includes("Do not attach Spotify exports") &&
    roadmap.includes("OAuth credentials") &&
    roadmap.includes("unsanitized logs"),
  "the public roadmap has no private-data reporting boundary",
);
const pullRequestTemplate = await read(".github/PULL_REQUEST_TEMPLATE.md");
assert(
  pullRequestTemplate.includes("listening-history export"),
  ".github/PULL_REQUEST_TEMPLATE.md has no private-data check",
);

const ci = await readYaml(".github/workflows/ci.yml");
const ciVerify = ci.value.jobs?.verify;
assert(
  ci.value.permissions?.contents === "read" &&
    ciVerify?.["runs-on"] === "ubuntu-latest",
  "CI does not retain its read-only Ubuntu boundary",
);
assert(
  JSON.stringify(ciVerify.strategy?.matrix?.node) ===
    JSON.stringify(["22.19.0", "24.x"]),
  "CI does not cover the minimum and current Node lines",
);
assert(Array.isArray(ciVerify.steps), "CI has no verification steps");
assert(
  ciVerify.steps.some(
    (step) => step?.uses === "actions/checkout@v4" &&
      step?.with?.["fetch-depth"] === 0,
  ),
  "CI does not inspect complete tracked history",
);
assert(
  ciVerify.steps.some(
    (step) => step?.uses === "actions/setup-node@v4" &&
      step?.with?.["node-version"] === "${{ matrix.node }}",
  ),
  "CI does not bind setup-node to its matrix",
);
const packageJson = JSON.parse(await read("package.json"));
const declaredNpm = packageJson.packageManager?.replace(/^npm@/u, "");
assert(
  ciVerify.steps.some(
    (step) => step?.run === `npm install --global npm@${declaredNpm}`,
  ),
  "CI does not install the declared npm version",
);
assert(
  ciVerify.steps.some(
    (step) => step?.run === "npm run verify:clean-source",
  ),
  "CI does not rebuild and verify the public source tree",
);

function formItem(form, id) {
  return form.body.find((item) => item?.id === id);
}

function validateIssueForm(relativePath, form, requiredIds) {
  assert(typeof form.name === "string" && form.name.trim(), `${relativePath} has no name`);
  assert(
    typeof form.description === "string" && form.description.trim(),
    `${relativePath} has no description`,
  );
  assert(typeof form.title === "string" && form.title.startsWith("["), `${relativePath} has no bounded title prefix`);
  assert(Array.isArray(form.body) && form.body.length > 0, `${relativePath} has no form body`);

  const ids = form.body
    .map((item) => item?.id)
    .filter((id) => typeof id === "string");
  assert(new Set(ids).size === ids.length, `${relativePath} contains duplicate field IDs`);
  for (const id of requiredIds) {
    const item = formItem(form, id);
    assert(item, `${relativePath} is missing ${id}`);
    assert(item.validations?.required === true, `${relativePath} does not require ${id}`);
  }

  const privacy = formItem(form, "privacy");
  assert(privacy?.type === "checkboxes", `${relativePath} has no privacy checkboxes`);
  assert(
    Array.isArray(privacy.attributes?.options) &&
      privacy.attributes.options.length > 0 &&
      privacy.attributes.options.every((option) => option?.required === true),
    `${relativePath} privacy confirmations are not individually required`,
  );
}

const bugPath = ".github/ISSUE_TEMPLATE/bug.yml";
const productIdeaPath = ".github/ISSUE_TEMPLATE/product-idea.yml";
const bug = await readYaml(bugPath);
const productIdea = await readYaml(productIdeaPath);
validateIssueForm(bugPath, bug.value, [
  "surface",
  "environment",
  "steps",
  "expected",
  "actual",
]);
validateIssueForm(productIdeaPath, productIdea.value, [
  "listener_problem",
  "scenario",
  "outcome",
  "boundaries",
  "completion_evidence",
]);
for (const { relativePath, text } of [
  { relativePath: bugPath, text: bug.text },
  { relativePath: productIdeaPath, text: productIdea.text },
]) {
  assert(
    text.includes("Do not") &&
      /private (?:music|listening) data/iu.test(text) &&
      /credential/iu.test(text),
    `${relativePath} has no visible private-data warning`,
  );
  assert(!localUserPath.test(text), `${relativePath} contains a local user path`);
}
const config = await readYaml(".github/ISSUE_TEMPLATE/config.yml");
assert(config.value.blank_issues_enabled === false, "blank GitHub issues are still enabled");

process.stdout.write(
  `Verified community and CI surfaces: ${markdownFiles.length} Markdown files with ${checkedLinks} local links, README links and terminal captures, private-data boundaries, issue forms, and the clean-source CI matrix.\n`,
);
