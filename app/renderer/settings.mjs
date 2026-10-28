// Settings: one sheet over the window, the places on the left and the open one on the right. Every
// change goes to the core, which saves it where the terminal reads it. A choice shows at once and
// the core's next status confirms it, so nothing waits on a rebuild to look chosen.
import { appIconSvg, iconShape } from "../../src/surfaces/brand/logo.mjs";
import { languageTag, timeOfDay } from "../strings.mjs";
import { icon, make, name, scrollbar, setIcon } from "./ui.mjs";
import { SCRATCH_MS, scratchMark } from "./mark.mjs";

const SECTIONS = ["general", "appearance", "model", "playback", "library", "memory", "about"];
// The thinking levels offered for every model that thinks; the core gives each model the nearest it has.
export const EFFORTS = Object.freeze(["off", "low", "medium", "high", "xhigh", "max"]);
const ICONS = { general: "globe", appearance: "appearance", model: "model", playback: "speaker", library: "import", memory: "memory", about: "info" };
// Spotify names device types in English; the icon says the kind, so no word is needed.
const DEVICE_ICONS = { computer: "laptop", smartphone: "phone", tablet: "phone", tv: "tv" };
// The chosen app icon's ring on the icon's 1024 canvas: at the 64 px the sheet draws it, a 1.5 px line
// 3 px clear of the tile (412).
const RING = 472;
const REDIRECT_URI = "http://127.0.0.1:43821/callback";
const SPOTIFY_DASHBOARD = "https://developer.spotify.com/dashboard";
// NetEase plays through its own command line tool, installed and signed in from Terminal (app/README.md).
const NETEASE_SETUP = "npm install -g @music163/ncm-cli && brew install mpv && ncm-cli login";
// What NetEase's row says until ncm-cli is ready.
const NETEASE_STATES = { missing: "neteaseMissing", signed_out: "neteaseSignedOut", unavailable: "neteaseUnavailable", unknown: "checking" };
const LASTFM_KEY_PAGE = "https://www.last.fm/api/account/create";
const SITE = "https://moondog.audiofool.ai";
// The core's error codes the listener can act on. Anything else reads as a plain failure; the raw
// message goes to the console only.
const SIGN_IN_ERRORS = { connect_while_answering: "waitForReply", sign_in_busy: "signInBusy" };
const IMPORT_ERRORS = { import_while_answering: "waitForReply" };
const LASTFM_ACCESS = new Set(["lastfm_key_missing", "lastfm_key_invalid"]);
// Notices about a settings action, shown in the sheet when the renderer passes them on: where they
// show, what they say, and which shown-at-once choice they take back.
const NOTICES = { model_unknown: ["model", "noticeModelUnknown", "model"], transfer_failed: ["playback", "noticeTransferFailed"],
  "sign-out": [null, "noticeFailed", "spotify"], "music-service": ["playback", "noticeFailed", "service"], language: ["general", "noticeFailed", "locale"],
  model: ["model", "noticeFailed", "model"], effort: ["model", "noticeFailed", "effort"], "default-model": ["model", "noticeFailed"],
  "default-effort": ["model", "noticeFailed"], "list-model": ["model", "noticeFailed"], "endpoint-remove": ["model", "noticeFailed"] };
// The endpoint errors the listener can fix in the form; any other reads as a plain failure.
const ENDPOINT_ERRORS = { endpoint_url_invalid: "endpointUrlInvalid", endpoint_models_unavailable: "endpointModelsUnavailable",
  endpoint_models_missing: "endpointModelsUnavailable", endpoint_name_invalid: "endpointNameInvalid" };
// Window keys on the left, player keys on the right.
const SHORTCUTS = [["⌘N", "newConversation"], ["⌘,", "settings"], ["⌘.", "stopReply"], ["/", "commands"], ["⌥⌘S", "conversations"],
  ["⌥⌘P", "player"], ["⌃⌘P", "playPause"], ["⌃⌘→", "nextSong"], ["⌃⌘←", "previousSong"]];
const warn = (what, message) => { if (message) console.warn(`[moondog] ${what}: ${message}`); };

// Each control carries a key, so the focus comes back to it when the section redraws. A button
// without its own action submits the form it sits in, so a click and Enter do the same thing.
function button(label, className, onClick, key) {
  const node = make("button", className, label);
  node.type = onClick ? "button" : "submit";
  node.dataset.key = key ?? `button:${className}:${label}`;
  if (onClick) node.addEventListener("click", onClick);
  return node;
}
function link(text, href) {
  const node = make("a", "link", text);
  node.href = href;
  node.target = "_blank";
  node.rel = "noreferrer";
  node.dataset.key = `link:${href}`;
  node.append(icon("external"));
  return node;
}

