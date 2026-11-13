// What differs between the operating systems the core runs on: the environment's PATH key and
// how a link opens in the listener's browser.
import { spawn } from "node:child_process";

/** Windows spells the PATH variable as it likes (often "Path"); the others use PATH. */
export function environmentPathKey(environment) {
  return Object.keys(environment).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
}

/** Opens a link in the default browser, and resolves once the opener has started. */
export function openInDefaultBrowser(url, platform = process.platform) {
  const [command, args] =
    platform === "darwin"
      ? ["open", [url]]
      : platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
