// Answers the room's questions from the fictional snapshot.
// Everything else says plainly that it needs the installed app.
const needsApp = (what) => new Error(`${what} needs the installed app. This page is a preview with fictional data.`);

export class BrowserApplication {
  constructor(snapshot) {
    this.snapshot = snapshot;
    this.locale = "en";
    this.turns = [];
    this.pending = null;
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

  // Conversation memory lives only in this tab.
  startNewSession() { this.turns = []; }
  ensureMemorySession() { return { session_id: "browser-preview" }; }
  currentSessionTurns() { return [...this.turns]; }
  currentConversationTurns() { return [...this.turns]; }
  conversationEntries() { return []; }
  conversationPending(pending) {
    if (pending === undefined) return this.pending;
    this.pending = pending;
    return pending;
  }
  listSavedSessions() { return []; }
  resumeSession() { throw needsApp("Saved conversations"); }
  rewindConversation() { throw needsApp("Rewind"); }
  rememberMemory() { throw needsApp("Memory"); }
  forgetMemory() { throw needsApp("Memory"); }
}

export class PreviewRuntime {
  publicStatus() {
    return { state: "offline", adapter: "pi_agent_core", pi_version: "1.0.1", reason: "model_not_configured", session_persistence: "none", external_effects: "disabled" };
  }
  async prompt() { throw needsApp("Talking with a model"); }
  abort() {}
  reset() {}
  restoreSession() {}
  rewindTo() {}
}
