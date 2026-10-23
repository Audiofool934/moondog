import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export function desktopNeteaseLogin({ signal } = {}) {
  const require = createRequire(new URL("../../../app/package.json", import.meta.url));
  let electron;
  try { electron = require("electron"); }
  catch { throw new Error("Install the desktop dependencies first: cd app && npm ci"); }
  const entry = fileURLToPath(new URL("../../../app/netease-login-runner.mjs", import.meta.url));
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electron, [entry], { env, windowsHide: true, stdio: ["ignore", "pipe", "ignore"], signal });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; if (output.length > 32_768) child.kill(); });
    child.once("error", () => reject(new Error("Could not open NetEase sign-in. Check the desktop installation.")));
    child.once("exit", (code) => {
      if (signal?.aborted) return resolve(null);
      try { if (code !== 0) throw new Error(); resolve(JSON.parse(output.trim()).cookie ?? null); }
      catch { reject(new Error("NetEase sign-in did not finish. Please try again.")); }
    });
  });
}
