import {
  CombinedAutocompleteProvider,
  Container,
  Markdown,
  matchesKey,
  ProcessTerminal,
  Text,
  TuiMainScreen,
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
import {
  BrandSurface,
  ListeningEditor,
  ListeningHeader,
  ListeningMenu,
  RecordSleeve,
  homeActions,
  listeningHelp,
  paintBrandLine,
} from "./brand-components.mjs";

const slashCommands = [
  { name: "home", description: "Return to the Moondog record sleeve" },
  { name: "import", description: "Bring a saved Spotify history ZIP" },
  { name: "theme", description: "Paper, charcoal, or your terminal colors" },
  { name: "art", description: "Braille, ASCII, or a minimal opening" },
  { name: "motion", description: "Turn character animation on or off" },
  { name: "commands", description: "Search every command" },
  { name: "status", description: "Inspect Moondog readiness" },
  { name: "sources", description: "Inspect local data sources" },
  { name: "profile", description: "Inspect, correct, or retract profile readings" },
  { name: "taste", description: "Explore evidence and shape your listening profile" },
  { name: "memory", description: "Inspect memory ownership" },
  { name: "tools", description: "Inspect capability states" },
  { name: "doctor", description: "Run local environment checks" },
  { name: "model", description: "Choose a Pi provider and model" },
  { name: "auth", description: "Connect a model provider with an API key or Codex sign-in" },
  { name: "web", description: "Search or read public music sources with Codex" },
  { name: "spotify", description: "Set up and control Spotify" },
  { name: "reload", description: "Reload model settings and authentication" },
  { name: "remember", description: "Save an explicit durable memory" },
  { name: "forget", description: "Forget one memory by ID" },
  { name: "resume", description: "Find and continue a saved conversation" },
  { name: "new", description: "Start a new conversation and keep this one saved" },
  { name: "help", description: "Show commands" },
  { name: "quit", description: "Exit Moondog" },
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
  const authenticationStep =
    runtimeStatus.reason === "provider_authentication_required"
      ? `\n\n运行 \`/auth ${runtimeStatus.provider ?? "openai-codex"}\` 配置模型认证。`
      : "";
  return `Moondog 的本地 CLI 已经运行，但自由对话尚未连接模型。

当前原因：\`${runtimeStatus.reason}\`。

运行 \`/model\` 选择 Pi provider 和 model。${authenticationStep}
在此之前，\`/status\`、\`/profile\`、\`/memory\`、\`/tools\` 和 \`/doctor\` 都可以正常使用。`;
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
  providers = listPiProviders,
  models = listPiModels,
  environment = process.env,
}) {
  let activeRuntime = runtime;
  application.startNewSession?.("tui_start");
  activeRuntime.reset();
  let runtimeStatus = activeRuntime.publicStatus();
  await application.sourceStatus();
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
  const tui = new TuiMainScreen(terminal);
  if (theme.plain) tui.setShowHardwareCursor(true);
  const transcript = new Container();
  let homeVisible = true;
  let profileView = null;
  let profileReturnHome = false;
  let profileSnapshot = null;
  let profileNeedsRefresh = false;
  let homeFocused = false;
  let homeSelected = 0;
  let busy = false;
  let indicator = null;
  let homeMotion = null;
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
  const sleeve = new RecordSleeve({ terminal, getTheme, environment, getState: () => ({
    focused: homeFocused, selected: homeSelected,
    editorRows: editor.render(terminal.columns).length,
  }) });
  const header = new ListeningHeader(getTheme, () => ({
    profileReady: application.profileServicesReady?.() ?? false,
    modelReady: runtimeStatus.state === "configured",
    spotifyReady: application.spotifyReady?.() ?? false,
  }));
  const renderHeader = () => { header.invalidate(); tui.requestRender(); };
  const synchronizeHomeMotion = () => {
    const shouldRun = startAttempted && !cleanedUp && motionEnabled && !theme.plain &&
      !busy && !profileView && homeVisible && !homeFocused && !tui.hasOverlay() && !editor.getText() && sleeve.canAnimate;
    if (!shouldRun) {
      clearInterval(homeMotion);
      homeMotion = null;
    } else if (!homeMotion) {
      homeMotion = setInterval(() => { sleeve.advance(); tui.requestRender(); }, LOGO_MOTION_INTERVAL_MS);
      homeMotion.unref?.();
    }
  };
  const conversation = new BrandSurface(transcript, getTheme);
  tui.addChild(header);
  tui.addChild({
    render: (width) => {
      if (profileView) {
        synchronizeHomeMotion();
        return profileView.render(width);
      }
      const lines = homeVisible ? sleeve.render(width) : conversation.render(width);
      if (!homeVisible) {
        const bodyRows = terminal.rows - 2 - editor.render(width).length - (terminal.rows >= 20 ? 2 : 1);
        while (lines.length < bodyRows) lines.push(paintBrandLine("", width, theme));
      }
      synchronizeHomeMotion();
      return lines;
    },
    invalidate: () => { sleeve.invalidate(); transcript.invalidate(); profileView?.invalidate(); },
  });
  const composer = new BrandSurface(editor, getTheme);
  tui.addChild({ render: (width) => profileView ? [] : composer.render(width), invalidate: () => composer.invalidate() });
  tui.addChild({
    invalidate() {},
    render(width) {
      const marker = theme.plain ? "." : busy && !tui.hasOverlay() ? ["◴", "◷", "◶", "◵"][phase % 4] : "◎";
      const compactHint = terminal.rows < 20 && homeVisible && !busy && !profileView;
      let statusText = compactHint && homeFocused ? "↑ ↓ choose · enter open · esc type"
        : compactHint && editor.getText() ? "enter send · ctrl+p commands"
        : compactHint && footerText === "Ready." ? "tab explore · type to talk" : footerText;
      if (profileView && width < 60) {
        statusText = footerText.replace(/\. Profile refreshed\.$/u, "");
        if (tui.hasOverlay()) statusText = "Enter chooses · Esc back";
        else if (footerText.startsWith("Select a reading.")) statusText = "Enter actions · Tab views · Esc back";
        else if (footerText.startsWith("Evidence opened.")) statusText = "Evidence · PgUp/PgDn scroll · Enter";
        else if (footerText.startsWith("Import complete.")) statusText = "Import complete · Enter reviews";
      }
      const lines = [paintBrandLine(` ${theme.faint(marker)} ${footerColor(statusText)}`, width, theme)];
      if (terminal.rows >= 20) {
        const keys = profileView
          ? width >= 76 ? "type filter · ↑↓ select · enter actions · tab views · esc back" : "↑↓ select · enter actions · tab views · esc back"
          : busy ? "draft stays here · ctrl+c cancel" : homeFocused
          ? "↑ ↓ choose · enter open · esc type"
          : homeVisible && !editor.getText()
            ? width >= 60 ? "tab explore · ctrl+p commands       enter send · shift+enter newline" : "tab explore · ctrl+p commands"
            : width >= 60 ? "ctrl+p commands · /home       enter send · shift+enter newline" : "ctrl+p commands · /home";
        lines.push(paintBrandLine(` ${theme.faint(keys)}`, width, theme));
      }
      return lines;
    },
  });
  editor.setAutocompleteProvider(
    new CombinedAutocompleteProvider(slashCommands, process.cwd(), null),
  );
  tui.setFocus(editor);

  const setBusy = (value) => {
    busy = value;
    clearInterval(indicator);
    indicator = null;
    phase = 0;
    if (busy && !theme.plain && motionEnabled) {
      indicator = setInterval(() => { phase += 1; tui.requestRender(); }, 220);
      indicator.unref?.();
    }
    tui.requestRender();
  };
  const setFooter = (text, color = dim) => {
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
    addLabel("You");
    transcript.addChild(new Text(text, 1, 1));
  };
  const addMoondogMessage = (markdown) => {
    enterConversation();
    addLabel("Moondog");
    transcript.addChild(new Markdown(sanitizeTerminalText(markdown), 1, 1, markdownTheme, textStyle));
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

  const choose = async (items, currentValue, footerText) => {
    if (items.length === 0) return undefined;
    const menu = new ListeningMenu({ items, currentValue, title: footerText.split(".")[0], getTheme, getRows: () => terminal.rows });
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
    setFooter("Profile kept · /taste to return.");
    tui.requestRender(true);
  };

  const refreshProfile = async () => {
    const snapshot = await application.getProfileSummary({ maxItems: 10 });
    if (cleanedUp || !profileView) return;
    profileSnapshot = snapshot;
    profileView.setModel(buildTasteProfileModel(snapshot));
    profileNeedsRefresh = false;
    renderHeader();
  };

  const profileTask = async (action) => {
    if (busy || !profileView) return;
    setBusy(true);
    try {
      await action();
    } catch (error) {
      if (!cleanedUp) setFooter(`Profile action failed: ${error.message}`, red);
    } finally {
      setBusy(false);
      if (!cleanedUp && profileView && !tui.hasOverlay()) tui.setFocus(profileView);
    }
  };

  const inspectProfileSubject = async (subject) => {
    if (profileNeedsRefresh) {
      await refreshProfile();
      setFooter("Profile refreshed. Select a reading to continue.", green);
      return;
    }
    const evidenceItems = subject.evidence?.length ? subject.evidence
      : subject.evidenceId ? [{ id: subject.evidenceId, source: "Profile evidence" }] : [];
    const selected = await choose([
      ...(evidenceItems.length ? [{ value: "evidence", label: "Why this reading", description: "See the source, basis, and limits" }] : []),
      ...(typeof runProfileAction === "function" ? [
        { value: "like", label: "Like", description: "An explicit preference for this " + subject.kind },
        { value: "avoid", label: "Avoid", description: "Keep this " + subject.kind + " out of suggestions" },
        ...(subject.correctionId ? [{ value: "retract", label: "Retract my choice", description: "Remove your current stance; retain listening history" }] : []),
      ] : []),
      { value: "back", label: "Back to profile", description: "Keep exploring your listening" },
    ], undefined, subject.label);
    if (!selected || selected.value === "back" || cleanedUp || !profileView) return;
    if (selected.value === "evidence") {
      let evidence = evidenceItems[0];
      if (evidenceItems.length > 1) {
        const choice = await choose(evidenceItems.map((item) => ({
          value: item.id, label: item.source, description: "Local profile evidence",
        })), undefined, "Choose listening evidence");
        if (!choice || cleanedUp) return;
        evidence = evidenceItems.find((item) => item.id === choice.value);
      }
      const explanation = await application.explainProfileEvidence({ evidenceId: evidence.id });
      if (cleanedUp || !profileView) return;
      const detailLines = [
        "Why this reading", evidence.source, "",
        explanation.basis_summary,
        "", "What this tells us", explanation.interpretation_limit,
        ...(Number.isFinite(explanation.confidence) ? ["", `Evidence confidence: ${Math.round(explanation.confidence * 100)}%`] : []),
        "", ...subject.detailLines,
      ].filter((line) => typeof line === "string").map(sanitizeTerminalText);
      const model = buildTasteProfileModel(profileSnapshot);
      model.subjects = model.subjects.map((item) => item.key === subject.key ? { ...item, detailLines } : item);
      profileView.setModel(model);
      setFooter("Evidence opened. PgUp/PgDn scroll the detail; Enter returns to actions.");
      return;
    }
    const target = subject.target;
    const args = selected.value === "retract" ? ["retract", subject.correctionId]
      : ["correct", ...(target.entityType === "track"
        ? ["--track", target.label, "--by", target.artistCredit]
        : ["--artist", target.label]), `--${selected.value}`];
    setFooter("Saving your choice locally...", yellow);
    await runProfileAction(args);
    if (cleanedUp || !profileView) return;
    const receipt = selected.value === "retract" ? `Retracted: ${subject.label}`
      : `Saved: ${selected.value === "like" ? "Like" : "Avoid"} · ${subject.label}`;
    addMoondogMessage(`${receipt}${subject.kind === "track" ? ` (${target.artistCredit})` : ""}.\n\nYour explicit preference is updated. Listening history is unchanged.`);
    profileReturnHome = false;
    profileNeedsRefresh = true;
    try {
      await refreshProfile();
      setFooter(`${receipt}. Profile refreshed.`, green);
    } catch (error) {
      setFooter(`${receipt}. Refresh failed; Ctrl+R retries: ${error.message}`, yellow);
    }
  };

  const openProfile = async ({ imported = false } = {}) => {
    if (application.profileServicesReady?.() === false) {
      addMoondogMessage("## Start your listening profile\n\nBring a saved Spotify history ZIP with `/import`, or import your Apple Music library. Then select a track or artist here to inspect the evidence and shape your preferences.\n\nYour profile works locally without a model or Spotify sign-in.");
      setFooter("No local profile yet. /import brings your listening history.");
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
      setFooter("Profile refreshed from local listening evidence.", green);
    }); };
    profileView.onReport = () => {
      const snapshot = profileSnapshot;
      closeProfile();
      addMoondogMessage(formatLocalResult("taste", snapshot));
      setFooter("Full tasteprint. /taste returns to the interactive profile.");
    };
    homeFocused = false;
    tui.setFocus(profileView);
    setFooter(imported ? "Import complete. Review your cumulative local profile." : "Select a reading. Enter opens evidence and your choices.", green);
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
          "Choose a Pi provider. Enter selects; Esc returns.",
        );
        if (!selectedProvider) {
          setFooter("Model selection cancelled.", yellow);
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
          `Choose a model for ${providerId}. Enter selects; Esc returns.`,
        );
        if (!selectedModel) {
          if (!args[0] && availableModels.length && !cleanedUp) {
            providerId = undefined;
            continue;
          }
          setFooter("Model selection cancelled.", yellow);
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
        ? `Using Pi model \`${providerId}/${modelId}\`. The current conversation and memory were retained.`
        : `Saved \`${providerId}/${modelId}\`, but the runtime is offline: \`${status.reason}\`.${
            status.reason === "provider_authentication_required"
              ? ` Run \`/auth ${providerId}\` to connect this provider.`
              : ""
          }`,
    );
    setFooter(
      status.state === "configured" ? "Model ready." : "Model saved; runtime offline.",
      status.state === "configured" ? green : yellow,
    );
  };

  const authenticate = async (args) => {
    if (args.length > 1) {
      throw new Error("Usage: /auth [provider]. Enter API keys only in the hidden prompt.");
    }
    if (typeof runAuth !== "function") {
      throw new Error("Authentication is unavailable in this launch mode.");
    }

    const availableProviders = providers().filter((provider) =>
      supportedAuthProviderIds.includes(provider.id),
    );
    let providerId = args[0]?.toLowerCase() ?? runtimeStatus.provider;
    if (!providerId || !supportedAuthProviderIds.includes(providerId)) {
      if (args[0]) throw new Error("Unsupported authentication provider. Use /auth to choose one.");
      const selectedProvider = await choose(
        availableProviders.map((provider) => ({
          value: provider.id,
          label: provider.name,
          description: `${provider.id} - ${provider.id === "openai-codex" ? "ChatGPT sign-in" : "API key"}`,
        })),
        runtimeStatus.provider ?? "openai-codex",
        "Connect a model provider. Enter selects; Esc returns.",
      );
      if (!selectedProvider) {
        setFooter("Authentication cancelled.", yellow);
        return;
      }
      providerId = selectedProvider.value;
    }

    setFooter(`Opening ${providerId} authentication...`, yellow);
    tui.stop({ preserveScreen: true });
    try {
      await runAuth(providerId);
    } finally {
      if (!cleanedUp) tui.start();
    }
    if (cleanedUp) return;

    if (typeof rebuildRuntime === "function") {
      const currentSelection = runtimeStatus.provider && runtimeStatus.model
        ? { provider: runtimeStatus.provider, model: runtimeStatus.model }
        : undefined;
      const status = await replaceRuntime(currentSelection);
      addMoondogMessage(
        status.state === "configured"
          ? `Authentication complete. Using \`${status.provider}/${status.model}\`.`
          : `Authentication complete. Run \`/model ${providerId}\` to choose a model.`,
      );
    } else {
      addMoondogMessage("Authentication complete. Restart Moondog to load it.");
    }
    setFooter("Authentication complete.", green);
  };

  const showImportedListeningProfile = async () => {
    try {
      const profile = await application.runLocalCommand("taste", runtimeStatus);
      addMoondogMessage([
        "This is your cumulative local profile after this import, including previously imported history. The import receipt above reports this file's contribution.",
        formatLocalResult("taste", profile),
        "Use `/taste` to select a track or artist, inspect its evidence, and adjust your preferences. `/taste report` reopens this full report.",
      ].join("\n\n"));
      if (typeof application.getProfileSummary === "function") await openProfile({ imported: true });
      else setFooter("Import complete. Profile ready to review; /taste to explore.", green);
    } catch (error) {
      addMoondogMessage(
        `The import completed, but its listening profile could not be displayed: ${error.message}\n\nThe imported history is retained. Use \`/taste\` to retry the profile view.`,
      );
      setFooter("Import complete; profile review unavailable.", yellow);
    }
  };

  const runSpotifyCommand = async (args) => {
    if (typeof runSpotify !== "function") {
      throw new Error("Spotify control is unavailable in this launch mode.");
    }
    const action = args[0]?.toLowerCase() ?? "help";
    const leavesTui = action === "login";
    setFooter(`Spotify ${action}...`, yellow);
    if (leavesTui) tui.stop({ preserveScreen: true });
    let markdown;
    try {
      markdown = await runSpotify(args);
    } finally {
      if (leavesTui && !cleanedUp) tui.start();
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
    addMoondogMessage(markdown || "Spotify command completed.");
    if (action === "import-history") {
      await showImportedListeningProfile();
      return;
    }
    setFooter(`Spotify ${action} complete.`, green);
  };

  const resumeConversation = async (args) => {
    if (args.length > 1) throw new Error("Usage: /resume [session-id].");
    if (typeof application.listSavedSessions !== "function" ||
        typeof application.resumeSession !== "function" ||
        typeof activeRuntime.restoreSession !== "function") {
      throw new Error("Saved conversations are unavailable in this launch mode.");
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
        label: sanitizeTerminalText(session.title).replace(/\s+/gu, " ").trim() || "Untitled conversation",
        description: `${formatTime.format(new Date(session.updated_at))} · ${session.turn_count} messages${session.session_id === currentId ? " · open" : ""}`,
      }));
      selected = await choose(items, currentId, "Resume conversation");
      if (cleanedUp) return;
      if (!selected) {
        setFooter("Resume cancelled. Conversation kept.");
        return;
      }
    }
    if (selected.value === currentId) {
      setFooter("This conversation is already open.");
      return;
    }
    application.resumeSession(selected.value);
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
    const title = selected.label ?? turns.find((turn) => turn.role === "user")?.text ?? "Saved conversation";
    setFooter(`Resumed: ${title.replace(/\s+/gu, " ")}`, green);
    tui.requestRender(true);
  };

  const runLocalCommand = async (command, args = []) => {
    if (command === "taste" || (command === "profile" && !args.length)) {
      if (args.length > 1 || (args[0] && args[0] !== "report")) throw new Error("Usage: /taste [report].");
      if (args[0] === "report") {
        addMoondogMessage(formatLocalResult("taste", await application.runLocalCommand("taste", runtimeStatus)));
        setFooter("Full tasteprint. /taste opens the interactive profile.");
      } else await openProfile();
      return;
    }
    if (command === "resume") {
      await resumeConversation(args);
      return;
    }
    if (command === "web") {
      if (typeof runWeb !== "function") throw new Error("Web research is unavailable in this launch mode.");
      setFooter("Codex web research... Press Ctrl+C to cancel.", yellow);
      addMoondogMessage(await runWeb(args, { signal: localCommandController.signal }));
      setFooter("Web command complete.", green);
      return;
    }
    if (command === "home") {
      if (args.length) throw new Error("Usage: /home.");
      homeVisible = true;
      homeFocused = false;
      sleeve.invalidate();
      setFooter("Type a thought, or press Tab to explore.");
      return;
    }
    if (command === "theme") {
      if (args.length > 1 || (args[0] && !["auto", "paper", "charcoal", "terminal"].includes(args[0]))) {
        throw new Error("Usage: /theme [paper|charcoal|terminal|auto].");
      }
      let mode = args[0];
      if (!mode) {
        const selected = await choose([
          { value: "paper", label: "Paper", description: "Warm ivory and charcoal ink" },
          { value: "charcoal", label: "Charcoal", description: "A quiet room, warm light" },
          { value: "terminal", label: "Terminal", description: "Keep your terminal's colors" },
          { value: "auto", label: "Auto", description: "Use MOONDOG_THEME or the terminal hint" },
        ], theme.mode, "Choose a Moondog theme. Enter selects; Esc cancels.");
        mode = selected?.value;
      }
      if (!mode) { setFooter("Theme unchanged."); return; }
      theme = createMoondogTheme({ mode, environment });
      transcript.invalidate();
      sleeve.invalidate();
      setFooter(`${theme.mode === "paper" ? "Paper" : theme.mode === "charcoal" ? "Charcoal" : "Terminal"} theme. Applied to this session.`);
      tui.requestRender(true);
      return;
    }
    if (command === "art") {
      if (args.length > 1 || (args[0] && !["auto", "braille", "ascii", "off", "text"].includes(args[0]))) {
        throw new Error("Usage: /art [braille|ascii|off|auto].");
      }
      sleeve.setArtMode(args[0] ?? (sleeve.artMode === "ascii" ? "braille" : "ascii"));
      homeVisible = true;
      setFooter(sleeve.artMode === "off" ? "Minimal opening." : `${sleeve.artMode === "ascii" || sleeve.artMode === "text" ? "ASCII" : "Braille"} character artwork.`);
      return;
    }
    if (command === "motion") {
      if (args.length > 1 || (args[0] && !["on", "off"].includes(args[0]))) throw new Error("Usage: /motion [on|off].");
      motionEnabled = args[0] ? args[0] === "on" : !motionEnabled;
      setFooter(motionEnabled ? "Character motion on." : "Character motion off.");
      return;
    }
    if (command === "import") {
      if (args.length > 1) throw new Error('Usage: /import ["/path/to/spotify-history.zip"].');
      if (args[0]) { await runSpotifyCommand(["import-history", args[0]]); return; }
      addMoondogMessage('## Bring your listening history\n\nPaste the path to your saved Spotify history ZIP between the quotes below, then press Enter.\n\nThe archive is imported into your local cumulative profile. Your listening profile appears here immediately afterward.');
      editor.setText('/spotify import-history ""');
      editor.handleInput("\u001b[D");
      setFooter("Paste the ZIP path between the quotes, then press Enter.");
      return;
    }
    if (command === "help") {
      if (args.length > 1 || (args[0] && args[0] !== "all")) throw new Error("Usage: /help [all].");
      addMoondogMessage(args[0] === "all" ? helpText() : listeningHelp());
      setFooter("Find a command here, or type / to browse.");
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
        throw new Error("Profile corrections are unavailable in this launch mode.");
      }
      addMoondogMessage(await runProfile(args));
      if (["correct", "retract"].includes(args[0])) {
        try {
          await openProfile();
        } catch (error) {
          addMoondogMessage(`Your choice was saved, but the profile could not refresh: ${error.message}\n\nUse \`/taste\` to retry.`);
          setFooter("Choice saved; profile refresh unavailable.", yellow);
          return;
        }
      }
      setFooter("Profile command complete.", green);
      return;
    }
    if (command === "reload") {
      const status = await replaceRuntime();
      addMoondogMessage(
        status.state === "configured"
          ? `Reloaded \`${status.provider}/${status.model}\`. The current conversation and memory were retained.`
          : `Reloaded model settings. Runtime is offline: \`${status.reason}\`.`,
      );
      setFooter("Runtime reloaded.", status.state === "configured" ? green : yellow);
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
          "Usage: /remember [fact|preference|constraint|goal] <text>.",
        );
      }
      const memory = application.rememberMemory({ text, kind });
      addMoondogMessage(
        `${memory.created ? "Remembered" : "Already remembered"}: ${memory.text}\n\nMemory ID: \`${memory.memory_id}\``,
      );
      setFooter("Memory saved.", green);
      return;
    }
    if (command === "forget") {
      if (args.length !== 1) throw new Error("Usage: /forget <memory-id>.");
      const result = application.forgetMemory(args[0]);
      addMoondogMessage(
        result.forgotten
          ? `Forgot memory \`${result.memory_id}\`.`
          : `No active memory found for \`${result.memory_id}\`.`,
      );
      setFooter(result.forgotten ? "Memory forgotten." : "Memory not found.", yellow);
      return;
    }
    if (command === "new") {
      if (args.length) throw new Error("Usage: /new.");
      application.startNewSession?.("user_new");
      activeRuntime.reset();
      transcript.clear();
      homeVisible = true;
      homeFocused = false;
      sleeve.invalidate();
      setFooter("Started a new conversation. /resume keeps your history.", green);
      return;
    }
    const result = await application.runLocalCommand(command, runtimeStatus);
    addMoondogMessage(formatLocalResult(command, result));
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
        setFooter(`Draft kept. Use /${selected.value} after sending it.`);
      } else {
        editor.setText(`/${selected.value} `);
        setFooter("Complete the command, then press Enter.");
      }
      return;
    }
    if (selected.value === "import" && editor.getText()) {
      setFooter("Draft kept. Use /import after sending it.");
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
        addMoondogMessage(`Unknown command: \`/${command}\`. Use \`/help\`.`);
        return;
      }
      if (command === "commands") {
        if (args.length) { addMoondogMessage("Usage: /commands."); return; }
        await openCommandPalette();
        return;
      }
      try {
        if (!["home", "theme", "art", "motion", "model", "resume", "new", "taste", "profile"].includes(command)) enterConversation();
        if (command !== "auth") editor.addToHistory(value);
        setBusy(true);
        localCommandController = command === "web" ? new AbortController() : null;
        editor.disableSubmit = true;
        const parsedArgs = ["profile", "spotify", "web", "import"].includes(command)
          ? parseTuiArguments(value.slice(1).trim().slice(rawCommand.length))
          : args;
        await runLocalCommand(command, parsedArgs);
      } catch (error) {
        enterConversation();
        const cancelled = localCommandController?.signal.aborted;
        addMoondogMessage(cancelled ? "Web research cancelled." : `Local command failed: ${error.message}`);
        setFooter(cancelled ? "Cancelled." : "Command failed.", cancelled ? yellow : red);
      } finally {
        localCommandController = null;
        setBusy(false);
        editor.disableSubmit = false;
        tui.requestRender();
      }
      return;
    }

    enterConversation();
    editor.addToHistory(value);
    addUserMessage(value);
    if (runtimeStatus.state !== "configured") {
      addMoondogMessage(offlineReply(runtimeStatus));
      return;
    }

    setBusy(true);
    editor.disableSubmit = true;
    setFooter("Thinking... Press Ctrl+C to cancel.", yellow);
    addLabel("Moondog");
    const response = new Markdown("", 1, 1, markdownTheme, textStyle);
    transcript.addChild(response);
    let streamedText = "";

    try {
      const result = await activeRuntime.prompt(value, {
        onTextDelta: (delta) => {
          streamedText += sanitizeTerminalText(delta);
          response.setText(streamedText);
          tui.requestRender();
        },
        onTextReplace: (replacement) => {
          streamedText = sanitizeTerminalText(replacement);
          response.setText(streamedText);
          tui.requestRender();
        },
        onModelRetry: ({ attempt, maxRetries }) => {
          setFooter(`Retrying model connection ${attempt}/${maxRetries}... Ctrl+C cancels.`, yellow);
        },
        onToolStart: (tool) => {
          const label = typeof tool === "string" ? tool : tool.label;
          setFooter(`Using capability: ${label}`, yellow);
        },
        onToolEnd: (tool) => {
          const label = typeof tool === "string" ? tool : tool.label;
          setFooter(
            tool?.isError
              ? `Capability failed: ${label}`
              : `Capability finished: ${label}`,
            tool?.isError ? red : green,
          );
        },
      });
      if (result.status === "aborted") {
        if (streamedText.length === 0 && result.text) {
          streamedText = sanitizeTerminalText(result.text);
          response.setText(streamedText);
        }
        setFooter("Cancelled.", yellow);
      } else {
        setFooter("Ready.", green);
      }
    } catch (error) {
      const connectionFailed = error.code === "model_connection_failed";
      const errorText = connectionFailed
        ? `${sanitizeTerminalText(error.message)}\n\n${error.toolsExecuted
          ? "A capability already ran during this turn. Check results before repeating an action."
          : "Press ↑ to recall your message and Enter to try again."}`
        : `Runtime error: ${sanitizeTerminalText(error.message)}`;
      const appendedError = connectionFailed ? errorText : `_${errorText}_`;
      response.setText(
        streamedText.length > 0 ? `${streamedText}\n\n${appendedError}` : errorText,
      );
      setFooter(connectionFailed
        ? error.toolsExecuted
          ? "Connection failed. Check results before repeating."
          : "Connection failed. ↑ recalls your message."
        : "The model request failed.", red);
    } finally {
      setBusy(false);
      editor.disableSubmit = false;
      tui.requestRender();
    }
  };

  tui.addInputListener((data) => {
    if (tui.hasOverlay()) return undefined;
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
      if (localCommandController) localCommandController.abort();
      else activeRuntime.abort();
      setFooter("Cancelling the active response...", yellow);
    } else {
      shutdown();
    }
    return { consume: true };
  });

  setFooter("New conversation · /resume history");
  try {
    startAttempted = true;
    tui.start();
    await stoppedPromise;
  } finally {
    cleanup();
  }
}
