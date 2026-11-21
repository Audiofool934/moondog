// A track written as a score. Moondog's agent writes a compact lead sheet (tempo, key, parts, and
// sections with one chord a bar, drum grids and written lines); this module turns it into notes with
// the DAWN SDK (vendor/dawn-sdk.mjs), checks them with the SDK's lint and hands back a score the
// renderer plays. Nothing here needs a model, a GPU or a download, so it works on every machine.
import {
  ambientVoicing, chord, hit, lintSong, note, progression, scoreFromJSON, song, SONG_CALIBRATION_LATEST, track,
} from "./vendor/dawn-sdk.mjs";
import { SCORE_DRUM_VOICES, SCORE_LIMITS, SCORE_ROLES, SCORE_SOUNDS, SCORE_STYLES } from "./sheet.mjs";

export { SCORE_DRUM_VOICES, SCORE_LIMITS, SCORE_ROLES, SCORE_SOUNDS, SCORE_STYLES };

const WARMTH = 0.6;
const VOICINGS = Object.freeze({
  rhodes: "tine-piano", wurlitzer: "reed-piano", "felt-piano": "felt-piano", pad: "drift-pad", harp: "harp", dulcimer: "dulcimer",
  vibes: "soft-vibes", marimba: "marimba", kalimba: "thumb-piano", "glass-bell": "glass-bell", flute: "bamboo-flute",
  cello: "cello", viola: "viola", voice: "alto-vowel", "upright-bass": "upright-bass",
});
const KITS = Object.freeze({ lofi: "lofi", acoustic: "acoustic", 808: "syn808", 909: "syn909", electro: "electro", trap: "trap" });

// How a sound is played: the SDK's own voicings, and two plain synth basses.
function instrumentOf(sound) {
  if (sound === "round-bass") return { instrument: "triangle", synth: { attack: 0.02, decay: 1.2, sustain: 0.7, release: 0.35 }, filter: { cutoff: 240, ftype: "24db" } };
  if (sound === "sub-bass") return { instrument: "sine", synth: { attack: 0.02, decay: 1.2, sustain: 0.8, release: 0.3 } };
  if (KITS[sound]) return { instrument: "kit", kit: KITS[sound] };
  const voiced = ambientVoicing(VOICINGS[sound], WARMTH);
  // The slow tremolo and slight drift of an electric piano through an old amplifier.
  return sound === "rhodes" ? { ...voiced, keys: { ...voiced.keys, vib: 0.45, vibmod: 0.035, vibe: 0.24, vibehz: 2.1 } } : voiced;
}

const MIX = Object.freeze({
  chords: { volume: 0.72, reverb: { mix: 0.26, size: 0.7, fade: 2.2, lowpass: 5200, dim: 2400, predelay: 0.02 } },
  bass: { volume: 0.6 },
  drums: { volume: 0.55, reverb: { mix: 0.08, size: 0.4, fade: 0.8 } },
  line: { volume: 0.5, reverb: { mix: 0.3, size: 0.75, fade: 2.6, lowpass: 6000 } },
});
const MASTER = Object.freeze({ tape: { drive: 3, mix: 0.6 }, limiter: { ceiling: -1.5 }, target: -16 });

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => (typeof value === "string" ? value.trim() : "");
const round = (value) => Math.round(value * 1000) / 1000;

function chordsOf(value) {
  const symbols = Array.isArray(value) ? value.map(text) : text(value).split(/[\s|,]+/u);
  return symbols.filter(Boolean);
}

