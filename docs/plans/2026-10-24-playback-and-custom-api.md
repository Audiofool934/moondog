# Direct NetEase playback and custom model endpoint

Goal: play playlist songs inside the desktop app with the existing NetEase account, and configure a private OpenAI-compatible model endpoint without modifying source or using ncm-cli.

1. Add authenticated song URL lookup and catalog search to the shared NetEase library. Preserve service membership/copyright restrictions and label trials. Use a core-owned queue with lazy URL resolution so signed URLs do not expire while waiting.
2. Connect a native HTML Audio transport to that queue through the existing private message port. Confirm actual playback events before reporting success, handle pause/seek/end/error and discard events from replaced queues. Stop and invalidate playback on sign-out.
3. Add play-all and per-track play controls to the existing playlist view. Reuse the existing global now-playing panel and controls. Keep the terminal's optional external player separate.
4. Add a locally persisted custom endpoint (base URL, API key, model ID, protocol, context/output limits) and register it with Pi's existing provider infrastructure. Support Chat Completions, Responses and Anthropic Messages. Never return saved keys to the renderer; blank key preserves an existing key only for the same endpoint. Provide explicit connection testing.
5. Run focused tests against fictional music and a local fake model gateway, including real streaming chat and audio playback in Electron. Build the renderer, document results and commit the scoped local changes.

The chosen approach extends the existing core and renderer. An external playback daemon would retain the extra setup the user wants removed; a separate browser music product would duplicate existing app behavior.
