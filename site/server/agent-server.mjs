// Moondog's public agent. The website room sends each message here, and the real
// PiAgentRuntime answers from the fictional listener's history.
// Every visitor gets a private copy of that history; nothing is written back or kept,
// and message text is never logged.
//
//   DEEPSEEK_API_KEY=... node site/server/agent-server.mjs
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareFictionalHistory } from "../room/fictional-history.mjs";
import { DailyLimits } from "./limits.mjs";

const numberFrom = (value, fallback) => (Number.isFinite(Number(value)) && value !== "" && value != null ? Number(value) : fallback);

export function configFromEnvironment(environment = process.env) {
  return {
    port: numberFrom(environment.PORT, 8787),
    host: environment.HOST ?? "0.0.0.0",
    origins: (environment.MOONDOG_AGENT_ORIGINS ?? "https://moondog.audiofool.ai").split(",").map((origin) => origin.trim()).filter(Boolean),
    // Set to the header the proxy in front writes, such as cf-connecting-ip or x-real-ip.
    addressHeader: environment.MOONDOG_AGENT_ADDRESS_HEADER?.toLowerCase() || null,
    provider: environment.MOONDOG_AGENT_PROVIDER ?? "deepseek",
    model: environment.MOONDOG_AGENT_MODEL ?? "deepseek-flash",
    dailyBudgetUsd: numberFrom(environment.MOONDOG_AGENT_DAILY_BUDGET_USD, 3),
    sessionsPerAddress: numberFrom(environment.MOONDOG_AGENT_SESSIONS_PER_ADDRESS, 6),
    turnsPerAddress: numberFrom(environment.MOONDOG_AGENT_TURNS_PER_ADDRESS, 30),
    turnsPerSession: numberFrom(environment.MOONDOG_AGENT_TURNS_PER_SESSION, 8),
    toolCallsPerTurn: numberFrom(environment.MOONDOG_AGENT_TOOL_CALLS_PER_TURN, 12),
    maxOutputTokens: numberFrom(environment.MOONDOG_AGENT_MAX_OUTPUT_TOKENS, 4000),
    maxPromptChars: numberFrom(environment.MOONDOG_AGENT_MAX_PROMPT_CHARS, 600),
    maxConcurrentTurns: numberFrom(environment.MOONDOG_AGENT_MAX_CONCURRENT_TURNS, 8),
    maxSessions: numberFrom(environment.MOONDOG_AGENT_MAX_SESSIONS, 300),
    sessionIdleMs: numberFrom(environment.MOONDOG_AGENT_SESSION_IDLE_MINUTES, 30) * 60_000,
    turnTimeoutMs: numberFrom(environment.MOONDOG_AGENT_TURN_TIMEOUT_SECONDS, 150) * 1000,
    // A writable folder that outlives the container, so the daily budget survives restarts.
    stateDir: environment.MOONDOG_AGENT_STATE_DIR?.trim() || null,
    // With a Turnstile secret, each new conversation needs a token from Cloudflare's check on the page.
    turnstileSecret: environment.TURNSTILE_SECRET_KEY?.trim() || null,
  };
}

// Asks Cloudflare whether a Turnstile token is genuine and unused.
export async function verifyTurnstile({ secret, token, address }) {
  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret, response: token, ...(address && address !== "unknown" ? { remoteip: address } : {}) }),
      signal: AbortSignal.timeout(10_000),
    });
    return (await response.json()).success === true;
  } catch {
    return false;
  }
}

// What the visitor reads when a limit stops a turn. These arrive as Moondog's reply.
const notices = {
  session_turns: "That's all for this demo conversation. Type `/new` to start another one, or install Moondog to keep talking as long as you like.",
  daily_limit: "That's today's demo for you. Moondog itself has no such limit: install it and bring your own model.",
  budget: "The demo has used today's model budget, so I'm quiet until tomorrow (UTC). `/taste` still works here.",
  busy: "The demo is busy right now. Try again in a minute.",
  failed: "I couldn't finish that reply. Try again in a moment.",
  model_unavailable: "The demo can't reach its model right now. `/taste` still works here.",
  too_long: "Keep messages here under {max} characters, please.",
  check_failed: "I couldn't confirm you're a person. Reload the page and try again.",
};

