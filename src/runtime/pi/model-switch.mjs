// A model the listener asks the agent for in words ("switch to DeepSeek Pro"). The agent cannot
// replace itself mid-reply, so the request goes to the surface that runs it, which switches once
// the reply ends: the window as with its model menu, the terminal as with /model.

/** The listener's model menu, and requests from each conversation's agent to the surfaces. */
export function createModelSwitch({ list } = {}) {
  const listeners = new Set();
  return {
    // The models the listener set up, as the window's menu lists them, with whether each can answer.
    async choices() {
      const result = await list?.();
      return (Array.isArray(result?.models) ? result.models : []).map((entry) => ({
        model: `${entry.provider}/${entry.model}`, name: entry.name ?? entry.model, ready: entry.ready === true,
      }));
    },
    request(application, selection) {
      for (const listener of listeners) {
        try { listener({ application, selection }); } catch { /* A surface that fails keeps its model. */ }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
