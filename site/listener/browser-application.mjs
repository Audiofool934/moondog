// Answers the window's and the terminal's questions from the fictional snapshot, and keeps the
// visitor's conversations in this tab only. Everything else says plainly that it needs the app.
import { shortConversationTitle } from "../../src/memory/local-memory-store.mjs";

export const needsApp = (what) => Object.assign(new Error(`${what} needs Moondog itself. Download it from this page.`), { code: "needs_app" });

const now = () => new Date().toISOString();

export class BrowserApplication {
  constructor(snapshot, { locale = "en", playbackService = "spotify" } = {}) {
    this.snapshot = snapshot;
    this.locale = locale;
    this.conversationLocale = locale;
    this.playbackService = playbackService;
    this.pending = null;
    // Conversations live in this tab and go when it closes. A new one is listed after its first message.
    this.conversations = new Map();
    this.folders = new Map();
    this.sequence = 0;
    this.startNewSession();
  }

  profileServicesReady() { return true; }
  musicSimilarityReady() { return false; }
  spotifyReady() { return false; }
  spotifyStatus() {
    return { provider: "spotify", state: "not_configured", reason: "client_id_required", authentication: "not_configured", client_id_configured: false, external_effects: "disabled" };
  }
  async sourceStatus() { return this.snapshot.sourceStatus; }
  async getProfileSummary() { return structuredClone(this.snapshot.profileSummary); }
  async getLyricSeeds() { return { subjectId: null, tracks: [] }; }
  async explainProfileEvidence({ evidenceId }) {
    const explanation = this.snapshot.evidence[evidenceId];
    if (!explanation) throw new Error("That evidence isn't in this preview.");
    return structuredClone(explanation);
  }
  async runLocalCommand(command) {
    if (command in this.snapshot.localCommands) return structuredClone(this.snapshot.localCommands[command]);
    throw needsApp(`/${command}`);
  }

  // Conversations
  startNewSession() {
    const id = `tab-${(this.sequence += 1)}`;
    this.current = { id, title: "", customTitle: false, pinnedAt: null, folderId: null, startedAt: now(), updatedAt: now(), entries: [] };
    this.conversations.set(id, this.current);
    return { session_id: id };
  }
  ensureMemorySession() { return { session_id: this.current.id }; }
  resumeSession(id) {
    const conversation = this.conversations.get(id);
    if (!conversation) throw new Error("That conversation is gone.");
    this.current = conversation;
    return { session_id: id };
  }
  // The agent client saves each finished turn here, as the app's agent saves it to memory.
  recordTurn(userText, assistantText) {
    const conversation = this.current;
    conversation.entries.push({ entry_id: `${conversation.id}-${conversation.entries.length + 1}`, user_text: userText, assistant_text: assistantText });
    if (!conversation.title) conversation.title = shortConversationTitle(userText);
    conversation.updatedAt = now();
  }
  // Turns carry no saved entries, so neither the window nor the terminal offers to edit or branch a message:
  // the demo server can't rewind its side of a conversation.
  currentConversationTurns({ limit = 40 } = {}) {
    return this.current.entries.flatMap((entry) => [{ role: "user", text: entry.user_text },
      ...(entry.assistant_text ? [{ role: "assistant", text: entry.assistant_text }] : [])]).slice(-limit);
  }
  currentSessionTurns(options) { return this.currentConversationTurns(options); }
  conversationPending(pending) {
    if (pending === undefined) return this.pending;
    this.pending = pending;
    return pending;
  }
  listSavedSessions({ limit = 200 } = {}) {
    return [...this.conversations.values()].filter((conversation) => conversation.entries.length)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit)
      .map((conversation) => ({ session_id: conversation.id, title: conversation.title, custom_title: conversation.customTitle,
        started_at: conversation.startedAt, updated_at: conversation.updatedAt, pinned_at: conversation.pinnedAt, folder_id: conversation.folderId }));
  }
  labelSavedSession(id, patch = {}) {
    const conversation = this.conversations.get(id);
    if (!conversation) return;
    // A cleared name goes back to the first message.
    if (patch.title !== undefined) {
      const title = String(patch.title ?? "").trim();
      Object.assign(conversation, { title: title || shortConversationTitle(conversation.entries[0]?.user_text), customTitle: Boolean(title) });
    }
    if (patch.pinned !== undefined) conversation.pinnedAt = patch.pinned ? now() : null;
    if (patch.folderId !== undefined) conversation.folderId = this.folders.has(patch.folderId) ? patch.folderId : null;
  }
  deleteSavedSession(id) {
    this.conversations.delete(id);
    if (this.current.id !== id) return { started_new_session: false };
    this.startNewSession();
    return { started_new_session: true };
  }
  listConversationFolders() { return [...this.folders.values()]; }
  saveConversationFolder({ folderId, name }) {
    const folder = this.folders.get(folderId) ?? { folder_id: `folder-${(this.sequence += 1)}`, position: this.folders.size };
    folder.name = name || folder.name || "Folder";
    this.folders.set(folder.folder_id, folder);
    return folder;
  }
  deleteConversationFolder(id) {
    this.folders.delete(id);
    for (const conversation of this.conversations.values()) if (conversation.folderId === id) conversation.folderId = null;
  }
  rewindConversation() { throw needsApp("Editing a message"); }
  branchConversation() { throw needsApp("Branching a conversation"); }
  rememberMemory() { throw needsApp("Memory"); }
  forgetMemory() { throw needsApp("Memory"); }
}

export class PreviewRuntime {
  publicStatus() {
    return { state: "offline", adapter: "pi_agent_core", reason: "model_not_configured", session_persistence: "none", external_effects: "disabled" };
  }
  // Without the public agent a message still gets a plain answer, in the conversation where it was asked.
  async prompt(_text, callbacks = {}) {
    const text = "This copy of the page has no model to talk through. Moondog itself talks through the one you choose.";
    callbacks.onTextReplace?.(text);
    return { status: "completed", text };
  }
  abort() {}
  reset() {}
  restoreSession() {}
}
