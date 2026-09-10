import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runMoondogDemo } from "../../src/demo/moondog-demo.mjs";
import { formatDemoResult } from "../../src/surfaces/cli/format-output.mjs";

const moondogScript = fileURLToPath(
  new URL("../../scripts/moondog.mjs", import.meta.url),
);

test("demo uses a synthetic ready profile and returns an inspectable read-only trace", async () => {
  const value = await runMoondogDemo({
    prompt: "Plan two demo tracks.",
    runtimeBuilder: async (application) => {
      const source = await application.sourceStatus();
      const profile = await application.profileStatus();
      const summary = await application.getProfileSummary({ maxItems: 2 });

      assert.equal(source.source, "synthetic_demo_library");
      assert.equal(source.latest.tracks, 8);
      assert.equal(profile.state, "ready");
      assert.equal(summary.max_items_applied, 2);

      return {
        publicStatus() {
          return {
            state: "configured",
            provider: "faux",
            model: "faux-1",
          };
        },
        async prompt(prompt, callbacks) {
          assert.equal(prompt, "Plan two demo tracks.");
          callbacks.onToolStart({
            toolCallId: "call-1",
            toolName: "moondog_profile_summary",
            capabilityId: "profile.summary",
            label: "Read your music profile",
          });
          callbacks.onToolEnd({
            toolCallId: "call-1",
            toolName: "moondog_profile_summary",
            capabilityId: "profile.summary",
            label: "Read your music profile",
            isError: false,
          });
          return {
            status: "completed",
            text: "A bounded demo plan.",
            playlist_plan: {
              track_count: 2,
              tracks: [],
              external_effects: "none",
            },
          };
        },
        abort() {},
      };
    },
  });

  assert.equal(value.mode, "synthetic_read_only");
  assert.equal(value.coverage.external_effects, "disabled");
  assert.deepEqual(value.tool_trace, [
    {
      sequence: 1,
      tool: "moondog_profile_summary",
      capability: "profile.summary",
      label: "Read your music profile",
      status: "completed",
    },
  ]);
  assert.equal(value.result.playlist_plan.track_count, 2);
  assert.deepEqual(value.next_steps, [
    {
      id: "open_visual_tour",
      title: "Open the visual Listening Time Machine",
      checkout_command: "npm run demo:studio",
      installed_command: "moondog studio --demo",
      data_boundary:
        "The fictional tour stays on 127.0.0.1, reads no private history, rejects imports, and keeps corrections only in process memory.",
    },
    {
      id: "open_session_studio",
      title: "Open your history without importing it",
      checkout_command:
        "npm --silent run demo:studio -- --from /absolute/path/to/spotify-history.zip",
      installed_command:
        "moondog studio --from /absolute/path/to/spotify-history.zip",
      data_boundary:
        "No dependency installation is required. The archive stays unchanged, the private profile and corrections live only in process memory, and no model, provider, cloud, or network request is made.",
    },
    {
      id: "open_private_studio",
      title: "Bring your own listening history",
      checkout_command: "npm run studio",
      installed_command: "moondog studio",
      data_boundary:
        "Studio stays on 127.0.0.1. The fictional preview saves nothing. Import changes private local state only after an explicit button press.",
    },
  ]);

  const output = formatDemoResult(value);
  assert.match(output, /synthetic music data/u);
  assert.match(output, /profile\.summary - completed/u);
  assert.match(output, /A bounded demo plan/u);
  assert.match(output, /Keep exploring/u);
  assert.match(output, /npm run demo:studio/u);
  assert.match(output, /npm --silent run demo:studio -- --from \/absolute\/path\/to\/spotify-history\.zip/u);
  assert.match(output, /npm run studio/u);
  assert.doesNotMatch(output, /\/Users\//u);
});

test("offline demo exercises the grounded product loop without a model", async () => {
  let runtimeCalls = 0;
  const value = await runMoondogDemo({
    offline: true,
    runtimeBuilder: async () => {
      runtimeCalls += 1;
      throw new Error("The offline demo must not construct a model runtime.");
    },
  });

  assert.equal(runtimeCalls, 0);
  assert.equal(value.demo_version, "moondog-demo/3");
  assert.equal(value.mode, "synthetic_offline_read_only");
  assert.deepEqual(value.runtime, {
    provider: "none",
    model: "deterministic-showcase/1",
  });
  assert.deepEqual(
    value.tool_trace.map((entry) => entry.capability),
    ["profile.summary", "profile.explain", "library.search", "playlist.plan"],
  );
  assert.equal(
    value.tool_trace.every((entry) => entry.status === "completed"),
    true,
  );
  assert.equal(value.result.status, "completed");
  assert.equal(value.result.playlist_plan.track_count, 6);
  assert.deepEqual(
    value.result.playlist_plan.tracks.map((track) => track.title),
    [
      "Midnight Lines",
      "Glass Highway",
      "Blue Exit",
      "Soft Static",
      "Empty Overpass",
      "First Light Behind Us",
    ],
  );
  assert.equal(value.result.playlist_plan.external_effects, "none");
  assert.match(value.result.text, /Evidence checked:/u);
  assert.match(value.result.text, /play count supports familiarity, not liking/u);

  const output = formatDemoResult(value);
  assert.match(output, /profile\.explain - completed/u);
  assert.match(output, /Midnight Lines - Mara Vale/u);
  assert.match(output, /deterministic/u);
  assert.match(output, /Bring your own listening history/u);
  assert.match(output, /moondog studio/u);
  assert.doesNotMatch(output, /\/Users\//u);
});

test("offline demo is a zero-configuration CLI path", () => {
  const configHome = mkdtempSync(path.join(tmpdir(), "moondog-offline-demo-"));
  try {
    const result = spawnSync(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        moondogScript,
        "demo",
        "--offline",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, MOONDOG_CONFIG_HOME: configHome },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /profile\.summary - completed/u);
    assert.match(result.stdout, /playlist\.plan - completed/u);
    assert.match(result.stdout, /without saving or playing anything/u);
    assert.match(result.stdout, /Keep exploring/u);
    assert.match(result.stdout, /npm run studio/u);
    assert.deepEqual(readdirSync(configHome), []);
  } finally {
    rmSync(configHome, { recursive: true, force: true });
  }
});

test("demo fails clearly before touching a model when runtime is offline", async () => {
  await assert.rejects(
    runMoondogDemo({
      runtimeBuilder: async () => ({
        publicStatus() {
          return {
            state: "offline",
            reason: "provider_authentication_required",
          };
        },
        abort() {},
      }),
    }),
    (error) => {
      assert.equal(error.code, "provider_authentication_required");
      assert.match(error.message, /\/auth and \/model/u);
      return true;
    },
  );
});
