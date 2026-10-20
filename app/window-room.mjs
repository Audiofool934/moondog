// The window's side of the listening room. It drives the same application and agent the
// terminal uses, with messages from the window instead of keystrokes: a turn streams back
// as text and activity, and Spotify's player state arrives whenever it may have changed.
import { randomUUID } from "node:crypto";

const PLAYER_POLL_MS = { visible: 4_000, hidden: 30_000 };
// Tools whose results can change what Spotify is playing or what comes next.
const PLAYER_TOOLS = /^moondog_spotify_(?:player_control|queue_add|queue_batch|queue_similar|device_transfer|playlist_write)$/u;

const coverOf = (item) => (typeof item?.image === "string" ? item.image : null);
const trackOf = (item) => item && {
  title: item.name ?? "",
  artists: item.artists ?? (item.publisher ? [item.publisher] : []),
  album: item.album ?? null,
  image: coverOf(item),
  durationMs: Number.isInteger(item.duration_ms) ? item.duration_ms : null,
};

export function runWindowRoom({ application, runtime: firstRuntime, rebuildRuntime }, { port, send }) {
  let runtime = firstRuntime;
  let turn = null;
  let visible = true;
  let pollTimer = null;
  let polling = null;
  let closed = false;

  const sessionId = () => application.ensureMemorySession?.()?.session_id ?? null;
  const sessions = () => (application.listSavedSessions?.({ limit: 200 }) ?? []).map((session) => ({
    id: session.session_id, title: String(session.title ?? "").replace(/\s+/gu, " ").trim(),
    updatedAt: session.updated_at ?? session.started_at, branch: Boolean(session.parent_session_id),
  }));
  const transcript = () => (application.currentConversationTurns?.({ limit: 80 }) ?? [])
    .filter((entry) => entry.role === "user" || entry.role === "assistant").map((entry) => ({ role: entry.role, text: entry.text }));
  const status = () => {
    const model = runtime.publicStatus?.() ?? {};
    return { locale: application.locale, model: { state: model.state ?? "offline", provider: model.provider ?? null, model: model.model ?? null },
      spotify: application.spotifyReady?.() === true ? "ready" : "unavailable" };
  };
  const sendSessions = () => send({ type: "sessions", sessions: sessions(), current: sessionId() });

  async function readPlayer() {
    const service = application.spotifyConnection?.service;
    if (application.spotifyReady?.() !== true || !service) return { type: "player", spotify: "unavailable", now: null, next: [] };
    const [player, queue] = await Promise.all([service.currentPlayer(), service.queue?.().catch(() => null)]);
    const item = player?.state === "available" ? player.item : null;
    return { type: "player", spotify: "ready",
      now: item ? { ...trackOf(item), playing: player.is_playing === true, progressMs: player.progress_ms ?? 0,
        device: player.device?.name ?? null, observedAt: Date.now() } : null,
      next: (queue?.queue ?? []).slice(0, 8).map(trackOf) };
  }
  // One read at a time; a request while one runs reads again right after it.
  let again = false;
  async function refreshPlayer() {
    if (closed) return;
    if (polling) { again = true; return polling; }
    polling = readPlayer().then(send, (error) => send({ type: "player", spotify: "error", message: String(error?.message ?? error), now: null, next: [] }))
      .finally(() => {
        polling = null;
        if (again) { again = false; void refreshPlayer(); }
      });
    return polling;
  }
  const schedulePlayer = () => {
    clearTimeout(pollTimer);
    if (closed) return;
    pollTimer = setTimeout(async () => { await refreshPlayer(); schedulePlayer(); }, visible ? PLAYER_POLL_MS.visible : PLAYER_POLL_MS.hidden);
  };

  async function prompt(text) {
    if (turn || typeof text !== "string" || !text.trim()) return;
    const id = randomUUID();
    turn = { id };
    send({ type: "turn", id, state: "start", text });
    const unsubscribe = runtime.agent?.subscribe?.((event) => {
      if (event.type === "tool_execution_start") send({ type: "activity", id, call: event.toolCallId, tool: event.toolName, args: event.args ?? {}, state: "running" });
      if (event.type === "tool_execution_end") {
        send({ type: "activity", id, call: event.toolCallId, tool: event.toolName, state: event.isError ? "failed" : "done" });
        if (PLAYER_TOOLS.test(event.toolName)) void refreshPlayer();
      }
    }) ?? (() => {});
    try {
      const result = await runtime.prompt(text, {
        onTextDelta: (delta) => send({ type: "text", id, delta }),
        onTextReplace: (replacement) => send({ type: "text", id, replace: replacement }),
        onModelRetry: ({ attempt, maxRetries }) => send({ type: "retry", id, attempt, maxRetries }),
      });
      send({ type: "turn", id, state: "end", status: result.status, text: result.text ?? "",
        receipts: (result.spotify_write_receipts ?? []).map((receipt) => ({ action: receipt.action, state: receipt.state,
          targets: receipt.targets ?? [], device: receipt.device?.name ?? null })) });
    } catch (error) {
      send({ type: "turn", id, state: "error", message: String(error?.message ?? error), connection: error?.code === "model_connection_failed" });
    } finally {
      unsubscribe();
      turn = null;
      sendSessions();
      void refreshPlayer();
    }
  }

  async function control(action) {
    const service = application.spotifyConnection?.service;
    if (!service || application.spotifyReady?.() !== true || !["pause", "resume", "next", "previous"].includes(action)) return;
    try {
      await service[action]({});
    } catch (error) {
      send({ type: "player-error", action, message: String(error?.message ?? error) });
    }
    // Spotify takes a moment to report a skip.
    await refreshPlayer();
    setTimeout(() => void refreshPlayer(), 900);
  }

  function openSession(id) {
    if (turn) return;
    if (id) {
      application.resumeSession(id);
      runtime.restoreSession?.();
    } else {
      application.startNewSession?.("user_new");
      runtime.reset?.();
    }
    send({ type: "session", current: sessionId(), transcript: id ? transcript() : [] });
    sendSessions();
  }

  return new Promise((resolve) => {
    port.on("message", async ({ data }) => {
      try {
        if (data?.type === "prompt") await prompt(String(data.text ?? ""));
        else if (data?.type === "cancel") { if (turn) runtime.abort?.(); }
        else if (data?.type === "new") openSession(null);
        else if (data?.type === "open") openSession(String(data.id ?? ""));
        else if (data?.type === "control") await control(String(data.action ?? ""));
        else if (data?.type === "visible") { visible = data.visible !== false; if (visible) void refreshPlayer(); schedulePlayer(); }
        else if (data?.type === "model" && rebuildRuntime && !turn) {
          runtime = await rebuildRuntime(data.selection);
          send({ type: "status", ...status() });
        } else if (data?.type === "quit") {
          closed = true;
          clearTimeout(pollTimer);
          if (turn) runtime.abort?.();
          resolve({});
        }
      } catch (error) {
        send({ type: "notice", message: String(error?.message ?? error) });
      }
    });
    port.start();
    // Each launch opens a new conversation, as the terminal does; earlier ones wait in the sidebar.
    application.startNewSession?.("app_start");
    runtime.reset?.();
    send({ type: "ready", ...status(), sessions: sessions(), current: sessionId(), transcript: [] });
    void refreshPlayer();
    schedulePlayer();
  });
}
