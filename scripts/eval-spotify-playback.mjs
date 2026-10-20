#!/usr/bin/env node
// Playback evaluation: everyday Spotify requests, sent to a real model, against a simulated
// Spotify (src/evaluation/simulated-spotify.mjs). Nothing reaches a Spotify account. Only the
// model sign-in comes from your settings, and the script checks that it left them unchanged.
//
//   node scripts/eval-spotify-playback.mjs [--runs 5] [--only name,name] [--out folder]
//
// Each scenario passes when every turn leaves Spotify in the expected state, no tool call
// fails, and every reply is plain language in the listener's language.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { values: options } = parseArgs({ options: {
  runs: { type: "string", default: "5" }, only: { type: "string" }, out: { type: "string" }, parallel: { type: "string", default: "4" },
} });
process.env.MOONDOG_STATE_HOME = await mkdtemp(path.join(tmpdir(), "moondog-playback-eval-"));
process.env.MOONDOG_UPDATE_CHECK = "off";
process.env.MOONDOG_LYRICS = "off";
process.env.MOONDOG_PROVIDER ??= "anthropic";
process.env.MOONDOG_MODEL ??= "claude-sonnet-5-5";

const { MoondogApplication } = await import(`${root}/src/core/moondog-application.mjs`);
const { createSyntheticDomainServices } = await import(`${root}/src/core/synthetic-domain-services.mjs`);
const { createSpotifyWebApiClient } = await import(`${root}/src/integrations/spotify/web-api-client.mjs`);
const { createSpotifyService } = await import(`${root}/src/integrations/spotify/service.mjs`);
const { createConfiguredRuntime } = await import(`${root}/src/runtime/pi/configured-runtime.mjs`);
const { catalogNames, createSimulatedSpotify } = await import(`${root}/src/evaluation/simulated-spotify.mjs`);
const { messageLocale } = await import(`${root}/src/i18n/index.mjs`);

const artistOf = (track) => track?.artists.map((artist) => artist.name).join(", ") ?? "";
const isWuBai = (track) => /伍佰|Wu Bai/u.test(artistOf(track));
const check = (ok, failure) => (ok ? null : failure);

