import assert from "node:assert/strict";
import test from "node:test";

import { screenTranslator } from "../../src/i18n/index.mjs";
import { BLOCK_MARK, SeasonsChart } from "../../src/surfaces/cli/seasons-chart.mjs";

const theme = { palette: { foreground: "#111", muted: "#666", faint: "#ccc", background: "#fff" },
  muted: text => text, text: text => text };
// [quarter, plays, minutes]; a missing minutes value is a quarter whose plays recorded no length.
const quarters = rows => rows.map(([key, plays, minutes]) => ({ key, event_count: plays, first_observed_tracks: 0,
  leading_artist: { name: "Fictional Band" }, ...(minutes === undefined ? {} : { listening_minutes: minutes }) }));
const render = (rows, environment = {}) =>
  new SeasonsChart(quarters(rows), { getTheme: () => theme, tr: screenTranslator("en"), environment }).render(80);
const bar = line => line.match(/[█▏▎▍▌▋▊▉]+/u)?.[0].length ?? 0;

test("seasons draw listening time, or plays when a quarter's time was not recorded", () => {
  // Spotify's history times every play: bars follow minutes, even against the play counts.
  const timed = render([["2026-Q1", 100, 60], ["2026-Q2", 10, 600]]);
  assert.match(timed[0], /60 min/u);
  assert.match(timed[1], /10 h/u);
  assert.ok(bar(timed[1]) > bar(timed[0]));

  // Last.fm times no play: bars and labels follow plays instead of showing nothing.
  const scrobbles = render([["2026-Q1", 100], ["2026-Q2", 10], ["2026-Q3", 0]]);
  assert.match(scrobbles[0], /100 plays/u);
  assert.match(scrobbles[1], /10 plays/u);
  assert.ok(bar(scrobbles[0]) > bar(scrobbles[1]) && bar(scrobbles[1]) > 0);
  assert.match(scrobbles[2], /nothing in your history/u);
  assert.doesNotMatch(scrobbles.join("\n"), /unknown duration/u);

  // One untimed quarter makes minutes incomparable, so every quarter counts plays.
  const mixed = render([["2026-Q1", 40], ["2026-Q2", 20, 90]]);
  assert.match(mixed[1], /20 plays/u);
  assert.ok(bar(mixed[0]) > bar(mixed[1]));

  // In Moondog's own window, the marked rows tell the graphics which measure the bars show.
  const [line] = render([["2026-Q1", 100], ["2026-Q2", 10]], { MOONDOG_HOST: "app" });
  const value = JSON.parse(atob(line.match(new RegExp(`\\x1b\\]${BLOCK_MARK};[^;]+;0;\\d+;([^\\x07]+)\\x07`, "u"))[1]));
  assert.equal(value.measure, "plays");
  assert.deepEqual(value.rows.map(row => [row.amount, row.fraction]), [[100, 1], [10, 0.1]]);
});
