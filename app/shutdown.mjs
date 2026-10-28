// Every installer must wait for the old core to exit before it can start a new one.
// Reuse the same shutdown for a menu quit and an update arriving during that quit.
export function createCoreShutdown({ getCore, stopMusic, timeoutMs = 5000 }) {
  let pending;
  return function shutdown() {
    if (pending) return pending;
    stopMusic();
    const running = getCore();
    if (!running) return Promise.resolve();
    pending = new Promise((resolve, reject) => {
      let killTimer;
      let settled = false;
      const done = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(killTimer);
        running.removeListener("exit", exited);
        if (error) reject(error); else resolve();
      };
      const exited = () => done();
      const timer = setTimeout(() => {
        // The existing quit path bounds a stalled core. Still wait for its exit;
        // an installer must never run alongside the process we asked to stop.
        try {
          if (running.kill() === false) return done(new Error("The previous core could not be stopped."));
          if (!settled) killTimer = setTimeout(() => done(new Error("The previous core has not exited.")), timeoutMs);
        } catch (error) { done(error); }
      }, timeoutMs);
      running.once("exit", exited);
      try { running.postMessage({ type: "quit" }); } catch (error) { done(error); }
    }).catch((error) => { pending = null; throw error; });
    return pending;
  };
}
