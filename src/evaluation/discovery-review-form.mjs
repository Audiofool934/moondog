import { computeBlindContentDigest } from "./discovery-human-review.mjs";

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeJsonForHtml(value) {
  return JSON.stringify(value)
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function validatePacketTemplate(packet) {
  if (!isPlainObject(packet)) {
    throw new TypeError("A discovery human review packet is required.");
  }
  if (packet.review_packet_version !== "discovery-human-review/1") {
    throw new TypeError("Unsupported discovery human review packet version.");
  }
  if (packet.privacy?.classification !== "private_local_review") {
    throw new TypeError("The review form can render only a private local packet.");
  }
  if (!Array.isArray(packet.cases) || packet.cases.length === 0) {
    throw new TypeError("The review packet contains no cases.");
  }
  if (packet.blind_content_sha256 !== computeBlindContentDigest(packet)) {
    throw new TypeError("The review packet blind content digest is invalid.");
  }
}

export function renderDiscoveryReviewForm(packet) {
  validatePacketTemplate(packet);
  const packetJson = safeJsonForHtml(packet);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
  <meta name="color-scheme" content="light">
  <title>Moondog Blind Discovery Review</title>
  <style>
    :root {
      --paper: #eee8de;
      --paper-deep: #e2d9cc;
      --card: #f8f4ed;
      --ink: #191918;
      --muted: #68635c;
      --line: #c9bfb2;
      --line-strong: #9e9385;
      --accent: #526b86;
      --accent-soft: #dce5ed;
      --good: #49684f;
      --danger: #8c443e;
      --shadow: 0 18px 50px rgba(38, 32, 26, 0.10);
      font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--ink);
      background: var(--paper);
    }

    * { box-sizing: border-box; }

    html { scroll-behavior: smooth; }

    body {
      margin: 0;
      min-width: 320px;
      background:
        radial-gradient(circle at 10% 0%, rgba(255, 255, 255, 0.62), transparent 34rem),
        linear-gradient(180deg, var(--paper) 0%, #e9e1d6 100%);
    }

    button, input, select, textarea { font: inherit; }

    button, select, input[type="radio"] + label { cursor: pointer; }

    .shell {
      width: min(1180px, calc(100% - 40px));
      margin: 0 auto;
      padding: 42px 0 150px;
    }

    .hero {
      position: relative;
      overflow: hidden;
      min-height: 330px;
      padding: clamp(28px, 6vw, 68px);
      border: 1px solid var(--line-strong);
      border-radius: 30px;
      color: #f5f1ea;
      background: #1d1d1b;
      box-shadow: var(--shadow);
    }

    .hero::before,
    .hero::after {
      position: absolute;
      content: "";
      border-radius: 50%;
      pointer-events: none;
    }

    .hero::before {
      width: 520px;
      height: 520px;
      right: -118px;
      top: -114px;
      border: 1px solid rgba(245, 241, 234, 0.22);
      box-shadow:
        0 0 0 16px rgba(245, 241, 234, 0.035),
        0 0 0 36px rgba(245, 241, 234, 0.025),
        0 0 0 60px rgba(245, 241, 234, 0.02),
        0 0 0 90px rgba(245, 241, 234, 0.016);
    }

    .hero::after {
      width: 12px;
      height: 12px;
      right: 158px;
      top: 138px;
      background: var(--paper);
      box-shadow: 0 0 0 10px rgba(245, 241, 234, 0.12);
    }

    .eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 9px;
      margin: 0 0 28px;
      color: #d6dde5;
      font-size: 12px;
      font-weight: 750;
      letter-spacing: 0.14em;
      text-transform: uppercase;
    }

    .eyebrow::before {
      width: 8px;
      height: 8px;
      content: "";
      border-radius: 50%;
      background: #9bb2c7;
      box-shadow: 0 0 0 6px rgba(155, 178, 199, 0.15);
    }

    h1, h2, h3, p { margin-top: 0; }

    h1 {
      max-width: 760px;
      margin-bottom: 20px;
      font-family: Georgia, "Times New Roman", serif;
      font-size: clamp(42px, 7vw, 78px);
      font-weight: 500;
      letter-spacing: -0.045em;
      line-height: 0.96;
    }

    .hero-copy {
      max-width: 690px;
      margin-bottom: 34px;
      color: #c9c5bd;
      font-size: 17px;
      line-height: 1.6;
    }

    .hero-stats {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      width: min(620px, 100%);
      gap: 1px;
      overflow: hidden;
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.14);
    }

    .stat {
      min-width: 0;
      padding: 14px 16px;
      background: rgba(17, 17, 16, 0.78);
    }

    .stat-label {
      display: block;
      margin-bottom: 6px;
      color: #a9a59e;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }

    .stat-value {
      display: block;
      overflow: hidden;
      color: #f5f1ea;
      font-family: ui-monospace, "SFMono-Regular", Menlo, monospace;
      font-size: 13px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .privacy {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 14px;
      margin: 24px 0 0;
      padding: 18px 20px;
      border: 1px solid #a99d8d;
      border-radius: 16px;
      background: rgba(250, 247, 240, 0.74);
      backdrop-filter: blur(8px);
    }

    .privacy-mark {
      display: grid;
      width: 34px;
      height: 34px;
      place-items: center;
      border-radius: 50%;
      color: #f8f4ed;
      background: var(--ink);
      font-size: 15px;
      font-weight: 800;
    }

    .privacy strong { display: block; margin-bottom: 4px; }

    .privacy p { margin: 0; color: var(--muted); line-height: 1.5; }

    .section {
      margin-top: 26px;
      padding: clamp(22px, 4vw, 38px);
      border: 1px solid var(--line);
      border-radius: 22px;
      background: rgba(248, 244, 237, 0.88);
      box-shadow: 0 8px 30px rgba(42, 35, 29, 0.055);
    }

    .section-heading {
      display: flex;
      align-items: end;
      justify-content: space-between;
      gap: 22px;
      margin-bottom: 24px;
    }

    h2 {
      margin-bottom: 6px;
      font-family: Georgia, "Times New Roman", serif;
      font-size: clamp(28px, 4vw, 42px);
      font-weight: 500;
      letter-spacing: -0.025em;
    }

    .subtle { margin: 0; color: var(--muted); line-height: 1.55; }

    .meta-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 16px;
    }

    .field label,
    .field-label {
      display: block;
      margin-bottom: 8px;
      font-size: 12px;
      font-weight: 750;
      letter-spacing: 0.035em;
    }

    input[type="text"], select, textarea {
      width: 100%;
      border: 1px solid var(--line-strong);
      border-radius: 12px;
      color: var(--ink);
      background: #fffdf8;
      outline: none;
      transition: border-color 140ms ease, box-shadow 140ms ease;
    }

    input[type="text"], select { min-height: 48px; padding: 0 13px; }

    textarea { min-height: 96px; padding: 12px 13px; resize: vertical; line-height: 1.5; }

    input[type="text"]:focus, select:focus, textarea:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(82, 107, 134, 0.16);
    }

    .rubric-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
    }

    .rubric-card {
      min-width: 0;
      padding: 16px;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: #fffdf8;
    }

    .rubric-card strong { display: block; margin-bottom: 8px; }

    .rubric-card p { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.5; }

    .case {
      margin-top: 26px;
      padding: clamp(22px, 4vw, 38px);
      border: 1px solid var(--line-strong);
      border-radius: 24px;
      background: var(--card);
      box-shadow: var(--shadow);
    }

    .case-number {
      margin-bottom: 12px;
      color: var(--accent);
      font-family: ui-monospace, "SFMono-Regular", Menlo, monospace;
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }

    .case h2 { max-width: 850px; margin-bottom: 24px; font-size: clamp(28px, 4vw, 44px); }

    .context-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
      margin-bottom: 18px;
    }

    .context-card {
      min-width: 0;
      padding: 17px;
      border: 1px solid var(--line);
      border-radius: 15px;
      background: #f0e9df;
    }

    .context-card h3 {
      margin-bottom: 10px;
      font-size: 12px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .context-card p { margin: 0; line-height: 1.55; }

    .anchor-groups { display: grid; gap: 13px; }

    .anchor-title {
      margin-bottom: 7px;
      color: var(--muted);
      font-size: 11px;
      font-weight: 750;
      letter-spacing: 0.045em;
      text-transform: uppercase;
    }

    .tags { display: flex; flex-wrap: wrap; gap: 7px; }

    .tag {
      max-width: 100%;
      padding: 6px 9px;
      border: 1px solid #c4b9aa;
      border-radius: 999px;
      background: #faf7f1;
      font-size: 12px;
      line-height: 1.25;
      overflow-wrap: anywhere;
    }

    .boundary {
      margin: 0 0 22px;
      padding-left: 14px;
      border-left: 3px solid var(--accent);
      color: var(--muted);
      font-size: 13px;
      line-height: 1.55;
    }

    .recommendations { display: grid; gap: 18px; }

    .recommendation {
      min-width: 0;
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: 18px;
      background: #fffdf8;
    }

    .track-head {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 15px;
      padding: 22px;
      border-bottom: 1px solid var(--line);
      background: linear-gradient(135deg, rgba(238, 232, 222, 0.72), rgba(255, 253, 248, 0.9));
    }

    .track-index {
      display: grid;
      width: 40px;
      height: 40px;
      place-items: center;
      border-radius: 50%;
      color: #f8f4ed;
      background: var(--ink);
      font-family: Georgia, "Times New Roman", serif;
      font-size: 18px;
    }

    .track-title {
      margin: 0 0 3px;
      font-family: Georgia, "Times New Roman", serif;
      font-size: clamp(23px, 3vw, 31px);
      font-weight: 500;
      letter-spacing: -0.02em;
      overflow-wrap: anywhere;
    }

    .track-meta { margin: 0; color: var(--muted); line-height: 1.45; overflow-wrap: anywhere; }

    .explanation {
      margin: 0;
      padding: 18px 22px;
      border-bottom: 1px solid var(--line);
      color: #4d4943;
      font-size: 14px;
      line-height: 1.6;
    }

    .score-area { display: grid; gap: 18px; padding: 22px; }

    fieldset { min-width: 0; margin: 0; padding: 0; border: 0; }

    legend {
      width: 100%;
      margin-bottom: 10px;
      padding: 0;
      font-size: 14px;
      font-weight: 760;
    }

    .question { display: block; margin-top: 4px; color: var(--muted); font-size: 12px; font-weight: 450; line-height: 1.5; }

    .score-options {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 7px;
    }

    input[type="radio"] {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      opacity: 0;
      pointer-events: none;
    }

    input[type="radio"] + label {
      display: grid;
      min-height: 42px;
      place-items: center;
      border: 1px solid var(--line-strong);
      border-radius: 11px;
      background: #fff;
      font-weight: 760;
      transition: color 120ms ease, background 120ms ease, border-color 120ms ease, transform 120ms ease;
    }

    input[type="radio"]:hover + label { transform: translateY(-1px); }

    input[type="radio"]:focus-visible + label {
      outline: 3px solid rgba(82, 107, 134, 0.30);
      outline-offset: 2px;
    }

    input[type="radio"]:checked + label {
      border-color: var(--ink);
      color: #f8f4ed;
      background: var(--ink);
    }

    .anchors {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
      margin-top: 7px;
      color: var(--muted);
      font-size: 10px;
      line-height: 1.35;
    }

    .anchors span:nth-child(2) { text-align: center; }
    .anchors span:nth-child(3) { text-align: right; }

    .intent-options {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
    }

    .comment { margin-top: 2px; }

    .overall { margin-top: 20px; }

    .action-bar {
      position: fixed;
      z-index: 20;
      left: 50%;
      bottom: 18px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      width: min(920px, calc(100% - 28px));
      gap: 18px;
      align-items: center;
      padding: 15px 16px 15px 20px;
      border: 1px solid #7e7569;
      border-radius: 17px;
      color: #f5f1ea;
      background: rgba(28, 28, 26, 0.96);
      box-shadow: 0 16px 48px rgba(21, 18, 15, 0.28);
      backdrop-filter: blur(14px);
      transform: translateX(-50%);
    }

    .progress-copy { min-width: 0; }

    .progress-line {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 8px;
      font-size: 12px;
    }

    .progress-track {
      overflow: hidden;
      height: 5px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.15);
    }

    .progress-fill {
      width: 0;
      height: 100%;
      border-radius: inherit;
      background: #a8bfd4;
      transition: width 180ms ease;
    }

    .download {
      min-height: 46px;
      padding: 0 18px;
      border: 0;
      border-radius: 12px;
      color: var(--ink);
      background: #f5f1ea;
      font-weight: 780;
      transition: transform 130ms ease, background 130ms ease;
    }

    .download:hover { background: #fff; transform: translateY(-1px); }
    .download:focus-visible { outline: 3px solid #9bb2c7; outline-offset: 3px; }

    .status {
      min-height: 20px;
      margin: 14px 0 0;
      color: var(--good);
      font-size: 13px;
      font-weight: 650;
    }

    .status.error { color: var(--danger); }

    noscript {
      display: block;
      margin: 20px;
      padding: 16px;
      border: 2px solid var(--danger);
      background: white;
    }

    @media (max-width: 820px) {
      .rubric-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .context-grid { grid-template-columns: 1fr; }
    }

    @media (max-width: 620px) {
      .shell { width: min(100% - 20px, 1180px); padding-top: 10px; }
      .hero, .section, .case { border-radius: 18px; }
      .hero { min-height: 0; padding: 28px 22px; }
      .hero::before { opacity: 0.55; right: -310px; }
      .hero-stats, .meta-grid, .rubric-grid { grid-template-columns: 1fr; }
      .section-heading { align-items: start; flex-direction: column; }
      .track-head, .score-area { padding: 18px; }
      .explanation { padding: 16px 18px; }
      .anchors { font-size: 9px; }
      .action-bar { grid-template-columns: 1fr; gap: 12px; }
      .download { width: 100%; }
    }

    @media (prefers-reduced-motion: reduce) {
      html { scroll-behavior: auto; }
      *, *::before, *::after { transition-duration: 0.01ms !important; }
    }
  </style>
</head>
<body>
  <noscript>This private review form requires local JavaScript to render and download the completed JSON file.</noscript>
  <main class="shell">
    <header class="hero">
      <p class="eyebrow">Moondog private evaluation</p>
      <h1>Would you actually listen?</h1>
      <p class="hero-copy">Review each recommendation against the visible taste context. The provider, model, raw history, and tool trace are withheld so your judgment stays blind.</p>
      <div class="hero-stats" aria-label="Review packet summary">
        <div class="stat"><span class="stat-label">Packet</span><span class="stat-value" id="packet-id"></span></div>
        <div class="stat"><span class="stat-label">Cases</span><span class="stat-value" id="case-count"></span></div>
        <div class="stat"><span class="stat-label">Recommendations</span><span class="stat-value" id="recommendation-count"></span></div>
      </div>
    </header>

    <aside class="privacy" aria-label="Privacy boundary">
      <span class="privacy-mark" aria-hidden="true">L</span>
      <div>
        <strong>Private and local</strong>
        <p>This file makes no network requests. It contains personal music context, so keep both the form and downloaded review private. Only the aggregate summary is designed for publication.</p>
      </div>
    </aside>

    <form id="review-form">
      <section class="section" aria-labelledby="reviewer-heading">
        <div class="section-heading">
          <div>
            <h2 id="reviewer-heading">About this review</h2>
            <p class="subtle">Use an opaque label, not a name or email address.</p>
          </div>
        </div>
        <div class="meta-grid">
          <div class="field">
            <label for="reviewer-id">Reviewer ID</label>
            <input id="reviewer-id" name="reviewer_id" type="text" required maxlength="64" pattern="[A-Za-z0-9._-]+" placeholder="judge-01" autocomplete="off" spellcheck="false">
          </div>
          <div class="field">
            <label for="independent">Independent reviewer?</label>
            <select id="independent" name="independent" required>
              <option value="">Choose one</option>
              <option value="true">Yes - I did not build or tune this system</option>
              <option value="false">No - I helped build or tune this system</option>
            </select>
          </div>
        </div>
        <p class="status" id="form-status" role="status" aria-live="polite"></p>
      </section>

      <section class="section" aria-labelledby="rubric-heading">
        <div class="section-heading">
          <div>
            <h2 id="rubric-heading">One rubric, every track</h2>
            <p class="subtle">Scores are integers from 1 to 5. Use the anchors as calibration, not as a formula.</p>
          </div>
        </div>
        <div class="rubric-grid" id="rubric-grid"></div>
      </section>

      <div id="cases"></div>
    </form>
  </main>

  <div class="action-bar" aria-label="Review progress and download">
    <div class="progress-copy">
      <div class="progress-line"><span>Required answers</span><strong id="progress-text">0 / 0</strong></div>
      <div class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0" id="progress-track"><div class="progress-fill" id="progress-fill"></div></div>
    </div>
    <button class="download" id="download-review" type="submit" form="review-form">Download completed review</button>
  </div>

  <script id="review-packet" type="application/json">${packetJson}</script>
  <script>
    'use strict';

    const packet = JSON.parse(document.getElementById('review-packet').textContent);
    const form = document.getElementById('review-form');
    const casesRoot = document.getElementById('cases');
    const rubricRoot = document.getElementById('rubric-grid');
    const statusNode = document.getElementById('form-status');
    const progressText = document.getElementById('progress-text');
    const progressTrack = document.getElementById('progress-track');
    const progressFill = document.getElementById('progress-fill');
    const controlsByRecommendation = new Map();

    function make(tag, className, text) {
      const element = document.createElement(tag);
      if (className) element.className = className;
      if (text !== undefined && text !== null) element.textContent = String(text);
      return element;
    }

    function append(parent, children) {
      for (const child of children) {
        if (child) parent.appendChild(child);
      }
      return parent;
    }

    function addRubric() {
      for (const dimension of packet.methodology.dimensions) {
        const card = make('article', 'rubric-card');
        append(card, [
          make('strong', '', dimension.label),
          make('p', '', dimension.question),
        ]);
        rubricRoot.appendChild(card);
      }
    }

    function anchorGroup(title, items, key, suffixKey) {
      if (!Array.isArray(items) || items.length === 0) return null;
      const group = make('div', 'anchor-group');
      const tags = make('div', 'tags');
      for (const item of items) {
        const suffix = suffixKey && item[suffixKey] ? ' - ' + item[suffixKey] : '';
        tags.appendChild(make('span', 'tag', item[key] + suffix));
      }
      append(group, [make('div', 'anchor-title', title), tags]);
      return group;
    }

    function contextCards(reviewCase) {
      const grid = make('div', 'context-grid');
      const seed = reviewCase.context && reviewCase.context.seed;
      if (seed) {
        const seedCard = make('article', 'context-card');
        append(seedCard, [
          make('h3', '', 'Trusted seed'),
          make('p', '', seed.title + ' - ' + seed.artist_credit + (seed.release ? ' / ' + seed.release : '')),
        ]);
        grid.appendChild(seedCard);
      }
      const profile = reviewCase.context && reviewCase.context.profile_anchors;
      if (profile) {
        const profileCard = make('article', 'context-card');
        profileCard.appendChild(make('h3', '', 'Visible profile anchors'));
        const groups = make('div', 'anchor-groups');
        append(groups, [
          anchorGroup('Strong preferences', profile.strong_preferences, 'label'),
          anchorGroup('Familiarity', profile.familiarity, 'label', 'level'),
          anchorGroup('Artists', profile.artist_facets, 'name'),
          anchorGroup('Genres', profile.genre_facets, 'name'),
        ]);
        profileCard.appendChild(groups);
        grid.appendChild(profileCard);
      }
      return grid.childElementCount > 0 ? grid : null;
    }

    function ratingField(recommendation, dimension, control) {
      const fieldset = make('fieldset', 'rating-field');
      const legend = make('legend');
      append(legend, [
        make('span', '', dimension.label),
        make('span', 'question', dimension.question),
      ]);
      fieldset.appendChild(legend);
      const options = make('div', 'score-options');
      const inputs = [];
      for (let score = 1; score <= 5; score += 1) {
        const id = recommendation.recommendation_id + '-' + dimension.id + '-' + score;
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = recommendation.recommendation_id + '--' + dimension.id;
        input.id = id;
        input.value = String(score);
        input.required = true;
        const label = make('label', '', score);
        label.htmlFor = id;
        append(options, [input, label]);
        inputs.push(input);
      }
      const anchors = make('div', 'anchors');
      append(anchors, [
        make('span', '', '1 - ' + dimension.anchors['1']),
        make('span', '', '3 - ' + dimension.anchors['3']),
        make('span', '', '5 - ' + dimension.anchors['5']),
      ]);
      append(fieldset, [options, anchors]);
      control.ratings.set(dimension.id, inputs);
      return fieldset;
    }

    function intentField(recommendation, control) {
      const fieldset = make('fieldset', 'intent-field');
      const legend = make('legend', '', 'Would you choose to listen?');
      const options = make('div', 'intent-options');
      const inputs = [];
      for (const option of [
        { value: 'no', label: 'No' },
        { value: 'maybe', label: 'Maybe' },
        { value: 'yes', label: 'Yes' },
      ]) {
        const id = recommendation.recommendation_id + '-intent-' + option.value;
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = recommendation.recommendation_id + '--would-listen';
        input.id = id;
        input.value = option.value;
        input.required = true;
        const label = make('label', '', option.label);
        label.htmlFor = id;
        append(options, [input, label]);
        inputs.push(input);
      }
      append(fieldset, [legend, options]);
      control.intent = inputs;
      return fieldset;
    }

    function recommendationCard(recommendation) {
      const card = make('article', 'recommendation');
      card.dataset.recommendationId = recommendation.recommendation_id;
      const head = make('header', 'track-head');
      const identity = make('div');
      append(identity, [
        make('h3', 'track-title', recommendation.title),
        make('p', 'track-meta', recommendation.artist_credit + (recommendation.release ? ' / ' + recommendation.release : '')),
      ]);
      append(head, [make('div', 'track-index', recommendation.position), identity]);
      card.appendChild(head);
      card.appendChild(make('p', 'explanation', recommendation.explanation || 'No explanation was supplied.'));

      const scoreArea = make('div', 'score-area');
      const control = { ratings: new Map(), intent: [], comment: null };
      for (const dimension of packet.methodology.dimensions) {
        scoreArea.appendChild(ratingField(recommendation, dimension, control));
      }
      scoreArea.appendChild(intentField(recommendation, control));
      const commentField = make('div', 'field comment');
      const commentId = recommendation.recommendation_id + '-comment';
      const commentLabel = make('label', '', 'Optional note for this track');
      commentLabel.htmlFor = commentId;
      const textarea = document.createElement('textarea');
      textarea.id = commentId;
      textarea.maxLength = 4000;
      textarea.placeholder = 'What worked, what did not, or which version would be better?';
      append(commentField, [commentLabel, textarea]);
      scoreArea.appendChild(commentField);
      control.comment = textarea;
      controlsByRecommendation.set(recommendation.recommendation_id, control);
      card.appendChild(scoreArea);
      return card;
    }

    function renderCases() {
      packet.cases.forEach((reviewCase, caseIndex) => {
        const section = make('section', 'case');
        section.dataset.caseId = reviewCase.case_id;
        append(section, [
          make('div', 'case-number', 'Case ' + String(caseIndex + 1).padStart(2, '0')),
          make('h2', '', reviewCase.request_summary),
          contextCards(reviewCase),
          make('p', 'boundary', reviewCase.context && reviewCase.context.personal_context_boundary),
        ]);
        const recommendations = make('div', 'recommendations');
        for (const recommendation of reviewCase.recommendations) {
          recommendations.appendChild(recommendationCard(recommendation));
        }
        section.appendChild(recommendations);
        const overall = make('div', 'field overall');
        const overallId = reviewCase.case_id + '-overall';
        const overallLabel = make('label', '', 'Optional overall note for this case');
        overallLabel.htmlFor = overallId;
        const textarea = document.createElement('textarea');
        textarea.id = overallId;
        textarea.dataset.overallCase = reviewCase.case_id;
        textarea.maxLength = 4000;
        textarea.placeholder = 'How did the set work as a whole?';
        append(overall, [overallLabel, textarea]);
        section.appendChild(overall);
        casesRoot.appendChild(section);
      });
    }

    function groupAnswered(inputs) {
      return inputs.some((input) => input.checked);
    }

    function progress() {
      const reviewerAnswered = document.getElementById('reviewer-id').value.trim() ? 1 : 0;
      const independenceAnswered = document.getElementById('independent').value ? 1 : 0;
      let answered = reviewerAnswered + independenceAnswered;
      let total = 2;
      for (const control of controlsByRecommendation.values()) {
        for (const inputs of control.ratings.values()) {
          total += 1;
          if (groupAnswered(inputs)) answered += 1;
        }
        total += 1;
        if (groupAnswered(control.intent)) answered += 1;
      }
      const percentage = total === 0 ? 0 : Math.round((answered / total) * 100);
      progressText.textContent = answered + ' / ' + total;
      progressTrack.setAttribute('aria-valuemax', String(total));
      progressTrack.setAttribute('aria-valuenow', String(answered));
      progressFill.style.width = percentage + '%';
    }

    function selectedValue(inputs) {
      const selected = inputs.find((input) => input.checked);
      return selected ? selected.value : null;
    }

    function completedReview() {
      const output = JSON.parse(JSON.stringify(packet));
      output.reviewer = {
        reviewer_id: document.getElementById('reviewer-id').value.trim(),
        reviewed_at: new Date().toISOString(),
        independent: document.getElementById('independent').value === 'true',
      };
      for (const reviewCase of output.cases) {
        const overall = document.querySelector('[data-overall-case="' + reviewCase.case_id + '"]');
        reviewCase.overall_comment = overall ? overall.value.trim() : '';
        for (const recommendation of reviewCase.recommendations) {
          const control = controlsByRecommendation.get(recommendation.recommendation_id);
          for (const dimension of packet.methodology.dimensions) {
            recommendation.ratings[dimension.id] = Number(
              selectedValue(control.ratings.get(dimension.id)),
            );
          }
          recommendation.would_listen = selectedValue(control.intent);
          recommendation.comment = control.comment.value.trim();
        }
      }
      return output;
    }

    function downloadReview(review) {
      const json = JSON.stringify(review, null, 2) + '\\n';
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'completed-' + review.packet_id + '-' + review.reviewer.reviewer_id + '.json';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    document.getElementById('packet-id').textContent = packet.packet_id;
    document.getElementById('case-count').textContent = String(packet.cases.length);
    document.getElementById('recommendation-count').textContent = String(
      packet.cases.reduce((total, reviewCase) => total + reviewCase.recommendations.length, 0),
    );
    addRubric();
    renderCases();
    progress();

    form.addEventListener('input', progress);
    form.addEventListener('change', progress);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      statusNode.className = 'status';
      statusNode.textContent = '';
      if (!form.reportValidity()) {
        statusNode.className = 'status error';
        statusNode.textContent = 'Complete every required rating and reviewer field before downloading.';
        return;
      }
      const reviewerId = document.getElementById('reviewer-id');
      if (!/^[A-Za-z0-9._-]+$/.test(reviewerId.value.trim())) {
        reviewerId.setCustomValidity('Use only letters, numbers, dots, underscores, or hyphens.');
        reviewerId.reportValidity();
        reviewerId.setCustomValidity('');
        return;
      }
      const review = completedReview();
      downloadReview(review);
      statusNode.textContent = 'Downloaded a private completed review. Validate it with npm run eval:review -- validate.';
    });
  </script>
</body>
</html>
`;
}
