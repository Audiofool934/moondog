import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { musicHash, prepareMusicBundle } from "../../profile/music-import-bundle.mjs";

const exec = promisify(execFile);
const maximumBytes = 256 * 1024 * 1024;
const memberBytes = 64 * 1024 * 1024;
const maximumRecords = 100_000;
const videoId = /^[A-Za-z0-9_-]{11}$/u;

// Quoted commas, escaped quotes, UTF-8 BOMs and embedded line breaks occur in song names.
export function parseMusicCsv(text) {
  const rows = [];
  let row = [], cell = "", quoted = false, closed = false;
  text = text.replace(/^\uFEFF/u, "");
  for (let index = 0; index <= text.length; index += 1) {
    const char = text[index] ?? "\n";
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { cell += '"'; index += 1; }
      else if (char === '"') { quoted = false; closed = true; }
      else cell += char;
    } else if (char === '"' && !cell && !closed) quoted = true;
    else if (char === "," || char === "\n" || char === "\r") {
      row.push(cell); cell = ""; closed = false;
      if (char !== ",") {
        if (row.some(Boolean)) rows.push(row);
        row = [];
        if (char === "\r" && text[index + 1] === "\n") index += 1;
      }
    } else {
      if (closed || char === '"') throw new Error("Malformed CSV. Choose the original Google Takeout file.");
      cell += char;
    }
    if (rows.length > maximumRecords + 1 || cell.length > 100_000 || row.length > 100) throw new Error("Music CSV exceeds the supported size.");
  }
  if (quoted) throw new Error("Incomplete quoted CSV field. Choose the original Google Takeout file.");
  return rows;
}

function readRows(text, name, capturedAt) {
  const rows = [];
  let skipped = 0;
  if (/\.csv$/iu.test(name)) {
    const [header = [], ...records] = parseMusicCsv(text);
    const field = (row, key) => row[header.indexOf(key)]?.trim();
    if (!["Video ID", "Song Title", "Artist Name"].every((key) => header.includes(key))) {
      throw new Error("This CSV is not supported. Choose music-library-songs.csv with Video ID, Song Title and Artist Name columns. General YouTube playlist CSVs are not music library exports.");
    }
    for (const row of records) {
      const id = field(row, "Video ID");
      if (!videoId.test(id ?? "") || !field(row, "Song Title")) { skipped += 1; continue; }
      rows.push({ id, title: field(row, "Song Title"), artist: field(row, "Artist Name"), album: field(row, "Album Title"), member: name });
    }
  } else {
    let records;
    try { records = JSON.parse(text.replace(/^\uFEFF/u, "")); } catch { throw new Error("Invalid history JSON. In Google Takeout, choose JSON for history and download it again."); }
    if (!Array.isArray(records) || records.length > maximumRecords) throw new Error("Choose Google's watch-history.json array (up to 100,000 records per file).");
    for (const record of records) {
      let url;
      try { url = new URL(record?.titleUrl); } catch { skipped += 1; continue; }
      const id = url.searchParams.get("v");
      const time = Date.parse(record.time);
      // A video may also be watched on ordinary YouTube. Do not infer it was music.
      const music = record.header === "YouTube Music" || url.hostname === "music.youtube.com";
      const watched = typeof record.title === "string" && /^(?:Watched\s+|观看了\s*|觀看了\s*|已观看\s*)/iu.test(record.title);
      if (!music || !watched || !["http:", "https:"].includes(url.protocol) || !["www.youtube.com", "youtube.com", "music.youtube.com"].includes(url.hostname)
        || url.pathname !== "/watch" || !videoId.test(id ?? "") || !Number.isFinite(time)
        || time > Date.parse(capturedAt) || time < Date.UTC(2005, 0, 1) || typeof record.title !== "string") {
        skipped += 1; continue;
      }
      // Channel names are not recording-artist credits. Only the library CSV supplies those.
      const title = record.title.replace(/^(?:Watched\s+|观看了\s*|觀看了\s*|已观看\s*)/iu, "").trim();
      if (!title || title === record.titleUrl) { skipped += 1; continue; }
      rows.push({ id, title, occurredAt: new Date(time).toISOString(), member: name });
    }
  }
  return { rows, skipped };
}

