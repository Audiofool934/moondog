import { sanitizeTerminalText } from "./format-output.mjs";

export const savedProfileActions = new Set(["build", "saved", "explain"]);

const kindLabels = { observation: "measured", hypothesis: "interpretation", listener_assertion: "your choice" };

function builtLine(value) {
  const coverage = value.coverage?.coverage ?? {};
  const plays = Number.isInteger(coverage.effective_listening_events)
    ? ` from ${coverage.effective_listening_events.toLocaleString("en-US")} plays` : "";
  const span = coverage.earliest_played_at && coverage.latest_played_at
    ? `, ${coverage.earliest_played_at.slice(0, 10)} to ${coverage.latest_played_at.slice(0, 10)}` : "";
  const concerns = value.verification?.state === "flagged" ? value.verification.checks.at(-1).issues.length : 0;
  const check = value.verification?.state === "revised" ? "checked and revised once"
    : concerns ? `checked; ${concerns === 1 ? "one concern remains" : `${concerns} concerns remain`}` : "checked";
  return `Built ${value.built_at.slice(0, 10)}${plays}${span} · ${check}`;
}

function formatSaved(value, prefix, allFindings = false) {
  if (value.state === "missing") return `No saved reading yet. Use ${prefix} build with a connected model.`;
  const lines = [
    `# Your saved listening profile · v${value.sequence}`,
    value.state === "stale" ? `Evidence, choices or analysis changed. Use ${prefix} build to update this reading.` : builtLine(value),
    "", value.summary, "",
  ];
  // The TUI renders this text as Markdown, which renumbers an ordered list from its
  // first item. Ascending finding numbers keep the shown numbers valid for explain.
  const displayed = allFindings ? value.claims : [...new Map([
    ...(value.highlights ?? []), ...(value.listener_assertions ?? []),
  ].map(claim => [claim.claim_id, claim])).values()].sort((a, b) => a.finding_number - b.finding_number);
  for (const [index, claim] of displayed.entries()) {
    lines.push(`${claim.finding_number ?? value.offset + index + 1}. ${claim.statement}`,
      `   ${kindLabels[claim.kind] ?? claim.kind.replaceAll("_", " ")} · ${claim.scope} · ${claim.uncertainty}`);
  }
  if (value.state === "current" && value.verification?.state === "flagged") {
    lines.push("", "The final check still flagged:", ...value.verification.checks.at(-1).issues.map(issue => `- ${issue.problem}`));
  }
  lines.push("", `Use ${prefix} explain <number> for a finding's evidence.`);
  if (!allFindings && value.total_claims > displayed.length) lines.push(`All ${value.total_claims} findings: ${prefix} saved 0`);
  else if (allFindings && value.next_offset !== null) lines.push(`More findings: ${prefix} saved ${value.next_offset}`);
  return lines.join("\n");
}

function formatEvidence(entry) {
  const { data } = entry;
  const label = data.label ?? data.name ?? data.title ?? data.year ?? data.evidence_kind ?? entry.section;
  const fields = Object.entries(data).filter(([key]) => !["label", "name", "title"].includes(key))
    .map(([key, value]) => `${key.replaceAll("_", " ")}: ${typeof value === "object" ? JSON.stringify(value) : value}`);
  return `- ${label} (${entry.section.replaceAll("_", " ")})\n  ${fields.join(" · ")}`;
}

export async function runListenerProfileCommand({
  application, args, json = false, output = process.stdout, commandPrefix = "moondog profile",
  signal, onProgress, runtimeFactory,
} = {}) {
  const [action, ...values] = args ?? [];
  let result;
  let rendered;
  if (action === "build") {
    if (values.length > 1 || (values.length === 1 && values[0] !== "--force")) {
      throw new Error(`Usage: ${commandPrefix} build [--force].`);
    }
    result = await application.buildListenerProfile({ force: values[0] === "--force", signal, onProgress, runtimeFactory });
    rendered = result.state === "no_evidence" ? "Import your music first with /import."
      : `${result.state === "unchanged" ? "Your saved reading already matches the current evidence." : "Saved your new listening profile."}\n\n${formatSaved(result.revision, commandPrefix)}`;
  } else if (action === "saved") {
    if (values.length > 1 || (values.length === 1 && !/^\d+$/u.test(values[0]))) {
      throw new Error(`Usage: ${commandPrefix} saved [offset].`);
    }
    result = await application.getListenerProfile({ offset: Number(values[0] ?? 0) });
    rendered = formatSaved(result, commandPrefix, values.length > 0);
  } else if (action === "explain") {
    if (values.length !== 1 || !/^[1-9]\d*$/u.test(values[0]) || !Number.isSafeInteger(Number(values[0]))) {
      throw new Error(`Usage: ${commandPrefix} explain <finding-number>.`);
    }
    const page = await application.getListenerProfile({ offset: Number(values[0]) - 1, limit: 1 });
    if (!page.claims.length) throw new Error("That finding is not in your saved profile. Open /profile saved first.");
    result = await application.getListenerProfile({ claimId: page.claims[0].claim_id, revisionId: page.revision_id });
    rendered = [
      `# Finding ${values[0]} · profile v${result.sequence}${result.state === "stale" ? " · needs update" : ""}`,
      result.claim.statement, "", `Scope: ${result.claim.scope}`, `Uncertainty: ${result.claim.uncertainty}`,
      "", "Supporting evidence:", ...result.supporting_evidence.map(formatEvidence),
      ...(result.contradicting_evidence.length ? ["", "Conflicting evidence:", ...result.contradicting_evidence.map(formatEvidence)] : []),
    ].join("\n");
  } else throw new Error("Unknown saved profile command");
  output.write(`${sanitizeTerminalText(json ? JSON.stringify(result, null, 2) : rendered)}\n`);
  return result;
}
