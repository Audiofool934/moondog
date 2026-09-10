import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { inspect } from "node:util";

import { runAuthCommand } from "../../src/surfaces/cli/auth-command.mjs";

const providerId = "openai-codex";

function captureStream({ isTTY = true } = {}) {
  let value = "";
  const output = new PassThrough();
  output.isTTY = isTTY;
  output.columns = 120;
  output.setEncoding("utf8");
  output.on("data", (chunk) => {
    value += chunk;
  });
  output.value = () => value;
  return output;
}

function inputStream({ isTTY = true } = {}) {
  const input = new PassThrough();
  input.isTTY = isTTY;
  return input;
}

function fakeAuthenticationFactory(state) {
  return async () => {
    state.factoryCalls += 1;
    return {
      async status(provider) {
        state.statusCalls.push(provider);
        return {
          provider,
          state: state.stored ? "stored" : "not_configured",
          type: state.stored ? "oauth" : null,
        };
      },
      async login(provider, interaction) {
        state.loginCalls.push(provider);
        if (state.loginError) throw state.loginError;
        state.loginMethod = await interaction.prompt({
          type: "select",
          message: "Select login method",
          options: [
            { id: "browser", label: "Browser" },
            { id: "device_code", label: "Device code" },
          ],
        });
        interaction.notify({
          type: "auth_url",
          url: "https://auth.openai.com/fake-safe-url",
        });
        if (state.manualCodePrompt) {
          state.manualCode = await interaction.prompt({
            type: "manual_code",
            message: "Paste the authorization response",
            placeholder: "http://localhost/callback",
          });
        }
        state.stored = true;
        return { provider, state: "stored", type: "oauth" };
      },
      async logout(provider) {
        state.logoutCalls.push(provider);
        state.stored = false;
        return { provider, state: "not_configured", type: null };
      },
    };
  };
}

function commandFixture(overrides = {}) {
  const state = {
    factoryCalls: 0,
    statusCalls: [],
    loginCalls: [],
    logoutCalls: [],
    loginMethod: null,
    loginError: null,
    manualCodePrompt: false,
    manualCode: null,
    stored: false,
    ...overrides,
  };
  const input = inputStream();
  const output = captureStream();
  const progressOutput = captureStream();
  return {
    state,
    input,
    output,
    progressOutput,
    signalTarget: new EventEmitter(),
    createAuthentication: fakeAuthenticationFactory(state),
  };
}

test("auth help does not initialize provider or local data", async () => {
  const fixture = commandFixture();
  await runAuthCommand({ args: ["help"], ...fixture });
  await runAuthCommand({ args: ["--help"], ...fixture });

  assert.match(fixture.output.value(), /auth login openai-codex/iu);
  assert.equal(fixture.state.factoryCalls, 0);
});

test("exact auth login command chooses browser OAuth and emits no credential", async () => {
  const fixture = commandFixture();
  await runAuthCommand({
    args: ["login", providerId],
    interactive: true,
    ...fixture,
  });

  assert.deepEqual(fixture.state.loginCalls, [providerId]);
  assert.equal(fixture.state.loginMethod, "browser");
  assert.match(fixture.output.value(), /stored oauth credential/iu);
  assert.match(fixture.output.value(), /MOONDOG_PROVIDER=openai-codex/u);
  assert.match(fixture.progressOutput.value(), /auth\.openai\.com/iu);
  const combined = fixture.output.value() + fixture.progressOutput.value();
  assert.equal(combined.includes("ACCESS_TOKEN_SENTINEL"), false);
  assert.equal(combined.includes("REFRESH_TOKEN_SENTINEL"), false);
});

test("device-code login works without an interactive terminal", async () => {
  const fixture = commandFixture();
  fixture.input.isTTY = false;
  fixture.progressOutput.isTTY = false;
  await runAuthCommand({
    args: ["login", providerId, "--device-code"],
    interactive: false,
    ...fixture,
  });

  assert.equal(fixture.state.loginMethod, "device_code");
});

test("browser login receives manual fallback input without echoing it", async () => {
  const fixture = commandFixture({ manualCodePrompt: true });
  const login = runAuthCommand({
    args: ["login", providerId],
    interactive: true,
    ...fixture,
  });
  fixture.input.write("MANUAL_AUTHORIZATION_CODE_SENTINEL\n");
  await login;

  assert.equal(
    fixture.state.manualCode,
    "MANUAL_AUTHORIZATION_CODE_SENTINEL",
  );
  assert.match(fixture.progressOutput.value(), /input is hidden/iu);
  assert.doesNotMatch(
    fixture.output.value() + fixture.progressOutput.value(),
    /MANUAL_AUTHORIZATION_CODE_SENTINEL/u,
  );
});

