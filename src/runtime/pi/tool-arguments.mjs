// Weaker models often get a tool call almost right: "play" for "resume", one song where a list is
// asked for, an empty field, an extra key the tool does not take. The host repairs only mistakes
// with one clear reading, before Pi validates the call, so the call runs as the model meant it.
// Anything else is left as it was, and Pi's validation error names the model's own arguments.
import { validateToolArguments } from "@earendil-works/pi-ai";

const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function passes(tool, args) {
  try {
    validateToolArguments(tool, { name: tool.name, arguments: args });
    return true;
  } catch {
    return false;
  }
}

// A key that is no identifier ("/invoke", "invoke name=\"…\"") is a model's own tool-call markup
// leaking into the arguments. No tool takes such a key, so it carries no meaning to refuse.
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function withoutEmpty(args) {
  return Object.fromEntries(Object.entries(args).filter(([key, value]) => IDENTIFIER.test(key) &&
    value !== null && value !== undefined && !(typeof value === "string" && !value.trim())));
}

const PLAYER_ACTIONS = new Map([
  ["play", "resume"], ["start", "resume"], ["continue", "resume"], ["unpause", "resume"], ["playback", "resume"],
  ["stop", "pause"], ["skip", "next"], ["forward", "next"], ["next_track", "next"],
  ["back", "previous"], ["prev", "previous"], ["previous_track", "previous"],
  ["set_volume", "volume"], ["set_shuffle", "shuffle"], ["set_repeat", "repeat"],
]);
const PLAYER_SOURCES = ["item_ref_id", "uri", "context_uri", "context_ref_id", "track_refs", "songs", "pending_plan"];

const repairs = {
  moondog_spotify_player_control(args) {
    const result = { ...args };
    if (typeof result.action === "string") {
      const action = result.action.trim().toLowerCase().replace(/[\s-]+/gu, "_");
      result.action = PLAYER_ACTIONS.get(action) ?? action;
    }
    // One song, or a song given at the top level, is the list of one the tool takes.
    if (result.songs === undefined && (result.song !== undefined || (typeof result.title === "string" && typeof result.artist === "string"))) {
      result.songs = result.song ?? { title: result.title, artist: result.artist };
      delete result.song;
      delete result.title;
      delete result.artist;
    }
    // A song keeps every field it came with: an extra one ("version": "Live") may be a constraint
    // the tool cannot honor, and validation must refuse it rather than play another recording.
    if (isPlainObject(result.songs)) result.songs = [result.songs];
    if (typeof result.track_refs === "string") result.track_refs = [result.track_refs];
    // A search's type copied into the play call says nothing the player needs.
    delete result.type;
    if (result.action === "volume" && result.percent === undefined && result.volume !== undefined) {
      result.percent = result.volume;
      delete result.volume;
    }
    if (result.action === undefined && PLAYER_SOURCES.some((key) => result[key] !== undefined)) result.action = "resume";
    // Only resume plays a source; another action with one leaves the source out.
    if (result.action && result.action !== "resume") for (const key of PLAYER_SOURCES) delete result[key];
    return result;
  },
  moondog_spotify_search(args) {
    const types = new Map([["song", "track"], ["songs", "track"], ["tracks", "track"], ["albums", "album"], ["artists", "artist"], ["playlists", "playlist"]]);
    if (typeof args.type !== "string") return args;
    const type = args.type.trim().toLowerCase();
    return { ...args, type: types.get(type) ?? type };
  },
};

/** The arguments to validate: the model's own when they pass, or a repair that passes. */
export function repairToolArguments(tool, args) {
  let parsed = args;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch { return args; }
  }
  if (!isPlainObject(parsed) || passes(tool, parsed)) return parsed;
  // An unknown key is never dropped in general: it can carry meaning the tool must refuse, such
  // as a subject the model may not choose. Only a tool's own repair removes a key it knows is noise.
  let repaired = withoutEmpty(parsed);
  repaired = repairs[tool.name]?.(repaired) ?? repaired;
  return passes(tool, repaired) ? repaired : args;
}

/** The tool with its repair step; Pi runs prepareArguments before it validates a call. */
export function withArgumentRepair(tool) {
  return { ...tool, prepareArguments: (args) => repairToolArguments(tool, args) };
}
