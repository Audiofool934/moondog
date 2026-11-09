import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { resolveMoondogAuthFile } from "./persistent-credential-store.mjs";

// What each model is for, after Hermes Agent's main model and auxiliary tasks: one chat model answers,
// and a side task can have a model of its own. A role without a saved choice is "auto": vision uses the
// chat model when it can see images, and web search takes the first service that is set up.
// The chat model stays in settings.json, which older Moondogs read with a fixed shape; the other
// roles live in model-roles.json beside it.
//
// kind "model" is a provider and model from the catalog; kind "service" is a web service by id.
// A "planned" role holds its place in the settings and in this file, but nothing can choose it yet.
export const MODEL_ROLES = Object.freeze([
  Object.freeze({ id: "chat", kind: "model", state: "enabled", stored: "settings" }),
  Object.freeze({ id: "vision", kind: "model", state: "enabled", input: "image" }),
  Object.freeze({ id: "web_search", kind: "service", state: "enabled" }),
  Object.freeze({ id: "audio", kind: "model", state: "planned", input: "audio" }),
]);

export const WEB_SERVICES = Object.freeze(["deepseek", "brave", "codex"]);

const ROLES_VERSION = 1;
const printable = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max && !/[\p{C}\s]/u.test(value);

function rolesError(message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.name = "MoondogRuntimeSettingsError";
  error.code = "model_roles_invalid";
  return error;
}

export const modelRole = (id) => MODEL_ROLES.find((role) => role.id === id) ?? null;

/** One role's choice in its saved shape, or null for auto. Throws on a shape the role can't take. */
export function normalizeRoleChoice(roleId, value) {
  const role = modelRole(roleId);
  if (!role || role.stored) throw rolesError(`Moondog has no model role called ${roleId}.`);
  if (value === null || value === undefined || value === "auto") return null;
  if (role.kind === "service") {
    const service = typeof value?.service === "string" ? value.service.trim().toLowerCase() : "";
    if (!WEB_SERVICES.includes(service)) throw rolesError(`Web search can use ${WEB_SERVICES.join(", ")} or auto.`);
    return { service };
  }
  const provider = typeof value?.provider === "string" ? value.provider.trim().toLowerCase() : "";
  const model = typeof value?.model === "string" ? value.model.trim() : "";
  if (!printable(provider, 80) || !printable(model, 200)) throw rolesError(`The ${roleId} role needs a provider and a model.`);
  return { provider, model, ...(typeof value.effort === "string" && printable(value.effort, 20) ? { effort: value.effort } : {}) };
}

export function resolveModelRolesFile(environment = process.env) {
  return path.join(path.dirname(resolveMoondogAuthFile(environment)), "model-roles.json");
}

// Every saved role as it is in the file, including roles a newer Moondog wrote, so a write here
// never drops them.
async function readDocument(environment) {
  let source;
  try {
    source = await readFile(resolveModelRolesFile(environment), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw rolesError("Moondog could not read its model roles.", error);
  }
  let document;
  try {
    document = JSON.parse(source);
  } catch (error) {
    throw rolesError("Moondog's model roles are not valid JSON.", error);
  }
  if (!document || typeof document !== "object" || document.version !== ROLES_VERSION ||
      !document.roles || typeof document.roles !== "object" || Array.isArray(document.roles)) {
    throw rolesError("Moondog's model roles use an unsupported shape.");
  }
  return document.roles;
}

/** The saved choice for each role this Moondog knows, by role id; a role left on auto is absent. */
export async function readModelRoles(environment = process.env) {
  const saved = await readDocument(environment);
  const roles = {};
  for (const role of MODEL_ROLES) {
    if (role.stored || role.state !== "enabled" || saved[role.id] === undefined) continue;
    // One bad entry leaves that role on auto instead of failing every role.
    try {
      const choice = normalizeRoleChoice(role.id, saved[role.id]);
      if (choice) roles[role.id] = choice;
    } catch {}
  }
  return roles;
}

// One change at a time, so two quick choices never lose either.
let writing = Promise.resolve();
/** Saves one role's choice; null puts it back on auto. */
export function writeModelRole(roleId, value, environment = process.env) {
  const role = modelRole(roleId);
  if (!role || role.stored) return Promise.reject(rolesError(`Moondog has no model role called ${roleId}.`));
  if (role.state !== "enabled") return Promise.reject(rolesError(`The ${roleId} role isn't available yet.`));
  let choice;
  try { choice = normalizeRoleChoice(roleId, value); } catch (error) { return Promise.reject(error); }
  const next = writing.then(async () => {
    const roles = { ...(await readDocument(environment).catch(() => ({}))) };
    if (choice) roles[roleId] = choice;
    else delete roles[roleId];
    const file = resolveModelRolesFile(environment);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    // Another Moondog may read the roles at any moment, so it never sees half a file.
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify({ version: ROLES_VERSION, roles }, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
    return choice;
  });
  writing = next.catch(() => {});
  return next;
}