// The demo agent reads, plans, and plays previews on the page; it never writes, builds, or acts on a service.
const allowedEffects = new Set(["read_local", "read_runtime", "read_external", "derive_local", "play_preview"]);

export async function startAgentServer(config = configFromEnvironment(), { credentials, modelsFactory, verifyHuman = verifyTurnstile, musicCatalog: catalogOverride, log = console.log } = {}) {
  const work = await mkdtemp(path.join(tmpdir(), "moondog-agent-"));
  const { environment, databasePath: template } = await prepareFictionalHistory(path.join(work, "listener"));
  // Moondog modules read their folders from the environment; keep them inside this server's work folder.
  Object.assign(process.env, environment);
  const { openListeningHistoryStore } = await import("../../src/profile/listening-history-store.mjs");
  const { createListeningProfileDomainServices } = await import("../../src/core/listening-profile-domain-services.mjs");
  const { MoondogApplication } = await import("../../src/core/moondog-application.mjs");
  const { createAppleMusicCatalog } = await import("../../src/integrations/apple-music/catalog.mjs");
  const { createOpenMusicSimilarity, createWikidataArtistResolver } = await import("../../src/integrations/open-music-similarity/artist-radio.mjs");
  const { createConfiguredRuntime } = await import("../../src/runtime/pi/configured-runtime.mjs");
  const { PiAgentRuntime } = await import("../../src/runtime/pi/agent-runtime.mjs");

  class DemoApplication extends MoondogApplication {
    agentCapabilityDescriptors() {
      return super.agentCapabilityDescriptors().filter((descriptor) => allowedEffects.has(descriptor.effect));
    }
  }

  const limits = new DailyLimits({ ...config, stateFile: config.stateDir ? path.join(config.stateDir, "daily-limits.json") : null });
  const sessions = new Map();
  let activeTurns = 0;
  const musicCatalog = catalogOverride ?? createAppleMusicCatalog();
  const artistIdentityResolver = createWikidataArtistResolver();
  const musicSimilarity = createOpenMusicSimilarity({ identityResolver: artistIdentityResolver });
  const modelEnvironment = { ...process.env, MOONDOG_PROVIDER: config.provider, MOONDOG_MODEL: config.model };

  // Caps every model call's output, and keeps track of the calls in the current turn.
  const guardModels = (models, session) => new Proxy(models, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (key !== "streamSimple") return typeof value === "function" ? value.bind(target) : value;
      return (model, context, options = {}) => {
        session.modelCalls += 1;
        return target.streamSimple(model, context, { ...options, maxTokens: Math.min(options.maxTokens ?? Infinity, config.maxOutputTokens) });
      };
    },
  });

  const openSession = async (address) => {
    const id = randomUUID();
    const folder = path.join(work, "sessions", id);
    await mkdir(folder, { recursive: true });
    const databasePath = path.join(folder, "listening-history.sqlite");
    await copyFile(template, databasePath);
    const store = await openListeningHistoryStore({ databasePath, environment });
    const application = new DemoApplication({
      domainServices: createListeningProfileDomainServices({ listeningHistoryStore: store, subjectId: store.localSubjectId() }),
      locale: "en",
      musicCatalog,
      musicSimilarity,
      artistIdentityResolver,
      // Previews play in the visitor's page, sent as a stream event of the current turn.
      musicPreviewPlayer: {
        play: async (tracks, { album } = {}) => session.emit?.({
          type: "preview",
          tracks: tracks.map((track) => ({
            title: track.title, artist_credit: track.artist_credit,
            preview_url: track.preview_url, catalog_url: track.catalog_url, artwork_url: track.artwork_url,
          })),
          ...(album ? { album: { title: album.title, artist_credit: album.artist_credit, catalog_url: album.catalog_url, artwork_url: album.artwork_url } } : {}),
        }),
      },
    });
    const session = { id, address, folder, store, application, runtime: null, turns: 0, modelCalls: 0, busy: false, lastUsed: Date.now(), emit: null };
    session.runtime = await createConfiguredRuntime(application, modelEnvironment, {
      credentials,
      modelsFactory,
      runtimeFactory: (configuration) => new PiAgentRuntime({ ...configuration, models: guardModels(configuration.models, session) }),
    });
    sessions.set(id, session);
    return session;
  };

  const closeSession = async (session) => {
    sessions.delete(session.id);
    try { session.runtime?.abort?.(); } catch {}
    try { await session.application.close?.(); } catch {}
    try { session.store.close(); } catch {}
    await rm(session.folder, { recursive: true, force: true });
  };

  // Ask once at startup whether the model is reachable with the configured key.
  const probe = await openSession("startup");
  const runtimeStatus = probe.runtime.publicStatus();
  await closeSession(probe);
  const modelReady = runtimeStatus.state === "configured";
  log(`moondog-agent: ${config.provider}/${config.model} ${modelReady ? "ready" : `unavailable (${runtimeStatus.reason})`}`);

  const sweeper = setInterval(() => {
    const cutoff = Date.now() - config.sessionIdleMs;
    for (const session of sessions.values()) if (!session.busy && session.lastUsed < cutoff) void closeSession(session);
  }, 60_000);
  sweeper.unref();

  const availability = () => {
    if (!modelReady) return { available: false, reason: "model_unavailable" };
    if (limits.budgetLeft() <= 0) return { available: false, reason: "budget" };
    return { available: true };
  };

  const addressOf = (request) => {
    const header = config.addressHeader && request.headers[config.addressHeader];
    const value = (Array.isArray(header) ? header[0] : header)?.split(",")[0].trim();
    return value || request.socket.remoteAddress || "unknown";
  };
  const tag = (address) => createHash("sha256").update(`${limits.day}:${address}`).digest("hex").slice(0, 8);

  const send = (response, status, body) => {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(JSON.stringify(body));
  };
  const readBody = (request) => new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 8192) { reject(Object.assign(new Error("too large"), { status: 413 })); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch { reject(Object.assign(new Error("bad json"), { status: 400 })); }
    });
    request.on("error", reject);
  });

  const runTurn = async (request, response, session, address) => {
    const body = await readBody(request);
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return send(response, 400, { error: { code: "empty" } });

    response.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" });
    const emit = (event) => { if (!response.writableEnded) response.write(`${JSON.stringify(event)}\n`); };
    const notice = (code, values = {}) => {
      emit({ type: "notice", code, text: notices[code].replace(/\{(\w+)\}/gu, (_, name) => String(values[name] ?? "")) });
      response.end();
    };

    if (text.length > config.maxPromptChars) return notice("too_long", { max: config.maxPromptChars });
    if (!availability().available) return notice("budget");
    if (session.turns >= config.turnsPerSession) return notice("session_turns");
    if (activeTurns >= config.maxConcurrentTurns || session.busy) return notice("busy");
    if (!limits.claimTurn(address)) return notice("daily_limit");

    session.busy = true;
    session.emit = emit;
    session.turns += 1;
    session.modelCalls = 0;
    session.lastUsed = Date.now();
    activeTurns += 1;
    const firstMessage = session.runtime.agent?.state.messages.length ?? 0;
    let toolCalls = 0;
    const abort = () => { try { session.runtime.abort(); } catch {} };
    const timer = setTimeout(abort, config.turnTimeoutMs);
    response.on("close", () => { if (!response.writableFinished) abort(); });
    const started = Date.now();
    let outcome = "failed";
    try {
      const result = await session.runtime.prompt(text, {
        onTextDelta: (delta) => emit({ type: "text_delta", delta }),
        onTextReplace: (replacement) => emit({ type: "text_replace", text: replacement }),
        onModelRetry: ({ attempt, maxRetries }) => emit({ type: "model_retry", attempt, maxRetries }),
        onToolStart: (tool) => {
          emit({ type: "tool_start", tool });
          if ((toolCalls += 1) > config.toolCallsPerTurn) abort();
        },
        onToolEnd: (tool) => emit({ type: "tool_end", tool }),
      });
      outcome = result?.status ?? "completed";
      emit({ type: "result", result: { status: result?.status, text: result?.text ?? "" } });
    } catch (error) {
      // Provider errors stay in the server log; the visitor gets a plain reply.
      log(`turn ${tag(address)} ${session.id.slice(0, 8)} error: ${String(error?.message ?? error).slice(0, 300)}`);
      emit({ type: "notice", code: "failed", text: notices.failed });
    } finally {
      clearTimeout(timer);
      const usage = (session.runtime.agent?.state.messages ?? []).slice(firstMessage)
        .filter((message) => message.role === "assistant")
        .reduce((sum, message) => sum + (message.usage?.cost?.total ?? 0), 0);
      limits.spend(usage);
      activeTurns -= 1;
      session.busy = false;
      session.emit = null;
      session.lastUsed = Date.now();
      response.end();
      const day = limits.summary();
      log(`turn ${tag(address)} ${session.id.slice(0, 8)} #${session.turns} ${outcome} ${session.modelCalls} calls ${toolCalls} tools $${usage.toFixed(4)} ${Date.now() - started}ms | today $${day.spentUsd} ${day.turns} turns`);
    }
  };

  const server = http.createServer(async (request, response) => {
    const origin = request.headers.origin;
    const originAllowed = Boolean(origin) && config.origins.includes(origin);
    if (originAllowed) {
      response.setHeader("access-control-allow-origin", origin);
      response.setHeader("vary", "origin");
      response.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
      response.setHeader("access-control-allow-headers", "content-type");
      response.setHeader("access-control-max-age", "600");
    }
    const url = new URL(request.url, "http://agent");
    try {
      if (request.method === "OPTIONS") { response.writeHead(originAllowed ? 204 : 403); return response.end(); }
      if (request.method === "GET" && url.pathname === "/healthz") return send(response, 200, { ok: true });
      if (request.method === "GET" && url.pathname === "/v1/status") {
        return send(response, 200, { ...availability(), provider: config.provider, model: config.model, turnsPerSession: config.turnsPerSession, humanCheck: Boolean(config.turnstileSecret) });
      }
      // Only the website may open conversations from a browser.
      if (!originAllowed) return send(response, 403, { error: { code: "origin" } });
      const address = addressOf(request);

      if (request.method === "POST" && url.pathname === "/v1/sessions") {
        const state = availability();
        const refuse = (status, code) => send(response, status, { error: { code, text: notices[code] } });
        if (!state.available) return refuse(503, state.reason);
        if (sessions.size >= config.maxSessions) return refuse(503, "busy");
        if (config.turnstileSecret) {
          const token = (await readBody(request)).turnstileToken;
          const human = typeof token === "string" && token.length > 0 && token.length <= 2048 &&
            await verifyHuman({ secret: config.turnstileSecret, token, address });
          if (!human) return refuse(403, "check_failed");
        }
        if (!limits.claimSession(address)) return refuse(429, "daily_limit");
        const session = await openSession(address);
        return send(response, 201, { session: session.id, turnsPerSession: config.turnsPerSession });
      }
      const match = /^\/v1\/sessions\/([0-9a-f-]{36})(\/turns)?$/u.exec(url.pathname);
      const session = match && sessions.get(match[1]);
      if (match && !session) return send(response, 404, { error: { code: "session_missing" } });
      if (session && session.address !== address) return send(response, 404, { error: { code: "session_missing" } });
      if (session && request.method === "DELETE" && !match[2]) {
        if (!session.busy) await closeSession(session);
        return send(response, 204, {});
      }
      if (session && request.method === "POST" && match[2]) return await runTurn(request, response, session, address);
      return send(response, 404, { error: { code: "not_found" } });
    } catch (error) {
      if (response.headersSent) { response.end(); return; }
      send(response, error.status ?? 500, { error: { code: error.status ? "bad_request" : "server" } });
      if (!error.status) log(`moondog-agent error: ${error?.stack ?? error}`);
    }
  });

  await new Promise((resolve) => server.listen(config.port, config.host, resolve));
  log(`moondog-agent: listening on ${config.host}:${server.address().port} for ${config.origins.join(", ")}`);

  return {
    server,
    port: server.address().port,
    limits,
    sessions,
    async close() {
      clearInterval(sweeper);
      await new Promise((resolve) => server.close(resolve));
      for (const session of [...sessions.values()]) await closeSession(session);
      await rm(work, { recursive: true, force: true });
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const agent = await startAgentServer();
  const stop = async () => { await agent.close(); process.exit(0); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
