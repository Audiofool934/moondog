import {
  CombinedAutocompleteProvider,
  Container,
  Markdown,
  matchesKey,
  ProcessTerminal,
  ScrollView,
  Text,
  truncateToWidth,
  TuiAltScreen,
  visibleWidth,
  VStack,
} from "@earendil-works/pi-tui";

import {
  listPiModels,
  listPiProviders,
} from "../../runtime/pi/model-catalog.mjs";
import { supportedAuthProviderIds } from "../../runtime/pi/authentication.mjs";
import {
  formatLocalResult,
  helpText,
  sanitizeTerminalText,
} from "./format-output.mjs";

import { createMoondogTheme } from "./brand-theme.mjs";
import { LOGO_MOTION_INTERVAL_MS } from "./terminal-art.mjs";
import { buildTasteProfileModel } from "./taste-profile-model.mjs";
import { TasteProfileView } from "./taste-profile-view.mjs";
import { lyricTrackKey } from "../../core/lyric-profile.mjs";
import { HistoryImportView } from "./history-import-view.mjs";
import { IMPORT_GUIDE_URLS } from "./import-guides.mjs";
import { withCommandCompletions } from "./command-completions.mjs";
import {
  AgentWork,
  BrandSurface,
  ListeningEditor,
  ListeningHeader,
  ListeningMenu,
  RecordSleeve,
  homeActions,
  listeningHelp,
  paintBrandLine,
} from "./brand-components.mjs";

const LAYOUT_NODE = Symbol.for("@earendil-works/pi-tui/layout-node");

/** Full-screen listening room. The conversation scrolls; the header and draft stay put. */
class ListeningRoom extends TuiAltScreen {
  constructor(terminal, { mouse = true } = {}) {
    super(terminal, false, undefined, { mouse, wheelScrollLines: 3 });
    this.passViewportKeys = () => false;
    this.cursorRow = 0;
  }

  extractCursorPosition(lines, height) {
    const position = super.extractCursorPosition(lines, height);
    this.cursorRow = position?.row ?? 0;
    return position;
  }

  handleViewportInput(data) {
    if (this.passViewportKeys()) return undefined;
    return super.handleViewportInput(data);
  }

  doRender() {
    super.doRender();
    if (this.pendingReveal == null || this.conversationVisible?.() === false) return;
    const line = this.pendingReveal;
    this.pendingReveal = null;
    this.revealScroll?.(line);
  }

  captureRenderState() {
    return {
      previousLines: this.previousScreen ?? [],
      previousWidth: this.previousScreenWidth,
      previousHeight: this.previousScreenHeight,
      previousViewportTop: 0,
      hardwareCursorRow: this.cursorRow,
    };
  }
}

const slashCommands = [
  { name: "home", description: "Back to the record sleeve" },
  { name: "lyrics", description: "Your lyric library, or sync more songs" },
  { name: "import", description: "Bring in your listening history or library" },
  { name: "theme", description: "Paper, charcoal, or your terminal colors" },
  { name: "art", description: "Braille, ASCII, or a quiet opening" },
  { name: "motion", description: "Turn the animation on or off" },
  { name: "commands", description: "Search every command" },
  { name: "status", description: "See what's connected and ready" },
  { name: "sources", description: "See where your music data comes from" },
  { name: "profile", description: "Review, change, or undo your choices" },
  { name: "taste", description: "Your listening profile and the evidence behind it" },
  { name: "memory", description: "See what Moondog remembers" },
  { name: "tools", description: "See which music tools are available" },
  { name: "doctor", description: "Check your setup" },
  { name: "model", description: "Choose the model Moondog talks through" },
  { name: "auth", description: "Sign in to a model provider" },
  { name: "web", description: "Look things up on public music sites" },
  { name: "spotify", description: "Connect and control Spotify" },
  { name: "reload", description: "Reload model settings and sign-ins" },
  { name: "remember", description: "Ask Moondog to remember something" },
  { name: "forget", description: "Forget one memory by ID" },
  { name: "resume", description: "Pick up a saved conversation" },
  { name: "new", description: "Start fresh; this conversation stays saved" },
  { name: "help", description: "Commands and shortcuts" },
  { name: "quit", description: "Leave Moondog" },
];

// Parse command arguments as text only. Never evaluate shell substitutions.
export function parseTuiArguments(text) {
  const values = [];
  let value = "";
  let quote = null;
  let started = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\\" && quote !== "'") {
      const next = text[index + 1];
      if (next === undefined) throw new Error("Incomplete escape in command arguments.");
      if (!quote || next === quote || next === "\\") {
        value += next;
        index += 1;
      } else {
        value += character;
      }
      started = true;
    } else if (quote) {
      if (character === quote) quote = null;
      else value += character;
    } else if (character === '"' || character === "'") {
      quote = character;
      started = true;
    } else if (/\s/u.test(character)) {
      if (started) values.push(value);
      value = "";
      started = false;
    } else {
      value += character;
      started = true;
    }
  }
  if (quote) throw new Error("Unclosed quote in command arguments.");
  if (started) values.push(value);
  return values;
}

function offlineReply(runtimeStatus) {
  const provider = runtimeStatus.provider ?? "openai-codex";
  const [why, next] = runtimeStatus.reason === "provider_authentication_required"
    ? [`you're not signed in to ${provider}`, `Sign in with \`/auth ${provider}\`.`]
    : runtimeStatus.reason === "model_not_configured" || !runtimeStatus.reason
      ? ["no model is connected", "Type `/model` to pick one."]
      : [`I can't reach the model (\`${runtimeStatus.reason}\`)`, "Type `/model` to pick another, or `/reload` to try again."];
  return `Obscured by clouds. I can't talk yet because ${why}.

${next}

Your profile doesn't need a model. \`/taste\`, \`/import\`, and \`/help\` all work right now.`;
}

