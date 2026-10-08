// Sends the room's messages to Moondog's public agent and replays its progress,
// so the TUI shows a remote reply exactly as it shows a local one.
import { needsApp } from "./browser-application.mjs";

const unreachable = "I can't reach Moondog's demo server right now. `/taste` still works here.";
const unchecked = "I couldn't confirm you're a person. Reload the page and try again.";

export class RemoteRuntime {
  // humanCheck, when given, returns a Turnstile token for each new conversation.
  // onPreview receives each set of Apple Music previews the agent plays, as (tracks, album).
  constructor(url, { humanCheck, onPreview } = {}) {
    this.url = url.replace(/\/+$/u, "");
    this.humanCheck = humanCheck;
    this.onPreview = onPreview;
    this.session = null;
    this.controller = null;
  }

  publicStatus() {
    return { state: "configured", adapter: "moondog_web_agent", provider: "deepseek", model: "deepseek-flash", session_persistence: "none", external_effects: "disabled" };
  }

  async prompt(text, callbacks = {}) {
    if (this.controller) throw new Error("A Moondog prompt is already in progress.");
    const controller = this.controller = new AbortController();
    try {
      // A conversation the server let go of (idle, restarted) starts over once.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (!this.session) {
          let turnstileToken;
          if (this.humanCheck) {
            try { turnstileToken = await this.humanCheck({ signal: controller.signal }); }
            catch { if (controller.signal.aborted) throw controller.signal.reason; return notice(unchecked, callbacks); }
          }
          const opened = await fetch(`${this.url}/v1/sessions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(turnstileToken ? { turnstileToken } : {}),
            signal: controller.signal,
          });
          const body = await opened.json().catch(() => ({}));
          if (!opened.ok) return notice(body.error?.text ?? unreachable, callbacks);
          this.session = body.session;
        }
        const response = await fetch(`${this.url}/v1/sessions/${this.session}/turns`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
          signal: controller.signal,
        });
        if (response.status === 404) { this.session = null; continue; }
        if (!response.ok || !response.body) return notice(unreachable, callbacks);
        return await replay(response.body, { ...callbacks, onPreview: this.onPreview });
      }
      return notice(unreachable, callbacks);
    } catch {
      if (controller.signal.aborted) return { status: "aborted", text: "" };
      return notice(unreachable, callbacks);
    } finally {
      this.controller = null;
    }
  }

  abort() { this.controller?.abort(); }

  // /new starts a fresh conversation on the server too.
  reset() {
    if (this.session) void fetch(`${this.url}/v1/sessions/${this.session}`, { method: "DELETE", keepalive: true }).catch(() => {});
    this.session = null;
  }

  restoreSession() {}
  rewindTo() { throw needsApp("Rewind"); }
}

function notice(text, callbacks) {
  callbacks.onTextReplace?.(text);
  return { status: "completed", text };
}

async function replay(body, callbacks) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const event = JSON.parse(line);
      if (event.type === "text_delta") callbacks.onTextDelta?.(event.delta);
      else if (event.type === "text_replace") callbacks.onTextReplace?.(event.text);
      else if (event.type === "tool_start") callbacks.onToolStart?.(event.tool);
      else if (event.type === "tool_end") callbacks.onToolEnd?.(event.tool);
      else if (event.type === "model_retry") callbacks.onModelRetry?.(event);
      else if (event.type === "preview") callbacks.onPreview?.(event.tracks ?? [], event.album ?? null);
      else if (event.type === "notice") return notice(event.text, callbacks);
      else if (event.type === "result") return event.result;
    }
  }
  return notice(unreachable, callbacks);
}
