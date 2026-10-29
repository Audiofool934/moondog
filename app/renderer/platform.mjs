import { accelerators, keyLabel } from "../platform.mjs";

// The browser scene keeps its Mac window; desktop hosts identify themselves through the preload.
export const platform = globalThis.window?.moondogApp?.platform ?? "darwin";
export const isMac = platform === "darwin";
export const primaryModifier = (event) => isMac ? event.metaKey : event.ctrlKey;
// The labels read the same keys the menu uses (app/platform.mjs).
export const shortcuts = Object.fromEntries(Object.entries(accelerators(platform)).map(([name, keys]) => [name, keyLabel(keys, platform)]));
