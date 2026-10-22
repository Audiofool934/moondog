// Hands the page the message port that connects it to the core process, the menu's commands,
// and a way to tell the menu which language the core speaks.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

ipcRenderer.once("room", (event) => window.postMessage("moondog-room", "*", event.ports));
contextBridge.exposeInMainWorld("moondogApp", {
  pathForFile: (file) => webUtils.getPathForFile(file),
  onCommand: (callback) => ipcRenderer.on("command", (_event, name) => callback(String(name))),
  setLanguage: (locale) => ipcRenderer.send("language", String(locale)),
  setBusy: (busy) => ipcRenderer.send("busy", busy === true),
  setPlayback: (playback) => ipcRenderer.send("playback", { controllable: playback?.controllable === true, streaming: playback?.streaming === true }),
  showMenu: (items, at) => ipcRenderer.invoke("menu", { items, ...(at ?? {}) }),
  confirm: (options) => ipcRenderer.invoke("confirm", options),
  chooseFile: (options) => ipcRenderer.invoke("choose-file", options),
  version: () => ipcRenderer.invoke("version"),
  // Whole Apple Music songs through the app's MusicKit helper, where this Mac allows them.
  appleMusic: (command) => ipcRenderer.invoke("apple-music", command),
  onAppleMusic: (callback) => ipcRenderer.on("apple-music", (_event, message) => callback(message)),
});
