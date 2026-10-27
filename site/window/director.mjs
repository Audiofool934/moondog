// Plays the scene in the window as a visitor would: a click on the record's arm asks for music, a request
// is typed, the record takes the whole window, and the needle lifts. Everything after each gesture is the window and its core
// answering, as in the app. The scene begins and ends on a new conversation with the arm up, so it plays
// again from where it ends. It runs only while the window is on screen.
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
    // Puts the pointer somewhere at once, such as where the visitor's own click on the page landed.
    jump: (point) => place(point, 0),
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

// A point on the record's arm, by the art module's own geometry (as app/check-ui.mjs aims): where it rests
// while nothing plays, or on the record while music plays. The full-window record keeps a fixed number
// of dots across (app/renderer/renderer.mjs, immerse).
const RESTING = [1.07, -0.6];
const PLAYING = [0.864, -0.706];
function armPoint(canvas = $("record"), across = null, [ux, uy] = RESTING) {
  const box = canvas.getBoundingClientRect();
  const grid = across ?? Math.max(48, Math.round(Math.floor(canvas.clientWidth) / 8) * 4);
  const radius = (grid - 4) / 2.35;
  const [cx, cy] = [(grid - 1) / 2 - radius * 0.09, (grid - 1) / 2 + radius * 0.045];
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

// begin resolves when the page lets the scene start, with { at } where the visitor's click on its cover
// landed in this window, if they clicked: the scene's pointer takes over from there. needle hears each
// click on the arm, and ending hears the needle lift at the end.
export async function direct({ clock, agent, request, quick = false, begin, needle = () => {}, ending = () => {} }) {
  const pointer = quick ? null : createPointer(clock);
  const curtain = document.createElement("div");
  curtain.className = "curtain";
  document.body.append(curtain);
  // The scene waits for the window to be seen, and holds while it isn't.
  let seen = false;
  const watch = () => clock.run(seen && document.visibilityState === "visible");
  new IntersectionObserver(([entry]) => { seen = entry.isIntersecting; watch(); }, { threshold: 0.35 }).observe(document.body);
  document.addEventListener("visibilitychange", watch);

  // The window draws its first frame and hears from its core before the first gesture, then waits on
  // the record, its composer set aside, for the page to let it begin.
  await (quick ? sleep(500) : clock.wait(400));
  document.body.classList.add("waiting");
  curtain.classList.add("open");
  let { at } = await begin;

  const drop = () => {
    const point = armPoint();
    document.elementFromPoint(point.x, point.y)?.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: point.x, clientY: point.y, detail: 1 }));
  };
  for (;;) {
    // A new conversation, the arm up: the composer comes back where the page's words were, and the
    // pointer clicks the record's arm, so Moondog picks something for right now; the needle goes down as
    // the music starts.
    document.body.classList.remove("waiting");
    let answered = agent.answered();
    if (pointer) {
      if (at) {
        pointer.jump(at);
        pointer.show();
        at = null;
        await clock.wait(500);
      } else {
        await clock.wait(900);
        pointer.show();
      }
      await pointer.move(armPoint(), 1300);
      await clock.wait(450);
      await pointer.click();
      needle();
      await clock.wait(300);
      await pointer.move({ x: innerWidth * 0.8, y: innerHeight * 0.72 }, 900);
      pointer.hide();
    } else {
      drop();
      needle();
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
    await clock.wait(5000);

    // The needle lifts and the music stops.
    const deep = $("immersive-record");
    pointer.show();
    await pointer.move(armPoint(deep, 160, PLAYING), 1000);
    await clock.wait(400);
    await pointer.click();
    ending();
    await clock.wait(1500);
    // Under the record, the player folds and a new conversation opens, as ⌘N opens one. A click beside
    // the record brings the window back, and the record glides from the whole window to its place over
    // the composer: where the scene began.
    if ($("toggle-inspector").getAttribute("aria-pressed") === "true") $("toggle-inspector").click();
    $("new").click();
    document.body.classList.add("waiting");
    await pointer.move({ x: innerWidth * 0.14, y: innerHeight * 0.56 }, 900);
    await clock.wait(300);
    const from = deep.getBoundingClientRect();
    await pointer.click();
    while (!$("immersive").hidden) await clock.wait(16);
    pointer.hide();
    const record = $("record");
    const to = record.getBoundingClientRect();
    if (to.width) {
      record.animate([{ transformOrigin: "0 0", transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width})` },
        { transformOrigin: "0 0", transform: "none" }], { duration: 900, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
    }
    await clock.wait(700);
  }
}
