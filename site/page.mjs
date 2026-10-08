// The project page: the live room, on-screen keys for touch screens, and copy buttons.
import { createHumanCheck } from "./room/human-check.mjs";
import { createPreviewPlayer } from "./room/preview-player.mjs";
import { openRoom } from "./room/room.mjs";

// The build sets MOONDOG_AGENT_URL when the public agent is running,
// and MOONDOG_TURNSTILE_SITE_KEY when Cloudflare checks visitors first.
const agentUrl = MOONDOG_AGENT_URL;
const siteKey = agentUrl ? MOONDOG_TURNSTILE_SITE_KEY : "";
for (const note of document.querySelectorAll("[data-agent]")) note.hidden = (note.dataset.agent === "online") !== Boolean(agentUrl);
for (const note of document.querySelectorAll("[data-check]")) note.hidden = !siteKey;

const frame = document.querySelector("[data-room]");
const humanCheck = siteKey ? createHumanCheck(siteKey, document.querySelector("[data-room-check]")) : undefined;
const player = createPreviewPlayer(document.querySelector("[data-player]"));
const room = openRoom(frame.querySelector("[data-room-screen]"), { agentUrl, humanCheck, onPreview: (tracks, album) => player.play(tracks, album) });
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