// Each turn's expect(state) returns a failure sentence or null.
const scenarios = [
  { name: "play-named", language: "zh", setup: {},
    turns: [{ text: "我要听伍佰的被动", expect: (s) => check(s.current?.id === "simBeidong" && s.playing && s.active === "simMac",
      `expected 被動 playing on the Mac, got ${s.current?.name ?? "nothing"} on ${s.active ?? "no device"}`) }] },
  { name: "version-followup", language: "zh", setup: {},
    turns: [
      { text: "我要听伍佰的被动", expect: (s) => check(s.current?.id === "simBeidong" && s.playing, `expected 被動, got ${s.current?.name ?? "nothing"}`) },
      { text: "我记得有一个和女歌手合唱的版本（我忘了名字了）", expect: (s) => check(s.current?.id === "simBeidongDuet" && s.playing,
        `expected the LaLa duet, got ${s.current?.name ?? "nothing"}`) },
    ] },
  { name: "move-refused-transfer", language: "zh", setup: { active: "simMac", playing: "simBeidongDuet", refuseTransfersTo: ["simPC"] },
    turns: [{ text: "能否切换到PC播放？PC现在连接的我的音响", expect: (s) => check(s.active === "simPC" && s.playing && s.current?.id === "simBeidongDuet",
      `expected the duet playing on the PC, got ${s.current?.name ?? "nothing"} on ${s.active}${s.playing ? "" : " (paused)"}`) }] },
  // Spotify refuses this device every way, so the one refusal is expected; the reply must say so plainly.
  { name: "move-refused-everywhere", language: "zh", setup: { active: "simMac", playing: "simBeidongDuet", refuseMovesTo: ["simPC"] },
    turns: [{ text: "能否切换到PC播放？PC现在连接的我的音响", allowedErrors: 1, expect: (s, reply) => check(s.active === "simMac" && s.playing && !/已(?:经)?(?:切换|切到|转到)/u.test(reply),
      `expected playback to stay on the Mac with an honest reply, got ${s.active}${s.playing ? "" : " (paused)"}`) }] },
  { name: "pause-resume-skip", language: "ja", setup: { active: "simMac", playing: "simWeirdFishes", queue: ["simNude", "simReckoner"] },
    turns: [
      { text: "一時停止して", expect: (s) => check(!s.playing, "expected paused") },
      { text: "再開して", expect: (s) => check(s.playing && s.current?.id === "simWeirdFishes", `expected Weird Fishes playing, got ${s.current?.name}${s.playing ? "" : " (paused)"}`) },
      { text: "もう一度再生して", expect: (s) => check(s.playing && s.current?.id === "simWeirdFishes", "expected it to keep playing") },
      { text: "次の曲", expect: (s) => check(s.playing && s.current?.id === "simNude", `expected Nude, got ${s.current?.name}`) },
    ] },
  { name: "queue-three", language: "en", setup: { active: "simMac", playing: "simBeidong" },
    turns: [{ text: "add three more Wu Bai songs to the queue", expect: (s) => {
      const ids = s.queue.map((track) => track.id);
      return check(s.current?.id === "simBeidong" && ids.length === 3 && new Set(ids).size === 3 && s.queue.every(isWuBai) && !ids.includes("simBeidong"),
        `expected three other Wu Bai songs queued after 被動, got [${s.queue.map((track) => track.name).join(", ")}] after ${s.current?.name}`);
    } }] },
  { name: "queue-from-idle", language: "es", setup: {},
    turns: [{ text: "pon tres canciones de Radiohead en la cola", expect: (s) => {
      const radiohead = [s.current, ...s.queue].filter((track) => artistOf(track) === "Radiohead");
      return check(s.playing && s.active === "simMac" && radiohead.length === 3 && new Set(radiohead.map((track) => track.id)).size === 3,
        `expected three Radiohead songs started on the Mac, got ${s.current?.name ?? "nothing"} + [${s.queue.map((track) => track.name).join(", ")}]`);
    } }] },
  { name: "earlier-result", language: "zh", setup: { active: "simMac", playing: "simReckoner" },
    turns: [
      { text: "帮我搜一下 Beyond 有哪些歌，先别放", expect: (s) => check(s.current?.id === "simReckoner", "expected nothing to change yet") },
      { text: "再搜一下陈奕迅的，也先别放", expect: (s) => check(s.current?.id === "simReckoner", "expected nothing to change yet") },
      { text: "好，放刚才 Beyond 的海阔天空", expect: (s) => check(s.current?.id === "simHaiKuoTianKong" && s.playing,
        `expected 海闊天空, got ${s.current?.name ?? "nothing"}`) },
    ] },
  // The same everyday requests in the other reply languages, with no language-specific parsing.
  { name: "play-french", language: "fr", setup: {},
    turns: [{ text: "mets Nude de Radiohead", expect: (s) => check(s.current?.id === "simNude" && s.playing && s.active === "simMac",
      `expected Nude playing on the Mac, got ${s.current?.name ?? "nothing"} on ${s.active ?? "no device"}`) }] },
  { name: "queue-german", language: "de", setup: { active: "simMac", playing: "simReckoner" },
    turns: [{ text: "füg drei Lieder von Beyond zur Warteschlange hinzu", expect: (s) => {
      const beyond = s.queue.filter((track) => artistOf(track) === "Beyond");
      return check(s.current?.id === "simReckoner" && beyond.length === 3 && new Set(beyond.map((track) => track.id)).size === 3,
        `expected three Beyond songs queued after Reckoner, got [${s.queue.map((track) => track.name).join(", ")}]`);
    } }] },
  { name: "move-italian", language: "it", setup: { active: "simMac", playing: "simNude", refuseTransfersTo: ["simPC"] },
    turns: [{ text: "sposta la musica sul PC", expect: (s) => check(s.active === "simPC" && s.playing && s.current?.id === "simNude",
      `expected Nude playing on the PC, got ${s.current?.name ?? "nothing"} on ${s.active}${s.playing ? "" : " (paused)"}`) }] },
  { name: "pause-korean", language: "ko", setup: { active: "simMac", playing: "simShiLuoShaZhou" },
    turns: [
      { text: "일시 정지해 줘", expect: (s) => check(!s.playing, "expected paused") },
      { text: "다시 틀어 줘", expect: (s) => check(s.playing && s.current?.id === "simShiLuoShaZhou", `expected 失落沙洲 playing, got ${s.current?.name}${s.playing ? "" : " (paused)"}`) },
    ] },
  { name: "play-traditional", language: "zh-Hant", setup: {},
    turns: [{ text: "播放陳奕迅的浮誇", expect: (s) => check(s.current?.id === "simFuKua" && s.playing, `expected 浮誇, got ${s.current?.name ?? "nothing"}`) }] },
];

