// Sends the visitor's messages to Moondog's public agent and replays its progress, so the window
// and the terminal show a remote reply exactly as they show a local one. Each conversation in the
// tab has its own conversation on the server.
import { needsApp } from "./browser-application.mjs";

const unreachable = "I can't reach Moondog's demo server right now. Try again in a minute.";
const unchecked = "I couldn't confirm you're a person. Reload the page and try again.";
const tickTheBox = "Tick the check below to continue.";

export class RemoteRuntime {
  // agent names the model the server answers with (the snapshot's agent).
  // application keeps the tab's conversations and saves each finished turn.
  // humanCheck, when given, returns a Turnstile token for each new conversation.
  // onPreview receives each set of Apple Music previews the agent plays, as (tracks, album).
  constructor(url, { agent, application, humanCheck, onPreview } = {}) {
    this.url = url.replace(/\/+$/u, "");
    this.model = agent;
    this.application = application;
    this.humanCheck = humanCheck;
    this.onPreview = onPreview;
    this.sessions = new Map();
    this.controller = null;
    // The window follows a turn's tools through the agent's events, as it does in the app.
    const listeners = new Set();
    this.agent = { subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); } };
    this.emit = (event) => { for (const listener of listeners) listener(event); };
  }

  publicStatus() {
    return { state: "configured", adapter: "moondog_web_agent", provider: this.model?.provider ?? null, model: this.model?.model ?? null,
      session_persistence: "none", external_effects: "disabled" };
  }

  get conversation() { return this.application?.ensureMemorySession?.()?.session_id ?? "tab"; }

  async prompt(text, callbacks = {}) {
    if (this.controller) throw new Error("A Moondog prompt is already in progress.");
    const controller = this.controller = new AbortController();
    const conversation = this.conversation;
    try {
      // A conversation the server let go of (idle, restarted) starts over once.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let session = this.sessions.get(conversation);
        if (!session) {
          let turnstileToken;
          if (this.humanCheck) {
            // When Cloudflare needs a click, say so where the visitor is looking, then clear it.
            let asked = false;
            const onInteractive = () => { asked = true; callbacks.onTextReplace?.(tickTheBox); };
            try { turnstileToken = await this.humanCheck({ signal: controller.signal, onInteractive }); }
            catch { if (controller.signal.aborted) throw controller.signal.reason; return notice(unchecked, callbacks); }
            if (asked) callbacks.onTextReplace?.("");
          }
          const opened = await fetch(`${this.url}/v1/sessions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(turnstileToken ? { turnstileToken } : {}),
            signal: controller.signal,
          });
          const body = await opened.json().catch(() => ({}));
          if (!opened.ok) return notice(body.error?.text ?? unreachable, callbacks);
          session = body.session;
          this.sessions.set(conversation, session);
        }
        const response = await fetch(`${this.url}/v1/sessions/${session}/turns`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
          signal: controller.signal,
        });
        if (response.status === 404) { this.sessions.delete(conversation); continue; }
        if (!response.ok || !response.body) return notice(unreachable, callbacks);
        const result = await replay(response.body, { ...callbacks, onPreview: this.onPreview, emit: this.emit });
        if (result.text) this.application?.recordTurn?.(text, result.text);
        return result;
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

  // A new conversation starts fresh on the server; the one it leaves is let go there.
  reset() {
    const conversation = this.conversation;
    const session = this.sessions.get(conversation);
    this.sessions.delete(conversation);
    if (session) void fetch(`${this.url}/v1/sessions/${session}`, { method: "DELETE", keepalive: true }).catch(() => {});
  }

  restoreSession() {}
  rewindTo() { throw needsApp("Editing a message"); }
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
      else if (event.type === "tool_start") {
        callbacks.onToolStart?.(event.tool);
        callbacks.emit?.({ type: "tool_execution_start", toolCallId: event.tool?.toolCallId, toolName: event.tool?.toolName, args: {} });
      } else if (event.type === "tool_end") {
        callbacks.onToolEnd?.(event.tool);
        callbacks.emit?.({ type: "tool_execution_end", toolCallId: event.tool?.toolCallId, toolName: event.tool?.toolName, isError: event.tool?.isError === true });
      } else if (event.type === "model_retry") callbacks.onModelRetry?.(event);
      else if (event.type === "preview") callbacks.onPreview?.(event.tracks ?? [], event.album ?? null);
      else if (event.type === "notice") return notice(event.text, callbacks);
      else if (event.type === "result") return event.result;
    }
  }
  return notice(unreachable, callbacks);
}
