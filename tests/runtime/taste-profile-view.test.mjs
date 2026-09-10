import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";

import { createMoondogTheme } from "../../src/surfaces/cli/brand-theme.mjs";
import { TasteProfileView } from "../../src/surfaces/cli/taste-profile-view.mjs";

function model() {
  return {
    summaryLines: ["1,200 plays · 84 hours · 230 tracks", "Your direct choices stay separate from listening frequency."],
    subjects: [
      { key: "track-one", label: "Quiet Orbit", subtitle: "Luna Vale · Night Rooms", kind: "track", detailLines: ["Played 24 times.", "Last heard in your winter listening season."], opaque: { trackRef: "local-1" } },
      { key: "artist-one", label: "Luna Vale", subtitle: "Artist · 8 familiar tracks", kind: "artist", stance: "like", detailLines: ["You explicitly liked this artist.", "Listening evidence remains independent."] },
      { key: "track-two", label: "月の窓 / Window on the Moon", subtitle: "Luna Vale · Long Nights", kind: "track", stance: "avoid", detailLines: Array.from({ length: 30 }, (_, index) => `Evidence row ${index + 1}: a bounded fictional observation.`) },
    ],
    emptyLines: ["Bring your listening history.", "A saved archive creates your first profile."],
  };
}

function fixture(options = {}) {
  let rows = options.rows ?? 30;
  const theme = createMoondogTheme({ mode: options.mode ?? "charcoal", environment: options.environment ?? { TERM: "xterm-256color" } });
  const data = model();
  const view = new TasteProfileView({ model: data, getTheme: () => theme, getRows: () => rows });
  view.focused = true;
  return { view, data, resize: (value) => { rows = value; } };
}

test("profile view keeps the native query cursor and selected reading inside wide and narrow viewports", () => {
  for (const options of [{ mode: "paper" }, { mode: "charcoal" }, { environment: { NO_COLOR: "1" } }]) {
    const { view, resize } = fixture(options);
    for (const [columns, rows] of [[100, 30], [40, 15], [80, 20], [26, 10], [8, 6], [3, 3], [1, 1], [40, 0]]) {
      resize(rows);
      const lines = view.render(columns);
      assert.equal(lines.length, rows);
      assert.ok(lines.every((line) => visibleWidth(line) === columns));
      if (columns >= 26 && rows >= 10) {
        assert.ok(lines.some((line) => line.includes(CURSOR_MARKER)));
        const screen = lines.map(stripVTControlCharacters).join("\n");
        assert.match(screen, columns >= 40 ? /Your listening profile/u : /Your profile/u);
        assert.match(screen, /Quiet Orbit/u);
      }
      if (options.environment?.NO_COLOR) assert.ok(lines.every((line) => !/\x1b\[[\d;]*m/u.test(line)));
    }
  }
});

test("profile categories, filtering, refresh replacement and callbacks preserve opaque subjects and draft query", () => {
  const { view, data } = fixture();
  let selected;
  let refreshed = 0;
  let reports = 0;
  let closed = 0;
  view.onSelect = (item) => { selected = item; };
  view.onRefresh = () => { refreshed += 1; };
  view.onReport = () => { reports += 1; };
  view.onClose = () => { closed += 1; };
  view.handleInput("luna");
  view.handleInput("\t");
  assert.equal(view.getSelectedItem().kind, "track");
  view.handleInput("\x1b[B");
  assert.equal(view.getSelectedItem().key, "track-two");
  const replacement = { ...data, subjects: data.subjects.map((subject) => ({ ...subject, updated: true })) };
  view.setModel(replacement);
  assert.equal(view.getSelectedItem(), replacement.subjects[2]);
  assert.equal(view.input.getValue(), "luna");
  view.handleInput("\r");
  assert.equal(selected, replacement.subjects[2]);
  view.handleInput("\t");
  assert.equal(view.getSelectedItem().kind, "artist");
  view.handleInput("\t");
  assert.ok(["like", "avoid"].includes(view.getSelectedItem().stance));
  view.handleInput("\x12");
  view.handleInput("\x0f");
  view.handleInput("\x1b");
  assert.equal(refreshed, 1);
  assert.equal(reports, 1);
  assert.equal(closed, 1);
  view.handleInput("no-such-reading");
  assert.equal(view.getSelectedItem(), null);
  view.handleInput("\x1b[A");
  view.handleInput("\r");
  assert.equal(selected, replacement.subjects[2]);
  assert.match(view.render(40).map(stripVTControlCharacters).join("\n"), /No matching readings/u);
});

test("profile reading pages scroll independently and split pastes cannot select a subject", () => {
  const { view } = fixture({ rows: 15 });
  view.handleInput("\x1b[A");
  const initial = view.render(40).map(stripVTControlCharacters).join("\n");
  assert.match(initial, /Evidence row 1:/u);
  view.handleInput("\x1b[6~");
  const paged = view.render(40).map(stripVTControlCharacters).join("\n");
  assert.notEqual(paged, initial);
  assert.doesNotMatch(paged, /Evidence row 1:/u);
  view.handleInput("\x1b[5~");
  assert.equal(view.render(40).map(stripVTControlCharacters).join("\n"), initial);
  let selected = false;
  view.onSelect = () => { selected = true; };
  view.handleInput("\x1b[200~Quiet");
  view.handleInput("\r");
  view.handleInput(" Orbit\x1b[20");
  view.handleInput("1~");
  assert.equal(selected, false);
  assert.equal(view.getSelectedItem().key, "track-one");
  view.setModel({ subjects: [], emptyLines: ["Import a saved archive to begin."] });
  assert.match(view.render(40).map(stripVTControlCharacters).join("\n"), /Import a saved archive/u);
});
