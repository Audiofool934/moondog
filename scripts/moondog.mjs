#!/usr/bin/env node

import { MoondogApplication } from "../src/core/moondog-application.mjs";
import { openLocalMemoryStore } from "../src/memory/local-memory-store.mjs";
import {
  openAppleProjectionDomainServices,
  resolveAppleMusicSubjectId,
} from "../src/core/apple-projection-domain-services.mjs";
import { readAppleMusicSourceStatus } from "../src/core/apple-library-source-status.mjs";
import { createListeningProfileDomainServices } from "../src/core/listening-profile-domain-services.mjs";
import { runMemoryReflection } from "../src/memory/reflection-worker.mjs";
import { createConfiguredRuntime } from "../src/runtime/pi/configured-runtime.mjs";
import { writePiRuntimeSelection } from "../src/runtime/pi/runtime-settings.mjs";
import {
  formatLocalResult,
  formatDemoResult,
  formatMemoryReflection,
  helpText,
  sanitizeTerminalText,
} from "../src/surfaces/cli/format-output.mjs";
import { runAuthCommand } from "../src/surfaces/cli/auth-command.mjs";
import { runDataCommand } from "../src/surfaces/cli/data-command.mjs";
import { runCatalogCommand } from "../src/surfaces/cli/catalog-command.mjs";
import { runProfileCommand } from "../src/surfaces/cli/profile-command.mjs";
import { createCodexWebResearch } from "../src/integrations/web/codex-web.mjs";
import { runWebCommand } from "../src/surfaces/cli/web-command.mjs";
import { openSpotifyConnection } from "../src/integrations/spotify/connection.mjs";
import {
  openSpotifyResolutionCache,
} from "../src/integrations/spotify/resolution-cache.mjs";
import {
  readSpotifyConfiguration,
} from "../src/integrations/spotify/settings.mjs";
import { runSpotifyCommand } from "../src/surfaces/cli/spotify-command.mjs";
import { runListenBrainzCommand } from "../src/surfaces/cli/listenbrainz-command.mjs";
import { openListeningHistoryStore } from "../src/profile/listening-history-store.mjs";
import { runMoondogTui } from "../src/surfaces/cli/tui.mjs";
import { createAppleMusicCatalog } from "../src/integrations/apple-music/catalog.mjs";
import {
  createOpenMusicSimilarity,
  createWikidataArtistResolver,
} from "../src/integrations/open-music-similarity/artist-radio.mjs";
import { runMoondogDemo } from "../src/demo/moondog-demo.mjs";
import { writeFictionalSpotifyHistoryArchive } from "../src/demo/fictional-spotify-history.mjs";
import { writeTasteprintArtifact } from "../src/surfaces/html/tasteprint-artifact.mjs";
import {
  persistTasteFromSpotifyArchive,
  projectTasteFromSpotifyArchives,
  projectTasteFromSpotifyArchive,
  SPOTIFY_ARCHIVE_SET_MAXIMUM,
} from "../src/profile/spotify-archive-taste.mjs";
import { deriveArtistReleaseHintsFromSpotifyArchive } from "../src/profile/spotify-archive-catalog-hints.mjs";
import { runMoondogStudio } from "../src/surfaces/web/studio.mjs";

const localCommands = new Set([
  "status",
  "sources",
  "profile",
  "taste",
  "memory",
  "tools",
  "doctor",
]);

