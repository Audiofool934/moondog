#!/usr/bin/env node
// Score evaluation: requests to make music, sent to a real model on a machine where Stable Audio 3
// cannot run, so Moondog writes each track as a score (src/integrations/score). The listener is the
// synthetic one and the player only records what it was asked to play; nothing else leaves this
// machine but the model requests, which use the model sign-in from your settings.
//
//   node scripts/eval-score-track.mjs [--runs 1] [--only name,name] [--out folder]
//
// A scenario passes when one track plays, its file is a WAV as long as the score says, no tool call
// fails, and the reply is in the listener's language. With --out, every track and its sheet are kept
// there to listen to; a pass says the path works, not that the music is good.
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { values: options } = parseArgs({ options: { runs: { type: "string", default: "1" }, only: { type: "string" }, out: { type: "string" } } });
process.env.MOONDOG_STATE_HOME = await mkdtemp(path.join(tmpdir(), "moondog-score-eval-"));
process.env.MOONDOG_UPDATE_CHECK = "off";
process.env.MOONDOG_LYRICS = "off";

const { MoondogApplication } = await import(`${root}/src/core/moondog-application.mjs`);
const { createSyntheticDomainServices } = await import(`${root}/src/core/synthetic-domain-services.mjs`);
const { createLocalGenerator } = await import(`${root}/src/integrations/stable-audio/local-generator.mjs`);
const { createConfiguredRuntime } = await import(`${root}/src/runtime/pi/configured-runtime.mjs`);
const { replyInOtherLanguage } = await import(`${root}/src/runtime/pi/reply-language.mjs`);

const scenarios = [
  { name: "late-night", language: "en", text: "Make me something calm for late-night coding." },
  { name: "rainy-day", language: "zh", text: "给我写一首适合下雨天听的曲子，慢一点。" },
  { name: "short-waltz", language: "en", text: "Write me a short, bright little waltz, about half a minute." },
  { name: "morning", language: "es", text: "Compón algo alegre para empezar la mañana." },
];

async function wavSeconds(file) {
  const bytes = await readFile(file);
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") return null;
  return (bytes.length - 44) / (bytes.readUInt32LE(24) * bytes.readUInt16LE(22) * 2);
}

// The model that answered, as the runtime names it.
let modelName = null;

async function runScenario(scenario, run) {
  const stateHome = await mkdtemp(path.join(process.env.MOONDOG_STATE_HOME, `${scenario.name}-${run}-`));
  const environment = { ...process.env, MOONDOG_STATE_HOME: stateHome };
  // A Windows machine as the generator sees it: Stable Audio 3's MLX build cannot run, so the score is the way.
  const localGenerator = createLocalGenerator({ environment, platform: "win32", arch: "x64" });
  await localGenerator.check();
  const played = [];
  const musicPreviewPlayer = { playGenerated: (track) => { played.push(track); }, subscribe: () => () => {}, stop: () => {} };
  const application = new MoondogApplication({ importsRoot: path.join(stateHome, "imports"), locale: scenario.language,
    domainServices: createSyntheticDomainServices({ subjectScope: { subjectId: `score-eval-${scenario.name}` } }), musicPreviewPlayer, localGenerator });
  const runtime = await createConfiguredRuntime(application, environment);
  if (!runtime.agent) throw new Error(`No model runtime: ${JSON.stringify(runtime.publicStatus?.() ?? {})}`);
  const status = runtime.publicStatus?.() ?? {};
  modelName ??= [status.provider, status.model].filter(Boolean).join("/") || "the saved model";
  const events = [];
  const started = Date.now();
  const at = () => Math.round((Date.now() - started) / 100) / 10;
  runtime.agent.subscribe((event) => {
    if (event.type === "tool_execution_start") events.push({ kind: "call", at: at(), tool: event.toolName, args: event.args });
    if (event.type === "tool_execution_end") events.push({ kind: "result", at: at(), tool: event.toolName, error: event.isError === true,
      text: event.result?.content?.map((part) => part.text ?? "").join("").slice(0, 2_000) });
  });
  let reply = "";
  let failure = null;
  try {
    reply = (await runtime.prompt(scenario.text)).text ?? "";
  } catch (error) {
    failure = `the turn threw: ${error.message}`;
  }
  const seconds = (Date.now() - started) / 1000;
  const writes = events.filter((event) => event.kind === "call" && event.tool === "moondog_write_track");
  const results = events.filter((event) => event.kind === "result" && event.tool === "moondog_write_track");
  const toolErrors = events.filter((event) => event.kind === "result" && event.error);
  const track = played[0] ?? null;
  const length = track?.file ? await wavSeconds(track.file).catch(() => null) : null;
  const receipt = track ? await localGenerator.receipt(track.id) : null;
  const problems = [
    failure,
    played.length === 1 ? null : `expected one track to play, got ${played.length}`,
    track && !(length >= 15) ? `the track's file is not a WAV of 15 seconds or more (${length})` : null,
    track && receipt?.generator?.adapter !== "dawn-score" ? "the receipt does not say the track was written as a score" : null,
    toolErrors.length ? `${toolErrors.length} tool error(s): ${toolErrors.map((event) => `${event.tool}: ${event.text.slice(0, 200)}`).join(" | ")}` : null,
    !reply.trim() ? "no reply" : null,
    reply.trim() && replyInOtherLanguage(reply, scenario.language) ? `the reply is not in ${scenario.language}` : null,
    /\bmoondog_[a-z_]+\b|score_notes|pitch:beats/u.test(reply) ? "the reply shows internal detail" : null,
  ].filter(Boolean);
  let kept = null;
  if (options.out && track?.file) {
    await mkdir(options.out, { recursive: true });
    kept = path.join(options.out, `${scenario.name}-${run}.wav`);
    await copyFile(track.file, kept);
    await writeFile(path.join(options.out, `${scenario.name}-${run}.sheet.json`), `${JSON.stringify({ title: receipt?.title, sheet: receipt?.generator?.sheet }, null, 2)}\n`);
  }
  application.close?.();
  return { scenario: scenario.name, run, passed: problems.length === 0, problems, seconds, reply, attempts: writes.length,
    sentBack: results.filter((event) => /"state":\s*"not_made"/u.test(event.text)).map((event) => event.text.slice(0, 600)),
    title: receipt?.title ?? null, length, score: receipt?.generator?.score ?? null, kept, events };
}

