import { homedir } from "node:os";
import path from "node:path";

/** The one directory that holds a listener's private Moondog state. */
export function resolveMoondogStateDirectory(environment = process.env) {
  for (const name of ["MOONDOG_STATE_HOME", "MOONDOG_CONFIG_HOME"]) {
    const configured = environment[name]?.trim();
    if (!configured) continue;
    if (!path.isAbsolute(configured)) {
      throw new TypeError(`${name} must be an absolute path`);
    }
    return path.resolve(configured);
  }
  const xdgState = environment.XDG_STATE_HOME?.trim();
  if (xdgState && path.isAbsolute(xdgState)) {
    return path.join(path.resolve(xdgState), "moondog");
  }
  return path.join(homedir(), ".local", "state", "moondog");
}
