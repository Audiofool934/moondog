import { MODEL_ROLES, WEB_SERVICES } from "../../runtime/pi/model-roles.mjs";

// /model roles, /model vision and /model web: the terminal's side of Settings' Uses. The chat model
// stays /model <provider> <model>.
export const MODEL_ROLE_WORDS = Object.freeze({ roles: null, vision: "vision", web: "web_search", audio: "audio" });

const titles = { chat: "Chat", vision: "Seeing images", web_search: "Web search", audio: "Hearing audio" };
const usage = "Usage: /model roles, /model vision auto|<provider> <model>, or /model web auto|deepseek|brave|codex.";

const modelName = (choice) => `${choice.name ?? choice.model} (${choice.providerName ?? choice.provider})`;

function describe(role) {
  if (role.state !== "enabled") return "not available yet; its place is kept for a later Moondog";
  if (role.id === "chat") return role.choice ? modelName(role.choice) : "none chosen; /model picks one";
  if (role.kind === "service") {
    const service = (id) => role.services?.find((entry) => entry.id === id || entry.provider === id);
    if (role.choice) {
      const chosen = service(role.choice.service);
      return `${chosen?.name ?? role.choice.service}${chosen && !chosen.ready ? " (not set up; falls back to the next service)" : ""}`;
    }
    const used = service(role.search);
    return used?.ready ? `auto, now ${used.name}` : "auto, but no service is set up; /web status says how";
  }
  if (role.choice) return modelName(role.choice);
  return role.auto ? `auto, now ${modelName(role.auto)}` : "auto, but the chat model can't see images";
}

export function formatModelRoles(roles) {
  const lines = roles.map((role) => `- ${titles[role.id] ?? role.id}: ${describe(role)}`);
  return `# What each model is for\n\n${lines.join("\n")}\n\n` +
    "`/model vision <provider> <model>` gives images a model of their own, and `/model vision auto` gives them back to the chat model when it can see.\n" +
    "`/model web deepseek|brave|codex` picks the web search service, and `/model web auto` takes the first one set up.";
}

export async function runModelRolesCommand({ args = [], modelSettings, webResearch } = {}) {
  if (!modelSettings?.roles) throw new Error("Model roles aren't available when Moondog is started this way.");
  const [word, ...rest] = args;
  const roleId = MODEL_ROLE_WORDS[String(word ?? "").toLowerCase()];
  const show = async () => formatModelRoles(await modelSettings.roles({ web: await webResearch?.services?.().catch(() => null) ?? null }));
  if (roleId === null) {
    if (rest.length) throw new Error(usage);
    return show();
  }
  if (roleId === undefined) throw new Error(usage);
  const role = MODEL_ROLES.find((entry) => entry.id === roleId);
  if (role.state !== "enabled") return `${titles[roleId]} isn't available yet. Its place is kept, so a later Moondog can add it.`;
  if (!rest.length) return show();
  let choice;
  if (rest.length === 1 && rest[0].toLowerCase() === "auto") choice = null;
  else if (role.kind === "service") {
    if (rest.length !== 1 || !WEB_SERVICES.includes(rest[0].toLowerCase())) throw new Error(usage);
    choice = { service: rest[0].toLowerCase() };
  } else {
    if (rest.length !== 2) throw new Error(usage);
    choice = { provider: rest[0], model: rest[1] };
  }
  await modelSettings.setRole(roleId, choice);
  if (roleId === "web_search") await webResearch?.refresh?.();
  return show();
}
