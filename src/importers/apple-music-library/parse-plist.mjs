import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

import { parse } from "plist";

export const DEFAULT_APPLE_LIBRARY_LIMITS = Object.freeze({
  maxBytes: 64 * 1024 * 1024,
  maxNodes: 2_000_000,
  maxDepth: 64,
  maxTextBytes: 1024 * 1024,
  maxTracks: 100_000,
  maxPlaylists: 10_000,
  maxPlaylistItems: 1_000_000,
});

const standardAppleDoctype =
  /<!DOCTYPE\s+plist\s+PUBLIC\s+["']-\/\/Apple(?:\s+Computer)?\/\/DTD\s+PLIST\s+1\.0\/\/EN["']\s+["']http:\/\/www\.apple\.com\/DTDs\/PropertyList-1\.0\.dtd["']\s*>/i;

export class AppleMusicImportError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "AppleMusicImportError";
    this.code = code;
  }
}

function fail(code, message, options) {
  throw new AppleMusicImportError(code, message, options);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function mergedLimits(overrides = {}) {
  const limits = { ...DEFAULT_APPLE_LIBRARY_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`Apple Music parser limit ${name} must be positive`);
    }
  }
  return limits;
}

function decodeXmlKey(source) {
  const decoded = source.replace(
    /&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi,
    (entity) => {
      const body = entity.slice(1, -1).toLowerCase();
      const named = new Map([
        ["amp", "&"],
        ["lt", "<"],
        ["gt", ">"],
        ["quot", '"'],
        ["apos", "'"],
      ]);
      if (named.has(body)) return named.get(body);
      const codePoint = body.startsWith("#x")
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      if (!Number.isInteger(codePoint) || codePoint > 0x10ffff) {
        fail("xml_invalid_key_entity", "XML key contains an invalid entity");
      }
      return String.fromCodePoint(codePoint);
    },
  );

  if (/&[^;\s]+;/.test(decoded)) {
    fail("xml_unsupported_key_entity", "XML key contains an unsupported entity");
  }
  return decoded;
}

