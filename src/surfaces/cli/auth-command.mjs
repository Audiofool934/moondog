import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

import { createPiAuthentication } from "../../runtime/pi/authentication.mjs";
import { sanitizeTerminalText } from "./format-output.mjs";

const DEFAULT_AUTH_PROVIDER = "openai-codex";

export function authHelpText() {
  return `# Moondog authentication

Commands:

- \`moondog auth login openai-codex\` - start a browser OAuth login
- \`moondog auth login openai-codex --device-code\` - use headless device login
- \`moondog auth status [openai-codex] [--json]\` - inspect local credential storage
- \`moondog auth logout openai-codex [--json]\` - remove Moondog's credential

Moondog keeps this credential in its own private local store.
It does not read, modify, or log out the Codex CLI or ChatGPT desktop session.`;
}

function parseAuthArguments(args) {
  const values = [...args];
  if (
    values.length === 1 &&
    (values[0] === "--help" || values[0] === "-h")
  ) {
    return {
      action: "help",
      provider: undefined,
      extra: [],
      loginMethod: "browser",
    };
  }
  const deviceCodeIndex = values.indexOf("--device-code");
  const browserIndex = values.indexOf("--browser");
  const deviceCode = deviceCodeIndex !== -1;
  const browser = browserIndex !== -1;
  if (deviceCode) values.splice(deviceCodeIndex, 1);
  const adjustedBrowserIndex = values.indexOf("--browser");
  if (adjustedBrowserIndex !== -1) values.splice(adjustedBrowserIndex, 1);
  if (deviceCode && browser) {
    throw new Error("Choose either --browser or --device-code, not both.");
  }
  const unknownOption = values.find((value) => value.startsWith("-"));
  if (unknownOption) {
    throw new Error(`Unknown auth option: ${unknownOption}`);
  }
  return {
    action: values[0],
    provider: values[1],
    extra: values.slice(2),
    loginMethod: deviceCode ? "device_code" : "browser",
  };
}

function writeLine(stream, value = "") {
  stream.write(`${sanitizeTerminalText(value)}\n`);
}

function formatStatus(value) {
  if (value.state === "stored") {
    return `${value.provider}: stored ${value.type} credential`;
  }
  return `${value.provider}: not configured`;
}

function createReadlineOutput(output) {
  let muted = false;
  const stream = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) output.write(chunk, encoding);
      callback();
    },
  });
  stream.isTTY = output.isTTY;
  stream.columns = output.columns;
  stream.rows = output.rows;
  if (typeof output.getColorDepth === "function") {
    stream.getColorDepth = output.getColorDepth.bind(output);
  }
  return {
    stream,
    setMuted(value) {
      muted = value;
    },
  };
}

function createOAuthInteraction({
  input,
  output,
  loginMethod,
  signal,
  interactive,
}) {
  const readlineOutput = createReadlineOutput(output);
  const readline = createInterface({
    input,
    output: readlineOutput.stream,
    terminal: interactive,
  });

  return {
    close() {
      readline.close();
    },
    interaction: {
      signal,
      async prompt(prompt) {
        if (prompt.type === "select") {
          const selected = prompt.options.find(
            (option) => option.id === loginMethod,
          );
          if (!selected) {
            throw new Error(
              "The installed Pi provider does not support the requested login method.",
            );
          }
          return selected.id;
        }
        if (prompt.type === "secret") {
          throw new Error(
            "Moondog will not echo a secret credential prompt to the terminal.",
          );
        }
        const placeholder = prompt.placeholder
          ? ` (${sanitizeTerminalText(prompt.placeholder)})`
          : "";
        const question = `${sanitizeTerminalText(prompt.message)}${placeholder}: `;
        const questionOptions = prompt.signal
          ? { signal: prompt.signal }
          : undefined;
        if (prompt.type !== "manual_code") {
          return readline.question(question, questionOptions);
        }

        writeLine(output, question);
        writeLine(
          output,
          "Paste the authorization response. Input is hidden for safety.",
        );
        readlineOutput.setMuted(true);
        try {
          return await readline.question("", questionOptions);
        } finally {
          readlineOutput.setMuted(false);
          writeLine(output);
        }
      },
      notify(event) {
        switch (event.type) {
          case "auth_url":
            writeLine(output);
            writeLine(output, "Open this URL to sign in with ChatGPT:");
            writeLine(output, event.url);
            if (event.instructions) writeLine(output, event.instructions);
            break;
          case "device_code":
            writeLine(output);
            writeLine(output, "Open this URL to sign in with ChatGPT:");
            writeLine(output, event.verificationUri);
            writeLine(output, `Device code: ${event.userCode}`);
            break;
          case "info":
            writeLine(output, event.message);
            for (const link of event.links ?? []) {
              writeLine(
                output,
                `${link.label ?? "More information"}: ${link.url}`,
              );
            }
            break;
          case "progress":
            writeLine(output, event.message);
            break;
        }
      },
    },
  };
}

