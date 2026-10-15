// Hands the page the message port that connects it to the room process, and the path
// of a file dropped on the window (pages can't read paths on their own).
const { contextBridge, ipcRenderer, webUtils } = require("electron");

ipcRenderer.once("room", (event) => window.postMessage("moondog-room", "*", event.ports));
contextBridge.exposeInMainWorld("moondogApp", { pathForFile: (file) => webUtils.getPathForFile(file) });
