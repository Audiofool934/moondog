// Settings: one sheet over the conversation, a short list of sections on the left and the
// section on the right. Every change goes to the core, which saves it where the terminal reads it.
const make = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
// Each control carries a key, so the focus comes back to it when the sheet redraws.
const button = (label, className = "", onClick, key = `button:${className}:${label}`) => {
  const node = make("button", className, label);
  node.type = "button";
  node.dataset.key = key;
  if (onClick) node.addEventListener("click", onClick);
  return node;
};
// Spotify names device types in English; the window says them in the listener's language.
const DEVICE_TYPES = { computer: "device.computer", smartphone: "device.smartphone", speaker: "device.speaker", tv: "device.tv",
  tablet: "device.tablet", automobile: "device.car" };
const SECTIONS = ["general", "model", "playback", "library", "memory", "about"];

export function createSettings({ state, send, t, prettyModel = String }) {
  const sheet = make("div", "sheet");
  sheet.hidden = true;
  const card = make("div", "sheet-card");
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.setAttribute("aria-labelledby", "settings-title");
  const nav = make("nav", "sheet-nav");
  const body = make("div", "sheet-body");
  const close = button("", "sheet-close", () => hide());
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", "#i-close");
  svg.append(use);
  close.append(svg);
  card.append(nav, body, close);
  sheet.append(card);
  document.body.append(sheet);
  sheet.addEventListener("mousedown", (event) => { if (event.target === sheet) hide(); });

  let section = "general";
  // What the core told this sheet; the sheet asks again each time it opens a section.
  const data = { providers: null, models: new Map(), expanded: null, devices: null, devicesError: null, memories: null, auth: null, error: null,
    importing: null, version: null };
  const windowNode = document.querySelector("[data-window]");

  // While the sheet is open, the window behind it takes no focus or clicks.
  function show(name = section) {
    if (name !== section) data.error = null;
    section = SECTIONS.includes(name) ? name : "general";
    sheet.hidden = false;
    if (windowNode) windowNode.inert = true;
    refresh();
    render();
    requestAnimationFrame(() => (card.querySelector("[data-focus]") ?? card.querySelector(".sheet-nav .on") ?? close).focus());
  }
  function hide() {
    sheet.hidden = true;
    if (windowNode) windowNode.inert = false;
    document.querySelector("[data-input]")?.focus();
  }
  function refresh() {
    send({ type: "settings" });
    if (section === "model") send({ type: "models" });
    if (section === "playback") send({ type: "devices" });
    if (section === "memory") send({ type: "memories" });
    if (section === "about" && !data.version) void window.moondogApp?.version?.().then((version) => { data.version = version; render(); });
  }
  document.addEventListener("keydown", (event) => {
    if (sheet.hidden) return;
    if (event.key === "Escape" && !data.auth?.prompt) { event.preventDefault(); hide(); }
  });

  const heading = (text) => make("h3", "", text);
  const note = (text) => make("p", "note", text);
  function choice({ label, detail, checked, onChoose, trailing, disabled }) {
    const item = make("div", `choice${checked ? " checked" : ""}`);
    const main = button("", "choice-main", disabled ? null : onChoose, `choice:${label}`);
    main.disabled = Boolean(disabled);
    main.setAttribute("aria-pressed", String(Boolean(checked)));
    const words = make("span", "choice-words");
    words.append(make("span", "choice-label", label));
    if (detail) words.append(make("span", "choice-detail", detail));
    main.append(words);
    if (checked) main.append(make("span", "check", "✓"));
    item.append(main);
    if (trailing) item.append(trailing);
    return item;
  }

  function general() {
    const tr = t();
    const part = make("div");
    part.append(heading(tr("language")), note(tr("languageNote")));
    const list = make("div", "choices");
    for (const entry of state.locales ?? []) {
      list.append(choice({ label: entry.nativeName, detail: entry.nativeName === entry.name ? null : entry.name, checked: entry.code === state.locale,
        onChoose: () => send({ type: "language", locale: entry.code }) }));
    }
    part.append(list);
    return part;
  }

  function signInPanel() {
    const tr = t();
    const auth = data.auth;
    const panel = make("div", "auth");
    panel.append(make("p", "auth-title", tr("signingIn", { provider: auth.providerName ?? auth.provider })));
    for (const line of auth.lines ?? []) panel.append(note(line));
    if (auth.url) {
      const link = make("a", "", tr("openSignInPage"));
      link.href = auth.url;
      link.target = "_blank";
      panel.append(link);
    }
    if (auth.code) panel.append(make("p", "code", auth.code));
    const prompt = auth.prompt;
    if (prompt?.kind === "select") {
      const options = make("div", "choices");
      for (const option of prompt.options ?? []) options.append(choice({ label: option.label, detail: option.description,
        onChoose: () => { send({ type: "auth-answer", id: prompt.id, value: option.id }); auth.prompt = null; render(); } }));
      panel.append(make("p", "", prompt.message), options);
    } else if (prompt) {
      const form = make("form", "auth-form");
      const label = make("label", "", prompt.message);
      const field = make("input");
      field.type = prompt.kind === "secret" ? "password" : "text";
      field.placeholder = prompt.placeholder ?? "";
      field.autocomplete = "off";
      field.spellcheck = false;
      field.dataset.key = `auth-field:${prompt.id}`;
      // A redraw keeps what was typed; the answer itself goes to the core only.
      field.value = prompt.draft ?? "";
      field.addEventListener("input", () => { prompt.draft = field.value; });
      form.append(label, field, button(tr("continue"), "primary"));
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        send({ type: "auth-answer", id: prompt.id, value: field.value });
        field.value = "";
        prompt.draft = "";
        auth.prompt = null;
        auth.lines = [tr("checking")];
        render();
      });
      panel.append(form);
      if (!prompt.focused) {
        prompt.focused = true;
        requestAnimationFrame(() => field.focus());
      }
    }
    panel.append(button(tr("cancel"), "quiet", () => { send({ type: "sign-in-cancel" }); }));
    return panel;
  }

  function model() {
    const tr = t();
    const part = make("div");
    const current = state.model ?? {};
    part.append(heading(tr("currentModel")));
    const providerName = data.providers?.find((provider) => provider.id === current.provider)?.name ?? current.provider;
    const now = make("p", "current", current.model ? prettyModel(current.model) : tr("noModel"));
    if (current.model && current.provider) now.append(make("span", "", `${providerName}, ${current.model}`));
    part.append(now);
    if (current.effortLevels?.length) {
      const efforts = make("div", "segments");
      for (const level of ["default", ...current.effortLevels]) {
        const chosen = (current.effort ?? "default") === level;
        const segment = button(level === "default" ? tr("effortDefault") : tr(`effort.${level}`) === `effort.${level}` ? level : tr(`effort.${level}`), chosen ? "segment on" : "segment",
          () => send({ type: "effort", effort: level }), `effort:${level}`);
        segment.setAttribute("aria-pressed", String(chosen));
        efforts.append(segment);
      }
      part.append(make("p", "label", tr("effort")), efforts);
    }
    if (data.auth) { part.append(signInPanel()); return part; }
    if (data.error) part.append(make("p", "error", data.error));
    part.append(heading(tr("providers")));
    if (!data.providers) { part.append(note(tr("loading"))); return part; }
    if (!data.providers.length) { part.append(note(data.providersError ?? tr("noProviders"))); return part; }
    const list = make("div", "choices");
    // Providers that only read a key from the environment wait behind one button, unless one is in use.
    const usable = (provider) => provider.signedIn === true || provider.signIn !== "environment_only";
    const hidden = data.providers.filter((provider) => !usable(provider));
    for (const provider of data.showAllProviders ? data.providers : data.providers.filter(usable)) {
      const signedIn = provider.signedIn === true;
      const detail = signedIn ? (provider.source && provider.source !== "saved" ? tr("signedInFrom", { source: provider.source === "environment" ? tr("theEnvironment") : provider.source }) : tr("signedIn"))
        : provider.signIn === "oauth" ? tr("signInWithBrowser") : provider.signIn === "api_key" ? tr("needsApiKey") : tr("setInEnvironment");
      // Only a key Moondog saved can be signed out here; one from the environment stays in effect.
      const action = signedIn ? (provider.source === "saved" ? button(tr("signOut"), "quiet small", () => send({ type: "sign-out", provider: provider.id }), `sign-out:${provider.id}`) : null)
        : provider.signIn === "environment_only" ? null : button(tr("signIn"), "small", () => {
          data.error = null;
          data.auth = { provider: provider.id, providerName: provider.name, lines: [] };
          send({ type: "sign-in", provider: provider.id });
          render();
        });
      list.append(choice({ label: provider.name, detail, checked: provider.id === current.provider, trailing: action,
        onChoose: () => {
          data.expanded = data.expanded === provider.id ? null : provider.id;
          if (data.expanded && !data.models.has(provider.id)) send({ type: "provider-models", provider: provider.id });
          render();
        } }));
      if (data.expanded === provider.id) {
        const models = data.models.get(provider.id);
        const inner = make("div", "choices inner");
        if (!models) inner.append(note(tr("loading")));
        else if (!signedIn && provider.signIn !== "environment_only") inner.append(note(tr("signInFirst")));
        else for (const entry of models) {
          inner.append(choice({ label: entry.name ?? entry.id, detail: entry.name && entry.name !== entry.id ? entry.id : null,
            checked: provider.id === current.provider && entry.id === current.model,
            onChoose: () => send({ type: "model", provider: provider.id, model: entry.id }) }));
        }
        list.append(inner);
      }
    }
    part.append(list);
    if (hidden.length && !data.showAllProviders) {
      part.append(button(tr("moreProviders", { count: hidden.length }), "quiet small", () => { data.showAllProviders = true; render(); }));
    }
    return part;
  }

  function playback() {
    const tr = t();
    const part = make("div");
    part.append(heading(tr("musicService")));
    const services = make("div", "choices");
    services.append(choice({ label: "Spotify", detail: state.spotify === "ready" ? tr("connected") : tr("notConnected"),
      checked: state.playbackService === "spotify", onChoose: () => send({ type: "music-service", service: "spotify" }) }));
    services.append(choice({ label: "Apple Music", detail: tr("appleMusicNote"), checked: state.playbackService === "apple_music",
      onChoose: () => send({ type: "music-service", service: "apple_music" }) }));
    part.append(services);

    part.append(heading(tr("spotifyAccount")));
    if (data.error) part.append(make("p", "error", data.error));
    if (data.auth?.provider === "spotify") part.append(signInPanel());
    else if (data.auth) part.append(note(tr("signInBusy")));
    else if (state.spotify === "ready") {
      part.append(note(tr("spotifyConnected")), button(tr("disconnect"), "quiet", () => send({ type: "sign-out", provider: "spotify" })));
    } else {
      const form = make("form", "auth-form");
      let field = null;
      if (!state.spotifyAccount?.clientId) {
        form.append(make("label", "", tr("spotifyClientId")));
        field = make("input");
        field.spellcheck = false;
        form.append(field);
      }
      form.append(button(tr("connectSpotify"), "primary"));
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const clientId = field?.value.trim();
        if (field && !clientId) return;
        data.error = null;
        data.auth = { provider: "spotify", providerName: "Spotify", lines: [tr("openingBrowser")] };
        send({ type: "sign-in", provider: "spotify", ...(clientId ? { clientId } : {}) });
        render();
      });
      part.append(note(tr("spotifyNeedsApp")), form);
    }

    if (state.spotify === "ready") {
      part.append(heading(tr("devices")));
      const list = make("div", "choices");
      if (!data.devices) list.append(note(tr("loading")));
      else if (data.devicesError) list.append(note(tr("noticeDevicesFailed")));
      else if (!data.devices.length) list.append(note(tr("noDevices")));
      else for (const device of data.devices) {
        const type = DEVICE_TYPES[String(device.type).toLowerCase()];
        list.append(choice({ label: device.name, detail: type ? tr(type) : null, checked: device.active, disabled: device.restricted,
          onChoose: () => { send({ type: "transfer", ref: device.ref }); data.devices = data.devices.map((entry) => ({ ...entry, active: entry.ref === device.ref })); render(); } }));
      }
      part.append(list, button(tr("refresh"), "quiet small", () => { data.devices = null; send({ type: "devices" }); render(); }));
    }
    return part;
  }

  function library() {
    const tr = t();
    const part = make("div");
    const job = data.importing;
    part.append(heading(tr("importHistory")), note(tr("importNote")));
    if (job && ["reading", "progress", "saving"].includes(job.stage)) {
      part.append(make("p", "working", job.stage === "saving" ? tr("importSaving") : job.count ? tr("importReadingCount", { count: job.count.toLocaleString(state.locale) }) : tr("importReading")));
      if (job.stage !== "saving") part.append(button(tr("stop"), "quiet", () => send({ type: "import-cancel" })));
      return part;
    }
    if (job?.stage === "preview") {
      // The words come from the core, written as the terminal writes them.
      const preview = job.preview;
      const facts = make("ul", "facts");
      for (const paragraph of preview.paragraphs ?? []) facts.append(make("li", "", paragraph));
      part.replaceChildren(heading(preview.title ?? tr("importHistory")), note(preview.notice ?? tr("importNote")),
        ...(preview.empty ? [make("p", "", tr("importEmpty"))] : []), facts);
      const actions = make("div", "actions");
      if (!preview.empty) actions.append(button(tr("addToProfile"), "primary", () => send({ type: "import-commit" })));
      actions.append(button(tr("back"), "quiet", () => { send({ type: "import-cancel" }); data.importing = null; render(); }));
      part.append(actions);
      return part;
    }
    if (job?.stage === "done") part.append(make("p", "done", job.receipt?.already ? tr("importAlready") : tr("importDone")));
    if (job?.stage === "error") part.append(make("p", "error", job.code === "import_while_answering" ? tr("importWhileAnswering") : job.message || tr("importFailed")));

    const sources = make("div", "choices");
    sources.append(choice({ label: tr("importSpotifyQuick"), detail: state.spotify === "ready" ? tr("importSpotifyQuickNote") : tr("connectSpotifyFirst"),
      disabled: state.spotify !== "ready", onChoose: () => send({ type: "import-spotify" }) }));
    sources.append(choice({ label: tr("importFile"), detail: tr("importFileNote"), onChoose: async () => {
      const path = await window.moondogApp?.chooseFile?.({ title: tr("importFile"), filterName: tr("musicHistoryFiles") });
      if (path) send({ type: "import-file", path });
    } }));
    part.append(sources);
    const form = make("form", "inline-form");
    const field = make("input");
    field.placeholder = tr("lastfmUsername");
    field.spellcheck = false;
    form.append(field, button(tr("read"), "small"));
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (field.value.trim()) send({ type: "import-lastfm", username: field.value.trim() });
    });
    part.append(make("p", "label", "Last.fm"), form, note(tr("dropHint")));
    return part;
  }

  function memory() {
    const tr = t();
    const part = make("div");
    part.append(heading(tr("memory")), note(tr("memoryNote")));
    const form = make("form", "inline-form");
    const field = make("input");
    field.placeholder = tr("rememberPlaceholder");
    form.append(field, button(tr("remember"), "small"));
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!field.value.trim()) return;
      send({ type: "remember", text: field.value.trim() });
      field.value = "";
    });
    part.append(form);
    const list = make("div", "memories");
    if (!data.memories) list.append(note(tr("loading")));
    else if (!data.memories.length) list.append(note(tr("noMemories")));
    else for (const entry of data.memories) {
      const item = make("div", "memory");
      item.append(make("p", "", entry.text), button(tr("forget"), "quiet small", () => send({ type: "forget", id: entry.id }), `forget:${entry.id}`));
      list.append(item);
    }
    part.append(list);
    return part;
  }

  function about() {
    const tr = t();
    const part = make("div");
    part.append(heading("Moondog"), note(data.version ? tr("version", { version: data.version }) : ""));
    const link = make("a", "", "moondog.audiofool.ai");
    link.href = "https://moondog.audiofool.ai";
    link.target = "_blank";
    part.append(link, heading(tr("shortcuts")));
    const keys = make("dl", "keys");
    for (const [key, what] of [["⌘N", tr("newConversation")], ["⌘,", tr("settings")], ["⌘.", tr("stop")], ["/", tr("commands")], ["⌥⌘S", tr("conversations")], ["⌥⌘P", tr("player")]]) {
      keys.append(make("dt", "", key), make("dd", "", what));
    }
    part.append(keys);
    return part;
  }

  function render() {
    if (sheet.hidden) return;
    const tr = t();
    const focused = card.contains(document.activeElement) ? document.activeElement.dataset.key : null;
    const title = make("p", "sheet-title", tr("settings"));
    title.id = "settings-title";
    nav.replaceChildren(title);
    for (const name of SECTIONS) {
      const item = button(tr(`section.${name}`), name === section ? "on" : "", () => { section = name; data.error = null; refresh(); render(); }, `nav:${name}`);
      item.setAttribute("aria-current", String(name === section));
      nav.append(item);
    }
    const views = { general, model, playback, library, memory, about };
    body.replaceChildren(views[section]());
    close.setAttribute("aria-label", tr("close"));
    // A key shared by several controls is not restored, so the focus never lands on another item's button.
    const matches = focused ? card.querySelectorAll(`[data-key="${CSS.escape(focused)}"]`) : [];
    if (matches.length === 1) matches[0].focus();
  }

  // Messages from the core that this sheet draws.
  function receive(message) {
    if (message.type === "models") { data.providers = message.providers ?? []; data.providersError = message.error ?? null; }
    if (message.type === "provider-models") data.models.set(message.provider, message.models ?? []);
    if (message.type === "devices") { data.devices = message.devices ?? []; data.devicesError = message.error ?? null; }
    if (message.type === "memories") data.memories = message.memories ?? [];
    if (message.type === "auth-prompt" && data.auth) data.auth.prompt = { id: message.id, kind: message.kind, message: message.message, placeholder: message.placeholder, options: message.options };
    if (message.type === "auth-prompt-closed" && data.auth?.prompt?.id === message.id) data.auth.prompt = null;
    if (message.type === "auth-event" && data.auth) {
      if (message.kind === "auth_url") {
        data.auth.url = message.url;
        if (!message.opened) window.open(message.url, "_blank");
        data.auth.lines = [t()("finishInBrowser")];
      }
      if (message.kind === "device_code") { data.auth.code = message.userCode; data.auth.url = message.url; data.auth.lines = [t()("enterCode")]; }
      if (message.kind === "info" || message.kind === "progress") data.auth.lines = [message.message];
    }
    // A refused second sign-in leaves the running one on screen; any other end clears its own panel.
    if (message.type === "sign-in" && message.code !== "sign_in_busy") {
      if (!data.auth || data.auth.provider === message.provider) data.auth = null;
      data.error = message.state === "error" ? (message.code === "connect_while_answering" ? t()("connectWhileAnswering") : message.message || t()("signInFailed")) : null;
      send({ type: "models" });
    }
    if (message.type === "import") {
      if (message.stage === "cancelled") data.importing = null;
      else if (message.stage === "progress") data.importing = { ...data.importing, stage: "progress", count: message.count };
      else if (!["refresh-failed", "lastfm-key-saved"].includes(message.stage)) data.importing = { ...message };
      if (message.stage === "preview" || message.stage === "reading") { if (sheet.hidden) show("library"); else section = "library"; }
      // The profile it built is posted in the conversation, so the sheet steps aside to show it.
      if (message.stage === "done") hide();
    }
    render();
  }

  return { show, hide, render, receive, get open() { return !sheet.hidden; } };
}
