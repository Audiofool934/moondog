// Plays the scene in the window as a visitor would: a pointer moves, the needle goes down, a request
// is typed, and the record takes the whole window. Everything after each gesture is the window and its
// core answering, as in the app. The scene runs only while the window is on screen, and starts again,
// faded, once it has played.
const $ = (name) => document.querySelector(`[data-${name}]`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Time that stops while nobody can see the window. With reduced motion every wait is a moment.
export function createClock({ quick = false } = {}) {
  let running = false;
  let resumed = Promise.withResolvers();
  return {
    run(on) {
      if (on === running) return;
      running = on;
      if (on) resumed.resolve();
      else resumed = Promise.withResolvers();
    },
    async wait(ms) {
      if (quick) return sleep(Math.min(ms, 8));
      let left = ms;
      while (left > 0) {
        if (!running) await resumed.promise;
        const started = performance.now();
        await sleep(Math.min(left, 100));
        if (running) left -= performance.now() - started;
      }
    },
  };
}

// The pointer: macOS's arrow, gliding between the places the scene points at.
function createPointer(clock) {
  const pointer = document.createElement("div");
  pointer.className = "pointer";
  pointer.setAttribute("aria-hidden", "true");
  pointer.innerHTML = '<svg viewBox="0 0 18 24"><path d="M1.5 1.5v17.2l4.3-4.1 2.9 6.6 2.7-1.2-2.9-6.5h6.1z"/></svg>';
  document.body.append(pointer);
  let at = { x: innerWidth * 0.84, y: innerHeight * 0.9 };
  const place = (point, ms) => {
    pointer.style.transitionDuration = `${ms}ms`;
    pointer.style.transform = `translate(${point.x}px, ${point.y}px)`;
    at = point;
  };
  place(at, 0);
  // What the window hears from a pointer: moves over what is under it, then a press and a click.
  const fire = (type, point, Event = MouseEvent) => document.elementFromPoint(point.x, point.y)
    ?.dispatchEvent(new Event(type, { bubbles: true, cancelable: true, clientX: point.x, clientY: point.y, detail: 1, pointerType: "mouse" }));
  return {
    show: () => pointer.classList.add("shown"),
    hide: () => pointer.classList.remove("shown"),
    async move(point, ms) {
      place(point, ms);
      await clock.wait(ms);
      fire("pointermove", point, PointerEvent);
    },
    async click() {
      pointer.classList.add("pressed");
      fire("pointerdown", at, PointerEvent);
      await clock.wait(110);
      fire("pointerup", at, PointerEvent);
      fire("click", at);
      pointer.classList.remove("pressed");
    },
  };
}

// Where the record's arm rests while nothing plays, by the art module's own geometry (as app/check-ui.mjs aims).
function armPoint() {
  const canvas = $("record");
  const box = canvas.getBoundingClientRect();
  const grid = Math.max(48, Math.round(Math.floor(canvas.clientWidth) / 8) * 4);
  const radius = (grid - 4) / 2.35;
  const [cx, cy] = [(grid - 1) / 2 - radius * 0.09, (grid - 1) / 2 + radius * 0.045];
  const [ux, uy] = [1.07, -0.6];
  return { x: box.left + (cx + ux * radius + 0.5) / grid * box.width, y: box.top + (cy + uy * radius + 0.5) / grid * box.height };
}
const middle = (element, dx = 0) => {
  const box = element.getBoundingClientRect();
  return { x: box.left + box.width / 2 + dx, y: box.top + box.height / 2 };
};
// The window is ready for a message once no reply is being written.
async function settled(clock) {
  while ($("send")?.querySelector("use")?.getAttribute("href") === "#i-stop") await clock.wait(100);
}

export async function direct({ clock, agent, request, quick = false, ending = () => {} }) {
  const pointer = quick ? null : createPointer(clock);
  const curtain = document.createElement("div");
  curtain.className = "curtain";
  document.body.append(curtain);
  // The scene waits for the window to be seen, and holds while it isn't.
  let seen = false;
  const watch = () => clock.run(seen && document.visibilityState === "visible");
  new IntersectionObserver(([entry]) => { seen = entry.isIntersecting; watch(); }, { threshold: 0.35 }).observe(document.body);
  document.addEventListener("visibilitychange", watch);

  // The window draws its first frame and hears from its core before the first gesture.
  await (quick ? sleep(500) : clock.wait(400));
  curtain.classList.add("open");
  await clock.wait(1600);

  // The needle goes down, and Moondog picks something for right now.
  let answered = agent.answered();
  if (pointer) {
    pointer.show();
    await pointer.move(armPoint(), 1300);
    await clock.wait(500);
    await pointer.click();
    await clock.wait(300);
    await pointer.move({ x: innerWidth * 0.8, y: innerHeight * 0.72 }, 900);
    pointer.hide();
  } else {
    const point = armPoint();
    document.elementFromPoint(point.x, point.y)?.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: point.x, clientY: point.y, detail: 1 }));
  }
  await answered;
  await clock.wait(2400);

  // The player opens, with the song's cover, where the window has room for it beside the words
  // (app/renderer/renderer.mjs, roomFor). In a narrower window the song stays in the title bar.
  if (innerWidth < 1060) await clock.wait(1500);
  else if (pointer) {
    pointer.show();
    await pointer.move(middle($("toggle-inspector")), 1000);
    await clock.wait(350);
    await pointer.click();
    await clock.wait(250);
    pointer.hide();
  } else $("toggle-inspector").click();
  await clock.wait(innerWidth < 1060 ? 1000 : 3000);

  // A request, typed.
  await settled(clock);
  const input = $("input");
  if (pointer) {
    pointer.show();
    await pointer.move(middle(input, -input.getBoundingClientRect().width / 2 + 90), 1000);
    await clock.wait(250);
    await pointer.click();
    pointer.hide();
  }
  for (const letter of request) {
    input.value += letter;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await clock.wait(quick ? 0 : 45 + Math.random() * 70 + (letter === " " ? 40 : 0));
  }
  await clock.wait(500);
  answered = agent.answered();
  $("form").requestSubmit();
  await answered;
  if (quick) return;

  // The record takes the whole window, as its arrows offer under the pointer, and turns in the cover's colours.
  await clock.wait(2600);
  const frame = $("record-frame");
  pointer.show();
  await pointer.move(middle(frame), 1100);
  frame.classList.add("scene-hover");
  await clock.wait(600);
  await pointer.move(middle($("expand")), 600);
  await clock.wait(300);
  await pointer.click();
  frame.classList.remove("scene-hover");
  await clock.wait(400);
  pointer.hide();
  await clock.wait(6500);

  // The scene plays again from the start, behind a fade.
  ending();
  curtain.classList.remove("open");
  await clock.wait(900);
  location.reload();
}
