import { app, BrowserWindow } from "electron";
import { openNeteaseLogin } from "./netease-login.mjs";

await app.whenReady();
try {
  const cookie = await openNeteaseLogin({ BrowserWindow });
  // Private pipe to the calling core; this output is never forwarded to the terminal.
  process.stdout.write(`${JSON.stringify({ cookie })}\n`);
} catch { process.exitCode = 1; }
app.quit();
