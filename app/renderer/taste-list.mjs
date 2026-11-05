// Your taste in the sidebar, beside the conversations and the library: every artist and track Moondog's profile
// rests on, filtered by kind or by your own choices. The core builds it with the terminal's own view of /taste, so
// the words and the choices are the same in both. A row unfolds to why it's there and what you can say about it:
// I like this, Keep it out, Undo my choice, and for a track Find more like this, which starts a request in the
// composer. Unfolding a row opens the taste page in the room and lights that artist across its record.
import { make } from "./ui.mjs";

const FILTERS = ["all", "artist", "track", "choices"];
// The sidebar is narrow, so the choices filter takes its short name.
const FILTER_LABELS = { all: "tasteAll", artist: "tasteArtists", track: "tasteTracks", choices: "tasteChoicesShort" };

export function createTasteList({ root, state, send, t, onSelect, onAsk }) {
  const say = (key, params) => t()(key, params);
  // What the list shows beside the core's profile: the filter, the one row unfolded, and the explanations asked for.
  let filter = "all";
  let unfolded = null;
  const why = new Map();
  const asking = new Set();
  const page = () => state.tasteData ?? null;
  const subjectsFor = (value) => (value === "all" ? page()?.subjects ?? []
    : value === "choices" ? (page()?.subjects ?? []).filter((subject) => subject.chosen)
      : (page()?.subjects ?? []).filter((subject) => subject.kind === value));

  root.addEventListener("keydown", (event) => {
    // Up and Down move between the rows, as in the conversations and the library.
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && event.target.closest?.(".taste-open")) {
      event.preventDefault();
      const rows = [...root.querySelectorAll(".taste-open")];
      rows[rows.indexOf(event.target) + (event.key === "ArrowDown" ? 1 : -1)]?.focus();
    }
  });

  function button(label, className, onClick, key) {
    const node = make("button", className, label);
    node.type = "button";
    node.dataset.key = key;
    node.addEventListener("click", onClick);
    return node;
  }

  function filters() {
    const node = make("div", "taste-filters");
    node.setAttribute("role", "toolbar");
    for (const value of FILTERS) {
      const count = subjectsFor(value).length;
      const chip = button("", "taste-filter", () => { filter = value; render(); root.querySelector(`[data-key="filter:${value}"]`)?.focus(); }, `filter:${value}`);
      chip.append(make("span", "", say(FILTER_LABELS[value])), make("span", "taste-count", count.toLocaleString(state.locale)));
      chip.title = `${say(value === "choices" ? "tasteChoices" : FILTER_LABELS[value])} · ${count.toLocaleString(state.locale)}`;
      chip.setAttribute("aria-pressed", String(filter === value));
      node.append(chip);
    }
    return node;
  }

  const stanceOf = (subject) => (subject.stance === "like" ? say("tasteLiked") : subject.stance === "avoid" ? say("tasteKeptOut") : "");
  // The artist a row lights on the record: the artist itself, or a track's artist.
  const artistOf = (subject) => (subject.kind === "track" ? subject.target?.artistCredit ?? subject.subtitle : subject.label);

  function row(subject, data) {
    const item = make("li", "taste-row");
    const open = unfolded === subject.key;
    item.classList.toggle("open", open);
    const head = button("", "taste-open", () => {
      unfolded = open ? null : subject.key;
      onSelect(unfolded ? artistOf(subject) : null);
      render();
      root.querySelector(`[data-key="${CSS.escape(`subject:${subject.key}`)}"]`)?.focus({ preventScroll: true });
      if (!open) reveal(subject.key);
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
  // An unfolded row, and the explanation that arrives under it, scroll into view if the list has to move.
  function reveal(key) {
    root.querySelector(`[data-key="${CSS.escape(`subject:${key}`)}"]`)?.closest(".taste-row")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function render() {
    const data = page();
    const focused = root.contains(document.activeElement) ? document.activeElement.dataset.key : null;
    const nodes = [];
    if (!data) nodes.push(make("p", "taste-side-note", say("loading")));
    else if (data.state !== "ready" || !data.subjects?.length) {
      for (const line of data.lines ?? []) nodes.push(make("p", "taste-side-note", line));
    } else {
      nodes.push(filters());
      const subjects = subjectsFor(filter);
      if (unfolded && !subjects.some((subject) => subject.key === unfolded)) unfolded = null;
      const list = make("ol", "taste-list");
      for (const subject of subjects) list.append(row(subject, data));
      nodes.push(list);
      if (!subjects.length) nodes.push(make("p", "taste-side-note", say("tasteNoChoices")));
    }
    const top = root.scrollTop;
    root.replaceChildren(...nodes);
    root.scrollTop = top;
    if (focused) root.querySelector(`[data-key="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  }

  return {
    render,
    receive(data) {
      if (data.type === "taste-why") {
        asking.delete(data.evidenceId);
        why.set(data.evidenceId, data);
      }
      // A notice for an explanation that failed lets its button ask again.
      if (data.type === "notice" && data.code === "taste-why") asking.clear();
      render();
      if (data.type === "taste-why" && data.key) reveal(data.key);
    },
  };
}
