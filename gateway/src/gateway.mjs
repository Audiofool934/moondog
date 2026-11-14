// The Moondog model's gateway: one model named "moondog", open to listeners who hold an invite
// code. The code is the bearer key. The gateway holds the upstream key and picks the upstream
// model, so neither ships in the app, and it counts each code's tokens against a daily allowance.
// It keeps no conversation: only token counts per code per day.

export const MODEL_ID = "moondog";
export const INVITE_PATTERN = /^md-[0-9a-hjkmnp-tv-z]{24}$/u;

const CODE_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
// The allowance day turns at midnight in Beijing, where most of the first listeners are.
const DAY_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const quotaDay = (at) => new Date(at + DAY_OFFSET_MS).toISOString().slice(0, 10);
const secondsToNextDay = (at) => Math.ceil((DAY_MS - ((at + DAY_OFFSET_MS) % DAY_MS)) / 1000);

export async function hashInvite(code) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function newInviteCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return `md-${[...bytes].map((byte) => CODE_ALPHABET[byte % 32]).join("")}`;
}

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
});

// OpenAI's error shape, so every client that speaks Chat Completions can show the message.
const refusal = (status, code, message, headers) => json(status, { error: { message, type: "moondog_gateway_error", code } }, headers);

const bearer = (request) => /^Bearer\s+(\S+)$/u.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";

async function sameSecret(given, expected) {
  if (!given || !expected) return false;
  const [a, b] = await Promise.all([hashInvite(given), hashInvite(expected)]);
  return a === b;
}

const count = (value) => (Number.isSafeInteger(value) && value > 0 ? value : 0);
const estimateTokens = (characters) => Math.ceil(characters / 3);

/**
 * Passes an upstream event stream through, naming the model "moondog" in every event and reading
 * the token counts from the last one. `settle` runs once, when the stream ends or the listener
 * hangs up, with the counts the upstream reported or null when it reported none.
 */
export function relayEventStream(body, settle) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  let usage = null;
  let characters = 0;
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    settle(usage, characters);
  };
  const rewrite = (line) => {
    if (!line.startsWith("data:")) return line;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return line;
    try {
      const event = JSON.parse(payload);
      if (event.usage) usage = event.usage;
      if (typeof event.model === "string") event.model = MODEL_ID;
      return `data: ${JSON.stringify(event)}`;
    } catch {
      return line;
    }
  };
  return new ReadableStream({
    async pull(controller) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            pending += decoder.decode();
            if (pending) controller.enqueue(encoder.encode(rewrite(pending)));
            controller.close();
            finish();
            return;
          }
          const text = decoder.decode(value, { stream: true });
          characters += text.length;
          pending += text;
          const lines = pending.split("\n");
          pending = lines.pop();
          if (lines.length > 0) {
            controller.enqueue(encoder.encode(`${lines.map(rewrite).join("\n")}\n`));
            return;
          }
        }
      } catch (error) {
        finish();
        controller.error(error);
      }
    },
    async cancel(reason) {
      finish();
      await reader.cancel(reason).catch(() => {});
    },
  });
}

/**
 * @param {object} options
 * @param {object} options.store invites and daily token counts; see store-d1.mjs
 * @param {object} options.upstream { baseUrl, apiKey, model, extraBody }
 * @param {object} options.limits { dailyTokens, globalDailyTokens, endsAt }
 * @param {string} options.adminToken the owner's key for /admin
 * @param {(key: string) => Promise<boolean>} [options.allowRequest] per-minute limit; false refuses
 */
