import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";

import { createMoondogTheme } from "../../src/surfaces/cli/brand-theme.mjs";
import { HistoryImportView } from "../../src/surfaces/cli/history-import-view.mjs";

const preview = {
  sourceLabel: "Spotify Extended history", fileName: "My Spotify history.zip",
  sourceFormat: "private_schema_marker", dataScope: "private_scope_marker",
  listeningEvents: 12450, tracks: 420,
  earliestListeningAt: "2016-01-01T00:00:00.000Z", latestListeningAt: "2026-09-01T00:00:00.000Z",
  eventsWithPlayedMs: 12000, profileEvidence: 5,
  scopeNote: "A history export describes the listening included in this file.",
};

function fixture(options = {}) {
  let rows = options.rows ?? 20;
  const actions = [];
  const theme = createMoondogTheme({ mode: options.mode ?? "charcoal", environment: options.environment ?? { TERM: "xterm-256color" } });
  const view = new HistoryImportView({
    tui: { terminal: { rows: 24 }, requestRender() {} },
    getTheme: () => theme, getRows: () => rows,
    profileReady: options.profileReady ?? false, onAction: (action) => actions.push(action),
  });
  view.focused = true;
  return { view, actions, resize: (value) => { rows = value; } };
}

function screen(view, width = 80) { return view.render(width).map(stripVTControlCharacters).join("\n"); }

test("import actions remain host-owned and the profile shortcut follows readiness", () => {
  const { view, actions } = fixture();
  assert.doesNotMatch(screen(view), /View my profile/u);
  view.handleInput("\r");
  assert.deepEqual(actions.pop(), { type: "spotify" });
  assert.equal(view.state.page, "start");
  view.handleInput("\x1b[B");
  view.handleInput("\r");
  assert.deepEqual(actions.pop(), { type: "apple" });
  view.handleInput("\x1b[B");
  view.handleInput("\r");
  assert.deepEqual(actions.pop(), { type: "youtube_music" });
  for (const type of ["qq_music", "netease", "other"]) {
    view.handleInput("\x1b[B"); view.handleInput("\r");
    assert.deepEqual(actions.pop(), { type });
  }
  view.handleInput("\x1b");
  assert.deepEqual(actions.pop(), { type: "close" });
  view.setState({ page: "start", profileReady: true });
  assert.match(screen(view), /View my profile/u);
  view.handleInput("\x1b[B");
  view.handleInput("\r");
  assert.deepEqual(actions.pop(), { type: "profile" });
  for (const page of ["spotify", "waiting", "other", "file", "preview"]) {
    view.setState({ page, preview });
    view.handleInput("\x1b");
    assert.deepEqual(actions.pop(), { type: "back" });
  }
});

test("native editor retains literal paths, inspection errors, and expanded split pastes", () => {
  const { view, actions } = fixture();
  view.setState({ page: "file" });
  const file = "/tmp/listener/My Downloads/Spotify history.zip";
  view.setPath(file);
  view.handleInput("\r");
  assert.deepEqual(actions.pop(), { type: "inspect", path: file });
  assert.equal(view.getPath(), file);
  view.setState({ page: "file", error: "This file is not a supported history archive." });
  assert.equal(view.getPath(), file);
  assert.match(screen(view), /not a supported history archive/u);
  assert.match(screen(view), /My Downloads\/Spotify history.zip/u);
  view.setPath("");
  const longPath = `/tmp/${"saved-history-".repeat(90)}.zip`;
  view.handleInput(`\x1b[200~${longPath}`);
  view.handleInput("\x1b[20");
  view.handleInput("1~");
  assert.deepEqual(actions, []);
  assert.equal(view.getPath(), longPath);
  view.handleInput("\r");
  assert.deepEqual(actions.pop(), { type: "inspect", path: longPath });
  assert.equal(view.getPath(), longPath);
  view.setState({ page: "preview", preview });
  view.setState({ page: "file", error: "Try another export." });
  assert.equal(view.getPath(), longPath);
});

test("Tab uses Pi file completion and retains the completed path after inspection", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog import path-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "Listening history.zip");
  await writeFile(file, "synthetic fixture");
  const { view, actions } = fixture({ rows: 12 });
  context.after(() => { view.focused = false; });
  view.setState({ page: "file" });
  view.setPath(path.join(root, "List"));
  view.handleInput("\t");
  const deadline = performance.now() + 1000;
  while (!view.getPath().includes("Listening history.zip") && !view.editor.isShowingAutocomplete()) {
    assert.ok(performance.now() < deadline, "Pi should return local path completions");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (view.editor.isShowingAutocomplete()) {
    const lines = view.render(40);
    assert.equal(lines.length, 12);
    assert.ok(lines.some((line) => line.includes(CURSOR_MARKER)));
    assert.ok(lines.every((line) => visibleWidth(line) === 40));
    view.handleInput("\t");
  }
  assert.ok(view.getPath().includes(file));
  assert.deepEqual(actions, []);
  const completed = view.getPath();
  view.handleInput("\r");
  assert.deepEqual(actions.pop(), { type: "inspect", path: completed });
  assert.equal(view.getPath(), completed);
});