function wrapLoginError(error) {
  if (error?.name === "AbortError" || error?.code === "ABORT_ERR") {
    return new Error("OpenAI Codex login was cancelled.");
  }
  if (
    typeof error?.code === "string" &&
    (error.code.startsWith("credential_store_") ||
      error.code === "credential_provider_unsupported")
  ) {
    return error;
  }
  const safe = new Error(
    "OpenAI Codex login failed before a usable credential was saved.",
  );
  safe.code = "auth_login_failed";
  return safe;
}

export async function runAuthCommand({
  args,
  json = false,
  environment = process.env,
  input = process.stdin,
  output = process.stdout,
  progressOutput = process.stderr,
  signalTarget = process,
  createAuthentication = createPiAuthentication,
  interactive = Boolean(input.isTTY && progressOutput.isTTY),
}) {
  const options = parseAuthArguments(args);
  if (!options.action || options.action === "help") {
    if (options.provider || options.extra.length > 0) {
      throw new Error("The auth help command does not accept extra arguments.");
    }
    writeLine(output, authHelpText());
    return;
  }

  if (options.extra.length > 0) {
    throw new Error("Too many arguments for the auth command.");
  }
  if (!["login", "status", "logout"].includes(options.action)) {
    throw new Error(`Unknown auth command: ${options.action}`);
  }
  if (
    options.action !== "login" &&
    (options.loginMethod !== "browser" || args.includes("--browser"))
  ) {
    throw new Error("Login method options are valid only for auth login.");
  }

  const provider = options.provider ??
    (options.action === "status" ? DEFAULT_AUTH_PROVIDER : undefined);
  if (!provider) {
    throw new Error(`The auth ${options.action} command requires a provider.`);
  }
  if (provider !== DEFAULT_AUTH_PROVIDER) {
    throw new Error(`Unsupported auth provider: ${provider}`);
  }

  if (options.action === "status") {
    const authentication = await createAuthentication({ environment });
    const status = await authentication.status(provider);
    if (json) {
      writeLine(output, JSON.stringify(status, null, 2));
    } else {
      writeLine(output, formatStatus(status));
      writeLine(
        output,
        "Status reports stored metadata only and does not refresh the token.",
      );
    }
    return;
  }

  if (options.action === "logout") {
    const authentication = await createAuthentication({ environment });
    const status = await authentication.logout(provider);
    if (json) {
      writeLine(output, JSON.stringify(status, null, 2));
    } else {
      writeLine(output, formatStatus(status));
      writeLine(
        output,
        "Moondog's local credential was removed. Codex CLI and ChatGPT desktop login were not changed.",
      );
    }
    return;
  }

  if (json) {
    throw new Error("The auth login command does not support --json.");
  }
  if (options.loginMethod === "browser" && !interactive) {
    throw new Error(
      "Browser OAuth login requires an interactive terminal. Use --device-code for a headless session.",
    );
  }

  const authentication = await createAuthentication({ environment });
  const controller = new AbortController();
  const handleSigint = () => controller.abort();
  signalTarget.once("SIGINT", handleSigint);
  const oauth = createOAuthInteraction({
    input,
    output: progressOutput,
    loginMethod: options.loginMethod,
    signal: controller.signal,
    interactive,
  });
  try {
    let status;
    try {
      status = await authentication.login(provider, oauth.interaction);
    } catch (error) {
      throw wrapLoginError(error);
    }
    writeLine(output, formatStatus(status));
    writeLine(output, "Next, return to Moondog and run /model.");
    writeLine(output, "For a non-interactive launch, use environment overrides:");
    writeLine(output, "  export MOONDOG_PROVIDER=openai-codex");
    writeLine(output, "  export MOONDOG_MODEL=gpt-5.6-terra");
    writeLine(output, "  moondog");
  } finally {
    signalTarget.removeListener("SIGINT", handleSigint);
    oauth.close();
  }
}
