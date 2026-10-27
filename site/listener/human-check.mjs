// Cloudflare Turnstile, loaded only when a visitor starts a conversation with the agent.
// It usually decides on its own; when it needs the visitor, it shows its check in `container`.
const script = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

export function createHumanCheck(siteKey, container) {
  let loading = null;
  let widget;
  let pending = null;
  let interactive = null;
  const settle = (outcome, value) => {
    const current = pending;
    pending = null;
    container.hidden = true;
    current?.[outcome](value);
  };
  const load = () => loading ??= new Promise((resolve, reject) => {
    const element = Object.assign(document.createElement("script"), { src: script, async: true });
    element.onload = resolve;
    element.onerror = () => { loading = null; reject(new Error("Turnstile did not load")); };
    document.head.append(element);
  });

  // Each conversation gets a fresh token; Cloudflare accepts a token once.
  // onInteractive runs when Cloudflare needs the visitor to tick its box.
  return async function token({ signal, onInteractive } = {}) {
    interactive = onInteractive ?? null;
    await load();
    const { turnstile } = window;
    const result = new Promise((resolve, reject) => { pending = { resolve, reject }; });
    container.hidden = false;
    if (widget === undefined) {
      widget = turnstile.render(container, {
        sitekey: siteKey,
        action: "conversation",
        execution: "execute",
        appearance: "interaction-only",
        callback: (value) => settle("resolve", value),
        "error-callback": () => settle("reject", new Error("Turnstile failed")),
        "expired-callback": () => settle("reject", new Error("Turnstile expired")),
        "before-interactive-callback": () => interactive?.(),
      });
    } else {
      turnstile.reset(widget);
    }
    turnstile.execute(widget);
    const timeout = setTimeout(() => settle("reject", new Error("Turnstile timed out")), 120_000);
    signal?.addEventListener("abort", () => settle("reject", signal.reason), { once: true });
    try { return await result; } finally { clearTimeout(timeout); }
  };
}
