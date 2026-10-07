// pi-tui's Terminal interface, drawn by xterm.js instead of a TTY.
import { StdinBuffer } from "@earendil-works/pi-tui";

export class XtermTerminal {
  constructor(xterm) {
    this.xterm = xterm;
    this.subscriptions = [];
  }

  get kittyProtocolActive() { return false; }
  get columns() { return this.xterm.cols; }
  get rows() { return this.xterm.rows; }

  start(onInput, onResize) {
    // Split xterm's input into whole key sequences, like the terminal app does with stdin.
    this.buffer = new StdinBuffer({ escapeTimeout: 10 });
    this.buffer.on("data", (sequence) => onInput(sequence));
    this.buffer.on("paste", (content) => onInput(`\x1b[200~${content}\x1b[201~`));
    this.subscriptions.push(
      this.xterm.onData((data) => this.buffer.process(data)),
      this.xterm.onResize(() => onResize()),
    );
    this.xterm.write("\x1b[?2004h");
  }

  stop() {
    this.xterm.write("\x1b[?2004l");
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
    this.buffer?.destroy?.();
    this.buffer = undefined;
  }

  async drainInput() {}
  write(data) { this.xterm.write(data); }
  moveBy(lines) {
    if (lines > 0) this.xterm.write(`\x1b[${lines}B`);
    else if (lines < 0) this.xterm.write(`\x1b[${-lines}A`);
  }
  hideCursor() { this.xterm.write("\x1b[?25l"); }
  showCursor() { this.xterm.write("\x1b[?25h"); }
  clearLine() { this.xterm.write("\x1b[K"); }
  clearFromCursor() { this.xterm.write("\x1b[J"); }
  clearScreen() { this.xterm.write("\x1b[2J\x1b[H"); }
  setTitle() {}
  setProgress() {}
}
