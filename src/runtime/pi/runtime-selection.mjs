// Whether an agent built earlier is behind the saved choice: another model or effort, or an agent
// that could not answer then, which a sign-in since may let answer. Token refreshes rewrite
// auth.json often, so a working agent on the saved model is kept. Kept apart from the settings
// file, so the window code the project page runs in the browser can use it.
export function runtimeBehindSelection(status, selection) {
  if (status?.state !== "configured") return true;
  return status.provider !== selection?.provider || status.model !== selection?.model ||
    (status.effort ?? undefined) !== selection?.effort;
}