const selected = scenarios.filter((scenario) => !options.only || options.only.split(",").includes(scenario.name));
const runs = Number(options.runs);
const results = [];
for (const scenario of selected) {
  for (let run = 1; run <= runs; run += 1) {
    const result = await runScenario(scenario, run).catch((error) => ({ scenario: scenario.name, run, passed: false, problems: [error.message], seconds: 0, reply: "", attempts: 0, sentBack: [], events: [] }));
    results.push(result);
    process.stdout.write(`${result.passed ? "pass" : "FAIL"} ${result.scenario} #${result.run} · ${result.attempts} write call(s) · ${result.seconds.toFixed(1)} s` +
      `${result.title ? ` · "${result.title}" ${Math.round(result.length ?? 0)} s` : ""}${result.passed ? "" : ` · ${result.problems.join("; ")}`}\n`);
  }
}

const lines = [`# Score eval: ${modelName ?? "no model"}, ${runs} run(s)`, ""];
const passed = results.filter((result) => result.passed).length;
lines.push(`Total: ${passed}/${results.length} passed. Scores sent back to fix: ${results.reduce((sum, result) => sum + result.sentBack.length, 0)}.`, "");
for (const result of results) {
  lines.push(`## ${result.scenario} #${result.run}: ${result.passed ? "pass" : "FAIL"}`, "");
  if (result.score) lines.push(`"${result.title}": ${result.score.key}, ${result.score.tempo} BPM, ${result.score.bars} bars, ${Math.round(result.length)} s. ${result.score.form}. ${(result.score.parts ?? []).map((part) => part.sound).join(", ")}.`, "");
  for (const text of result.sentBack) lines.push(`Sent back: ${text}`, "");
  for (const event of result.events) lines.push(event.kind === "call" ? `- ${event.at} s: call ${event.tool} ${JSON.stringify(event.args).slice(0, 1_600)}` : `  - ${event.at} s: ${event.error ? "ERROR " : ""}${event.text.slice(0, 500).replace(/\n/gu, " ")}`);
  lines.push("", `**Moondog:** ${result.reply.replace(/\n/gu, "\n> ")}`, "");
  if (result.problems.length) lines.push(`Problems: ${result.problems.join("; ")}`, "");
}
const out = options.out ?? path.join(process.env.MOONDOG_STATE_HOME, "report");
await mkdir(out, { recursive: true });
const report = path.join(out, `score-eval-${new Date().toISOString().replace(/[:.]/gu, "-")}.md`);
await writeFile(report, lines.join("\n"));
if (options.out) await rm(process.env.MOONDOG_STATE_HOME, { recursive: true, force: true });
console.log(`\n${lines[2]}\nReport: ${report}`);
process.exit(passed === results.length ? 0 : 1);
