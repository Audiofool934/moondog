// The project page: the live room, on-screen keys for touch screens, and copy buttons.
import { openRoom } from "./room/room.mjs";

// The build sets MOONDOG_AGENT_URL when the public agent is running.
const agentUrl = MOONDOG_AGENT_URL;
for (const note of document.querySelectorAll("[data-agent]")) note.hidden = (note.dataset.agent === "online") !== Boolean(agentUrl);

const frame = document.querySelector("[data-room]");
const room = openRoom(frame.querySelector("[data-room-screen]"), { agentUrl });
// The spectrum fades once the room has drawn its first frame.
requestAnimationFrame(() => { frame.dataset.state = "ready"; });

for (const link of document.querySelectorAll('a[href="#room"]')) {
  link.addEventListener("click", () => setTimeout(room.focus, 0));
}

const keys = { tab: "\t", up: "\x1b[A", down: "\x1b[B", enter: "\r", esc: "\x1b" };
for (const button of document.querySelectorAll("[data-key]")) {
  button.addEventListener("click", () => room.send(keys[button.dataset.key]));
}
for (const button of document.querySelectorAll("[data-command]")) {
  button.addEventListener("click", () => room.send(`${button.dataset.command}\r`));
}

for (const button of document.querySelectorAll("[data-copy]")) {
  button.addEventListener("click", async () => {
    const text = document.getElementById(button.dataset.copy).textContent.trim();
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = "Copied";
      button.dataset.state = "done";
    } catch {
      button.textContent = "Select and copy";
    }
    setTimeout(() => { button.textContent = "Copy"; delete button.dataset.state; }, 2000);
  });
}
