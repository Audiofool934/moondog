#!/usr/bin/env node

import { createHash } from "node:crypto";

import { runMoondogDemo } from "../src/demo/moondog-demo.mjs";

const expectedCapabilities = [
  "profile.summary",
  "profile.explain",
  "library.search",
  "playlist.plan",
];

function fail(message) {
  throw new Error(`Public demo verification failed: ${message}`);
}

function arraysEqual(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

const value = await runMoondogDemo({
  offline: true,
  runtimeBuilder: async () => {
    fail("the offline path attempted to construct a model runtime");
  },
});

if (value.demo_version !== "moondog-demo/3") {
  fail("the demo contract version is unexpected");
}
if (value.mode !== "synthetic_offline_read_only") {
  fail("the demo is not in synthetic offline read-only mode");
}
if (value.runtime?.provider !== "none") {
  fail("the demo reports a model provider");
}
const capabilities = value.tool_trace?.map((entry) => entry.capability) ?? [];
if (!arraysEqual(capabilities, expectedCapabilities)) {
  fail("the grounded tool sequence changed");
}
if (value.tool_trace.some((entry) => entry.status !== "completed")) {
  fail("one or more grounded steps did not complete");
}
const plan = value.result?.playlist_plan;
if (
  value.result?.status !== "completed" ||
  plan?.track_count !== 6 ||
  plan?.candidate_scope !== "private_library" ||
  plan?.persistence !== "none" ||
  plan?.external_effects !== "none"
) {
  fail("the validated playlist plan is incomplete or effectful");
}
if (
  !Array.isArray(plan.tracks) ||
  new Set(plan.tracks.map((track) => track.track_ref_id)).size !== 6
) {
  fail("the plan does not contain six unique trusted tracks");
}
const studioStep = value.next_steps?.find(
  (step) => step.id === "open_private_studio",
);
const visualTourStep = value.next_steps?.find(
  (step) => step.id === "open_visual_tour",
);
if (
  visualTourStep?.checkout_command !== "npm run demo:studio" ||
  visualTourStep?.installed_command !== "moondog studio --demo" ||
  !visualTourStep?.data_boundary?.includes("rejects imports")
) {
  fail("the demo does not provide a bounded path into the zero-data visual tour");
}
if (
  studioStep?.checkout_command !== "npm run studio" ||
  studioStep?.installed_command !== "moondog studio" ||
  !studioStep?.data_boundary?.includes("explicit button press")
) {
  fail("the demo does not provide a bounded path into private Studio");
}

const serialized = JSON.stringify(value);
const forbiddenPatterns = [
  /\/Users\//u,
  /[A-Za-z]:\\Users\\/u,
  /file:\/\//iu,
  /(?:access|refresh)[_-]?token/iu,
  /client[_-]?secret/iu,
  /spotify:(?:track|artist|album|playlist):/iu,
];
if (forbiddenPatterns.some((pattern) => pattern.test(serialized))) {
  fail("the public output contains a private path, credential field, or provider ID");
}

const digest = createHash("sha256").update(serialized).digest("hex");
process.stdout.write(
  `Verified public demo: ${plan.track_count} tracks, ${capabilities.length} grounded steps, sha256 ${digest}.\n`,
);
