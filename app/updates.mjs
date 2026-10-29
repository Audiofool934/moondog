// Moondog keeps itself current from the GitHub releases of Audiofool934/moondog. It looks
// at launch and every six hours and shows a newer build at the top right, but downloads nothing
// until the listener asks: one click downloads it and restarts into it when the download ends.
// macOS takes only a build signed by the same developer, and the download must match the checksum
// its release lists. A beta version follows the releases GitHub marks as prereleases; a stable one,
// only the others.

const EVERY_MS = 6 * 60 * 60_000;

/**
 * What the window and the menu show: { phase: "idle" }, { phase: "available", version },
 * { phase: "downloading", version, progress } with progress from 0 to 1, or { phase: "ready", version }.
 * installing is true once the listener asked. onRestart runs just before the updater closes the windows to
 * install, and only then. autoUpdater is electron-updater's, or null when the app is not packaged;
 * squirrel is Electron's own autoUpdater, which receives the restart event on every platform.
 * restart installs the downloaded build: quitAndInstall by default, as macOS does; Windows and Linux
 * quit first and install as the app exits (lifecycle.mjs).
 */
export function createUpdates({ autoUpdater, squirrel, onChange, onRestart, restart = () => autoUpdater.quitAndInstall() }) {
  let state = { phase: "idle" };
  let installing = false;
  const set = (next) => {
    state = next;
    onChange({ ...state, installing });
  };
  // Development builds never update; main.mjs makes the updater only for a packaged app.
  const enabled = Boolean(autoUpdater);
  if (enabled) {
    // A newer build is the listener's to fetch: a 150 MB download and a restart should not start unasked.
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    // Trying an update before it is published: MOONDOG_UPDATE_FEED names a folder served over HTTP
    // that holds a newer build's zip and its latest-mac.yml. That install quits without relaunching,
    // because the relaunched app has none of the test's settings and would open the listener's profile.
    const feed = process.env.MOONDOG_UPDATE_FEED;
    if (feed) {
      autoUpdater.setFeedURL({ provider: "generic", url: feed });
      autoUpdater.autoRunAppAfterInstall = false;
    }
    autoUpdater.on("update-available", ({ version }) => {
      if (state.phase === "idle" || state.phase === "available") set({ phase: "available", version });
    });
    autoUpdater.on("download-progress", ({ percent }) => {
      if (state.phase === "downloading") set({ ...state, progress: Math.max(0, Math.min(1, percent / 100)) });
    });
    autoUpdater.on("update-downloaded", ({ version }) => {
      set({ phase: "ready", version });
      // The listener asked for it, so restart as soon as the updater has the build.
      if (installing) restart();
    });
    // A failed check changes nothing. A failed download, or macOS's own check of it, leaves the
    // installed app as it is and the newer build offered again, so another click tries again.
    autoUpdater.on("error", (error) => {
      process.stderr.write(`[update] ${error?.message ?? error}\n`);
      if (state.phase === "idle" || state.phase === "available") return;
      installing = false;
      set({ phase: "available", version: state.version });
    });
    // quitAndInstall emits this on Electron's autoUpdater as it closes the windows to install.
    squirrel?.on("before-quit-for-update", () => onRestart());
  }

  // "available", "current" or "failed". A check while one is downloading or ready changes nothing;
  // one while a build is offered can find a newer one.
  async function check() {
    if (!enabled) return "failed";
    if (state.phase === "downloading" || state.phase === "ready") return "available";
    try {
      const result = await autoUpdater.checkForUpdates();
      return result?.isUpdateAvailable ? "available" : "current";
    } catch { return "failed"; }
  }

  // Downloads the offered build and restarts into it when the download ends, or restarts at once
  // into one already downloaded. The app then quits as it always does, so the core stops its
  // replies and saves each conversation before Squirrel installs.
  function install() {
    if (!enabled || state.phase === "idle" || installing) return;
    installing = true;
    if (state.phase === "ready") {
      set(state);
      restart();
      return;
    }
    if (state.phase === "available") set({ phase: "downloading", version: state.version, progress: 0 });
    else set(state);
    // A failed download reaches the error handler above.
    autoUpdater.downloadUpdate().catch(() => {});
  }

  function start() {
    if (!enabled) return;
    void check();
    setInterval(() => void check(), EVERY_MS);
  }

  return { enabled, state: () => ({ ...state, installing }), check, install, start };
}
