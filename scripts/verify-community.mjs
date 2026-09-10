#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

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

async function readJson(relativePath) {
  const text = await read(relativePath);
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Community surface verification failed: ${relativePath} is not valid JSON: ${error.message}`);
  }
  assert(value && typeof value === "object" && !Array.isArray(value), `${relativePath} is not a JSON object`);
  return { text, value };
}

async function readYaml(relativePath) {
  const text = await read(relativePath);
  const value = parse(text);
  assert(value && typeof value === "object" && !Array.isArray(value), `${relativePath} is not a YAML object`);
  return { text, value };
}

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

const roadmap = await read("docs/ROADMAP.md");
for (const expected of [
  "## North star",
  "## Shipped product foundation",
  "## Now: prove the personal loop",
  "## Next: deepen discovery and collaboration",
  "## Later: creative agent tools",
  "## Owner gates before a licensed release",
  "## Turning roadmap items into issues",
]) {
  assert(roadmap.includes(expected), `the public roadmap is missing ${expected}`);
}
assert((roadmap.match(/^- \[ \]/gmu) ?? []).length >= 10, "the public roadmap has too few issue-ready outcomes");
assert(
  roadmap.includes("Do not attach Spotify exports") &&
    roadmap.includes("OAuth credentials") &&
    roadmap.includes("unsanitized logs"),
  "the public roadmap has no private-data reporting boundary",
);
const readme = await read("README.md");
const terminalGuide = await read("docs/TERMINAL_GUIDE.md");
const publicDocumentation = `${readme}\n${terminalGuide}`;
const tuiMedia = [
  "assets/demo/moondog-tui-home.png",
  "assets/demo/moondog-tui-profile.png",
];
assert(
  readme.includes("Pi") &&
    readme.includes("TUI") &&
    /GUI and Studio development is paused/iu.test(publicDocumentation) &&
    readme.includes("npm ci") &&
    readme.includes("npm start") &&
    readme.includes("22.19.0") &&
    readme.indexOf("npm ci") < readme.indexOf("npm start"),
  "README does not provide the current terminal setup and interface scope",
);
for (const relativePath of [
  "docs/TERMINAL_GUIDE.md",
  "docs/ROADMAP.md",
  "docs/PUBLIC_RELEASE_READINESS.md",
  "CONTRIBUTING.md",
]) {
  assert(readme.includes(relativePath), `README does not link ${relativePath}`);
  await read(relativePath);
}
assert(
  /fictional/iu.test(readme) && tuiMedia.every((relativePath) => readme.includes(relativePath)),
  "README does not show both terminal views with an explicit fictional-data caption",
);
for (const command of [
  "/import", "/taste", "/auth", "/model", "/new", "/resume",
  "/profile corrections", "/profile correct", "/profile retract",
  "/theme", "/art", "/motion", "/web status", "/web search", "/web read",
]) {
  assert(publicDocumentation.includes(command), `the terminal guide is missing ${command}`);
}
assert(
  publicDocumentation.includes("same TUI session") &&
    publicDocumentation.includes("Like") &&
    publicDocumentation.includes("Avoid") &&
    /retract/iu.test(publicDocumentation) &&
    publicDocumentation.includes("without a model") &&
    publicDocumentation.includes("original listening history"),
  "the terminal guide does not preserve the import, evidence, correction, and return loop",
);
assert(
  publicDocumentation.includes("/new") &&
    publicDocumentation.includes("/resume <session-id>") &&
    publicDocumentation.includes("conversation draft") &&
    publicDocumentation.includes("model context"),
  "the terminal guide does not explain saved sessions and draft preservation",
);
for (const [relativePath, text] of [
  ["README.md", readme],
  ["docs/TERMINAL_GUIDE.md", terminalGuide],
]) {
  assert(!/\/Users\/[A-Za-z0-9._-]+\//u.test(text), `${relativePath} contains a local user path`);
}
assert(
  publicDocumentation.includes("npm run verify:clean-source") &&
    publicDocumentation.includes("npm run verify:clean-linux"),
  "the public guide does not document both clean-source proofs",
);
assert(
  publicDocumentation.includes("isolated temporary npm cache") &&
    publicDocumentation.includes("stale or preloaded package metadata"),
  "the public guide does not document the cold consumer-package proof",
);
assert(
  publicDocumentation.includes("npm run export:public-source -- --output /absolute/path") &&
    publicDocumentation.includes("per-file SHA-256 values") &&
    publicDocumentation.includes("performs no publication") &&
    publicDocumentation.includes("does not infer a license decision"),
  "the public guide does not document the bounded public-source export",
);
assert(
  publicDocumentation.includes("moondog data inspect --scope profile") &&
    publicDocumentation.includes("moondog data export") &&
    publicDocumentation.includes("moondog data reset") &&
    publicDocumentation.includes("SHA-256 content fingerprints") &&
    publicDocumentation.includes("It performs no deletion"),
  "the public guide does not document recoverable local music data control",
);
assert(
  publicDocumentation.includes("moondog profile correct --artist") &&
    publicDocumentation.includes("moondog profile retract <correction-id>") &&
    publicDocumentation.includes("**Correct the reading**") &&
    publicDocumentation.includes(
      "original play records and familiarity evidence remain unchanged",
    ),
  "the public guide does not document the listener correction boundary",
);
assert(
  publicDocumentation.includes("**Try the real importer with fictional history**") &&
    publicDocumentation.includes("runs it through the production importer in memory") &&
    publicDocumentation.includes("supports apply and retract") &&
    publicDocumentation.includes("stay only in the Studio process"),
  "the public guide does not document the no-state production-importer Time Machine",
);
assert(
  publicDocumentation.includes("npm run demo:studio") &&
    publicDocumentation.includes("moondog studio --demo") &&
    publicDocumentation.includes("No dependency installation is required for this interactive first look") &&
    publicDocumentation.includes("dedicated source-checkout launcher") &&
    publicDocumentation.includes("rejects every user-supplied history import") &&
    publicDocumentation.includes("writes no persistent profile"),
  "the public guide does not document the dedicated zero-data Studio tour",
);
assert(
  publicDocumentation.includes("## Open your real history without importing it") &&
    publicDocumentation.includes('npm --silent run demo:studio -- --from "/path/to/spotify-history.zip"') &&
    publicDocumentation.includes("No dependency installation is required for this private session") &&
    publicDocumentation.includes("stops npm from repeating the expanded script command") &&
    publicDocumentation.includes("may still remain in your shell history") &&
    publicDocumentation.includes("moondog studio --from <spotify-history.zip>") &&
    publicDocumentation.includes(
      "moondog studio --from <account-data.zip> --from <extended-history.zip>",
    ) &&
    publicDocumentation.includes("reconciles exact cross-format overlaps regardless of selection order") &&
    publicDocumentation.includes(
      "does not create or open Moondog's persistent listening-history database",
    ) &&
    publicDocumentation.includes("corrections stay only in the current process") &&
    publicDocumentation.includes(
      "original ZIP's bytes and modification time remain unchanged",
    ),
  "the public guide does not document the session-only private Studio path",
);
assert(
  publicDocumentation.includes("represented-year coverage") &&
    publicDocumentation.includes("retained years without a selected landmark") &&
    publicDocumentation.includes("minimum-attention rules"),
  "the public guide does not document Time Machine selection coverage",
);
assert(
  publicDocumentation.includes("## See the pulse between the landmarks") &&
    publicDocumentation.includes("continuous UTC calendar-month cells") &&
    publicDocumentation.includes("latest 240 retained months") &&
    publicDocumentation.includes("Studio previews at most the latest 72") &&
    publicDocumentation.includes("not proof that no listening occurred"),
  "the public guide does not document the bounded Listening Pulse",
);
assert(
  publicDocumentation.includes("## Read the seasons inside the pulse") &&
    publicDocumentation.includes("deterministic UTC calendar quarters") &&
    publicDocumentation.includes("latest 80 quarters") &&
    publicDocumentation.includes("complete Tasteprint shows the latest 12") &&
    publicDocumentation.includes("Studio and Agent preview the latest six") &&
    publicDocumentation.includes("not discovery") &&
    publicDocumentation.includes("not proof of no listening outside the available archive"),
  "the public guide does not document bounded Listening Seasons",
);
assert(
  publicDocumentation.includes("The same projection includes **Music that came back**") &&
    publicDocumentation.includes("gaps of at least 180 days") &&
    publicDocumentation.includes("moondog_historical_return_candidates") &&
    publicDocumentation.includes("not proof of liking, nostalgia, intentional absence, or current preference"),
  "the public guide does not document bounded historical-return evidence and planning",
);
assert(
  publicDocumentation.includes("**Played back to back**") &&
    publicDocumentation.includes("moondog_back_to_back_candidates") &&
    publicDocumentation.includes("at least two adjacent retained plays") &&
    publicDocumentation.includes("not proof that repeat mode was active") &&
    publicDocumentation.includes("lower-resolution Account Data is not promoted into this view"),
  "the public guide does not document bounded played-back-to-back evidence and planning",
);
assert(
  publicDocumentation.includes("## See what stayed and what changed") &&
    publicDocumentation.includes("Artists across eras") &&
    publicDocumentation.includes("Year-to-year turnover") &&
    publicDocumentation.includes("not uninterrupted loyalty, discovery, genre breadth, or identity"),
  "the public guide does not document the bounded continuity and change view",
);
assert(
  publicDocumentation.includes("## See how listening gathers") &&
    publicDocumentation.includes("Approximate sessions") &&
    publicDocumentation.includes("gap longer than 30 minutes") &&
    publicDocumentation.includes("Records explored in depth") &&
    publicDocumentation.includes("at least three distinct retained track identities") &&
    publicDocumentation.includes("not a provider session log"),
  "the public guide does not document bounded session shape and release depth",
);
assert(
  publicDocumentation.includes("## Exercise the real importer with fictional history") &&
    publicDocumentation.includes("npm run generate:demo-history") &&
    publicDocumentation.includes("moondog demo-history --output /absolute/path/to/moondog-fictional-history.zip") &&
    publicDocumentation.includes("Repeated generations at fresh paths are byte-identical") &&
    publicDocumentation.includes("Studio then treats the fictional archive exactly like a user-selected history ZIP"),
  "the public guide does not document the deterministic fictional history path",
);
assert(
  publicDocumentation.includes("npm run showcase") &&
    publicDocumentation.includes("showcase/index.html") &&
    publicDocumentation.includes("exact allowlist of seven files") &&
    publicDocumentation.includes("No dependency installation is required for this first look") &&
    publicDocumentation.includes("cannot bind to a public network interface"),
  "the public guide does not document the zero-install bounded static product showcase",
);
assert(
  publicDocumentation.includes("刘森最新的单曲是哪首？") &&
    publicDocumentation.includes("captured public-catalog answer") &&
    publicDocumentation.includes("2026-09-03") &&
    publicDocumentation.includes("private listening evidence remains separate"),
  "the public guide does not connect the original catalog question to the dated grounded-answer proof",
);
assert(
  publicDocumentation.includes("catalog panel now shows the exact archive-assisted command") &&
    publicDocumentation.includes("inert text inside the showcase") &&
    publicDocumentation.includes("never opens or reads a ZIP"),
  "the public guide does not document the showcase's runnable archive-assisted proof",
);
assert(
  publicDocumentation.includes("npm run moondog -- catalog latest-single") &&
    publicDocumentation.includes('--known-release "华北浪革"') &&
    publicDocumentation.includes("does not configure or call a model") &&
    publicDocumentation.includes("does not read or send the personal profile") &&
    publicDocumentation.includes("known release stays inside the Moondog host") &&
    publicDocumentation.includes("do not send the release-name hint") &&
    publicDocumentation.includes("before the bounded general-release list is truncated") &&
    publicDocumentation.includes("validated public artist pages"),
  "the public guide does not document the direct no-model latest-single command and its safety boundary",
);
assert(
  publicDocumentation.includes('--artist-page "https://music.apple.com/us/artist/liu-sen/1502984832"') &&
    publicDocumentation.includes("extracts only the public numeric catalog identity") &&
    publicDocumentation.includes("requires the returned artist name to match") &&
    publicDocumentation.includes("mismatched page fails closed") &&
    publicDocumentation.includes("existing ten-minute in-memory cache"),
  "the public guide does not document the explicit public artist-page recovery path",
);
assert(
  publicDocumentation.includes('--from "/path/to/spotify-history.zip"') &&
    publicDocumentation.includes("reads the explicitly supplied ZIP only in memory") &&
    publicDocumentation.includes("sends neither its content nor derived release titles") &&
    publicDocumentation.includes("private release titles, listening counts, and source path stay out of the result"),
  "the public guide does not document archive-assisted catalog disambiguation and its private-data boundary",
);
assert(
  publicDocumentation.includes(
    "npm run export:showcase -- --output /absolute/path/to/moondog-showcase",
  ) &&
    publicDocumentation.includes("root `index.html`") &&
    publicDocumentation.includes("performs no hosting, upload, license decision, or repository change"),
  "the public guide does not document the host-ready showcase export boundary",
);
assert(
  publicDocumentation.includes("### First-run Usability Field Kit") &&
    publicDocumentation.includes("npm run eval:usability -- create") &&
    publicDocumentation.includes("npm run eval:usability -- status") &&
    publicDocumentation.includes("npm run eval:usability -- summarize") &&
    publicDocumentation.includes("FIRST_RUN_USABILITY.md") &&
    publicDocumentation.includes("The eight-task path") &&
    publicDocumentation.includes("the real one-off Taste importer") &&
    publicDocumentation.includes("Do not import a participant's music history"),
  "the public guide does not document the private first-run usability workflow",
);
assert(
  roadmap.includes("[x] Add an inspectable reset and export path") &&
    roadmap.includes("no silent deletion"),
  "the public roadmap does not record local music data control",
);
assert(
  roadmap.includes("docs/PUBLIC_RELEASE_READINESS.md") ||
    roadmap.includes("PUBLIC_RELEASE_READINESS.md"),
  "the public roadmap does not link the current release status",
);
assert(
  roadmap.includes("[x] Ship the first correction flow") &&
    roadmap.includes("typed user assertion") &&
    roadmap.includes("visible effect on the next profile projection"),
  "the public roadmap does not record the listener correction flow",
);
assert(
  roadmap.includes("[x] Run the complete Studio correction loop") &&
    roadmap.includes("real import take over without mixing"),
  "the public roadmap does not record the interactive fictional correction loop",
);
assert(
  roadmap.includes("[x] Open the fictional Time Machine through one dedicated zero-data Studio command") &&
    roadmap.includes("rejects user-supplied imports") &&
    roadmap.includes("production importer") &&
    roadmap.includes("no `node_modules`"),
  "the public roadmap does not record the dedicated zero-data Studio tour",
);
assert(
  roadmap.includes("[x] Expose retained-versus-represented Time Machine year coverage") &&
    roadmap.includes("name unselected years") &&
    roadmap.includes("active selection thresholds"),
  "the public roadmap does not record Time Machine selection coverage",
);
assert(
  roadmap.includes("[x] Turn eligible effective listening history into a bounded **Listening Pulse**") &&
    roadmap.includes("latest-240-month complete view") &&
    roadmap.includes("latest-72-month Studio preview") &&
    roadmap.includes("blank month is not proof of no listening"),
  "the public roadmap does not record the bounded Listening Pulse",
);
assert(
  roadmap.includes("[x] Turn the same eligible history into deterministic **Listening Seasons**") &&
    roadmap.includes("latest-80-quarter projection") &&
    roadmap.includes("latest-12-quarter Tasteprint") &&
    roadmap.includes("latest-six-quarter Studio and Agent previews") &&
    roadmap.includes("no mood or life-story inference"),
  "the public roadmap does not record bounded Listening Seasons",
);
assert(
  roadmap.includes("[x] Turn tracks that reappear after gaps of at least 180 days") &&
    roadmap.includes("dedicated prompt-local Agent candidate set") &&
    roadmap.includes("rejecting nostalgia or preference inference"),
  "the public roadmap does not record historical-return evidence and planning",
);
assert(
  roadmap.includes("[x] Turn adjacent same-track Spotify Extended History plays") &&
    roadmap.includes("dedicated prompt-local Agent candidate set") &&
    roadmap.includes("requiring two non-skipped plays of at least 30 seconds within a 30-minute gap") &&
    roadmap.includes("rejecting repeat-mode, intention, liking, or preference inference"),
  "the public roadmap does not record played-back-to-back evidence and planning",
);
assert(
  roadmap.includes("[x] Turn retained multi-year artist history into a bounded continuity-and-change view") &&
    roadmap.includes("active retained years") &&
    roadmap.includes("adjacent-year top-10 turnover") &&
    roadmap.includes("without claiming identity or permanent taste change"),
  "the public roadmap does not record the continuity and change view",
);
assert(
  roadmap.includes("[x] Turn Extended History album metadata and UTC track-stop sequences") &&
    roadmap.includes("multi-track release depth") &&
    roadmap.includes("approximate listening-session shape") &&
    roadmap.includes("excluding incognito events"),
  "the public roadmap does not record session shape and release depth",
);
assert(
  roadmap.includes("[x] Open one script-free product showcase") &&
    roadmap.includes("without dependency installation") &&
    roadmap.includes("without reading private state or loading a network resource"),
  "the public roadmap does not record the zero-install static product showcase",
);
assert(
  roadmap.includes("刘森最新的单曲是哪首？") &&
    roadmap.includes("four exact-name artist candidates") &&
    roadmap.includes("one-storefront evidence separate from private listening evidence"),
  "the public roadmap does not record the grounded catalog-answer proof",
);
assert(
  roadmap.includes("Run the original latest-single question directly from the CLI without a model") &&
    roadmap.includes("explicit `latest_released_single`") &&
    roadmap.includes("before the general release list is truncated") &&
    roadmap.includes("validated public artist pages"),
  "the public roadmap does not record the direct no-model catalog path",
);
assert(
  roadmap.includes("Turn those returned same-name artist pages into a deterministic recovery loop") &&
    roadmap.includes("extracting only its public catalog ID") &&
    roadmap.includes("requiring the looked-up artist name to match") &&
    roadmap.includes("cached identity-and-release response"),
  "the public roadmap does not record the explicit artist-page recovery path",
);
assert(
  roadmap.includes("Use an explicitly supplied Spotify history ZIP to disambiguate that catalog identity locally") &&
    roadmap.includes("without persisting the archive") &&
    roadmap.includes("exposing its release titles, listening counts, or path") &&
    roadmap.includes("make that runnable path visible inside the zero-install showcase as inert text"),
  "the public roadmap does not record private archive-assisted catalog disambiguation",
);
assert(
  roadmap.includes(
    "Open one or two explicitly supplied Spotify history ZIPs directly from a clean source checkout",
  ) &&
    roadmap.includes("npm --silent run demo:studio -- --from") &&
    roadmap.includes("no dependency installation") &&
    roadmap.includes("in-memory cross-format reconciliation") &&
    roadmap.includes("full Tasteprint and Listening Time Machine") &&
    roadmap.includes(
      "never opening or creating the persistent profile store",
    ) &&
    roadmap.includes("leaving every original archive unchanged"),
  "the public roadmap does not record the session-only private Studio path",
);
assert(
  roadmap.includes("[x] Export that verified showcase") &&
    roadmap.includes("per-file SHA-256 values") &&
    roadmap.includes("no publication side effect"),
  "the public roadmap does not record the host-ready showcase export",
);
assert(
  roadmap.includes("[x] Revise a validated pending playlist") &&
    roadmap.includes("later approval of only the newest draft"),
  "the public roadmap does not record conversational playlist revision",
);
assert(
  roadmap.includes("[x] Provide a privacy-bounded contribution path"),
  "the public roadmap does not record the contribution path",
);
assert(
  roadmap.includes("[x] Export the verified public source tree") &&
    roadmap.includes("no Git metadata or ignored local state"),
  "the public roadmap does not record the owner-reviewable source export",
);
assert(
  roadmap.includes(
    "[x] Turn first-run testing into a fictional-only product-first field kit",
  ) &&
    roadmap.includes("zero-install Studio") &&
    roadmap.includes("version-1 and version-2 protocol validation") &&
    roadmap.includes("three unique validator-compatible sessions") &&
    roadmap.includes("npm run eval:usability"),
  "the public roadmap does not separate the ready usability kit from unfinished human sessions",
);
for (const internalDocument of [
  "DJ_CLAW_LINEAGE_AND_MIGRATION.md",
  "DJ_CLAW_MIGRATION_MANIFEST.md",
  "NEXT_PHASE_AGENT_DEVELOPMENT.md",
  "NEXT_PHASE_PROFILE_FOUNDATION.md",
]) {
  assert(!publicDocumentation.includes(internalDocument), `the public guide links internal document ${internalDocument}`);
  assert(!roadmap.includes(internalDocument), `public roadmap links internal document ${internalDocument}`);
}
assert(
  publicDocumentation.includes("DJ_CLAW_LINEAGE.md"),
  "the public guide does not link the public predecessor boundary",
);

const releaseReadiness = await read("docs/PUBLIC_RELEASE_READINESS.md");
const { text: linuxVerificationText, value: linuxVerification } = await readJson(
  "docs/verification/linux-node-22.19.0.json",
);
const productCharter = await read("docs/PRODUCT_CHARTER.md");
const extendedHistoryFieldPolicy = await read(
  "docs/SPOTIFY_EXTENDED_HISTORY_FIELD_POLICY.md",
);
assert(
  productCharter.includes("continuity-and-change view") &&
    productCharter.includes("artists present across retained years") &&
    productCharter.includes("adjacent-year top-artist turnover"),
  "the product charter does not include temporal continuity and change",
);
assert(
  productCharter.includes("listening-pattern view") &&
    productCharter.includes("multi-track release depth") &&
    productCharter.includes("approximate listening-session shape") &&
    productCharter.includes("per-session timestamps, raw sequences"),
  "the product charter does not include bounded listening patterns",
);
assert(
  productCharter.includes("historical-return loop") &&
    productCharter.includes("Music that came back evidence") &&
    productCharter.includes("180-day gap") &&
    productCharter.includes("exact provider identity remains inside the host"),
  "the product charter does not include bounded historical returns",
);
assert(
  productCharter.includes("played-back-to-back loop") &&
    productCharter.includes("adjacent same-track Spotify Extended History plays") &&
    productCharter.includes("private-history played-back-to-back set") &&
    productCharter.includes("does not infer repeat mode, intention, liking, or preference"),
  "the product charter does not include bounded played-back-to-back sequences",
);
assert(
  extendedHistoryFieldPolicy.includes("## Historical returns") &&
    extendedHistoryFieldPolicy.includes("at least one observed gap reaches 180 days") &&
    extendedHistoryFieldPolicy.includes("at least three effective plays") &&
    extendedHistoryFieldPolicy.includes("Studio further reduces that result to at most four track labels") &&
    extendedHistoryFieldPolicy.includes("not proof of liking, nostalgia, intentional absence, rediscovery, or current preference"),
  "the Extended History field policy does not bound historical returns",
);
assert(
  extendedHistoryFieldPolicy.includes("## Played back to back") &&
    extendedHistoryFieldPolicy.includes("same resolved track appears in adjacent retained rows") &&
    extendedHistoryFieldPolicy.includes("each play lasted at least 30 seconds") &&
    extendedHistoryFieldPolicy.includes("between zero and 30 minutes") &&
    extendedHistoryFieldPolicy.includes("do not prove that repeat mode was active") &&
    extendedHistoryFieldPolicy.includes("Account Data and ListenBrainz events are not promoted"),
  "the Extended History field policy does not bound played-back-to-back sequences",
);
assert(
  extendedHistoryFieldPolicy.includes("## Temporal continuity and change") &&
    extendedHistoryFieldPolicy.includes("at least two retained UTC calendar years") &&
    extendedHistoryFieldPolicy.includes("ten artists with the most retained listening time") &&
    extendedHistoryFieldPolicy.includes("does not establish uninterrupted affinity, discovery, genre breadth, identity, or permanent taste change"),
  "the Extended History field policy does not bound continuity and change",
);
assert(
  extendedHistoryFieldPolicy.includes("## Release depth and approximate sessions") &&
    extendedHistoryFieldPolicy.includes("at least three distinct effective track identities") &&
    extendedHistoryFieldPolicy.includes("gap longer than 30 minutes") &&
    extendedHistoryFieldPolicy.includes("not a provider session log") &&
    extendedHistoryFieldPolicy.includes("Per-session timestamps and raw event sequences are not placed"),
  "the Extended History field policy does not bound session shape and release depth",
);
assert(
  roadmap.includes("independently of import order") &&
    publicDocumentation.includes("This reconciliation is import-order independent"),
  "public documentation does not preserve the cross-format reconciliation guarantee",
);
assert(
  roadmap.includes("fail closed on multiple targets") &&
    roadmap.includes("withheld-ambiguity coverage") &&
    publicDocumentation.includes("a provisional TrackRef that overlaps more than one resolved target remains separate") &&
    publicDocumentation.includes("ambiguous provisional identities and effective events deliberately kept separate"),
  "public documentation does not preserve the fail-closed identity coverage ledger",
);
assert(
  releaseReadiness.includes("https://github.com/Audiofool934/moondog") &&
    releaseReadiness.includes("https://github.com/Audiofool934/moondog/actions") &&
    releaseReadiness.includes("npm run verify:release-tree") &&
    releaseReadiness.includes("npm run verify:clean-source") &&
    /local/iu.test(releaseReadiness) && /CI/iu.test(releaseReadiness),
  "release status does not link the canonical repository and distinguish local verification from hosted CI",
);
assert(
  /license/iu.test(releaseReadiness) &&
    /(?:not (?:yet )?(?:selected|chosen)|unselected|no (?:project |open-source )?license)/iu.test(releaseReadiness) &&
    /private/iu.test(releaseReadiness) && /npm/iu.test(releaseReadiness),
  "release status does not preserve the unselected-license and private npm-package boundary",
);
assert(
  releaseReadiness.includes("verification/linux-node-22.19.0.json") &&
    /historical/iu.test(releaseReadiness),
  "release status does not separate the dated historical record from the current release",
);
assert(
  !/\/Users\/[A-Za-z0-9._-]+\//u.test(releaseReadiness),
  "release status contains a local user path",
);
assert(
  linuxVerification.schema === "moondog.cross-platform-verification.v1" &&
    /^\d{4}-\d{2}-\d{2}$/u.test(linuxVerification.captured_on ?? "") &&
    linuxVerification.execution_environment?.platform === "Linux" &&
    typeof linuxVerification.execution_environment?.kernel === "string" &&
    typeof linuxVerification.execution_environment?.architecture === "string" &&
    /^v\d+\.\d+\.\d+$/u.test(linuxVerification.execution_environment?.node ?? "") &&
    /^\d+\.\d+\.\d+$/u.test(linuxVerification.execution_environment?.npm ?? ""),
  "the historical Linux verification record does not bind the tested environment",
);
assert(
  linuxVerification.node_distribution?.source === "docker.io/library/node" &&
    linuxVerification.node_distribution?.image?.startsWith("node:") &&
    /^sha256:[a-f0-9]{64}$/u.test(linuxVerification.node_distribution?.manifest_digest ?? "") &&
    linuxVerification.node_distribution?.pull_result === "passed" &&
    linuxVerification.dependency_install?.registry === "https://registry.npmjs.org/" &&
    linuxVerification.dependency_install?.cache === "fresh-container" &&
    linuxVerification.dependency_install?.result === "passed",
  "the historical Linux verification record does not bind the cold dependency proof",
);
const historicalTests = linuxVerification.verification?.tests;
assert(
  linuxVerification.source_boundary?.kind === "verified-public-source-snapshot" &&
    linuxVerification.source_boundary?.transfer_manifest_match === "passed" &&
    Number.isSafeInteger(linuxVerification.source_boundary?.release_tree_files) &&
    linuxVerification.source_boundary.release_tree_files > 0 &&
    /^[a-f0-9]{64}$/u.test(linuxVerification.source_boundary?.release_tree_sha256 ?? "") &&
    linuxVerification.source_boundary?.git_metadata_included === false &&
    linuxVerification.source_boundary?.private_local_state_included === false &&
    linuxVerification.verification?.command === "npm run verify" &&
    linuxVerification.verification?.result === "passed" &&
    Number.isSafeInteger(historicalTests?.total) && historicalTests.total > 0 &&
    historicalTests.passed === historicalTests.total &&
    historicalTests.failed === 0 && historicalTests.cancelled === 0 &&
    historicalTests.skipped === 0 && historicalTests.todo === 0,
  "the historical Linux verification record does not preserve a complete clean-source test result",
);
assert(
  linuxVerification.boundaries?.canonical_github_actions_run === false &&
    linuxVerification.boundaries?.publication_performed === false &&
    linuxVerification.boundaries?.provider_write_performed === false &&
    linuxVerification.boundaries?.private_listener_data_read === false &&
    !linuxVerificationText.includes("/Users/") &&
    !linuxVerificationText.includes("/home/") &&
    !linuxVerificationText.includes("/tmp/") &&
    !linuxVerificationText.includes("aimind"),
  "the historical Linux verification record leaks execution identity or overstates publication",
);

const firstRunUsability = await read("docs/FIRST_RUN_USABILITY.md");
for (const expected of [
  "# First-run Usability Evaluation",
  "## Privacy and eligibility boundary",
  "## Create the field kit",
  "## Prepare one clean session",
  "## Validate and inspect collection status",
  "## Create the public aggregate",
  "## Turn evidence into product work",
  "npm run eval:usability -- create",
  "npm run eval:usability -- validate",
  "npm run eval:usability -- status",
  "npm run eval:usability -- summarize",
]) {
  assert(
    firstRunUsability.includes(expected),
    `docs/FIRST_RUN_USABILITY.md is missing ${expected}`,
  );
}
assert(
  firstRunUsability.includes("Do not import a participant's Spotify export") &&
    firstRunUsability.includes("The only ZIP permitted in the session") &&
    firstRunUsability.includes("real one-off Taste importer") &&
    firstRunUsability.includes("protocol version 3") &&
    firstRunUsability.includes("Existing version-1 and version-2 protocols") &&
    firstRunUsability.includes("before dependency installation") &&
    firstRunUsability.includes("Only the aggregate summary") &&
    firstRunUsability.includes("three unique opaque participant IDs"),
  "the first-run method does not enforce its privacy and independence boundary",
);
assert(
  !/\/Users\/[A-Za-z0-9._-]+\//u.test(firstRunUsability),
  "docs/FIRST_RUN_USABILITY.md contains a local user path",
);

const packageJson = JSON.parse(await read("package.json"));
assert(
  packageJson.scripts?.start ===
    "node --disable-warning=ExperimentalWarning scripts/moondog.mjs" &&
    Array.isArray(packageJson.keywords) &&
    packageJson.keywords.includes("local-first") &&
    packageJson.keywords.includes("music-discovery") &&
    packageJson.keywords.includes("spotify"),
  "package.json does not expose the default TUI start path and bounded discovery metadata",
);
assert(
  packageJson.scripts?.["eval:usability"] ===
    "node --disable-warning=ExperimentalWarning scripts/evaluate-usability.mjs",
  "package.json does not expose the first-run usability workflow",
);
assert(
  packageJson.scripts?.["demo:studio"] ===
    "node --disable-warning=ExperimentalWarning scripts/demo-studio.mjs",
  "package.json does not expose the zero-data Studio tour",
);
assert(
  packageJson.scripts?.["generate:studio-tour"] ===
    "node --disable-warning=ExperimentalWarning scripts/capture-studio-tour.mjs",
  "package.json does not expose reproducible Studio tour capture",
);
assert(
  packageJson.scripts?.["generate:demo-history"] ===
      "node --disable-warning=ExperimentalWarning scripts/moondog.mjs demo-history" &&
    packageJson.scripts?.["verify:demo-history"] ===
      "node --test tests/runtime/moondog-demo-history.test.mjs",
  "package.json does not expose and verify fictional history generation",
);
assert(
  packageJson.scripts?.showcase ===
    "node --disable-warning=ExperimentalWarning scripts/showcase.mjs" &&
    packageJson.scripts?.["verify:showcase"] ===
      "node --disable-warning=ExperimentalWarning scripts/verify-showcase.mjs",
  "package.json does not expose and verify the static product showcase",
);
assert(
  packageJson.scripts?.["export:showcase"] ===
    "node --disable-warning=ExperimentalWarning scripts/export-showcase.mjs" &&
    packageJson.scripts?.["verify:showcase-export"] ===
      "node --test tests/core/showcase-export.test.mjs",
  "package.json does not expose and verify the host-ready showcase exporter",
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
assert(
  ciVerify.steps.some(
    (step) => step?.run === "npm install --global npm@11.16.0",
  ),
  "CI does not install the declared npm version",
);
assert(
  ciVerify.steps.some(
    (step) => step?.run === "npm run verify:clean-source",
  ),
  "CI does not rebuild and verify the public source tree",
);
assert(
  publicDocumentation.includes("Each CI matrix job rebuilds the reviewed public source tree") &&
    publicDocumentation.includes("without copying Git metadata, ignored files, dependencies, or local state") &&
    readme.includes("docs/PUBLIC_RELEASE_READINESS.md"),
  "public documentation does not explain the clean-source CI boundary and link current release status",
);

const contributing = await read("CONTRIBUTING.md");
for (const expected of [
  "## Pre-release governance boundary",
  "## Start with the listener outcome",
  "## Protect private listener data",
  "## Verify the change",
  "npm ci --ignore-scripts",
  "npm run showcase",
  "npm run export:showcase",
  "npm run demo:studio",
  "npm run generate:demo-history",
  "npm run verify",
  "npm run verify:clean-source",
  "npm run verify:clean-linux",
  "tests/fixtures/",
]) {
  assert(contributing.includes(expected), `CONTRIBUTING.md is missing ${expected}`);
}
assert(
  contributing.includes("does not yet have a selected public license") &&
    contributing.includes("does not grant redistribution rights"),
  "CONTRIBUTING.md obscures the pre-release license boundary",
);
assert(
  contributing.includes("Spotify Account Data or Extended Streaming History exports") &&
    contributing.includes("OAuth credentials") &&
    contributing.includes("Personal Tasteprints"),
  "CONTRIBUTING.md has no concrete private-data boundary",
);
assert(
  !/\/Users\/[A-Za-z0-9._-]+\//u.test(contributing),
  "CONTRIBUTING.md contains a local user path",
);

const pullRequestTemplate = await read(".github/PULL_REQUEST_TEMPLATE.md");
for (const expected of [
  "## Listener outcome",
  "## Evidence",
  "## Boundaries and limitations",
  "npm run verify",
  "listening-history export",
  "desktop and narrow widths",
  "authorized live provider action",
]) {
  assert(
    pullRequestTemplate.includes(expected),
    `.github/PULL_REQUEST_TEMPLATE.md is missing ${expected}`,
  );
}
assert(
  (pullRequestTemplate.match(/^- \[ \]/gmu) ?? []).length >= 8,
  ".github/PULL_REQUEST_TEMPLATE.md has too few contributor checks",
);
assert(
  !/\/Users\/[A-Za-z0-9._-]+\//u.test(pullRequestTemplate),
  ".github/PULL_REQUEST_TEMPLATE.md contains a local user path",
);

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
  assert(!/\/Users\/[A-Za-z0-9._-]+\//u.test(text), `${relativePath} contains a local user path`);
}

const config = await readYaml(".github/ISSUE_TEMPLATE/config.yml");
assert(config.value.blank_issues_enabled === false, "blank GitHub issues are still enabled");

for (const relativePath of tuiMedia) {
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

process.stdout.write(
  "Verified community and CI surfaces: terminal-first README, two bounded TUI screenshots, detailed terminal guide, current release status, dated historical record, clean public-source Node matrix, contribution guide, pull request template, public roadmap, structured issue forms, and private-data boundaries.\n",
);