function stripAndValidateMarkup(xml) {
  if (/<!ENTITY\b/i.test(xml)) {
    fail("xml_entity_forbidden", "Custom XML entities are not allowed");
  }
  if (/<!\[CDATA\[/i.test(xml)) {
    fail("xml_cdata_unsupported", "CDATA sections are not supported");
  }

  const withoutStandardDoctype = xml.replace(standardAppleDoctype, "");
  if (/<!DOCTYPE\b/i.test(withoutStandardDoctype)) {
    fail("xml_doctype_forbidden", "Only the standard Apple plist doctype is allowed");
  }

  const commentStarts = withoutStandardDoctype.match(/<!--/g)?.length ?? 0;
  const commentEnds = withoutStandardDoctype.match(/-->/g)?.length ?? 0;
  if (commentStarts !== commentEnds) {
    fail("xml_malformed_comment", "XML contains an unclosed comment");
  }

  return withoutStandardDoctype.replace(/<!--[\s\S]*?-->/g, "");
}

function validateDocumentEnvelope(xml) {
  const declaration =
    /^\s*<\?xml\s+version=["']1\.0["'](?:\s+encoding=["']UTF-8["'])?\s*\?>/i;
  const declarationMatch = xml.match(declaration);
  if (!declarationMatch && /<\?xml\b/i.test(xml)) {
    fail(
      "plist_envelope_invalid",
      "XML declaration must appear before the plist document",
    );
  }
  const withoutDeclaration = declarationMatch
    ? xml.slice(declarationMatch[0].length)
    : xml;
  if (/<\?xml\b/i.test(withoutDeclaration) || /<\?(?!xml\b)/i.test(xml)) {
    fail(
      "xml_processing_instruction_forbidden",
      "XML contains an unsupported processing instruction",
    );
  }

  const openings = [...withoutDeclaration.matchAll(/<plist\b[^>]*>/gi)];
  const closings = [...withoutDeclaration.matchAll(/<\/plist\s*>/gi)];
  if (openings.length !== 1 || closings.length !== 1) {
    fail("plist_envelope_invalid", "XML must contain exactly one plist document");
  }
  if (
    !/^<plist(?:\s+version=["']1\.0["'])?\s*>$/i.test(openings[0][0])
  ) {
    fail("plist_element_invalid", "plist root attributes are not supported");
  }

  const before = withoutDeclaration.slice(0, openings[0].index);
  const closingEnd = closings[0].index + closings[0][0].length;
  const after = withoutDeclaration.slice(closingEnd);
  if (before.trim() !== "" || after.trim() !== "") {
    fail(
      "plist_envelope_invalid",
      "XML cannot contain content outside the plist document",
    );
  }
}

function preflightStructure(xml, limits) {
  for (const match of xml.matchAll(
    /<(?!\/)(dict|array|key|string|integer|real|date|data|true|false)\b([^>]*)>/gi,
  )) {
    const tagName = match[1].toLowerCase();
    const suffix = match[2].trim();
    if (suffix !== "" && suffix !== "/") {
      fail("xml_tag_attributes_forbidden", "plist value tags cannot have attributes");
    }
    if (tagName === "key" && suffix === "/") {
      fail("xml_empty_key_forbidden", "Empty plist dictionary keys are not allowed");
    }
  }

  const nodeMatches = xml.match(
    /<(?:dict|array|key|string|integer|real|date|data|true|false)\b/gi,
  );
  if ((nodeMatches?.length ?? 0) > limits.maxNodes) {
    fail("xml_node_limit", "XML exceeds the configured node limit");
  }

  for (const tagName of ["key", "string", "data", "integer", "real", "date"]) {
    const pattern = new RegExp(
      `<${tagName}\\s*>([\\s\\S]*?)<\\/${tagName}\\s*>`,
      "gi",
    );
    for (const match of xml.matchAll(pattern)) {
      if (Buffer.byteLength(match[1], "utf8") > limits.maxTextBytes) {
        fail("xml_text_limit", "XML contains a text value above the size limit");
      }
    }
  }

  const stack = [];
  const tokenPattern =
    /<(dict|array)\s*>|<\/(dict|array)\s*>|<key\s*>([\s\S]*?)<\/key\s*>/gi;

  for (const match of xml.matchAll(tokenPattern)) {
    if (match[1]) {
      stack.push({ type: match[1].toLowerCase(), keys: new Set() });
      if (stack.length > limits.maxDepth) {
        fail("xml_depth_limit", "XML exceeds the configured nesting depth");
      }
      continue;
    }

    if (match[2]) {
      const expected = match[2].toLowerCase();
      const current = stack.pop();
      if (!current || current.type !== expected) {
        fail("xml_structure_invalid", "XML containers are not balanced");
      }
      continue;
    }

    const current = stack.at(-1);
    if (!current || current.type !== "dict") {
      fail("xml_key_outside_dict", "XML key appears outside a dictionary");
    }
    const key = decodeXmlKey(match[3]);
    if (current.keys.has(key)) {
      fail("xml_duplicate_dict_key", "XML contains a duplicate dictionary key");
    }
    current.keys.add(key);
  }

  if (stack.length !== 0) {
    fail("xml_structure_invalid", "XML containers are not balanced");
  }
}

function isoTimestamp(value, fieldName) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    fail("plist_required_date_invalid", `${fieldName} must be a valid plist date`);
  }
  return value.toISOString();
}

function validateParsedRoot(root, limits) {
  if (!isPlainObject(root)) {
    fail("plist_root_invalid", "Apple Music plist root must be a dictionary");
  }
  if (!isPlainObject(root.Tracks)) {
    fail("plist_tracks_invalid", "Apple Music plist must contain a Tracks dictionary");
  }
  if (root.Playlists !== undefined && !Array.isArray(root.Playlists)) {
    fail("plist_playlists_invalid", "Apple Music Playlists must be an array");
  }

  const trackCount = Object.keys(root.Tracks).length;
  const playlists = root.Playlists ?? [];
  if (trackCount > limits.maxTracks) {
    fail("plist_track_limit", "Apple Music library exceeds the track limit");
  }
  if (playlists.length > limits.maxPlaylists) {
    fail("plist_playlist_limit", "Apple Music library exceeds the playlist limit");
  }

  let playlistItemCount = 0;
  for (const playlist of playlists) {
    if (!isPlainObject(playlist)) {
      fail("plist_playlist_invalid", "Apple Music playlist entry must be a dictionary");
    }
    const items = playlist["Playlist Items"];
    if (items !== undefined && !Array.isArray(items)) {
      fail("plist_playlist_items_invalid", "Playlist Items must be an array");
    }
    playlistItemCount += items?.length ?? 0;
    if (playlistItemCount > limits.maxPlaylistItems) {
      fail(
        "plist_playlist_item_limit",
        "Apple Music library exceeds the playlist item limit",
      );
    }
  }

  const libraryPersistentId = root["Library Persistent ID"];
  if (
    libraryPersistentId !== undefined &&
    (typeof libraryPersistentId !== "string" ||
      libraryPersistentId.trim() === "")
  ) {
    fail(
      "plist_library_identity_invalid",
      "Library Persistent ID must be a non-empty string when present",
    );
  }

  return {
    capturedAt: isoTimestamp(root.Date, "Apple Music export Date"),
    libraryPersistentId: libraryPersistentId?.trim(),
    trackCount,
    playlistCount: playlists.length,
    playlistItemCount,
  };
}

export function parseAppleMusicLibraryBuffer(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError("Apple Music XML input must be a Buffer");
  }
  const limits = mergedLimits(options.limits);
  if (buffer.length > limits.maxBytes) {
    fail("input_byte_limit", "Apple Music XML exceeds the configured byte limit");
  }

  let xml;
  try {
    xml = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (cause) {
    fail("input_encoding_invalid", "Apple Music XML must be valid UTF-8", {
      cause,
    });
  }
  if (xml.codePointAt(0) === 0xfeff) xml = xml.slice(1);
  if (xml.includes("\0")) {
    fail("input_nul_forbidden", "Apple Music XML cannot contain NUL bytes");
  }
  if (!/<plist(?:\s[^>]*)?>/i.test(xml)) {
    fail("plist_element_missing", "Input does not contain a plist root element");
  }

  const sanitizedXml = stripAndValidateMarkup(xml);
  validateDocumentEnvelope(sanitizedXml);
  preflightStructure(sanitizedXml, limits);

  let root;
  let parserDiagnostic = false;
  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = () => {
    parserDiagnostic = true;
  };
  console.warn = () => {
    parserDiagnostic = true;
  };
  try {
    root = parse(sanitizedXml);
  } catch {
    fail("plist_parse_failed", "Apple Music XML could not be parsed");
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
  }
  if (parserDiagnostic) {
    fail("plist_parse_diagnostic", "Apple Music XML contains invalid markup");
  }

  const rootSummary = validateParsedRoot(root, limits);
  return {
    root,
    sourceSha256: createHash("sha256").update(buffer).digest("hex"),
    sourceBytes: buffer.length,
    ...rootSummary,
  };
}

export async function readAppleMusicLibrary(inputPath, options = {}) {
  if (typeof inputPath !== "string" || inputPath.trim() === "") {
    throw new TypeError("Apple Music XML input path is required");
  }
  const limits = mergedLimits(options.limits);

  try {
    const metadata = await stat(inputPath);
    if (!metadata.isFile()) {
      fail("input_not_file", "Apple Music XML input must be a regular file");
    }
    if (metadata.size > limits.maxBytes) {
      fail("input_byte_limit", "Apple Music XML exceeds the configured byte limit");
    }
    const buffer = await readFile(inputPath);
    return parseAppleMusicLibraryBuffer(buffer, { limits });
  } catch (cause) {
    if (cause instanceof AppleMusicImportError) throw cause;
    fail("input_unreadable", "Apple Music XML input could not be read", { cause });
  }
}
