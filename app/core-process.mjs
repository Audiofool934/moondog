// Runs Moondog's core in its own Node process: the same application and agent the `moondog`
// command builds, with the window as its surface instead of a terminal. The window and this
// process talk over one message port, which also carries the previews the agent plays.
import { createWindowPreviewPlayer } from "./preview-player.mjs";
import { runWindowRoom } from "./window-room.mjs";
import { createWindowNeteasePlayer } from "./netease-player.mjs";

const port = await new Promise((resolve) => {
  process.parentPort.once("message", ({ ports: [roomPort] }) => resolve(roomPort));
});
const send = (message) => port.postMessage(message);
// The app asks to quit here, so running replies can stop and be saved before the process ends.
const quit = new AbortController();
// The app also says when its window gains focus, so the room can read Spotify again.
const focus = new EventTarget();
let loginRequest = null;
process.parentPort.on("message", ({ data }) => {
  if (data?.type === "quit") quit.abort();
  if (data?.type === "focus") focus.dispatchEvent(new Event("focus"));
  if (data?.type === "netease-login-result" && loginRequest) {
    const pending = loginRequest;
    loginRequest = null;
    pending.cleanup();
    data.error ? pending.reject(new Error(data.error)) : pending.resolve(data.cookie ?? null);
  }
});

globalThis[Symbol.for("moondog.host")] = {
  createNeteasePlayer: (library) => createWindowNeteasePlayer({ library, port }),
  openNeteaseLogin: ({ signal } = {}) => new Promise((resolve, reject) => {
    if (signal?.aborted) return resolve(null);
    if (loginRequest) return reject(new Error("NetEase sign-in is already open."));
    const cancel = () => process.parentPort.postMessage({ type: "netease-login-cancel" });
    loginRequest = { resolve, reject, cleanup: () => signal?.removeEventListener("abort", cancel) };
    signal?.addEventListener("abort", cancel, { once: true });
    process.parentPort.postMessage({ type: "netease-login" });
  }),
  runRoom: (services) => runWindowRoom(services, { port, send, quit: quit.signal, focus }),
  // The port would keep this process alive after the room closes.
  closed: () => {
    port.close();
    process.exit(process.exitCode ?? 0);
  },
  // The agent's previews play in the window, next to links to the full songs.
  musicPreviewPlayer: createWindowPreviewPlayer(port),
};

// The core is the `moondog` command with no arguments.
process.argv.splice(2);
await import("../scripts/moondog.mjs");
