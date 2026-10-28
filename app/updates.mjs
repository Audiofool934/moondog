// Moondog for Mac keeps itself current from the GitHub releases of Audiofool934/moondog. It looks
// at launch and every six hours and shows a newer build at the top right, but downloads nothing
// until the listener asks: one click downloads it and restarts after macOS validates the build.
// macOS takes only a build signed by the same developer, and the download must match the checksum
// its release lists. A beta version follows the releases GitHub marks as prereleases; a stable one,
// only the others.

const EVERY_MS = 6 * 60 * 60_000;

/**
 * What the window and the menu show: { phase: "idle" }, { phase: "available", version },
 * { phase: "downloading", version, progress } with progress from 0 to 1, or { phase: "ready", version }.
 * installing is true once the listener asked. beforeInstall drains the old core before any installer
 * can start the new app. onRestart runs just before macOS closes the windows to
 * install, and only then. autoUpdater is electron-updater's, or null when the app is not packaged;
 * squirrel is Electron's own autoUpdater, which installs the download.
 */
export function createUpdates({ autoUpdater, squirrel, onChange, onRestart, beforeInstall = () => {}, platform = process.platform }) {
  let state = { phase: "idle" };
  let installing = false;
  let preparing = false;
  let nativeReady = false;
  let nativeDownloaded;
  const set = (next) => {
    state = next;
    onChange({ ...state, installing });
  };
  // Development builds never update; main.mjs makes the updater only for a packaged app.
  const enabled = Boolean(autoUpdater);
  function downloadFailed(error) {
    process.stderr.write(`[update] ${error?.message ?? error}\n`);
    if (nativeDownloaded) squirrel?.removeListener("update-downloaded", nativeDownloaded);
    nativeDownloaded = null;
    nativeReady = false;
    if (state.phase === "idle" || state.phase === "available") return;
    installing = false;
    set({ phase: "available", version: state.version });
  }
  async function restart() {
    if (preparing) return;
    preparing = true;
    try {
      await beforeInstall();
      autoUpdater.quitAndInstall();
    } catch (error) {
      process.stderr.write(`[update] ${error?.message ?? error}\n`);
      installing = false;
      set({ phase: "ready", version: state.version });
    } finally { preparing = false; }
  }
  function prepareInstall() {
    if (platform !== "darwin" || nativeReady) {
      void restart();
      return;
    }
    if (nativeDownloaded) return;
    // MacUpdater's event only means the ZIP is ready at its local proxy. With automatic
    // installation disabled, explicitly ask Squirrel to fetch and validate it first.
    // Calling MacUpdater.quitAndInstall here would add an unremovable install listener
    // and shut down the core before an asynchronous signature error can arrive.
    const version = state.version;
    set({ phase: "downloading", version, progress: 1 });
    nativeDownloaded = () => {
      nativeDownloaded = null;
      nativeReady = true;
      set({ phase: "ready", version });
      if (installing) void restart();
    };
    try {
      squirrel.once("update-downloaded", nativeDownloaded);
      squirrel.checkForUpdates();
    } catch (error) { downloadFailed(error); }
  }
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
      if (installing) prepareInstall();
    });
    // A failed check changes nothing. A failed download, or macOS's own check of it, leaves the
    // installed app as it is and the newer build offered again, so another click tries again.
    // MacUpdater forwards native Squirrel errors to this event too.
    autoUpdater.on("error", downloadFailed);
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

  // Download and validate the offered build, then save each conversation and stop the core
  // before the installer can start the new app. A failed shutdown can retry the staged build.
  function install() {
    if (!enabled || state.phase === "idle" || installing) return;
    installing = true;
    if (state.phase === "ready") {
      set(state);
      prepareInstall();
      return;
    }
    nativeReady = false;
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
