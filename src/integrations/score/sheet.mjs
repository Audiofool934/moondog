// What a lead sheet may hold: the limits and the names the agent's tool and the score builder share.
// It is kept apart from the builder so that reading it never loads the renderer.

export const SCORE_LIMITS = Object.freeze({
  tempo: Object.freeze({ min: 50, max: 180 }),
  parts: 6,
  sections: 12,
  sectionBars: 16,
  repeat: 4,
  seconds: Object.freeze({ min: 15, max: 300 }),
  lineCharacters: 1_500,
  drumBars: 4,
});

export const SCORE_ROLES = Object.freeze(["chords", "bass", "drums", "line"]);

// The sounds a part can have, by role. The renderer synthesizes every one; none is a sample or a noise bed.
export const SCORE_SOUNDS = Object.freeze({
  chords: Object.freeze(["rhodes", "wurlitzer", "felt-piano", "pad", "harp", "dulcimer"]),
  bass: Object.freeze(["round-bass", "upright-bass", "sub-bass"]),
  drums: Object.freeze(["lofi", "acoustic", "808", "909", "electro", "trap"]),
  line: Object.freeze(["vibes", "marimba", "kalimba", "glass-bell", "flute", "cello", "viola", "voice", "rhodes", "felt-piano", "harp", "upright-bass", "round-bass"]),
});

// How a chords part plays each bar's chord, and how a bass part plays its root.
export const SCORE_STYLES = Object.freeze({
  chords: Object.freeze(["held", "rolled", "arp", "pulse"]),
  bass: Object.freeze(["long", "push", "pulse", "root-fifth"]),
});

export const SCORE_DRUM_VOICES = Object.freeze(["kick", "snare", "rim", "clap", "hat", "openhat", "tom"]);
