// Runs the real listening room, the same code as the `moondog` command, in its own Node process.
// The window draws it: output, keys, and size travel over a message port, and so do the
// previews the agent plays.
import { createWindowPreviewPlayer } from "./preview-player.mjs";
import { WindowTerminal } from "./window-terminal.mjs";

const port = await new Promise((resolve) => {
  process.parentPort.once("message", ({ ports: [roomPort] }) => resolve(roomPort));
});

// The room starts once the window has measured itself.
const terminal = await new Promise((resolve) => {
  let screen = null;
  port.on("message", ({ data }) => {
    if (data?.type === "input") screen?.input(String(data.data ?? ""));
    if (data?.type === "resize") {
      const cols = Math.max(20, Number(data.cols) || 80);
      const rows = Math.max(8, Number(data.rows) || 24);
      if (screen) screen.resize(cols, rows);
      else {
        resolve(screen = new WindowTerminal({ cols, rows }, {
          send: (output) => port.postMessage({ type: "output", data: output }),
          notify: (message) => process.parentPort.postMessage(message),
        }));
      }
    }
  });
  port.start();
});

globalThis[Symbol.for("moondog.host")] = {
  terminal,
  // Sign-in prompts read and write here while the room steps aside.
  terminalStreams: terminal.streams,
  // The port would keep this process alive after the room closes.
  closed: () => {
    port.close();
    process.exit(process.exitCode ?? 0);
  },
  // The agent's previews play in the window's player, next to links to the full songs.
  musicPreviewPlayer: createWindowPreviewPlayer(port),
};

// The room is the `moondog` command with no arguments.
process.argv.splice(2);
await import("../scripts/moondog.mjs");
