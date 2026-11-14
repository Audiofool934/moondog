import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

import { acquirePrivateFileLock, resolveMoondogAuthFile } from "./persistent-credential-store.mjs";

// Moondog's own model: one model named Moondog, answered by Moondog's gateway (see gateway/). A
// listener reaches it with an invite code, which is the key. Which model answers behind the gateway
// is the gateway's business, so no release is needed to change it. The code stays in its own
// private file: auth.json and settings.json are read with a fixed shape by older Moondogs.
export const MOONDOG_PROVIDER = "moondog";
export const MOONDOG_MODEL = "moondog";
const DEFAULT_URL = "https://moondog-api.audiofool.ai/v1";
const DOCUMENT_VERSION = 1;
const INVITE = /md-[0-9a-hjkmnp-tv-z]{24}/u;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

// What the gateway says when it refuses, in the listener's terms. The window has its own words for
// each code; the terminal shows these.
const REFUSALS = Object.freeze({
  invite_invalid: "Moondog doesn't know this invite code. Check it and enter it again.",
  invite_revoked: "This invite code is no longer active.",
  beta_ended: "The Moondog model's test period has ended.",
  daily_allowance_used: "You've used today's Moondog allowance. It starts again at midnight, Beijing time.",
  beta_capacity_reached: "The Moondog model is at today's limit for all testers. It starts again at midnight, Beijing time.",
  rate_limited: "Too many requests in a minute. Wait a moment and try again.",
});

function inviteError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.name = "MoondogRuntimeSettingsError";
  error.code = code;
  return error;
}

export const isMoondogProvider = (providerId) => providerId === MOONDOG_PROVIDER;

// The gateway's address. MOONDOG_MODEL_URL points a development build at another gateway.
export function moondogModelUrl(environment = process.env) {
  const configured = environment.MOONDOG_MODEL_URL?.trim();
  if (!configured) return DEFAULT_URL;
  let url;
  try { url = new URL(configured); } catch { return DEFAULT_URL; }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) return DEFAULT_URL;
  return url.href.replace(/\/+$/u, "");
}

// A code as the listener has it: typed, pasted, or inside an invite link.
export function parseInvite(value) {
  const code = INVITE.exec(String(value ?? "").trim().toLowerCase())?.[0];
  if (!code) throw inviteError("invite_invalid", "That isn't an invite code. A code starts with md- and has 24 more characters.");
  return code;
}

export function resolveInviteFile(environment = process.env) {
  return path.join(path.dirname(resolveMoondogAuthFile(environment)), "moondog-model.json");
}

export async function readInvite(environment = process.env) {
  let source;
  try {
    source = await readFile(resolveInviteFile(environment), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw inviteError("invite_store_invalid", "Moondog could not read its invite code.", error);
  }
  let document;
  try { document = JSON.parse(source); } catch { document = null; }
  if (!document || document.version !== DOCUMENT_VERSION || typeof document.code !== "string" || !INVITE.test(document.code)) {
    throw inviteError("invite_store_invalid", "Moondog's invite file uses a shape it can't read. Enter the code again in Settings.");
  }
  return { code: parseInvite(document.code), ...(typeof document.label === "string" ? { label: document.label.slice(0, 80) } : {}) };
}

// Asks the gateway whether it takes the code, and what it allows.
export async function checkInvite(code, environment = process.env, { fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  let reply;
  try {
    reply = await fetchImpl(`${moondogModelUrl(environment)}/invite`, {
      headers: { authorization: `Bearer ${code}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw inviteError("invite_unreachable", "Moondog could not reach its model service to check the code. Check your connection and try again.", error);
  }
  const body = await reply.json().catch(() => null);
  if (!reply.ok) {
    const code = body?.error?.code;
    if (Object.hasOwn(REFUSALS, code)) throw inviteError(code, REFUSALS[code]);
    throw inviteError("invite_unreachable", "Moondog's model service could not check the code. Try again in a moment.");
  }
  const number = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
  return {
    label: typeof body?.label === "string" ? body.label.slice(0, 80) : "",
    dailyTokens: number(body?.daily_tokens),
    usedToday: number(body?.used_today),
  };
}

// Saves a code once the gateway takes it, so a mistyped one never becomes the listener's model.
export async function saveInvite(value, environment = process.env, options = {}) {
  const code = parseInvite(value);
  const allowance = await checkInvite(code, environment, options);
  const file = resolveInviteFile(environment);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const release = await acquirePrivateFileLock(file);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify({ version: DOCUMENT_VERSION, code, label: allowance.label }, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
    await release();
  }
  return allowance;
}

export async function removeInvite(environment = process.env) {
  const file = resolveInviteFile(environment);
  const had = (await readInvite(environment).catch(() => true)) !== null;
  await rm(file, { force: true });
  return had;
}

// The provider is always in the catalog, so Settings can offer it; it can answer once a code is saved.
export function addMoondogModel(models, invite, environment = process.env) {
  const baseUrl = moondogModelUrl(environment);
  models.setProvider(createProvider({
    id: MOONDOG_PROVIDER, name: "Moondog", baseUrl,
    models: [{
      id: MOONDOG_MODEL, name: "Moondog", provider: MOONDOG_PROVIDER, api: "openai-completions", baseUrl,
      reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000, maxTokens: 8192,
    }],
    auth: { apiKey: { name: "Moondog invite code", resolve: async () => (invite?.code ? { auth: { apiKey: invite.code }, source: "stored credential" } : undefined) } },
    api: openAICompletionsApi(),
  }));
  return models;
}

/**
 * Reads why the gateway refused a model request. Returns an error whose code is the gateway's, with
 * words for the listener, or null when the answer is not one of the gateway's refusals.
 */
export async function moondogRefusal(response) {
  if (!response || response.ok || ![401, 403, 429].includes(response.status)) return null;
  const body = await response.clone().json().catch(() => null);
  const code = body?.error?.code;
  if (!Object.hasOwn(REFUSALS, code)) return null;
  const error = new Error(REFUSALS[code]);
  error.name = "MoondogModelRefusal";
  error.code = `moondog_${code}`;
  return error;
}
