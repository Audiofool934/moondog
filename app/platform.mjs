// Native chrome and keys stay with the host; the listening room is shared.
export function windowChrome(platform) {
  return platform === "darwin"
    ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 18, y: 15 } }
    : { autoHideMenuBar: true };
}

// The menu's keys, which the window's labels read too. Every menu key is live while the listener
// types, so none may type a character or edit text. Windows and Linux use Control with Shift for the
// window and Alt with Shift for playback: Control with Alt is AltGr on many Windows keyboards, and
// GNOME moves windows between workspaces with Control, Alt, Shift and an arrow.
export function accelerators(platform) {
  const mac = platform === "darwin";
  return {
    new: "CmdOrCtrl+N", settings: "CmdOrCtrl+,", stop: "CmdOrCtrl+.",
    sidebar: mac ? "CmdOrCtrl+Alt+S" : "Ctrl+Shift+S",
    player: mac ? "CmdOrCtrl+Alt+P" : "Ctrl+Shift+P",
    record: mac ? "CmdOrCtrl+Alt+R" : "Ctrl+Shift+R",
    play: mac ? "Ctrl+Cmd+P" : "Alt+Shift+P",
    next: mac ? "Ctrl+Cmd+Right" : "Alt+Shift+Right",
    previous: mac ? "Ctrl+Cmd+Left" : "Alt+Shift+Left",
  };
}

// How a key reads in the window: macOS's symbols in its own order, and the others spelled out.
export function keyLabel(accelerator, platform) {
  const parts = accelerator.split("+");
  const key = { Right: "→", Left: "←" }[parts.at(-1)] ?? parts.at(-1);
  const has = (...names) => parts.slice(0, -1).some((part) => names.includes(part));
  if (platform === "darwin") return `${has("Ctrl") ? "⌃" : ""}${has("Alt") ? "⌥" : ""}${has("Shift") ? "⇧" : ""}${has("Cmd", "CmdOrCtrl") ? "⌘" : ""}${key}`;
  return [...(has("Ctrl", "CmdOrCtrl") ? ["Ctrl"] : []), ...(has("Alt") ? ["Alt"] : []), ...(has("Shift") ? ["Shift"] : []), key].join("+");
}

// macOS applications launched from Finder need their login shell's PATH. Windows and Linux
// inherit the desktop session's environment, including its own executable search rules.
export function needsLoginShell(platform, packaged) {
  return platform === "darwin" && packaged;
}
