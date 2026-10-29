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

// Windows and Linux install a downloaded update once the app has quit as usual, so the core has
// saved first: the NSIS installer stops a running Moondog within seconds, and the AppImage updater
// would start the new build at once. Called as the app quits (will-quit). Linux leaves the relaunch
// to Electron, which starts the new build only after this process exits, so the new one finds no
// Moondog still running.
export function installDownloadedUpdate({ updater, platform, relaunch, appImage }) {
  let file = appImage;
  const renamed = (next) => { file = next; };
  updater.once("appimage-filename-updated", renamed);
  const restart = updater.autoRunAppAfterInstall !== false;
  // Silent: the listener already asked, and the installer has no choices to offer.
  const installed = updater.install(true, platform === "win32" && restart);
  updater.removeListener("appimage-filename-updated", renamed);
  if (!restart) return;
  if (platform === "linux") relaunch({ execPath: file, args: [] });
  // A failed install leaves the installed app as it is, and opens it again.
  else if (!installed) relaunch();
}
