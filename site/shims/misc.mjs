// child_process, module, url, perf_hooks, and timers/promises in one place.
import { unavailable } from "./unavailable.mjs";
export const spawn = unavailable("child_process.spawn");
export const execSync = unavailable("child_process.execSync");
export const execFile = unavailable("child_process.execFile");
export const createRequire = () => unavailable("require");
export const fileURLToPath = (value) => new URL(value).pathname;
export const pathToFileURL = (value) => new URL(`file://${value}`);
export const performance = globalThis.performance;
export const setTimeout = (ms, value) => new Promise((resolve) => globalThis.setTimeout(resolve, ms, value));
export default { spawn, execSync, execFile, createRequire, fileURLToPath, pathToFileURL, performance, setTimeout };
