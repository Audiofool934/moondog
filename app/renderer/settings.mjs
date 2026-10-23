// Settings: one sheet over the window, the places on the left and the open one on the right. Every
// change goes to the core, which saves it where the terminal reads it. A choice shows at once and
// the core's next status confirms it, so nothing waits on a rebuild to look chosen.
import { languageTag } from "../strings.mjs";
import { icon, make, name, scrollbar, setIcon, turning } from "./ui.mjs";

const SECTIONS = ["general", "model", "playback", "library", "memory", "about"];
const ICONS = { general: "globe", model: "model", playback: "speaker", library: "import", memory: "memory", about: "info" };
// Spotify names device types in English; the icon says the kind, so no word is needed.
const DEVICE_ICONS = { computer: "laptop", smartphone: "phone", tablet: "phone", tv: "tv" };
const REDIRECT_URI = "http://127.0.0.1:43821/callback";
const SPOTIFY_DASHBOARD = "https://developer.spotify.com/dashboard";
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
  model: ["model", "noticeFailed", "model"], effort: ["model", "noticeFailed", "effort"] };
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
// The same turning mark the conversation shows while Moondog works, in step with it. The offset is
// fixed when the work starts, so a redraw draws the same mark and keeps the one already turning.
function phase(offset) {
  const mark = make("span", "phase");
  const strip = make("i", "", "◐\n◓\n◑\n◒");
  strip.style.animationDelay = `-${offset}ms`;
  mark.append(strip);
  mark.setAttribute("aria-hidden", "true");
  return mark;
}