const JARGON = /\bspotify_[a-z_]+\b|\bHTTP \d{3}\b|\b(?:item|track|device|playlist)_ref(?:_id)?\b|\bNO_ACTIVE_DEVICE\b|\bRestriction violated\b|\b(?:403|404|429)\b/iu;

async function settingsFingerprint() {
  const directory = path.join(homedir(), ".config", "moondog");
  // The model sign-in may refresh its own token, so auth.json is left out.
  const names = (await readdir(directory).catch(() => [])).filter((name) => name.endsWith(".json") && name !== "auth.json").sort();
  return JSON.stringify(await Promise.all(names.map(async (name) => [name, createHash("sha256").update(await readFile(path.join(directory, name))).digest("hex")])));
}

async function runScenario(scenario, run) {
  const spotify = createSimulatedSpotify({ devices: [{ id: "simMac", name: "Fictional MacBook Pro", type: "Computer" }, { id: "simPC", name: "PC", type: "Computer" }],
    ...scenario.setup });
  const client = createSpotifyWebApiClient({ tokenProvider: async () => "SIMULATED_TOKEN", fetchImpl: spotify.fetchImpl });
  const stateHome = await mkdtemp(path.join(process.env.MOONDOG_STATE_HOME, `${scenario.name}-${run}-`));
  const application = new MoondogApplication({ importsRoot: path.join(stateHome, "imports"),
    domainServices: createSyntheticDomainServices({ subjectScope: { subjectId: `playback-eval-${scenario.name}` } }),
    spotifyConnection: { ready: () => true, missingScopes: () => [], publicStatus: () => ({ provider: "spotify", state: "ready" }),
      service: createSpotifyService({ client, thisComputerName: "Fictional MacBook Pro" }) } });
  const runtime = await createConfiguredRuntime(application, { ...process.env, MOONDOG_STATE_HOME: stateHome });
  if (!runtime.agent) throw new Error(`No model runtime: ${JSON.stringify(runtime.publicStatus?.() ?? {})}`);
  const events = [];
  runtime.agent.subscribe((event) => {
    if (event.type === "tool_execution_start") events.push({ kind: "call", tool: event.toolName, args: event.args });
    if (event.type === "tool_execution_end") events.push({ kind: "result", tool: event.toolName, error: event.isError === true,
      text: event.result?.content?.map((part) => part.text ?? "").join("").slice(0, 1200) });
  });
  const turns = [];
  for (const turn of scenario.turns) {
    const started = Date.now();
    const writesBefore = spotify.state.writes.length;
    let reply = "";
    let failure = null;
    try {
      const result = await runtime.prompt(turn.text);
      reply = result.text ?? "";
    } catch (error) {
      failure = `the turn threw: ${error.message}`;
    }
    const toolEvents = events.splice(0);
    const toolErrors = toolEvents.filter((event) => event.kind === "result" && event.error).slice(turn.allowedErrors ?? 0);
    // Song, album and artist names travel across languages; read the reply around them.
    const replyLocale = messageLocale(catalogNames().reduce((prose, name) => prose.replaceAll(name, " "), reply), scenario.language);
    const problems = [
      failure,
      turn.expect(spotify.state, reply),
      toolErrors.length ? `${toolErrors.length} tool error(s): ${toolErrors.map((event) => `${event.tool}: ${event.text.slice(0, 160)}`).join(" | ")}` : null,
      JARGON.test(reply) ? `the reply shows internal detail: ${reply.match(JARGON)[0]}` : null,
      reply.trim() && !(replyLocale === scenario.language || (scenario.language === "zh" && replyLocale === "zh-Hant")) ? `the reply is in ${replyLocale}, not ${scenario.language}` : null,
      !reply.trim() ? "no reply" : null,
    ].filter(Boolean);
    turns.push({ text: turn.text, seconds: (Date.now() - started) / 1000, reply, problems, tools: toolEvents,
      writes: spotify.state.writes.slice(writesBefore).map((write) => `${write.method} ${write.path}${write.query.device_id ? `?device_id=${write.query.device_id}` : ""}${write.body?.uris ? ` ${write.body.uris.join(",")}` : ""}${write.body?.device_ids ? ` -> ${write.body.device_ids.join(",")}` : ""} ${write.status}`) });
  }
  application.close?.();
  return { scenario: scenario.name, run, passed: turns.every((turn) => turn.problems.length === 0), turns,
    toolErrors: turns.reduce((sum, turn, index) => sum + Math.max(0, turn.tools.filter((event) => event.kind === "result" && event.error).length - (scenario.turns[index].allowedErrors ?? 0)), 0) };
}

