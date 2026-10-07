// The room reads a few process fields; the page answers for a browser.
export const process = {
  env: {},
  platform: "browser",
  pid: 1,
  argv: [],
  versions: {},
  exitCode: undefined,
  cwd: () => "/",
  nextTick: (callback, ...args) => queueMicrotask(() => callback(...args)),
  on() { return this; },
  once() { return this; },
  off() { return this; },
  removeListener() { return this; },
  emit() { return false; },
};
globalThis.process ??= process;
globalThis.setImmediate ??= (callback, ...args) => setTimeout(callback, 0, ...args);
globalThis.clearImmediate ??= (handle) => clearTimeout(handle);
// pi-tui checks for Node Buffers on input; xterm.js only sends strings.
export const Buffer = { isBuffer: () => false };
