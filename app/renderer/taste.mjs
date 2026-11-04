// The listener's taste, open in the room in the conversation's place, as a playlist opens: what Moondog's
// profile says about them, the reading a model wrote from it, and every artist and track it rests on. The core
// builds it with the terminal's own view of /taste, so the words and the choices are the same in both.
// A row unfolds to why it's there and what the listener can say about it: I like this, Keep it out, Undo my
// choice, and Find more like this, which starts a request in the composer. The composer stays below.
import { createPressing } from "./pressing.mjs";
import { make } from "./ui.mjs";

const FILTERS = ["all", "artist", "track", "choices"];
const FILTER_LABELS = { all: "tasteAll", artist: "tasteArtists", track: "tasteTracks", choices: "tasteChoices" };
const KIND_LABELS = { observation: "tasteMeasured", hypothesis: "tasteInterpretation", listener_assertion: "tasteYourChoice" };

export function createTaste({ root, state, send, t, onClose, onAsk }) {
  const say = (key, params) => t()(key, params);
  const scroller = make("div", "taste-scroll");
  const column = make("div", "taste-column");
  scroller.append(column);
  root.append(scroller);
  // The record of the listener's history, built once so its needle and range stay while the page redraws.
  const pressing = createPressing({ t, locale: () => state.locale });
  let pressed = null;
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); onClose(); return; }
    // Up and Down move between the rows, as in the conversations.
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && event.target.closest?.(".taste-open")) {
      event.preventDefault();
      const rows = [...scroller.querySelectorAll(".taste-open")];
      rows[rows.indexOf(event.target) + (event.key === "ArrowDown" ? 1 : -1)]?.focus();
    }
  });

  // What the page shows beside the core's profile: the filter, the one row unfolded, and the explanations asked for.
  let filter = "all";
  let unfolded = null;
  const why = new Map();
  const asking = new Set();
  const page = () => state.taste?.data ?? null;

  const subjectsFor = (value) => (value === "all" ? page()?.subjects ?? []
    : value === "choices" ? (page()?.subjects ?? []).filter((subject) => subject.chosen)
      : (page()?.subjects ?? []).filter((subject) => subject.kind === value));

  function button(label, className, onClick, key) {
    const node = make("button", className, label);
    node.type = "button";
    node.dataset.key = key;
    node.addEventListener("click", onClick);
    return node;
  }

  function head(data) {
    const node = make("header", "taste-head");
    const title = make("div", "taste-title");
    title.append(make("h1", "taste-name", say("tasteTitle")));
    if (data?.state === "ready") title.append(button(say("tasteReport"), "button small quiet", () => send({ type: "taste-report" }), "taste:report"));
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
        item.addEventListener("mouseleave", () => pressing.focusFrom(""));
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

  function filters() {
    const node = make("div", "taste-filters");
    node.setAttribute("role", "toolbar");
    for (const value of FILTERS) {
      const count = subjectsFor(value).length;
      const chip = button("", "taste-filter", () => { filter = value; render(); scroller.querySelector(`[data-key="filter:${value}"]`)?.focus(); }, `filter:${value}`);
      chip.append(make("span", "", say(FILTER_LABELS[value])), make("span", "taste-count", count.toLocaleString(state.locale)));
      chip.setAttribute("aria-pressed", String(filter === value));
      node.append(chip);
    }
    return node;
  }

  function stanceOf(subject) {
    return subject.stance === "like" ? say("tasteLiked") : subject.stance === "avoid" ? say("tasteKeptOut") : "";
  }

  function row(subject, data) {
    const item = make("li", "taste-row");
    const open = unfolded === subject.key;
    item.classList.toggle("open", open);
    const head = button("", "taste-open", () => {
      unfolded = open ? null : subject.key;
      render();
      focusRow(subject.key);
      if (!open) revealRow(subject.key);
    }, `subject:${subject.key}`);
    head.setAttribute("aria-expanded", String(open));
    const words = make("span", "taste-words");
    words.append(make("strong", "", subject.label));
    // A track shows its artist; an artist shows where it comes from first. A choice comes first among the
    // details, and the stance already says it, so the line after it shows instead.
    const lines = (subject.details ?? []).filter(Boolean);
    const first = (subject.chosen && lines.length > 1 ? lines[1] : lines[0]) ?? "";
    words.append(make("span", "", subject.kind === "track" ? subject.subtitle : first || subject.subtitle));
    head.append(words);
    const stance = stanceOf(subject);
    if (stance) head.append(make("span", `taste-stance ${subject.stance}`, stance));
    item.append(head);
    if (open) item.append(detail(subject, data));
    return item;
  }

  function detail(subject, data) {
    const node = make("div", "taste-detail");
    for (const line of subject.details ?? []) node.append(make("p", "", line));
    const evidence = subject.evidence?.[0];
    const explained = evidence ? why.get(evidence.id) : null;
    if (explained) {
      const block = make("div", "taste-why");
      if (explained.basis) block.append(make("p", "", explained.basis));
      if (explained.limit) block.append(make("p", "taste-label", say("tasteCantTell")), make("p", "taste-limit", explained.limit));
      if (Number.isFinite(explained.confidence)) block.append(make("p", "taste-limit", say("tasteSure", { percent: Math.round(explained.confidence * 100) })));
      node.append(block);
    }
    const actions = make("div", "taste-actions");
    if (evidence && !explained) {
      const ask = button(say("tasteWhy"), "button small quiet", () => {
        asking.add(evidence.id);
        ask.disabled = true;
        send({ type: "taste-why", key: subject.key, evidenceId: evidence.id });
      }, `why:${subject.key}`);
      ask.disabled = asking.has(evidence.id);
      actions.append(ask);
    }
    if (data.canChoose) {
      const choose = (stance) => send({ type: "taste-choice", key: subject.key, target: subject.target, stance });
      if (subject.stance !== "like") actions.append(button(say("tasteLike"), "button small quiet", () => choose("like"), `like:${subject.key}`));
      if (subject.stance !== "avoid") actions.append(button(say("tasteAvoid"), "button small quiet", () => choose("avoid"), `avoid:${subject.key}`));
      if (subject.chosen) actions.append(button(say("tasteUndo"), "button small quiet", () => choose("retract"), `retract:${subject.key}`));
    }
    if (subject.kind === "track" && data.ask) {
      actions.append(button(say("tasteMore"), "button small quiet", () => {
        const target = subject.target;
        onAsk(`${data.ask}\n\nTrack: ${JSON.stringify(target.label)}\nArtist: ${JSON.stringify(target.artistCredit)}`);
      }, `more:${subject.key}`));
    }
    if (actions.childElementCount) node.append(actions);
    return node;
  }

  function focusRow(key) {
    scroller.querySelector(`[data-key="${CSS.escape(`subject:${key}`)}"]`)?.focus({ preventScroll: true });
  }
  // An unfolded row, and the explanation that arrives under it, scroll into view if the page has to move.
  function revealRow(key) {
    scroller.querySelector(`[data-key="${CSS.escape(`subject:${key}`)}"]`)?.closest(".taste-row")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function render() {
    root.hidden = !state.taste;
    if (!state.taste) return;
    const data = page();
    // The control that had the focus gets it back after the page redraws.
    const focused = scroller.contains(document.activeElement) ? document.activeElement.dataset.key : null;
    // The record is the same node across redraws; a control in it keeps the focus it had.
    const held = pressing.node.contains(document.activeElement) ? document.activeElement : null;
    const nodes = [head(data)];
    if (!data) nodes.push(make("p", "taste-note", say("loading")));
    else if (data.state !== "ready") {
      const empty = make("div", "taste-empty");
      for (const line of data.lines ?? []) empty.append(make("p", "", line));
      nodes.push(empty);
    } else {
      if (pressed !== data) { pressed = data; pressing.update(data, data.subjects); } else pressing.language();
      if (data.history) nodes.push(pressing.node);
      const saved = reading(data.reading);
      if (saved) nodes.push(saved);
      if (data.subjects?.length) {
        nodes.push(filters());
        const subjects = subjectsFor(filter);
        if (unfolded && !subjects.some((subject) => subject.key === unfolded)) unfolded = null;
        const list = make("ol", "taste-list");
        for (const subject of subjects) list.append(row(subject, data));
        nodes.push(list);
        if (!subjects.length) nodes.push(make("p", "taste-note", say("tasteNoChoices")));
      }
    }
    const top = scroller.scrollTop;
    column.replaceChildren(...nodes);
    scroller.scrollTop = top;
    if (held?.isConnected) held.focus({ preventScroll: true });
    else if (focused) scroller.querySelector(`[data-key="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  }

  return {
    render,
    reset() { filter = "all"; unfolded = null; why.clear(); asking.clear(); scroller.scrollTop = 0; pressing.reset(); pressed = null; },
    receive(data) {
      if (data.type === "taste-why") {
        asking.delete(data.evidenceId);
        why.set(data.evidenceId, data);
      }
      // A notice for an explanation that failed lets its button ask again.
      if (data.type === "notice" && data.code === "taste-why") asking.clear();
      render();
      if (data.type === "taste-why" && data.key) revealRow(data.key);
    },
  };
}