export function createSettings({ state, send, t, appleMusic = null, onHide = null }) {
  const say = (key, params) => t()(key, params);
  const sheet = make("div", "sheet");
  sheet.hidden = true;
  const card = make("div", "sheet-card");
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.tabIndex = -1;
  const nav = make("nav", "sheet-nav");
  const body = make("div", "sheet-body frame");
  const scroller = make("div", "sheet-scroll");
  body.append(scroller);
  const close = make("button", "tool sheet-close");
  close.type = "button";
  close.dataset.key = "close";
  close.append(icon("close"));
  close.addEventListener("click", () => (asking ? asking.skip() : hide()));
  card.append(nav, body, close);
  sheet.append(card);
  document.body.append(sheet);
  scrollbar(scroller);
  // A click beside the first run doesn't skip it; only the close button or Escape does.
  sheet.addEventListener("mousedown", (event) => { if (event.target === sheet && !asking) hide(); });
  const windowNode = document.querySelector("[data-window]");

  // The places are built once and only their state changes, so a message from the core never
  // replaces the row under the pointer.
  const tabs = new Map();
  // The window's look belongs to the Mac app, so a window without it, such as the project page's, leaves it out.
  const sections = SECTIONS.filter((id) => id !== "appearance" || window.moondogApp?.setAppearance);
  for (const id of sections) {
    const tab = make("button", "sheet-tab");
    tab.type = "button";
    tab.dataset.key = `nav:${id}`;
    const label = make("span");
    tab.append(icon(ICONS[id]), label);
    tab.addEventListener("click", () => go(id));
    nav.append(tab);
    tabs.set(id, { tab, label });
  }

  let section = "general";
  let isOpen = false;
  let closing = 0;
  // The first run (first-run.mjs) asks in this sheet: one place at a time, with no others beside it,
  // and the close button skips the rest. { step, at, of, answer, skip } while it asks.
  let asking = null;
  let content = null;
  let copiedTimer = 0;
  // What the core told this sheet; the sheet asks again each time a section opens.
  const data = { providers: null, providersError: false, models: new Map(), modelsFailed: new Set(), expanded: undefined, signingOut: new Set(),
    list: null, listError: false, toggles: new Map(), listPending: new Map(), endpoint: null,
    devices: null, devicesError: false, devicesLoading: false, memories: null, auth: null, error: null, importing: null, version: null, appearance: null, copied: null, focus: null, phaseOffset: null,
    lastfm: { username: "", needsKey: false, keyError: false, savingKey: false },
    drafts: { remember: "", lastfm: "", lastfmKey: "", spotifyClientId: "", endpointName: "", endpointUrl: "", endpointKey: "", endpointModels: "" } };

  // A choice stands until the core's next status, which always brings a new model object and says
  // what really happened.
  const pending = new Map();
  const expect = (kind, value) => pending.set(kind, { value, status: state.model });
  function expected(kind, actual) {
    const entry = pending.get(kind);
    if (entry && entry.status === state.model) return entry.value;
    pending.delete(kind);
    return actual;
  }

  // Settings opened while the first run asks takes the sheet; the first run comes back when it closes.
  function show(name = section) {
    asking = null;
    open(name);
  }
  // The first run's step, or nothing to let it go. A step already in view is only redrawn, since
  // opening asks the core again and the core answers with a status that asks again.
  function ask(flow) {
    if (!flow) { if (asking) hide(); return; }
    const same = asking && isOpen && asking.step === flow.step;
    asking = flow;
    if (same) render(); else open(flow.step);
  }
  // While the sheet is open, the window behind it takes no focus or clicks.
  function open(name) {
    const next = sections.includes(name) ? name : "general";
    const wasOpen = isOpen;
    const moved = next !== section;
    if (moved) { data.error = null; scroller.scrollTop = 0; }
    section = next;
    clearTimeout(closing);
    delete sheet.dataset.state;
    sheet.hidden = false;
    if (!wasOpen) {
      content = null;
      // Each opening starts with the providers and the music service in use folded. An endpoint still
      // being saved keeps its form.
      data.expanded = undefined;
      data.servicePanel = undefined;
      data.neteaseCheck = null;
      if (!data.endpoint?.busy) data.endpoint = null;
    }
    isOpen = true;
    if (windowNode) windowNode.inert = true;
    refresh();
    render({ entering: wasOpen && moved });
    // A sign-in that waits for an answer takes the focus; otherwise the sheet itself does, so the
    // arrow keys move between places and Tab reaches the first one.
    requestAnimationFrame(() => {
      const waiting = card.querySelector('[data-key^="auth-field:"]');
      if (waiting || !card.contains(document.activeElement)) (waiting ?? card).focus({ preventScroll: true });
    });
  }
  function hide() {
    if (!isOpen) return;
    isOpen = false;
    asking = null;
    if (windowNode) windowNode.inert = false;
    sheet.dataset.state = "closing";
    // The first run's shape stays until the sheet has faded, so it never turns into Settings on the way out.
    closing = setTimeout(() => { sheet.hidden = true; delete sheet.dataset.state; card.classList.remove("asking"); }, 120);
    document.querySelector("[data-input]")?.focus();
    onHide?.();
  }
  function go(name) {
    if (asking || name === section || !sections.includes(name)) return;
    section = name;
    data.error = null;
    scroller.scrollTop = 0;
    refresh();
    render({ entering: true });
  }
  function refresh() {
    // The status and the memories come back for every section.
    send({ type: "settings" });
    if (section === "model") { send({ type: "models" }); send({ type: "model-list" }); }
    if (section === "playback") {
      // Spotify's devices are asked for only while Spotify is the service in use.
      if (state.spotify === "ready" && (state.playbackService ?? "spotify") === "spotify") {
        data.devicesLoading = true;
        send({ type: "devices" });
      }
      // Whether Apple Music can play whole songs here can change outside the window, so Playback asks again.
      void appleMusic?.check().then(() => render());
    }
    if (section === "about" && !data.version) void window.moondogApp?.version?.().then((version) => { data.version = version; render(); });
    if (section === "appearance") void window.moondogApp?.appearance?.().then((value) => { data.appearance = value; render(); });
  }

  document.addEventListener("keydown", (event) => {
    if (!isOpen) return;
    // A sign-in waiting for an answer keeps the sheet, so a stray Escape cannot lose it. In the first
    // run, Escape skips the rest of it.
    if (event.key === "Escape") {
      if (!data.auth?.prompt) { event.preventDefault(); if (asking) asking.skip(); else hide(); }
      return;
    }
    const target = event.target;
    const step = { ArrowDown: 1, ArrowUp: -1, ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (!step || event.metaKey || event.altKey || event.ctrlKey) return;
    const vertical = event.key === "ArrowDown" || event.key === "ArrowUp";
    // The first run has one place, so the arrows go from the sheet straight to its rows.
    if (vertical && target === card && asking) {
      const rows = [...scroller.querySelectorAll(".choice-main:not(:disabled)")];
      const next = step > 0 ? rows[0] : rows.at(-1);
      if (next) { event.preventDefault(); next.focus(); }
    } else if (vertical && (target === card || target.closest?.(".sheet-nav"))) {
      event.preventDefault();
      const next = sections[Math.max(0, Math.min(sections.length - 1, sections.indexOf(section) + step))];
      go(next);
      tabs.get(next).tab.focus();
    } else if (vertical && target.classList?.contains("choice-main")) {
      const rows = [...scroller.querySelectorAll(".choice-main:not(:disabled)")];
      const next = rows[rows.indexOf(target) + step];
      if (next) { event.preventDefault(); next.focus(); }
    } else if (!vertical && target.parentElement?.getAttribute("role") === "radiogroup") {
      // Choices side by side, the segments and the app icons, move left and right.
      const options = [...target.parentElement.children];
      const next = options[options.indexOf(target) + step];
      if (!next) return;
      event.preventDefault();
      // The click redraws the section, so the focus goes to the redrawn choice.
      const key = next.dataset.key;
      next.click();
      card.querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus();
    }
  });

  // Small parts.
  const group = (title, ...children) => {
    const node = make("section", "group");
    if (title) node.append(make("h3", "group-title", title));
    node.append(...children.filter(Boolean));
    return node;
  };
  const note = (text) => make("p", "note", text);
  // The first run's question takes the place of the group's title; a mark for each of its steps
  // follows, the one on screen darker.
  const question = (key) => make("h2", "ask-title", say(key));
  const steps = () => {
    if (asking.of < 2) return null;
    const marks = make("div", "steps");
    marks.setAttribute("aria-hidden", "true");
    for (let at = 0; at < asking.of; at += 1) marks.append(make("i", at === asking.at ? "on" : ""));
    return marks;
  };
  // Something still on its way shows the working mark, never the word "Loading".
  const waiting = () => {
    const line = make("p", "note waiting");
    line.setAttribute("aria-label", say("loading"));
    line.append(scratchMark());
    return line;
  };
  // An error inside the sheet is announced, since the notice behind it is covered while the sheet is open.
  const alertLine = (text) => {
    const node = make("p", "alert");
    node.setAttribute("role", "alert");
    node.append(icon("info"), make("span", "", text));
    return node;
  };
  const failure = (key, params) => alertLine(say(key, params));
  const sectionError = () => (data.error && (!data.error.section || data.error.section === section) ? failure(data.error.key) : null);
  // A redraw rebuilds the open section. These fields keep what the listener is typing.
  function keptField(key, placeholder, secret = false) {
    const field = make("input", "text-field");
    field.type = secret ? "password" : "text";
    field.dataset.key = `field:${key}`;
    field.spellcheck = false;
    field.autocomplete = "off";
    field.placeholder = placeholder;
    field.setAttribute("aria-label", placeholder);
    field.value = data.drafts[key] ?? "";
    field.addEventListener("input", () => { data.drafts[key] = field.value; });
    return field;
  }
  // A field and its button on one row. The button waits until there is something to send.
  function inlineForm({ key, placeholder, action, primary = false, secret = false, onSubmit, after = [] }) {
    const form = make("form", "inline");
    const field = keptField(key, placeholder, secret);
    const submit = button(action, primary ? "button primary small" : "button small", null, `submit:${key}`);
    const sync = () => { submit.disabled = !field.value.trim(); };
    field.addEventListener("input", sync);
    sync();
    form.append(field, submit, ...after);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = field.value.trim();
      if (value) onSubmit(value, field, sync);
    });
    return form;
  }
  function choice({ label, detail, chosen, expanded, action, onChoose, trailing, disabled, key, lead, role = "radio", check = true }) {
    const item = make("div", `choice${disabled ? " off" : ""}`);
    const main = make("button", "choice-main");
    main.type = "button";
    main.dataset.key = key ?? `choice:${label}`;
    main.disabled = Boolean(disabled);
    // A row that opens a list says so; a row that picks one of several says whether it is the one.
    if (expanded !== undefined) main.setAttribute("aria-expanded", String(expanded));
    else if (!action) { main.setAttribute("role", role); main.setAttribute("aria-checked", String(Boolean(chosen))); }
    if (onChoose && !disabled) main.addEventListener("click", onChoose);
    if (lead) main.append(lead);
    const words = make("span", "choice-words");
    words.append(make("span", "choice-label", label));
    if (detail) words.append(make("span", "choice-detail", detail));
    main.append(words);
    // A row that does something rather than choosing something points the way it goes.
    if (action && !chosen) main.append(icon("chevron", "icon go"));
    item.append(main);
    if (trailing) item.append(trailing);
    // The check keeps one column down the right edge, after any button the row carries.
    if (chosen && check) (trailing ? item : main).append(icon("check", "icon check"));
    return item;
  }
  const choices = (rows, className = "choices") => {
    const list = make("div", className);
    list.append(...rows);
    return list;
  };
  // A value to paste elsewhere, with a button that copies it and says so for a moment.
  function copyChip(text, key, className = "chip", label = "") {
    const chip = make("div", className);
    if (label) { chip.setAttribute("role", "group"); chip.setAttribute("aria-label", label); }
    const value = make("code", "", text);
    const copy = make("button", "tool");
    copy.type = "button";
    copy.dataset.key = `copy:${key}`;
    const done = data.copied === key;
    copy.append(icon(done ? "check" : "copy"));
    name(copy, say(done ? "copied" : "copy"));
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(text);
      } catch (error) {
        // Without the clipboard, the value is selected so ⌘C copies it.
        warn("copy", error?.message);
        getSelection()?.selectAllChildren(value);
        return;
      }
      data.copied = key;
      setIcon(copy, "check");
      name(copy, say("copied"));
      clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => {
        data.copied = null;
        const shown = card.querySelector(`[data-key="copy:${CSS.escape(key)}"]`);
        if (shown) { setIcon(shown, "copy"); name(shown, say("copy")); }
      }, 1400);
    });
    chip.append(value, copy);
    return chip;
  }

  // Language: the list, the current one checked.
  function general() {
    const locales = state.locales ?? [];
    if (!locales.length) return [waiting()];
    const current = expected("locale", state.locale);
    // Each language under its own name, with its name in the window's language beneath when they differ.
    let names = null;
    try { names = new Intl.DisplayNames([languageTag(state.locale)], { type: "language", languageDisplay: "standard" }); } catch { /* The English names stand in. */ }
    const local = (entry) => { const said = names?.of(languageTag(entry.code)) ?? entry.name; return said === entry.nativeName ? null : said; };
    return [sectionError(), choices(locales.map((entry) => choice({ label: entry.nativeName, detail: local(entry),
      chosen: entry.code === current, key: `locale:${entry.code}`,
      onChoose: () => { expect("locale", entry.code); send({ type: "language", locale: entry.code }); render(); } })))].filter(Boolean);
  }

  // Appearance: the window's light, dark or the system's, and the icon the Dock shows. The app keeps
  // them, not the core, since they belong to this Mac's window rather than to the terminal.
  function appearance() {
    if (!data.appearance) return [waiting()];
    const choose = (next) => {
      data.appearance = { ...data.appearance, ...next };
      render();
      window.moondogApp.setAppearance(next).then((saved) => { data.appearance = saved; render(); },
        () => { data.error = { section: "appearance", key: "noticeFailed" }; render(); });
    };
    const themes = make("div", "segments");
    themes.setAttribute("role", "radiogroup");
    themes.setAttribute("aria-label", say("theme"));
    for (const [theme, label] of [["system", "themeSystem"], ["light", "themeLight"], ["dark", "themeDark"]]) {
      const chosen = data.appearance.theme === theme;
      const segment = button(say(label), "segment", () => { if (!chosen) choose({ theme }); }, `theme:${theme}`);
      segment.setAttribute("role", "radio");
      segment.setAttribute("aria-checked", String(chosen));
      segment.tabIndex = chosen ? 0 : -1;
      themes.append(segment);
    }
    // Each icon shows itself, drawn from the logo, and says its name in the tooltip. A hairline inside
    // the tile keeps the dark one's shape on a dark sheet; a ring of the same shape marks the chosen one.
    const icons = make("div", "icon-choices");
    icons.setAttribute("role", "radiogroup");
    icons.setAttribute("aria-label", say("appIcon"));
    for (const [kind, label] of [["light", "themeLight"], ["dark", "themeDark"]]) {
      const chosen = data.appearance.icon === kind;
      const id = `settings-icon-${kind}`;
      const option = button("", "icon-choice", () => { if (!chosen) choose({ icon: kind }); }, `icon:${kind}`);
      option.setAttribute("role", "radio");
      option.setAttribute("aria-checked", String(chosen));
      option.tabIndex = chosen ? 0 : -1;
      name(option, say(label));
      option.innerHTML = appIconSvg({ dark: kind === "dark", id })
        + `<svg class="icon-marks" viewBox="0 0 1024 1024"><clipPath id="${id}-inside"><path d="${iconShape()}"/></clipPath>`
        + `<path class="icon-edge" d="${iconShape()}" clip-path="url(#${id}-inside)"/><path class="icon-ring" d="${iconShape(RING)}"/></svg>`;
      icons.append(option);
    }
    return [sectionError(), group(say("theme"), themes), group(say("appIcon"), icons)].filter(Boolean);
  }

  function signInPanel() {
    const auth = data.auth;
    const panel = make("div", "auth");
    const head = make("div", "auth-head");
    head.append(make("p", "auth-title", say("signingIn", { provider: auth.providerName ?? auth.provider })),
      button(say("cancel"), "button quiet small", () => { send({ type: "sign-in-cancel" }); data.auth = null; render(); }, "auth:cancel"));
    panel.append(head);
    // The provider's own words, when it sends any, say more than a generic line.
    const line = auth.info ?? (auth.status ? say(auth.status) : null);
    if (line) panel.append(make("p", "auth-line", line));
    if (auth.code) panel.append(copyChip(auth.code, "device-code", "chip code"));
    if (auth.url) panel.append(link(say("openSignInPage"), auth.url));
    const prompt = auth.prompt;
    if (prompt?.kind === "select") {
      panel.append(make("p", "auth-line", prompt.message), choices((prompt.options ?? []).map((option) => choice({ label: option.label, detail: option.description,
        action: true, key: `auth-option:${option.id}`,
        onChoose: () => { send({ type: "auth-answer", id: prompt.id, value: option.id }); auth.prompt = null; auth.status = "checking"; auth.info = null; render(); } }))));
    } else if (prompt) {
      const form = make("form", "inline");
      const field = make("input", "text-field");
      field.type = prompt.kind === "secret" ? "password" : "text";
      field.placeholder = prompt.placeholder ?? "";
      field.autocomplete = "off";
      field.spellcheck = false;
      field.setAttribute("aria-label", prompt.message ?? "");
      field.dataset.key = `auth-field:${prompt.id}`;
      // A redraw keeps what was typed; the answer itself goes to the core only.
      field.value = prompt.draft ?? "";
      field.addEventListener("input", () => { prompt.draft = field.value; });
      form.append(field, button(say("continue"), "button primary small", null, `auth-submit:${prompt.id}`));
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        send({ type: "auth-answer", id: prompt.id, value: field.value });
        field.value = "";
        prompt.draft = "";
        auth.prompt = null;
        auth.status = "checking";
        auth.info = null;
        render();
      });
      if (prompt.message) panel.append(make("p", "auth-line", prompt.message));
      panel.append(form);
      if (!prompt.focused) {
        prompt.focused = true;
        requestAnimationFrame(() => field.focus());
      }
    }
    return panel;
  }

  // Model: the models the menu offers, the default among them and how hard it thinks, then where
  // models come from: OpenAI by a ChatGPT subscription or an API key, Anthropic, Google and xAI by key,
  // and any other service as an endpoint by its address. A sign-in, or an endpoint being edited,
  // takes the whole place while it runs.
  const sameModel = (left, right) => Boolean(left && right) && left.provider === right.provider && left.model === right.model;
  const modelKey = (entry) => `${entry.provider}:${entry.model}`;
  // A default or a thinking level stands until the core sends the list again.
  const expectList = (kind, value) => data.listPending.set(kind, value);
  const listExpected = (kind, actual) => (data.listPending.has(kind) ? data.listPending.get(kind) : actual);
  const effortLabel = (level) => (level === "default" ? say("effortDefault") : say(`effort.${level}`));
  function model() {
    if (data.auth && data.auth.provider !== "spotify") return [group(null, signInPanel())];
    if (data.endpoint) return [group(say(data.endpoint.id ? "editEndpoint" : "addEndpoint"), endpointForm())];
    const saved = data.list?.default ?? null;
    const chosen = listExpected("default", saved && { provider: saved.provider, model: saved.model });
    // The first run asks for a model over the same providers; a model chosen there is the default.
    if (asking) return [question("firstRunModel"), sectionError(), group(null, providerList(chosen)), steps()].filter(Boolean);
    const parts = [sectionError(), group(say("models"), menuList(chosen))];
    if (saved?.reasoning && sameModel(chosen, saved)) parts.push(group(say("effort"), efforts(saved)));
    parts.push(group(say("providers"), providerList(chosen)));
    return parts.filter(Boolean);
  }
  // The menu's models as they will be once the core confirms what was just ticked.
  function menuModels() {
    const shown = (data.list?.models ?? []).filter((entry) => data.toggles.get(modelKey(entry))?.listed !== false);
    for (const { entry, listed } of data.toggles.values()) if (listed && !shown.some((kept) => sameModel(kept, entry))) shown.push(entry);
    return shown;
  }
  const isListed = (entry) => data.toggles.get(modelKey(entry))?.listed ?? (data.list?.models ?? []).some((kept) => sameModel(kept, entry));
  function toggle(entry, listed) {
    data.toggles.set(modelKey(entry), { entry, listed });
    send({ type: "list-model", provider: entry.provider, model: entry.model, listed });
    render();
  }
  // A row makes its model the default; the default says so, and the others can leave the menu.
  function menuList(chosen) {
    if (!data.list) return waiting();
    if (data.listError) return failure("noticeFailed");
    const models = menuModels();
    if (!models.length) return note(say("noModels"));
    return choices(models.map((entry) => {
      const isDefault = sameModel(entry, chosen);
      let trailing = make("span", "choice-tag", say("default"));
      if (!isDefault) {
        trailing = make("button", "tool choice-remove");
        trailing.type = "button";
        trailing.dataset.key = `unlist:${modelKey(entry)}`;
        trailing.append(icon("close"));
        name(trailing, say("removeFromMenu"));
        trailing.addEventListener("click", () => toggle(entry, false));
      }
      return choice({ label: entry.name ?? entry.model, detail: entry.ready === false ? `${entry.providerName} · ${say("notConnected")}` : entry.providerName,
        chosen: isDefault, check: false, disabled: entry.ready === false && !isDefault, trailing, key: `menu:${modelKey(entry)}`,
        onChoose: isDefault ? null : () => chooseDefault(entry) });
    }));
  }
  function chooseDefault(entry) {
    expectList("default", { provider: entry.provider, model: entry.model });
    send({ type: "default-model", provider: entry.provider, model: entry.model });
    render();
  }
  // The same scale for every model that thinks. A level the default model lacks shows the one it gets.
  function efforts(saved) {
    const asked = saved.effort ?? "default";
    const chosen = listExpected("effort", asked);
    const track = make("div", "segments");
    track.setAttribute("role", "radiogroup");
    track.setAttribute("aria-label", say("effort"));
    for (const level of ["default", ...EFFORTS]) {
      const gets = level === chosen && chosen === asked && saved.thinking && saved.thinking !== level ? saved.thinking : null;
      const segment = button(gets ? `${effortLabel(level)} → ${effortLabel(gets)}` : effortLabel(level), "segment", () => {
        if (chosen === level) return;
        expectList("effort", level);
        send({ type: "default-effort", effort: level });
        render();
      }, `effort:${level}`);
      segment.setAttribute("role", "radio");
      segment.setAttribute("aria-checked", String(chosen === level));
      // One stop for the group; the arrow keys move inside it.
      segment.tabIndex = chosen === level ? 0 : -1;
      track.append(segment);
    }
    return track;
  }
  // Where models come from. OpenAI is one row with its two ways in; every provider opens to its
  // models, each ticked when the menu offers it.
  function providerList(chosen) {
    if (!data.providers) return waiting();
    if (data.providersError) return failure("noProviders");
    const usable = data.providers.filter((provider) => provider.signedIn === true || provider.signIn !== "environment_only");
    const rows = [];
    for (const provider of usable) {
      const expanded = data.expanded === provider.id;
      // OpenAI opens to its two ways in, a ChatGPT subscription or an API key, over its models.
      if (provider.chatgpt) {
        rows.push(choice({ label: provider.name, detail: provider.signedIn ? say(provider.method === "oauth" ? "chatgpt" : "apiKey") : null, expanded,
          key: `provider:${provider.id}`, lead: icon("chevron", "icon disclose"), onChoose: () => { data.expanded = expanded ? null : provider.id; render(); } }));
        if (expanded) {
          const ways = ["oauth", "api_key"].map((method) => way({ label: say(method === "oauth" ? "chatgpt" : "apiKey"),
            detail: provider.method === method ? accessDetail(provider) : null, trailing: access(provider, method) }));
          rows.push(choices([...ways, ...(provider.signedIn ? [modelList(provider, chosen)] : [])], "choices inner"));
        }
        continue;
      }
      rows.push(choice({ label: provider.name, detail: provider.endpoint ? host(provider.endpoint.baseUrl) : accessDetail(provider), expanded,
        trailing: access(provider), key: `provider:${provider.id}`, lead: icon("chevron", "icon disclose"),
        onChoose: () => { data.expanded = expanded ? null : provider.id; render(); } }));
      if (expanded) rows.push(modelList(provider, chosen));
    }
    rows.push(choice({ label: say("addEndpoint"), action: true, key: "endpoint:add", lead: icon("plus", "icon lead"), onChoose: () => editEndpoint(null) }));
    return choices(rows);
  }
  // A way in under its provider: words and what can be done about it, with nothing to choose.
  function way({ label, detail, trailing }) {
    const item = make("div", "choice static");
    const words = make("span", "choice-words");
    words.append(make("span", "choice-label", label));
    if (detail) words.append(make("span", "choice-detail", detail));
    const main = make("div", "choice-main");
    main.append(words);
    item.append(main);
    if (trailing) item.append(trailing);
    return item;
  }
  const host = (address) => { try { return new URL(address).host; } catch { return address; } };
  // A key from the environment can't be removed here; it says where it comes from instead.
  const accessDetail = (provider) => (provider.signedIn && provider.source !== "saved" && provider.signIn !== "endpoint" ? say("signedIn") : null);
  // What each row can do about its way in: sign in or out of ChatGPT, add or remove a key, edit an endpoint.
  // OpenAI keeps one of its two at a time, so signing in one way replaces the other.
  function access(provider, method = provider.signIn) {
    if (provider.signIn === "endpoint") return button(say("editMessage"), "button quiet small", () => editEndpoint(provider), `endpoint:edit:${provider.id}`);
    const oauth = method === "oauth";
    if (provider.signedIn && (!provider.chatgpt || provider.method === method)) {
      if (provider.source !== "saved") return null;
      const node = button(say(oauth ? "signOut" : "removeKey"), "button quiet small", () => {
        data.signingOut.add(provider.id);
        send({ type: "sign-out", provider: provider.id });
        render();
      }, `sign-out:${provider.id}:${method}`);
      node.disabled = data.signingOut.has(provider.id);
      return node;
    }
    const node = button(say(oauth ? "signIn" : "addKey"), "button small", () => {
      data.error = null;
      data.auth = { provider: provider.id, providerName: oauth ? "ChatGPT" : provider.name, status: null, info: null };
      send({ type: "sign-in", provider: provider.id, method });
      render();
    }, `sign-in:${provider.id}:${method}`);
    // One sign-in at a time; the core would refuse a second.
    node.disabled = Boolean(data.auth);
    return node;
  }
  // Each provider's models are asked for once; the renderer asks for the signed-in ones on its own.
  const requested = new Set();
  function wantModels(provider) {
    if (provider.signedIn !== true || data.models.has(provider.id) || requested.has(provider.id)) return;
    requested.add(provider.id);
    send({ type: "provider-models", provider: provider.id });
  }
  function modelList(provider, chosen) {
    wantModels(provider);
    const models = data.models.get(provider.id);
    const retry = () => { data.modelsFailed.delete(provider.id); requested.delete(provider.id); wantModels(provider); render(); };
    const inner = provider.signedIn !== true ? [note(say("addKeyFirst"))]
      : data.modelsFailed.has(provider.id) ? [failure("noticeFailed"), button(say("tryAgain"), "button quiet small", retry, `retry:${provider.id}`)]
        : !models ? [waiting()]
          : models.map((model) => {
            const entry = { provider: provider.id, model: model.id, name: model.name ?? model.id, providerName: provider.name, ready: true };
            const isDefault = sameModel(entry, chosen);
            const listed = isDefault || isListed(entry);
            // In the first run a model row picks the one Moondog answers with; otherwise it ticks the menu.
            if (asking) return choice({ label: entry.name, chosen: isDefault, key: `model:${modelKey(entry)}`, onChoose: isDefault ? null : () => chooseDefault(entry) });
            return choice({ label: entry.name, detail: isDefault ? say("default") : null, chosen: listed, role: "checkbox", key: `model:${modelKey(entry)}`,
              onChoose: isDefault ? null : () => toggle(entry, !listed) });
          });
    return choices(inner, "choices inner");
  }
  // An endpoint: a name, its address, the format it speaks, a key if it takes one, and its model IDs,
  // which the endpoint is asked for when left empty.
  function editEndpoint(provider) {
    data.error = null;
    data.endpoint = { id: provider?.id ?? null, format: provider?.endpoint?.format ?? "openai", keySaved: provider?.endpoint?.keySaved === true, busy: false, error: null };
    Object.assign(data.drafts, { endpointName: provider?.name ?? "", endpointUrl: provider?.endpoint?.baseUrl ?? "", endpointKey: "",
      endpointModels: provider?.endpoint?.models?.join(", ") ?? "" });
    data.focus = "field:endpointName";
    render();
  }
  function endpointForm() {
    const shown = data.endpoint;
    const form = make("form", "endpoint");
    const field = (key, label, placeholder, secret = false) => {
      const row = make("label", "entry");
      row.append(make("span", "entry-label", label), keptField(key, placeholder, secret));
      return row;
    };
    const formats = make("div", "segments");
    formats.setAttribute("role", "radiogroup");
    formats.setAttribute("aria-label", say("endpointFormat"));
    for (const [format, label] of [["openai", "OpenAI"], ["anthropic", "Anthropic"]]) {
      const segment = button(label, "segment", () => { shown.format = format; render(); }, `endpoint-format:${format}`);
      segment.setAttribute("role", "radio");
      segment.setAttribute("aria-checked", String(shown.format === format));
      segment.tabIndex = shown.format === format ? 0 : -1;
      formats.append(segment);
    }
    const formatRow = make("div", "entry");
    formatRow.append(make("span", "entry-label", say("endpointFormat")), formats);
    const save = button(say("save"), "button primary small", null, "endpoint:save");
    const sync = () => { save.disabled = shown.busy || !data.drafts.endpointName.trim() || !data.drafts.endpointUrl.trim(); };
    const actions = make("div", "actions");
    actions.append(save, button(say("cancel"), "button quiet small", () => { data.endpoint = null; render(); }, "endpoint:cancel"));
    if (shown.id) {
      const remove = button(say("removeEndpoint"), "button quiet small end", () => {
        send({ type: "endpoint-remove", id: shown.id });
        data.models.delete(shown.id);
        data.endpoint = null;
        data.expanded = null;
        render();
      }, "endpoint:remove");
      remove.disabled = shown.busy;
      actions.append(remove);
    }
    if (shown.busy) actions.append(turning());
    form.append(field("endpointName", say("endpointName"), "DeepSeek"), field("endpointUrl", say("endpointUrl"), "https://api.deepseek.com"), formatRow,
      field("endpointKey", say("endpointKey"), say(shown.keySaved ? "keyKept" : "keyOptional"), true),
      field("endpointModels", say("endpointModels"), say("modelsAsk")));
    if (shown.error) form.append(failure(shown.error));
    form.append(actions);
    form.addEventListener("input", sync);
    sync();
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (save.disabled) return;
      shown.busy = true;
      shown.error = null;
      send({ type: "endpoint-save", endpoint: { ...(shown.id ? { id: shown.id } : {}), name: data.drafts.endpointName.trim(), baseUrl: data.drafts.endpointUrl.trim(),
        format: shown.format, key: data.drafts.endpointKey.trim(), models: data.drafts.endpointModels } });
      render();
    });
    return form;
  }

  // Playback: one row per music service, its state under its name and the one in use checked. A click
  // on a row unfolds what the service has: its setup, or its own controls, such as Spotify's devices.
  // One row is open at a time, and the service in use starts open. At a row's right, while the pointer
  // is on it, a service that can play has a switch that uses it, and one that can't yet has Set up.
  // Other sources of music get groups of their own beside this one.
  function playback() {
    if (asking) return firstRunServices();
    const service = expected("service", state.playbackService ?? "spotify");
    const spotifyReady = expected("spotify", state.spotify) === "ready";
    const neteaseReady = state.netease === "ready";
    // Whole Apple Music songs need the listener's permission once; until then, and without it, previews play.
    const whole = appleMusic?.status();
    const canAllowWhole = whole?.authorization === "notDetermined" && whole.reason !== "developerTokenRequestFailed";
    const rows = [
      { id: "spotify", label: "Spotify", detail: say(spotifyReady ? "connected" : "notConnected"), playable: spotifyReady },
      { id: "apple_music", label: "Apple Music", detail: say(whole?.canPlay ? "fullSongs" : "appleMusicNote"), playable: true, empty: !canAllowWhole },
      { id: "netease", label: say("netease"), detail: say(neteaseReady ? "signedIn" : NETEASE_STATES[state.netease] ?? "checking"), playable: neteaseReady },
    ];
    const actions = (...buttons) => {
      const line = make("div", "actions");
      line.append(...buttons.filter(Boolean));
      return line;
    };
    const inside = {
      spotify: () => (data.auth?.provider === "spotify" ? [signInPanel()]
        : !spotifyReady ? [data.auth ? note(say("signInBusy")) : connectSpotify()]
          : [service === "spotify" ? devices() : null, actions(button(say("disconnect"), "button quiet small", () => {
            expect("spotify", "unavailable");
            send({ type: "sign-out", provider: "spotify" });
            render();
          }, "spotify:disconnect"))]),
      apple_music: () => [actions(button(say("allowFullSongs"), "button small", () => {
        void appleMusic.check("authorize").then(() => render());
      }, "apple-music:allow"))],
      // NetEase's searches send NetEase a short summary of the request, which its row says before it is used.
      netease: () => (neteaseReady ? [note(say("neteaseNote"))] : [setUpNetease()]),
    };
    const open = data.servicePanel !== undefined ? data.servicePanel : data.auth?.provider === "spotify" ? "spotify" : service;
    const list = [];
    for (const row of rows) {
      const expanded = !row.empty && open === row.id;
      let trailing = null;
      if (row.playable && row.id !== service) {
        trailing = make("button", "tool reveal");
        trailing.type = "button";
        trailing.dataset.key = `use:${row.id}`;
        trailing.append(icon("switch"));
        name(trailing, say("useService", { service: row.label }));
        trailing.addEventListener("click", () => {
          expect("service", row.id);
          send({ type: "music-service", service: row.id });
          // Spotify's devices are read afresh once it is in use.
          if (row.id === "spotify") data.devices = null;
          render();
        });
      } else if (!row.playable) {
        trailing = button(say("setUp"), "button small reveal", () => { data.servicePanel = row.id; render(); }, `set-up:${row.id}`);
      }
      list.push(choice({ label: row.label, detail: row.detail, chosen: service === row.id, key: `service:${row.id}`, trailing,
        ...(row.empty ? {} : { expanded, onChoose: () => { data.servicePanel = expanded ? null : row.id; render(); } }) }));
      if (!expanded) continue;
      const panel = make("div", "panel");
      panel.append(...inside[row.id]().filter(Boolean));
      list.push(panel);
    }
    return [group(say("musicService"), sectionError(), choices(list))];
  }
  // The first run asks before any service is saved, so none is checked, and choosing the one in use
  // saves it too. Each service leads with its own mark, the one the composer shows beside send once it
  // is chosen, and a click chooses it and moves on instead of unfolding it. Spotify can be chosen
  // before it is connected; NetEase is offered only once it is ready, since the core refuses it until
  // then. Spotify's account and NetEase's setup wait for Settings.
  function firstRunServices() {
    const whole = appleMusic?.status();
    const pick = (service) => () => { send({ type: "music-service", service }); asking.answer("playback"); };
    const services = choices([
      choice({ label: "Spotify", detail: say(expected("spotify", state.spotify) === "ready" ? "connected" : "notConnected"),
        key: "service:spotify", lead: icon("spotify", "icon fill mark"), onChoose: pick("spotify") }),
      choice({ label: "Apple Music", detail: say(whole?.canPlay ? "fullSongs" : "appleMusicNote"),
        key: "service:apple_music", lead: icon("apple-music", "icon fill mark"), onChoose: pick("apple_music") }),
      ...(state.netease === "ready" ? [choice({ label: say("netease"), detail: say("neteaseNote"),
        key: "service:netease", lead: icon("netease", "icon fill mark"), onChoose: pick("netease") })] : []),
    ]);
    return [question("firstRunService"), sectionError(), services, steps()].filter(Boolean);
  }
  // NetEase is set up in Terminal with its own tool, then checked again here. A check that still
  // doesn't find it ready says why, so the listener sees that it ran.
  function setUpNetease() {
    const signIn = state.netease === "signed_out";
    const checking = data.neteaseCheck === "checking";
    const again = button(say(checking ? "checking" : "checkAgain"), "button small", () => {
      data.neteaseCheck = "checking";
      send({ type: "netease-check" });
      render();
    }, "netease:check");
    again.disabled = checking;
    const why = data.neteaseCheck !== "done" ? null
      : state.netease === "unavailable" && state.neteaseMessage ? alertLine(state.neteaseMessage)
        : failure(signIn ? "neteaseSignedOut" : "neteaseNotFound");
    const stack = make("div", "stack");
    stack.append(note(say(signIn ? "neteaseSignIn" : "neteaseSetup")), copyChip(signIn ? "ncm-cli login" : NETEASE_SETUP, "netease", "chip", say("netease")),
      again, ...(why ? [why] : []));
    return stack;
  }
  function connectSpotify() {
    const start = (clientId) => {
      data.error = null;
      data.drafts.spotifyClientId = "";
      data.auth = { provider: "spotify", providerName: "Spotify", status: "openingBrowser", info: null };
      send({ type: "sign-in", provider: "spotify", ...(clientId ? { clientId } : {}) });
      render();
    };
    const stack = make("div", "stack");
    if (state.spotifyAccount?.clientId) {
      stack.append(button(say("connectSpotify"), "button primary", () => start(null), "spotify:connect"));
      return stack;
    }
    // Spotify wants each listener's own app. The note links to where it is made.
    const text = say("spotifyNeedsApp");
    const words = make("p", "note");
    const at = text.indexOf("developer.spotify.com");
    if (at < 0) words.textContent = text;
    else {
      const site = make("a", "", "developer.spotify.com");
      site.href = SPOTIFY_DASHBOARD;
      site.target = "_blank";
      site.rel = "noreferrer";
      words.append(text.slice(0, at), site, text.slice(at + "developer.spotify.com".length));
    }
    stack.append(words, copyChip(REDIRECT_URI, "redirect", "chip", say("redirectUri")),
      inlineForm({ key: "spotifyClientId", placeholder: say("spotifyClientId"), action: say("connectSpotify"), primary: true, onSubmit: (clientId) => start(clientId) }));
    return stack;
  }
  // Spotify's devices, in its row while it is the service in use. Unread ones are asked for once.
  function devices() {
    if (!data.devices && !data.devicesLoading) {
      data.devicesLoading = true;
      send({ type: "devices" });
    }
    const head = make("div", "group-head");
    const again = make("button", "tool");
    again.type = "button";
    again.dataset.key = "devices:refresh";
    again.append(icon("refresh"));
    name(again, say("refresh"));
    again.addEventListener("click", () => { data.devicesLoading = true; send({ type: "devices" }); render(); });
    head.append(make("h4", "group-title", say("devices")), again);
    const list = !data.devices ? waiting()
      : data.devicesLimitedUntil ? failure("spotifyLimited", { time: timeOfDay(data.devicesLimitedUntil, state.locale) })
        : data.devicesError ? failure("noticeDevicesFailed")
        : !data.devices.length ? note(say("noDevices"))
          : choices(data.devices.map((device) => choice({ label: device.name, chosen: device.active, disabled: device.restricted,
            key: `device:${device.ref}`, lead: icon(DEVICE_ICONS[String(device.type).toLowerCase()] ?? "speaker", "icon kind"),
            onChoose: () => {
              if (device.active) return;
              send({ type: "transfer", ref: device.ref });
              // Spotify reports the new device late, so the check moves now.
              data.devices = data.devices.map((entry) => ({ ...entry, active: entry.ref === device.ref }));
              render();
            } })));
    const part = make("div", "part");
    part.append(head, list);
    return part;
  }

  // Import: two ways in, then Last.fm by name. The core reads first and saves only what is added.
  const importLine = (job) => (job.stage === "saving" ? say("importSaving")
    : job.count ? say("importReadingCount", { count: Number(job.count).toLocaleString(state.locale) }) : say("importReading"));
  function library() {
    const job = data.importing;
    if (job && ["reading", "progress", "saving"].includes(job.stage)) {
      // The import's mark keeps the offset it started with, so a redraw draws the same mark and keeps the one already moving.
      data.phaseOffset ??= Math.round(performance.now() % SCRATCH_MS);
      const line = make("div", "working");
      const words = make("span", "", importLine(job));
      words.dataset.progressText = "";
      line.append(scratchMark(data.phaseOffset), words);
      if (job.stage !== "saving") line.append(button(say("stop"), "button quiet small", () => send({ type: "import-cancel" }), "import:stop"));
      return [line];
    }
    data.phaseOffset = null;
    if (job?.stage === "preview") return preview(job);
    const parts = [];
    // A missing Last.fm key is not a failure to report: the key field that replaces the username says what to do.
    if (job?.stage === "error" && job.code !== "lastfm_key_missing") parts.push(failure(IMPORT_ERRORS[job.code] ?? "importFailed"));
    const spotifyReady = state.spotify === "ready";
    parts.push(choices([
      choice({ label: say("importSpotifyQuick"), detail: say(spotifyReady ? "importSpotifyQuickNote" : "connectSpotifyFirst"), action: true,
        disabled: !spotifyReady, key: "import:spotify", onChoose: () => send({ type: "import-spotify" }) }),
      choice({ label: say("importFile"), detail: say("importFileNote"), action: true, key: "import:file", onChoose: async () => {
        const path = await window.moondogApp?.chooseFile?.({ title: say("importFile"), filterName: say("musicHistoryFiles") });
        if (path) send({ type: "import-file", path });
      } }),
    ]));
    parts.push(data.lastfm.needsKey ? lastfmKey() : inlineForm({ key: "lastfm", placeholder: say("lastfmUsername"), action: say("continue"),
      onSubmit: (username) => { data.lastfm.username = username; send({ type: "import-lastfm", username }); } }));
    return parts;
  }
  // Reading Last.fm needs an API key on this computer. Once it is saved, the same username is read again.
  function lastfmKey() {
    const stack = make("div", "stack");
    if (data.lastfm.keyError) stack.append(failure("noticeFailed"));
    const form = inlineForm({ key: "lastfmKey", placeholder: say("lastfmKey"), action: say("save"), after: [link("last.fm/api", LASTFM_KEY_PAGE)],
      onSubmit: (key) => { data.lastfm.savingKey = true; data.lastfm.keyError = false; send({ type: "lastfm-key", key }); render(); } });
    if (data.lastfm.savingKey) form.querySelector("button").disabled = true;
    stack.append(form);
    return stack;
  }
  function preview(job) {
    // The words come from the core, written as the terminal writes them.
    const { title, paragraphs = [], empty } = job.preview ?? {};
    const parts = [make("h3", "preview-title", title ?? say("importHistory"))];
    if (empty) parts.push(make("p", "facts-empty", say("importEmpty")));
    else {
      const facts = make("ul", "facts");
      for (const paragraph of paragraphs) if (paragraph) facts.append(make("li", "", paragraph));
      parts.push(facts);
    }
    const actions = make("div", "actions");
    if (!empty) actions.append(button(say("addToProfile"), "button primary", () => send({ type: "import-commit" }), "import:commit"));
    actions.append(button(say("cancel"), "button quiet", () => { send({ type: "import-cancel" }); data.importing = null; render(); }, "import:back"));
    if (job.error) parts.push(failure(job.error));
    parts.push(actions);
    return parts;
  }

  // Memory: what Moondog keeps about the listener, and a way to add or forget a line.
  function memory() {
    const form = inlineForm({ key: "remember", placeholder: say("rememberPlaceholder"), action: say("remember"),
      onSubmit: (text, field, sync) => {
        send({ type: "remember", text });
        data.drafts.remember = "";
        field.value = "";
        sync();
        field.focus();
      } });
    const list = !data.memories ? waiting()
      : !data.memories.length ? note(say("noMemories"))
        : choices(data.memories.map((entry) => {
          const item = make("div", "memory");
          item.append(make("p", "", entry.text), button(say("forget"), "button quiet small", () => {
            // The line goes at once; the core's list follows. The focus moves to the next line's Forget.
            const at = data.memories.findIndex((other) => other.id === entry.id);
            const next = data.memories[at + 1] ?? data.memories[at - 1];
            data.memories = data.memories.filter((other) => other.id !== entry.id);
            send({ type: "forget", id: entry.id });
            render();
            card.querySelector(`[data-key="${CSS.escape(next ? `forget:${next.id}` : "field:remember")}"]`)?.focus();
          }, `forget:${entry.id}`));
          return item;
        }), "choices memories");
    return [group(null, form), group(null, list)];
  }

  function about() {
    const title = make("p", "about-name", "Moondog");
    if (data.version) title.append(make("span", "", ` ${data.version}`));
    const keys = make("dl", "keys");
    keys.style.gridTemplateRows = `repeat(${Math.ceil(SHORTCUTS.length / 2)}, auto)`;
    for (const [combo, label] of SHORTCUTS) {
      const pair = make("div", "key");
      const term = make("dt");
      term.append(make("kbd", "", combo));
      pair.append(term, make("dd", "", say(label)));
      keys.append(pair);
    }
    return [group(null, title, link(SITE.replace("https://", ""), SITE)), group(say("shortcuts"), keys)];
  }

  function render({ entering = false } = {}) {
    if (!isOpen) return;
    // The first run has no places to go to; its close button skips the rest and says so.
    card.classList.toggle("asking", Boolean(asking));
    card.setAttribute("aria-label", say(asking ? (asking.step === "model" ? "firstRunModel" : "firstRunService") : "settings"));
    if (asking) name(close, say("skipSetup"), "esc");
    else { close.setAttribute("aria-label", say("close")); delete close.dataset.tip; delete close.dataset.keys; }
    for (const [id, { tab, label }] of tabs) {
      label.textContent = say(`section.${id}`);
      tab.classList.toggle("on", id === section);
      tab.setAttribute("aria-current", String(id === section));
    }
    const active = document.activeElement;
    const focused = card.contains(active) ? active.dataset.key : null;
    const wanted = data.focus;
    data.focus = null;
    const fresh = make("div", `sheet-section${entering ? " entering" : ""}`);
    fresh.dataset.section = section;
    const views = { general, appearance, model, playback, library, memory, about };
    fresh.append(...views[section]());
    // The core often repeats itself. An unchanged section keeps its nodes, so the row under the
    // pointer and the field being typed in are never replaced. Passing states, such as the refresh
    // turning, are set on both before they are compared, so they alone never cause a redraw.
    for (const root of [content, fresh]) root?.querySelector('[data-key="devices:refresh"]')?.classList.toggle("spinning", data.devicesLoading);
    if (!entering && content?.dataset.section === section && content.isConnected && content.innerHTML === fresh.innerHTML) return;
    if (content?.isConnected) content.replaceWith(fresh); else scroller.replaceChildren(fresh);
    content = fresh;
    // A field that takes the place of the one being typed in takes its focus too.
    const handoff = wanted && card.querySelector(`[data-key="${CSS.escape(wanted)}"]`);
    if (handoff && (!focused || !card.querySelector(`[data-key="${CSS.escape(focused)}"]`))) { handoff.focus({ preventScroll: true }); return; }
    if (!focused) return;
    // A key shared by several controls is not restored, so the focus never lands on another item's button.
    const matches = card.querySelectorAll(`[data-key="${CSS.escape(focused)}"]`);
    if (matches.length === 1 && !matches[0].disabled) matches[0].focus({ preventScroll: true });
    else if (!card.contains(document.activeElement)) tabs.get(section).tab.focus({ preventScroll: true });
  }

  // Reading progress changes many times a second; only its words change.
  function patchProgress() {
    const words = scroller.querySelector("[data-progress-text]");
    if (!words || section !== "library") return false;
    words.textContent = importLine(data.importing);
    return true;
  }

  // Messages from the core that this sheet draws.
  function receive(message) {
    if (message.type === "models") {
      data.providers = message.providers ?? [];
      data.providersError = Boolean(message.error);
      data.signingOut.clear();
      warn("providers", message.error);
    }
    if (message.type === "provider-models") { data.models.set(message.provider, message.models ?? []); data.modelsFailed.delete(message.provider); }
    if (message.type === "model-list") {
      data.list = { models: message.models ?? [], default: message.default ?? null };
      data.listError = Boolean(message.error);
      data.toggles.clear();
      data.listPending.clear();
      warn("model list", message.error);
    }
    // A saved endpoint opens to its models; a refused one keeps the form with what to fix.
    if (message.type === "endpoint") {
      if (message.state === "saved") {
        data.endpoint = null;
        if (message.id) { data.models.delete(message.id); requested.delete(message.id); data.expanded = message.id; }
      } else if (data.endpoint) {
        data.endpoint.busy = false;
        data.endpoint.error = ENDPOINT_ERRORS[message.code] ?? "endpointFailed";
        warn("endpoint", message.message);
      }
    }
    if (message.type === "devices") {
      data.devices = message.devices ?? [];
      data.devicesError = Boolean(message.error);
      data.devicesLimitedUntil = message.error === "limited" ? message.resumeAt : null;
      data.devicesLoading = false;
      warn("devices", message.error);
    }
    if (message.type === "memories") data.memories = message.memories ?? [];
    if (message.type === "netease-checked") data.neteaseCheck = "done";
    if (message.type === "auth-prompt" && data.auth) {
      data.auth.prompt = { id: message.id, kind: message.kind, message: message.message, placeholder: message.placeholder, options: message.options };
    }
    if (message.type === "auth-prompt-closed" && data.auth?.prompt?.id === message.id) data.auth.prompt = null;
    if (message.type === "auth-event" && data.auth) {
      if (message.kind === "auth_url") {
        data.auth.url = message.url;
        if (!message.opened) window.open(message.url, "_blank");
        data.auth.status = "finishInBrowser";
        data.auth.info = null;
      }
      if (message.kind === "device_code") { data.auth.code = message.userCode; data.auth.url = message.url; data.auth.status = "enterCode"; data.auth.info = null; }
      if (message.kind === "info" || message.kind === "progress") data.auth.info = message.message || null;
    }
    // A refused second sign-in leaves the running one on screen; any other end clears its own panel.
    if (message.type === "sign-in" && message.code !== "sign_in_busy") {
      if (!data.auth || data.auth.provider === message.provider) data.auth = null;
      const where = message.provider === "spotify" ? "playback" : "model";
      data.error = message.state === "error" ? { section: where, key: SIGN_IN_ERRORS[message.code] ?? "signInFailed" } : null;
      if (message.state === "error") warn("sign-in", message.message);
      // Spotify reads as connected while the core rebuilds with it.
      if (message.provider === "spotify" && message.state === "done") { expect("spotify", "ready"); data.devices = null; }
      // A provider just signed in to opens to its models, so its first model is one click away.
      if (message.provider !== "spotify" && message.state === "done") { data.expanded = message.provider; data.models.delete(message.provider); requested.delete(message.provider); }
      send({ type: "models" });
    }
    if (message.type === "import") {
      const stage = message.stage;
      const shown = data.importing;
      if (stage === "progress") {
        data.importing = { ...shown, stage: "progress", count: message.count };
        if (isOpen && patchProgress()) return;
      } else if (stage === "cancelled") data.importing = null;
      else if (stage === "saving") data.importing = { stage, preview: shown?.preview };
      else if (stage === "error") {
        warn("import", message.message);
        if (LASTFM_ACCESS.has(message.code)) { data.lastfm.needsKey = true; data.lastfm.savingKey = false; data.focus = "field:lastfmKey"; }
        // A failed save keeps its preview, so the listener can add it again once the reply ends.
        data.importing = shown?.preview ? { stage: "preview", preview: shown.preview, error: IMPORT_ERRORS[message.code] ?? "importFailed" } : { ...message };
      } else if (stage === "lastfm-key-saved") {
        data.lastfm = { ...data.lastfm, needsKey: false, savingKey: false, keyError: false };
        data.drafts.lastfmKey = "";
        if (data.lastfm.username) send({ type: "import-lastfm", username: data.lastfm.username });
      } else if (stage !== "refresh-failed") data.importing = { ...message };
      // The profile it built is posted in the conversation, so the sheet steps aside to show it.
      if (stage === "done") {
        data.importing = null;
        data.drafts.lastfm = "";
        data.lastfm.username = "";
        hide();
        return;
      }
      // A file dropped on the window, or an import started elsewhere, brings the sheet to Import.
      if ((stage === "preview" || stage === "reading") && (!isOpen || section !== "library")) {
        if (isOpen && !asking) go("library"); else show("library");
        return;
      }
    }
    if (message.type === "notice") {
      if (message.code === "lastfm-key") { data.lastfm.savingKey = false; data.lastfm.keyError = true; }
      else if (message.code === "provider-models") { for (const id of requested) if (!data.models.has(id)) data.modelsFailed.add(id); }
      else if (NOTICES[message.code]) {
        const [where, key, kind] = NOTICES[message.code];
        data.error = { section: where, key };
        // The choice that failed shows as it really is again.
        if (kind) pending.delete(kind);
        if (message.code === "sign-out") data.signingOut.clear();
        if (message.code === "list-model") data.toggles.clear();
        if (message.code === "default-model") data.listPending.delete("default");
        if (message.code === "default-effort") data.listPending.delete("effort");
      } else return;
    }
    render();
  }

  return { show, ask, hide, render, receive, get open() { return isOpen; }, get asking() { return Boolean(asking); } };
}