function elapsedTime(startedAt) {
  const seconds = Math.max(0, Math.floor((performance.now() - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m${seconds % 60}s` : `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

export async function runMoondogTui({
  application,
  runtime,
  terminal = new ProcessTerminal(),
  signalTarget = process,
  rebuildRuntime,
  runAuth,
  runSpotify,
  runProfile,
  runProfileAction,
  runWeb,
  lyrics,
  prepareImport,
  prepareRecentImport,
  refreshImportedData,
  openImportHelp,
  providers = listPiProviders,
  models = listPiModels,
  environment = process.env,
}) {
  let activeRuntime = runtime;
  application.startNewSession?.("tui_start");
  activeRuntime.reset();
  let runtimeStatus = activeRuntime.publicStatus();
  const sourceStatusTask = Promise.resolve().then(() => application.sourceStatus?.()).then(
    () => null,
    (error) => error,
  );
  let theme = createMoondogTheme({ environment });
  const getTheme = () => theme;
  const color = (name) => (text) => theme[name](text);
  const accent = color("accent");
  const green = color("success");
  const yellow = color("warning");
  const red = color("error");
  const dim = color("muted");
  const bold = color("bold");
  const selectListTheme = Object.fromEntries(
    Object.keys(theme.selectListTheme).map((key) => [key, (text) => theme.selectListTheme[key](text)]),
  );
  const editorTheme = { borderColor: color("faint"), selectList: selectListTheme };
  const markdownTheme = Object.fromEntries(
    Object.keys(theme.markdownTheme).map((key) => [key, (text) => theme.markdownTheme[key](text)]),
  );
  const textStyle = { color: color("text") };
  const tui = new ListeningRoom(terminal, { mouse: environment.TERM !== "dumb" });
  if (theme.plain) tui.setShowHardwareCursor(true);
  const transcript = new Container();
  let homeVisible = true;
  let conversationTitle = "";
  let profileView = null;
  let importView = null;
  let importPage = "start";
  let importReturnHome = false;
  let preparedImport = null;
  let importNeedsRefresh = false;
  let importOrigin = "file";
  let importProvider = null;
  let importFileReturn = "start";
  let importAuthController = null;
  let profileReturnHome = false;
  let profileSnapshot = null;
  let profileNeedsRefresh = false;
  let profileDiscoveryDraft = null;
  let homeFocused = false;
  let homeSelected = 0;
  let busy = false;
  let cancelWork = null;
  let cancellationRequested = false;
  let workStartedAt = 0;
  let indicator = null;
  let homeMotion = null;
  let lyricController = null;
  let lyricTask = Promise.resolve();
  let homeLyric = null;
  let homeLyricSeeds = null;
  let lyricSubject = null;
  let lyricError = null;
  let motionEnabled = environment.MOONDOG_MOTION !== "off";
  let phase = 0;
  let footerText = "Ready.";
  let footerColor = dim;
  let localCommandController = null;
  let startAttempted = false;
  let cleanedUp = false;
  let resolveStopped;
  const stoppedPromise = new Promise((resolve) => { resolveStopped = resolve; });
  const editor = new ListeningEditor(tui, editorTheme, getTheme, () => ({ busy, homeVisible, homeFocused }));
  const recallBySession = new Map();
  const sessionId = () => application.ensureMemorySession?.()?.session_id ?? null;
  const storeRecall = () => {
    const id = sessionId();
    if (id) recallBySession.set(id, editor.recallEntries());
  };
  const recallFromTurns = () => {
    const turns = application.currentSessionTurns?.({ limit: 100 }) ?? [];
    const history = [];
    for (let index = turns.length - 1; index >= 0 && history.length < 100; index -= 1) {
      const turn = turns[index];
      if (turn?.role !== "user" || typeof turn.text !== "string") continue;
      const text = turn.text.trim();
      if (!text || history.at(-1) === text) continue;
      history.push(text);
    }
    return history;
  };
  const installRecall = (id, entries) => {
    const history = editor.replaceRecall(entries);
    if (id) recallBySession.set(id, history);
  };
  const sleeve = new RecordSleeve({ terminal, getTheme, environment, getState: () => ({
    focused: homeFocused, selected: homeSelected, motionEnabled,
    editorRows: editor.rowCount || 3,
  }), getNextLyric: () => {
    try {
      homeLyric = homeLyricSeeds ? lyrics.selectHome(homeLyricSeeds) : null;
    } catch (error) {
      lyricError = sanitizeTerminalText(error.message);
    }
    return homeLyric?.text ?? null;
  } });
  const updateHomeLyrics = ({ sync = true, signal } = {}) => {
    if (!lyrics || typeof application.getLyricSeeds !== "function" || cleanedUp) return Promise.resolve();
    lyricController?.abort();
    const controller = new AbortController();
    lyricController = controller;
    const taskSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    // Serialize replacements so a profile change cannot leave an old fetch writing afterward.
    lyricTask = lyricTask.then(async () => {
      taskSignal.throwIfAborted();
      const seeds = await application.getLyricSeeds();
      taskSignal.throwIfAborted();
      homeLyricSeeds = seeds;
      if (lyricSubject !== seeds.subjectId || (homeLyric && !seeds.tracks.some((track) => lyricTrackKey(track) === homeLyric.trackKey))) {
        homeLyric = null;
        sleeve.setLyric(null);
      }
      lyricSubject = seeds.subjectId;
      const chooseCached = () => {
        if (taskSignal.aborted || cleanedUp || homeLyric) return;
        homeLyric = lyrics.selectHome(seeds);
        if (homeLyric) { sleeve.setLyric(homeLyric.text); tui.requestRender(); }
      };
      chooseCached();
      lyricError = null;
      if (sync) await lyrics.refresh(seeds, { signal: taskSignal, onUpdate: chooseCached });
    }).catch((error) => {
      if (!taskSignal.aborted) lyricError = sanitizeTerminalText(error.message);
    });
    return lyricTask;
  };
  const header = new ListeningHeader(getTheme, () => ({
    profileReady: application.profileServicesReady?.() ?? false,
    modelReady: runtimeStatus.state === "configured",
    provider: runtimeStatus.provider,
    model: runtimeStatus.model,
    spotifyReady: application.spotifyReady?.() ?? false,
    place: homeVisible ? "" : conversationTitle,
  }));
  const renderHeader = () => { header.invalidate(); tui.requestRender(); };
  const synchronizeHomeMotion = () => {
    const shouldRun = startAttempted && !cleanedUp && motionEnabled && !theme.plain &&
      !busy && !profileView && !importView && homeVisible && !homeFocused && !tui.hasOverlay() && !editor.getText() && sleeve.canAnimate;
    if (!shouldRun) {
      clearInterval(homeMotion);
      homeMotion = null;
    } else if (!homeMotion) {
      homeMotion = setInterval(() => { sleeve.advance(); tui.requestRender(); }, LOGO_MOTION_INTERVAL_MS);
      homeMotion.unref?.();
    }
  };
  const conversation = new BrandSurface(transcript, getTheme);
  const transcriptPane = {
    invalidate() { conversation.invalidate(); },
    render(width) {
      const lines = conversation.render(width);
      const footerRows = terminal.rows >= 20 ? 2 : 1;
      const bodyRows = Math.max(1, terminal.rows - 2 - footerRows - (editor.rowCount || 3));
      while (lines.length < bodyRows) lines.push(paintBrandLine("", width, theme));
      return lines;
    },
  };
  const transcriptScroll = new ScrollView(transcriptPane, {
    follow: "end",
    primary: true,
    scrollbar: "auto",
    scrollbarStyle: (text) => getTheme().faint(text),
  });
  const stage = {
    invalidate() {
      sleeve.invalidate();
      transcript.invalidate();
      profileView?.invalidate();
      importView?.invalidate();
    },
    render(width) {
      // Measure the draft before the sleeve asks, so one frame uses the real height.
      if (!profileView && !importView) editor.rowCount = editor.render(width).length;
      const lines = importView ? importView.render(width)
        : profileView ? profileView.render(width)
          : homeVisible ? sleeve.render(width)
            : transcriptPane.render(width);
      synchronizeHomeMotion();
      return lines;
    },
    [LAYOUT_NODE]() {
      if (!homeVisible && !profileView && !importView) return transcriptScroll[LAYOUT_NODE]();
      return undefined;
    },
  };
  const composer = new BrandSurface(editor, getTheme);
  const composerSlot = {
    invalidate() { composer.invalidate(); },
    render: (width) => profileView || importView ? [] : composer.render(width),
  };
  const shell = new VStack();
  shell.addChild(header, { shrink: 0 });
  shell.addChild(stage, { grow: 1, shrink: 1, minSize: 1 });
  shell.addChild(composerSlot, { shrink: 0 });
  tui.passViewportKeys = () => Boolean(profileView || importView);
  tui.setLayoutRoot(shell);
  shell.addChild({
    invalidate() {},
    render(width) {
      const marker = theme.plain ? "." : busy && !tui.hasOverlay() ? ["◴", "◷", "◶", "◵"][phase % 4] : "◎";
      const compactHint = terminal.rows < 20 && homeVisible && !busy && !profileView && !importView;
      let statusText = compactHint && homeFocused ? "↑ ↓ choose · enter open · esc type"
        : compactHint && editor.getText() ? "enter send · ctrl+p commands"
        : compactHint && footerText === "Ready." ? "tab explore · type to talk" : footerText;
      if (importView && width < 64) {
        if (busy) statusText = footerText.startsWith("Reading the file") ? "Reading; nothing added yet."
          : footerText.startsWith("History saved") ? "Saved; refreshing profile..." : "Saving history locally...";
        else if (importView.state.error) statusText = "See the message above.";
        else if (footerText.startsWith("Guide opened")) statusText = "Guide opened in browser.";
        else statusText = importPage === "preview" ? "Ready; nothing added."
          : importPage === "file" ? "Choose one history file." : "Choose a step; Esc goes back.";
      }
      if (profileView && !importView && width < 60) {
        statusText = footerText.replace(/\. Profile refreshed\.$/u, "");
        if (tui.hasOverlay()) statusText = "Enter chooses · Esc back";
        else if (footerText.startsWith("Pick a song or artist.")) statusText = "Enter actions · Tab views · Esc back";
        else if (footerText.startsWith("Here's the evidence.")) statusText = "Evidence · PgUp/PgDn scroll · Enter";
        else if (footerText.startsWith("Imported.")) statusText = "Imported · Enter to review";
      }
      if (busy && !profileView && !importView && width >= 20) {
        const elapsed = ` · ${elapsedTime(workStartedAt)}`;
        statusText = truncateToWidth(statusText, width - 3 - visibleWidth(elapsed)) + elapsed;
      }
      if (terminal.rows < 20 && !busy && !profileView && !importView && editor.isShowingAutocomplete()) {
        statusText = "↑↓ choose · Tab/Enter complete";
      }
      const lines = [paintBrandLine(` ${theme.faint(marker)} ${footerColor(statusText)}`, width, theme)];
      if (terminal.rows >= 20) {
        const keys = importView
          ? width < 64 ? busy ? "One moment..." : importPage === "file"
            ? "Tab path · ↵ inspect · Esc back" : "↑↓ ↵ · PgUp/Dn read · Esc back"
          : busy ? "One moment..." : importPage === "file"
            ? "paste a path · tab completes · enter inspects · esc back"
            : "↑↓ choose · enter select · PgUp/PgDn read · esc back"
          : profileView
          ? busy ? "One moment..."
            : width >= 76 ? "type filter · ↑↓ select · enter actions · tab views · esc back" : "↑↓ select · enter actions · tab views · esc back"
          : busy ? cancellationRequested ? "cancelling · draft stays here"
            : cancelWork ? "draft stays here · ctrl+c cancel"
            : "draft stays here · waiting for command"
          : editor.isShowingAutocomplete() ? "↑↓ choose · tab/enter complete · esc dismiss" : homeFocused
          ? "↑ ↓ choose · enter open · esc type"
          : homeVisible && !editor.getText()
            ? width >= 60 ? "tab explore · ctrl+p commands       enter send · shift+enter newline" : "tab explore · ctrl+p commands"
            : width >= 72 ? "enter send · shift+enter newline" : "enter send";
        lines.push(paintBrandLine(` ${theme.faint(keys)}`, width, theme));
      }
      return lines;
    },
  }, { shrink: 0 });
  editor.setAutocompleteProvider(
    new CombinedAutocompleteProvider(withCommandCompletions(slashCommands, {
      providers, models, authProviderIds: supportedAuthProviderIds,
    }), process.cwd(), null),
  );
  tui.setFocus(editor);

  const setBusy = (value, cancel = null) => {
    busy = value;
    cancelWork = value ? cancel : null;
    cancellationRequested = false;
    if (value) workStartedAt = performance.now();
    clearInterval(indicator);
    indicator = null;
    phase = 0;
    if (busy && !cleanedUp) {
      const animate = !theme.plain && motionEnabled;
      indicator = setInterval(() => { if (animate) phase += 1; tui.requestRender(); }, animate ? 220 : 1000);
      indicator.unref?.();
    }
    if (!cleanedUp) tui.requestRender();
  };
  const setFooter = (text, color = dim) => {
    if (cleanedUp) return;
    footerText = sanitizeTerminalText(text);
    footerColor = color;
    tui.requestRender();
  };
  const enterConversation = () => {
    if (!homeVisible) return;
    homeVisible = false;
    homeFocused = false;
    editor.focused = true;
    tui.requestRender(true);
  };
  const addLabel = (label) => {
    transcript.addChild({
      invalidate() {},
      render: (width) => new Text(`${theme.faint(label === "Moondog" ? "◎" : "›")} ${bold(label)}`, 1, 0).render(width),
    });
  };
  const addUserMessage = (text) => {
    const title = text.replace(/\s+/gu, " ").trim();
    if (!conversationTitle && title) conversationTitle = Array.from(title).slice(0, 160).join("");
    addLabel("You");
    transcript.addChild(new Text(text, 1, 1));
  };
  // A finished local message is read from the top. Several messages added before
  // the next frame share the first anchor, once that frame has measured them.
  tui.conversationVisible = () => !homeVisible && !profileView && !importView;
  tui.revealScroll = (added) => {
    transcriptScroll.scrollToEnd();
    const hiddenAbove = added - transcriptScroll.viewportHeight;
    if (hiddenAbove > 0) transcriptScroll.scrollBy(-hiddenAbove);
    tui.requestRender();
  };
  const revealMessageStart = (added) => {
    tui.pendingReveal = (tui.pendingReveal ?? 0) + added;
  };
  const addMoondogMessage = (markdown) => {
    enterConversation();
    const width = Math.max(1, transcriptScroll.getContentWidth(terminal.columns));
    const before = conversation.render(width).length;
    addLabel("Moondog");
    transcript.addChild(new Markdown(sanitizeTerminalText(markdown), 1, 1, markdownTheme, textStyle));
    revealMessageStart(Math.max(0, conversation.render(width).length - before));
    tui.requestRender();
  };

  const removeLifecycleListeners = () => {
    signalTarget.removeListener("SIGTERM", handleSigterm);
    signalTarget.removeListener("SIGHUP", handleSighup);
    signalTarget.removeListener(
      "uncaughtExceptionMonitor",
      handleUncaughtFailure,
    );
  };

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    clearInterval(indicator);
    indicator = null;
    clearInterval(homeMotion);
    homeMotion = null;
    localCommandController?.abort();
    importAuthController?.abort();
    lyricController?.abort();
    preparedImport?.close?.();
    preparedImport = null;
    removeLifecycleListeners();
    try {
      if (startAttempted) tui.stop();
    } catch (error) {
      try {
        terminal.showCursor();
      } catch {}
      try {
        terminal.stop();
      } catch {}
      throw error;
    } finally {
      resolveStopped();
    }
  };

  const shutdown = () => {
    cleanup();
    // The spoken line that closes Eclipse, the last thing on The Dark Side of the Moon.
    try {
      terminal.write(`\n ${theme.faint("\"There is no dark side of the moon, really. Matter of fact, it's all dark.\"")}\n\n`);
    } catch {}
  };

  const terminate = (exitCode) => {
    try {
      activeRuntime.abort();
    } finally {
      signalTarget.exitCode = exitCode;
      cleanup();
    }
  };

  function handleSigterm() {
    terminate(143);
  }

  function handleSighup() {
    terminate(129);
  }

  function handleUncaughtFailure() {
    try {
      activeRuntime.abort();
    } catch {}
    try {
      cleanup();
    } catch {}
  }

  signalTarget.once("SIGTERM", handleSigterm);
  signalTarget.once("SIGHUP", handleSighup);
  signalTarget.once("uncaughtExceptionMonitor", handleUncaughtFailure);

  const choose = async (items, currentValue, title) => {
    if (items.length === 0) return undefined;
    const menu = new ListeningMenu({ items, currentValue, title, getTheme, getRows: () => terminal.rows });
    return await new Promise((resolve) => {
      let overlay;
      const finish = (value) => {
        overlay.hide();
        if (profileView) tui.setFocus(profileView);
        else editor.focused = !homeFocused;
        tui.requestRender();
        resolve(value);
      };
      menu.onSelect = (item) => finish(item);
      menu.onCancel = () => finish(undefined);
      overlay = tui.showOverlay(menu, {
        width: "86%",
        maxHeight: "100%",
        anchor: "center",
        margin: 1,
      });
    });
  };

  const closeProfile = () => {
    if (!profileView) return;
    profileView = null;
    profileSnapshot = null;
    homeVisible = profileReturnHome;
    homeFocused = false;
    tui.setFocus(editor);
    setFooter("Profile closed · /taste opens it again.");
    tui.requestRender(true);
  };

  const refreshProfile = async () => {
    const snapshot = await application.getProfileSummary({ maxItems: 10 });
    if (cleanedUp || !profileView) return;
    profileSnapshot = snapshot;
    profileView.setModel(buildTasteProfileModel(snapshot));
    profileNeedsRefresh = false;
    void updateHomeLyrics();
    renderHeader();
  };

  const profileTask = async (action) => {
    if (busy || !profileView) return;
    setBusy(true);
    try {
      await action();
    } catch (error) {
      if (!cleanedUp) setFooter(`That didn't work: ${error.message}`, red);
    } finally {
      setBusy(false);
      if (!cleanedUp && profileView && !tui.hasOverlay()) tui.setFocus(profileView);
    }
  };

  const inspectProfileSubject = async (subject) => {
    if (profileNeedsRefresh) {
      await refreshProfile();
      setFooter("Profile updated. Pick a song or artist.", green);
      return;
    }
    const evidenceItems = subject.evidence?.length ? subject.evidence
      : subject.evidenceId ? [{ id: subject.evidenceId, source: "From your profile" }] : [];
    const selected = await choose([
      ...(subject.target?.entityType === "track" && application.musicSimilarityReady?.() ? [{
        value: "discover", label: "Find more like this", description: "Start a request from this track that you can edit",
      }] : []),
      ...(evidenceItems.length ? [{ value: "evidence", label: "Why it's here", description: "Where this comes from and what it can't tell me" }] : []),
      ...(typeof runProfileAction === "function" ? [
        { value: "like", label: "I like this", description: "Tell Moondog you like this " + subject.kind },
        { value: "avoid", label: "Keep it out", description: "Leave this " + subject.kind + " out of suggestions" },
        ...(subject.correctionId ? [{ value: "retract", label: "Undo my choice", description: "Go back to what your listening says" }] : []),
      ] : []),
      { value: "back", label: "Back", description: "Keep looking around" },
    ], undefined, subject.label);
    if (!selected || selected.value === "back" || cleanedUp || !profileView) return;
    if (selected.value === "discover") {
      const draft = editor.getText();
      if (draft.trimStart().startsWith("/")) {
        setFooter("You have a command half-typed. Finish or clear it first.", yellow);
        return;
      }
      const target = subject.target;
      const context = `Track: ${JSON.stringify(sanitizeTerminalText(target.label))}\nArtist: ${JSON.stringify(sanitizeTerminalText(target.artistCredit))}`;
      const text = profileDiscoveryDraft && draft.includes(profileDiscoveryDraft.context)
        ? draft.replace(profileDiscoveryDraft.context, () => context)
        : `${draft || "Find me 3 songs to go to from here, and tell me why each one."}\n\n${context}`;
      profileDiscoveryDraft = { context, target: { ...target } };
      editor.setText(text);
      profileReturnHome = false;
      closeProfile();
      enterConversation();
      setFooter(runtimeStatus.state === "configured"
        ? "Request ready · edit it, then press Enter."
        : "Request ready · /model connects a model first.", runtimeStatus.state === "configured" ? green : yellow);
      return;
    }
    if (selected.value === "evidence") {
      let evidence = evidenceItems[0];
      if (evidenceItems.length > 1) {
        const choice = await choose(evidenceItems.map((item) => ({
          value: item.id, label: item.source, description: "From your profile",
        })), undefined, "Which evidence?");
        if (!choice || cleanedUp) return;
        evidence = evidenceItems.find((item) => item.id === choice.value);
      }
      const explanation = await application.explainProfileEvidence({ evidenceId: evidence.id });
      if (cleanedUp || !profileView) return;
      const detailLines = [
        "Why it's here", evidence.source, "",
        explanation.basis_summary,
        "", "What it can't tell me", explanation.interpretation_limit,
        ...(Number.isFinite(explanation.confidence) ? ["", `How sure: ${Math.round(explanation.confidence * 100)}%`] : []),
        "", ...subject.detailLines,
      ].filter((line) => typeof line === "string").map(sanitizeTerminalText);
      const model = buildTasteProfileModel(profileSnapshot);
      model.subjects = model.subjects.map((item) => item.key === subject.key ? { ...item, detailLines } : item);
      profileView.setModel(model);
      setFooter("Here's the evidence. PgUp/PgDn to scroll, Enter for actions.");
      return;
    }
    const target = subject.target;
    const args = selected.value === "retract" ? ["retract", subject.correctionId]
      : ["correct", ...(target.entityType === "track"
        ? ["--track", target.label, "--by", target.artistCredit]
        : ["--artist", target.label]), `--${selected.value}`];
    setFooter("Saving your choice...", yellow);
    await runProfileAction(args);
    if (cleanedUp || !profileView) return;
    const receipt = selected.value === "retract" ? `Undone: ${subject.label}`
      : `${selected.value === "like" ? "Liked" : "Kept out"}: ${subject.label}`;
    const named = `${subject.label}${subject.kind === "track" ? ` by ${target.artistCredit}` : ""}`;
    addMoondogMessage(selected.value === "retract"
      ? `Done. I'll read ${named} from your listening again, without your earlier choice.`
      : selected.value === "like"
        ? `Noted. You like ${named}.\n\nYour listening history stays as it was.`
        : `Noted. I'll leave ${named} out of suggestions.\n\nYour listening history stays as it was.`);
    profileReturnHome = false;
    profileNeedsRefresh = true;
    try {
      await refreshProfile();
      setFooter(`${receipt}.`, green);
    } catch (error) {
      setFooter(`${receipt}. The profile didn't refresh; Ctrl+R tries again.`, yellow);
    }
  };

  const openProfile = async ({ imported = false } = {}) => {
    if (application.profileServicesReady?.() === false) {
      addMoondogMessage("## Is there anybody out there?\n\nNot yet. Your profile starts with your listening history.\n\nType `/import`, pick your music service, and bring in your history, your library, or a public playlist. Then come back here to see what it says about you, and tell me what I got wrong.\n\nEverything stays on this machine. You don't need a model or a Spotify sign-in.");
      setFooter("No profile yet. /import brings in your history.");
      return;
    }
    if (typeof application.getProfileSummary !== "function") {
      addMoondogMessage(formatLocalResult("taste", await application.runLocalCommand("taste", runtimeStatus)));
      return;
    }
    const snapshot = await application.getProfileSummary({ maxItems: 10 });
    if (cleanedUp) return;
    profileSnapshot = snapshot;
    profileNeedsRefresh = false;
    profileReturnHome = homeVisible;
    profileView = new TasteProfileView({
      model: buildTasteProfileModel(snapshot), getTheme,
      getRows: () => Math.max(1, terminal.rows - 2 - (terminal.rows >= 20 ? 2 : 1)),
    });
    profileView.onSelect = (subject) => { void profileTask(() => inspectProfileSubject(subject)); };
    profileView.onClose = closeProfile;
    profileView.onRefresh = () => { void profileTask(async () => {
      await refreshProfile();
      setFooter("Profile updated.", green);
    }); };
    profileView.onReport = () => {
      const snapshot = profileSnapshot;
      closeProfile();
      addMoondogMessage(formatLocalResult("taste", snapshot));
      setFooter("Full report above. /taste opens the profile again.");
    };
    homeFocused = false;
    tui.setFocus(profileView);
    setFooter(imported ? "Imported. Here's your profile with everything so far." : "Pick a song or artist. Enter shows why it's here.", green);
    tui.requestRender(true);
  };

  const replaceRuntime = async (selection) => {
    if (typeof rebuildRuntime !== "function") {
      throw new Error("Runtime rebuilding is unavailable in this launch mode.");
    }
    const nextRuntime = await rebuildRuntime(selection);
    const nextStatus = nextRuntime.publicStatus();
    const previousRuntime = activeRuntime;
    activeRuntime = nextRuntime;
    runtimeStatus = nextStatus;
    try {
      previousRuntime.reset();
    } catch {}
    renderHeader();
    tui.requestRender(true);
    return nextStatus;
  };

  const selectModel = async (args) => {
    if (args.length > 2) {
      throw new Error("Usage: /model [provider] [model].");
    }

    const availableProviders = providers()
      .filter((provider) => provider.modelCount > 0)
      .sort((left, right) => {
        const priority = (provider) => {
          if (provider.id === runtimeStatus.provider) return 0;
          if (provider.id === "openai-codex") return 1;
          return 2;
        };
        return (
          priority(left) - priority(right) ||
          left.name.localeCompare(right.name)
        );
      });
    let providerId = args[0]?.toLowerCase();
    let modelId = args[1];
    while (true) {
      if (providerId) {
        if (!availableProviders.some((provider) => provider.id === providerId)) {
          throw new Error(`Unknown Pi provider: ${providerId}`);
        }
      } else {
        const selectedProvider = await choose(
          availableProviders.map((provider) => ({
            value: provider.id, label: provider.id,
            description: `${provider.name} - ${provider.modelCount} models`,
          })),
          runtimeStatus.provider,
          "Choose a model provider",
        );
        if (!selectedProvider) {
          setFooter("Model unchanged.", yellow);
          return;
        }
        providerId = selectedProvider.value;
      }
      const availableModels = models(providerId);
      if (modelId) {
        if (!availableModels.some((model) => model.id === modelId)) {
          throw new Error(`Unknown ${providerId} model: ${modelId}`);
        }
      } else {
        const selectedModel = await choose(
          availableModels.map((model) => ({
            value: model.id, label: model.id,
            description: `${model.name}${model.reasoning ? " - reasoning" : ""}`,
          })),
          runtimeStatus.provider === providerId ? runtimeStatus.model : undefined,
          `Choose a model for ${providerId}`,
        );
        if (!selectedModel) {
          if (!args[0] && availableModels.length && !cleanedUp) {
            providerId = undefined;
            continue;
          }
          setFooter("Model unchanged.", yellow);
          return;
        }
        modelId = selectedModel.value;
      }
      break;
    }

    setFooter(`Loading ${providerId}/${modelId}...`, yellow);
    const status = await replaceRuntime({ provider: providerId, model: modelId });
    addMoondogMessage(
      status.state === "configured"
        ? `Now talking through \`${providerId}/${modelId}\`. This conversation and what I remember carry over.`
        : status.reason === "provider_authentication_required"
          ? `Saved \`${providerId}/${modelId}\`, but you're not signed in yet. Run \`/auth ${providerId}\` to connect it.`
          : `Saved \`${providerId}/${modelId}\`, but I can't reach it yet (\`${status.reason}\`).`,
    );
    setFooter(
      status.state === "configured" ? "Model ready." : "Model saved, not connected yet.",
      status.state === "configured" ? green : yellow,
    );
  };

  const authenticate = async (args) => {
    if (args.length > 1) {
      throw new Error("Use /auth or /auth <provider>. Type API keys only into the hidden prompt that follows.");
    }
    if (typeof runAuth !== "function") {
      throw new Error("Sign-in isn't available when Moondog is started this way.");
    }

    const availableProviders = providers().filter((provider) =>
      supportedAuthProviderIds.includes(provider.id),
    );
    let providerId = args[0]?.toLowerCase() ?? runtimeStatus.provider;
    if (!providerId || !supportedAuthProviderIds.includes(providerId)) {
      if (args[0]) throw new Error("I can't sign in to that provider. Type /auth to see the ones I can.");
      const selectedProvider = await choose(
        availableProviders.map((provider) => ({
          value: provider.id,
          label: provider.name,
          description: `${provider.id} - ${provider.id === "openai-codex" ? "ChatGPT sign-in" : "API key"}`,
        })),
        runtimeStatus.provider ?? "openai-codex",
        "Sign in to a model provider",
      );
      if (!selectedProvider) {
        setFooter("Sign-in cancelled.", yellow);
        return;
      }
      providerId = selectedProvider.value;
    }

    setFooter(`Opening ${providerId} sign-in...`, yellow);
    tui.stop({ preserveScreen: true });
    try {
      await runAuth(providerId);
    } finally {
      if (!cleanedUp) {
        tui.start();
        // Pi may retain a queued render from before the authentication pause.
        tui.requestRender(true);
      }
    }
    if (cleanedUp) return;

    if (typeof rebuildRuntime === "function") {
      const currentSelection = runtimeStatus.provider && runtimeStatus.model
        ? { provider: runtimeStatus.provider, model: runtimeStatus.model }
        : undefined;
      const status = await replaceRuntime(currentSelection);
      addMoondogMessage(
        status.state === "configured"
          ? `Signed in. Talking through \`${status.provider}/${status.model}\`.`
          : `Signed in. Run \`/model ${providerId}\` to pick a model.`,
      );
    } else {
      addMoondogMessage("Signed in. Restart Moondog to use it.");
    }
    setFooter("Signed in.", green);
  };

  const showImportedListeningProfile = async () => {
    void updateHomeLyrics();
    try {
      const profile = await application.runLocalCommand("taste", runtimeStatus);
      addMoondogMessage([
        "Here's everything I can read so far, including anything you imported before.",
        formatLocalResult("taste", profile),
        "Type `/taste` to open any song or artist and see why it's here. `/taste report` brings this report back.",
      ].join("\n\n"));
      if (typeof application.getProfileSummary === "function") await openProfile({ imported: true });
      else setFooter("Imported. /taste opens your profile.", green);
    } catch (error) {
      addMoondogMessage(
        `Your history was imported, but I couldn't show the profile: ${error.message}\n\nNothing was lost. Type \`/taste\` to try again.`,
      );
      setFooter("Imported. The profile didn't open; try /taste.", yellow);
    }
  };

  const discardPreparedImport = () => {
    preparedImport?.close?.();
    preparedImport = null;
  };

  const setImportPage = (page, details = {}) => {
    importPage = page;
    importView?.setState({ page, origin: importOrigin, provider: importProvider, spotify: application.spotifyStatus?.(), ...details });
    tui.requestRender(true);
  };

  const closeImport = ({ restore = true } = {}) => {
    discardPreparedImport();
    importView = null;
    if (restore) homeVisible = importReturnHome;
    homeFocused = false;
    tui.setFocus(profileView ?? editor);
    setFooter("Import closed. Nothing changed.");
    tui.requestRender(true);
  };

  const inspectImport = async (filePath) => {
    discardPreparedImport();
    importOrigin = "file";
    const view = importView;
    view.setPath(filePath);
    setBusy(true);
    setImportPage("working", { message: "Reading your file..." });
    setFooter("Reading the file. Nothing is added until you say so.", yellow);
    try {
      if (typeof prepareImport !== "function") throw new Error("Reading files isn't available when Moondog is started this way.");
      const prepared = await prepareImport(filePath, { provider: importProvider });
      if (cleanedUp || importView !== view) { prepared.close?.(); return; }
      if (!importProvider) {
        importProvider = prepared.preview.kind === "library" ? "apple" : prepared.provider === "listenbrainz" ? "other" : ["youtube_music", "qq_music", "netease"].includes(prepared.provider) ? prepared.provider : "spotify";
        importFileReturn = { apple: "appleQuick", other: "other", youtube_music: "youtube_music", qq_music: "qq_music", netease: "netease" }[importProvider] ?? "spotifyHistory";
      }
      preparedImport = prepared;
      setImportPage("preview", { preview: prepared.preview });
      setFooter("Here's what's inside. Nothing is added until you import it.", green);
    } catch (error) {
      if (!cleanedUp && importView === view) {
        setImportPage("file", { error: sanitizeTerminalText(error.message) });
        setFooter("Nothing imported. Your path is still there to fix.", yellow);
      }
    } finally {
      setBusy(false);
      if (!cleanedUp && importView === view) tui.setFocus(view);
    }
  };

  const inspectRecentListening = async () => {
    discardPreparedImport();
    importOrigin = "quick";
    const view = importView;
    setBusy(true);
    setImportPage("working", { message: "Asking Spotify for your recent listening..." });
    setFooter("Reading from Spotify. Nothing is added until you say so.", yellow);
    try {
      if (typeof prepareRecentImport !== "function") throw new Error("Recent listening isn't available when Moondog is started this way. A history ZIP still works.");
      const prepared = await prepareRecentImport();
      if (cleanedUp || importView !== view) { prepared.close?.(); return; }
      if (!prepared.preview.listeningEvents) {
        prepared.close?.();
        setImportPage("empty");
        setFooter("Nothing to import yet. Try again later, or bring a ZIP.");
      } else {
        preparedImport = prepared;
        setImportPage("preview", { preview: prepared.preview });
        setFooter("Here's your recent listening. Nothing is added until you import it.", green);
      }
    } catch (error) {
      if (cleanedUp || importView !== view) return;
      const messages = {
        spotify_action_forbidden: "Spotify said no. Make sure this account is listed under User Management in your Spotify app, and that the app owner has Premium. A history ZIP works either way.",
        spotify_scope_insufficient: "Spotify needs one more permission. Reconnect Spotify to allow recent listening.",
        spotify_authentication_required: "Your Spotify sign-in has expired. Choose Reconnect Spotify.",
        spotify_quota_exceeded: "Your Spotify app has used up its quota for now. A downloaded history ZIP still works.",
        spotify_rate_limited: "Spotify wants us to slow down. Wait a minute and try again, or use a history ZIP.",
      };
      setImportPage("quick", { error: messages[error.code] ?? sanitizeTerminalText(error.message) });
      setFooter("Nothing imported. Your profile is unchanged.", yellow);
    } finally {
      setBusy(false);
      if (!cleanedUp && importView === view) tui.setFocus(view);
    }
  };

  const connectImportSpotify = async (clientId) => {
    const view = importView;
    const configuring = clientId !== undefined;
    setBusy(true);
    setImportPage("working", { message: configuring ? "Saving your Spotify app..." : "Finish signing in to Spotify in your browser. Ctrl+C cancels." });
    importAuthController = new AbortController();
    if (!configuring) tui.stop({ preserveScreen: true });
    try {
      if (typeof runSpotify !== "function") throw new Error("Spotify isn't available when Moondog is started this way.");
      await runSpotify(configuring ? ["configure", clientId] : ["login", "--history-only"], { signal: importAuthController.signal });
      if (cleanedUp || importView !== view) return;
      if (typeof rebuildRuntime === "function") await replaceRuntime();
      if (cleanedUp || importView !== view) return;
      setImportPage("quick", { message: configuring ? "App saved. Now connect Spotify." : "Spotify is connected. Next, preview your recent listening." });
      setFooter("Connected. Nothing imported yet.", green);
    } catch (error) {
      if (!cleanedUp && importView === view) {
        setImportPage(configuring ? "client" : "quick", { error: sanitizeTerminalText(error.message) });
        setFooter("Nothing imported. Try again, or use a history ZIP.", yellow);
      }
    } finally {
      importAuthController = null;
      if (!configuring && !cleanedUp) { tui.start(); tui.requestRender(true); }
      setBusy(false);
      if (!cleanedUp && importView === view) tui.setFocus(view);
    }
  };

  const commitInspectedImport = async () => {
    if (!preparedImport) return;
    const pending = preparedImport;
    const preview = pending.preview;
    const view = importView;
    let saved = false;
    setBusy(true);
    setImportPage("working", { message: "Adding it to your profile..." });
    setFooter("Saving your history on this machine...", yellow);
    try {
      const receipt = await pending.commit();
      saved = true;
      importNeedsRefresh = receipt;
      discardPreparedImport();
      if (cleanedUp) return;
      const counts = preview.kind === "library"
        ? receipt.already_imported ? "You've imported this library before, so nothing changed."
          : `Saved ${receipt.library_tracks ?? preview.tracks} songs from your library. A library shows what you keep, not when you played it, so no plays were added.`
        : receipt.already_imported || (receipt.inserted_events === 0 && !receipt.inserted_profile_evidence && !receipt.superseded_events)
        ? "Already up to date. There was nothing new in this one."
        : `${receipt.inserted_events ?? 0} new ${receipt.inserted_events === 1 ? "play" : "plays"}${receipt.duplicate_events ? `, ${receipt.duplicate_events} I already had` : ""}.${receipt.inserted_profile_evidence ? ` Also ${receipt.inserted_profile_evidence} saved songs, follows, or playlist entries.` : ""}`;
      // Keep the durable result visible even if refreshing the runtime later fails.
      addMoondogMessage([
        preview.kind === "library" ? "## Your Apple Music library is in" : preview.kind === "collection" ? "## Your collection is in" : "## Your history is in",
        [preview.sourceLabel, preview.fileName].filter(Boolean).join(" · "),
        counts,
        ...(receipt.superseded_events ? [`${receipt.superseded_events} plays you already had were replaced with more detailed versions.`] : []),
        "Everything from before is still here, including your choices. `/import` adds another source any time.",
      ].join("\n\n"));
      setImportPage("working", { message: "Saved. Reading it..." });
      setFooter("History saved. Updating your profile...", yellow);
      await refreshImportedData?.(importNeedsRefresh);
      if (cleanedUp) return;
      if (typeof rebuildRuntime === "function") await replaceRuntime();
      if (cleanedUp) return;
      importNeedsRefresh = false;
      importView = null;
      homeVisible = false;
      await showImportedListeningProfile();
    } catch (error) {
      if (cleanedUp) return;
      if (saved) {
        importView = null;
        homeVisible = false;
        profileView = null;
        tui.setFocus(editor);
        addMoondogMessage(`Your history is saved, but I couldn't update the profile: ${sanitizeTerminalText(error.message)}\n\nNothing was lost. Try \`/reload\`, then \`/taste\`.`);
        setFooter("History saved. The profile needs another try.", yellow);
      } else {
        setImportPage("preview", { preview, error: sanitizeTerminalText(error.message) });
        setFooter("Not saved. See the message above.", yellow);
      }
    } finally {
      setBusy(false);
      if (!cleanedUp) tui.setFocus(importView === view ? view : profileView ?? editor);
    }
  };

  const handleImportAction = async ({ type, path: filePath, clientId } = {}) => {
    if (busy || cleanedUp || !importView) return;
    if (type === "inspect") { await inspectImport(filePath); return; }
    if (type === "commit") { await commitInspectedImport(); return; }
    if (type === "recent") { await inspectRecentListening(); return; }
    if (type === "connectSpotify" || type === "configureSpotify") {
      await connectImportSpotify(type === "configureSpotify" ? clientId : undefined);
      return;
    }
    if (type === "close") { closeImport(); return; }
    if (type === "profile") {
      closeImport();
      await openProfile();
      return;
    }
    if (["openSpotify", "openSpotifySetup", "openAppleHelp", "openApplePrivacy", "openYouTube", "openQQ", "openNetEase"].includes(type)) {
      const destination = { openSpotify: "spotify", openSpotifySetup: "spotifySetup", openAppleHelp: "apple", openApplePrivacy: "applePrivacy", openYouTube: "youtube", openQQ: "qq", openNetEase: "netease" }[type];
      const url = IMPORT_GUIDE_URLS[destination];
      try {
        if (typeof openImportHelp !== "function") throw new Error("Can't open a browser from here.");
        await openImportHelp(destination);
        setFooter("Opened in your browser. Moondog will be here when you're back.");
      } catch {
        setImportPage(importPage, { error: `I couldn't open your browser. Here's the link: ${url}` });
      }
      return;
    }
    if (type === "back") {
      if (importPage === "start") { closeImport(); return; }
      if (importPage === "preview") {
        discardPreparedImport();
        setImportPage(importOrigin === "quick" ? "quick" : "file");
      } else setImportPage({ waiting: "spotifyHistory", file: importFileReturn, setup: "quick", client: "setup", empty: "quick", quick: "spotify", spotifyHistory: "spotify", appleQuick: "apple", appleHistory: "apple", youtubeQuick: "youtube_music", youtubeHistory: "youtube_music" }[importPage] ?? "start");
    } else if (["start", "file", "spotify", "waiting", "other", "quick", "setup", "client", "spotifyHistory", "apple", "appleQuick", "appleHistory", "youtube_music", "youtubeQuick", "youtubeHistory", "qq_music", "netease"].includes(type)) {
      discardPreparedImport();
      if (["spotify", "apple", "other", "youtube_music", "qq_music", "netease"].includes(type)) importProvider = type;
      if (type === "file" && !["preview", "file"].includes(importPage)) importFileReturn = importPage;
      setImportPage(type);
    }
    setFooter(importPage === "file"
      ? "Paste or drag in a file. Tab completes the path, Enter reads it."
      : "Pick a step.");
    tui.setFocus(importView);
  };

  const openImport = async (filePath) => {
    importProvider = null;
    importFileReturn = "start";
    if (!importView) {
      importReturnHome = homeVisible;
      homeFocused = false;
      importView = new HistoryImportView({
        tui, getTheme,
        getRows: () => Math.max(1, terminal.rows - 2 - (terminal.rows >= 20 ? 2 : 1)),
        profileReady: application.profileServicesReady?.() ?? false,
        onAction: (action) => {
          void handleImportAction(action).catch((error) => {
            if (!cleanedUp) setFooter(`That didn't work: ${error.message}`, red);
          });
        },
      });
    }
    setImportPage("start");
    tui.setFocus(importView);
    setFooter("Welcome to the machine. Pick your music service.");
    if (filePath) await inspectImport(filePath);
  };

  const runSpotifyCommand = async (args) => {
    if (typeof runSpotify !== "function") {
      throw new Error("Spotify isn't available when Moondog is started this way.");
    }
    const action = args[0]?.toLowerCase() ?? "help";
    const leavesTui = action === "login";
    setFooter(`Spotify ${action}...`, yellow);
    if (leavesTui) tui.stop({ preserveScreen: true });
    let markdown;
    try {
      markdown = await runSpotify(args);
    } finally {
      if (leavesTui && !cleanedUp) {
        tui.start();
        tui.requestRender(true);
      }
    }
    if (cleanedUp) return;

    if (
      ["configure", "login", "logout", "import-history", "sync-recent"].includes(action) &&
      typeof rebuildRuntime === "function"
    ) {
      await replaceRuntime();
    } else {
      renderHeader();
    }
    addMoondogMessage(markdown || "Done.");
    if (action === "import-history") {
      await showImportedListeningProfile();
      return;
    }
    setFooter(`Spotify ${action}: done.`, green);
  };

  const resumeConversation = async (args) => {
    if (args.length > 1) throw new Error("Use /resume, or /resume <conversation-id>.");
    if (typeof application.listSavedSessions !== "function" ||
        typeof application.resumeSession !== "function" ||
        typeof activeRuntime.restoreSession !== "function") {
      throw new Error("Saved conversations aren't available when Moondog is started this way.");
    }
    const currentId = application.ensureMemorySession?.()?.session_id;
    let selected = args[0] ? { value: args[0] } : undefined;
    if (!selected) {
      const sessions = application.listSavedSessions({ limit: 200 });
      if (!sessions.length) {
        setFooter("No saved conversations yet.");
        return;
      }
      const formatTime = new Intl.DateTimeFormat(undefined, {
        year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
      });
      const items = sessions.map((session) => ({
        value: session.session_id,
        label: sanitizeTerminalText(session.title).replace(/\s+/gu, " ").trim() || "Untitled",
        description: `${formatTime.format(new Date(session.updated_at))} · ${session.turn_count} ${session.turn_count === 1 ? "message" : "messages"}${session.session_id === currentId ? " · open now" : ""}`,
      }));
      selected = await choose(items, currentId, "Pick up where you left off");
      if (cleanedUp) return;
      if (!selected) {
        setFooter("Staying here.");
        return;
      }
    }
    if (selected.value === currentId) {
      setFooter("You're already in that one.");
      return;
    }
    storeRecall();
    conversationTitle = "";
    application.resumeSession(selected.value);
    if (!recallBySession.has(selected.value)) {
      recallBySession.set(selected.value, recallFromTurns());
    }
    editor.replaceRecall(recallBySession.get(selected.value));
    activeRuntime.restoreSession();
    const turns = application.currentSessionTurns({ limit: 40 });
    transcript.clear();
    homeVisible = turns.length === 0;
    homeFocused = false;
    editor.focused = true;
    for (const turn of turns) {
      if (turn.role === "user") addUserMessage(sanitizeTerminalText(turn.text));
      if (turn.role === "assistant") addMoondogMessage(turn.text);
    }
    const savedTitle = selected.label ? undefined
      : application.listSavedSessions({ limit: 200 }).find((session) => session.session_id === selected.value)?.title;
    const title = selected.label ?? savedTitle ?? turns.find((turn) => turn.role === "user")?.text ?? "Saved conversation";
    const resumed = String(title).replace(/\s+/gu, " ").trim();
    if (resumed && resumed !== "Saved conversation") conversationTitle = Array.from(resumed).slice(0, 160).join("");
    setFooter(`Back in: ${resumed || "Saved conversation"}`, green);
    tui.requestRender(true);
  };

  const runLocalCommand = async (command, args = []) => {
    if (command === "lyrics") {
      if (args.length > 1 || (args[0] && args[0] !== "sync")) throw new Error("Use /lyrics, or /lyrics sync.");
      if (!lyrics) throw new Error("The lyric library isn't available when Moondog is started this way.");
      if (args[0] === "sync") await updateHomeLyrics({ signal: localCommandController?.signal });
      if (cleanedUp) return;
      const status = lyrics.status();
      addMoondogMessage([
        "## Your lyric library", "",
        `${status.ready} ${status.ready === 1 ? "song" : "songs"} with lyrics · ${status.instrumental} ${status.instrumental === 1 ? "instrumental" : "instrumentals"} · ${status.entries} looked up`,
        `Stored at ${status.path}`,
        `Syncing: ${status.refresh.state}`,
        ...(lyricError ? [`Last problem: ${lyricError}`] : []),
        ...(homeLyric ? ["", `On the sleeve now: ${homeLyric.title} · ${homeLyric.artist}`, `Lyrics from ${homeLyric.sourceUrl}`] : []),
        "", "`/lyrics sync` looks up more songs from your profile. `/home` takes you back to the sleeve.",
      ].join("\n"));
      setFooter("Lyric library · /home to go back.");
      return;
    }
    if (command === "taste" || (command === "profile" && !args.length)) {
      if (args.length > 1 || (args[0] && args[0] !== "report")) throw new Error("Use /taste, or /taste report.");
      if (args[0] === "report") {
        addMoondogMessage(formatLocalResult("taste", await application.runLocalCommand("taste", runtimeStatus)));
        setFooter("Full report above. /taste opens the profile.");
      } else await openProfile();
      return;
    }
    if (command === "resume") {
      await resumeConversation(args);
      return;
    }
    if (command === "web") {
      if (typeof runWeb !== "function") throw new Error("Web lookups aren't available when Moondog is started this way.");
      setFooter("Looking it up with Codex... Ctrl+C cancels.", yellow);
      addMoondogMessage(await runWeb(args, { signal: localCommandController.signal }));
      setFooter("Done.", green);
      return;
    }
    if (command === "home") {
      if (args.length) throw new Error("/home doesn't take anything after it.");
      homeVisible = true;
      homeFocused = false;
      sleeve.invalidate();
      setFooter("Say anything, or press Tab to look around.");
      return;
    }
    if (command === "theme") {
      if (args.length > 1 || (args[0] && !["auto", "paper", "charcoal", "terminal"].includes(args[0]))) {
        throw new Error("Use /theme, or /theme paper, charcoal, terminal, or auto.");
      }
      let mode = args[0];
      if (!mode) {
        const selected = await choose([
          { value: "paper", label: "Paper", description: "Black ink on white paper" },
          { value: "charcoal", label: "Charcoal", description: "Moonlight on a black sky" },
          { value: "terminal", label: "Terminal", description: "Keep your terminal's colors" },
          { value: "auto", label: "Auto", description: "Follow MOONDOG_THEME, or guess from your terminal" },
        ], theme.mode, "Pick a look");
        mode = selected?.value;
      }
      if (!mode) { setFooter("Theme unchanged."); return; }
      theme = createMoondogTheme({ mode, environment });
      transcript.invalidate();
      sleeve.invalidate();
      setFooter(`${theme.mode === "paper" ? "Paper" : theme.mode === "charcoal" ? "Charcoal" : "Terminal"} theme, for this session.`);
      tui.requestRender(true);
      return;
    }
    if (command === "art") {
      if (args.length > 1 || (args[0] && !["auto", "braille", "ascii", "off", "text"].includes(args[0]))) {
        throw new Error("Use /art, or /art braille, ascii, off, or auto.");
      }
      sleeve.setArtMode(args[0] ?? (sleeve.artMode === "ascii" ? "braille" : "ascii"));
      homeVisible = true;
      setFooter(sleeve.artMode === "off" ? "A quiet opening, no artwork." : `${sleeve.artMode === "ascii" || sleeve.artMode === "text" ? "ASCII" : "Braille"} artwork.`);
      return;
    }
    if (command === "motion") {
      if (args.length > 1 || (args[0] && !["on", "off"].includes(args[0]))) throw new Error("Use /motion, or /motion on or off.");
      motionEnabled = args[0] ? args[0] === "on" : !motionEnabled;
      setFooter(motionEnabled ? "Animation on." : "Animation off.");
      return;
    }
    if (command === "import") {
      await openImport(args[0]);
      return;
    }
    if (command === "help") {
      if (args.length > 1 || (args[0] && args[0] !== "all")) throw new Error("Use /help, or /help all.");
      addMoondogMessage(args[0] === "all" ? helpText() : listeningHelp());
      setFooter("Type / to browse every command.");
      return;
    }
    if (command === "model") {
      await selectModel(args);
      return;
    }
    if (command === "auth") {
      await authenticate(args);
      return;
    }
    if (command === "spotify") {
      await runSpotifyCommand(args);
      return;
    }
    if (command === "profile" && args.length > 0) {
      if (typeof runProfile !== "function") {
        throw new Error("Changing your profile isn't available when Moondog is started this way.");
      }
      addMoondogMessage(await runProfile(args));
      void updateHomeLyrics();
      if (["correct", "retract"].includes(args[0])) {
        try {
          await openProfile();
        } catch (error) {
          addMoondogMessage(`Your choice is saved, but I couldn't update the profile: ${error.message}\n\nType \`/taste\` to try again.`);
          setFooter("Choice saved. The profile needs another try.", yellow);
          return;
        }
      }
      setFooter("Done.", green);
      return;
    }
    if (command === "reload") {
      if (importNeedsRefresh) await refreshImportedData?.(importNeedsRefresh);
      const status = await replaceRuntime();
      importNeedsRefresh = false;
      addMoondogMessage(
        status.state === "configured"
          ? `Reloaded \`${status.provider}/${status.model}\`. This conversation and what I remember carry over.`
          : `Reloaded, but no model is connected (\`${status.reason}\`). Your profile still works.`,
      );
      setFooter("Reloaded.", status.state === "configured" ? green : yellow);
      return;
    }
    if (command === "remember") {
      const supportedKinds = new Set([
        "fact",
        "preference",
        "constraint",
        "goal",
      ]);
      const requestedKind = args[0]?.toLowerCase();
      const kind = supportedKinds.has(requestedKind) ? requestedKind : "fact";
      const text = (kind === requestedKind ? args.slice(1) : args)
        .join(" ")
        .trim();
      if (!text) {
        throw new Error(
          "Tell me what to remember, like /remember preference no live albums.",
        );
      }
      const memory = application.rememberMemory({ text, kind });
      addMoondogMessage(
        `${memory.created ? "I'll remember that" : "I already knew that"}: ${memory.text}\n\nTo forget it later: \`/forget ${memory.memory_id}\``,
      );
      setFooter("Remembered.", green);
      return;
    }
    if (command === "forget") {
      if (args.length !== 1) throw new Error("Tell me which memory, like /forget <memory-id>.");
      const result = application.forgetMemory(args[0]);
      addMoondogMessage(
        result.forgotten
          ? `Forgotten: \`${result.memory_id}\`.`
          : `I don't have a memory called \`${result.memory_id}\`.`,
      );
      setFooter(result.forgotten ? "Forgotten." : "No such memory.", yellow);
      return;
    }
    if (command === "new") {
      if (args.length) throw new Error("/new doesn't take anything after it.");
      storeRecall();
      application.startNewSession?.("user_new");
      installRecall(sessionId(), []);
      activeRuntime.reset();
      profileDiscoveryDraft = null;
      conversationTitle = "";
      transcript.clear();
      homeVisible = true;
      homeFocused = false;
      sleeve.invalidate();
      setFooter("A fresh start. /resume brings back the last one.", green);
      return;
    }
    const result = await application.runLocalCommand(command, runtimeStatus);
    addMoondogMessage(formatLocalResult(command, result));
    setFooter("Ready.");
  };

  const openCommandPalette = async () => {
    const selected = await choose(slashCommands.map(({ name, description }) => ({
      value: name, label: `/${name}`, description,
    })), undefined, "Commands");
    if (!selected || cleanedUp) return;
    if (profileView) closeProfile();
    homeFocused = false;
    editor.focused = true;
    if (["web", "remember", "forget", "spotify", "art", "motion"].includes(selected.value)) {
      if (editor.getText()) {
        setFooter(`Your message is still here. Send or clear it, then use /${selected.value}.`);
      } else {
        editor.setText(`/${selected.value} `);
        setFooter("Finish the command, then press Enter.");
      }
      return;
    }
    if (selected.value === "import") {
      await openImport();
      return;
    }
    if (selected.value !== "commands") await editor.onSubmit(`/${selected.value}`);
  };

  editor.onSubmit = async (rawValue) => {
    if (busy) return;
    const value = sanitizeTerminalText(rawValue).trim();
    if (!value) return;

    if (value.startsWith("/")) {
      const [rawCommand = "", ...args] = value.slice(1).trim().split(/\s+/u);
      const command = rawCommand.toLowerCase();
      if (command === "quit" || command === "exit") {
        shutdown();
        return;
      }
      if (!slashCommands.some((entry) => entry.name === command)) {
        enterConversation();
        addMoondogMessage(`I don't know \`/${command}\`. Type \`/help\` to see what I do know.`);
        return;
      }
      if (command === "commands") {
        if (args.length) { addMoondogMessage("`/commands` doesn't take anything after it."); return; }
        await openCommandPalette();
        return;
      }
      try {
        if (!["home", "theme", "art", "motion", "model", "resume", "new", "taste", "profile", "import"].includes(command)) enterConversation();
        if (command !== "auth") editor.addToHistory(value);
        localCommandController = ["web", "lyrics"].includes(command) ? new AbortController() : null;
        const controller = localCommandController;
        setBusy(true, controller ? () => controller.abort() : null);
        setFooter(`/${command}...`, yellow);
        editor.disableSubmit = true;
        const argumentText = value.slice(1).trim().slice(rawCommand.length).trim();
        const parsedArgs = command === "import" ? argumentText ? [argumentText] : []
          : ["profile", "spotify", "web"].includes(command)
          ? parseTuiArguments(argumentText)
          : args;
        await runLocalCommand(command, parsedArgs);
      } catch (error) {
        if (cleanedUp) return;
        enterConversation();
        const cancelled = localCommandController?.signal.aborted;
        addMoondogMessage(cancelled ? command === "web" ? "Stopped the lookup." : "Stopped the lyric sync." : `That didn't work: ${error.message}`);
        setFooter(cancelled ? "Cancelled." : `/${command} didn't work.`, cancelled ? yellow : red);
      } finally {
        localCommandController = null;
        setBusy(false);
        editor.disableSubmit = false;
        if (!cleanedUp) tui.requestRender();
      }
      return;
    }

    const profileSeed = profileDiscoveryDraft && value.includes(profileDiscoveryDraft.context)
      ? profileDiscoveryDraft.target : undefined;
    if (profileSeed && runtimeStatus.state !== "configured") {
      editor.setText(rawValue);
      setFooter("Your request is still here · /model connects a model first.", yellow);
      return;
    }
    // Retain the binding for history recall, only while its exact metadata is visible.
    if (!profileSeed) profileDiscoveryDraft = null;
    editor.addToHistory(value);
    addUserMessage(value);
    enterConversation();
    if (runtimeStatus.state !== "configured") {
      addMoondogMessage(offlineReply(runtimeStatus));
      return;
    }

    setBusy(true, () => activeRuntime.abort());
    editor.disableSubmit = true;
    setFooter("Thinking...", yellow);
    transcriptScroll.scrollToEnd();
    addLabel("Moondog");
    const work = new AgentWork(getTheme, () => phase);
    transcript.addChild(work);
    const response = new Markdown("", 1, 1, markdownTheme, textStyle);
    transcript.addChild(response);
    let streamedText = "";
    const toolCalls = new Map();
    let legacyToolId = 0;
    const updateTool = (tool, state) => {
      if (cleanedUp) return;
      const label = sanitizeTerminalText(typeof tool === "string" ? tool : tool?.label ?? "Music tool")
        .replace(/\s+/gu, " ").trim() || "Music tool";
      // Runtime events carry call IDs; retain support for older label-only callbacks.
      const key = tool?.toolCallId ?? (state !== "running"
        ? [...toolCalls].find(([, call]) => call.state === "running" && call.label === label)?.[0]
        : undefined) ?? `label-${++legacyToolId}`;
      toolCalls.set(key, { label, state });
      work.note(key, label, state);
      if (cancellationRequested) {
        tui.requestRender();
        return;
      }
      const pending = [...toolCalls.values()].filter((call) => call.state === "running");
      if (pending.length) {
        setFooter(pending.length > 1 ? `${pending.length} running · ${pending[0].label}` : `${pending[0].label}...`, yellow);
      } else {
        setFooter(state === "failed" ? `${label} didn't work · carrying on...` : "Thinking...", state === "failed" ? yellow : dim);
      }
    };

    try {
      const result = await activeRuntime.prompt(value, {
        ...(profileSeed ? { profileSeed } : {}),
        onTextDelta: (delta) => {
          if (cleanedUp) return;
          work.quiet();
          streamedText += sanitizeTerminalText(delta);
          response.setText(streamedText);
          tui.requestRender();
        },
        onTextReplace: (replacement) => {
          if (cleanedUp) return;
          streamedText = sanitizeTerminalText(replacement);
          if (streamedText.trim()) work.quiet();
          response.setText(streamedText);
          tui.requestRender();
        },
        onModelRetry: ({ attempt, maxRetries }) => {
          if (!cancellationRequested) setFooter(`Can't reach the model. Trying again (${attempt}/${maxRetries})...`, yellow);
        },
        onToolStart: (tool) => updateTool(tool, "running"),
        onToolEnd: (tool) => updateTool(tool, tool?.isError ? "failed" : "completed"),
      });
      if (cleanedUp) return;
      if (result.status === "aborted") {
        if (streamedText.length === 0 && result.text) {
          streamedText = sanitizeTerminalText(result.text);
          response.setText(streamedText);
        }
        setFooter("Cancelled.", yellow);
      } else {
        setFooter("Up recalls this conversation.", green);
      }
    } catch (error) {
      if (cleanedUp) return;
      const connectionFailed = error.code === "model_connection_failed";
      const errorText = connectionFailed
        ? `${sanitizeTerminalText(error.message)}\n\n${error.toolsExecuted
          ? "Something already ran before the connection dropped. Check what happened before you ask again."
          : "Press ↑ to bring your message back, then Enter to try again."}`
        : `Something went wrong: ${sanitizeTerminalText(error.message)}`;
      const appendedError = connectionFailed ? errorText : `_${errorText}_`;
      response.setText(
        streamedText.length > 0 ? `${streamedText}\n\n${appendedError}` : errorText,
      );
      setFooter(connectionFailed
        ? error.toolsExecuted
          ? "Lost the model. Check what ran before retrying."
          : "Lost the model. ↑ brings your message back."
        : "The model couldn't answer.", red);
    } finally {
      if (!cleanedUp && work.calls.length) work.settle(elapsedTime(workStartedAt));
      setBusy(false);
      editor.disableSubmit = false;
      if (!cleanedUp) tui.requestRender();
    }
  };

  tui.addInputListener((data) => {
    if (tui.hasOverlay()) return undefined;
    if (importView) {
      if (busy) return { consume: true };
      if (matchesKey(data, "ctrl+c")) {
        closeImport();
        return { consume: true };
      }
      return undefined;
    }
    if (!busy && matchesKey(data, "ctrl+p")) {
      void openCommandPalette();
      return { consume: true };
    }
    if (profileView) {
      if (busy) return { consume: true };
      if (matchesKey(data, "ctrl+c")) { closeProfile(); return { consume: true }; }
      return undefined;
    }
    if (!busy && homeVisible && !editor.getText()) {
      if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
        homeFocused = !homeFocused;
        editor.focused = !homeFocused;
        tui.requestRender();
        return { consume: true };
      }
      if (homeFocused) {
        if (matchesKey(data, "up") || matchesKey(data, "down")) {
          homeSelected = (homeSelected + (matchesKey(data, "up") ? -1 : 1) + homeActions.length) % homeActions.length;
          tui.requestRender();
          return { consume: true };
        }
        if (matchesKey(data, "enter")) {
          homeFocused = false;
          editor.focused = true;
          editor.onSubmit(`/${homeActions[homeSelected].command}`);
          return { consume: true };
        }
        if (matchesKey(data, "escape")) {
          homeFocused = false;
          editor.focused = true;
          tui.requestRender();
          return { consume: true };
        }
        // Printable input and bracketed paste go untouched to the same editor.
        if (!matchesKey(data, "ctrl+c")) {
          homeFocused = false;
          editor.focused = true;
        }
      }
    }
    if (!matchesKey(data, "ctrl+c")) return undefined;
    if (busy) {
      if (cancelWork) {
        if (!cancellationRequested) {
          cancellationRequested = true;
          setFooter("Stopping...", yellow);
          cancelWork();
        }
      } else {
        setFooter("This can't be stopped halfway. Almost there...", yellow);
      }
    } else {
      shutdown();
    }
    return { consume: true };
  });

  setFooter("New conversation · /resume history");
  void sourceStatusTask.then((error) => {
    if (cleanedUp || !error || footerText !== "New conversation · /resume history") return;
    setFooter(`Couldn't read the music library: ${sanitizeTerminalText(error.message)}`, yellow);
  });
  try {
    startAttempted = true;
    tui.start();
    void updateHomeLyrics();
    await stoppedPromise;
  } finally {
    cleanup();
    await lyricTask;
  }
}
