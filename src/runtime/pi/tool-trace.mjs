// A local record of the agent's tool calls: what the model asked for and what came back, one
// JSON line each, in a file per day under the listener's state directory. When playback goes
// wrong, this is what to read. It never leaves the machine. MOONDOG_TRACE=off turns it off.
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { resolveMoondogStateDirectory } from "../../core/state-directory.mjs";

const clip = (value, size) => {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return text.length > size ? `${text.slice(0, size)}…` : text;
};

export function createToolTrace(environment = process.env, { now = () => new Date() } = {}) {
  if (environment.MOONDOG_TRACE === "off") return null;
  let directory;
  try {
    directory = path.join(resolveMoondogStateDirectory(environment), "traces");
  } catch {
    return null;
  }
  let ready = null;
  let written = Promise.resolve();
  return {
    directory,
    // Calls are written in order; a failed write is dropped, never thrown into a turn.
    record({ args, result, ...entry }) {
      const at = now();
      const line = `${JSON.stringify({ at: at.toISOString(), ...entry,
        ...(args === undefined ? {} : { args: clip(args, 2_000) }),
        ...(result === undefined ? {} : { result: clip(result, 4_000) }) })}\n`;
      const file = path.join(directory, `${at.toISOString().slice(0, 10)}.jsonl`);
      ready ??= mkdir(directory, { recursive: true, mode: 0o700 });
      written = written.then(() => ready).then(() => appendFile(file, line, { mode: 0o600 })).catch(() => {});
      return written;
    },
  };
}