function parseArguments(argv) {
  const values = [...argv];
  const jsonIndex = values.indexOf("--json");
  const json = jsonIndex !== -1;
  if (json) values.splice(jsonIndex, 1);
  const dryRunIndex = values.indexOf("--dry-run");
  const dryRun = dryRunIndex !== -1;
  if (dryRun) values.splice(dryRunIndex, 1);
  const offlineIndex = values.indexOf("--offline");
  const offline = offlineIndex !== -1;
  if (offline) values.splice(offlineIndex, 1);
  const htmlIndex = values.indexOf("--html");
  const html = htmlIndex !== -1;
  if (html) values.splice(htmlIndex, 1);
  const cardIndex = values.indexOf("--card");
  const card = cardIndex !== -1;
  if (card) values.splice(cardIndex, 1);
  const saveIndex = values.indexOf("--save");
  const save = saveIndex !== -1;
  if (save) values.splice(saveIndex, 1);
  const outputIndex = values.indexOf("--output");
  let output = null;
  if (outputIndex !== -1) {
    if (values.lastIndexOf("--output") !== outputIndex) {
      throw new Error("The --output option may be provided only once.");
    }
    output = values[outputIndex + 1];
    if (!output || output.startsWith("--")) {
      throw new Error("The --output option requires a file or directory path.");
    }
    values.splice(outputIndex, 2);
  }
  const fromArchives = [];
  let fromIndex = values.indexOf("--from");
  while (fromIndex !== -1) {
    const archivePath = values[fromIndex + 1];
    if (!archivePath || archivePath.startsWith("--")) {
      throw new Error("The --from option requires a Spotify history ZIP path.");
    }
    fromArchives.push(archivePath);
    values.splice(fromIndex, 2);
    fromIndex = values.indexOf("--from");
  }
  if (fromArchives.length > SPOTIFY_ARCHIVE_SET_MAXIMUM) {
    throw new Error(
      `The --from option may be provided at most ${SPOTIFY_ARCHIVE_SET_MAXIMUM} times.`,
    );
  }
  return {
    command: values[0],
    rest: values.slice(1),
    json,
    dryRun,
    offline,
    html,
    card,
    save,
    output,
    from: fromArchives[0] ?? null,
    fromArchives,
  };
}

async function optionalAppleMusicSubjectId() {
  const source = await readAppleMusicSourceStatus();
  if (source.state === "missing") return null;
  if (source.state === "invalid") {
    const error = new Error("The canonical Apple Music import source is invalid");
    error.code = "projection_source_invalid";
    throw error;
  }
  return resolveAppleMusicSubjectId();
}

function projectionErrorCode(error) {
  return typeof error?.code === "string" &&
    /^projection_[a-z0-9_]+$/u.test(error.code)
    ? error.code
    : null;
}

async function loadDomainServices() {
  const listeningHistoryStore = await openListeningHistoryStore();
  let domainServicesError = null;
  let subjectId = null;
  try {
    const appleSubjectId = await optionalAppleMusicSubjectId();
    subjectId = listeningHistoryStore.localSubjectId({
      ...(appleSubjectId ? { preferredSubjectId: appleSubjectId } : {}),
    });
    if (appleSubjectId) {
      try {
        return {
          domainServices: await openAppleProjectionDomainServices({
            listeningHistoryStore,
            subjectId: appleSubjectId,
          }),
          domainServicesError: null,
        };
      } catch (error) {
        domainServicesError = projectionErrorCode(error);
        if (!domainServicesError) throw error;
      }
    } else {
      domainServicesError = "projection_subject_unavailable";
    }
  } catch (error) {
    domainServicesError = projectionErrorCode(error);
    if (!domainServicesError) {
      listeningHistoryStore.close();
      throw error;
    }
    subjectId ??= listeningHistoryStore.localSubjectId();
  }

  if (
    subjectId &&
    listeningHistoryStore.subjectDataStatus({ subjectId }).state === "ready"
  ) {
    return {
      domainServices: createListeningProfileDomainServices({
        listeningHistoryStore,
        subjectId,
      }),
      domainServicesError,
    };
  }
  listeningHistoryStore.close();
  return { domainServices: null, domainServicesError };
}

let spotifyResolutionCachePromise = null;

function spotifyResolutionCache() {
  spotifyResolutionCachePromise ??= openSpotifyResolutionCache().catch(
    () => null,
  );
  return spotifyResolutionCachePromise;
}

async function closeSpotifyResolutionCache() {
  if (!spotifyResolutionCachePromise) return;
  const cache = await spotifyResolutionCachePromise;
  cache?.close?.();
  spotifyResolutionCachePromise = null;
}

async function spotifyResolutionCacheIfConfigured() {
  return (await readSpotifyConfiguration(process.env))
    ? await spotifyResolutionCache()
    : null;
}

async function loadSpotifyConnection() {
  try {
    return await openSpotifyConnection({
      resolutionCache: await spotifyResolutionCacheIfConfigured(),
    });
  } catch (error) {
    const reason =
      typeof error?.code === "string" && /^spotify_[a-z0-9_]+$/u.test(error.code)
        ? error.code
        : "spotify_connection_failed";
    return {
      service: null,
      authentication: null,
      ready: () => false,
      publicStatus: () => ({
        provider: "spotify",
        state: "unavailable",
        reason,
        client_id_configured: false,
        external_effects: "disabled",
      }),
    };
  }
}

