// The one-time first run in the window: the music service, then the model. The core keeps whether it
// is over (src/core/first-run.mjs) and sends it as status.firstRun; the terminal shares it, so a first
// run finished or skipped there ends here too. The Settings sheet asks, one place at a time.

// What is still to ask: each step the core still misses, less one the listener answered here before
// the core confirmed it. Nothing until the core says (null), as on the project page.
export function firstRunLeft(run, { modelReady = false, answered = [] } = {}) {
  if (run?.needed !== true) return [];
  return [!run.service && "playback", !run.model && !modelReady && "model"].filter((step) => step && !answered.includes(step));
}

// read() gives the core's latest { run, modelReady }. The sheet calls answer() when a step is answered
// and skip() for the rest; update() follows each status. Once both steps are answered the core ends
// the first run by itself, so the sheet only steps aside.
export function createFirstRun({ settings, send, read }) {
  let begun = null;
  const answered = [];
  let skipped = false;
  const flow = {
    answer(step) {
      if (!answered.includes(step)) answered.push(step);
      update();
    },
    skip() {
      if (skipped) return;
      skipped = true;
      send({ type: "first-run-done", skipped: true });
      settings.ask(null);
    },
  };
  function update() {
    const { run, modelReady } = read();
    const left = skipped ? [] : firstRunLeft(run, { modelReady, answered });
    if (!left.length) { settings.ask(null); return; }
    // The steps this first run began with, for the marks that say how far along it is.
    begun ??= left;
    // Settings opened by hand stays as it is; the first run comes back when it closes.
    if (settings.open && !settings.asking) return;
    const steps = begun.filter((step) => left.includes(step) || answered.includes(step));
    settings.ask({ ...flow, step: left[0], at: steps.indexOf(left[0]), of: steps.length });
  }
  return { update, skip: flow.skip };
}
