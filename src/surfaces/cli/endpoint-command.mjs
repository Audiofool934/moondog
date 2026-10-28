import { createInterface } from "node:readline/promises";

import { ENDPOINT_FORMATS, readEndpoints } from "../../runtime/pi/custom-endpoints.mjs";
import { createModelSettings } from "../../runtime/pi/model-settings.mjs";
import { createReadlineOutput } from "./auth-command.mjs";
import { sanitizeTerminalText } from "./format-output.mjs";

// Endpoints from the terminal, as Settings › Model adds them in the window: any service that speaks
// OpenAI's Chat Completions or Anthropic's Messages, by its address, an optional key and its model IDs.
export function endpointHelpText() {
  return `# Moondog endpoints

- \`moondog endpoint\` - list the endpoints you added
- \`moondog endpoint add\` - add one; Moondog asks for its name, address, format, key and model IDs
- \`moondog endpoint remove <id>\` - remove one with its key

The key is typed out of sight and kept in Moondog's private endpoints.json, never in a command.
Leave the model IDs empty and Moondog asks the endpoint for its list.
Then pick a model with /model <id>.`;
}

const line = (stream, value = "") => stream.write(`${sanitizeTerminalText(value)}\n`);
const host = (address) => { try { return new URL(address).host; } catch { return address; } };

export function describeEndpoints(endpoints) {
  if (!endpoints.length) return "No endpoints yet. Add one with moondog endpoint add, or /endpoint add in Moondog.";
  return endpoints.map((endpoint) => `${endpoint.id} - ${endpoint.name}, ${endpoint.format === "anthropic" ? "Anthropic" : "OpenAI"} format at ${host(endpoint.baseUrl)}, ` +
    `${endpoint.models.length} model${endpoint.models.length === 1 ? "" : "s"}${endpoint.key ? ", key saved" : ""}`).join("\n");
}

// The questions an endpoint needs, one by one, on a paused terminal. The key is asked with the output
// muted; an empty answer keeps the endpoint keyless, as a server on this Mac often is.
async function askEndpoint({ input, output, signal }) {
  const quiet = createReadlineOutput(output);
  const readline = createInterface({ input, output: quiet.stream, terminal: Boolean(input.isTTY) });
  const ask = (question) => readline.question(`${sanitizeTerminalText(question)} `, { signal });
  try {
    line(output);
    line(output, "Add an endpoint. Press Ctrl+C to stop.");
    const name = (await ask("Name (for example DeepSeek):")).trim();
    const baseUrl = (await ask("Address (for example https://api.deepseek.com):")).trim();
    const said = (await ask("Format, openai or anthropic [openai]:")).trim().toLowerCase();
    const format = said.startsWith("a") ? "anthropic" : "openai";
    if (said && !ENDPOINT_FORMATS.some((value) => value.startsWith(said[0]))) throw Object.assign(new Error("Answer openai or anthropic."), { code: "endpoint_format_invalid" });
    line(output, "Key (hidden; leave empty for none):");
    quiet.setMuted(true);
    let key;
    try { key = (await readline.question("", { signal })).trim(); } finally { quiet.setMuted(false); line(output); }
    const models = (await ask("Model IDs, separated by commas (leave empty to ask the endpoint):")).trim();
    return { name, baseUrl, format, key, models };
  } finally {
    readline.close();
  }
}

export async function runEndpointCommand({
  args = [],
  json = false,
  environment = process.env,
  input = process.stdin,
  output = process.stdout,
  progressOutput = process.stderr,
  signalTarget = process,
  interactive = Boolean(input.isTTY && progressOutput.isTTY),
  settings = createModelSettings({ environment }),
} = {}) {
  const [action = "list", ...rest] = args;
  if (action === "help" || action === "--help" || action === "-h") {
    line(output, endpointHelpText());
    return null;
  }
  if (action === "list") {
    if (rest.length) throw new Error("moondog endpoint list takes nothing after it.");
    const endpoints = await readEndpoints(environment);
    line(output, json ? JSON.stringify(endpoints.map(({ key, ...shown }) => ({ ...shown, keySaved: Boolean(key) })), null, 2) : describeEndpoints(endpoints));
    return endpoints;
  }
  if (action === "remove") {
    const wanted = rest.join(" ").trim().toLowerCase();
    if (!wanted) throw new Error("Name the endpoint to remove: moondog endpoint remove <id>.");
    const endpoint = (await readEndpoints(environment)).find((entry) => entry.id === wanted || entry.id === `endpoint-${wanted}` || entry.name.toLowerCase() === wanted);
    if (!endpoint) throw new Error("No endpoint has that id or name. moondog endpoint lists them.");
    await settings.removeEndpoint(endpoint.id);
    line(output, `Removed ${endpoint.name} and its key.`);
    return { id: endpoint.id, name: endpoint.name, removed: true };
  }
  if (action !== "add") throw new Error("Unknown endpoint command. Use add, remove, list, or help.");
  if (rest.length) throw new Error("moondog endpoint add asks for everything it needs; type the key only at its hidden prompt.");
  if (!interactive) throw new Error("Adding an endpoint asks for its key out of sight, so it needs an interactive terminal.");
  const controller = new AbortController();
  const stop = () => controller.abort();
  signalTarget.once("SIGINT", stop);
  try {
    const answers = await askEndpoint({ input, output: progressOutput, signal: controller.signal });
    if (answers.models === "") line(progressOutput, "Asking the endpoint for its models...");
    const saved = await settings.saveEndpoint(answers);
    line(output, `Saved ${saved.name} as ${saved.id}, with ${saved.models.length} model${saved.models.length === 1 ? "" : "s"}${saved.keySaved ? " and its key" : ""}.`);
    line(output, `Next, pick one with /model ${saved.id}.`);
    return saved;
  } catch (error) {
    if (controller.signal.aborted) throw Object.assign(new Error("Adding the endpoint was cancelled."), { code: "endpoint_cancelled" });
    throw error;
  } finally {
    signalTarget.removeListener("SIGINT", stop);
  }
}
