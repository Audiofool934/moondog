// Windows and Linux install a downloaded update after beforeInstall has stopped the core, and the
// app then quits. Linux leaves the relaunch to Electron, which starts the new build only after this
// process exits: the AppImage updater would start it at once, and the new one would find this
// Moondog still holding the single-instance lock and close.
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
  // A failed install leaves the installed app as it is. Its core has stopped, so open it again.
  else if (!installed) relaunch();
}
