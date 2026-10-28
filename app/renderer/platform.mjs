// The browser scene keeps its Mac window; desktop hosts identify themselves through the preload.
export const platform = globalThis.window?.moondogApp?.platform ?? "darwin";
export const isMac = platform === "darwin";
export const primaryModifier = (event) => isMac ? event.metaKey : event.ctrlKey;
export const shortcuts = isMac
  ? { new: "⌘N", settings: "⌘,", stop: "⌘.", sidebar: "⌥⌘S", player: "⌥⌘P", play: "⌃⌘P", next: "⌃⌘→", previous: "⌃⌘←" }
  : { new: "Ctrl+N", settings: "Ctrl+,", stop: "Ctrl+.", sidebar: "Ctrl+Alt+S", player: "Ctrl+Alt+P",
    play: "Ctrl+Alt+Shift+P", next: "Ctrl+Alt+Shift+→", previous: "Ctrl+Alt+Shift+←" };
