// Harness interaction checks. MOONDOG_HARNESS_PLATFORM can draw each desktop's shared renderer.
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const $ = (name) => document.querySelector(`[data-${name}]`);
const platform = window.moondogApp.platform;
const mac = platform === "darwin";
await wait(400);
assert(document.documentElement.dataset.platform === platform, "The renderer follows its desktop host");
assert($("new").dataset.keys === (mac ? "⌘N" : "Ctrl+N"), "New conversation names the host's modifier");
assert(getComputedStyle(document.querySelector(".bar-start")).paddingInlineStart === (mac ? "92px" : "10px"), "Only Mac leaves space for traffic lights");

// Selection must use Ctrl on Windows/Linux, with no accidental conversation opening.
const sidebarHidden = $("window").classList.contains("no-sidebar");
if (sidebarHidden) { $("toggle-sidebar").click(); await wait(500); }
const rows = [...document.querySelectorAll(".row")];
assert(rows.length >= 2, "The fictional fixture has conversations to select");
rows[0].querySelector(".open").dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: !mac, metaKey: mac }));
rows[1].querySelector(".open").dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: !mac, metaKey: mac }));
assert(rows[1].classList.contains("selected"), "The platform modifier selects a conversation");
rows[1].querySelector(".open").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
if (sidebarHidden) { $("toggle-sidebar").click(); await wait(500); }

$("settings-button").click();
await wait(250);
document.querySelector('[data-key="nav:appearance"]').click();
await wait(150);
assert(Boolean(document.querySelector('[data-key="theme:dark"]')), "Every platform offers its window theme");
assert(Boolean(document.querySelector('[data-key="icon:dark"]')) === mac, "Only Mac offers a Dock icon choice");
document.querySelector('[data-key="nav:playback"]').click();
await wait(150);
if (!mac) assert(!document.querySelector('[data-key="apple-music:allow"]'), "Other platforms do not offer Mac MusicKit permission");
document.querySelector('[data-key="nav:about"]').click();
await wait(150);
assert(document.querySelector(".keys").textContent.includes(mac ? "⌘N" : "Ctrl+N"), "Settings lists the same shortcuts as the toolbar");
document.querySelector(".sheet-close").click();
await wait(300);
assert(document.documentElement.scrollWidth === innerWidth, "The room fits the viewport without horizontal overflow");
return { platform, width: innerWidth, nativeControls: !mac, modifier: mac ? "Command" : "Ctrl", settings: "passed", selection: "passed" };