async function spotifyRecentSyncContext(args) {
  if (!new Set(["sync-recent", "import-history"]).has(args[0])) return {};
  const recentActivityStore = await openListeningHistoryStore();
  try {
    const appleSubjectId = await optionalAppleMusicSubjectId();
    return {
      subjectId: recentActivityStore.localSubjectId({
        ...(appleSubjectId ? { preferredSubjectId: appleSubjectId } : {}),
        create: true,
      }),
      recentActivityStore,
    };
  } catch (error) {
    recentActivityStore.close();
    throw error;
  }
}

async function runSpotifySurface(options) {
  const syncContext = await spotifyRecentSyncContext(options.args);
  try {
    return await runSpotifyCommand({
      ...options,
      ...syncContext,
    });
  } finally {
    syncContext.recentActivityStore?.close?.();
  }
}

async function runListenBrainzSurface(options) {
  if (options.args[0] !== "import-history") {
    return runListenBrainzCommand(options);
  }
  const historyStore = await openListeningHistoryStore();
  try {
    const appleSubjectId = await optionalAppleMusicSubjectId();
    const subjectId = historyStore.localSubjectId({
      ...(appleSubjectId ? { preferredSubjectId: appleSubjectId } : {}),
      create: true,
    });
    return await runListenBrainzCommand({
      ...options,
      historyStore,
      subjectId,
    });
  } finally {
    historyStore.close();
  }
}

function tasteCoverage(profile) {
  return {
    effective_listening_events:
      profile.coverage?.effective_listening_events ?? null,
    listening_hours: profile.coverage?.listening_hours ?? null,
    distinct_tracks: profile.coverage?.listening_tracks ?? null,
  };
}

function tasteSourceLabel(source) {
  if (source?.data_scope === "combined_spotify_history") {
    return "combined Spotify history archives";
  }
  if (source?.data_scope === "lifetime_extended_streaming_history") {
    return "Spotify Extended Streaming History";
  }
  if (source?.data_scope === "past_year_account_data") {
    return "Spotify Account Data";
  }
  return "Spotify history";
}