test("preview exposes human facts and requires explicit commit; working ignores commands", () => {
  const { view, actions } = fixture();
  view.setState({ page: "preview", preview });
  const text = screen(view);
  assert.match(text, /Nothing added yet/u);
  assert.match(text, /12,450 plays · 420 tracks/u);
  assert.match(text, /2016-01-01 to 2026-09-01/u);
  assert.doesNotMatch(text, /private_schema_marker|private_scope_marker/u);
  assert.deepEqual(actions, []);
  view.handleInput("\r");
  assert.deepEqual(actions.pop(), { type: "commit" });
  view.setState({ page: "working", message: "Updating your listening profile." });
  for (const key of ["\r", "\x1b", "\x1b[B", "\x03", "\t", "\x1b[200~text\x1b[201~"]) view.handleInput(key);
  assert.deepEqual(actions, []);
  assert.match(screen(view), /Updating your listening profile/u);
  assert.doesNotMatch(screen(view), /cancel|Ctrl\+C|percent|\d+%/u);
});

test("every page fits wide and narrow body viewports with an intact file cursor and plain colors", () => {
  for (const options of [{ mode: "paper" }, { mode: "charcoal" }, { environment: { NO_COLOR: "1" } }]) {
    const { view, resize } = fixture({ ...options, profileReady: true });
    view.setPath("/tmp/listener/Downloads/a long listening history file.zip");
    for (const [width, rows] of [[80, 20], [40, 14], [40, 12], [26, 8], [8, 3], [1, 1], [40, 0]]) {
      resize(rows);
      for (const page of ["start", "spotify", "spotifyHistory", "apple", "appleQuick", "appleHistory", "youtube_music", "youtubeQuick", "youtubeHistory", "qq_music", "netease", "waiting", "other", "quick", "setup", "client", "empty", "file", "preview", "working"]) {
        view.setState({ page, preview, ...(page === "file" ? { error: "Choose a supported file; your path is still here." } : {}) });
        const lines = view.render(width);
        assert.equal(lines.length, rows, `${page} height at ${width}x${rows}`);
        assert.ok(lines.every((line) => visibleWidth(line) === width), `${page} width at ${width}x${rows}`);
        if (["file", "client"].includes(page) && width >= 40 && rows >= 12) assert.ok(lines.some((line) => line.includes(CURSOR_MARKER)));
        if (page === "preview" && width >= 40 && rows >= 12) assert.match(lines.join("\n"), /Import into my profile/u);
        if (options.environment?.NO_COLOR) assert.ok(lines.every((line) => !/\x1b\[[\d;:]*m/u.test(line)));
      }
    }
  }
});

test("short guides scroll while actions remain visible and external text cannot issue terminal controls", () => {
  const { view, actions } = fixture({ rows: 12 });
  view.setState({ page: "spotifyHistory" });
  const first = screen(view, 40);
  assert.match(first, /Open Spotify data export/u);
  view.handleInput("\x1b[6~");
  assert.notEqual(screen(view, 40), first);
  assert.match(screen(view, 40), /Open Spotify data export/u);
  view.handleInput("\x1b[B");
  view.handleInput("\r");
  assert.deepEqual(actions.pop(), { type: "openSpotify" });
  view.setState({ page: "preview", preview: { ...preview, fileName: "history\x1b[2J\u202ezip" }, error: "failed\x1b]52;c;payload\x07\u2066" });
  let rendered = view.render(40).join("\n");
  assert.doesNotMatch(rendered, /\x1b\[2J|\x1b\]52|\u202e|\u2066/u);
  view.setState({ page: "file", error: "failed\x1b[2J" });
  view.setPath("/tmp/history\x1b[2J\u202e.zip");
  rendered = view.render(40).join("\n");
  assert.doesNotMatch(rendered, /\x1b\[2J|\u202e/u);
  assert.ok(rendered.includes(CURSOR_MARKER));
  view.handleInput("\x1b[200~");
  view.handleInput("\r");
  view.handleInput("\x1b[201~");
  assert.deepEqual(actions, []);
});
