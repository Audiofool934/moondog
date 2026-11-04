// The listener's history pressed as a record, at the top of the taste page. The groove is one spiral from the
// rim to the label, a turn a unit of time: a year, a quarter, a month or a week, whichever gives between four
// and fourteen turns, so a short history is a small single and a long one an album. Its dots darken with the
// plays of each stretch of the turn. The arm is the needle in time: it rests on now, the wheel scratches back
// through the years as the record turns, a click drops the needle on a groove, and the arm drags. A double-click,
// a pinch or Enter opens one turn as its own record, and the trail above goes back out. Beside it, the liner
// notes follow the turn under the needle: its plays, its song, and who moved across the range, read within the
// range only. A name lights that artist's plays across the whole record. Moondog's own picks show hollow, apart.
import { make } from "./ui.mjs";

const DAY = 86_400_000;
const TAU = Math.PI * 2;
const PITCH = 2; // between dot centres, in CSS pixels, as the record above the words
const RIM = 0.95, LABEL_MIN = 0.27, BAND_MAX = 0.078;
// The arm's base at the top right corner of the square about the disc, long enough to reach the label.
const PIVOT = [1, -1], ARM = 1.16;
const UNIT_ORDER = ["year", "quarter", "month", "week"];
// Stretches of time along one turn, never shorter than a day.
const BINS_BY_UNIT = { year: 52, quarter: 46, month: 31, week: 7 };
const PRESETS = [["tasteLast12", 365], ["tasteLast3", 91]];
const NOW_DAYS = 28;
const reduced = matchMedia("(prefers-reduced-motion: reduce)");

