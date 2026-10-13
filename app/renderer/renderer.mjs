// The window's page: the real room drawn by xterm.js, and a player for the previews the agent picks.
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { createPreviewPlayer } from "../../site/room/preview-player.mjs";
import { attachBlocks, renderSeasons } from "./blocks.mjs";
import "./style.css";

// The room's own paper and charcoal colors, from src/surfaces/cli/brand-theme.mjs.
const PALETTES = {
  paper: { background: "#f4f4f4", foreground: "#141414", cursor: "#141414", cursorAccent: "#f4f4f4", selectionBackground: "#14141433" },
  charcoal: { background: "#0c0c0c", foreground: "#e4e4e4", cursor: "#e4e4e4", cursorAccent: "#0c0c0c", selectionBackground: "#e4e4e433" },
};

const dark = matchMedia("(prefers-color-scheme: dark)").matches;
const container = document.querySelector("[data-room]");
const xterm = new Terminal({
  fontFamily: '"SF Mono", Menlo, "DejaVu Sans Mono", monospace',
  fontSize: 13,
  lineHeight: 1,
  scrollback: 0,
  cursorBlink: true,
  theme: PALETTES[dark ? "charcoal" : "paper"],
  // OSC 8 links open in the browser; the main process refuses everything but https.
  linkHandler: { activate: (_event, uri) => window.open(uri) },
});
const fit = new FitAddon();
xterm.loadAddon(fit);
xterm.open(container);
fit.fit();
// Room components that mark their cells get graphics painted over them.
attachBlocks(xterm, { seasons: renderSeasons });

const player = createPreviewPlayer(document.querySelector("[data-player]"));

// The main process sends the port that reaches the room process.
const port = await new Promise((resolve) => {
  window.addEventListener("message", function receive(event) {
    if (event.source !== window || event.data !== "moondog-room") return;
    window.removeEventListener("message", receive);
    resolve(event.ports[0]);
  });
});

port.onmessage = ({ data }) => {
  if (data?.type === "output") xterm.write(data.data);
  if (data?.type === "preview") player.play(data.tracks, data.album);
};
xterm.onData((data) => port.postMessage({ type: "input", data }));
const sendSize = () => port.postMessage({ type: "resize", cols: xterm.cols, rows: xterm.rows });
xterm.onResize(sendSize);
// The player takes room from the bottom when it appears, so the room refits.
new ResizeObserver(() => fit.fit()).observe(container);
sendSize();

// A dropped file types its path into the room, as in a terminal: `/import ` and then a drop.
const quote = (path) => (/^[\w./~-]+$/u.test(path) ? path : `"${path.replaceAll('"', '\\"')}"`);
window.addEventListener("dragover", (event) => event.preventDefault());
window.addEventListener("drop", (event) => {
  event.preventDefault();
  const paths = [...(event.dataTransfer?.files ?? [])].map((file) => window.moondogApp?.pathForFile(file)).filter(Boolean);
  if (!paths.length) return;
  port.postMessage({ type: "input", data: `\x1b[200~${paths.map(quote).join(" ")}\x1b[201~` });
  xterm.focus();
});

xterm.focus();
window.addEventListener("focus", () => xterm.focus());