export function createGateway({ store, upstream, limits, adminToken, allowRequest = async () => true, fetch = globalThis.fetch, now = Date.now }) {
  async function admit(request) {
    const code = bearer(request);
    if (!INVITE_PATTERN.test(code)) return { refused: refusal(401, "invite_invalid", "This invite code isn't one Moondog knows. Check it and enter it again.") };
    const at = now();
    const day = quotaDay(at);
    const { invite, used, totalUsed } = await store.lookup(await hashInvite(code), day);
    if (!invite) return { refused: refusal(401, "invite_invalid", "This invite code isn't one Moondog knows. Check it and enter it again.") };
    if (invite.status !== "active") return { refused: refusal(401, "invite_revoked", "This invite code is no longer active.") };
    const endsAt = invite.expiresAt ?? limits.endsAt;
    if (endsAt && at >= endsAt) return { refused: refusal(403, "beta_ended", "The Moondog model's test period has ended. Thank you for listening.") };
    const dailyTokens = invite.dailyTokenLimit ?? limits.dailyTokens;
    return { invite, day, at, used, totalUsed, dailyTokens };
  }

  const allowance = ({ invite, used, dailyTokens, at }) => ({
    label: invite.label,
    model: MODEL_ID,
    daily_tokens: dailyTokens,
    used_today: used,
    resets_in_seconds: secondsToNextDay(at),
  });

  async function chat(request, context) {
    const admitted = await admit(request);
    if (admitted.refused) return admitted.refused;
    const { invite, day, at, used, totalUsed, dailyTokens } = admitted;
    const wait = String(secondsToNextDay(at));
    if (used >= dailyTokens) {
      return refusal(429, "daily_allowance_used", "You've used today's Moondog allowance. It starts again at midnight, Beijing time.", { "retry-after": wait });
    }
    if (totalUsed >= limits.globalDailyTokens) {
      return refusal(429, "beta_capacity_reached", "The Moondog model is at today's limit for all testers. It starts again at midnight, Beijing time.", { "retry-after": wait });
    }
    if (!(await allowRequest(invite.id))) {
      return refusal(429, "rate_limited", "Too many requests in a minute. Wait a moment and try again.", { "retry-after": "20" });
    }

    const raw = await request.text();
    if (raw.length > MAX_REQUEST_BYTES) return refusal(413, "request_too_large", "This request is too large for the Moondog model.");
    let body;
    try { body = JSON.parse(raw); } catch { body = null; }
    if (!body || typeof body !== "object" || !Array.isArray(body.messages)) {
      return refusal(400, "request_invalid", "The request must be a Chat Completions body with messages.");
    }
    const streaming = body.stream === true;
    const forwarded = { ...body, ...upstream.extraBody, model: upstream.model };
    if (streaming) forwarded.stream_options = { ...body.stream_options, include_usage: true };
    else delete forwarded.stream_options;

    let reply;
    try {
      reply = await fetch(`${upstream.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${upstream.apiKey}` },
        body: JSON.stringify(forwarded),
        signal: request.signal,
      });
    } catch {
      return refusal(502, "upstream_unreachable", "The Moondog model didn't answer. Try again in a moment.");
    }

    const record = (usage, characters) => {
      const input = count(usage?.prompt_tokens) || estimateTokens(raw.length);
      const output = count(usage?.completion_tokens) || estimateTokens(characters);
      context?.waitUntil?.(store.addUsage(invite.id, day, { input, output }).catch(() => {}));
    };

    if (!reply.ok) {
      // The upstream's own words can name the upstream; the status alone tells the app what to do.
      await reply.body?.cancel().catch(() => {});
      const status = reply.status === 429 || reply.status >= 500 ? reply.status : 502;
      const headers = reply.headers.get("retry-after") ? { "retry-after": reply.headers.get("retry-after") } : {};
      return refusal(status, "upstream_error", "The Moondog model couldn't answer this request. Try again in a moment.", headers);
    }
    if (streaming && reply.body) {
      return new Response(relayEventStream(reply.body, record), {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" },
      });
    }
    const text = await reply.text();
    let completion;
    try { completion = JSON.parse(text); } catch { completion = null; }
    record(completion?.usage, text.length);
    if (!completion) return refusal(502, "upstream_error", "The Moondog model couldn't answer this request. Try again in a moment.");
    if (typeof completion.model === "string") completion.model = MODEL_ID;
    return json(200, completion);
  }

  async function admin(request, url) {
    if (!(await sameSecret(bearer(request), adminToken))) return refusal(401, "admin_unauthorized", "Not allowed.");
    const [, , resource, id, action] = url.pathname.split("/");
    if (resource !== "invites") return refusal(404, "not_found", "Not found.");
    if (request.method === "GET" && !id) {
      return json(200, { day: quotaDay(now()), invites: await store.listInvites(quotaDay(now())) });
    }
    if (request.method === "POST" && !id) {
      const input = await request.json().catch(() => ({}));
      const labels = Array.isArray(input.labels) ? input.labels : [input.label];
      const created = [];
      for (const label of labels.slice(0, 200)) {
        const code = newInviteCode();
        const stored = await store.createInvite({
          hash: await hashInvite(code),
          label: String(label ?? "").slice(0, 80),
          dailyTokenLimit: count(input.daily_tokens) || null,
          expiresAt: count(input.expires_at) || null,
          createdAt: now(),
        });
        // The code is shown here once; only its hash is kept.
        created.push({ id: stored, label: String(label ?? "").slice(0, 80), code });
      }
      return json(201, { invites: created });
    }
    if (request.method === "POST" && id && (action === "revoke" || action === "restore")) {
      const changed = await store.setStatus(Number(id), action === "revoke" ? "revoked" : "active");
      return changed ? json(200, { id: Number(id), status: action === "revoke" ? "revoked" : "active" }) : refusal(404, "not_found", "No such invite.");
    }
    return refusal(404, "not_found", "Not found.");
  }

  return async function handle(request, context) {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname.replace(/\/+$/u, "") || "/"}`;
    try {
      if (route === "POST /v1/chat/completions") return await chat(request, context);
      if (route === "GET /v1/models") {
        const admitted = await admit(request);
        return admitted.refused ?? json(200, { object: "list", data: [{ id: MODEL_ID, object: "model", owned_by: "moondog" }] });
      }
      if (route === "GET /v1/invite") {
        const admitted = await admit(request);
        return admitted.refused ?? json(200, allowance(admitted));
      }
      if (url.pathname.startsWith("/admin/")) return await admin(request, url);
      if (route === "GET /") return json(200, { service: "moondog-model", model: MODEL_ID });
      return refusal(404, "not_found", "Not found.");
    } catch {
      return refusal(500, "gateway_error", "The Moondog model's gateway failed. Try again in a moment.");
    }
  };
}