const selected = scenarios.filter((scenario) => !options.only || options.only.split(",").includes(scenario.name));
const runs = Number(options.runs);
const before = await settingsFingerprint();
const jobs = selected.flatMap((scenario) => Array.from({ length: runs }, (_, run) => () => runScenario(scenario, run + 1)));
const results = [];
let next = 0;
await Promise.all(Array.from({ length: Math.min(Number(options.parallel), jobs.length) }, async () => {
  while (next < jobs.length) {
    const job = jobs[next++];
    const result = await job().catch((error) => ({ scenario: "?", run: 0, passed: false, turns: [], toolErrors: 0, error: error.stack }));
    results.push(result);
    process.stdout.write(`${result.passed ? "pass" : "FAIL"} ${result.scenario} #${result.run}${result.passed ? "" : `: ${result.error ?? result.turns.flatMap((turn) => turn.problems).join("; ")}`}\n`);
  }
}));
const after = await settingsFingerprint();

const lines = [`# Playback eval: ${process.env.MOONDOG_PROVIDER}/${process.env.MOONDOG_MODEL}, ${runs} runs`, ""];
lines.push("| Scenario | Passed | Tool errors | Median turn |", "| --- | --- | --- | --- |");
for (const scenario of selected) {
  const mine = results.filter((result) => result.scenario === scenario.name);
  const seconds = mine.flatMap((result) => result.turns.map((turn) => turn.seconds)).sort((a, b) => a - b);
  lines.push(`| ${scenario.name} | ${mine.filter((result) => result.passed).length}/${mine.length} | ${mine.reduce((sum, result) => sum + result.toolErrors, 0)} | ${seconds.length ? `${seconds[Math.floor(seconds.length / 2)].toFixed(1)} s` : "-"} |`);
}
const passed = results.filter((result) => result.passed).length;
lines.push("", `Total: ${passed}/${results.length} passed. Settings unchanged: ${before === after}.`, "");
for (const result of results.sort((a, b) => a.scenario.localeCompare(b.scenario) || a.run - b.run)) {
  lines.push(`## ${result.scenario} #${result.run}: ${result.passed ? "pass" : "FAIL"}`, "");
  if (result.error) lines.push("```", result.error, "```", "");
  for (const turn of result.turns) {
    lines.push(`**You:** ${turn.text} (${turn.seconds.toFixed(1)} s)`, "");
    for (const event of turn.tools) lines.push(event.kind === "call" ? `- call ${event.tool} ${JSON.stringify(event.args).slice(0, 300)}` : `  - ${event.error ? "ERROR " : ""}${event.text.slice(0, 300).replace(/\n/gu, " ")}`);
    lines.push("", `Spotify writes: ${turn.writes.join("; ") || "none"}`, "", `**Moondog:** ${turn.reply.replace(/\n/gu, "\n> ")}`, "");
    if (turn.problems.length) lines.push(`Problems: ${turn.problems.join("; ")}`, "");
  }
}
const out = options.out ?? path.join(process.env.MOONDOG_STATE_HOME, "report");
await mkdir(out, { recursive: true });
const report = path.join(out, `playback-eval-${new Date().toISOString().replace(/[:.]/gu, "-")}.md`);
await writeFile(report, lines.join("\n"));
console.log(`\n${lines.slice(2, 3 + selected.length + 2).join("\n")}\nReport: ${report}`);
process.exit(passed === results.length && before === after ? 0 : 1);
