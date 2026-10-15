import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { formatListeningTime, sanitizeTerminalText } from "./format-output.mjs";

// The last twelve quarters as bars: listening time per quarter, with its new songs and
// leading artist beside each bar. Every terminal draws the bars with block characters.
// In Moondog's own window (MOONDOG_HOST=app), each bar row also carries an invisible
// OSC 7717 mark: block id, row, bar width, and the chart's numbers, so any row that is
// in view is enough. The window paints graphics over exactly those cells; the labels
// and details stay terminal text. A marked region keeps a blank cell on each side,
// which the graphics may bleed into.
export const BLOCK_MARK = 7717;
const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
let charts = 0;

function textBar(fraction, width) {
  const eighths = Math.round(Math.max(0, Math.min(1, fraction)) * width * 8);
  return "█".repeat(Math.floor(eighths / 8)) + EIGHTHS[eighths % 8];
}

function inline(value) {
  return sanitizeTerminalText(String(value ?? "")).replace(/\s+/gu, " ").trim();
}

export class SeasonsChart {
  constructor(seasons, { getTheme, tr, environment = process.env }) {
    this.seasons = seasons.filter((season) => /^\d{4}-Q[1-4]$/u.test(season?.key ?? "")).slice(-12);
    this.getTheme = getTheme;
    this.tr = tr;
    this.marked = environment.MOONDOG_HOST === "app";
    this.id = `seasons-${(charts += 1)}`;
  }

  invalidate() {}

  render(width) {
    const theme = this.getTheme();
    const tr = this.tr;
    const minutes = this.seasons.map((season) => (Number.isFinite(season.listening_minutes) ? season.listening_minutes : 0));
    const most = Math.max(1, ...minutes);
    const details = this.seasons.map((season) => {
      if (!Number.isInteger(season.event_count) || season.event_count === 0) return tr("nothing in your history");
      const artist = inline(season.leading_artist?.name);
      return [
        formatListeningTime(season.listening_minutes, tr),
        season.first_observed_tracks > 0 ? tr("{count} new", { count: tr.number(season.first_observed_tracks) }) : null,
        artist || null,
      ].filter(Boolean).join(" · ");
    });
    const detailWidth = Math.min(28, Math.max(...details.map((detail) => visibleWidth(detail))));
    // " 2024 Q3  bars  details": the bars take what the label and a short detail leave.
    const barWidth = Math.max(8, Math.min(30, width - 1 - 7 - 2 - 2 - detailWidth));
    const payload = btoa(JSON.stringify({
      kind: "seasons",
      rows: this.seasons.map((season, row) => ({
        quarter: Number(season.key.slice(-1)),
        minutes: minutes[row],
        fraction: minutes[row] / most,
        newSongs: Number.isInteger(season.first_observed_tracks) ? season.first_observed_tracks : 0,
        empty: !(season.event_count > 0),
      })),
      colors: {
        ink: theme.palette.foreground,
        muted: theme.palette.muted,
        faint: theme.palette.faint,
        paper: theme.palette.background,
      },
    }));
    return this.seasons.map((season, row) => {
      const [year, quarter] = season.key.split("-");
      // The year shows where it changes, so the column reads as a calendar.
      const label = row === 0 || quarter === "Q1" ? `${year} ${quarter}` : `     ${quarter}`;
      const bar = minutes[row] > 0 ? textBar(minutes[row] / most, barWidth) : "·";
      const mark = this.marked ? `\x1b]${BLOCK_MARK};${this.id};${row};${barWidth};${payload}\x07` : "";
      const line = ` ${theme.muted(label)}  ${mark}${theme.text(bar)}${" ".repeat(Math.max(0, barWidth - visibleWidth(bar)))}  ${theme.muted(details[row])}`;
      return truncateToWidth(line, width, "");
    });
  }
}
