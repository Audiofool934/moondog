// The scene's Moondog. Each message gets the scene's next exchange: its steps run one by one, the last
// starts the songs in the Music app, and the reply is written at a reading pace. The window follows the
// steps through the agent's events and the words through the turn's callbacks, as it does in the app.
export class SceneAgent {
  constructor({ application, musicApp, clock, exchanges, model }) {
    Object.assign(this, { application, musicApp, clock, exchanges, model });
    this.turns = 0;
    this.calls = 0;
    this.waiting = [];
    const listeners = new Set();
    this.agent = { subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); } };
    this.emit = (event) => { for (const listener of listeners) listener(event); };
  }

  publicStatus() {
    return { state: "configured", adapter: "moondog_scene", provider: this.model.provider, model: this.model.model, effort_levels: [] };
  }

  // Resolves when the reply now being written, or the next one, is done.
  answered() { return new Promise((resolve) => this.waiting.push(resolve)); }

  async prompt(text, callbacks = {}) {
    const exchange = this.exchanges[this.turns % this.exchanges.length];
    this.turns += 1;
    for (const step of exchange.steps) {
      const toolCallId = `scene-${(this.calls += 1)}`;
      this.emit({ type: "tool_execution_start", toolCallId, toolName: step.tool, args: step.args ?? {} });
      await this.clock.wait(step.ms);
      if (step.plays) this.musicApp.play(exchange.songs);
      this.emit({ type: "tool_execution_end", toolCallId, toolName: step.tool, isError: false });
    }
    // A word or two at a time, with the small unevenness of a model writing.
    for (const piece of exchange.reply.match(/\S+\s*/gu)) {
      callbacks.onTextDelta?.(piece);
      await this.clock.wait(26 + Math.random() * 38 + (/[.:]\s/u.test(piece) ? 90 : 0));
    }
    this.application.recordTurn(text, exchange.reply);
    for (const resolve of this.waiting.splice(0)) resolve();
    // The song the reply started shows under it with its cover, as a played song does in the app.
    return { status: "completed", text: exchange.reply,
      spotify_write_receipts: [{ action: "playback.resume", state: "accepted",
        targets: [{ title: exchange.songs[0].title, artist_credit: exchange.songs[0].artists.join(", ") }] }] };
  }

  abort() {}
  reset() {}
  restoreSession() {}
}