async function boundedFile(filePath) {
  const file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > maximumBytes) throw new Error("Choose a regular Takeout file smaller than 256 MB. For a larger ZIP, extract only music-library-songs.csv and watch-history.json, then import each file.");
    const bytes = Buffer.alloc(stat.size + 1);
    let total = 0;
    while (total < bytes.length) {
      const { bytesRead } = await file.read(bytes, total, bytes.length - total, null);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total !== stat.size) throw new Error("The file changed while reading it. Try again after the download finishes.");
    return bytes.subarray(0, total);
  } finally { await file.close(); }
}

export async function readYouTubeMusicTakeout({ filePath, subjectId, capturedAt }) {
  const bytes = await boundedFile(filePath);
  const sources = [];
  if (/\.zip$/iu.test(filePath)) {
    // Read from one private snapshot: manifest digest and preview describe exactly the same bytes.
    const root = await mkdtemp(path.join(tmpdir(), "moondog-takeout-"));
    try {
      const zip = path.join(root, "takeout.zip");
      await writeFile(zip, bytes, { mode: 0o600 });
      const { stdout } = await exec("unzip", ["-Z1", zip], { maxBuffer: 1024 * 1024, timeout: 15_000 });
      const names = stdout.trimEnd().split("\n");
      const selected = names.filter((name) => /(?:^|\/)(?:watch-history\.json|music[- ]library[- ]songs\.csv|library[- ]songs\.csv)$/iu.test(name));
      if (!selected.length) throw new Error("No supported YouTube Music files in this ZIP. Include music library songs and history in Google Takeout; set history format to JSON, not HTML.");
      if (selected.length > 100 || new Set(selected).size !== selected.length) throw new Error("Takeout contains too many or duplicate music files.");
      let total = 0;
      for (const name of selected) {
        if (name.startsWith("/") || name.split("/").includes("..") || /[\\*?\[\]\u0000-\u001f\u007f]/u.test(name)) throw new Error("Unsupported archive member path.");
        const { stdout: content } = await exec("unzip", ["-p", zip, name], { encoding: "buffer", maxBuffer: memberBytes, timeout: 15_000 });
        total += content.length;
        if (total > maximumBytes) throw new Error("Unpacked music data exceeds 256 MB. Import the extracted files separately.");
        sources.push({ name: `${musicHash(name).slice(0, 12)}-${path.basename(name)}`, content });
      }
    } catch (error) {
      if (error.cmd || error.code === "ENOENT") throw new Error("Could not read this Takeout ZIP. Finish the download and use an unencrypted ZIP, or extract music-library-songs.csv and watch-history.json and import each file. ZIP reading requires unzip on this computer.");
      throw error;
    } finally { await rm(root, { recursive: true, force: true }); }
  } else {
    if (bytes.length > memberBytes) throw new Error("Choose a music CSV or history JSON smaller than 64 MB.");
    sources.push({ name: path.basename(filePath), content: bytes });
  }
  let skipped = 0;
  const rows = [];
  for (const source of sources) {
    const parsed = readRows(new TextDecoder("utf-8", { fatal: true }).decode(source.content), source.name, capturedAt);
    rows.push(...parsed.rows); skipped += parsed.skipped;
    if (rows.length > maximumRecords) throw new Error("Import up to 100,000 music records at a time. Import the extracted files separately.");
  }
  return prepareMusicBundle({ provider: "youtube_music", subjectId, capturedAt, rows,
    digest: musicHash(bytes), size: bytes.length, members: sources.map((source) => source.name), skipped,
    fileName: path.basename(filePath),
    scopeNote: "Your library songs and YouTube Music plays, read in English or Chinese. Regular YouTube videos are left out. Google doesn't say how long you listened, and history you deleted or paused can't come back.",
  });
}
