// Moondog for Mac keeps itself current from the GitHub releases of Audiofool934/moondog. It looks
// at launch and every six hours, downloads a newer build in the background, and installs it when
// the app quits, or at once when the listener asks. macOS takes only a build signed by the same
// developer, and the download must match the checksum its release lists. A beta version follows the
// releases GitHub marks as prereleases; a stable one, only the others.
import { autoUpdater as squirrel } from "electron";
import electronUpdater from "electron-updater";

const EVERY_MS = 6 * 60 * 60_000;

/**
 * What the window and the menu show: { phase: "idle" }, { phase: "downloading", version, progress }
 * with progress from 0 to 1, or { phase: "ready", version }. installing is true once the listener asked.
 * onRestart runs just before macOS closes the windows to install, and only then.
 */
export function createUpdates({ app, onChange, onRestart }) {
  let state = { phase: "idle" };
  let installing = false;
  const set = (next) => {
    state = next;
    onChange({ ...state, installing });
  };
  const enabled = app.isPackaged;
  // Development builds never update; the updater is made only for a packaged app.
  const autoUpdater = enabled ? electronUpdater.autoUpdater : null;
  if (enabled) {
    // Trying an update before it is published: MOONDOG_UPDATE_FEED names a folder served over HTTP
    // that holds a newer build's zip and its latest-mac.yml.
    const feed = process.env.MOONDOG_UPDATE_FEED;
    if (feed) autoUpdater.setFeedURL({ provider: "generic", url: feed });
    autoUpdater.on("update-available", ({ version }) => set({ phase: "downloading", version, progress: 0 }));
    autoUpdater.on("download-progress", ({ percent }) => {
      if (state.phase === "downloading") set({ ...state, progress: Math.max(0, Math.min(1, percent / 100)) });
    });
    autoUpdater.on("update-downloaded", ({ version }) => set({ phase: "ready", version }));
    // A download, or macOS's own check of it, that fails leaves the installed app as it is and the
    // button goes; the next check tries again. Checks run only while nothing is on its way.
    autoUpdater.on("error", (error) => {
      process.stderr.write(`[update] ${error?.message ?? error}\n`);
      if (state.phase === "idle") return;
      installing = false;
      set({ phase: "idle" });
    });
    squirrel.on("before-quit-for-update", () => onRestart());
  }

  // "available", "current" or "failed". A check while one is downloading or ready changes nothing.
  async function check() {
    if (!enabled) return "failed";
    if (state.phase !== "idle") return "available";
    try {
      const result = await autoUpdater.checkForUpdates();
      return result?.isUpdateAvailable ? "available" : "current";
    } catch { return "failed"; }
  }

  // Restarts into the new version now, or the moment its download finishes. The app then quits as
  // it always does, so the core stops its replies and saves each conversation before Squirrel installs.
  function install() {
    if (!enabled || state.phase === "idle" || installing) return;
    installing = true;
    set(state);
    autoUpdater.quitAndInstall();
  }

  function start() {
    if (!enabled) return;
    void check();
    setInterval(() => void check(), EVERY_MS);
  }

  return { enabled, state: () => ({ ...state, installing }), check, install, start };
}
