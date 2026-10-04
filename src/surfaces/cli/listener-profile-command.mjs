import { sanitizeTerminalText } from "./format-output.mjs";

export const savedProfileActions = new Set(["build", "saved", "explain"]);

function formatSaved(value, prefix) {
  if (value.state === "missing") return `No saved reading yet. Use ${prefix} build with a connected model.`;
  const lines = [
    `# Your saved listening profile · v${value.sequence}`,
    value.state === "stale" ? `Your music or choices changed. Use ${prefix} build to update this reading.`
      : `Built ${value.built_at.slice(0, 10)} · ${value.coverage.reviewed_partitions}/${value.coverage.digest_partitions} evidence pages reviewed`,
    "", value.summary, "",
  ];
  for (const [index, claim] of value.claims.entries()) {
    lines.push(`${value.offset + index + 1}. [${claim.kind.replaceAll("_", " ")}] ${claim.statement}`,
      `   ${claim.scope} · ${claim.uncertainty}`);
  }
  lines.push("", `Use ${prefix} explain <number> for a finding's evidence.`);
  if (value.next_offset !== null) lines.push(`More findings: ${prefix} saved ${value.next_offset}`);
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
    rendered = formatSaved(result, commandPrefix);
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
