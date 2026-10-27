import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

import {
  createPiAuthentication,
  serviceKeyProviders,
  supportedAuthProviderIds,
} from "../../runtime/pi/authentication.mjs";
import { sanitizeTerminalText } from "./format-output.mjs";

const DEFAULT_AUTH_PROVIDER = "openai";

export function authHelpText() {
  return `# Moondog authentication

Commands:

- \`moondog auth login openai --chatgpt\` - sign in with your ChatGPT subscription in the browser
- \`moondog auth login <provider>\` - save an API key using hidden terminal input
- \`moondog auth status [provider] [--json]\` - inspect saved or environment credentials
- \`moondog auth logout <provider> [--json]\` - remove that provider's saved credential

API key providers: ${supportedAuthProviderIds.filter((id) => !serviceKeyProviders.some((service) => service.id === id)).join(", ")}.
Web search keys: ${serviceKeyProviders.map((service) => `${service.id} for ${service.name} (or ${service.variable})`).join(", ")}; a deepseek key also searches and reads pages.
Use openai for GPT, anthropic for Claude, google for Gemini, xai for Grok, zai for GLM, and moonshotai or moonshotai-cn for Kimi.
OpenAI takes either a ChatGPT sign-in or an API key; the newer one replaces the other.
Moondog keeps credentials in its own private local store.
API keys are entered interactively, never as command arguments.
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
      chatgpt: false,
    };
  }
  const chatgptIndex = values.indexOf("--chatgpt");
  if (chatgptIndex !== -1) values.splice(chatgptIndex, 1);
  const unknownOption = values.find((value) => value.startsWith("-"));
  if (unknownOption) {
    throw new Error(
      "Unknown auth option. API keys must be entered at the hidden prompt, never as command arguments.",
    );
  }
  return {
    action: values[0],
    provider: values[1],
    extra: values.slice(2),
    chatgpt: chatgptIndex !== -1,
  };
}

function writeLine(stream, value = "") {
  stream.write(`${sanitizeTerminalText(value)}\n`);
}

function formatStatus(value) {
  if (value.state === "environment") {
    return `${value.provider}: configured through ${value.source ?? "environment"}`;
  }
  if (value.state === "stored") {
    return `${value.provider}: stored ${value.type} credential`;
  }
  return `${value.provider}: not configured`;
}

// A readline output that can go quiet, so a key typed into it is never echoed.
export function createReadlineOutput(output) {
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

function createAuthInteraction({
  input,
  output,
  signal,
  interactive,
  apiKeyLogin,
}) {
  const readlineOutput = createReadlineOutput(output);
  readlineOutput.setMuted(apiKeyLogin);
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
          throw new Error(
            "The installed Pi provider asked for a login choice Moondog doesn't offer.",
          );
        }
        if (prompt.type === "secret" && !interactive) {
          throw new Error(
            "API key login requires an interactive terminal with hidden input.",
          );
        }
        const placeholder = prompt.placeholder
          ? ` (${sanitizeTerminalText(prompt.placeholder)})`
          : "";
        const question = `${sanitizeTerminalText(prompt.message)}${placeholder}: `;
        const questionOptions = { signal: prompt.signal ?? signal };
        if (prompt.type !== "manual_code" && prompt.type !== "secret") {
          return readline.question(question, questionOptions);
        }

        writeLine(output);
        writeLine(output, question);
        writeLine(
          output,
          prompt.type === "secret"
            ? "Paste the API key. Input is hidden."
            : "Paste the authorization response. Input is hidden for safety.",
        );
        readlineOutput.setMuted(true);
        try {
          const answer = await readline.question("", questionOptions);
          return prompt.type === "secret" ? answer.trim() : answer;
        } finally {
          readlineOutput.setMuted(apiKeyLogin);
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

// Pi's login errors can carry provider response bodies. Every surface that signs
// in shows only these fixed messages and codes.
export function wrapLoginError(error, provider) {
  const name = provider === DEFAULT_AUTH_PROVIDER ? "OpenAI" : provider;
  if (error?.name === "AbortError" || error?.code === "ABORT_ERR") {
    const cancelled = new Error(`${name} login was cancelled.`);
    cancelled.code = "auth_login_cancelled";
    return cancelled;
  }
  if (
    typeof error?.code === "string" &&
    (error.code.startsWith("credential_store_") ||
      error.code === "credential_provider_unsupported")
  ) {
    return error;
  }
  const safe = new Error(
    `${name} login failed before a credential was saved.`,
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
    throw new Error("Unknown auth command. Use login, status, logout, or help.");
  }
  if (options.action !== "login" && options.chatgpt) {
    throw new Error("--chatgpt is valid only for auth login.");
  }

  const provider = options.provider ??
    (options.action === "status" ? DEFAULT_AUTH_PROVIDER : undefined);
  if (!provider) {
    throw new Error(`The auth ${options.action} command requires a provider.`);
  }
  if (!supportedAuthProviderIds.includes(provider)) {
    throw new Error(
      `Unsupported auth provider. Choose ${supportedAuthProviderIds.join(", ")}.`,
    );
  }
  if (options.chatgpt && provider !== DEFAULT_AUTH_PROVIDER) {
    throw new Error("Only openai signs in with ChatGPT; other providers take an API key.");
  }
  const apiKeyLogin = !options.chatgpt;

  if (options.action === "status") {
    const authentication = await createAuthentication({ environment });
    const status = await authentication.status(provider);
    if (json) {
      writeLine(output, JSON.stringify(status, null, 2));
    } else {
      writeLine(output, formatStatus(status));
      writeLine(
        output,
        "Status reports local configuration only. It does not verify the credential with the provider or refresh tokens.",
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
        "Moondog's saved credential was removed. Environment credentials remain available until unset; the Codex CLI and ChatGPT desktop sign-ins were not changed.",
      );
    }
    return;
  }

  if (json) {
    throw new Error("The auth login command does not support --json.");
  }
  if (apiKeyLogin && !interactive) {
    throw new Error(
      "API key login requires an interactive terminal with hidden input. For headless use, set the provider's API key environment variable.",
    );
  }
  if (!apiKeyLogin && !interactive) {
    throw new Error(
      "ChatGPT sign-in requires an interactive terminal. For headless use, set OPENAI_API_KEY instead.",
    );
  }

  const authentication = await createAuthentication({ environment });
  const controller = new AbortController();
  const handleSigint = () => controller.abort();
  signalTarget.once("SIGINT", handleSigint);
  const login = createAuthInteraction({
    input,
    output: progressOutput,
    signal: controller.signal,
    interactive,
    apiKeyLogin,
  });
  try {
    let status;
    try {
      status = await authentication.login(provider, login.interaction, { method: apiKeyLogin ? "api_key" : "oauth" });
    } catch (error) {
      throw wrapLoginError(error, provider);
    }
    writeLine(output, formatStatus(status));
    if (apiKeyLogin) {
      writeLine(
        output,
        "API key saved locally. It will be checked by the provider when you send a request.",
      );
    }
    writeLine(output, serviceKeyProviders.some((service) => service.id === provider)
      ? "Next, run moondog web status, or /web status in Moondog, to see which service searches."
      : "Next, return to Moondog and run /model.");
    if (!apiKeyLogin) {
      writeLine(output, "For a non-interactive launch, use environment overrides:");
      writeLine(output, "  export MOONDOG_PROVIDER=openai");
      writeLine(output, "  export MOONDOG_MODEL=gpt-6.1-sol");
      writeLine(output, "  moondog");
    }
  } finally {
    signalTarget.removeListener("SIGINT", handleSigint);
    login.close();
  }
}
