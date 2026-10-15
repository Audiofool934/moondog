// Runs the real listening room, the same code as the `moondog` command, in its own Node process.
// The window draws it: output, keys, and size travel over a message port, and so do the
// previews the agent plays.
import { StdinBuffer } from "@earendil-works/pi-tui";
import { createWindowPreviewPlayer } from "./preview-player.mjs";

const port = await new Promise((resolve) => {
  process.parentPort.once("message", ({ ports: [roomPort] }) => resolve(roomPort));
});

// pi-tui's Terminal interface, drawn by xterm.js in the window instead of a TTY.
class WindowTerminal {
  constructor(size) {
    this.size = size;
    this.buffer = undefined;
    this.onResize = undefined;
  }

  get kittyProtocolActive() { return false; }
  get columns() { return this.size.cols; }
  get rows() { return this.size.rows; }

  start(onInput, onResize) {
    // Split the window's input into whole key sequences, like the terminal app does with stdin.
    this.buffer = new StdinBuffer({ escapeTimeout: 10 });
    this.buffer.on("data", (sequence) => onInput(sequence));
    this.buffer.on("paste", (content) => onInput(`\x1b[200~${content}\x1b[201~`));
    this.onResize = onResize;
    this.write("\x1b[?2004h");
  }

  stop() {
    this.write("\x1b[?2004l");
    this.buffer?.destroy?.();
    this.buffer = undefined;
    this.onResize = undefined;
  }

  input(data) { this.buffer?.process(data); }
  resize(cols, rows) {
    this.size = { cols, rows };
    this.onResize?.();
  }

  async drainInput() {}
  write(data) { port.postMessage({ type: "output", data }); }
  moveBy(lines) {
    if (lines > 0) this.write(`\x1b[${lines}B`);
    else if (lines < 0) this.write(`\x1b[${-lines}A`);
  }
  hideCursor() { this.write("\x1b[?25l"); }
  showCursor() { this.write("\x1b[?25h"); }
  clearLine() { this.write("\x1b[K"); }
  clearFromCursor() { this.write("\x1b[J"); }
  clearScreen() { this.write("\x1b[2J\x1b[H"); }
  setTitle(title) { process.parentPort.postMessage({ type: "title", title: String(title ?? "") }); }
  setProgress(active) { process.parentPort.postMessage({ type: "progress", active: Boolean(active) }); }
}

// The room starts once the window has measured itself.
const terminal = await new Promise((resolve) => {
  let screen = null;
  port.on("message", ({ data }) => {
    if (data?.type === "input") screen?.input(String(data.data ?? ""));
    if (data?.type === "resize") {
      const cols = Math.max(20, Number(data.cols) || 80);
      const rows = Math.max(8, Number(data.rows) || 24);
      if (screen) screen.resize(cols, rows);
      else resolve(screen = new WindowTerminal({ cols, rows }));
    }
  });
  port.start();
});

globalThis[Symbol.for("moondog.host")] = {
  terminal,
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
