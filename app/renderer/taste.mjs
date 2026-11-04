// The listener's taste, open in the room in the conversation's place, as a playlist opens: what Moondog's profile
// says about them, their history pressed as a record, and the reading a model wrote from it. The artists and
// tracks it rests on are the taste view in the sidebar beside it (taste-list.mjs); a row unfolded there lights
// that artist across the record here. The composer stays below.
import { createPressing } from "./pressing.mjs";
import { make } from "./ui.mjs";

const KIND_LABELS = { observation: "tasteMeasured", hypothesis: "tasteInterpretation", listener_assertion: "tasteYourChoice" };

export function createTaste({ root, state, send, t, onClose }) {
  const say = (key, params) => t()(key, params);
  const scroller = make("div", "taste-scroll");
  const column = make("div", "taste-column");
  scroller.append(column);
  root.append(scroller);
  // The record of the listener's history, built once so its needle and range stay while the page redraws.
  const pressing = createPressing({ t, locale: () => state.locale });
  let pressed = null;
  let pinned = null;
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); onClose(); }
  });
  const page = () => state.tasteData ?? null;

  function head(data) {
    const node = make("header", "taste-head");
    const title = make("div", "taste-title");
    title.append(make("h1", "taste-name", say("tasteTitle")));
    if (data?.state === "ready") {
      const report = make("button", "button small quiet", say("tasteReport"));
      report.type = "button";
      report.dataset.key = "taste:report";
      report.addEventListener("click", () => send({ type: "taste-report" }));
      title.append(report);
    }
    node.append(title);
    // The overview reads as one line of facts under the title, wrapping where the room is narrow.
    const lines = data?.state === "ready" ? data.overview ?? [] : [];
    if (lines.length) node.append(make("p", "taste-overview", lines.join(" · ")));
    return node;
  }

  function reading(value) {
    if (!value) return null;
    const node = make("section", "taste-reading");
    node.append(make("h2", "taste-heading", say("tasteReading")));
    if (value.state === "missing") {
      node.append(make("p", "taste-note", say("tasteReadingMissing")));
      return node;
    }
    if (value.summary) node.append(make("p", "taste-summary", value.summary));
    if (value.findings?.length) {
      const list = make("ol", "taste-findings");
      for (const finding of value.findings) {
        const item = make("li");
        item.value = finding.number;
        // A finding that names an artist on the record lights that artist there.
        item.addEventListener("mouseenter", () => pressing.focusFrom(finding.statement));
        item.addEventListener("mouseleave", () => pressing.pin(pinned));
        item.append(make("p", "", finding.statement));
        const kind = KIND_LABELS[finding.kind];
        const meta = [kind ? say(kind) : "", finding.scope].filter(Boolean).join(" · ");
        if (meta) item.append(make("span", "", meta));
        list.append(item);
      }
      node.append(list);
    }
    const built = { version: value.version ?? "", date: value.builtAt ?? "" };
    node.append(make("p", "taste-note", value.state === "stale" ? say("tasteReadingStale", built)
      : value.state === "current_through" ? say("tasteReadingThrough", built) : say("tasteReadingBuilt", built)));
    return node;
  }

  function render() {
    root.hidden = !state.taste;
    if (!state.taste) return;
    const data = page();
    // The record is the same node across redraws; a control in it keeps the focus it had.
    const held = pressing.node.contains(document.activeElement) ? document.activeElement : null;
    const nodes = [head(data)];
    if (!data) nodes.push(make("p", "taste-note", say("loading")));
    else if (data.state !== "ready") {
      const empty = make("div", "taste-empty");
      for (const line of data.lines ?? []) empty.append(make("p", "", line));
      nodes.push(empty);
    } else {
      if (pressed !== data) { pressed = data; pressing.update(data, data.subjects); pressing.pin(pinned); } else pressing.language();
      if (data.history) nodes.push(pressing.node);
      const saved = reading(data.reading);
      if (saved) nodes.push(saved);
    }
    const top = scroller.scrollTop;
    column.replaceChildren(...nodes);
    scroller.scrollTop = top;
    if (held?.isConnected) held.focus({ preventScroll: true });
  }

  return {
    render,
    // The artist a row unfolded in the taste view stands for, lit across the record until it folds.
    pin(name) { pinned = name ?? null; pressing.pin(pinned); },
    reset() { scroller.scrollTop = 0; pressing.reset(); pressed = null; },
  };
}
