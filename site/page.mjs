// The project page: Moondog's window and its terminal room, each in a frame of its own, and copy buttons.
// The terminal's frame loads the first time someone asks for it.
const online = Boolean(MOONDOG_AGENT_URL);
const stage = document.querySelector("[data-stage]");
const tabs = [...document.querySelectorAll("[data-view]")].filter((element) => element.getAttribute("role") === "tab");
const frames = { window: stage.querySelector('[data-frame="window"]') };

// Each line of the note shows for its view, and for whether the demo agent is there.
function showNotes(view) {
  for (const note of document.querySelectorAll(".note [data-for], .note [data-agent]")) {
    const forView = !note.dataset.for || note.dataset.for === view;
    const forAgent = !note.dataset.agent || (note.dataset.agent === "online") === online;
    note.hidden = !(forView && forAgent);
  }
}

function show(view, { focus = true } = {}) {
  if (!frames[view]) {
    frames[view] = Object.assign(document.createElement("iframe"), { src: "terminal.html", title: "Moondog's terminal room, with the same made-up listener" });
    frames[view].dataset.frame = view;
    frames[view].allow = "autoplay; clipboard-write";
    stage.append(frames[view]);
  }
  for (const [name, frame] of Object.entries(frames)) frame.hidden = name !== view;
  for (const tab of tabs) {
    const selected = tab.dataset.view === view;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  stage.dataset.view = view;
  showNotes(view);
  if (focus) frames[view].focus();
}

for (const tab of tabs) {
  tab.addEventListener("click", () => show(tab.dataset.view));
  tab.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next = tabs[(tabs.indexOf(tab) + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
    next.focus();
    show(next.dataset.view, { focus: false });
  });
}
show("window", { focus: false });

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
