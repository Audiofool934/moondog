import { sanitizeTerminalText } from "./format-output.mjs";
import { N_, screenTranslator } from "../../i18n/index.mjs";

export const savedProfileActions = new Set(["build", "saved", "explain"]);

const kindLabels = { observation: N_("measured"), hypothesis: N_("interpretation"), listener_assertion: N_("your choice") };

function builtLine(value, tr) {
  const coverage = value.coverage?.coverage ?? {};
  const concerns = value.verification?.state === "flagged" ? value.verification.checks.at(-1).issues.length : 0;
  const check = value.verification?.state === "revised" ? tr("checked and revised once")
    : concerns ? tr.n(concerns, "checked; one concern remains", "checked; {count} concerns remain") : tr("checked");
  const built = [
    tr("Built {date}", { date: value.built_at.slice(0, 10) }),
    ...(Number.isInteger(coverage.effective_listening_events) ? [tr.n(coverage.effective_listening_events, "from {count} play", "from {count} plays")] : []),
  ].join(" ");
  const span = coverage.earliest_played_at && coverage.latest_played_at
    ? `, ${tr("{first} to {last}", { first: coverage.earliest_played_at.slice(0, 10), last: coverage.latest_played_at.slice(0, 10) })}` : "";
  return `${built}${span} · ${check}`;
}

function formatSaved(value, prefix, allFindings = false, tr) {
  if (value.state === "missing") return tr("No saved reading yet. Use {prefix} build with a connected model.", { prefix });
  const lines = [
    `# ${tr("Your saved listening profile · v{version}", { version: value.sequence })}`,
    value.state === "stale" ? tr("Evidence, choices or analysis changed. Use {prefix} build to update this reading.", { prefix }) : builtLine(value, tr),
    "", value.summary, "",
  ];
  // The TUI renders this text as Markdown, which renumbers an ordered list from its
  // first item. Ascending finding numbers keep the shown numbers valid for explain.
  const displayed = allFindings ? value.claims : [...new Map([
    ...(value.highlights ?? []), ...(value.listener_assertions ?? []),
  ].map(claim => [claim.claim_id, claim])).values()].sort((a, b) => a.finding_number - b.finding_number);
  for (const [index, claim] of displayed.entries()) {
    lines.push(`${claim.finding_number ?? value.offset + index + 1}. ${claim.statement}`,
      `   ${kindLabels[claim.kind] ? tr.marked(kindLabels[claim.kind]) : claim.kind.replaceAll("_", " ")} · ${claim.scope} · ${claim.uncertainty}`);
  }
  if (value.state === "current" && value.verification?.state === "flagged") {
    lines.push("", tr("The final check still flagged:"), ...value.verification.checks.at(-1).issues.map(issue => `- ${issue.problem}`));
  }
  lines.push("", tr("Use {prefix} explain <number> for a finding's evidence.", { prefix }));
  if (!allFindings && value.total_claims > displayed.length) lines.push(tr("All {count} findings: {prefix} saved 0", { count: value.total_claims, prefix }));
  else if (allFindings && value.next_offset !== null) lines.push(tr("More findings: {prefix} saved {offset}", { prefix, offset: value.next_offset }));
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
  signal, onProgress, runtimeFactory, tr = screenTranslator("en"),
} = {}) {
  const [action, ...values] = args ?? [];
  let result;
  let rendered;
  if (action === "build") {
    if (values.length > 1 || (values.length === 1 && values[0] !== "--force")) {
      throw new Error(tr("Usage: {prefix} build [--force].", { prefix: commandPrefix }));
    }
    result = await application.buildListenerProfile({ force: values[0] === "--force", signal, onProgress, runtimeFactory });
    rendered = result.state === "no_evidence" ? tr("Import your music first with /import.")
      : `${result.state === "unchanged" ? tr("Your saved reading already matches the current evidence.") : tr("Saved your new listening profile.")}\n\n${formatSaved(result.revision, commandPrefix, false, tr)}`;
  } else if (action === "saved") {
    if (values.length > 1 || (values.length === 1 && !/^\d+$/u.test(values[0]))) {
      throw new Error(tr("Usage: {prefix} saved [offset].", { prefix: commandPrefix }));
    }
    result = await application.getListenerProfile({ offset: Number(values[0] ?? 0) });
    rendered = formatSaved(result, commandPrefix, values.length > 0, tr);
  } else if (action === "explain") {
    if (values.length !== 1 || !/^[1-9]\d*$/u.test(values[0]) || !Number.isSafeInteger(Number(values[0]))) {
      throw new Error(tr("Usage: {prefix} explain <finding-number>.", { prefix: commandPrefix }));
    }
    const page = await application.getListenerProfile({ offset: Number(values[0]) - 1, limit: 1 });
    if (!page.claims.length) throw new Error(tr("That finding is not in your saved profile. Open /profile saved first."));
    result = await application.getListenerProfile({ claimId: page.claims[0].claim_id, revisionId: page.revision_id });
    rendered = [
      `# ${result.state === "stale" ? tr("Finding {number} · profile v{version} · needs update", { number: values[0], version: result.sequence })
        : tr("Finding {number} · profile v{version}", { number: values[0], version: result.sequence })}`,
      result.claim.statement, "", tr("Scope: {scope}", { scope: result.claim.scope }), tr("Uncertainty: {uncertainty}", { uncertainty: result.claim.uncertainty }),
      "", tr("Supporting evidence:"), ...result.supporting_evidence.map(formatEvidence),
      ...(result.contradicting_evidence.length ? ["", tr("Conflicting evidence:"), ...result.contradicting_evidence.map(formatEvidence)] : []),
    ].join("\n");
  } else throw new Error("Unknown saved profile command");
  output.write(`${sanitizeTerminalText(json ? JSON.stringify(result, null, 2) : rendered)}\n`);
  return result;
}
