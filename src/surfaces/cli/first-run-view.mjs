import { getKeybindings, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import { sanitizeTerminalText } from "./format-output.mjs";
import { screenTranslator } from "../../i18n/index.mjs";

// NetEase plays through its own command line tool and mpv, set up from a terminal as the window shows it.
export const NETEASE_SETUP = "npm install -g @music163/ncm-cli && brew install mpv && ncm-cli login";

/** The command that makes NetEase ready, from ncm-cli's state: missing installs it, signed out signs in. */
export function neteaseSetupCommand(state) {
  return state === "signed_out" ? "ncm-cli login" : NETEASE_SETUP;
}

export function playbackServiceName(service, tr) {
  return service === "netease" ? tr("NetEase Music") : service === "apple_music" ? "Apple Music" : "Spotify";
}

/**
 * The music services the first run and /service offer, as the window does: Spotify and Apple Music,
 * and NetEase once ncm-cli is installed, signed in or not. Choosing NetEase before it is signed in
 * shows how to set it up.
 */
export function playbackServiceChoices(tr, { netease = "unavailable", current = null } = {}) {
  const neteaseOffered = ["ready", "signed_out", "missing"].includes(netease) || current === "netease";
  return [
    { value: "spotify", label: "Spotify", description: tr("Whole songs on your Spotify devices") },
    { value: "apple_music", label: "Apple Music", description: tr("30-second previews, played here") },
    ...(neteaseOffered ? [{
      value: "netease", label: tr("NetEase Music"),
      description: netease === "ready" ? tr("Whole songs through ncm-cli") : tr("Set up ncm-cli first"),
    }] : []),
  ];
}

function clean(value) {
  return sanitizeTerminalText(String(value ?? "")).replace(/\s+/gu, " ").trim();
}

function paint(value, width, theme) {
  const clipped = truncateToWidth(value, width, "");
  const line = clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
  return theme.plain ? line.replace(/\u001b\[[\d;:]*m/g, "") : theme.background(theme.text(line));
}

/**
 * The one-time first run: where music plays, then the model. It draws the step it is given and
 * reports the listener's choice; the room saves it and runs Pi's own model picker and sign-in.
 */
export class FirstRunView {
  constructor({ getTheme, getRows, onAction, getText = () => screenTranslator("en") }) {
    this.getTheme = getTheme;
    this.getRows = getRows;
    this.getText = getText;
    this.onAction = onAction;
    this.state = { step: "service", steps: 2, services: [], model: {} };
    this.selected = 0;
    this.focused = false;
  }

  invalidate() {}

  setState(state) {
    if (state.step !== this.state.step) this.selected = 0;
    this.state = { ...this.state, ...state };
  }

  actions() {
    const tr = this.getText();
    if (this.state.step === "service") return this.state.services.map((choice) => ({ type: "service", ...choice }));
    const { provider, signIn } = this.state.model ?? {};
    return signIn ? [
      { type: "auth", label: tr("Sign in to {provider}", { provider }), description: provider === "openai" ? tr("ChatGPT sign-in or API key") : tr("API key") },
      { type: "model", label: tr("Choose another model") },
    ] : [{ type: "model", label: tr("Choose a model"), description: tr("Pick a provider and model, then sign in") }];
  }

  handleInput(data) {
    const keys = getKeybindings();
    const actions = this.actions();
    if (keys.matches(data, "tui.select.cancel")) {
      this.onAction?.({ type: "skip" });
    } else if (keys.matches(data, "tui.select.up") || keys.matches(data, "tui.select.down")) {
      if (actions.length) this.selected = (this.selected + (keys.matches(data, "tui.select.up") ? -1 : 1) + actions.length) % actions.length;
    } else if (keys.matches(data, "tui.select.confirm") && actions.length) {
      const { type, value } = actions[Math.min(this.selected, actions.length - 1)];
      this.onAction?.({ type, value });
    }
  }

  render(width) {
    const columns = Math.max(1, Math.floor(width));
    const rows = Number(this.getRows());
    const height = Number.isFinite(rows) ? Math.max(0, Math.floor(rows)) : 0;
    if (!height) return [];
    const theme = this.getTheme();
    const tr = this.getText();
    const inset = columns >= 8 ? 1 : 0;
    const inner = Math.max(1, columns - inset * 2);
    const wrap = (text, ink) => wrapTextWithAnsi(clean(text), inner).map(ink);
    const { step, steps, note, setup, model = {} } = this.state;
    const intro = steps > 1 ? tr("Two things before we start: where I play your music, and the model I talk through.")
      : step === "service" ? tr("One thing before we start: where I play your music.") : tr("One thing before we start: the model I talk through.");
    const question = step === "service" ? tr("Where should I play music?") : tr("Which model should I talk through?");
    const help = step === "service" ? tr("/service changes it any time.")
      : model.signIn ? tr("{model} is saved, but you're not signed in to {provider} yet.", { model: `${model.provider}/${model.model}`, provider: model.provider })
        : tr("Sign in with ChatGPT, or use an API key from another provider. Your profile works without one.");
    const notice = [
      ...(note?.text ? wrap(note.text, note.tone === "error" ? theme.error : theme.accent) : []),
      ...(setup ? [...wrap(tr("NetEase plays through its own command line tool. Run this in another terminal, then choose it again:"), theme.muted),
        ...wrap(setup, theme.text)] : []),
    ];
    const actions = this.actions();
    this.selected = Math.min(this.selected, Math.max(0, actions.length - 1));
    const labelWidth = Math.max(0, ...actions.map(({ label }) => visibleWidth(clean(label)))) + 4;
    const items = actions.map(({ label, description }, index) => {
      const selected = index === this.selected;
      const name = (selected ? "◉ " : "  ") + clean(label);
      const room = inner - labelWidth;
      const line = description && room >= 12
        ? name + " ".repeat(Math.max(1, labelWidth - visibleWidth(name))) + theme.muted(truncateToWidth(clean(description), room, "…"))
        : name;
      return selected ? theme.selected(truncateToWidth(name, inner, "")) + line.slice(name.length) : theme.text(line);
    });
    // The choices always show. On a short screen the blank rows go first, then the introduction,
    // then the line under the question; what happened last stays longest.
    const title = theme.bold(tr("Welcome to the machine."));
    const parts = (gaps, introduced, helped) => [
      title, ...(introduced ? wrap(intro, theme.muted) : []), ...(gaps ? [""] : []),
      ...(notice.length ? [...notice, ...(gaps ? [""] : [])] : []),
      theme.bold(question), ...(helped ? wrap(help, theme.muted) : []), ...(gaps ? [""] : []),
    ];
    const space = height - items.length;
    const above = [parts(true, true, true), parts(false, true, true), parts(false, false, true), parts(false, false, false)]
      .find((candidate) => candidate.length <= space) ?? (space > 0 ? parts(false, false, false).slice(-space) : []);
    const lines = [...above, ...items];
    return Array.from({ length: height }, (_, row) => paint(" ".repeat(inset) + (lines[row] ?? ""), columns, theme));
  }
}
