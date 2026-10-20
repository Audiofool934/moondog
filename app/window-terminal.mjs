// pi-tui's Terminal interface, drawn by xterm.js in the window instead of a TTY.
import { PassThrough, Writable } from "node:stream";
import { StdinBuffer } from "@earendil-works/pi-tui";

export class WindowTerminal {
  // `send` writes to the window; `notify` reaches the main process (title, Dock progress).
  constructor(size, { send, notify, signalTarget = process }) {
    this.size = size;
    this.send = send;
    this.notify = notify;
    this.signalTarget = signalTarget;
    this.buffer = undefined;
    this.onResize = undefined;
    this.asideStarted = false;
    // While the room steps aside for a sign-in, the window is a plain terminal, as in
    // `moondog`: typing goes to the prompt, and Ctrl+C is SIGINT, which cancels it.
    this.streams = { input: new PassThrough(), output: this.createOutput() };
    this.streams.input.isTTY = true;
  }

  createOutput() {
    const terminal = this;
    // A TTY turns each newline into a carriage return and a newline; xterm.js does not.
    const output = new Writable({
      write(chunk, encoding, callback) {
        // A window has no shell history above the prompt, so each sign-in starts on a clean screen.
        const clear = terminal.asideStarted || terminal.buffer ? "" : "\x1b[2J\x1b[H";
        terminal.asideStarted = true;
        terminal.write(clear + String(chunk).replace(/\r?\n/gu, "\r\n"));
        callback();
      },
    });
    output.isTTY = true;
    Object.defineProperties(output, {
      columns: { get: () => terminal.columns },
      rows: { get: () => terminal.rows },
    });
    return output;
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
    this.asideStarted = false;
  }

  input(data) {
    if (this.buffer) return this.buffer.process(data);
    if (data.includes("\x03")) return this.signalTarget.emit("SIGINT");
    // Keys typed with no prompt waiting are dropped, so they can't answer a later one.
    if (this.streams.input.listenerCount("keypress") > 0) this.streams.input.write(data);
  }

  resize(cols, rows) {
    this.size = { cols, rows };
    this.onResize?.();
    this.streams.output.emit("resize");
  }

  async drainInput() {}
  write(data) { this.send(data); }
  moveBy(lines) {
    if (lines > 0) this.write(`\x1b[${lines}B`);
    else if (lines < 0) this.write(`\x1b[${-lines}A`);
  }
  hideCursor() { this.write("\x1b[?25l"); }
  showCursor() { this.write("\x1b[?25h"); }
  clearLine() { this.write("\x1b[K"); }
  clearFromCursor() { this.write("\x1b[J"); }
  clearScreen() { this.write("\x1b[2J\x1b[H"); }
  setTitle(title) { this.notify({ type: "title", title: String(title ?? "") }); }
  setProgress(active) { this.notify({ type: "progress", active: Boolean(active) }); }
}
