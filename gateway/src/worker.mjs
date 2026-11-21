import { createGateway } from "./gateway.mjs";
import { createD1Store } from "./store-d1.mjs";

const whole = (value, fallback) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

function extraBody(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// Web search and page reading go to WEB_SEARCH_URL and WEB_READ_URL, or by default to the
// upstream's /web_search and /reader, with WEB_API_KEY or the upstream's key.
function webService(env) {
  const base = String(env.UPSTREAM_BASE_URL ?? "").replace(/\/+$/u, "");
  if (env.WEB_SEARCH === "off" || (!base && !env.WEB_SEARCH_URL)) return null;
  return {
    search: env.WEB_SEARCH_URL || `${base}/web_search`,
    read: env.WEB_READ_URL || `${base}/reader`,
    apiKey: env.WEB_API_KEY || env.UPSTREAM_API_KEY,
    engine: env.WEB_SEARCH_ENGINE || "search-prime",
  };
}

export default {
  async fetch(request, env, context) {
    const handle = createGateway({
      store: createD1Store(env.DB),
      upstream: {
        baseUrl: String(env.UPSTREAM_BASE_URL ?? "").replace(/\/+$/u, ""),
        apiKey: env.UPSTREAM_API_KEY,
        model: env.UPSTREAM_MODEL,
        visionModel: env.UPSTREAM_VISION_MODEL || null,
        extraBody: extraBody(env.UPSTREAM_EXTRA_BODY),
      },
      web: webService(env),
      limits: {
        dailyTokens: whole(env.DAILY_TOKEN_LIMIT, 3_000_000),
        globalDailyTokens: whole(env.GLOBAL_DAILY_TOKEN_LIMIT, 40_000_000),
        perMinute: whole(env.PER_MINUTE_LIMIT, 20),
        endsAt: env.BETA_ENDS_AT ? Date.parse(env.BETA_ENDS_AT) || null : null,
      },
      adminToken: env.ADMIN_TOKEN,
    });
    return handle(request, context);
  },
};
