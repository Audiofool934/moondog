// Both a normal quit and an updater quit must give the core time to save conversations.
// The window remains alive until that finishes on Windows and Linux too.
export function createQuitHandler({ getCore, stopMusic, willQuit, quit, timeoutMs = 5000 }) {
  let stopping = false;
  return (event) => {
    willQuit();
    stopMusic();
    const running = getCore();
    if (!running) return;
    event.preventDefault();
    if (stopping) return;
    stopping = true;
    const timer = setTimeout(() => running.kill(), timeoutMs);
    running.once("exit", () => {
      clearTimeout(timer);
      quit();
    });
    running.postMessage({ type: "quit" });
  };
}