test("auth status JSON exposes only non-secret metadata", async () => {
  const fixture = commandFixture({ stored: true });
  await runAuthCommand({
    args: ["status", providerId],
    json: true,
    ...fixture,
  });

  assert.deepEqual(JSON.parse(fixture.output.value()), {
    provider: providerId,
    state: "stored",
    type: "oauth",
  });
  assert.equal(fixture.progressOutput.value(), "");
});

test("auth logout is explicit and does not claim to log out Codex", async () => {
  const fixture = commandFixture({ stored: true });
  await runAuthCommand({ args: ["logout", providerId], ...fixture });

  assert.deepEqual(fixture.state.logoutCalls, [providerId]);
  assert.match(fixture.output.value(), /Codex CLI.*not changed/iu);
});

test("auth login rejects non-interactive browser mode before provider setup", async () => {
  const fixture = commandFixture();
  await assert.rejects(
    runAuthCommand({
      args: ["login", providerId],
      interactive: false,
      ...fixture,
    }),
    /interactive terminal/iu,
  );
  assert.equal(fixture.state.factoryCalls, 0);
});

test("auth login rejects JSON mode before provider setup", async () => {
  const fixture = commandFixture();
  await assert.rejects(
    runAuthCommand({
      args: ["login", providerId],
      json: true,
      interactive: true,
      ...fixture,
    }),
    /does not support --json/iu,
  );
  assert.equal(fixture.state.factoryCalls, 0);
});

test("auth login hides provider error details that may contain credentials", async () => {
  const fixture = commandFixture({
    loginError: new Error("provider leaked ACCESS_TOKEN_SENTINEL"),
  });
  await assert.rejects(
    runAuthCommand({
      args: ["login", providerId],
      interactive: true,
      ...fixture,
    }),
    (error) =>
      /login failed/iu.test(error.message) &&
      !inspect(error, { depth: null }).includes("ACCESS_TOKEN_SENTINEL"),
  );
  assert.equal(
    (fixture.output.value() + fixture.progressOutput.value()).includes(
      "ACCESS_TOKEN_SENTINEL",
    ),
    false,
  );
});

test("auth command rejects unknown providers, actions, and extra arguments", async () => {
  const fixture = commandFixture();
  await assert.rejects(
    runAuthCommand({ args: ["status", "openai"], ...fixture }),
    /unsupported auth provider/iu,
  );
  await assert.rejects(
    runAuthCommand({ args: ["refresh", providerId], ...fixture }),
    /unknown auth command/iu,
  );
  await assert.rejects(
    runAuthCommand({ args: ["status", providerId, "extra"], ...fixture }),
    /too many arguments/iu,
  );
  assert.equal(fixture.state.factoryCalls, 0);
});

test("real CLI auth status is offline-safe and does not create a credential file", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-auth-cli-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const { spawnSync } = await import("node:child_process");
  const cliEntry = path.resolve("scripts/moondog.mjs");
  const result = spawnSync(
    process.execPath,
    [cliEntry, "auth", "status", providerId, "--json"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        MOONDOG_CONFIG_HOME: root,
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    provider: providerId,
    state: "not_configured",
    type: null,
  });
  await assert.rejects(stat(path.join(root, "auth.json")), { code: "ENOENT" });
});

test("the installed-style launcher recognizes the exact auth login command", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-auth-launcher-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const { spawnSync } = await import("node:child_process");
  const launcher = path.resolve("scripts/moondog");
  const result = spawnSync(launcher, ["auth", "login", providerId], {
    encoding: "utf8",
    env: {
      ...process.env,
      MOONDOG_CONFIG_HOME: root,
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /interactive terminal/iu);
  assert.doesNotMatch(result.stderr, /unknown command/iu);
  await assert.rejects(stat(path.join(root, "auth.json")), { code: "ENOENT" });
});

test("ask reports the missing openai-codex authorization precisely", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-auth-ask-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const { spawnSync } = await import("node:child_process");
  const launcher = path.resolve("scripts/moondog");
  const result = spawnSync(launcher, ["ask", "hello"], {
    encoding: "utf8",
    env: {
      ...process.env,
      MOONDOG_CONFIG_HOME: root,
      MOONDOG_PROVIDER: providerId,
      MOONDOG_MODEL: "gpt-5.6-terra",
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /auth login openai-codex/iu);
  assert.doesNotMatch(result.stderr, /set MOONDOG_PROVIDER/iu);
  await assert.rejects(stat(path.join(root, "auth.json")), { code: "ENOENT" });
});
