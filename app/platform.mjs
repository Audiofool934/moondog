// Native chrome and keys stay with the host; the listening room is shared.
export function windowChrome(platform) {
  return platform === "darwin"
    ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 18, y: 15 } }
    : { autoHideMenuBar: true };
}

export function playbackAccelerators(platform) {
  const modifier = platform === "darwin" ? "Ctrl+Cmd" : "Ctrl+Alt+Shift";
  return { toggle: `${modifier}+P`, next: `${modifier}+Right`, previous: `${modifier}+Left` };
}

// macOS applications launched from Finder need their login shell's PATH. Windows and Linux
// inherit the desktop session's environment, including its own executable search rules.
export function needsLoginShell(platform, packaged) {
  return platform === "darwin" && packaged;
}