async function emitTasteprintArtifact(
  profile,
  { output, json, generatedAt, source = null, format = "full" } = {},
) {
  const artifact = await writeTasteprintArtifact(profile, {
    outputPath: output ?? undefined,
    generatedAt,
    format,
  });
  const result = {
    ...artifact,
    coverage: tasteCoverage(profile),
    ...(source ? { source } : {}),
  };
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    const lines = [
      format === "card"
        ? "Created a private local Moondog Tasteprint card."
        : "Created a private local Moondog Tasteprint.",
      `Artifact: ${artifact.path}`,
      `Coverage: ${(result.coverage.effective_listening_events ?? 0).toLocaleString("en-US")} effective events, ${(result.coverage.listening_hours ?? 0).toLocaleString("en-US")} listening hours, ${(result.coverage.distinct_tracks ?? 0).toLocaleString("en-US")} distinct tracks.`,
    ];
    if (source?.persistent_import === false) {
      lines.push(
        `Source: one-off ${tasteSourceLabel(source)} preview, not added to persistent history.`,
      );
    } else if (source?.persistent_import === true) {
      lines.push(
        `Source: ${tasteSourceLabel(source)} imported into Moondog's private persistent history.`,
      );
    }
    lines.push(
      "Open the HTML file directly in a browser. It has no scripts, external assets, or network requests.",
    );
    if (format === "card") {
      lines.push(
        "Review every visible artist, track, date, and aggregate before sharing it.",
      );
    }
    process.stdout.write(`${lines.join("\n")}\n`);
  }
  return result;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));

  if (options.command === "help" || options.command === "--help" || options.command === "-h") {
    process.stdout.write(`${helpText()}\n`);
    return;
  }

  if (options.command === "web") {
    if (options.dryRun || options.offline || options.html || options.card || options.save || options.from || options.output) {
      throw new Error("Usage: moondog web status|search|read [arguments] [--json].");
    }
    const webResearch = await createCodexWebResearch();
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    try {
      process.stdout.write(`${await runWebCommand({ args: options.rest, webResearch, json: options.json, signal: controller.signal })}\n`);
    } finally {
      process.removeListener("SIGINT", abort);
      process.removeListener("SIGTERM", abort);
      webResearch.close();
    }
    return;
  }

  if (options.command === "studio") {
    const demoOnly =
      options.rest.length === 1 && options.rest[0] === "--demo";
    if (
      (options.rest.length > 0 && !demoOnly) ||
      (demoOnly && options.from) ||
      options.json ||
      options.dryRun ||
      options.offline ||
      options.html ||
      options.card ||
      options.save ||
      options.output
    ) {
      throw new Error(
        "Usage: moondog studio [--demo | --from <spotify-history.zip> [--from <spotify-history.zip>]].",
      );
    }
    await runMoondogStudio({
      demoOnly,
      archivePaths: options.fromArchives,
    });
    return;
  }

  if (options.command === "demo-history") {
    if (
      options.rest.length > 0 ||
      options.dryRun ||
      options.offline ||
      options.html ||
      options.card ||
      options.save ||
      options.from ||
      !options.output
    ) {
      throw new Error(
        "Usage: moondog demo-history --output <absolute-file.zip> [--json].",
      );
    }
    const result = await writeFictionalSpotifyHistoryArchive({
      outputPath: options.output,
    });
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(
        [
          "Created a fictional Spotify Extended Streaming History ZIP.",
          `Archive: ${sanitizeTerminalText(result.archive_path)}`,
          `Records: ${result.record_count} across ${result.years.join(", ")}.`,
          `SHA-256: ${result.archive_sha256}`,
          "Boundary: no private listening data was read, and no network, provider action, or persistent profile write occurred.",
          "Next: pass the ZIP to moondog taste --from <archive.zip> --html, or drop it into moondog studio.",
        ].join("\n") + "\n",
      );
    }
    return;
  }

  if (options.command === "catalog") {
    if (
      options.dryRun ||
      options.offline ||
      options.html ||
      options.card ||
      options.save ||
      options.output ||
      options.fromArchives.length > 1
    ) {
      throw new Error(
        "Usage: moondog catalog latest-single --artist <name> [--artist-page <Apple Music artist URL> | --known-release <title> | --from <spotify-history.zip>] [--json].",
      );
    }
    const catalog = createAppleMusicCatalog();
    const identityResolver = createWikidataArtistResolver();
    try {
      await runCatalogCommand({
        args: options.rest,
        json: options.json,
        archivePath: options.from ?? undefined,
        deriveArchiveHints: deriveArtistReleaseHintsFromSpotifyArchive,
        catalog,
        identityResolver,
      });
    } finally {
      catalog.close?.();
    }
    return;
  }

  if (options.command === "data") {
    if (
      options.dryRun ||
      options.offline ||
      options.html ||
      options.card ||
      options.save ||
      options.from
    ) {
      throw new Error(
        "Usage: moondog data <inspect|export|reset> --scope <listening|apple|profile>.",
      );
    }
    await runDataCommand({
      args: options.rest,
      json: options.json,
      outputPath: options.output,
    });
    return;
  }

  if (options.command === "profile" && options.rest.length > 0) {
    if (
      options.dryRun ||
      options.offline ||
      options.html ||
      options.card ||
      options.save ||
      options.output ||
      options.from
    ) {
      throw new Error(
        "Usage: moondog profile <corrections|correct|retract>.",
      );
    }
    await runProfileCommand({
      args: options.rest,
      json: options.json,
      resolvePreferredSubjectId: optionalAppleMusicSubjectId,
    });
    return;
  }

  if (options.offline && options.command !== "demo") {
    throw new Error("The --offline option is only valid for moondog demo.");
  }

  if (options.html && options.command !== "taste") {
    throw new Error("The --html option is only valid for moondog taste.");
  }

  if (options.card && options.command !== "taste") {
    throw new Error("The --card option is only valid for moondog taste.");
  }

  if (options.html && options.card) {
    throw new Error("Choose either --html or --card for moondog taste, not both.");
  }

  if (options.save && options.command !== "taste") {
    throw new Error("The --save option is only valid for moondog taste.");
  }

  if (options.from && options.command !== "taste") {
    throw new Error("The --from option is only valid for moondog taste.");
  }

  if (options.save && !options.from) {
    throw new Error("The --save option requires --from <spotify-history.zip>.");
  }

  if (options.save && options.fromArchives.length > 1) {
    throw new Error(
      "The two-archive --from path is an in-memory preview. Persist each ZIP with moondog spotify import-history, then run moondog taste --html.",
    );
  }

  if (
    options.output &&
    !(options.command === "taste" && (options.html || options.card))
  ) {
    throw new Error("The --output option requires moondog taste --html or --card.");
  }

  if (options.command === "taste" && options.rest.length > 0) {
    throw new Error(
      "Usage: moondog taste [--from <spotify-history.zip> [--from <spotify-history.zip>] [--save]] [--json] [(--html|--card) [--output <file.html>]].",
    );
  }

  if (options.command === "auth") {
    await runAuthCommand({
      args: options.rest,
      json: options.json,
    });
    return;
  }

  if (options.command === "spotify") {
    await runSpotifySurface({
      args: options.rest,
      json: options.json,
      resolutionCache:
        options.rest[0] === "resolve"
          ? await spotifyResolutionCacheIfConfigured()
          : null,
    });
    return;
  }

  if (options.command === "listenbrainz") {
    if (
      options.dryRun ||
      options.offline ||
      options.html ||
      options.save ||
      options.output ||
      options.from
    ) {
      throw new Error(
        "Usage: moondog listenbrainz import-history <listen-history.json> [--json].",
      );
    }
    await runListenBrainzSurface({
      args: options.rest,
      json: options.json,
    });
    return;
  }

  if (options.command === "demo") {
    if (options.dryRun) {
      throw new Error("The --dry-run option is not valid for moondog demo.");
    }
    if (options.offline && options.rest.length > 0) {
      throw new Error("Usage: moondog demo --offline [--json].");
    }
    const prompt = options.rest.join(" ").trim() || undefined;
    const value = await runMoondogDemo({ prompt, offline: options.offline });
    process.stdout.write(
      `${options.json ? JSON.stringify(value, null, 2) : formatDemoResult(value)}\n`,
    );
    return;
  }

  if (options.command === "memory" && options.rest[0] === "reflect") {
    if (options.rest.length !== 1) {
      throw new Error("Usage: moondog memory reflect [--dry-run] [--json].");
    }
    const memoryStore = await openLocalMemoryStore();
    const application = new MoondogApplication({ memoryStore });
    try {
      const value = await runMemoryReflection({
        application,
        dryRun: options.dryRun,
      });
      process.stdout.write(
        `${options.json ? JSON.stringify(value, null, 2) : formatMemoryReflection(value)}\n`,
      );
    } finally {
      application.close();
    }
    return;
  }

  if (options.dryRun) {
    throw new Error("The --dry-run option is only valid for memory reflect.");
  }

  if (options.command === "taste" && options.from) {
    const generatedAt = new Date().toISOString();
    let listeningHistoryStore;
    let preview;
    try {
      if (options.save) {
        listeningHistoryStore = await openListeningHistoryStore();
        const appleSubjectId = await optionalAppleMusicSubjectId();
        const subjectId = listeningHistoryStore.localSubjectId({
          ...(appleSubjectId ? { preferredSubjectId: appleSubjectId } : {}),
          create: true,
        });
        preview = await persistTasteFromSpotifyArchive({
          archivePath: options.from,
          subjectId,
          store: listeningHistoryStore,
          capturedAt: generatedAt,
          maxItems: 10,
        });
      } else {
        preview = options.fromArchives.length === 1
          ? await projectTasteFromSpotifyArchive({
              archivePath: options.from,
              capturedAt: generatedAt,
              maxItems: 10,
            })
          : await projectTasteFromSpotifyArchives({
              archivePaths: options.fromArchives,
              capturedAt: generatedAt,
              maxItems: 10,
            });
      }
    } finally {
      listeningHistoryStore?.close?.();
    }
    const profile = {
      ...preview.profile,
      preview_source: preview.source,
    };
    if (options.html || options.card) {
      await emitTasteprintArtifact(profile, {
        output: options.output,
        json: options.json,
        generatedAt,
        source: preview.source,
        format: options.card ? "card" : "full",
      });
    } else {
      process.stdout.write(
        `${options.json ? JSON.stringify(profile, null, 2) : formatLocalResult("taste", profile)}\n`,
      );
    }
    return;
  }

  const domainState = await loadDomainServices();
  const memoryStore = await openLocalMemoryStore();
  const spotifyConnection = await loadSpotifyConnection();
  const musicCatalog = createAppleMusicCatalog();
  const artistIdentityResolver = createWikidataArtistResolver();
  const musicSimilarity = createOpenMusicSimilarity({
    identityResolver: artistIdentityResolver,
  });
  const webResearch = await createCodexWebResearch();
  const application = new MoondogApplication({
    ...domainState,
    webResearch,
    memoryStore,
    spotifyConnection,
    musicCatalog,
    musicSimilarity,
    artistIdentityResolver,
  });

  try {
    const runtime = await createConfiguredRuntime(application);
    const runtimeStatus = runtime.publicStatus();

    if (localCommands.has(options.command)) {
      if (options.command === "taste" && (options.html || options.card)) {
        const generatedAt = new Date().toISOString();
        const profile = await application.getProfileSummary({ maxItems: 10 });
        await emitTasteprintArtifact(profile, {
          output: options.output,
          json: options.json,
          generatedAt,
          format: options.card ? "card" : "full",
        });
        return;
      }
      const value = await application.runLocalCommand(
        options.command,
        runtimeStatus,
      );
      process.stdout.write(
        `${options.json ? JSON.stringify(value, null, 2) : formatLocalResult(options.command, value)}\n`,
      );
      return;
    }

    if (options.command === "remember") {
      const text = options.rest.join(" ").trim();
      if (!text) throw new Error("The remember command requires text.");
      const value = application.rememberMemory({ text, kind: "fact" });
      process.stdout.write(
        `${options.json ? JSON.stringify(value, null, 2) : `Remembered ${value.memory_id}: ${value.text}`}\n`,
      );
      return;
    }

    if (options.command === "forget") {
      const memoryId = options.rest[0]?.trim();
      if (!memoryId || options.rest.length !== 1) {
        throw new Error("Usage: moondog forget <memory-id>.");
      }
      const value = application.forgetMemory(memoryId);
      process.stdout.write(
        `${options.json ? JSON.stringify(value, null, 2) : value.forgotten ? `Forgot ${memoryId}.` : `No active memory found for ${memoryId}.`}\n`,
      );
      return;
    }

    if (options.command === "ask") {
      const prompt = options.rest.join(" ").trim();
      if (!prompt) throw new Error("The ask command requires a prompt.");
      if (runtimeStatus.state !== "configured") {
        if (runtimeStatus.reason === "provider_authentication_required") {
          throw new Error(
            "The openai-codex provider requires authentication. Run moondog auth login openai-codex first.",
          );
        }
        throw new Error(
          "The model runtime is offline. Set MOONDOG_PROVIDER and MOONDOG_MODEL first.",
        );
      }
      const result = await runtime.prompt(prompt);
      if (options.json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        process.stdout.write(`${sanitizeTerminalText(result.text)}\n`);
      }
      return;
    }

    if (options.command) {
      throw new Error(`Unknown command: ${options.command}`);
    }

    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error(
        "Interactive mode requires a TTY. Use moondog status --json for a non-interactive check.",
      );
    }
    await runMoondogTui({
      application,
      runtime,
      rebuildRuntime: async (selection) => {
        if (selection) await writePiRuntimeSelection(selection);
        return createConfiguredRuntime(application, process.env, { selection });
      },
      runAuth: () =>
        runAuthCommand({
          args: ["login", "openai-codex"],
        }),
      runWeb: (args, options) => runWebCommand({ args, webResearch, ...options }),
      runProfileAction: (args) => runProfileCommand({
        args,
        commandPrefix: "/profile",
        resolvePreferredSubjectId: optionalAppleMusicSubjectId,
        output: { write() {} },
      }),
      runProfile: async (args) => {
        const values = [...args];
        const json = values.at(-1) === "--json";
        if (json) values.pop();
        let output = "";
        await runProfileCommand({
          args: values,
          json,
          commandPrefix: "/profile",
          resolvePreferredSubjectId: optionalAppleMusicSubjectId,
          output: { write: (value) => { output += String(value); } },
        });
        return json ? `\`\`\`json\n${output.trim()}\n\`\`\`` : output.trim();
      },
      runSpotify: async (args) => {
        let output = "";
        const capture = {
          write(value) {
            output += String(value);
          },
        };
        await runSpotifySurface({
          args,
          stdout: capture,
          stderr: args[0] === "login" ? process.stderr : capture,
          resolutionCache: await spotifyResolutionCacheIfConfigured(),
        });
        if (["import-history", "sync-recent"].includes(args[0])) {
          const next = await loadDomainServices();
          const previous = application.domainServices;
          application.domainServices = next.domainServices;
          application.domainServicesError = next.domainServicesError;
          previous?.close?.();
        }
        application.setSpotifyConnection(await loadSpotifyConnection());
        return output.trim();
      },
    });
  } finally {
    application.close();
  }
}

main()
  .catch((error) => {
    process.stderr.write(`moondog: ${sanitizeTerminalText(error.message)}\n`);
    process.exitCode = 1;
  })
  .finally(() => closeSpotifyResolutionCache());