export function createSettings({ state, send, t, prettyModel = String, appleMusic = null }) {
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
  close.addEventListener("click", () => hide());
  card.append(nav, body, close);
  sheet.append(card);
  document.body.append(sheet);
  scrollbar(scroller);
  sheet.addEventListener("mousedown", (event) => { if (event.target === sheet) hide(); });
  const windowNode = document.querySelector("[data-window]");

  // The places are built once and only their state changes, so a message from the core never
  // replaces the row under the pointer.
  const tabs = new Map();
  for (const id of SECTIONS) {
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
  let content = null;
  let copiedTimer = 0;
  // What the core told this sheet; the sheet asks again each time a section opens.
  const data = { providers: null, providersError: false, models: new Map(), modelsFailed: new Set(), expanded: undefined, signingOut: new Set(),
    devices: null, devicesError: false, devicesLoading: false, memories: null, auth: null, error: null, importing: null, version: null, copied: null, focus: null, phaseOffset: null,
    lastfm: { username: "", needsKey: false, keyError: false, savingKey: false },
    drafts: { remember: "", lastfm: "", lastfmKey: "", spotifyClientId: "" } };

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

  // While the sheet is open, the window behind it takes no focus or clicks.
  function show(name = section) {
    const next = SECTIONS.includes(name) ? name : "general";
    const wasOpen = isOpen;
    const moved = next !== section;
    if (moved) { data.error = null; scroller.scrollTop = 0; }
    section = next;
    clearTimeout(closing);
    delete sheet.dataset.state;
    sheet.hidden = false;
    if (!wasOpen) {
      content = null;
      // Each opening starts with the provider in use unfolded.
      data.expanded = undefined;
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
    if (windowNode) windowNode.inert = false;
    sheet.dataset.state = "closing";
    closing = setTimeout(() => { sheet.hidden = true; delete sheet.dataset.state; }, 120);
    document.querySelector("[data-input]")?.focus();
  }
  function go(name) {
    if (name === section || !SECTIONS.includes(name)) return;
    section = name;
    data.error = null;
    scroller.scrollTop = 0;
    refresh();
    render({ entering: true });
  }
  function refresh() {
    // The status and the memories come back for every section.
    send({ type: "settings" });
    if (section === "model") send({ type: "models" });
    if (section === "playback") {
      data.devicesLoading = true;
      send({ type: "devices" });
      // Whether Apple Music can play whole songs here can change outside the window, so Playback asks again.
      void appleMusic?.check().then(() => render());
    }
    if (section === "about" && !data.version) void window.moondogApp?.version?.().then((version) => { data.version = version; render(); });
  }

  document.addEventListener("keydown", (event) => {
    if (!isOpen) return;
    // A sign-in waiting for an answer keeps the sheet, so a stray Escape cannot lose it.
    if (event.key === "Escape") {
      if (!data.auth?.prompt) { event.preventDefault(); hide(); }
      return;
    }
    const target = event.target;
    const step = { ArrowDown: 1, ArrowUp: -1, ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (!step || event.metaKey || event.altKey || event.ctrlKey) return;
    const vertical = event.key === "ArrowDown" || event.key === "ArrowUp";
    if (vertical && (target === card || target.closest?.(".sheet-nav"))) {
      event.preventDefault();
      const next = SECTIONS[Math.max(0, Math.min(SECTIONS.length - 1, SECTIONS.indexOf(section) + step))];
      go(next);
      tabs.get(next).tab.focus();
    } else if (vertical && target.classList?.contains("choice-main")) {
      const rows = [...scroller.querySelectorAll(".choice-main:not(:disabled)")];
      const next = rows[rows.indexOf(target) + step];
      if (next) { event.preventDefault(); next.focus(); }
    } else if (!vertical && target.classList?.contains("segment")) {
      const segments = [...target.parentElement.children];
      const next = segments[segments.indexOf(target) + step];
      if (!next) return;
      event.preventDefault();
      // The click redraws the section, so the focus goes to the redrawn segment.
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
  // Something still on its way shows the turning mark, never the word "Loading".
  const waiting = () => {
    const line = make("p", "note waiting");
    line.setAttribute("aria-label", say("loading"));
    line.append(turning());
    return line;
  };
  // An error inside the sheet is announced, since the notice behind it is covered while the sheet is open.
  const failure = (key) => {
    const node = make("p", "alert");
    node.setAttribute("role", "alert");
    node.append(icon("info"), make("span", "", say(key)));
    return node;
  };
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
  function choice({ label, detail, chosen, expanded, action, onChoose, trailing, disabled, key, lead }) {
    const item = make("div", `choice${disabled ? " off" : ""}`);
    const main = make("button", "choice-main");
    main.type = "button";
    main.dataset.key = key ?? `choice:${label}`;
    main.disabled = Boolean(disabled);
    // A row that opens a list says so; a row that picks one of several says whether it is the one.
    if (expanded !== undefined) main.setAttribute("aria-expanded", String(expanded));
    else if (!action) { main.setAttribute("role", "radio"); main.setAttribute("aria-checked", String(Boolean(chosen))); }
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
    if (chosen) (trailing ? item : main).append(icon("check", "icon check"));
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

  // Model: what answers now, how hard it thinks, and where else it could come from.
  const prettyOf = (provider, id) => {
    const pretty = prettyModel(id);
    if (pretty && pretty !== id) return pretty;
    return data.models.get(provider)?.find((entry) => entry.id === id)?.name ?? id;
  };
  function model() {
    const current = state.model ?? {};
    const active = expected("model", current.model ? { provider: current.provider, model: current.model } : null);
    const switching = active && (active.provider !== current.provider || active.model !== current.model);
    // The model in use is the checked row under its account; only its absence needs saying.
    const parts = [];
    if (!active) parts.push(group(null, make("p", "now-name none", say("noModel"))));
    // Which model answers comes first; how hard it thinks follows. A model sign-in replaces the list while it runs.
    if (data.auth && data.auth.provider !== "spotify") parts.push(group(null, signInPanel()));
    else parts.push(group(say("providers"), sectionError(), providerList(active)));
    if (current.effortLevels?.length && !switching) parts.push(group(say("effort"), efforts(current)));
    return parts;
  }
  function efforts(current) {
    const chosen = expected("effort", current.effort ?? "default");
    const track = make("div", "segments");
    track.setAttribute("role", "radiogroup");
    track.setAttribute("aria-label", say("effort"));
    for (const level of ["default", ...current.effortLevels]) {
      const label = level === "default" ? say("effortDefault") : say(`effort.${level}`) === `effort.${level}` ? level : say(`effort.${level}`);
      const segment = button(label, "segment", () => {
        if (chosen === level) return;
        expect("effort", level);
        send({ type: "effort", effort: level });
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
  function providerList(active) {
    if (!data.providers) return waiting();
    // Providers that only read a key from the environment can't be signed in here, so they show only once in use.
    const usable = data.providers.filter((provider) => provider.signedIn === true || provider.signIn !== "environment_only");
    if (data.providersError || !usable.length) return failure("noProviders");
    // The provider in use starts open, so its models are one look away.
    const open = data.expanded === undefined ? usable.find((provider) => provider.id === active?.provider && provider.signedIn)?.id ?? null : data.expanded;
    const rows = [];
    for (const provider of usable) {
      const signedIn = provider.signedIn === true;
      // Only a key Moondog saved can be signed out here; one from the environment stays in effect.
      const canSignOut = signedIn && provider.source === "saved";
      let trailing = null;
      if (canSignOut) {
        trailing = button(say("signOut"), "button quiet small", () => {
          data.signingOut.add(provider.id);
          send({ type: "sign-out", provider: provider.id });
          render();
        }, `sign-out:${provider.id}`);
        trailing.disabled = data.signingOut.has(provider.id);
      } else if (!signedIn) {
        trailing = button(say("signIn"), "button small", () => {
          data.error = null;
          data.auth = { provider: provider.id, providerName: provider.name, status: null, info: null };
          send({ type: "sign-in", provider: provider.id });
          render();
        }, `sign-in:${provider.id}`);
        // One sign-in at a time; the core would refuse a second.
        trailing.disabled = Boolean(data.auth);
      }
      const expanded = open === provider.id;
      rows.push(choice({ label: provider.name, detail: signedIn && !canSignOut ? say("signedIn") : null, expanded, trailing,
        key: `provider:${provider.id}`, lead: icon("chevron", "icon disclose"),
        onChoose: () => { data.expanded = expanded ? null : provider.id; render(); } }));
      if (expanded) {
        wantModels(provider);
        rows.push(modelList(provider, active));
      }
    }
    return choices(rows);
  }
  // Each provider's models are asked for once; the renderer asks for the signed-in ones on its own.
  const requested = new Set();
  function wantModels(provider) {
    if (provider.signedIn !== true || data.models.has(provider.id) || requested.has(provider.id)) return;
    requested.add(provider.id);
    send({ type: "provider-models", provider: provider.id });
  }
  function modelList(provider, active) {
    const models = data.models.get(provider.id);
    const retry = () => { data.modelsFailed.delete(provider.id); requested.delete(provider.id); wantModels(provider); render(); };
    const inner = provider.signedIn !== true ? [note(say("signInFirst"))]
      : data.modelsFailed.has(provider.id) ? [failure("noticeFailed"), button(say("tryAgain"), "button quiet small", retry, `retry:${provider.id}`)]
        : !models ? [waiting()]
          : models.map((entry) => choice({ label: entry.name ?? entry.id, key: `model:${provider.id}:${entry.id}`,
            chosen: active?.provider === provider.id && active?.model === entry.id,
            onChoose: () => {
              if (active?.provider === provider.id && active?.model === entry.id) return;
              expect("model", { provider: provider.id, model: entry.id });
              send({ type: "model", provider: provider.id, model: entry.id });
              render();
            } }));
    return choices(inner, "choices inner");
  }

  // Playback: the music service, then Spotify's account or its devices.
  function playback() {
    const service = expected("service", state.playbackService ?? "spotify");
    const ready = expected("spotify", state.spotify) === "ready";
    const chooseService = (next) => () => {
      if (next === service) return;
      expect("service", next);
      send({ type: "music-service", service: next });
      render();
    };
    const disconnect = ready ? button(say("disconnect"), "button quiet small", () => {
      expect("spotify", "unavailable");
      send({ type: "sign-out", provider: "spotify" });
      render();
    }, "spotify:disconnect") : null;
    // Whole Apple Music songs need the listener's permission once; until then, and without it, previews play.
    const whole = appleMusic?.status();
    const allowWhole = whole?.authorization === "notDetermined" && whole.reason !== "developerTokenRequestFailed" ? button(say("allowFullSongs"), "button small", () => {
      void appleMusic.check("authorize").then(() => render());
    }, "apple-music:allow") : null;
    const parts = [group(say("musicService"), sectionError(), choices([
      choice({ label: "Spotify", detail: ready ? null : say("notConnected"), chosen: service === "spotify", trailing: disconnect,
        key: "service:spotify", onChoose: chooseService("spotify") }),
      choice({ label: "Apple Music", detail: say(whole?.canPlay ? "fullSongs" : "appleMusicNote"), chosen: service === "apple_music", key: "service:apple_music",
        trailing: allowWhole, onChoose: chooseService("apple_music") }),
      // NetEase is offered once ncm-cli is installed and signed in; its searches send NetEase a short summary.
      ...(state.netease === "ready" || service === "netease" ? [choice({ label: say("netease"), detail: say("neteaseNote"), chosen: service === "netease",
        key: "service:netease", onChoose: chooseService("netease") })] : []),
    ]))];
    if (service !== "spotify") return parts;
    if (data.auth?.provider === "spotify") parts.push(group(null, signInPanel()));
    else if (!ready) parts.push(group(null, data.auth ? note(say("signInBusy")) : connectSpotify()));
    else parts.push(devices());
    return parts;
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
  function devices() {
    const head = make("div", "group-head");
    const again = make("button", "tool");
    again.type = "button";
    again.dataset.key = "devices:refresh";
    again.append(icon("refresh"));
    name(again, say("refresh"));
    again.addEventListener("click", () => { data.devicesLoading = true; send({ type: "devices" }); render(); });
    head.append(make("h3", "group-title", say("devices")), again);
    const list = !data.devices ? waiting()
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
    const part = make("section", "group");
    part.append(head, list);
    return part;
  }

  // Import: two ways in, then Last.fm by name. The core reads first and saves only what is added.
  const importLine = (job) => (job.stage === "saving" ? say("importSaving")
    : job.count ? say("importReadingCount", { count: Number(job.count).toLocaleString(state.locale) }) : say("importReading"));
  function library() {
    const job = data.importing;
    if (job && ["reading", "progress", "saving"].includes(job.stage)) {
      data.phaseOffset ??= Math.round(performance.now() % 2400);
      const line = make("div", "working");
      const words = make("span", "", importLine(job));
      words.dataset.progressText = "";
      line.append(phase(data.phaseOffset), words);
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
    card.setAttribute("aria-label", say("settings"));
    close.setAttribute("aria-label", say("close"));
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
    const views = { general, model, playback, library, memory, about };
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
    if (message.type === "devices") {
      data.devices = message.devices ?? [];
      data.devicesError = Boolean(message.error);
      data.devicesLoading = false;
      warn("devices", message.error);
    }
    if (message.type === "memories") data.memories = message.memories ?? [];
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
      if (message.provider === "spotify" && message.state === "done") expect("spotify", "ready");
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
        if (isOpen) go("library"); else show("library");
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
      } else return;
    }
    render();
  }

  return { show, hide, render, receive, get open() { return isOpen; } };
}