const ymd = (ts) => { const d = new Date(ts); return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()]; };
const dayOf = (text) => { const [y, m, d] = text.split("-").map(Number); return Date.UTC(y, m - 1, d); };
const UNITS = {
  year: { floor: (t) => Date.UTC(ymd(t)[0], 0, 1), next: (t) => Date.UTC(ymd(t)[0] + 1, 0, 1) },
  quarter: { floor: (t) => { const [y, m] = ymd(t); return Date.UTC(y, m - m % 3, 1); }, next: (t) => { const [y, m] = ymd(t); return Date.UTC(y, m - m % 3 + 3, 1); } },
  month: { floor: (t) => { const [y, m] = ymd(t); return Date.UTC(y, m, 1); }, next: (t) => { const [y, m] = ymd(t); return Date.UTC(y, m + 1, 1); } },
  week: { floor: (t) => t - ((new Date(t).getUTCDay() + 6) % 7) * DAY, next: (t) => t - ((new Date(t).getUTCDay() + 6) % 7) * DAY + 7 * DAY },
};
function turnsOf(unit, from, to) {
  const turns = [];
  for (let at = UNITS[unit].floor(from); at < to; at = UNITS[unit].next(at)) turns.push({ start: at, end: UNITS[unit].next(at) });
  return turns;
}
// The unit whose turns come closest to ten, within four to fourteen.
function fit(from, to) {
  const fits = UNIT_ORDER.map((unit) => [unit, turnsOf(unit, from, to).length]).filter(([, n]) => n >= 4 && n <= 14);
  if (fits.length) return fits.sort((a, b) => Math.abs(a[1] - 10) - Math.abs(b[1] - 10))[0][0];
  return turnsOf("year", from, to).length > 14 ? "year" : "week";
}
const insidePolygon = (x, y, points) => {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const [xi, yi] = points[i], [xj, yj] = points[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const nearLine = (x, y, points, reach) => {
  for (let i = 1; i < points.length; i += 1) {
    const [ax, ay] = points[i - 1], [bx, by] = points[i], dx = bx - ax, dy = by - ay;
    const k = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
    if (Math.hypot(x - ax - dx * k, y - ay - dy * k) <= reach) return true;
  }
  return false;
};

export function createPressing({ t, locale }) {
  const say = (key, params) => t()(key, params);
  const root = make("section", "pressing");
  const deck = make("div", "pressing-deck");
  const range = make("div", "pressing-range");
  const crumbs = make("nav", "pressing-crumbs");
  const presets = make("div", "pressing-presets");
  range.append(crumbs, presets);
  const platter = make("div", "pressing-platter");
  const canvas = make("canvas");
  canvas.tabIndex = 0;
  const label = make("div", "pressing-label");
  platter.append(canvas, label);
  const readout = make("div", "pressing-readout");
  const hint = make("p", "pressing-hint");
  deck.append(range, platter, readout, hint);
  const notesRoot = make("aside", "pressing-notes");
  root.append(deck, notesRoot);
  const ctx = canvas.getContext("2d");

  // The history, as days from its first: everyone's plays, each top artist's, and Moondog's own.
  let history = null, START = 0, END = 0, DAYS = 0, total = null, picksByDay = null, artists = [], songs = new Map(), stances = new Map();
  let shown = null, stack = [], BINS = 52, INNER = LABEL_MIN, BAND = 0;
  let R = 0, cx = 0, cy = 0, dpr = 1, dots = new Float32Array(0), width = 0;
  let T = 1, target = 1, raf = 0, focus = null, pinned = null, picks = false, hover = null, dragging = false, shownTurn = null, pinchAt = 0;
  const lang = () => locale() ?? "en";
  const date = (ts, options) => new Intl.DateTimeFormat(lang(), { timeZone: "UTC", ...options }).format(ts);
  const number = (n) => Math.round(n).toLocaleString(lang());
  const playsText = (n) => (Math.round(n) === 1 ? say("tastePlay") : say("tastePlays", { count: number(n) }));
  const ink = () => getComputedStyle(document.documentElement).getPropertyValue("--ink-rgb").trim().split(/\s+/).map(Number);

  function load(data) {
    history = data;
    START = dayOf(data.first_day);
    END = dayOf(data.last_day) + DAY;
    DAYS = Math.round((END - START) / DAY);
    const series = (pairs) => { const out = new Float32Array(DAYS); for (const [day, plays] of pairs ?? []) { const d = Math.round((dayOf(day) - START) / DAY); if (d >= 0 && d < DAYS) out[d] = plays; } return out; };
    total = series(data.days);
    picksByDay = series(data.moondog_days);
    artists = (data.artists ?? []).map((artist) => ({ name: artist.name, days: series(artist.days) }));
    stack = [];
    focus = pinned = null;
    setRange(press(START, END));
  }
  const recentEnough = () => Date.now() - END < NOW_DAYS * DAY;
  // Presses a range: its turns and, for each turn, the plays in each stretch of it.
  function press(from, to, name = null) {
    from = Math.max(from, START); to = Math.min(to, END);
    const unit = fit(from, to), turns = turnsOf(unit, from, to), N = turns.length, bins = BINS_BY_UNIT[unit];
    const grid = () => turns.map(() => new Float32Array(bins));
    const all = grid(), picked = grid(), by = artists.map(grid);
    let k = 0;
    for (let d = Math.max(0, Math.floor((from - START) / DAY)); d < Math.min(DAYS, Math.ceil((to - START) / DAY)); d += 1) {
      const ts = START + d * DAY;
      while (k < N - 1 && ts >= turns[k].end) k += 1;
      if (ts < turns[k].start || ts >= turns[k].end) continue;
      const b = Math.min(bins - 1, Math.floor((ts - turns[k].start) / (turns[k].end - turns[k].start) * bins));
      all[k][b] += total[d]; picked[k][b] += picksByDay[d];
      artists.forEach((artist, a) => { by[a][k][b] += artist.days[d]; });
    }
    const loud = (rows) => { const v = rows.flatMap((row) => [...row]).filter(Boolean).sort((x, y) => x - y); return v[Math.floor(v.length * 0.96)] || 1; };
    const position = (ts) => { const j = turns.findIndex((turn) => ts >= turn.start && ts < turn.end); return j < 0 ? (ts < from ? 0 : 1) : (j + (ts - turns[j].start) / (turns[j].end - turns[j].start)) / N; };
    return { from, to, unit, turns, N, bins, name, all, picked, by, loud: loud(all), loudBy: by.map(loud), position,
      first: position(from), last: Math.min(1, position(to - 1) + 0.5 / (bins * N)) };
  }
  // A range's name: its span, or the turn it was opened from.
  function rangeName(r) {
    if (r.name) return r.name;
    const [fy] = ymd(r.from), [ly] = ymd(r.to - 1);
    if (r.unit === "year") return fy === ly ? String(fy) : `${fy} – ${ly}`;
    return `${date(r.from, { month: "short", year: "numeric" })} – ${date(r.to - 1, { month: "short", year: "numeric" })}`;
  }
  function turnName(unit, start) {
    if (unit === "year") return String(ymd(start)[0]);
    if (unit === "quarter") return `${date(start, { month: "short" })} – ${date(UNITS.quarter.next(start) - DAY, { month: "short", year: "numeric" })}`;
    if (unit === "month") return date(start, { month: "long", year: "numeric" });
    return say("tasteWeekOf", { date: date(start, { day: "numeric", month: "short", year: "numeric" }) });
  }

  function setRange(next, at = null) {
    shown = next;
    BINS = shown.bins;
    // Few turns press a narrower band and leave a wider label, as a single has.
    INNER = Math.max(LABEL_MIN, RIM - shown.N * BAND_MAX);
    BAND = (RIM - INNER) / shown.N;
    T = target = Math.max(shown.first, Math.min(shown.last, shown.position(at ?? END - DAY)));
    shownTurn = null;
    renderRange(); renderLabel(); draw(); notes(true); describe(stylusAt(), false);
  }
  // Opening a turn, or going back out, presses the record again: it fades out and comes back pressed anew.
  function repress(change) {
    if (reduced.matches) { change(); return; }
    canvas.classList.add("pressing-out");
    setTimeout(() => { change(); requestAnimationFrame(() => canvas.classList.remove("pressing-out")); }, 150);
  }
  const timeAt = (t) => { const x = Math.max(0, Math.min(shown.N - 1e-9, t * shown.N)), k = Math.floor(x), turn = shown.turns[k]; return turn.start + (x - k) * (turn.end - turn.start); };
  function open(k, at) {
    const turn = shown.turns[k];
    if (!turn || shown.unit === "week") return;
    const inner = press(turn.start, turn.end, turnName(shown.unit, turn.start));
    if (inner.N < 2) return;
    repress(() => { stack.push(shown); setRange(inner, at); });
  }
  function back(to = stack.length - 1) {
    if (to < 0 || to >= stack.length) return false;
    const at = timeAt(T);
    repress(() => { const outer = stack[to]; stack = stack.slice(0, to); setRange(outer, at); });
    return true;
  }

  function layout() {
    const next = Math.min(deck.clientWidth, 560);
    if (!next || next === width) return;
    width = next;
    R = Math.floor(width / 2.32);
    const w = Math.round(R * 2.32), h = Math.round(R * 2.3);
    dpr = devicePixelRatio || 1;
    canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    cx = R * 1.1; cy = R * 1.18;
    const list = [];
    for (let y = -R; y <= R; y += PITCH) for (let x = -R; x <= R; x += PITCH) {
      const r = Math.hypot(x, y) / R;
      if (r <= 0.985) list.push(x, y, r, Math.atan2(x, -y));
    }
    dots = Float32Array.from(list);
    renderLabel();
    draw();
  }
  // Laid out on the next frame, so resizing the canvas never re-enters the observer that asked for it.
  let laying = 0;
  new ResizeObserver(() => { cancelAnimationFrame(laying); laying = requestAnimationFrame(layout); }).observe(deck);
  function renderLabel() {
    if (!shown || !R) return;
    label.style.left = `${cx}px`; label.style.top = `${cy}px`;
    label.replaceChildren(make("strong", "", rangeName(shown)),
      make("span", "", `${say("tasteTurns", { count: shown.N })} · ${say(`tasteEach.${shown.unit}`)}`));
    label.hidden = INNER * R < 46;
  }

  // The arm swings about its base; its stylus meets the groove where a circle about the base crosses it, on
  // the side that hangs down the record's right early in the history and leans in toward now.
  function stylusPoint(r) {
    const [px, py] = PIVOT, d = Math.hypot(px, py);
    const a = (d * d + r * r - ARM * ARM) / (2 * d), h = Math.sqrt(Math.max(0, r * r - a * a));
    return [px * a / d - h * py / d, py * a / d + h * px / d];
  }
  const radiusAt = (t) => RIM - (RIM - INNER) * t;
  // Time runs counter-clockwise on the record, so the record turns clockwise as time goes on, as a record does.
  const turnAt = (t) => { const [sx, sy] = stylusPoint(radiusAt(t)); return Math.atan2(sx, -sy) + (t * shown.N % 1) * TAU; };
  function binAt(r, angle, turn) {
    const along = (((turn - angle) / TAU) % 1 + 1) % 1;
    const u = (RIM - r) / BAND - along;
    const k = Math.round(u);
    if (k < 0 || k >= shown.N) return null;
    const t = (k + along) / shown.N;
    if (t < shown.first || t > shown.last) return null;
    return { k, b: Math.min(BINS - 1, Math.floor(along * BINS)), off: Math.abs(u - k), t };
  }
  const focusIndex = () => artists.findIndex((artist) => artist.name === focus);

  function draw() {
    if (!shown || !R) return;
    const [ir, ig, ib] = ink();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const turn = turnAt(T), here = Math.min(shown.N - 1, Math.floor(T * shown.N)), a = focusIndex();
    const LEVELS = 14, paths = Array.from({ length: LEVELS }, () => new Path2D()), hollow = new Path2D();
    const half = Math.min(0.36, 0.022 / BAND); // a wide band keeps a groove no wider than an album's
    for (let i = 0; i < dots.length; i += 4) {
      const x = dots[i], y = dots[i + 1], r = dots[i + 2], angle = dots[i + 3];
      let level;
      if (r < INNER - BAND * 0.6) level = r < 0.018 ? 0.9 : 0.02; // the label, and its spindle
      else {
        const at = binAt(r, angle, turn);
        if (!at || at.off > half) level = 0.045; // the land between grooves
        else {
          const v = Math.min(1, Math.max(0, a >= 0 ? shown.by[a][at.k][at.b] / shown.loudBy[a] : shown.all[at.k][at.b] / shown.loud));
          level = a >= 0 ? (v > 0.02 ? 0.22 + 0.74 * v ** 0.6 : 0.06) : 0.11 + 0.8 * v ** 0.75;
          if (a < 0 && at.k === here) level += 0.06;
          level *= 1 - (at.off / half) ** 2 * 0.55;
          if (picks && shown.picked[at.k][at.b] > 0) {
            if (at.off < half * 0.4 && ((x + y) / PITCH) % 4 === 0) { hollow.moveTo(cx + x + 1.3, cy + y); hollow.arc(cx + x, cy + y, 1.3, 0, TAU); }
            level *= 0.35;
          }
        }
      }
      const step = Math.max(0, Math.min(LEVELS - 1, Math.round(level * (LEVELS - 1))));
      if (!step) continue;
      const size = 0.7 + 0.8 * (step / (LEVELS - 1));
      paths[step].rect(cx + x - size / 2, cy + y - size / 2, size, size);
    }
    paths.forEach((path, step) => { if (step) { ctx.fillStyle = `rgb(${ir} ${ig} ${ib} / ${(step / (LEVELS - 1)).toFixed(3)})`; ctx.fill(path); } });
    if (picks) { ctx.strokeStyle = `rgb(${ir} ${ig} ${ib} / 0.7)`; ctx.lineWidth = 0.7; ctx.stroke(hollow); }
    drawArm(ir, ig, ib);
  }
  // The tonearm, pressed into the record's own grid of dots: a base, a counterweight behind it, a tube that bows a
  // little, and a headshell, as the record above the words has. As the record keeps a clear halo about its dog,
  // the arm keeps one about itself, so it reads as resting on the grooves.
  function drawArm(ir, ig, ib) {
    const [sx, sy] = stylusPoint(radiusAt(T)), [px, py] = PIVOT;
    const P = [cx + px * R, cy + py * R], S = [cx + sx * R, cy + sy * R];
    const L = Math.hypot(S[0] - P[0], S[1] - P[1]) / R;
    const ex = (S[0] - P[0]) / (L * R), ey = (S[1] - P[1]) / (L * R);
    const at = ([u, v]) => [P[0] + (ex * u - ey * v) * R, P[1] + (ey * u + ex * v) * R];
    const tube = Array.from({ length: 17 }, (_, i) => { const f = i / 16; return at([-0.11 + (L - 0.04) * f, 0.03 * Math.sin(Math.PI * Math.max(0, (f * (L - 0.04) - 0.11) / (L - 0.15)))]); });
    const head = [[L - 0.16, -0.024], [L - 0.003, -0.031], [L + 0.011, 0.02], [L - 0.16, 0.024]].map(at);
    const lift = [[L - 0.055, 0.024], [L - 0.047, 0.046]].map(at);
    const weight = [[-0.125, -0.03], [-0.055, -0.03], [-0.055, 0.03], [-0.125, 0.03]].map(at);
    const lit = dragging || hover === "arm";
    const hub = 0.042 * R, bore = 0.012 * R, reach = (lit ? 0.01 : 0.0075) * R, CLEAR = 3;
    const all = [...tube, ...head, ...lift, ...weight, [P[0] - hub, P[1] - hub], [P[0] + hub, P[1] + hub]];
    const xs = all.map(([x]) => x), ys = all.map(([, y]) => y);
    const x0 = cx + Math.floor((Math.min(...xs) - 4 - cx) / PITCH) * PITCH, y0 = cy + Math.floor((Math.min(...ys) - 4 - cy) / PITCH) * PITCH;
    const x1 = Math.max(...xs) + 4, y1 = Math.max(...ys) + 4;
    const solid = new Path2D(), soft = new Path2D(), halo = new Path2D(), closed = [...head, head[0]];
    for (let y = y0; y <= y1; y += PITCH) for (let x = x0; x <= x1; x += PITCH) {
      const d = Math.hypot(x - P[0], y - P[1]);
      if (d <= hub && d > bore) { soft.rect(x - 0.75, y - 0.75, 1.5, 1.5); continue; }
      if (insidePolygon(x, y, head) || insidePolygon(x, y, weight) || nearLine(x, y, tube, reach) || nearLine(x, y, lift, 0.006 * R)) { solid.rect(x - 0.75, y - 0.75, 1.5, 1.5); continue; }
      if (d <= hub + CLEAR || nearLine(x, y, tube, reach + CLEAR) || nearLine(x, y, closed, CLEAR) || nearLine(x, y, lift, 0.006 * R + CLEAR)) halo.rect(x - PITCH / 2, y - PITCH / 2, PITCH, PITCH);
    }
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = "#000";
    ctx.fill(halo);
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = `rgb(${ir} ${ig} ${ib} / ${lit ? 0.75 : 0.55})`;
    ctx.fill(soft);
    ctx.fillStyle = `rgb(${ir} ${ig} ${ib} / ${lit ? 1 : 0.88})`;
    ctx.fill(solid);
    ctx.beginPath(); ctx.arc(S[0], S[1], 1.4, 0, TAU); ctx.fill();
  }

  // What the stylus, or the pointer over a groove, rests on.
  const binStart = (k, b) => { const turn = shown.turns[k]; return turn.start + (turn.end - turn.start) * b / BINS; };
  const isNow = (k, b) => recentEnough() && binStart(k, b) >= END - NOW_DAYS * DAY;
  function binName(k, b) {
    const ts = binStart(k, b);
    if (shown.unit === "year") return say("tasteWeekOf", { date: date(ts, { day: "numeric", month: "short", year: "numeric" }) });
    if (shown.unit === "week") return date(ts, { weekday: "short", day: "numeric", month: "short" });
    return date(ts, { day: "numeric", month: "short", year: "numeric" });
  }
  function stylusAt() {
    const t = Math.max(shown.first, Math.min(T, shown.last - 1e-9));
    const x = t * shown.N, k = Math.min(shown.N - 1, Math.floor(x));
    return { k, b: Math.min(BINS - 1, Math.floor((x - k) * BINS)), t };
  }
  function describe(at, preview) {
    const plays = shown.all[at.k][at.b], started = shown.picked[at.k][at.b];
    const top = artists.map((artist, a) => [artist, shown.by[a][at.k][at.b]]).sort((x, y) => y[1] - x[1])[0];
    const head = [isNow(at.k, at.b) ? say("tasteNow") : "", binName(at.k, at.b), preview ? say("tasteDropNeedle") : ""].filter(Boolean).join(" · ");
    const sub = [playsText(plays), top && top[1] > 1 ? say("tasteMost", { name: top[0].name }) : "", picks && started ? say("tasteStarted", { count: number(started) }) : ""].filter(Boolean).join(" · ");
    readout.replaceChildren(make("strong", "", head), make("span", "", sub));
  }

  // The trail above the record, and the shortcuts to a recent stretch beside it.
  function renderRange() {
    const trail = [...stack, shown];
    crumbs.replaceChildren(...trail.flatMap((each, index) => {
      const button = make("button", "", index === 0 && !each.preset ? say("tastePressAll") : rangeName(each));
      button.type = "button";
      const current = index === trail.length - 1;
      button.setAttribute("aria-current", String(current));
      if (!current) button.addEventListener("click", () => back(index));
      return index ? [make("span", "chev", "›"), button] : [button];
    }));
    presets.replaceChildren(...PRESETS.filter(([, days]) => END - START > days * DAY * 1.2).map(([key, days]) => {
      const name = say(key);
      const button = make("button", "", name);
      button.type = "button";
      button.setAttribute("aria-pressed", String(shown.name === name));
      button.addEventListener("click", () => {
        if (shown.name === name) { back(0); return; }
        const at = timeAt(T), whole = stack[0] ?? shown;
        const next = Object.assign(press(END - days * DAY, END, name), { preset: true });
        repress(() => { stack = [whole]; setRange(next, at); });
      });
      return button;
    }));
    hint.textContent = say("tastePressHint");
  }

  // The liner notes beside the record follow the turn under the stylus.
  const turnPlays = (a, k) => shown.by[a][k].reduce((x, y) => x + y, 0);
  const long = () => shown.to - shown.from >= 700 * DAY;
  // Movement within this range only. Under two years a season can look like a change, so a short range only
  // says more or less lately.
  function movement(a) {
    const series = shown.turns.map((_, k) => turnPlays(a, k));
    const sum = series.reduce((x, y) => x + y, 0);
    if (!sum) return "";
    if (Math.max(...series) > sum * 0.6 && shown.N > 3) return say("tasteBurst");
    const lit = series.map((v) => v > sum * 0.02);
    const firstLit = lit.indexOf(true), lastLit = lit.lastIndexOf(true);
    for (let k = firstLit, gap = 0; k <= lastLit; k += 1) { gap = lit[k] ? 0 : gap + 1; if (gap >= 2 && lit.slice(k).some(Boolean)) return say(long() ? "tasteReturning" : "tasteOnOff"); }
    const third = Math.max(1, Math.floor(shown.N / 3));
    const early = series.slice(0, third).reduce((x, y) => x + y, 0) / third, late = series.slice(-third).reduce((x, y) => x + y, 0) / third;
    if (late >= early * 1.6) return say(long() ? "tasteRising" : "tasteMoreLately");
    if (late <= early * 0.4) return say(long() ? "tasteFading" : "tasteLessLately");
    return say("tasteSteady");
  }
  function thread(a, k) {
    // Drawn at the notes' own width, so its dots stay round.
    const c = make("canvas"), w = Math.max(160, (notesRoot.clientWidth || 300) - 16), h = 14;
    c.width = w * dpr; c.height = h * dpr; c.style.width = `${w}px`; c.style.height = `${h}px`;
    const g = c.getContext("2d"); g.scale(dpr, dpr);
    const [ir, ig, ib] = ink();
    const series = shown.turns.map((_, j) => turnPlays(a, j)), peak = Math.max(...series) || 1, step = w / shown.N;
    series.forEach((plays, j) => {
      const v = plays / peak;
      g.fillStyle = `rgb(${ir} ${ig} ${ib} / ${j === k ? 0.95 : plays > 0.5 ? 0.35 + 0.4 * v : 0.12})`;
      g.beginPath(); g.arc(step * j + step / 2, h / 2, (plays > 0.5 ? 2 + 6 * Math.sqrt(v) : 1.6) / 2, 0, TAU); g.fill();
    });
    return c;
  }
  function notes(force = false) {
    if (!shown) return;
    const { k, b } = stylusAt();
    const now = isNow(k, b);
    const key = now ? "now" : k;
    if (key === shownTurn && !force) return;
    shownTurn = key;
    const nodes = [];
    const turn = shown.turns[k];
    const plays = shown.all[k].reduce((x, y) => x + y, 0);
    if (now) {
      let lately = 0;
      for (let d = Math.max(0, DAYS - NOW_DAYS); d < DAYS; d += 1) lately += total[d];
      nodes.push(make("div", "era", say("tasteNow")), make("p", "era-sub", say("tasteLastFour", { plays: playsText(lately) })));
    } else {
      nodes.push(make("div", "era", turnName(shown.unit, turn.start)), make("p", "era-sub", playsText(plays)));
    }
    const song = shown.unit === "year" && !now ? songs.get(ymd(turn.start)[0]) : null;
    if (song) {
      const line = make("p", "song", song.title);
      line.append(make("span", "", song.artist));
      nodes.push(make("p", "label", say("tasteSongOfYear")), line, make("p", "caption", say("tasteSongNote")));
    } else if (!now) {
      const top = artists.map((_, a) => [a, turnPlays(a, k)]).sort((x, y) => y[1] - x[1])[0];
      if (top && top[1] > 1) {
        const line = make("p", "song", artists[top[0]].name);
        line.append(make("span", "", playsText(top[1])));
        nodes.push(make("p", "label", say("tasteMostPlayed")), line);
      }
    }
    nodes.push(make("p", "label", now ? say("tasteLately") : say("tasteWhoMoved", { range: rangeName(shown) })));
    const list = make("ul", "people");
    const people = artists.map((artist, a) => ({ artist, a, here: turnPlays(a, k), all: shown.turns.reduce((s, _, j) => s + turnPlays(a, j), 0) }))
      .filter((p) => p.all > 3).sort((x, y) => y.here - x.here || y.all - x.all).slice(0, 5);
    for (const { artist, a } of people) {
      const row = make("li", `person${focus === artist.name ? " on" : ""}`);
      const stance = stances.get(artist.name.normalize("NFKC").toLocaleLowerCase());
      row.append(make("strong", "", artist.name),
        make("em", "", [movement(a), stance === "like" ? say("tasteLiked") : stance === "avoid" ? say("tasteKeptOut") : ""].filter(Boolean).join(" · ")),
        thread(a, k));
      row.addEventListener("mouseenter", () => setFocus(artist.name));
      row.addEventListener("mouseleave", () => setFocus(pinned));
      row.addEventListener("click", () => { pinned = pinned === artist.name ? null : artist.name; setFocus(pinned); });
      list.append(row);
    }
    nodes.push(list, make("p", "caption", now ? say("tasteNowNote") : long() ? say("tasteLongNote") : say("tasteShortNote")));
    if (history.moondog_days?.length) {
      const toggle = make("button", "toggle", say("tastePicks"));
      toggle.type = "button";
      toggle.setAttribute("aria-pressed", String(picks));
      toggle.addEventListener("click", () => { picks = !picks; draw(); notes(true); describe(stylusAt(), false); });
      nodes.push(toggle);
      if (picks) nodes.push(make("p", "caption", say("tastePicksNote")));
    }
    notesRoot.replaceChildren(...nodes);
  }
  function setFocus(name) {
    focus = name ?? null;
    for (const row of notesRoot.querySelectorAll(".person")) row.classList.toggle("on", row.querySelector("strong").textContent === focus);
    draw();
  }

  // Motion: the needle eases toward its target, so a needle drop spins the record there and the arm swings in.
  function moveTo(t, instant = false) {
    target = Math.max(shown.first, Math.min(shown.last, t));
    if (instant || reduced.matches) { T = target; frame(); return; }
    if (!raf) raf = requestAnimationFrame(tick);
  }
  function tick() {
    raf = 0;
    const gap = target - T;
    T = Math.abs(gap) < 1e-5 ? target : T + gap * 0.16;
    frame();
    if (T !== target) raf = requestAnimationFrame(tick);
  }
  function frame() { draw(); if (hover !== "groove" || dragging) describe(stylusAt(), false); notes(); }

  // Hands: the wheel scratches, a pinch opens a turn or goes back out, a click drops the needle, a double-click
  // opens the turn under it, the arm drags, the keys step.
  const local = (event) => { const box = canvas.getBoundingClientRect(); return [(event.clientX - box.left - cx) / R, (event.clientY - box.top - cy) / R]; };
  function nearArm([x, y]) {
    const [px, py] = PIVOT, [sx, sy] = stylusPoint(radiusAt(T));
    const dx = sx - px, dy = sy - py, l = dx * dx + dy * dy;
    const k = Math.max(0, Math.min(1, ((x - px) * dx + (y - py) * dy) / l));
    return Math.hypot(x - (px + dx * k), y - (py + dy * k)) * R < 14;
  }
  const grooveAt = (p) => { const r = Math.hypot(...p); return r <= RIM + BAND / 2 && r >= INNER - BAND / 2 ? binAt(r, Math.atan2(p[0], -p[1]), turnAt(T)) : null; };
  canvas.addEventListener("wheel", (event) => {
    if (!shown) return;
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      if (Date.now() - pinchAt < 450 || Math.abs(event.deltaY) < 2) return;
      pinchAt = Date.now();
      if (event.deltaY < 0) open(stylusAt().k, timeAt(T)); else back();
      return;
    }
    // A slow wheel moves finely; a quick one covers more, as the record's own scratch does.
    const speed = Math.min(6, 1 + Math.abs(event.deltaY) / 40);
    moveTo(target + event.deltaY * speed / (BINS * shown.N * 40));
  }, { passive: false });
  canvas.addEventListener("pointerdown", (event) => {
    if (!shown) return;
    const p = local(event);
    if (nearArm(p)) { dragging = true; canvas.setPointerCapture(event.pointerId); canvas.classList.add("dragging"); draw(); return; }
    const at = grooveAt(p);
    if (at) moveTo(at.t);
  });
  canvas.addEventListener("dblclick", (event) => { if (!shown) return; const at = grooveAt(local(event)); if (at) open(at.k, binStart(at.k, at.b)); });
  canvas.addEventListener("pointermove", (event) => {
    if (!shown) return;
    const p = local(event);
    if (dragging) { moveTo((RIM - Math.hypot(...p)) / (RIM - INNER), true); return; }
    const arm = nearArm(p), at = arm ? null : grooveAt(p), was = hover;
    hover = arm ? "arm" : at ? "groove" : null;
    canvas.classList.toggle("grab", hover !== null);
    if (at && at.off < 0.5) describe(at, true); else describe(stylusAt(), false);
    if (was !== hover && (was === "arm" || hover === "arm")) draw();
  });
  canvas.addEventListener("pointerleave", () => { if (!shown) return; hover = null; if (!dragging) { describe(stylusAt(), false); draw(); } });
  const release = () => { if (!dragging) return; dragging = false; canvas.classList.remove("dragging"); draw(); };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);
  canvas.addEventListener("keydown", (event) => {
    if (!shown) return;
    const bin = 1 / (BINS * shown.N), turn = 1 / shown.N;
    const by = { ArrowRight: bin, ArrowLeft: -bin, ArrowDown: bin, ArrowUp: -bin, PageDown: turn, PageUp: -turn }[event.key];
    if (by) { event.preventDefault(); moveTo(target + by); }
    if (event.key === "End") { event.preventDefault(); moveTo(shown.last); }
    if (event.key === "Home") { event.preventDefault(); moveTo(shown.first); }
    if (event.key === "Enter") { event.preventDefault(); open(stylusAt().k, timeAt(T)); }
    // Escape goes back out of an opened turn first; at the whole record it closes the page as elsewhere.
    if (event.key === "Escape" && stack.length) { event.preventDefault(); back(); }
  });
  // The theme can change under an open page; the record's ink follows it.
  const redraw = () => { draw(); notes(true); };
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", redraw);
  new MutationObserver(redraw).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });

  return {
    node: root,
    // A new page from the core: the record is pressed again only when the history itself changed.
    update(data, subjects = []) {
      stances = new Map(subjects.filter((subject) => subject.kind === "artist" && subject.stance)
        .map((subject) => [subject.label.normalize("NFKC").toLocaleLowerCase(), subject.stance]));
      songs = new Map((data?.songs ?? []).map((song) => [song.year, song]));
      const next = data?.history ?? null;
      root.hidden = !next;
      if (!next) { history = null; shown = null; return; }
      const same = history && JSON.stringify([history.first_day, history.last_day, history.days.length, history.artists?.map((a) => a.plays)])
        === JSON.stringify([next.first_day, next.last_day, next.days.length, next.artists?.map((a) => a.plays)]);
      if (same) { history = next; notes(true); return; }
      layout();
      load(next);
    },
    // A finding that names an artist on the record lights that artist while the pointer rests on it.
    focusFrom(text) {
      if (!history) return;
      const named = artists.find((artist) => text.toLocaleLowerCase().includes(artist.name.toLocaleLowerCase()));
      setFocus(named ? named.name : pinned);
    },
    // An artist held lit from outside, as a row unfolded in the taste view; null lets it go. A name that isn't on
    // the record lights nothing.
    pin(name) {
      const wanted = typeof name === "string" ? name.normalize("NFKC").toLocaleLowerCase() : null;
      const match = wanted ? artists.find((artist) => artist.name.normalize("NFKC").toLocaleLowerCase() === wanted) : null;
      pinned = match ? match.name : null;
      if (history) setFocus(pinned);
    },
    language() { if (shown) { renderRange(); renderLabel(); notes(true); describe(stylusAt(), false); } },
    reset() { stack = []; focus = pinned = null; picks = false; history = null; shown = null; width = 0; },
  };
}