// "Ab4:1 F5:1.5 -:0.5": one pitch and its length in beats after another; "-" is a rest.
function parseLine(source, where, problems) {
  const notes = [];
  let at = 0;
  for (const token of text(source).split(/[\s,|]+/u).filter(Boolean)) {
    const match = /^(-|r|[A-Ga-g][#b]?-?\d):(\d+(?:\.\d+)?|\d+\/\d+)$/u.exec(token);
    if (!match) {
      problems.push({ where, problem: `"${token.slice(0, 16)}" is not pitch:beats. Write notes like Ab4:1 or F#3:0.5, and rests like -:2.` });
      return null;
    }
    const [whole, over] = match[2].split("/");
    const beats = over ? Number(whole) / Number(over) : Number(whole);
    if (!(beats > 0) || beats > 64) {
      problems.push({ where, problem: `"${token}" needs a length in beats above 0.` });
      return null;
    }
    if (match[1] !== "-" && match[1] !== "r") notes.push({ pitch: match[1][0].toUpperCase() + match[1].slice(1), at, beats });
    at += beats;
  }
  return { notes, beats: at };
}

// "x...x...x...x...": sixteenth steps, x a hit, X an accent, o a soft one, . a rest.
function parseGrid(source, stepsPerBar, where, problems) {
  const steps = text(source).replace(/[\s|]/gu, "");
  if (!steps || /[^xXo.\-]/u.test(steps)) {
    problems.push({ where, problem: "A drum grid uses only x (hit), X (accent), o (soft) and . (rest)." });
    return null;
  }
  if (steps.length % stepsPerBar !== 0 || steps.length / stepsPerBar > SCORE_LIMITS.drumBars) {
    problems.push({ where, problem: `A drum grid has ${stepsPerBar} steps a bar (sixteenths), for 1 to ${SCORE_LIMITS.drumBars} bars; this one has ${steps.length} steps.` });
    return null;
  }
  return steps;
}

const VELOCITY = Object.freeze({ x: 0.6, X: 0.85, o: 0.3 });

function bassNotes(style, rootPitch, at, beatsPerBar, plainFifth) {
  const fifth = plainFifth ? rootPitch + 7 : rootPitch;
  if (style === "pulse") return Array.from({ length: beatsPerBar }, (_, beat) => note(rootPitch, at + beat, 0.9, beat === 0 ? 0.62 : 0.5));
  if (style === "root-fifth") {
    const half = beatsPerBar === 4 ? 2 : beatsPerBar - 1;
    return [note(rootPitch, at, half - 0.1, 0.62), note(fifth, at + half, beatsPerBar - half - 0.1, 0.52)];
  }
  if (style === "push") {
    return beatsPerBar === 4
      ? [note(rootPitch, at, 2.3, 0.62), note(rootPitch, at + 2.5, 1.2, 0.5)]
      : [note(rootPitch, at, beatsPerBar - 1.1, 0.62), note(rootPitch, at + beatsPerBar - 1, 0.9, 0.5)];
  }
  return [note(rootPitch, at, beatsPerBar - 0.1, 0.62)];
}

// The chords of one part across the whole track. Voice-led chords move least, but a seventh or a ninth
// can then land a semitone under the root low in the keyboard, which sounds muddy; the lint names that
// (harmony.low-second), so the voicing with the fewest such clashes is kept.
function chordNotes(style, bars, beatsPerBar, options) {
  const base = { vel: 0.5, anchor: "C3", ...options };
  const notes = [];
  for (const run of bars) {
    if (style === "pulse") {
      const symbols = run.symbols.flatMap((symbol) => Array.from({ length: beatsPerBar }, () => symbol));
      notes.push(...progression(symbols, { ...base, from: run.at, each: 1 }));
    } else if (style === "arp") {
      notes.push(...progression(run.symbols, { ...base, from: run.at, each: beatsPerBar, perform: "arp-up", rate: 0.5 }));
    } else {
      notes.push(...progression(run.symbols, { ...base, from: run.at, each: beatsPerBar, strum: style === "rolled" ? 0.07 : 0.02 }));
    }
  }
  return notes;
}
const CHORD_VOICINGS = Object.freeze([{ lead: true, anchor: "C3" }, { lead: true, anchor: "F3" }, { lead: false, anchor: "C3" }]);

/**
 * Turns a lead sheet into a score. Returns { ok: true, score, seconds, bars, summary, notes } where
 * score is what the renderer takes and notes are what the lint heard in it, or { ok: false, problems }
 * with one plain sentence for each thing to fix.
 */
export function buildTrackScore(sheet) {
  const problems = [];
  const fail = () => ({ ok: false, problems: problems.slice(0, 8) });
  if (!isRecord(sheet)) return { ok: false, problems: [{ where: "score", problem: "The score must be an object." }] };

  const tempo = Number(sheet.tempo);
  if (!Number.isFinite(tempo) || tempo < SCORE_LIMITS.tempo.min || tempo > SCORE_LIMITS.tempo.max) {
    problems.push({ where: "tempo", problem: `tempo is ${SCORE_LIMITS.tempo.min} to ${SCORE_LIMITS.tempo.max} beats a minute.` });
  }
  const key = text(sheet.key);
  if (!/^[A-Ga-g][#b]?\s+\S+/u.test(key)) problems.push({ where: "key", problem: 'key is a tonic and a scale, such as "Db major", "A minor" or "D dorian".' });
  const beatsPerBar = sheet.beats_per_bar === undefined ? 4 : Number(sheet.beats_per_bar);
  if (![3, 4].includes(beatsPerBar)) problems.push({ where: "beats_per_bar", problem: "beats_per_bar is 3 or 4." });

  const parts = new Map();
  const partList = Array.isArray(sheet.parts) ? sheet.parts : [];
  if (partList.length < 1 || partList.length > SCORE_LIMITS.parts) problems.push({ where: "parts", problem: `A track has 1 to ${SCORE_LIMITS.parts} parts.` });
  for (const [index, part] of partList.slice(0, SCORE_LIMITS.parts).entries()) {
    const where = `parts[${index}]`;
    const name = text(part?.name).toLowerCase();
    if (!/^[a-z][a-z0-9 _-]{0,23}$/u.test(name) || parts.has(name)) {
      problems.push({ where, problem: "Each part needs its own short name, such as keys, bass, drums or lead." });
      continue;
    }
    if (!SCORE_ROLES.includes(part.role)) {
      problems.push({ where, problem: `role is one of ${SCORE_ROLES.join(", ")}.` });
      continue;
    }
    if (!SCORE_SOUNDS[part.role].includes(part.sound)) {
      problems.push({ where, problem: `A ${part.role} part's sound is one of ${SCORE_SOUNDS[part.role].join(", ")}.` });
      continue;
    }
    const styles = SCORE_STYLES[part.role];
    const style = part.style ?? styles?.[0];
    if (styles && !styles.includes(style)) {
      problems.push({ where, problem: `A ${part.role} part's style is one of ${styles.join(", ")}.` });
      continue;
    }
    let grids = null;
    if (part.role === "drums") {
      const beat = isRecord(part.beat) ? part.beat : {};
      grids = [];
      for (const [voice, grid] of Object.entries(beat)) {
        if (!SCORE_DRUM_VOICES.includes(voice)) problems.push({ where: `${where}.beat`, problem: `Drum voices are ${SCORE_DRUM_VOICES.join(", ")}; "${voice.slice(0, 16)}" is not one.` });
        else {
          const steps = parseGrid(grid, beatsPerBar * 4, `${where}.beat.${voice}`, problems);
          if (steps) grids.push({ voice, steps });
        }
      }
      if (!Object.keys(beat).length) problems.push({ where: `${where}.beat`, problem: 'A drums part needs a beat, such as { "kick": "x.......x.x.....", "snare": "....x.......x...", "hat": "x.x.x.x.x.x.x.x." }.' });
    }
    const level = part.level === undefined ? 1 : Number(part.level);
    if (!(level >= 0.2 && level <= 1.2)) problems.push({ where, problem: "level is 0.2 to 1.2; 1 is the usual balance." });
    parts.set(name, { name, role: part.role, sound: part.sound, style, grids, level: level >= 0.2 && level <= 1.2 ? level : 1, notes: [], runs: [] });
  }

  const sections = Array.isArray(sheet.sections) ? sheet.sections : [];
  if (sections.length < 1 || sections.length > SCORE_LIMITS.sections) problems.push({ where: "sections", problem: `A track has 1 to ${SCORE_LIMITS.sections} sections.` });
  if (problems.length) return fail();

  const harmony = [];
  const form = [];
  let bar = 0;
  for (const [index, section] of sections.entries()) {
    const where = `sections[${index}]`;
    const symbols = chordsOf(section?.chords);
    if (symbols.length < 1 || symbols.length > SCORE_LIMITS.sectionBars) {
      problems.push({ where: `${where}.chords`, problem: `A section has 1 to ${SCORE_LIMITS.sectionBars} bars: write one chord symbol for each bar, and repeat a symbol to hold it.` });
      continue;
    }
    for (const symbol of symbols) {
      try { chord(symbol, 0, 1); } catch { problems.push({ where: `${where}.chords`, problem: `"${symbol.slice(0, 16)}" is not a chord symbol. Use symbols like Dbmaj7, Bbm7, G7sus4, Fadd9 or C/E.` }); }
    }
    const repeat = section.repeat === undefined ? 1 : Number(section.repeat);
    if (!Number.isInteger(repeat) || repeat < 1 || repeat > SCORE_LIMITS.repeat) {
      problems.push({ where: `${where}.repeat`, problem: `repeat is 1 to ${SCORE_LIMITS.repeat}.` });
      continue;
    }
    const playing = section.plays === undefined ? [...parts.keys()] : (Array.isArray(section.plays) ? section.plays : []).map((name) => text(name).toLowerCase());
    for (const name of playing) if (!parts.has(name)) problems.push({ where: `${where}.plays`, problem: `"${name.slice(0, 24)}" is not one of the parts (${[...parts.keys()].join(", ")}).` });
    // The written lines: a list of { part, notes }, which every model's tool schema can carry, or an object by part name.
    const lines = (Array.isArray(section.lines) ? section.lines.map((entry) => [entry?.part, entry?.notes]) : isRecord(section.lines) ? Object.entries(section.lines) : [])
      .map(([name, line]) => [text(name).toLowerCase(), line]);
    const written = new Map();
    for (const [name, line] of lines) {
      const part = parts.get(name);
      if (!part || part.role !== "line") {
        problems.push({ where: `${where}.lines`, problem: `"${name.slice(0, 24)}" is not a line part. Only parts with role line take written notes.` });
        continue;
      }
      if (text(line).length > SCORE_LIMITS.lineCharacters) {
        problems.push({ where: `${where}.lines.${name}`, problem: "This line is too long. Write a shorter phrase and use repeat." });
        continue;
      }
      const parsed = parseLine(line, `${where}.lines.${name}`, problems);
      if (!parsed) continue;
      const room = symbols.length * beatsPerBar;
      if (parsed.beats > room + 1e-6) {
        problems.push({ where: `${where}.lines.${name}`, problem: `This line is ${round(parsed.beats)} beats long, but the section's ${symbols.length} bars hold ${room}. Shorten it by ${round(parsed.beats - room)} beats.` });
        continue;
      }
      written.set(name, parsed.notes);
    }
    if (problems.length) continue;
    const name = text(section.name).slice(0, 32) || `section ${index + 1}`;
    for (let pass = 0; pass < repeat; pass += 1) {
      const at = bar * beatsPerBar;
      form.push({ name, bar, bars: symbols.length });
      harmony.push(...symbols);
      for (const partName of new Set(playing)) {
        const part = parts.get(partName);
        if (part.role === "chords") part.runs.push({ at, symbols });
        else if (part.role === "bass") {
          for (const [offset, symbol] of symbols.entries()) {
            const [root] = chord(symbol, 0, 1, { part: "bass" });
            part.notes.push(...bassNotes(part.style, root.pitch, at + offset * beatsPerBar, beatsPerBar, !/dim|aug|b5|#5|\+/u.test(symbol)));
          }
        } else if (part.role === "drums") {
          const steps = symbols.length * beatsPerBar * 4;
          for (const { voice, steps: grid } of part.grids) {
            for (let step = 0; step < steps; step += 1) {
              const mark = grid[step % grid.length];
              if (VELOCITY[mark]) part.notes.push(hit(voice, at + step / 4, VELOCITY[mark]));
            }
          }
        } else {
          for (const entry of written.get(partName) ?? []) part.notes.push(note(entry.pitch, at + entry.at, Math.max(0.1, entry.beats - 0.02), 0.5));
        }
      }
      bar += symbols.length;
    }
  }
  if (problems.length) return fail();

  const seconds = (bar * beatsPerBar * 60) / tempo;
  if (seconds < SCORE_LIMITS.seconds.min || seconds > SCORE_LIMITS.seconds.max) {
    return { ok: false, problems: [{ where: "sections", problem: `The track runs ${Math.round(seconds)} seconds (${bar} bars at ${tempo} BPM); it can be ${SCORE_LIMITS.seconds.min} to ${SCORE_LIMITS.seconds.max}. ${seconds < SCORE_LIMITS.seconds.min ? "Add bars or use repeat." : "Take bars out."}` }] };
  }
  if (![...parts.values()].some((part) => part.role === "chords" ? part.runs.length : part.notes.length)) {
    return { ok: false, problems: [{ where: "sections", problem: "No part plays a note. List the parts in each section's plays, and write lines for line parts." }] };
  }

  const assemble = (voicing) => song({
    calibration: SONG_CALIBRATION_LATEST,
    tempo,
    meter: [beatsPerBar, 4],
    bars: bar,
    key,
    tracks: [...parts.values()].map((part) => {
      const mix = MIX[part.role];
      return track({
        name: part.name,
        ...instrumentOf(part.sound),
        volume: Math.min(1, round(mix.volume * part.level)),
        ...(mix.reverb ? { reverb: mix.reverb } : {}),
        notes: part.role === "chords" ? chordNotes(part.style, part.runs, beatsPerBar, voicing) : part.notes,
      });
    }),
    master: MASTER,
  });
  const listen = (built) => lintSong(built, { config: { harmony } }).findings;
  let best = null;
  try {
    for (const voicing of CHORD_VOICINGS) {
      const built = JSON.parse(JSON.stringify(assemble(voicing)));
      const findings = listen(built);
      const clashes = findings.filter((finding) => finding.rule === "harmony.low-second").length;
      if (!best || clashes < best.clashes) best = { built, findings, clashes };
      if (clashes === 0) break;
    }
    // The renderer's own reading of the score: a score it refuses is a problem to fix, not a crash later.
    scoreFromJSON(best.built);
  } catch (error) {
    return { ok: false, problems: [{ where: "score", problem: String(error?.message ?? "The score could not be built.").slice(0, 240) }] };
  }

  const summary = {
    tempo, key, beats_per_bar: beatsPerBar, bars: bar, seconds: Math.round(seconds),
    parts: [...parts.values()].map((part) => ({ name: part.name, role: part.role, sound: part.sound, ...(part.style ? { style: part.style } : {}) })),
    form: form.map((entry) => `${entry.name} (${entry.bars})`).join(", ").slice(0, 400),
    chords: [...new Set(harmony)].slice(0, 24),
  };
  // What the lint heard: wrong notes first, then cautions. Advice the listener would not hear stays out.
  const order = { error: 0, warn: 1 };
  const notes = best.findings.filter((finding) => finding.severity in order)
    .sort((left, right) => order[left.severity] - order[right.severity])
    .slice(0, 6).map((finding) => ({
      severity: finding.severity,
      rule: finding.rule,
      // The part and the bar as the agent counts them, from 1.
      where: [finding.where?.track, Number.isInteger(finding.where?.bar) ? `bar ${finding.where.bar + 1}` : null].filter(Boolean).join(", ") || "score",
      problem: String(finding.message).slice(0, 200),
    }));
  return { ok: true, score: best.built, seconds, bars: bar, summary, notes, wrong_notes: best.findings.filter((finding) => finding.severity === "error").length };
}

/** The line a receipt and the agent keep in place of a text prompt: what the score is, in a sentence. */
export function describeScore(summary) {
  const sounds = summary.parts.map((part) => part.sound).join(", ");
  return `Written as a score: ${summary.key}, ${summary.tempo} BPM, ${summary.bars} bars. ${sounds}. Chords: ${summary.chords.join(" ")}.`.slice(0, 1_000);
}
