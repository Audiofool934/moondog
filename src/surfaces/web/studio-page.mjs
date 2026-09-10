function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderStudioPage({
  sessionToken,
  nonce,
  maximumArchiveBytes,
  maximumHistoryJsonBytes,
  demoOnly = false,
  archiveSession = false,
  archiveCount = archiveSession ? 1 : 0,
  captureMode = null,
} = {}) {
  if (typeof sessionToken !== "string" || !/^[A-Za-z0-9_-]{32,}$/u.test(sessionToken)) {
    throw new TypeError("Studio session token is invalid.");
  }
  if (typeof nonce !== "string" || !/^[A-Za-z0-9_-]{16,}$/u.test(nonce)) {
    throw new TypeError("Studio CSP nonce is invalid.");
  }
  if (!Number.isSafeInteger(maximumArchiveBytes) || maximumArchiveBytes < 4) {
    throw new TypeError("Studio archive size limit is invalid.");
  }
  if (
    !Number.isSafeInteger(maximumHistoryJsonBytes) ||
    maximumHistoryJsonBytes < 1
  ) {
    throw new TypeError("Studio history JSON size limit is invalid.");
  }
  if (typeof demoOnly !== "boolean") {
    throw new TypeError("Studio demo-only mode is invalid.");
  }
  if (typeof archiveSession !== "boolean" || (demoOnly && archiveSession)) {
    throw new TypeError("Studio archive-session mode is invalid.");
  }
  if (
    !Number.isInteger(archiveCount) ||
    (archiveSession
      ? archiveCount < 1 || archiveCount > 2
      : archiveCount !== 0)
  ) {
    throw new TypeError("Studio archive count is invalid.");
  }
  if (
    !new Set([
      null,
      "hero",
      "time-machine",
      "listening-pulse",
      "listening-seasons",
      "historical-returns",
      "listening-patterns",
      "correction",
    ]).has(captureMode) ||
    (captureMode !== null && !demoOnly)
  ) {
    throw new TypeError("Studio capture mode is invalid.");
  }
  const maximumMegabytes = Math.floor(maximumArchiveBytes / (1024 * 1024));
  const maximumJsonMegabytes = Math.floor(
    maximumHistoryJsonBytes / (1024 * 1024),
  );
  const token = escapeHtml(sessionToken);
  const safeNonce = escapeHtml(nonce);
  const sessionMode = archiveSession
    ? "archive"
    : demoOnly
      ? "demo"
      : "persistent";
  const privateInMemory = archiveSession;
  const importHidden = demoOnly || archiveSession;

  return `<!doctype html>
<html lang="en"${captureMode ? ` data-capture="${captureMode}"` : ""}>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow, noarchive">
  <meta name="referrer" content="no-referrer">
  <meta name="color-scheme" content="light">
  <link rel="icon" href="/brand.png?session=${token}" type="image/png">
  <title>${demoOnly
    ? "Moondog Studio - Fictional Listening Time Machine"
    : privateInMemory
      ? "Moondog Studio - Session-only Spotify History"
      : "Moondog Studio - Private Listening History"}</title>
  <style nonce="${safeNonce}">
    :root {
      --paper: #eee8de;
      --paper-deep: #e2d8ca;
      --card: #f8f4ed;
      --ink: #1b1b19;
      --night: #1b1b19;
      --night-soft: #282825;
      --muted: #6d665d;
      --line: #c8bdaf;
      --line-strong: #94887a;
      --blue: #7897b3;
      --blue-soft: #d8e5ef;
      --green: #4f735f;
      --red: #b4523f;
      --shadow: 0 24px 70px rgba(45, 35, 26, 0.11);
      color: var(--ink);
      background: var(--paper);
      font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    * { box-sizing: border-box; }

    html { min-width: 320px; }

    html[data-capture] { scrollbar-width: none; }

    html[data-capture]::-webkit-scrollbar { display: none; }

    html[data-capture] *,
    html[data-capture] *::before,
    html[data-capture] *::after {
      scroll-behavior: auto !important;
      animation: none !important;
      transition: none !important;
    }

    html[data-capture="correction"] .topbar,
    html[data-capture="correction"] .hero,
    html[data-capture="correction"] .workspace,
    html[data-capture="correction"] .footnote { display: none !important; }

    html[data-capture="correction"] .shell {
      width: min(1180px, calc(100% - 40px));
      padding: 20px 0;
    }

    html[data-capture="correction"] .tuner {
      min-height: 800px;
      margin-top: 0;
    }

    html[data-capture="time-machine"] .topbar,
    html[data-capture="time-machine"] .hero,
    html[data-capture="time-machine"] .workspace,
    html[data-capture="time-machine"] .footnote,
    html[data-capture="time-machine"] .tuner-workbench,
    html[data-capture="time-machine"] .tuner-intro > .section-label,
    html[data-capture="time-machine"] .tuner-intro > h2,
    html[data-capture="time-machine"] .tuner-lede,
    html[data-capture="time-machine"] .demo-start-action,
    html[data-capture="time-machine"] .profile-metrics,
    html[data-capture="time-machine"] .identity-link-coverage,
    html[data-capture="time-machine"] .listening-pulse-preview,
    html[data-capture="time-machine"] .listening-seasons-preview,
    html[data-capture="time-machine"] .historical-returns-preview,
    html[data-capture="time-machine"] .continuity-preview,
    html[data-capture="time-machine"] .listening-patterns-preview,
    html[data-capture="time-machine"] .profile-artifact-links,
    html[data-capture="listening-patterns"] .topbar,
    html[data-capture="listening-patterns"] .hero,
    html[data-capture="listening-patterns"] .workspace,
    html[data-capture="listening-patterns"] .footnote,
    html[data-capture="listening-patterns"] .tuner-workbench,
    html[data-capture="listening-patterns"] .tuner-intro > .section-label,
    html[data-capture="listening-patterns"] .tuner-intro > h2,
    html[data-capture="listening-patterns"] .tuner-lede,
    html[data-capture="listening-patterns"] .demo-start-action,
    html[data-capture="listening-patterns"] .profile-metrics,
    html[data-capture="listening-patterns"] .identity-link-coverage,
    html[data-capture="listening-patterns"] .time-machine-preview,
    html[data-capture="listening-patterns"] .listening-pulse-preview,
    html[data-capture="listening-patterns"] .listening-seasons-preview,
    html[data-capture="listening-patterns"] .historical-returns-preview,
    html[data-capture="listening-patterns"] .continuity-preview,
    html[data-capture="listening-patterns"] .profile-artifact-links,
    html[data-capture="historical-returns"] .topbar,
    html[data-capture="historical-returns"] .hero,
    html[data-capture="historical-returns"] .workspace,
    html[data-capture="historical-returns"] .footnote,
    html[data-capture="historical-returns"] .tuner-workbench,
    html[data-capture="historical-returns"] .tuner-intro > .section-label,
    html[data-capture="historical-returns"] .tuner-intro > h2,
    html[data-capture="historical-returns"] .tuner-lede,
    html[data-capture="historical-returns"] .demo-start-action,
    html[data-capture="historical-returns"] .profile-metrics,
    html[data-capture="historical-returns"] .identity-link-coverage,
    html[data-capture="historical-returns"] .time-machine-preview,
    html[data-capture="historical-returns"] .listening-pulse-preview,
    html[data-capture="historical-returns"] .listening-seasons-preview,
    html[data-capture="historical-returns"] .continuity-preview:not(.historical-returns-preview),
    html[data-capture="historical-returns"] .listening-patterns-preview,
    html[data-capture="historical-returns"] .profile-artifact-links,
    html[data-capture="listening-seasons"] .topbar,
    html[data-capture="listening-seasons"] .hero,
    html[data-capture="listening-seasons"] .workspace,
    html[data-capture="listening-seasons"] .footnote,
    html[data-capture="listening-seasons"] .tuner-workbench,
    html[data-capture="listening-seasons"] .tuner-intro > .section-label,
    html[data-capture="listening-seasons"] .tuner-intro > h2,
    html[data-capture="listening-seasons"] .tuner-lede,
    html[data-capture="listening-seasons"] .demo-start-action,
    html[data-capture="listening-seasons"] .profile-metrics,
    html[data-capture="listening-seasons"] .identity-link-coverage,
    html[data-capture="listening-seasons"] .time-machine-preview,
    html[data-capture="listening-seasons"] .listening-pulse-preview,
    html[data-capture="listening-seasons"] .historical-returns-preview,
    html[data-capture="listening-seasons"] .continuity-preview,
    html[data-capture="listening-seasons"] .listening-patterns-preview,
    html[data-capture="listening-seasons"] .profile-artifact-links {
      display: none !important;
    }

    html[data-capture="listening-pulse"] .topbar,
    html[data-capture="listening-pulse"] .hero,
    html[data-capture="listening-pulse"] .workspace,
    html[data-capture="listening-pulse"] .footnote,
    html[data-capture="listening-pulse"] .tuner-workbench,
    html[data-capture="listening-pulse"] .tuner-intro > .section-label,
    html[data-capture="listening-pulse"] .tuner-intro > h2,
    html[data-capture="listening-pulse"] .tuner-lede,
    html[data-capture="listening-pulse"] .demo-start-action,
    html[data-capture="listening-pulse"] .profile-metrics,
    html[data-capture="listening-pulse"] .identity-link-coverage,
    html[data-capture="listening-pulse"] .time-machine-preview,
    html[data-capture="listening-pulse"] .listening-seasons-preview,
    html[data-capture="listening-pulse"] .continuity-preview,
    html[data-capture="listening-pulse"] .listening-patterns-preview,
    html[data-capture="listening-pulse"] .profile-artifact-links {
      display: none !important;
    }

    html[data-capture="time-machine"] .shell,
    html[data-capture="listening-pulse"] .shell,
    html[data-capture="listening-seasons"] .shell,
    html[data-capture="historical-returns"] .shell,
    html[data-capture="listening-patterns"] .shell {
      width: min(1180px, calc(100% - 40px));
      padding: 20px 0;
    }

    html[data-capture="time-machine"] .tuner,
    html[data-capture="listening-pulse"] .tuner,
    html[data-capture="listening-seasons"] .tuner,
    html[data-capture="historical-returns"] .tuner,
    html[data-capture="listening-patterns"] .tuner {
      display: block;
      min-height: 800px;
      margin-top: 0;
      border-color: #0e0e0d;
      background: var(--night);
    }

    html[data-capture="time-machine"] .tuner-intro,
    html[data-capture="listening-pulse"] .tuner-intro,
    html[data-capture="listening-seasons"] .tuner-intro,
    html[data-capture="historical-returns"] .tuner-intro,
    html[data-capture="listening-patterns"] .tuner-intro {
      min-height: 800px;
      padding: 54px 62px;
    }

    html[data-capture="time-machine"] .profile-state,
    html[data-capture="listening-pulse"] .profile-state,
    html[data-capture="listening-seasons"] .profile-state,
    html[data-capture="historical-returns"] .profile-state,
    html[data-capture="listening-patterns"] .profile-state {
      margin-top: 0;
      padding-top: 0;
      border-top: 0;
    }

    html[data-capture="time-machine"] .profile-state-head,
    html[data-capture="listening-pulse"] .profile-state-head,
    html[data-capture="listening-seasons"] .profile-state-head,
    html[data-capture="historical-returns"] .profile-state-head,
    html[data-capture="listening-patterns"] .profile-state-head {
      max-width: 700px;
    }

    html[data-capture="time-machine"] .time-machine-preview,
    html[data-capture="listening-pulse"] .listening-pulse-preview,
    html[data-capture="listening-seasons"] .listening-seasons-preview,
    html[data-capture="historical-returns"] .historical-returns-preview,
    html[data-capture="listening-patterns"] .listening-patterns-preview {
      margin-top: 40px;
      padding: 34px 38px;
      border-radius: 24px;
      background: rgba(166, 191, 213, 0.1);
    }

    html[data-capture="time-machine"] .time-machine-preview-head strong,
    html[data-capture="listening-pulse"] .time-machine-preview-head strong,
    html[data-capture="listening-seasons"] .time-machine-preview-head strong,
    html[data-capture="historical-returns"] .time-machine-preview-head strong,
    html[data-capture="listening-patterns"] .time-machine-preview-head strong {
      font-size: 32px;
    }

    html[data-capture="time-machine"] .time-machine-count,
    html[data-capture="listening-pulse"] .time-machine-count,
    html[data-capture="listening-seasons"] .time-machine-count,
    html[data-capture="historical-returns"] .time-machine-count,
    html[data-capture="listening-patterns"] .time-machine-count {
      font-size: 10px;
    }

    html[data-capture="time-machine"] .time-machine-coverage,
    html[data-capture="listening-pulse"] .listening-pulse-summary,
    html[data-capture="listening-seasons"] .listening-seasons-summary,
    html[data-capture="historical-returns"] .continuity-summary,
    html[data-capture="listening-patterns"] .listening-patterns-summary {
      max-width: 820px;
      margin-top: 18px;
      font-size: 13px;
      line-height: 1.6;
    }

    html[data-capture="time-machine"] .time-machine-coverage strong {
      font-size: 14px;
    }

    html[data-capture="listening-pulse"] .listening-pulse-preview {
      border-color: rgba(166, 191, 213, 0.5);
      background:
        radial-gradient(circle at 100% 0%, rgba(166, 191, 213, 0.16), transparent 22rem),
        rgba(166, 191, 213, 0.08);
    }

    html[data-capture="listening-pulse"] .studio-pulse-grid {
      gap: 7px;
      grid-template-columns: 42px repeat(12, minmax(0, 1fr));
      margin: 28px 0 24px;
    }

    html[data-capture="listening-pulse"] .studio-pulse-corner,
    html[data-capture="listening-pulse"] .studio-pulse-month,
    html[data-capture="listening-pulse"] .studio-pulse-year {
      font-size: 9px;
    }

    html[data-capture="listening-pulse"] .studio-pulse-cell {
      border-radius: 5px;
    }

    html[data-capture="listening-pulse"] .listening-pulse-boundary {
      max-width: 820px;
      margin: 0 0 22px;
      font-size: 11px;
      line-height: 1.6;
    }

    html[data-capture="listening-seasons"] .listening-seasons-preview {
      margin-top: 22px;
      padding: 24px 30px;
      border-color: rgba(196, 173, 136, 0.52);
      background:
        radial-gradient(circle at 0% 100%, rgba(166, 191, 213, 0.12), transparent 22rem),
        rgba(196, 173, 136, 0.09);
    }

    html[data-capture="listening-seasons"] .tuner-intro {
      padding: 28px 62px;
    }

    html[data-capture="listening-seasons"] .studio-seasons-grid {
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
      margin: 18px 0 16px;
    }

    html[data-capture="listening-seasons"] .studio-season {
      min-height: 180px;
      padding: 14px;
      border-radius: 15px;
    }

    html[data-capture="listening-seasons"] .studio-season-head strong {
      font-size: 10px;
    }

    html[data-capture="listening-seasons"] .studio-season-head span,
    html[data-capture="listening-seasons"] .studio-season-total span,
    html[data-capture="listening-seasons"] .studio-season small {
      font-size: 8px;
    }

    html[data-capture="listening-seasons"] .studio-season-total {
      margin-top: 11px;
    }

    html[data-capture="listening-seasons"] .studio-season-total strong {
      font-size: 22px;
    }

    html[data-capture="listening-seasons"] .studio-season-mix {
      height: 4px;
      margin-top: 10px;
    }

    html[data-capture="listening-seasons"] .studio-season-mix-label span,
    html[data-capture="listening-seasons"] .studio-season-anchor span {
      font-size: 7px;
    }

    html[data-capture="listening-seasons"] .studio-season-anchor {
      margin-top: 8px;
      padding-top: 6px;
    }

    html[data-capture="listening-seasons"] .studio-season-anchor strong {
      font-size: 11px;
    }

    html[data-capture="listening-seasons"] .listening-seasons-boundary {
      max-width: 900px;
      margin: 0 0 14px;
      font-size: 10px;
      line-height: 1.5;
    }

    html[data-capture="time-machine"] .time-machine-route {
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 1px;
      margin: 32px 0 30px;
      overflow: hidden;
      border: 1px solid rgba(245, 241, 233, 0.14);
      border-radius: 18px;
      background: rgba(245, 241, 233, 0.13);
    }

    html[data-capture="time-machine"] .time-machine-landmark {
      display: block;
      min-height: 176px;
      padding: 28px 24px;
      border-top: 0;
      background: rgba(27, 27, 25, 0.94);
    }

    html[data-capture="time-machine"] .time-machine-year {
      font-size: 14px;
    }

    html[data-capture="time-machine"] .time-machine-track {
      margin-top: 42px;
    }

    html[data-capture="time-machine"] .time-machine-track strong {
      font-size: 19px;
    }

    html[data-capture="time-machine"] .time-machine-track span {
      margin-top: 7px;
      font-size: 12px;
    }

    html[data-capture="historical-returns"] .historical-returns-preview {
      border-color: rgba(196, 173, 136, 0.42);
      background: rgba(196, 173, 136, 0.1);
    }

    html[data-capture="historical-returns"] .continuity-summary {
      margin-bottom: 20px;
    }

    html[data-capture="historical-returns"] .continuity-relationships {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 0 32px;
      margin: 22px 0 26px;
    }

    html[data-capture="historical-returns"] .continuity-relationship {
      padding: 18px 0;
    }

    html[data-capture="historical-returns"] .historical-return-identity strong {
      font-size: 17px;
    }

    html[data-capture="historical-returns"] .historical-return-identity p {
      margin-top: 6px;
      font-size: 11px;
    }

    html[data-capture="historical-returns"] .continuity-relationship span {
      font-size: 10px;
    }

    html[data-capture="listening-patterns"] .listening-patterns-summary {
      margin-bottom: 22px;
    }

    html[data-capture="listening-patterns"] .listening-patterns-metrics {
      gap: 12px;
      margin-bottom: 24px;
    }

    html[data-capture="listening-patterns"] .listening-patterns-metric {
      padding: 18px;
      border-radius: 14px;
    }

    html[data-capture="listening-patterns"] .listening-patterns-metric strong {
      font-size: 34px;
    }

    html[data-capture="listening-patterns"] .listening-patterns-metric span {
      margin-top: 7px;
      font-size: 9px;
    }

    html[data-capture="listening-patterns"] .listening-pattern-release {
      padding: 15px 2px;
    }

    html[data-capture="listening-patterns"] .listening-pattern-release strong {
      font-size: 15px;
    }

    html[data-capture="listening-patterns"] .listening-pattern-release p,
    html[data-capture="listening-patterns"] .listening-pattern-release span {
      font-size: 11px;
    }

    body {
      min-height: 100vh;
      margin: 0;
      background:
        radial-gradient(circle at 8% -5%, rgba(255, 255, 255, 0.82), transparent 32rem),
        linear-gradient(180deg, var(--paper) 0%, #e7ddd0 100%);
    }

    button, input, textarea { font: inherit; }

    [hidden] { display: none !important; }

    button, .drop-zone, .result-link, .hero-preview-link, .profile-artifact-link { -webkit-tap-highlight-color: transparent; }

    .shell {
      width: min(1180px, calc(100% - 40px));
      margin: 0 auto;
      padding: 24px 0 56px;
    }

    .topbar {
      display: flex;
      min-width: 0;
      align-items: center;
      justify-content: space-between;
      gap: 24px;
      padding: 0 4px 18px;
    }

    .brand {
      display: flex;
      min-width: 0;
      align-items: center;
      gap: 12px;
    }

    .brand-mark {
      width: 42px;
      height: 42px;
      flex: 0 0 auto;
      overflow: hidden;
      border: 1px solid #aaa093;
      border-radius: 50%;
      background: #f7f3ec;
    }

    .brand-mark img {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: cover;
    }

    .brand-name {
      margin: 0;
      font-family: Iowan Old Style, Baskerville, "Times New Roman", serif;
      font-size: 22px;
      font-weight: 650;
      letter-spacing: -0.02em;
      line-height: 1;
    }

    .brand-subtitle {
      margin: 4px 0 0;
      color: var(--muted);
      font-size: 10px;
      font-weight: 760;
      letter-spacing: 0.16em;
      text-transform: uppercase;
    }

    .local-badge {
      display: inline-flex;
      min-width: 0;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border: 1px solid var(--line);
      border-radius: 999px;
      color: #514b44;
      background: rgba(248, 244, 237, 0.72);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      white-space: nowrap;
    }

    .local-badge::before {
      width: 7px;
      height: 7px;
      flex: 0 0 auto;
      border: 4px solid rgba(79, 115, 95, 0.17);
      border-radius: 50%;
      background: var(--green);
      content: "";
    }

    .hero {
      position: relative;
      isolation: isolate;
      display: grid;
      min-width: 0;
      grid-template-columns: minmax(0, 1.15fr) minmax(260px, 0.65fr);
      gap: clamp(32px, 6vw, 84px);
      overflow: hidden;
      padding: clamp(38px, 6vw, 72px);
      border: 1px solid #0e0e0d;
      border-radius: 32px 32px 0 0;
      color: #f5f1e9;
      background: var(--night);
      box-shadow: var(--shadow);
    }

    .hero::before {
      position: absolute;
      z-index: -1;
      width: 600px;
      aspect-ratio: 1;
      right: -220px;
      top: -250px;
      border: 1px solid rgba(245, 241, 233, 0.19);
      border-radius: 50%;
      box-shadow:
        0 0 0 24px rgba(245, 241, 233, 0.028),
        0 0 0 62px rgba(245, 241, 233, 0.022),
        0 0 0 108px rgba(245, 241, 233, 0.017),
        0 0 0 162px rgba(245, 241, 233, 0.012);
      content: "";
    }

    .eyebrow {
      display: flex;
      align-items: center;
      gap: 10px;
      margin: 0 0 32px;
      color: #d7d0c7;
      font-size: 10px;
      font-weight: 800;
      letter-spacing: 0.2em;
      text-transform: uppercase;
    }

    .eyebrow::before {
      width: 8px;
      height: 8px;
      border: 5px solid rgba(120, 151, 179, 0.24);
      border-radius: 50%;
      background: #a6bfd5;
      content: "";
    }

    h1, h2, .serif {
      font-family: Iowan Old Style, Baskerville, "Times New Roman", serif;
      font-weight: 650;
      letter-spacing: -0.04em;
    }

    h1 {
      max-width: 720px;
      margin: 0;
      font-size: clamp(52px, 7.2vw, 94px);
      line-height: 0.89;
    }

    .hero-copy {
      max-width: 650px;
      margin: 28px 0 0;
      color: #cdc7be;
      font-size: clamp(16px, 1.7vw, 20px);
      line-height: 1.55;
    }

    .hero-preview-link {
      appearance: none;
      display: inline-flex;
      align-items: center;
      gap: 10px;
      margin-top: 22px;
      padding: 0 0 5px;
      border: 0;
      border-bottom: 1px solid rgba(245, 241, 233, 0.38);
      color: #f5f1e9;
      background: transparent;
      font-size: 12px;
      font-weight: 760;
      line-height: 1.4;
      text-align: left;
      text-decoration: none;
      cursor: pointer;
      transition: border-color 150ms ease, color 150ms ease;
    }

    .hero-preview-link:hover { border-color: #a6bfd5; color: #dce9f4; }

    .hero-preview-link:focus-visible { outline: 3px solid rgba(166, 191, 213, 0.55); outline-offset: 5px; }

    .hero-preview-link:disabled { opacity: 0.48; cursor: wait; }

    .hero-preview-link.is-primary {
      min-height: 44px;
      padding: 0 17px;
      border: 1px solid #f5f1e9;
      border-radius: 999px;
      color: var(--night);
      background: #f5f1e9;
    }

    .hero-preview-link.is-primary:hover {
      border-color: #dce9f4;
      color: var(--night);
      background: #dce9f4;
    }

    .hero-preview-actions {
      display: flex;
      min-width: 0;
      flex-wrap: wrap;
      gap: 16px;
      align-items: center;
      margin-top: 22px;
    }

    .hero-preview-actions .hero-preview-link { margin-top: 0; }

    .hero-aside {
      align-self: end;
      border-top: 1px solid rgba(245, 241, 233, 0.25);
    }

    .hero-step {
      display: grid;
      grid-template-columns: 30px minmax(0, 1fr);
      gap: 14px;
      padding: 16px 0;
      border-bottom: 1px solid rgba(245, 241, 233, 0.15);
    }

    .hero-step span {
      color: #93aec5;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11px;
    }

    .hero-step p {
      margin: 0;
      color: #e7e1d8;
      font-size: 13px;
      line-height: 1.45;
    }

    .workspace {
      display: grid;
      min-width: 0;
      grid-template-columns: minmax(220px, 0.55fr) minmax(0, 1.45fr);
      border: 1px solid var(--line-strong);
      border-top: 0;
      border-radius: 0 0 32px 32px;
      background: var(--card);
      box-shadow: var(--shadow);
    }

    .privacy-rail {
      min-width: 0;
      padding: clamp(28px, 4vw, 48px);
      border-right: 1px solid var(--line);
      background: #e9e1d6;
    }

    .section-label {
      margin: 0 0 22px;
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 10px;
      font-weight: 800;
      letter-spacing: 0.17em;
      text-transform: uppercase;
    }

    .privacy-item {
      display: grid;
      grid-template-columns: 24px minmax(0, 1fr);
      gap: 12px;
      padding: 15px 0;
      border-top: 1px solid rgba(148, 136, 122, 0.45);
    }

    .privacy-item:last-of-type { border-bottom: 1px solid rgba(148, 136, 122, 0.45); }

    .privacy-icon {
      display: grid;
      width: 24px;
      height: 24px;
      place-items: center;
      border: 1px solid #8eaa99;
      border-radius: 50%;
      color: var(--green);
      font-size: 12px;
      font-weight: 900;
    }

    .privacy-item strong {
      display: block;
      margin: 1px 0 4px;
      font-size: 13px;
    }

    .privacy-item p {
      margin: 0;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.45;
    }

    .importer {
      min-width: 0;
      padding: clamp(28px, 5vw, 58px);
    }

    .importer-header {
      display: flex;
      min-width: 0;
      align-items: end;
      justify-content: space-between;
      gap: 24px;
      margin-bottom: 24px;
    }

    .importer h2 {
      margin: 0;
      font-size: clamp(32px, 4.4vw, 54px);
      line-height: 0.98;
    }

    .limit {
      flex: 0 0 auto;
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 10px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .file-input {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
      clip-path: inset(50%);
      white-space: nowrap;
    }

    .drop-zone {
      position: relative;
      display: grid;
      min-height: 258px;
      place-items: center;
      padding: 34px;
      overflow: hidden;
      border: 1.5px dashed var(--line-strong);
      border-radius: 24px;
      text-align: center;
      background:
        radial-gradient(circle at 90% 0%, rgba(120, 151, 179, 0.15), transparent 18rem),
        rgba(255, 255, 255, 0.24);
      cursor: pointer;
      transition: border-color 160ms ease, background 160ms ease, transform 160ms ease;
    }

    .drop-zone:hover, .drop-zone:focus-visible, .drop-zone.is-dragging {
      outline: none;
      border-color: var(--ink);
      background-color: rgba(216, 229, 239, 0.42);
      transform: translateY(-2px);
    }

    .drop-zone.is-ready {
      border-style: solid;
      border-color: #809d8b;
      background-color: rgba(79, 115, 95, 0.07);
    }

    .drop-orbit {
      display: grid;
      width: 74px;
      height: 74px;
      margin: 0 auto 22px;
      place-items: center;
      border: 1px solid var(--line-strong);
      border-radius: 50%;
      color: var(--ink);
      box-shadow: 0 0 0 9px rgba(148, 136, 122, 0.09), 0 0 0 19px rgba(148, 136, 122, 0.055);
      font-size: 26px;
      line-height: 1;
    }

    .drop-title {
      display: block;
      margin: 0;
      font-size: 18px;
      font-weight: 750;
    }

    .drop-copy {
      display: block;
      margin: 8px 0 0;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.5;
    }

    .file-meta {
      display: none;
      min-width: 0;
      margin-top: 16px;
      padding: 14px 16px;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: #f2ece3;
    }

    .file-meta.is-visible { display: flex; }

    .file-name {
      min-width: 0;
      overflow: hidden;
      font-size: 13px;
      font-weight: 720;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .file-size {
      flex: 0 0 auto;
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 10px;
    }

    .action-row {
      display: flex;
      min-width: 0;
      align-items: center;
      gap: 18px;
      margin-top: 20px;
    }

    .primary-action {
      display: inline-flex;
      min-height: 50px;
      min-width: 218px;
      align-items: center;
      justify-content: space-between;
      gap: 18px;
      padding: 0 18px 0 20px;
      border: 1px solid var(--ink);
      border-radius: 999px;
      color: #f7f2e9;
      background: var(--ink);
      font-size: 13px;
      font-weight: 760;
      cursor: pointer;
      transition: opacity 150ms ease, transform 150ms ease;
    }

    .primary-action:hover:not(:disabled) { transform: translateY(-1px); }

    .primary-action:focus-visible { outline: 3px solid rgba(120, 151, 179, 0.5); outline-offset: 3px; }

    .primary-action:disabled { opacity: 0.38; cursor: not-allowed; }

    .action-arrow {
      display: grid;
      width: 28px;
      height: 28px;
      place-items: center;
      border-radius: 50%;
      color: var(--ink);
      background: #f7f2e9;
      font-size: 16px;
    }

    .status {
      min-width: 0;
      margin: 0;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.45;
    }

    .status.is-error { color: var(--red); font-weight: 680; }

    .progress {
      display: none;
      height: 3px;
      margin-top: 20px;
      overflow: hidden;
      border-radius: 999px;
      background: #d7cec2;
    }

    .progress.is-visible { display: block; }

    .progress-bar {
      width: 0;
      height: 100%;
      border-radius: inherit;
      background: var(--blue);
      transition: width 180ms ease;
    }

    .result {
      display: none;
      min-width: 0;
      margin-top: 24px;
      padding: clamp(22px, 4vw, 34px);
      border: 1px solid #9eb3c5;
      border-radius: 22px;
      background: var(--blue-soft);
    }

    .result.is-visible { display: block; }

    .result-kicker {
      margin: 0 0 8px;
      color: #506c84;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 10px;
      font-weight: 800;
      letter-spacing: 0.14em;
      text-transform: uppercase;
    }

    .result h3 {
      margin: 0;
      font-family: Iowan Old Style, Baskerville, "Times New Roman", serif;
      font-size: clamp(28px, 4vw, 40px);
      letter-spacing: -0.035em;
    }

    .result-copy {
      margin: 9px 0 0;
      color: #516271;
      font-size: 13px;
      line-height: 1.5;
    }

    .stats {
      display: grid;
      min-width: 0;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 1px;
      margin: 24px 0;
      overflow: hidden;
      border: 1px solid rgba(80, 108, 132, 0.25);
      border-radius: 14px;
      background: rgba(80, 108, 132, 0.22);
    }

    .stat {
      min-width: 0;
      padding: 16px;
      background: rgba(248, 244, 237, 0.72);
    }

    .stat-value {
      display: block;
      overflow: hidden;
      color: var(--ink);
      font-family: Iowan Old Style, Baskerville, "Times New Roman", serif;
      font-size: clamp(22px, 3vw, 32px);
      font-weight: 650;
      letter-spacing: -0.04em;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .stat-label {
      display: block;
      margin-top: 4px;
      color: #607383;
      font-size: 10px;
      font-weight: 760;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .result-link {
      display: inline-flex;
      min-height: 44px;
      align-items: center;
      gap: 12px;
      padding: 0 18px;
      border: 1px solid var(--ink);
      border-radius: 999px;
      color: #f7f2e9;
      background: var(--ink);
      font-size: 12px;
      font-weight: 760;
      text-decoration: none;
    }

    .result-links {
      display: flex;
      min-width: 0;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
    }

    .result-link.is-secondary {
      color: var(--ink);
      background: transparent;
    }

    .result-boundary {
      margin: 12px 0 0;
      color: #607383;
      font-size: 10px;
      line-height: 1.45;
    }

    .tuner {
      display: grid;
      min-width: 0;
      grid-template-columns: minmax(260px, 0.66fr) minmax(0, 1.34fr);
      margin-top: 18px;
      overflow: hidden;
      border: 1px solid var(--line-strong);
      border-radius: 32px;
      background: var(--card);
      box-shadow: var(--shadow);
    }

    .tuner-intro {
      position: relative;
      isolation: isolate;
      min-width: 0;
      overflow: hidden;
      padding: clamp(34px, 5vw, 58px);
      color: #f5f1e9;
      background: var(--night);
    }

    .tuner-intro::after {
      position: absolute;
      z-index: -1;
      width: 320px;
      height: 320px;
      right: -190px;
      bottom: -150px;
      border: 1px solid rgba(166, 191, 213, 0.24);
      border-radius: 50%;
      box-shadow:
        0 0 0 24px rgba(166, 191, 213, 0.045),
        0 0 0 60px rgba(166, 191, 213, 0.025);
      content: "";
    }

    .tuner-intro .section-label { color: #a6bfd5; }

    .tuner h2 {
      max-width: 360px;
      margin: 0;
      font-size: clamp(38px, 5vw, 62px);
      line-height: 0.94;
    }

    .tuner-lede {
      max-width: 430px;
      margin: 22px 0 0;
      color: #c9c3ba;
      font-size: 14px;
      line-height: 1.62;
    }

    .profile-state {
      margin-top: 34px;
      padding-top: 22px;
      border-top: 1px solid rgba(245, 241, 233, 0.2);
    }

    .profile-state-head {
      display: grid;
      grid-template-columns: 12px minmax(0, 1fr);
      gap: 12px;
      align-items: start;
    }

    .profile-state-dot {
      width: 9px;
      height: 9px;
      margin-top: 5px;
      border: 3px solid rgba(166, 191, 213, 0.22);
      border-radius: 50%;
      background: #a6bfd5;
      box-sizing: content-box;
    }

    .profile-state.is-ready .profile-state-dot {
      border-color: rgba(130, 168, 146, 0.25);
      background: #82a892;
    }

    .profile-state.is-demo .profile-state-dot {
      border-color: rgba(166, 191, 213, 0.3);
      background: #a6bfd5;
    }

    .profile-state.is-error .profile-state-dot {
      border-color: rgba(180, 82, 63, 0.25);
      background: #d87864;
    }

    .profile-state strong {
      display: block;
      font-size: 14px;
      line-height: 1.35;
    }

    .profile-state p {
      margin: 6px 0 0;
      color: #a9a39a;
      font-size: 11px;
      line-height: 1.5;
    }

    .demo-profile-badge {
      display: inline-flex;
      margin: 0 0 9px;
      padding: 5px 8px;
      border: 1px solid rgba(166, 191, 213, 0.34);
      border-radius: 999px;
      color: #d7e6f2;
      background: rgba(166, 191, 213, 0.1);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 8px;
      font-weight: 820;
      letter-spacing: 0.13em;
      line-height: 1;
      text-transform: uppercase;
    }

    .demo-start-action {
      display: flex;
      width: 100%;
      min-width: 0;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      margin-top: 18px;
      padding: 12px 14px;
      border: 1px solid rgba(166, 191, 213, 0.32);
      border-radius: 13px;
      color: #f5f1e9;
      background: rgba(166, 191, 213, 0.08);
      font: inherit;
      font-size: 11px;
      font-weight: 760;
      text-align: left;
      cursor: pointer;
      transition: border-color 160ms ease, background 160ms ease, transform 160ms ease;
    }

    .demo-start-action:hover:not(:disabled) {
      transform: translateY(-1px);
      border-color: rgba(166, 191, 213, 0.68);
      background: rgba(166, 191, 213, 0.14);
    }

    .demo-start-action:focus-visible {
      outline: 3px solid rgba(166, 191, 213, 0.38);
      outline-offset: 3px;
    }

    .demo-start-action:disabled { opacity: 0.45; cursor: wait; }

    .profile-tools {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 14px;
    }

    .profile-tools .demo-start-action {
      width: auto;
      flex: 1 1 110px;
      margin-top: 0;
      min-height: 44px;
    }

    .track-correction-action {
      display: block;
      min-height: 44px;
      margin-top: 2px;
      padding: 8px 0;
      border: 0;
      color: #c8d9e8;
      background: transparent;
      font: inherit;
      font-size: 10px;
      font-weight: 700;
      text-align: left;
      text-decoration: underline;
      text-underline-offset: 3px;
      cursor: pointer;
    }

    .track-correction-action:focus-visible {
      outline: 2px solid var(--blue);
      outline-offset: 3px;
    }

    .track-correction-action:disabled { opacity: 0.45; cursor: wait; }
    html[data-capture] .profile-tools,
    html[data-capture] .track-correction-action { display: none; }
    #correction-form { scroll-margin-top: 24px; }
    #correction-return { margin-top: 16px; }

    .profile-metrics {
      display: grid;
      min-width: 0;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 1px;
      margin-top: 20px;
      overflow: hidden;
      border: 1px solid rgba(245, 241, 233, 0.13);
      border-radius: 13px;
      background: rgba(245, 241, 233, 0.12);
    }

    .profile-metric {
      min-width: 0;
      padding: 12px;
      background: rgba(245, 241, 233, 0.045);
    }

    .profile-metric strong {
      overflow: hidden;
      color: #f5f1e9;
      font-family: Iowan Old Style, Baskerville, "Times New Roman", serif;
      font-size: 22px;
      letter-spacing: -0.03em;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .profile-metric span {
      display: block;
      margin-top: 3px;
      color: #918b82;
      font-size: 8px;
      font-weight: 760;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }

    .profile-artifact-links {
      display: flex;
      min-width: 0;
      flex-wrap: wrap;
      gap: 14px;
      margin-top: 18px;
    }

    .profile-artifact-link {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding-bottom: 4px;
      border-bottom: 1px solid rgba(245, 241, 233, 0.3);
      color: #f5f1e9;
      font-size: 11px;
      font-weight: 760;
      text-decoration: none;
    }

    .time-machine-preview {
      min-width: 0;
      margin-top: 20px;
      padding: 16px;
      border: 1px solid rgba(166, 191, 213, 0.32);
      border-radius: 16px;
      background: rgba(166, 191, 213, 0.08);
    }

    .time-machine-preview-head {
      display: flex;
      min-width: 0;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
    }

    .time-machine-preview-head strong {
      color: #f5f1e9;
      font-family: Iowan Old Style, Baskerville, "Times New Roman", serif;
      font-size: 17px;
      letter-spacing: -0.025em;
    }

    .time-machine-count {
      flex: 0 0 auto;
      color: #a6bfd5;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 8px;
      font-weight: 800;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }

    .time-machine-coverage {
      margin: 10px 0 0;
      padding-left: 10px;
      border-left: 2px solid rgba(166, 191, 213, 0.5);
      color: #aaa49b;
      font-size: 9px;
      line-height: 1.55;
    }

    .time-machine-coverage strong {
      display: block;
      color: #c8d9e8;
      font-size: 10px;
      font-weight: 760;
    }

    .time-machine-coverage span {
      display: block;
      margin-top: 3px;
    }

    .identity-link-coverage {
      margin: 16px 0 0;
    }

    .time-machine-route {
      display: grid;
      min-width: 0;
      gap: 0;
      margin: 12px 0 14px;
      padding: 0;
      list-style: none;
    }

    .time-machine-landmark {
      display: grid;
      min-width: 0;
      grid-template-columns: 38px minmax(0, 1fr);
      gap: 10px;
      padding: 9px 0;
      border-top: 1px solid rgba(245, 241, 233, 0.12);
    }

    .time-machine-year {
      color: #a6bfd5;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 9px;
      font-weight: 800;
      letter-spacing: 0.04em;
    }

    .time-machine-track {
      min-width: 0;
    }

    .time-machine-track strong {
      overflow: hidden;
      color: #f5f1e9;
      font-size: 11px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .time-machine-track span {
      display: block;
      overflow: hidden;
      margin-top: 2px;
      color: #918b82;
      font-size: 9px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .time-machine-action {
      color: #dce9f4;
      border-bottom-color: rgba(166, 191, 213, 0.58);
    }

    .listening-pulse-preview {
      min-width: 0;
      margin-top: 14px;
      padding: 16px;
      border: 1px solid rgba(166, 191, 213, 0.36);
      border-radius: 16px;
      background:
        radial-gradient(circle at 100% 0%, rgba(166, 191, 213, 0.12), transparent 16rem),
        rgba(166, 191, 213, 0.06);
    }

    .listening-pulse-summary,
    .listening-pulse-boundary {
      margin: 10px 0 12px;
      color: #aaa49b;
      font-size: 9px;
      line-height: 1.55;
    }

    .listening-pulse-boundary { margin: 10px 0 14px; }

    .studio-pulse-grid {
      display: grid;
      grid-template-columns: 31px repeat(12, minmax(0, 1fr));
      gap: 4px;
      min-width: 0;
      align-items: center;
    }

    .studio-pulse-corner,
    .studio-pulse-month,
    .studio-pulse-year {
      color: #918b82;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 7px;
      font-weight: 800;
      letter-spacing: 0.04em;
    }

    .studio-pulse-month { text-align: center; }

    .studio-pulse-cell {
      display: block;
      min-width: 0;
      aspect-ratio: 1;
      border: 1px solid rgba(166, 191, 213, 0.12);
      border-radius: 3px;
      background: rgba(166, 191, 213, 0.07);
    }

    .studio-pulse-cell.level-1 { background: rgba(166, 191, 213, 0.26); }
    .studio-pulse-cell.level-2 { background: rgba(166, 191, 213, 0.46); }
    .studio-pulse-cell.level-3 { background: rgba(166, 191, 213, 0.68); }
    .studio-pulse-cell.level-4 { background: #a6bfd5; }
    .studio-pulse-cell.is-outside { border-color: transparent; background: transparent; }

    .listening-seasons-preview {
      min-width: 0;
      margin-top: 14px;
      padding: 16px;
      border: 1px solid rgba(196, 173, 136, 0.4);
      border-radius: 16px;
      background:
        radial-gradient(circle at 0% 100%, rgba(166, 191, 213, 0.08), transparent 14rem),
        rgba(196, 173, 136, 0.07);
    }

    .listening-seasons-summary,
    .listening-seasons-boundary {
      margin: 10px 0 12px;
      color: #aaa49b;
      font-size: 9px;
      line-height: 1.55;
    }

    .studio-seasons-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 7px;
      min-width: 0;
      margin-bottom: 12px;
    }

    .studio-season {
      position: relative;
      min-width: 0;
      overflow: hidden;
      padding: 11px;
      border: 1px solid rgba(245, 241, 233, 0.13);
      border-radius: 11px;
      background: rgba(245, 241, 233, 0.035);
    }

    .studio-season::before {
      position: absolute;
      inset: 0 auto 0 0;
      width: 2px;
      background: #a6bfd5;
      content: "";
    }

    .studio-season.quarter-2::before { background: #86a08c; }
    .studio-season.quarter-3::before { background: #c29a6b; }
    .studio-season.quarter-4::before { background: #9b819d; }
    .studio-season.is-empty::before { opacity: 0.34; }

    .studio-season-head,
    .studio-season-total,
    .studio-season-mix-label {
      display: flex;
      min-width: 0;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
    }

    .studio-season-head strong {
      color: #f5f1e9;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 8px;
      letter-spacing: 0.06em;
    }

    .studio-season-head span,
    .studio-season-total span,
    .studio-season small {
      color: #918b82;
      font-size: 7px;
      line-height: 1.4;
    }

    .studio-season-total { margin-top: 10px; }
    .studio-season-total strong {
      min-width: 0;
      overflow: hidden;
      color: #f5f1e9;
      font: 650 16px Iowan Old Style, Baskerville, serif;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .studio-season-total span { flex: 0 1 auto; text-align: right; }

    .studio-season-mix {
      height: 3px;
      margin-top: 9px;
      overflow: hidden;
      border-radius: 99px;
      background: rgba(196, 173, 136, 0.48);
    }
    .studio-season-mix span { display: block; height: 100%; background: #a6bfd5; }
    .studio-season-mix-label { margin: 4px 0 0; }
    .studio-season-mix-label span { color: #918b82; font-size: 6px; }

    .studio-season-anchor {
      min-width: 0;
      margin: 10px 0 0;
      padding-top: 8px;
      border-top: 1px solid rgba(245, 241, 233, 0.1);
    }
    .studio-season-anchor span {
      display: block;
      color: #918b82;
      font-size: 6px;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .studio-season-anchor strong {
      display: block;
      overflow: hidden;
      margin-top: 3px;
      color: #f5f1e9;
      font-size: 9px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .studio-season-anchor small {
      display: block;
      overflow: hidden;
      margin-top: 2px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .studio-season-empty {
      margin: 18px 0 13px;
      color: #918b82;
      font-size: 8px;
      line-height: 1.45;
    }

    .listening-seasons-boundary { margin: 10px 0 14px; }

    .continuity-preview {
      min-width: 0;
      margin-top: 14px;
      padding: 16px;
      border: 1px solid rgba(196, 173, 136, 0.36);
      border-radius: 16px;
      background: rgba(196, 173, 136, 0.08);
    }

    .continuity-summary {
      margin: 10px 0 0;
      color: #aaa49b;
      font-size: 9px;
      line-height: 1.55;
    }

    .continuity-relationships {
      display: grid;
      min-width: 0;
      gap: 0;
      margin: 12px 0 14px;
      padding: 0;
      list-style: none;
    }

    .continuity-relationship {
      display: flex;
      min-width: 0;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
      padding: 8px 0;
      border-top: 1px solid rgba(245, 241, 233, 0.12);
    }

    .continuity-relationship strong {
      min-width: 0;
      overflow: hidden;
      color: #f5f1e9;
      font-size: 11px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .continuity-relationship span {
      flex: 0 0 auto;
      color: #bfae90;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 8px;
      font-weight: 800;
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }

    .historical-returns-preview .continuity-relationship {
      align-items: center;
    }

    .back-to-back-preview {
      border-color: rgba(166, 191, 213, 0.36);
      background: rgba(166, 191, 213, 0.08);
    }

    .back-to-back-preview .continuity-relationship {
      align-items: center;
    }

    .historical-return-identity {
      min-width: 0;
    }

    .historical-return-identity strong {
      display: block;
    }

    .historical-return-identity p {
      overflow: hidden;
      margin: 3px 0 0;
      color: #918b82;
      font-size: 9px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .listening-patterns-preview {
      min-width: 0;
      margin-top: 14px;
      padding: 16px;
      border: 1px solid rgba(166, 191, 213, 0.36);
      border-radius: 16px;
      background: rgba(166, 191, 213, 0.08);
    }

    .listening-patterns-summary {
      margin: 10px 0 12px;
      color: #aaa49b;
      font-size: 9px;
      line-height: 1.55;
    }

    .listening-patterns-metrics {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 7px;
      margin-bottom: 12px;
    }

    .listening-patterns-metric {
      min-width: 0;
      padding: 10px 9px;
      border: 1px solid rgba(166, 191, 213, 0.22);
      border-radius: 10px;
      background: rgba(245, 241, 233, 0.035);
    }

    .listening-patterns-metric strong {
      display: block;
      overflow: hidden;
      color: #f5f1e9;
      font: 650 18px Iowan Old Style, Baskerville, serif;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .listening-patterns-metric span {
      display: block;
      margin-top: 4px;
      color: #918b82;
      font-size: 7px;
      font-weight: 800;
      letter-spacing: 0.07em;
      text-transform: uppercase;
    }

    .listening-pattern-releases {
      display: grid;
      min-width: 0;
      gap: 0;
      margin: 0 0 14px;
      padding: 0;
      list-style: none;
    }

    .listening-pattern-release {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 12px;
      min-width: 0;
      align-items: baseline;
      padding: 8px 0;
      border-top: 1px solid rgba(245, 241, 233, 0.12);
    }

    .listening-pattern-release > div { min-width: 0; }

    .listening-pattern-release strong,
    .listening-pattern-release p {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .listening-pattern-release strong { display: block; color: #f5f1e9; font-size: 10px; }
    .listening-pattern-release p { margin: 2px 0 0; color: #918b82; font-size: 8px; }
    .listening-pattern-release span { color: #a6bfd5; font: 800 8px ui-monospace, SFMono-Regular, Menlo, monospace; }

    .tuner-workbench {
      min-width: 0;
      padding: clamp(30px, 5vw, 58px);
    }

    .correction-fieldset {
      min-width: 0;
      margin: 0;
      padding: 0;
      border: 0;
    }

    .correction-fieldset:disabled { opacity: 0.5; }

    .control-block + .control-block { margin-top: 22px; }

    .control-label {
      display: block;
      margin: 0 0 9px;
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 9px;
      font-weight: 800;
      letter-spacing: 0.13em;
      text-transform: uppercase;
    }

    .choice-group {
      display: grid;
      min-width: 0;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 6px;
      padding: 5px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: #ebe3d8;
    }

    .choice-group input {
      position: absolute;
      opacity: 0;
      pointer-events: none;
    }

    .choice-group label {
      display: flex;
      min-width: 0;
      min-height: 38px;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 8px 14px;
      border-radius: 999px;
      color: #625b53;
      font-size: 12px;
      font-weight: 720;
      text-align: center;
      cursor: pointer;
    }

    .choice-group input:checked + label {
      color: #f7f2e9;
      background: var(--ink);
      box-shadow: 0 4px 14px rgba(27, 27, 25, 0.14);
    }

    .choice-group input:focus-visible + label {
      outline: 3px solid rgba(120, 151, 179, 0.5);
      outline-offset: 2px;
    }

    .field-grid {
      display: grid;
      min-width: 0;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
      margin-top: 22px;
    }

    .field { min-width: 0; }

    .text-input {
      width: 100%;
      min-width: 0;
      min-height: 48px;
      padding: 12px 14px;
      border: 1px solid var(--line);
      border-radius: 13px;
      outline: none;
      color: var(--ink);
      background: #f3ede4;
      font-size: 13px;
      transition: border-color 150ms ease, box-shadow 150ms ease, background 150ms ease;
    }

    textarea.text-input {
      min-height: 86px;
      resize: vertical;
      line-height: 1.5;
    }

    .text-input:focus {
      border-color: var(--blue);
      background: #faf7f1;
      box-shadow: 0 0 0 3px rgba(120, 151, 179, 0.16);
    }

    .text-input::placeholder { color: #a29a90; }

    .field-hint {
      margin: 7px 0 0;
      color: #8a8278;
      font-size: 10px;
      line-height: 1.4;
    }

    .correction-actions {
      display: flex;
      min-width: 0;
      align-items: center;
      gap: 16px;
      margin-top: 22px;
    }

    .correction-actions .primary-action { min-width: 198px; }

    .profile-status {
      min-width: 0;
      margin: 0;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.45;
    }

    .profile-status.is-error { color: var(--red); font-weight: 680; }

    .active-corrections {
      min-width: 0;
      margin-top: 34px;
      padding-top: 28px;
      border-top: 1px solid var(--line);
    }

    .active-corrections-head {
      display: flex;
      min-width: 0;
      align-items: baseline;
      justify-content: space-between;
      gap: 18px;
      margin-bottom: 14px;
    }

    .active-corrections h3 {
      margin: 0;
      font-family: Iowan Old Style, Baskerville, "Times New Roman", serif;
      font-size: 27px;
      letter-spacing: -0.035em;
    }

    .correction-count {
      flex: 0 0 auto;
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 9px;
      font-weight: 760;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }

    .correction-empty {
      margin: 0;
      padding: 18px;
      border: 1px dashed var(--line);
      border-radius: 14px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.5;
      text-align: center;
    }

    .correction-list {
      display: grid;
      min-width: 0;
      gap: 9px;
    }

    .correction-item {
      display: grid;
      min-width: 0;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 18px;
      align-items: center;
      padding: 15px 16px;
      border: 1px solid var(--line);
      border-radius: 15px;
      background: #f1eae0;
    }

    .correction-item-main { min-width: 0; }

    .correction-meta {
      display: flex;
      min-width: 0;
      flex-wrap: wrap;
      align-items: center;
      gap: 7px;
      margin-bottom: 6px;
    }

    .correction-chip {
      display: inline-flex;
      align-items: center;
      min-height: 20px;
      padding: 3px 8px;
      border-radius: 999px;
      color: #315b45;
      background: #d9e7dc;
      font-size: 8px;
      font-weight: 820;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }

    .correction-chip.is-avoid {
      color: #7b4338;
      background: #ecd9d4;
    }

    .correction-type, .correction-time {
      color: #81786e;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 8px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }

    .correction-title {
      display: block;
      overflow-wrap: anywhere;
      font-size: 14px;
      line-height: 1.35;
    }

    .correction-artist, .correction-note {
      margin: 4px 0 0;
      overflow-wrap: anywhere;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.45;
    }

    .retract-action {
      min-height: 34px;
      padding: 0 12px;
      border: 1px solid var(--line-strong);
      border-radius: 999px;
      color: #5c554d;
      background: transparent;
      font-size: 10px;
      font-weight: 730;
      cursor: pointer;
    }

    .retract-action:hover:not(:disabled) { border-color: var(--ink); color: var(--ink); }

    .retract-action:focus-visible { outline: 3px solid rgba(120, 151, 179, 0.45); outline-offset: 2px; }

    .retract-action:disabled { opacity: 0.45; cursor: wait; }

    .footnote {
      display: flex;
      min-width: 0;
      justify-content: space-between;
      gap: 24px;
      padding: 18px 5px 0;
      color: var(--muted);
      font-size: 10px;
      line-height: 1.5;
    }

    .footnote p { margin: 0; }

    @media (max-width: 820px) {
      .shell { width: min(100% - 24px, 700px); padding-top: 14px; }
      .local-badge { max-width: 48vw; overflow: hidden; text-overflow: ellipsis; }
      .hero { grid-template-columns: minmax(0, 1fr); border-radius: 24px 24px 0 0; }
      .hero-aside { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .hero-step { grid-template-columns: 24px minmax(0, 1fr); padding-right: 10px; border-right: 1px solid rgba(245, 241, 233, 0.15); }
      .hero-step:last-child { border-right: 0; }
      .workspace { grid-template-columns: minmax(0, 1fr); border-radius: 0 0 24px 24px; }
      .privacy-rail { border-right: 0; border-bottom: 1px solid var(--line); }
      .privacy-list { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
      .privacy-item { display: block; padding: 14px 0 0; border-bottom: 0 !important; }
      .privacy-icon { margin-bottom: 10px; }
      .tuner { grid-template-columns: minmax(0, 1fr); border-radius: 24px; }
      .tuner-intro { padding-bottom: 42px; }
    }

    @media (max-width: 560px) {
      .shell { width: calc(100% - 16px); padding-bottom: 24px; }
      .topbar { gap: 10px; padding: 0 2px 12px; }
      .brand-mark { width: 36px; height: 36px; }
      .brand-name { font-size: 19px; }
      .brand-subtitle { display: none; }
      .local-badge { max-width: 54vw; padding: 7px 9px; font-size: 9px; }
      .hero { gap: 30px; padding: 34px 24px; }
      h1 { font-size: clamp(48px, 16vw, 68px); }
      .hero-copy { font-size: 16px; }
      .hero-aside { display: block; }
      .hero-step { grid-template-columns: 28px minmax(0, 1fr); padding-right: 0; border-right: 0; }
      .privacy-rail, .importer { padding: 26px 22px; }
      .privacy-list { display: block; }
      .privacy-item { display: grid; padding: 14px 0; }
      .importer-header { display: block; }
      .limit { margin-top: 10px; }
      .drop-zone { min-height: 230px; padding: 28px 20px; }
      .file-meta { align-items: flex-start; }
      .action-row { display: block; }
      .primary-action { width: 100%; }
      .status { margin-top: 12px; }
      .stats { grid-template-columns: minmax(0, 1fr); }
      .stat { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
      .tuner-intro, .tuner-workbench { padding: 30px 22px; }
      .field-grid { grid-template-columns: minmax(0, 1fr); }
      .correction-actions { display: block; }
      .correction-actions .primary-action { width: 100%; }
      .profile-status { margin-top: 12px; }
      .profile-metrics { grid-template-columns: minmax(0, 1fr); }
      .profile-metric { display: flex; align-items: baseline; justify-content: space-between; gap: 14px; }
      .continuity-relationship { align-items: flex-start; flex-direction: column; gap: 4px; }
      .continuity-relationship span { flex: 1 1 auto; }
      .listening-patterns-metrics { grid-template-columns: minmax(0, 1fr); }
      .studio-seasons-grid { grid-template-columns: minmax(0, 1fr); }
      .listening-pattern-release { align-items: start; grid-template-columns: minmax(0, 1fr); gap: 4px; }
      .profile-artifact-link { min-height: 44px; padding: 10px 0; box-sizing: border-box; }
      .correction-item { grid-template-columns: minmax(0, 1fr); }
      .retract-action { justify-self: start; }
      .footnote { display: block; padding-inline: 3px; }
      .footnote p + p { margin-top: 6px; }
    }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; }
    }
  </style>
</head>
<body>
  <main class="shell" id="studio" data-session="${token}" data-maximum-bytes="${maximumArchiveBytes}" data-maximum-json-bytes="${maximumHistoryJsonBytes}" data-demo-only="${demoOnly}" data-session-mode="${sessionMode}" data-archive-count="${archiveCount}">
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark"><img src="/brand.png?session=${token}" alt=""></span>
        <div>
          <p class="brand-name">Moondog</p>
          <p class="brand-subtitle">Listening intelligence studio</p>
        </div>
      </div>
      <span class="local-badge">${demoOnly
        ? "127.0.0.1 - fictional tour"
        : privateInMemory
          ? "127.0.0.1 - session-only"
          : "127.0.0.1 - private session"}</span>
    </header>

    <section class="hero" aria-labelledby="hero-title">
      <div>
        <p class="eyebrow">${demoOnly
          ? "A zero-data product tour"
          : privateInMemory
            ? archiveCount === 1
              ? "One ZIP, no lasting import"
              : "Two ZIPs, one private session"
            : "Meet your listening self"}</p>
        <h1 id="hero-title">${demoOnly
          ? "A music life,<br>made legible."
          : privateInMemory
            ? "Your whole history,<br>ready now."
            : "Your history,<br>now useful."}</h1>
        <p class="hero-copy">${demoOnly
          ? "Explore a clearly fictional 52-play archive that Moondog passes through the production Spotify importer before rendering the local Time Machine, Tasteprint, and correction loop. No personal listening file is read or accepted in this tour."
          : privateInMemory
            ? archiveCount === 1
              ? "Moondog read the explicitly supplied Spotify ZIP into this local process. Your original ZIP stays untouched, and no persistent profile, provider call, model, or cloud upload is involved."
              : "Moondog reconciled the two explicitly supplied Spotify ZIPs inside this local process. Both originals stay untouched, and no persistent profile, provider call, model, or cloud upload is involved."
            : "Turn Spotify or ListenBrainz history into one private Tasteprint and a Listening Time Machine across your years. Moondog reads it on this Mac and gives the agent evidence it can act on."}</p>
        <div class="hero-preview-actions"${privateInMemory ? " hidden" : ""}>
          <button class="hero-preview-link is-primary" id="hero-demo-action" type="button">
            <span id="hero-demo-label">${demoOnly ? "Explore the real-import Time Machine" : "Try the real importer with fictional history"}</span>
            <span aria-hidden="true">→</span>
          </button>
          <a class="hero-preview-link" href="/demo-tasteprint-card?session=${token}">Preview the fictional recap card <span aria-hidden="true">→</span></a>
        </div>
      </div>
      <aside class="hero-aside" aria-label="${demoOnly
        ? "Fictional tour sequence"
        : privateInMemory
          ? "Session-only sequence"
          : "Import sequence"}">
        ${demoOnly
          ? `<div class="hero-step"><span>01</span><p>Run 52 fictional plays through the real importer.</p></div>
        <div class="hero-step"><span>02</span><p>Follow four fictional year landmarks.</p></div>
        <div class="hero-step"><span>03</span><p>Correct one reading and inspect its evidence.</p></div>`
          : privateInMemory
            ? `<div class="hero-step"><span>01</span><p>${archiveCount === 1 ? "Read the selected ZIP once" : "Reconcile both selected ZIPs"} in memory.</p></div>
        <div class="hero-step"><span>02</span><p>Open the full Tasteprint and chronological route.</p></div>
        <div class="hero-step"><span>03</span><p>Try corrections that vanish when Studio stops.</p></div>`
            : `<div class="hero-step"><span>01</span><p>Choose a Spotify ZIP or ListenBrainz JSON.</p></div>
        <div class="hero-step"><span>02</span><p>Build one private local music history.</p></div>
        <div class="hero-step"><span>03</span><p>Open a chronological route through your years.</p></div>`}
      </aside>
    </section>

    <section class="workspace" aria-labelledby="import-title"${importHidden ? " hidden aria-hidden=\"true\"" : ""}>
      <aside class="privacy-rail">
        <p class="section-label">The privacy contract</p>
        <div class="privacy-list">
          <div class="privacy-item">
            <span class="privacy-icon">1</span>
            <div><strong>Stays on this Mac</strong><p>No cloud upload, provider call, or model.</p></div>
          </div>
          <div class="privacy-item">
            <span class="privacy-icon">2</span>
            <div><strong>Source is temporary</strong><p>The working copy is removed after import.</p></div>
          </div>
          <div class="privacy-item">
            <span class="privacy-icon">3</span>
            <div><strong>Evidence stays bounded</strong><p>Private URIs and raw context do not enter the Tasteprint.</p></div>
          </div>
        </div>
      </aside>

      <div class="importer">
        <div class="importer-header">
          <div>
            <p class="section-label">Listening history import</p>
            <h2 id="import-title">Drop your history.</h2>
          </div>
          <span class="limit">ZIP ${maximumMegabytes} MB / JSON ${maximumJsonMegabytes} MB</span>
        </div>

        <input class="file-input" id="archive" type="file" accept=".zip,.json,application/zip,application/json">
        <label class="drop-zone" id="drop-zone" for="archive" tabindex="0">
          <span>
            <span class="drop-orbit" aria-hidden="true">↓</span>
            <span class="drop-title" id="drop-title">Drag Spotify ZIP or ListenBrainz JSON here</span>
            <span class="drop-copy" id="drop-copy">Account Data, Extended Streaming History, or saved ListenBrainz listens</span>
          </span>
        </label>

        <div class="file-meta" id="file-meta" aria-live="polite">
          <span class="file-name" id="file-name"></span>
          <span class="file-size" id="file-size"></span>
        </div>

        <div class="action-row">
          <button class="primary-action" id="import-action" type="button" disabled>
            <span id="action-label">Import and build Tasteprint</span>
            <span class="action-arrow" aria-hidden="true">→</span>
          </button>
          <p class="status" id="status" role="status" aria-live="polite">Nothing changes until you press import.</p>
        </div>
        <div class="progress" id="progress" aria-hidden="true"><div class="progress-bar" id="progress-bar"></div></div>

        <section class="result" id="result" aria-labelledby="result-title">
          <p class="result-kicker" id="result-kicker">Private profile ready</p>
          <h3 id="result-title">This is your listening arc.</h3>
          <p class="result-copy" id="result-copy"></p>
          <div class="stats" aria-label="Tasteprint coverage">
            <div class="stat"><span class="stat-value" id="events">0</span><span class="stat-label">listens</span></div>
            <div class="stat"><span class="stat-value" id="hours">0</span><span class="stat-label">hours</span></div>
            <div class="stat"><span class="stat-value" id="tracks">0</span><span class="stat-label">tracks</span></div>
          </div>
          <div class="result-links">
            <a class="result-link" id="result-link" href="#">Open Listening Time Machine <span aria-hidden="true">→</span></a>
            <a class="result-link is-secondary" id="result-card-link" href="#">Open recap card <span aria-hidden="true">→</span></a>
            <a class="result-link is-secondary" id="result-card-download-link" href="#" download>Download private HTML <span aria-hidden="true">↓</span></a>
          </div>
          <p class="result-boundary">The recap card is deliberately smaller, not automatically safe to share. Review every visible name, date, and aggregate first.</p>
        </section>
      </div>
    </section>

    <section class="tuner" id="profile-editor" aria-labelledby="tuner-title">
      <div class="tuner-intro">
        <p class="section-label">Your word beats inference</p>
        <h2 id="tuner-title">Correct the reading.</h2>
        <p class="tuner-lede">Listening history is evidence, not destiny. Tell Moondog what you actually like or want to avoid. The direct signal updates the next Tasteprint without rewriting a single play.</p>

        <div class="profile-state" id="profile-state">
          <div class="profile-state-head">
            <span class="profile-state-dot" aria-hidden="true"></span>
            <div>
              <span class="demo-profile-badge" id="demo-profile-badge" hidden>Fictional real-import demo</span>
              <strong id="profile-state-title">${demoOnly
                ? "Loading the fictional listening profile"
                : privateInMemory
                  ? "Reading the supplied Spotify history"
                  : "Checking this Mac for a private profile"}</strong>
              <p id="profile-state-copy">${demoOnly
                ? "A generated archive is imported in memory. No personal file or local profile is read."
                : privateInMemory
                  ? "The full profile is being built in memory without creating persistent state."
                  : "This is a read-only local check."}</p>
            </div>
          </div>
          <button class="demo-start-action" id="demo-start-action" type="button" hidden>
            <span>Run the fictional archive through the real importer</span>
            <span aria-hidden="true">→</span>
          </button>
          <div class="profile-metrics" id="profile-metrics" hidden>
            <div class="profile-metric"><strong id="profile-events">0</strong><span>listens</span></div>
            <div class="profile-metric"><strong id="profile-hours">0</strong><span>hours</span></div>
            <div class="profile-metric"><strong id="profile-corrections">0</strong><span>direct signals</span></div>
          </div>
          <p class="time-machine-coverage identity-link-coverage" id="profile-identity-link-coverage" hidden>
            <strong id="profile-identity-link-summary"></strong>
            <span id="profile-identity-link-detail"></span>
          </p>
          <div class="profile-tools" id="profile-tools" hidden>
            <button class="demo-start-action" id="profile-correct" type="button">Correct a reading</button>
            <button class="demo-start-action" id="profile-refresh" type="button">Refresh profile</button>
          </div>

          <section class="time-machine-preview" id="profile-time-machine" aria-labelledby="profile-time-machine-title" hidden>
            <div class="time-machine-preview-head">
              <strong id="profile-time-machine-title">Listening Time Machine</strong>
              <span class="time-machine-count" id="profile-time-machine-count">0 landmarks</span>
            </div>
            <p class="time-machine-coverage" id="profile-time-machine-coverage" hidden>
              <strong id="profile-time-machine-coverage-summary"></strong>
              <span id="profile-time-machine-coverage-detail"></span>
            </p>
            <ol class="time-machine-route" id="profile-time-machine-route" aria-label="Chronological listening landmarks"></ol>
            <a class="profile-artifact-link time-machine-action" id="profile-time-machine-link" href="#">Open the chronological route <span aria-hidden="true">→</span></a>
          </section>
          <section class="listening-pulse-preview" id="profile-listening-pulse" aria-labelledby="profile-listening-pulse-title" hidden>
            <div class="time-machine-preview-head">
              <strong id="profile-listening-pulse-title">Listening Pulse</strong>
              <span class="time-machine-count" id="profile-listening-pulse-count">0 active months</span>
            </div>
            <p class="listening-pulse-summary" id="profile-listening-pulse-summary"></p>
            <div class="studio-pulse-grid" id="profile-listening-pulse-grid" role="grid" aria-label="Monthly retained listening activity in UTC"></div>
            <p class="listening-pulse-boundary" id="profile-listening-pulse-boundary"></p>
            <a class="profile-artifact-link time-machine-action" id="profile-listening-pulse-link" href="#">Open the full monthly view <span aria-hidden="true">→</span></a>
          </section>
          <section class="listening-seasons-preview" id="profile-listening-seasons" aria-labelledby="profile-listening-seasons-title" hidden>
            <div class="time-machine-preview-head">
              <strong id="profile-listening-seasons-title">Listening Seasons</strong>
              <span class="time-machine-count" id="profile-listening-seasons-count">0 active seasons</span>
            </div>
            <p class="listening-seasons-summary" id="profile-listening-seasons-summary"></p>
            <div class="studio-seasons-grid" id="profile-listening-seasons-grid" aria-label="Recent fixed three-month UTC listening windows"></div>
            <p class="listening-seasons-boundary" id="profile-listening-seasons-boundary"></p>
            <a class="profile-artifact-link time-machine-action" id="profile-listening-seasons-link" href="#">Open the full seasonal view <span aria-hidden="true">→</span></a>
          </section>
          <section class="continuity-preview historical-returns-preview" id="profile-historical-returns" aria-labelledby="profile-historical-returns-title" hidden>
            <div class="time-machine-preview-head">
              <strong id="profile-historical-returns-title">Music that came back</strong>
              <span class="time-machine-count" id="profile-historical-returns-count">0 returns</span>
            </div>
            <p class="continuity-summary" id="profile-historical-returns-summary"></p>
            <ol class="continuity-relationships" id="profile-historical-returns-tracks" aria-label="Tracks that reappeared after a long gap"></ol>
            <a class="profile-artifact-link time-machine-action" id="profile-historical-returns-link" href="#">Open the return story <span aria-hidden="true">→</span></a>
          </section>
          <section class="continuity-preview back-to-back-preview" id="profile-back-to-back" aria-labelledby="profile-back-to-back-title" hidden>
            <div class="time-machine-preview-head">
              <strong id="profile-back-to-back-title">Played back to back</strong>
              <span class="time-machine-count" id="profile-back-to-back-count">0 tracks</span>
            </div>
            <p class="continuity-summary" id="profile-back-to-back-summary"></p>
            <ol class="continuity-relationships" id="profile-back-to-back-tracks" aria-label="Tracks played in adjacent retained sequences"></ol>
            <a class="profile-artifact-link time-machine-action" id="profile-back-to-back-link" href="#">Open the sequence evidence <span aria-hidden="true">→</span></a>
          </section>
          <section class="continuity-preview" id="profile-continuity" aria-labelledby="profile-continuity-title" hidden>
            <div class="time-machine-preview-head">
              <strong id="profile-continuity-title">What stayed. What changed.</strong>
              <span class="time-machine-count" id="profile-continuity-count">0 across eras</span>
            </div>
            <p class="continuity-summary" id="profile-continuity-summary"></p>
            <ol class="continuity-relationships" id="profile-continuity-relationships" aria-label="Artists present across retained listening years"></ol>
            <a class="profile-artifact-link time-machine-action" id="profile-continuity-link" href="#">Open continuity and change <span aria-hidden="true">→</span></a>
          </section>
          <section class="listening-patterns-preview" id="profile-listening-patterns" aria-labelledby="profile-listening-patterns-title" hidden>
            <div class="time-machine-preview-head">
              <strong id="profile-listening-patterns-title">The shape of a listening stretch</strong>
              <span class="time-machine-count" id="profile-listening-patterns-count">Extended History</span>
            </div>
            <p class="listening-patterns-summary" id="profile-listening-patterns-summary"></p>
            <div class="listening-patterns-metrics" id="profile-listening-patterns-metrics" hidden>
              <div class="listening-patterns-metric"><strong id="profile-session-count">0</strong><span>approx sessions</span></div>
              <div class="listening-patterns-metric"><strong id="profile-session-median">0</strong><span>median plays</span></div>
              <div class="listening-patterns-metric"><strong id="profile-session-extended">0%</strong><span id="profile-session-extended-label">5+ play stretches</span></div>
            </div>
            <ol class="listening-pattern-releases" id="profile-listening-pattern-releases" aria-label="Multi-track releases in retained listening history"></ol>
            <a class="profile-artifact-link time-machine-action" id="profile-listening-patterns-link" href="#">Open listening patterns <span aria-hidden="true">→</span></a>
          </section>
          <div class="profile-artifact-links">
            <a class="profile-artifact-link" id="profile-card-link" href="#" hidden>Open recap card <span aria-hidden="true">→</span></a>
            <a class="profile-artifact-link" id="profile-card-download-link" href="#" download hidden>Download private HTML <span aria-hidden="true">↓</span></a>
            <a class="profile-artifact-link" id="profile-tasteprint-link" href="#" hidden>Open current Tasteprint <span aria-hidden="true">→</span></a>
          </div>
        </div>
      </div>

      <div class="tuner-workbench">
        <form id="correction-form" aria-label="Correct a listening preference">
          <fieldset class="correction-fieldset" id="correction-fields" disabled>
            <legend class="section-label">One direct signal</legend>

            <div class="control-block">
              <span class="control-label">Correct an</span>
              <div class="choice-group" role="radiogroup" aria-label="Correction target type">
                <input id="entity-artist" name="entity-type" type="radio" value="artist" checked>
                <label for="entity-artist">Artist</label>
                <input id="entity-track" name="entity-type" type="radio" value="track">
                <label for="entity-track">Track</label>
              </div>
            </div>

            <div class="field-grid">
              <label class="field">
                <span class="control-label" id="target-label">Artist name</span>
                <input class="text-input" id="correction-label" name="label" type="text" maxlength="512" autocomplete="off" placeholder="Portishead" required>
              </label>
              <label class="field" id="artist-credit-field" hidden>
                <span class="control-label">Track artist</span>
                <input class="text-input" id="artist-credit" name="artist-credit" type="text" maxlength="512" autocomplete="off" placeholder="Portishead">
              </label>
            </div>

            <div class="control-block">
              <span class="control-label">Current stance</span>
              <div class="choice-group" role="radiogroup" aria-label="Correction stance">
                <input id="stance-like" name="stance" type="radio" value="like" required checked>
                <label for="stance-like">I like this</label>
                <input id="stance-avoid" name="stance" type="radio" value="avoid">
                <label for="stance-avoid">Avoid this</label>
              </div>
            </div>

            <label class="field control-block">
              <span class="control-label" id="correction-note-label">Private note - optional</span>
              <textarea class="text-input" id="correction-note" name="note" maxlength="2000" placeholder="Why this signal matters to you"></textarea>
              <p class="field-hint" id="correction-note-hint">The note stays local and can appear in your Tasteprint. It is not sent as model profile context.</p>
            </label>

            <div class="correction-actions">
              <button class="primary-action" id="correction-action" type="submit">
                <span id="correction-action-label">Apply to Tasteprint</span>
                <span class="action-arrow" aria-hidden="true">→</span>
              </button>
              <p class="profile-status" id="profile-status" role="status" aria-live="polite">${demoOnly
                ? "Running fictional history through the production importer."
                : privateInMemory
                  ? archiveCount === 1
                    ? "Reading the supplied ZIP into this private session."
                    : "Reconciling both supplied ZIPs inside this private session."
                  : "Import listening history to begin."}</p>
            </div>
            <button class="retract-action" id="correction-return" type="button" hidden>Back to listening view</button>
          </fieldset>
        </form>

        <section class="active-corrections" aria-labelledby="active-corrections-title">
          <div class="active-corrections-head">
            <h3 id="active-corrections-title">Active corrections</h3>
            <span class="correction-count" id="correction-count">0 active</span>
          </div>
          <p class="correction-empty" id="correction-empty">No direct corrections yet. Add a signal to guide the reading. Your listening history stays intact.</p>
          <div class="correction-list" id="correction-list"></div>
        </section>
      </div>
    </section>

    <footer class="footnote">
      <p>${demoOnly
        ? "This tour never reads or accepts personal listening history and writes no persistent profile."
        : privateInMemory
          ? `This private session keeps its profile and corrections only in memory. Stopping Studio discards them; ${archiveCount === 1 ? "the original ZIP remains" : "both original ZIPs remain"} untouched.`
          : "Keep this terminal session running while Studio is open."}</p>
      <p>Press Ctrl+C in the terminal to stop the local server.</p>
    </footer>
  </main>

  <script nonce="${safeNonce}">
    (() => {
      const studio = document.querySelector("#studio");
      const input = document.querySelector("#archive");
      const dropZone = document.querySelector("#drop-zone");
      const dropTitle = document.querySelector("#drop-title");
      const dropCopy = document.querySelector("#drop-copy");
      const fileMeta = document.querySelector("#file-meta");
      const fileName = document.querySelector("#file-name");
      const fileSize = document.querySelector("#file-size");
      const action = document.querySelector("#import-action");
      const actionLabel = document.querySelector("#action-label");
      const status = document.querySelector("#status");
      const progress = document.querySelector("#progress");
      const progressBar = document.querySelector("#progress-bar");
      const result = document.querySelector("#result");
      const resultLink = document.querySelector("#result-link");
      const resultCardLink = document.querySelector("#result-card-link");
      const resultCardDownloadLink = document.querySelector("#result-card-download-link");
      const heroDemoAction = document.querySelector("#hero-demo-action");
      const heroDemoLabel = document.querySelector("#hero-demo-label");
      const profileState = document.querySelector("#profile-state");
      const profileStateTitle = document.querySelector("#profile-state-title");
      const profileStateCopy = document.querySelector("#profile-state-copy");
      const demoProfileBadge = document.querySelector("#demo-profile-badge");
      const demoStartAction = document.querySelector("#demo-start-action");
      const profileMetrics = document.querySelector("#profile-metrics");
      const profileEvents = document.querySelector("#profile-events");
      const profileHours = document.querySelector("#profile-hours");
      const profileCorrections = document.querySelector("#profile-corrections");
      const profileIdentityLinkCoverage = document.querySelector("#profile-identity-link-coverage");
      const profileIdentityLinkSummary = document.querySelector("#profile-identity-link-summary");
      const profileIdentityLinkDetail = document.querySelector("#profile-identity-link-detail");
      const profileTimeMachine = document.querySelector("#profile-time-machine");
      const profileTimeMachineCount = document.querySelector("#profile-time-machine-count");
      const profileTimeMachineCoverage = document.querySelector("#profile-time-machine-coverage");
      const profileTimeMachineCoverageSummary = document.querySelector("#profile-time-machine-coverage-summary");
      const profileTimeMachineCoverageDetail = document.querySelector("#profile-time-machine-coverage-detail");
      const profileTimeMachineRoute = document.querySelector("#profile-time-machine-route");
      const profileTimeMachineLink = document.querySelector("#profile-time-machine-link");
      const profileListeningPulse = document.querySelector("#profile-listening-pulse");
      const profileListeningPulseCount = document.querySelector("#profile-listening-pulse-count");
      const profileListeningPulseSummary = document.querySelector("#profile-listening-pulse-summary");
      const profileListeningPulseGrid = document.querySelector("#profile-listening-pulse-grid");
      const profileListeningPulseBoundary = document.querySelector("#profile-listening-pulse-boundary");
      const profileListeningPulseLink = document.querySelector("#profile-listening-pulse-link");
      const profileListeningSeasons = document.querySelector("#profile-listening-seasons");
      const profileListeningSeasonsCount = document.querySelector("#profile-listening-seasons-count");
      const profileListeningSeasonsSummary = document.querySelector("#profile-listening-seasons-summary");
      const profileListeningSeasonsGrid = document.querySelector("#profile-listening-seasons-grid");
      const profileListeningSeasonsBoundary = document.querySelector("#profile-listening-seasons-boundary");
      const profileListeningSeasonsLink = document.querySelector("#profile-listening-seasons-link");
      const profileHistoricalReturns = document.querySelector("#profile-historical-returns");
      const profileHistoricalReturnsCount = document.querySelector("#profile-historical-returns-count");
      const profileHistoricalReturnsSummary = document.querySelector("#profile-historical-returns-summary");
      const profileHistoricalReturnTracks = document.querySelector("#profile-historical-returns-tracks");
      const profileHistoricalReturnsLink = document.querySelector("#profile-historical-returns-link");
      const profileBackToBack = document.querySelector("#profile-back-to-back");
      const profileBackToBackCount = document.querySelector("#profile-back-to-back-count");
      const profileBackToBackSummary = document.querySelector("#profile-back-to-back-summary");
      const profileBackToBackTracks = document.querySelector("#profile-back-to-back-tracks");
      const profileBackToBackLink = document.querySelector("#profile-back-to-back-link");
      const profileContinuity = document.querySelector("#profile-continuity");
      const profileContinuityCount = document.querySelector("#profile-continuity-count");
      const profileContinuitySummary = document.querySelector("#profile-continuity-summary");
      const profileContinuityRelationships = document.querySelector("#profile-continuity-relationships");
      const profileContinuityLink = document.querySelector("#profile-continuity-link");
      const profileListeningPatterns = document.querySelector("#profile-listening-patterns");
      const profileListeningPatternsCount = document.querySelector("#profile-listening-patterns-count");
      const profileListeningPatternsSummary = document.querySelector("#profile-listening-patterns-summary");
      const profileListeningPatternsMetrics = document.querySelector("#profile-listening-patterns-metrics");
      const profileSessionCount = document.querySelector("#profile-session-count");
      const profileSessionMedian = document.querySelector("#profile-session-median");
      const profileSessionExtended = document.querySelector("#profile-session-extended");
      const profileSessionExtendedLabel = document.querySelector("#profile-session-extended-label");
      const profileListeningPatternReleases = document.querySelector("#profile-listening-pattern-releases");
      const profileListeningPatternsLink = document.querySelector("#profile-listening-patterns-link");
      const profileTasteprintLink = document.querySelector("#profile-tasteprint-link");
      const profileCardLink = document.querySelector("#profile-card-link");
      const profileCardDownloadLink = document.querySelector("#profile-card-download-link");
      const correctionForm = document.querySelector("#correction-form");
      const correctionReturn = document.querySelector("#correction-return");
      const profileTools = document.querySelector("#profile-tools");
      const profileCorrect = document.querySelector("#profile-correct");
      const profileRefresh = document.querySelector("#profile-refresh");
      const correctionFields = document.querySelector("#correction-fields");
      const correctionLabel = document.querySelector("#correction-label");
      const targetLabel = document.querySelector("#target-label");
      const artistCreditField = document.querySelector("#artist-credit-field");
      const artistCredit = document.querySelector("#artist-credit");
      const correctionNote = document.querySelector("#correction-note");
      const correctionNoteLabel = document.querySelector("#correction-note-label");
      const correctionNoteHint = document.querySelector("#correction-note-hint");
      const correctionActionLabel = document.querySelector("#correction-action-label");
      const profileStatus = document.querySelector("#profile-status");
      const correctionCount = document.querySelector("#correction-count");
      const correctionEmpty = document.querySelector("#correction-empty");
      const correctionList = document.querySelector("#correction-list");
      const sessionToken = studio.dataset.session;
      const maximumBytes = Number(studio.dataset.maximumBytes);
      const maximumJsonBytes = Number(studio.dataset.maximumJsonBytes);
      const studioMode = studio.dataset.sessionMode || "persistent";
      const archiveMode = studioMode === "archive";
      const archiveCount = Number(studio.dataset.archiveCount) || 0;
      const portableCardUrl = (value) => {
        const url = new URL(value, window.location.origin);
        url.searchParams.set("download", "1");
        return url.pathname + url.search;
      };
      let selectedFile = null;
      let selectedFileKind = null;
      let busy = false;
      let profileReady = false;
      let profileBusy = false;
      let profileMode = "empty";
      let correctionOrigin = null;

      const formatNumber = (value, maximumFractionDigits = 0) =>
        new Intl.NumberFormat("en-US", { maximumFractionDigits }).format(Number(value) || 0);

      const formatCompactNumber = (value) =>
        new Intl.NumberFormat("en-US", {
          notation: "compact",
          maximumFractionDigits: 1,
        }).format(Number(value) || 0);

      const formatNaturalList = (items) => {
        if (items.length === 0) return "";
        if (items.length === 1) return items[0];
        if (items.length === 2) return items[0] + " and " + items[1];
        return items.slice(0, -1).join(", ") + ", and " + items.at(-1);
      };

      const formatBytes = (value) => {
        if (value < 1024 * 1024) return formatNumber(value / 1024, 1) + " KB";
        return formatNumber(value / (1024 * 1024), 1) + " MB";
      };

      const setStatus = (message, error = false) => {
        status.textContent = message;
        status.classList.toggle("is-error", error);
      };

      const setProfileStatus = (message, error = false) => {
        profileStatus.textContent = message;
        profileStatus.classList.toggle("is-error", error);
      };

      const syncAvailability = () => {
        input.disabled = archiveMode || busy || profileBusy;
        action.disabled = archiveMode || busy || profileBusy || !selectedFile;
        heroDemoAction.disabled = busy || profileBusy;
        demoStartAction.disabled = busy || profileBusy;
        correctionFields.disabled = !profileReady || busy || profileBusy;
        profileCorrect.disabled = !profileReady || busy || profileBusy;
        profileRefresh.disabled = busy || profileBusy;
        for (const button of document.querySelectorAll("[data-correction-shortcut]")) {
          button.disabled = !profileReady || busy || profileBusy;
        }
      };

      const selectedEntityType = () =>
        correctionForm.elements.namedItem("entity-type").value;

      const syncTargetFields = () => {
        const track = selectedEntityType() === "track";
        artistCreditField.hidden = !track;
        artistCredit.required = track;
        targetLabel.textContent = track ? "Track title" : "Artist name";
        correctionLabel.placeholder = track ? "Roads" : "Portishead";
      };

      const focusSection = (element) => {
        element.scrollIntoView({ block: "start", behavior: "instant" });
        element.focus({ preventScroll: true });
      };

      const startCorrection = (track = null, origin = profileState) => {
        if (!profileReady || busy || profileBusy) return;
        correctionOrigin = origin;
        correctionReturn.hidden = false;
        if (track) {
          correctionForm.elements.namedItem("entity-type").value = "track";
          correctionLabel.value = track.title;
          artistCredit.value = track.artist;
          for (const radio of correctionForm.elements.namedItem("stance")) {
            radio.checked = false;
          }
          correctionNote.value = "";
          syncTargetFields();
          setProfileStatus("Choose like or avoid for this track, then apply. Nothing has changed yet.");
        }
        correctionForm.scrollIntoView({ block: "start", behavior: "instant" });
        (track ? document.querySelector("#stance-like") : correctionLabel).focus({ preventScroll: true });
      };

      const trackCorrectionButton = (track, origin) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "track-correction-action";
        button.dataset.correctionShortcut = "track";
        button.textContent = "Correct this track";
        button.setAttribute("aria-label", "Correct " + track.title + " by " + track.artist);
        button.addEventListener("click", () => startCorrection(track, origin));
        return button;
      };

      profileCorrect.addEventListener("click", () => startCorrection());
      correctionReturn.addEventListener("click", () => {
        const target = correctionOrigin && !correctionOrigin.hidden
          ? correctionOrigin : profileState;
        target.tabIndex = -1;
        focusSection(target);
      });
      profileRefresh.addEventListener("click", async () => {
        if (busy || profileBusy) return;
        profileBusy = true;
        profileRefresh.textContent = "Refreshing...";
        syncAvailability();
        try {
          await loadProfile();
        } catch {
          // loadProfile already renders the actionable local error.
        } finally {
          profileBusy = false;
          profileRefresh.textContent = "Refresh profile";
          syncAvailability();
        }
      });

      const formatDate = (value) => {
        const date = new Date(value);
        if (Number.isNaN(date.valueOf())) return "now";
        return new Intl.DateTimeFormat("en-US", {
          year: "numeric",
          month: "short",
          day: "numeric",
          timeZone: "UTC",
        }).format(date);
      };

      const renderCorrections = (corrections) => {
        const items = Array.isArray(corrections) ? corrections : [];
        correctionCount.textContent = formatNumber(items.length) + " active";
        correctionEmpty.hidden = items.length > 0;
        correctionList.replaceChildren();
        for (const correction of items) {
          const item = document.createElement("article");
          item.className = "correction-item";

          const main = document.createElement("div");
          main.className = "correction-item-main";
          const meta = document.createElement("div");
          meta.className = "correction-meta";
          const chip = document.createElement("span");
          chip.className = "correction-chip" + (correction.stance === "avoid" ? " is-avoid" : "");
          chip.textContent = correction.stance === "avoid" ? "Avoid" : "Like";
          const type = document.createElement("span");
          type.className = "correction-type";
          type.textContent = correction.entity_type === "track" ? "Track" : "Artist";
          const time = document.createElement("span");
          time.className = "correction-time";
          time.textContent = formatDate(correction.occurred_at);
          meta.append(chip, type, time);

          const title = document.createElement("strong");
          title.className = "correction-title";
          title.textContent = correction.label;
          main.append(meta, title);
          if (correction.artist_credit) {
            const artist = document.createElement("p");
            artist.className = "correction-artist";
            artist.textContent = "by " + correction.artist_credit;
            main.append(artist);
          }
          if (correction.note) {
            const note = document.createElement("p");
            note.className = "correction-note";
            note.textContent = correction.note;
            main.append(note);
          }

          const retract = document.createElement("button");
          retract.className = "retract-action";
          retract.type = "button";
          retract.textContent = "Retract";
          retract.addEventListener("click", () => retractCorrection(correction, retract));
          item.append(main, retract);
          correctionList.append(item);
        }
      };

      const renderIdentityLinkCoverage = (coverage) => {
        const links = Number.isInteger(coverage && coverage.cross_format_track_links)
          ? coverage.cross_format_track_links
          : 0;
        const events = Number.isInteger(coverage && coverage.cross_format_linked_events)
          ? coverage.cross_format_linked_events
          : 0;
        const ambiguousTracks = Number.isInteger(
          coverage && coverage.cross_format_ambiguous_tracks,
        )
          ? coverage.cross_format_ambiguous_tracks
          : 0;
        const ambiguousEvents = Number.isInteger(
          coverage && coverage.cross_format_ambiguous_events,
        )
          ? coverage.cross_format_ambiguous_events
          : 0;
        const visible = links > 0 || ambiguousTracks > 0;
        const details = [];
        if (links > 0) {
          details.push(
            "Exact overlapping plays support behavioral aggregation across " +
              formatNumber(events) + " effective " +
              (events === 1 ? "event." : "events."),
          );
        }
        if (ambiguousTracks > 0) {
          details.push(
            "Multi-target cases stay separate: " +
              formatNumber(ambiguousTracks) + " provisional " +
              (ambiguousTracks === 1 ? "identity" : "identities") +
              " across " + formatNumber(ambiguousEvents) + " effective " +
              (ambiguousEvents === 1 ? "event" : "events") +
              " were not joined because exact overlaps point to multiple resolved Spotify identities.",
          );
        } else if (links > 0) {
          details.push("Multi-target cases stay separate.");
        }
        if (visible) details.push("Original records remain intact.");
        profileIdentityLinkCoverage.hidden = !visible;
        profileIdentityLinkSummary.textContent = !visible
          ? ""
          : links > 0
            ? formatNumber(links) + " provisional track " +
              (links === 1 ? "identity" : "identities") +
              " joined to resolved Spotify identities."
            : formatNumber(ambiguousTracks) + " ambiguous provisional track " +
              (ambiguousTracks === 1 ? "identity remains" : "identities remain") +
              " separate.";
        profileIdentityLinkDetail.textContent = details.join(" ");
      };

      const renderTimeMachine = (timeMachine, tasteprintUrl) => {
        const landmarks = Array.isArray(timeMachine && timeMachine.landmarks)
          ? timeMachine.landmarks
          : [];
        const ready = timeMachine && timeMachine.ready === true && landmarks.length >= 2 && tasteprintUrl;
        profileTimeMachineRoute.replaceChildren();
        profileTimeMachineCoverage.hidden = true;
        profileTimeMachineCoverageSummary.textContent = "";
        profileTimeMachineCoverageDetail.textContent = "";
        profileTimeMachine.hidden = !ready;
        if (!ready) return false;
        profileTimeMachineCount.textContent = formatNumber(timeMachine.landmark_count) + " landmarks";
        const retainedYearCount = Number.isInteger(timeMachine.retained_year_count)
          ? timeMachine.retained_year_count
          : 0;
        const representedYearCount = Number.isInteger(timeMachine.represented_year_count)
          ? timeMachine.represented_year_count
          : landmarks.length;
        const unrepresentedYears = Array.isArray(timeMachine.unrepresented_years)
          ? timeMachine.unrepresented_years.filter(Number.isInteger).map(String)
          : [];
        if (retainedYearCount > 0) {
          const retainedNoun = retainedYearCount === 1 ? "year" : "years";
          const coverageCopy = formatNumber(representedYearCount) + " of " +
            formatNumber(retainedYearCount) + " retained " + retainedNoun + " represented.";
          const omittedCopy = unrepresentedYears.length === 0
            ? "Every retained year has a selected landmark."
            : unrepresentedYears.length === 1
              ? unrepresentedYears[0] + " remains in the listening arc but has no selected landmark."
              : formatNaturalList(unrepresentedYears) + " remain in the listening arc but have no selected landmarks.";
          const engagedPlays = Number(timeMachine.minimum_engaged_plays);
          const listeningMinutes = Number(timeMachine.minimum_listening_minutes);
          const thresholdCopy = engagedPlays >= 1 && listeningMinutes >= 1
            ? " Candidates come from a track's strongest retained year, clear active avoids, and need at least " +
              formatNumber(engagedPlays) + " engaged plays and " + formatNumber(listeningMinutes, 1) + " listening minutes."
            : " Candidates come from a track's strongest retained year and clear active avoids.";
          profileTimeMachineCoverageSummary.textContent = coverageCopy;
          profileTimeMachineCoverageDetail.textContent = omittedCopy + thresholdCopy;
          profileTimeMachineCoverage.hidden = false;
        }
        for (const landmark of landmarks.slice(0, 4)) {
          const item = document.createElement("li");
          item.className = "time-machine-landmark";
          const year = document.createElement("span");
          year.className = "time-machine-year";
          year.textContent = String(landmark.year);
          const track = document.createElement("span");
          track.className = "time-machine-track";
          const title = document.createElement("strong");
          title.textContent = landmark.title;
          const artist = document.createElement("span");
          artist.textContent = landmark.artist;
          track.append(title, artist);
          track.append(trackCorrectionButton(landmark, profileTimeMachine));
          item.append(year, track);
          profileTimeMachineRoute.append(item);
        }
        profileTimeMachineLink.href = tasteprintUrl + "#time-machine";
        return true;
      };

      const renderListeningPulse = (pulse, tasteprintUrl) => {
        const months = Array.isArray(pulse && pulse.months) ? pulse.months : [];
        const ready = pulse && pulse.ready === true && months.length > 0 && tasteprintUrl;
        profileListeningPulseGrid.replaceChildren();
        profileListeningPulseSummary.textContent = "";
        profileListeningPulseBoundary.textContent = "";
        profileListeningPulse.hidden = !ready;
        if (!ready) return false;

        const monthLabels = [
          ["J", "January"], ["F", "February"], ["M", "March"],
          ["A", "April"], ["M", "May"], ["J", "June"],
          ["J", "July"], ["A", "August"], ["S", "September"],
          ["O", "October"], ["N", "November"], ["D", "December"],
        ];
        const activeMonths = Number.isInteger(pulse.active_month_count)
          ? pulse.active_month_count
          : months.filter((month) => month.event_count > 0).length;
        const previewActiveMonths = Number.isInteger(
          pulse.preview_active_month_count,
        )
          ? pulse.preview_active_month_count
          : months.filter((month) => month.event_count > 0).length;
        const previewMonthCount = Number.isInteger(pulse.preview_month_count)
          ? pulse.preview_month_count
          : months.length;
        const peakMinutes = Number.isFinite(pulse.peak_listening_minutes)
          ? pulse.peak_listening_minutes
          : Math.max(...months.map((month) => month.listening_minutes));
        profileListeningPulseCount.textContent = formatNumber(activeMonths) +
          (activeMonths === 1 ? " active month" : " active months");
        profileListeningPulseSummary.textContent =
          formatNumber(previewActiveMonths) + " of " +
          formatNumber(previewMonthCount) +
          " displayed UTC months contain eligible retained events. Color compares listening minutes only within this displayed window.";

        const corner = document.createElement("span");
        corner.className = "studio-pulse-corner";
        corner.textContent = "UTC";
        corner.setAttribute("aria-hidden", "true");
        profileListeningPulseGrid.append(corner);
        for (const [short, long] of monthLabels) {
          const label = document.createElement("span");
          label.className = "studio-pulse-month";
          label.textContent = short;
          label.title = long;
          label.setAttribute("aria-hidden", "true");
          profileListeningPulseGrid.append(label);
        }

        const byMonth = new Map(months.map((month) => [month.month, month]));
        const firstYear = Number(months[0].month.slice(0, 4));
        const lastYear = Number(months.at(-1).month.slice(0, 4));
        for (let year = firstYear; year <= lastYear; year += 1) {
          const yearLabel = document.createElement("span");
          yearLabel.className = "studio-pulse-year";
          yearLabel.textContent = String(year);
          yearLabel.setAttribute("role", "rowheader");
          profileListeningPulseGrid.append(yearLabel);
          for (let monthIndex = 0; monthIndex < 12; monthIndex += 1) {
            const key = String(year) + "-" + String(monthIndex + 1).padStart(2, "0");
            const month = byMonth.get(key);
            const cell = document.createElement("span");
            cell.className = "studio-pulse-cell";
            if (!month) {
              cell.classList.add("is-outside");
              cell.setAttribute("aria-hidden", "true");
              profileListeningPulseGrid.append(cell);
              continue;
            }
            const level = month.listening_minutes <= 0 || peakMinutes <= 0
              ? 0
              : Math.max(
                  1,
                  Math.min(
                    4,
                    Math.ceil(
                      Math.sqrt(month.listening_minutes / peakMinutes) * 4,
                    ),
                  ),
                );
            cell.classList.add("level-" + level);
            const description = month.event_count > 0
              ? monthLabels[monthIndex][1] + " " + year + ": " +
                formatNumber(month.event_count) + " eligible events, " +
                formatNumber(month.listening_minutes) + " listening minutes."
              : monthLabels[monthIndex][1] + " " + year +
                ": no retained eligible events.";
            cell.title = description;
            cell.setAttribute("role", "gridcell");
            cell.setAttribute("aria-label", description);
            profileListeningPulseGrid.append(cell);
          }
        }

        const previewOmitted = Number.isInteger(pulse.preview_omitted_month_count)
          ? pulse.preview_omitted_month_count
          : 0;
        const projectionOmitted = Number.isInteger(
          pulse.omitted_earlier_month_count,
        )
          ? pulse.omitted_earlier_month_count
          : 0;
        const boundedNotes = [];
        if (previewOmitted > 0) {
          boundedNotes.push(
            "Studio shows the latest " + formatNumber(previewMonthCount) +
              " represented months; " + formatNumber(previewOmitted) +
              " earlier represented months remain in the full Tasteprint.",
          );
        }
        if (projectionOmitted > 0) {
          boundedNotes.push(
            formatNumber(projectionOmitted) +
              " still-earlier months sit outside the 240-month projection limit.",
          );
        }
        boundedNotes.push(
          "A blank cell means no eligible retained event appears in that UTC month, not proof that no listening occurred.",
        );
        profileListeningPulseBoundary.textContent = boundedNotes.join(" ");
        profileListeningPulseLink.href = tasteprintUrl + "#listening-pulse";
        return true;
      };

      const renderListeningSeasons = (value, tasteprintUrl) => {
        const seasons = Array.isArray(value && value.seasons)
          ? value.seasons
          : [];
        const ready = value && value.ready === true &&
          seasons.some((season) => season.event_count > 0) && tasteprintUrl;
        profileListeningSeasonsGrid.replaceChildren();
        profileListeningSeasonsSummary.textContent = "";
        profileListeningSeasonsBoundary.textContent = "";
        profileListeningSeasons.hidden = !ready;
        if (!ready) return false;

        const activeSeasonCount = Number.isInteger(value.active_season_count)
          ? value.active_season_count
          : seasons.filter((season) => season.event_count > 0).length;
        const previewSeasonCount = Number.isInteger(value.preview_season_count)
          ? value.preview_season_count
          : seasons.length;
        const previewActiveSeasonCount = Number.isInteger(
          value.preview_active_season_count,
        )
          ? value.preview_active_season_count
          : seasons.filter((season) => season.event_count > 0).length;
        profileListeningSeasonsCount.textContent =
          formatNumber(activeSeasonCount) +
          (activeSeasonCount === 1 ? " active season" : " active seasons");
        profileListeningSeasonsSummary.textContent =
          "The latest " + formatNumber(previewSeasonCount) +
          " fixed UTC calendar quarters are shown, including " +
          formatNumber(previewActiveSeasonCount) +
          " with eligible retained events.";

        const monthNames = [
          "Jan", "Feb", "Mar", "Apr", "May", "Jun",
          "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
        ];
        for (const season of seasons) {
          const card = document.createElement("article");
          card.className = "studio-season quarter-" + season.key.slice(6);
          const head = document.createElement("div");
          head.className = "studio-season-head";
          const key = document.createElement("strong");
          key.textContent = season.key.replace("-", " ");
          const range = document.createElement("span");
          const firstMonth = Number(season.start_month.slice(5, 7));
          const lastMonth = Number(season.end_month.slice(5, 7));
          range.textContent = monthNames[firstMonth - 1] === monthNames[lastMonth - 1]
            ? monthNames[firstMonth - 1] + " UTC"
            : monthNames[firstMonth - 1] + "-" +
              monthNames[lastMonth - 1] + " UTC";
          head.append(key, range);
          card.append(head);

          if (season.event_count === 0) {
            card.classList.add("is-empty");
            const empty = document.createElement("p");
            empty.className = "studio-season-empty";
            empty.textContent = "No retained eligible events in this window.";
            const retained = document.createElement("small");
            retained.textContent = formatNumber(season.retained_month_count) +
              " of 3 months retained";
            card.append(empty, retained);
            profileListeningSeasonsGrid.append(card);
            continue;
          }

          const total = document.createElement("div");
          total.className = "studio-season-total";
          const time = document.createElement("strong");
          time.textContent = season.listening_minutes < 120
            ? formatNumber(season.listening_minutes) + " min"
            : formatNumber(season.listening_minutes / 60, 1) + " h";
          const events = document.createElement("span");
          events.textContent = formatNumber(season.event_count) + " events / " +
            formatNumber(season.distinct_tracks) + " tracks";
          total.append(time, events);

          const mix = document.createElement("div");
          mix.className = "studio-season-mix";
          const firstObservedShare = season.distinct_tracks > 0
            ? Math.max(
                0,
                Math.min(
                  100,
                  (season.first_observed_tracks / season.distinct_tracks) * 100,
                ),
              )
            : 0;
          const mixFill = document.createElement("span");
          mixFill.style.width = firstObservedShare + "%";
          mix.append(mixFill);
          mix.setAttribute(
            "aria-label",
            formatNumber(season.first_observed_tracks) +
              " tracks first observed in retained history and " +
              formatNumber(season.returning_tracks) +
              " seen in an earlier retained season",
          );
          const mixLabel = document.createElement("p");
          mixLabel.className = "studio-season-mix-label";
          const first = document.createElement("span");
          first.textContent = formatNumber(season.first_observed_tracks) +
            " first";
          const returning = document.createElement("span");
          returning.textContent = formatNumber(season.returning_tracks) +
            " seen earlier";
          mixLabel.append(first, returning);

          const leading = document.createElement("div");
          leading.className = "studio-season-anchor";
          const leadingLabel = document.createElement("span");
          leadingLabel.textContent = "Leading artist";
          const leadingName = document.createElement("strong");
          leadingName.textContent = season.leading_artist;
          leading.append(leadingLabel, leadingName);

          const signature = document.createElement("div");
          signature.className = "studio-season-anchor";
          const signatureLabel = document.createElement("span");
          signatureLabel.textContent = "Signature track";
          const signatureTitle = document.createElement("strong");
          signatureTitle.textContent = season.signature_track.title;
          const signatureArtist = document.createElement("small");
          signatureArtist.textContent = season.signature_track.artist;
          signature.append(
            signatureLabel,
            signatureTitle,
            signatureArtist,
          );
          card.append(total, mix, mixLabel, leading, signature);
          profileListeningSeasonsGrid.append(card);
        }

        const previewOmitted = Number.isInteger(
          value.preview_omitted_season_count,
        )
          ? value.preview_omitted_season_count
          : 0;
        const previewOmittedActive = Number.isInteger(
          value.preview_omitted_active_season_count,
        )
          ? value.preview_omitted_active_season_count
          : 0;
        const projectionOmitted = Number.isInteger(
          value.omitted_earlier_season_count,
        )
          ? value.omitted_earlier_season_count
          : 0;
        const notes = [];
        if (previewOmitted > 0) {
          notes.push(
            formatNumber(previewOmitted) +
              " earlier represented seasons, including " +
              formatNumber(previewOmittedActive) +
              " active seasons, remain in the full Tasteprint.",
          );
        }
        if (projectionOmitted > 0) {
          notes.push(
            formatNumber(projectionOmitted) +
              " still-earlier seasons sit outside the 80-season projection.",
          );
        }
        notes.push(
          "First observed means first appearance in retained history, not discovery. These fixed windows do not infer mood or life events.",
        );
        profileListeningSeasonsBoundary.textContent = notes.join(" ");
        profileListeningSeasonsLink.href = tasteprintUrl + "#listening-seasons";
        return true;
      };

      const renderHistoricalReturns = (historicalReturns, tasteprintUrl) => {
        const tracks = Array.isArray(historicalReturns && historicalReturns.tracks)
          ? historicalReturns.tracks
          : [];
        const ready = historicalReturns && historicalReturns.ready === true &&
          tracks.length > 0 && tasteprintUrl;
        profileHistoricalReturnTracks.replaceChildren();
        profileHistoricalReturnsSummary.textContent = "";
        profileHistoricalReturns.hidden = !ready;
        if (!ready) return false;
        const returnTrackCount = Number.isInteger(
          historicalReturns.return_track_count,
        )
          ? historicalReturns.return_track_count
          : tracks.length;
        const minimumGapDays = Number.isInteger(
          historicalReturns.minimum_gap_days,
        )
          ? historicalReturns.minimum_gap_days
          : null;
        profileHistoricalReturnsCount.textContent =
          formatNumber(returnTrackCount) +
          (returnTrackCount === 1 ? " return track" : " return tracks");
        profileHistoricalReturnsSummary.textContent = minimumGapDays
          ? "Each track reappeared after at least " +
            formatNumber(minimumGapDays) +
            " quiet days. This is an observed return pattern, not a claim of nostalgia or current preference."
          : "These tracks reappeared after a long gap. This is an observed return pattern, not a claim of nostalgia or current preference.";
        for (const track of tracks.slice(0, 4)) {
          const item = document.createElement("li");
          item.className = "continuity-relationship";
          const identity = document.createElement("div");
          identity.className = "historical-return-identity";
          const title = document.createElement("strong");
          title.textContent = track.title;
          const artist = document.createElement("p");
          artist.textContent = track.artist;
          identity.append(title, artist);
          identity.append(trackCorrectionButton(track, profileHistoricalReturns));
          const gap = document.createElement("span");
          gap.textContent = formatNumber(track.return_count) +
            (track.return_count === 1 ? " return" : " returns") +
            " · " + formatNumber(track.longest_gap_days) + "d max";
          item.append(identity, gap);
          profileHistoricalReturnTracks.append(item);
        }
        profileHistoricalReturnsLink.href = tasteprintUrl + "#tracks-that-stay";
        return true;
      };

      const renderBackToBack = (backToBack, tasteprintUrl) => {
        const tracks = Array.isArray(backToBack && backToBack.tracks)
          ? backToBack.tracks
          : [];
        const ready = backToBack && backToBack.ready === true &&
          tracks.length > 0 && tasteprintUrl;
        profileBackToBackTracks.replaceChildren();
        profileBackToBackSummary.textContent = "";
        profileBackToBack.hidden = !ready;
        if (!ready) return false;
        const trackCount = Number.isInteger(backToBack.track_count)
          ? backToBack.track_count
          : tracks.length;
        profileBackToBackCount.textContent =
          formatNumber(trackCount) + (trackCount === 1 ? " track" : " tracks");
        const minimumPlays = Number.isInteger(
          backToBack.minimum_consecutive_plays,
        )
          ? backToBack.minimum_consecutive_plays
          : 2;
        const minimumSeconds = Number.isInteger(
          backToBack.minimum_played_seconds,
        )
          ? backToBack.minimum_played_seconds
          : 30;
        const maximumGap = Number.isInteger(backToBack.maximum_gap_minutes)
          ? backToBack.maximum_gap_minutes
          : 30;
        profileBackToBackSummary.textContent =
          "Each result has at least " + formatNumber(minimumPlays) +
          " adjacent non-skipped plays, at least " +
          formatNumber(minimumSeconds) + " seconds per event, and no gap over " +
          formatNumber(maximumGap) +
          " minutes. This does not prove repeat mode, intention, or liking.";
        for (const track of tracks.slice(0, 4)) {
          const item = document.createElement("li");
          item.className = "continuity-relationship";
          const identity = document.createElement("div");
          identity.className = "historical-return-identity";
          const title = document.createElement("strong");
          title.textContent = track.title;
          const artist = document.createElement("p");
          artist.textContent = track.artist;
          identity.append(title, artist);
          const sequence = document.createElement("span");
          identity.append(trackCorrectionButton(track, profileBackToBack));
          sequence.textContent = formatNumber(track.maximum_consecutive_plays) +
            "x longest · " + formatNumber(track.burst_count) +
            (track.burst_count === 1 ? " sequence" : " sequences");
          item.append(identity, sequence);
          profileBackToBackTracks.append(item);
        }
        profileBackToBackLink.href = tasteprintUrl + "#back-to-back";
        return true;
      };

      const renderContinuity = (continuity, tasteprintUrl) => {
        const relationships = Array.isArray(continuity && continuity.relationships)
          ? continuity.relationships
          : [];
        const latest = continuity && continuity.latest_transition;
        const ready = continuity && continuity.ready === true &&
          (relationships.length > 0 || latest) && tasteprintUrl;
        profileContinuityRelationships.replaceChildren();
        profileContinuitySummary.textContent = "";
        profileContinuity.hidden = !ready;
        if (!ready) return false;
        const relationshipCount = Number.isInteger(continuity.relationship_count)
          ? continuity.relationship_count
          : relationships.length;
        profileContinuityCount.textContent =
          formatNumber(relationshipCount) + " across eras";
        if (
          latest &&
          Number.isInteger(latest.from_year) &&
          Number.isInteger(latest.to_year) &&
          Number.isFinite(latest.continuity_percent)
        ) {
          profileContinuitySummary.textContent =
            formatNumber(latest.continuity_percent, 1) + "% of " + latest.to_year +
            "'s top artists carried forward from " + latest.from_year + ". " +
            formatNumber(latest.new_artist_count) + " entered the later top set.";
        } else {
          profileContinuitySummary.textContent =
            "These artists appear across retained years and remain present in the latest retained year.";
        }
        for (const relationship of relationships.slice(0, 3)) {
          const item = document.createElement("li");
          item.className = "continuity-relationship";
          const name = document.createElement("strong");
          name.textContent = relationship.name;
          const years = document.createElement("span");
          years.textContent = formatNumber(relationship.active_years) +
            " years · " + relationship.first_year + "-" + relationship.last_year;
          item.append(name, years);
          profileContinuityRelationships.append(item);
        }
        profileContinuityLink.href = tasteprintUrl + "#continuity";
        return true;
      };

      const renderListeningPatterns = (patterns, tasteprintUrl) => {
        const releases = Array.isArray(patterns && patterns.releases)
          ? patterns.releases
          : [];
        const session = patterns && patterns.session;
        const ready = patterns && patterns.ready === true &&
          (releases.length > 0 || session) && tasteprintUrl;
        profileListeningPatternReleases.replaceChildren();
        profileListeningPatternsSummary.textContent = "";
        profileListeningPatternsMetrics.hidden = true;
        profileListeningPatternReleases.hidden = true;
        profileListeningPatterns.hidden = !ready;
        if (!ready) return false;

        const releaseCount = Number.isInteger(patterns.release_count)
          ? patterns.release_count
          : releases.length;
        profileListeningPatternsCount.textContent = releaseCount > 0
          ? formatNumber(releaseCount) + " deep records"
          : formatNumber(session.session_count) + " stretches";
        if (session) {
          profileListeningPatternsSummary.textContent =
            "A gap longer than " + formatNumber(session.gap_minutes) +
            " minutes begins a new approximate stretch. The median contains " +
            formatNumber(session.median_plays, 1) + " plays and " +
            formatNumber(session.median_listening_minutes, 1) +
            " listening minutes.";
          profileSessionCount.textContent = formatCompactNumber(session.session_count);
          profileSessionCount.title = formatNumber(session.session_count) + " approximate listening sessions";
          profileSessionMedian.textContent = formatNumber(session.median_plays, 1);
          profileSessionExtended.textContent =
            formatNumber(session.extended_sequence_percent, 1) + "%";
          profileSessionExtendedLabel.textContent =
            formatNumber(session.extended_sequence_minimum_plays) + "+ play stretches";
          profileListeningPatternsMetrics.hidden = false;
        } else {
          profileListeningPatternsSummary.textContent =
            "These releases each contain listening across multiple retained track identities.";
        }

        for (const release of releases.slice(0, 3)) {
          const item = document.createElement("li");
          item.className = "listening-pattern-release";
          const identity = document.createElement("div");
          const title = document.createElement("strong");
          title.textContent = release.title;
          const artist = document.createElement("p");
          artist.textContent = release.artist_credit;
          identity.append(title, artist);
          const depth = document.createElement("span");
          depth.textContent = formatNumber(release.distinct_tracks) +
            " tracks · " + formatNumber(release.active_years) +
            (release.active_years === 1 ? " year" : " years");
          item.append(identity, depth);
          profileListeningPatternReleases.append(item);
        }
        profileListeningPatternReleases.hidden = releases.length === 0;
        profileListeningPatternsLink.href = tasteprintUrl + "#listening-patterns";
        return true;
      };

      const applyProfile = (payload, message) => {
        profileTools.hidden = payload.state !== "ready";
        profileReady = payload && payload.state === "ready";
        profileMode = !profileReady
          ? "empty"
          : payload.profile_kind === "synthetic_demo"
            ? "demo"
            : payload.profile_kind === "private_session"
              ? "session"
              : "private";
        profileState.classList.toggle("is-ready", profileReady);
        profileState.classList.toggle("is-demo", profileMode === "demo");
        profileState.classList.remove("is-error");
        if (!profileReady) {
          result.classList.remove("is-visible");
          heroDemoAction.hidden = false;
          heroDemoLabel.textContent = "Try the real importer with fictional history";
          profileStateTitle.textContent = "No private profile yet";
          profileStateCopy.textContent = "Import Spotify or ListenBrainz history above, or run a generated fictional archive through the real importer.";
          demoProfileBadge.hidden = true;
          demoStartAction.hidden = false;
          profileMetrics.hidden = true;
          renderIdentityLinkCoverage(null);
          renderTimeMachine(null, null);
          renderListeningPulse(null, null);
          renderListeningSeasons(null, null);
          renderHistoricalReturns(null, null);
          renderBackToBack(null, null);
          renderContinuity(null, null);
          renderListeningPatterns(null, null);
          profileTasteprintLink.hidden = true;
          profileCardLink.hidden = true;
          profileCardDownloadLink.hidden = true;
          renderCorrections([]);
          if (message) setProfileStatus(message);
          syncAvailability();
          return;
        }

        const coverage = payload.coverage || {};
        const corrections = Array.isArray(payload.corrections) ? payload.corrections : [];
        const demoMode = profileMode === "demo";
        const sessionOnlyMode = profileMode === "session";
        const realImporterDemo = demoMode &&
          payload.demo_proof &&
          payload.demo_proof.production_importer === true;
        const timeMachineReady = renderTimeMachine(
          payload.time_machine,
          payload.tasteprint_url,
        );
        const listeningPulseReady = renderListeningPulse(
          payload.listening_pulse,
          payload.tasteprint_url,
        );
        const listeningSeasonsReady = renderListeningSeasons(
          payload.listening_seasons,
          payload.tasteprint_url,
        );
        const historicalReturnsReady = renderHistoricalReturns(
          payload.historical_returns,
          payload.tasteprint_url,
        );
        const backToBackReady = renderBackToBack(
          payload.back_to_back,
          payload.tasteprint_url,
        );
        const continuityReady = renderContinuity(
          payload.continuity,
          payload.tasteprint_url,
        );
        const listeningPatternsReady = renderListeningPatterns(
          payload.listening_patterns,
          payload.tasteprint_url,
        );
        heroDemoAction.hidden = !demoMode;
        heroDemoLabel.textContent = timeMachineReady
          ? "Real-import Time Machine ready - jump to it"
          : "Fictional real-import profile ready";
        profileStateTitle.textContent = demoMode
          ? "Fictional Listening Time Machine ready"
          : sessionOnlyMode
            ? timeMachineReady
              ? "Your session-only Listening Time Machine is ready"
              : listeningSeasonsReady
                ? "Your session-only Listening Seasons are ready"
                : listeningPulseReady
                  ? "Your session-only Listening Pulse is ready"
                  : backToBackReady
                    ? "Your session-only back-to-back story is ready"
                    : "Your session-only Tasteprint is ready"
          : timeMachineReady
            ? "Your Listening Time Machine is ready"
            : listeningSeasonsReady
              ? "Your Listening Seasons are ready"
              : listeningPulseReady
                ? "Your Listening Pulse is ready"
                : backToBackReady
                  ? "Your back-to-back story is ready"
                  : "Private profile ready to tune";
        profileStateCopy.textContent = demoMode
          ? realImporterDemo
            ? "52 fictional plays passed through the production importer. No personal history or persistent profile was used."
            : "Every name and number is synthetic. Corrections live only in memory and disappear when Studio stops."
          : sessionOnlyMode
            ? archiveCount === 1
              ? "The supplied ZIP is unchanged. This profile and every correction disappear when Studio stops."
              : "Both supplied ZIPs are unchanged. Their reconciled profile and every correction disappear when Studio stops."
            : "Direct signals update the projection. Your listening record stays factual and intact.";
        demoProfileBadge.textContent = sessionOnlyMode
          ? "Session-only private profile"
          : realImporterDemo
            ? "Fictional real-import demo"
            : "Fictional demo";
        demoProfileBadge.hidden = !demoMode && !sessionOnlyMode;
        demoStartAction.hidden = true;
        correctionNoteLabel.textContent = demoMode
          ? "Demo note - optional"
          : sessionOnlyMode
            ? "Session note - optional"
            : "Private note - optional";
        correctionNoteHint.textContent = demoMode
          ? "The note lives only in this Studio process and disappears when it stops."
          : sessionOnlyMode
            ? "The note can appear in this session's Tasteprint and disappears when Studio stops."
            : "The note stays local and can appear in your Tasteprint. It is not sent as model profile context.";
        profileEvents.textContent = formatCompactNumber(coverage.effective_listening_events);
        profileEvents.title = formatNumber(coverage.effective_listening_events) + " effective listens";
        profileHours.textContent = Number(coverage.listening_hours) >= 1_000
          ? formatCompactNumber(coverage.listening_hours)
          : formatNumber(coverage.listening_hours, 1);
        profileHours.title = formatNumber(coverage.listening_hours, 1) + " listening hours";
        profileCorrections.textContent = formatNumber(payload.active_corrections);
        profileMetrics.hidden = false;
        renderIdentityLinkCoverage(coverage);
        if (payload.tasteprint_url) {
          const hasCorrections = corrections.length > 0;
          profileTasteprintLink.href = payload.tasteprint_url +
            (hasCorrections
              ? "#listener-corrections"
              : timeMachineReady
                ? "#time-machine"
                : listeningSeasonsReady
                  ? "#listening-seasons"
                  : listeningPulseReady
                    ? "#listening-pulse"
                    : backToBackReady
                      ? "#back-to-back"
                      : historicalReturnsReady
                        ? "#tracks-that-stay"
                        : continuityReady
                          ? "#continuity"
                          : listeningPatternsReady
                            ? "#listening-patterns"
                            : "");
          profileTasteprintLink.firstChild.textContent = hasCorrections
            ? "Review corrections in Tasteprint "
            : demoMode
              ? "Open fictional Tasteprint "
              : sessionOnlyMode
                ? "Open session Tasteprint "
                : "Open current Tasteprint ";
          profileTasteprintLink.hidden = false;
          resultLink.href = payload.tasteprint_url +
            (timeMachineReady
              ? "#time-machine"
              : listeningSeasonsReady
                ? "#listening-seasons"
                : listeningPulseReady
                  ? "#listening-pulse"
                  : backToBackReady
                    ? "#back-to-back"
                    : historicalReturnsReady
                      ? "#tracks-that-stay"
                      : continuityReady
                        ? "#continuity"
                        : listeningPatternsReady
                          ? "#listening-patterns"
                          : "");
          resultLink.firstChild.textContent = timeMachineReady
            ? "Open Listening Time Machine "
            : listeningSeasonsReady
              ? "Open Listening Seasons "
              : listeningPulseReady
                ? "Open Listening Pulse "
                : backToBackReady
                  ? "Open played back to back "
                  : historicalReturnsReady
                    ? "Open music that came back "
                    : continuityReady
                      ? "Open continuity map "
                      : listeningPatternsReady
                        ? "Open listening patterns "
                        : "Open full Tasteprint ";
        }
        if (payload.tasteprint_card_url) {
          profileCardLink.href = payload.tasteprint_card_url;
          profileCardLink.firstChild.textContent = demoMode
            ? "Open fictional recap card "
            : sessionOnlyMode
              ? "Open session recap card "
              : "Open recap card ";
          profileCardLink.hidden = false;
          profileCardDownloadLink.href = portableCardUrl(payload.tasteprint_card_url);
          profileCardDownloadLink.firstChild.textContent = demoMode
            ? "Download fictional HTML "
            : sessionOnlyMode
              ? "Download session HTML "
              : "Download private HTML ";
          profileCardDownloadLink.hidden = false;
          resultCardLink.href = payload.tasteprint_card_url;
          resultCardDownloadLink.href = portableCardUrl(payload.tasteprint_card_url);
        } else {
          profileCardLink.hidden = true;
          profileCardDownloadLink.hidden = true;
        }
        renderCorrections(corrections);
        if (message) setProfileStatus(message);
        syncAvailability();
      };

      const showProfileError = (message) => {
        profileReady = false;
        profileMode = "empty";
        profileState.classList.remove("is-ready");
        profileState.classList.remove("is-demo");
        profileState.classList.add("is-error");
        profileStateTitle.textContent = "Private profile unavailable";
        profileStateCopy.textContent = message;
        heroDemoAction.hidden = true;
        demoProfileBadge.hidden = true;
        renderTimeMachine(null, null);
        renderListeningPulse(null, null);
        renderListeningSeasons(null, null);
        demoStartAction.hidden = true;
        profileMetrics.hidden = true;
        renderIdentityLinkCoverage(null);
        profileTasteprintLink.hidden = true;
        profileCardLink.hidden = true;
        profileCardDownloadLink.hidden = true;
        renderCorrections([]);
        setProfileStatus(message, true);
        syncAvailability();
      };

      async function profileRequest(pathname, options = {}) {
        const response = await fetch(pathname, {
          ...options,
          headers: {
            "X-Moondog-Session": sessionToken,
            ...(options.body ? { "Content-Type": "application/json" } : {}),
          },
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload.message || "The local Studio update did not complete.");
        }
        return payload;
      }

      async function loadProfile({ preserveStatus = false } = {}) {
        try {
          const payload = await profileRequest("/api/profile");
          applyProfile(
            payload,
            preserveStatus
              ? undefined
              : payload.state === "ready"
                ? payload.profile_kind === "synthetic_demo"
                  ? "Real importer complete. Try correcting Mara Vale or Midnight Lines."
                  : payload.profile_kind === "private_session"
                    ? archiveCount === 1
                      ? "Session ready. The original ZIP is untouched; corrections disappear when Studio stops."
                      : "Session ready. Both original ZIPs are untouched; corrections disappear when Studio stops."
                    : "Ready. Add a direct signal or retract one below."
                : "Import a Spotify ZIP, ListenBrainz JSON, or try the fictional real-import profile.",
          );
          return payload;
        } catch (error) {
          showProfileError(error.message);
          throw error;
        }
      }

      async function retractCorrection(correction, button) {
        if (profileBusy || busy) return;
        profileBusy = true;
        button.disabled = true;
        correctionActionLabel.textContent = "Updating Tasteprint";
        setProfileStatus("Retracting " + correction.label + "...");
        syncAvailability();
        try {
          const payload = await profileRequest(
            profileMode === "demo"
              ? "/api/demo/corrections/retract"
              : profileMode === "session"
                ? "/api/session/corrections/retract"
                : "/api/corrections/retract",
            {
              method: "POST",
              body: JSON.stringify({ correction_id: correction.correction_id }),
            },
          );
          applyProfile(payload, "Retracted. The listening record is unchanged.");
        } catch (error) {
          await loadProfile({ preserveStatus: true }).catch(() => {});
          setProfileStatus(error.message, true);
        } finally {
          profileBusy = false;
          correctionActionLabel.textContent = "Apply to Tasteprint";
          syncAvailability();
          if (!button.isConnected && profileReady) {
            (correctionReturn.hidden ? correctionLabel : correctionReturn).focus({ preventScroll: true });
          }
        }
      }

      const resetProgress = () => {
        progress.classList.remove("is-visible");
        progress.setAttribute("aria-hidden", "true");
        progressBar.style.width = "0%";
      };

      const chooseFile = (file) => {
        result.classList.remove("is-visible");
        resetProgress();
        selectedFile = null;
        selectedFileKind = null;
        fileMeta.classList.remove("is-visible");
        dropZone.classList.remove("is-ready");
        dropTitle.textContent = "Drag Spotify ZIP or ListenBrainz JSON here";
        dropCopy.textContent = "Account Data, Extended Streaming History, or saved ListenBrainz listens";
        if (!file) {
          syncAvailability();
          return;
        }
        const lowerName = file.name.toLocaleLowerCase("en-US");
        const fileKind = lowerName.endsWith(".zip")
          ? "spotify"
          : lowerName.endsWith(".json")
            ? "listenbrainz"
            : null;
        if (!fileKind) {
          setStatus("Choose a Spotify .zip or ListenBrainz .json history file.", true);
          syncAvailability();
          return;
        }
        const minimumBytes = fileKind === "spotify" ? 4 : 1;
        const maximumFileBytes = fileKind === "spotify"
          ? maximumBytes
          : maximumJsonBytes;
        if (file.size < minimumBytes || file.size > maximumFileBytes) {
          setStatus(
            fileKind === "spotify"
              ? "That ZIP is outside the supported size range."
              : "That ListenBrainz JSON is outside the supported size range.",
            true,
          );
          syncAvailability();
          return;
        }
        selectedFile = file;
        selectedFileKind = fileKind;
        fileName.textContent = file.name;
        fileSize.textContent = formatBytes(file.size);
        fileMeta.classList.add("is-visible");
        dropZone.classList.add("is-ready");
        dropTitle.textContent = "Ready to read locally";
        dropCopy.textContent = "Click here if you want to choose a different history file";
        setStatus(
          fileKind === "spotify"
            ? "Ready. The Spotify ZIP has not been imported yet."
            : "Ready. The ListenBrainz JSON has not been imported yet.",
        );
        syncAvailability();
      };

      input.addEventListener("change", () => chooseFile(input.files && input.files[0]));
      const scrollToProfileOutcome = () => {
        const target = !profileTimeMachine.hidden
          ? profileTimeMachine
          : !profileListeningPulse.hidden
            ? profileListeningPulse
            : document.querySelector("#profile-editor");
        target.scrollIntoView({
          behavior: "smooth",
          block:
            profileTimeMachine.hidden && profileListeningPulse.hidden
              ? "start"
              : "center",
        });
      };

      async function startDemoProfile() {
        if (profileBusy || busy) return;
        if (profileReady) {
          scrollToProfileOutcome();
          return;
        }
        profileBusy = true;
        setProfileStatus("Running 52 fictional plays through the production importer...");
        syncAvailability();
        try {
          const payload = await profileRequest("/api/demo/start", {
            method: "POST",
            body: "{}",
          });
          applyProfile(
            payload,
            "Real importer complete. Follow the fictional route, then try correcting Mara Vale or Midnight Lines.",
          );
          scrollToProfileOutcome();
        } catch (error) {
          await loadProfile({ preserveStatus: true }).catch(() => {});
          setProfileStatus(error.message, true);
        } finally {
          profileBusy = false;
          syncAvailability();
        }
      }
      heroDemoAction.addEventListener("click", startDemoProfile);
      demoStartAction.addEventListener("click", startDemoProfile);
      for (const radio of correctionForm.elements.namedItem("entity-type")) {
        radio.addEventListener("change", syncTargetFields);
      }
      correctionForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!profileReady || profileBusy || busy || !correctionForm.reportValidity()) return;
        const entityType = selectedEntityType();
        const stance = correctionForm.elements.namedItem("stance").value;
        const inputValue = {
          entity_type: entityType,
          label: correctionLabel.value.trim(),
          stance,
          ...(entityType === "track"
            ? { artist_credit: artistCredit.value.trim() }
            : {}),
          ...(correctionNote.value.trim()
            ? { note: correctionNote.value.trim() }
            : {}),
        };
        profileBusy = true;
        correctionActionLabel.textContent = "Updating Tasteprint";
        setProfileStatus("Applying your direct signal locally...");
        syncAvailability();
        try {
          const payload = await profileRequest(
            profileMode === "demo"
              ? "/api/demo/corrections"
              : profileMode === "session"
                ? "/api/session/corrections"
                : "/api/corrections",
            {
              method: "POST",
              body: JSON.stringify(inputValue),
            },
          );
          applyProfile(
            payload,
            "Applied. Review the direct signal in the updated Tasteprint.",
          );
          correctionLabel.value = "";
          artistCredit.value = "";
          correctionNote.value = "";
          correctionLabel.focus();
        } catch (error) {
          await loadProfile({ preserveStatus: true }).catch(() => {});
          setProfileStatus(error.message, true);
        } finally {
          profileBusy = false;
          correctionActionLabel.textContent = "Apply to Tasteprint";
          syncAvailability();
        }
      });
      dropZone.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          input.click();
        }
      });

      for (const eventName of ["dragenter", "dragover"]) {
        dropZone.addEventListener(eventName, (event) => {
          event.preventDefault();
          if (!busy) dropZone.classList.add("is-dragging");
        });
      }
      for (const eventName of ["dragleave", "drop"]) {
        dropZone.addEventListener(eventName, (event) => {
          event.preventDefault();
          dropZone.classList.remove("is-dragging");
        });
      }
      dropZone.addEventListener("drop", (event) => {
        if (!busy) chooseFile(event.dataTransfer && event.dataTransfer.files[0]);
      });

      action.addEventListener("click", () => {
        if (!selectedFile || !selectedFileKind || busy || profileBusy) return;
        busy = true;
        actionLabel.textContent = "Importing locally";
        result.classList.remove("is-visible");
        progress.classList.add("is-visible");
        progress.setAttribute("aria-hidden", "false");
        progressBar.style.width = "4%";
        const sourceLabel = selectedFileKind === "spotify"
          ? "Spotify ZIP"
          : "ListenBrainz JSON";
        setStatus("Sending the " + sourceLabel + " to the local Moondog process...");
        syncAvailability();

        const request = new XMLHttpRequest();
        request.open("POST", "/api/import");
        request.responseType = "json";
        request.setRequestHeader(
          "Content-Type",
          selectedFileKind === "spotify" ? "application/zip" : "application/json",
        );
        request.setRequestHeader("X-Moondog-Session", sessionToken);
        request.upload.addEventListener("progress", (event) => {
          if (!event.lengthComputable) return;
          const percent = Math.min(82, Math.max(4, Math.round((event.loaded / event.total) * 82)));
          progressBar.style.width = percent + "%";
          if (event.loaded === event.total) {
            setStatus("Reading your history and building the cumulative profile...");
          }
        });
        request.addEventListener("load", () => {
          const payload = request.response || {};
          if (request.status < 200 || request.status >= 300) {
            setStatus(payload.message || "Moondog could not import that history file.", true);
            progressBar.style.width = "0%";
            return;
          }
          progressBar.style.width = "100%";
          document.querySelector("#events").textContent = formatNumber(payload.coverage.effective_listening_events);
          document.querySelector("#hours").textContent = formatNumber(payload.coverage.listening_hours, 1);
          document.querySelector("#tracks").textContent = formatNumber(payload.coverage.distinct_tracks);
          document.querySelector("#result-kicker").textContent = payload.source.already_imported
            ? "Already part of your private profile"
            : "Private profile updated";
          const importedTimeMachine = payload.time_machine && payload.time_machine.ready === true;
          const importedPulse = payload.listening_pulse && payload.listening_pulse.ready === true;
          const importedSeasons = payload.listening_seasons && payload.listening_seasons.ready === true;
          const importedBackToBack = payload.back_to_back && payload.back_to_back.ready === true;
          const importedHistoricalReturns = payload.historical_returns && payload.historical_returns.ready === true;
          const importedContinuity = payload.continuity && payload.continuity.ready === true;
          const importedPatterns = payload.listening_patterns && payload.listening_patterns.ready === true;
          document.querySelector("#result-title").textContent = importedTimeMachine
            ? "Your Listening Time Machine is ready."
            : importedSeasons
              ? "Your Listening Seasons are ready."
              : importedPulse
                ? "Your Listening Pulse is ready."
                : importedBackToBack
                  ? "Your back-to-back story is ready."
                  : importedHistoricalReturns
                    ? "Your return story is ready."
                    : importedContinuity
                      ? "Your continuity map is ready."
                      : importedPatterns
                        ? "Your listening patterns are ready."
                        : "This is your listening arc.";
          const importSummary = payload.source.already_imported
            ? "Moondog recognized this history file and kept the cumulative profile unchanged."
            : formatNumber(payload.source.effective_event_delta) + " new effective listens were folded into your local music identity.";
          const reconciliationSummary = !payload.source.already_imported && payload.source.superseded_events > 0
            ? " " + formatNumber(payload.source.superseded_events) + " overlapping standard records were reconciled to richer Extended History evidence instead of counted twice."
            : "";
          const identityLinkSummary = payload.coverage.cross_format_track_links > 0
            ? " " + formatNumber(payload.coverage.cross_format_track_links) +
              " provisional track identities now aggregate with resolved Spotify identities through exact overlap evidence."
            : "";
          const historicalReturnSummary = importedHistoricalReturns
            ? " " + formatNumber(payload.historical_returns.return_track_count) +
              (payload.historical_returns.return_track_count === 1
                ? " track reappeared"
                : " tracks reappeared") +
              " after a long gap, without treating the pattern as nostalgia or current preference."
            : "";
          const backToBackSummary = importedBackToBack
            ? " " + formatNumber(payload.back_to_back.track_count) +
              (payload.back_to_back.track_count === 1
                ? " track appears"
                : " tracks appear") +
              " in bounded adjacent playback sequences, without treating them as proof of repeat mode, intention, or liking."
            : "";
          const pulseSummary = importedPulse
            ? " " + formatNumber(payload.listening_pulse.active_month_count) +
              " retained UTC months contain eligible activity in the bounded Listening Pulse."
            : "";
          const seasonSummary = importedSeasons
            ? " " + formatNumber(payload.listening_seasons.active_season_count) +
              " fixed UTC calendar quarters form the bounded Listening Seasons view."
            : "";
          const patternSummary = importedPatterns
            ? " " + [
                payload.listening_patterns.session
                  ? formatNumber(payload.listening_patterns.session.session_count) + " approximate listening stretches"
                  : "",
                payload.listening_patterns.release_count > 0
                  ? formatNumber(payload.listening_patterns.release_count) + " multi-track records"
                  : "",
              ].filter(Boolean).join(" and ") + " are ready for review."
            : "";
          document.querySelector("#result-copy").textContent = importedTimeMachine
            ? formatNumber(payload.time_machine.landmark_count) + " chronological landmarks are ready across your retained listening years. " + importSummary + reconciliationSummary + identityLinkSummary + pulseSummary + seasonSummary + backToBackSummary + historicalReturnSummary + patternSummary
            : importedSeasons
              ? formatNumber(payload.listening_seasons.active_season_count) + " fixed UTC calendar quarters form your bounded Listening Seasons view. " + importSummary + reconciliationSummary + identityLinkSummary + pulseSummary + backToBackSummary + historicalReturnSummary + patternSummary
              : importedPulse
                ? formatNumber(payload.listening_pulse.active_month_count) + " retained UTC months form your bounded Listening Pulse. " + importSummary + reconciliationSummary + identityLinkSummary + seasonSummary + backToBackSummary + historicalReturnSummary + patternSummary
                : importedBackToBack
                  ? formatNumber(payload.back_to_back.track_count) + " tracks appear in bounded adjacent playback sequences. " + importSummary + reconciliationSummary + identityLinkSummary + pulseSummary + seasonSummary + historicalReturnSummary + patternSummary
                  : importedHistoricalReturns
                    ? formatNumber(payload.historical_returns.return_track_count) + " tracks reappeared after long gaps in retained history. " + importSummary + reconciliationSummary + identityLinkSummary + pulseSummary + seasonSummary + backToBackSummary + patternSummary
                    : importedContinuity
                      ? formatNumber(payload.continuity.relationship_count) + " artists remain present across retained years, alongside year-to-year top-artist turnover. " + importSummary + reconciliationSummary + identityLinkSummary + pulseSummary + seasonSummary + backToBackSummary + historicalReturnSummary + patternSummary
                      : importSummary + reconciliationSummary + identityLinkSummary + pulseSummary + seasonSummary + backToBackSummary + historicalReturnSummary + patternSummary;
          resultLink.href = payload.tasteprint_url +
            (importedTimeMachine
              ? "#time-machine"
              : importedSeasons
                ? "#listening-seasons"
                : importedPulse
                  ? "#listening-pulse"
                  : importedBackToBack
                    ? "#back-to-back"
                    : importedHistoricalReturns
                      ? "#tracks-that-stay"
                      : importedContinuity
                        ? "#continuity"
                        : importedPatterns
                          ? "#listening-patterns"
                          : "");
          resultLink.firstChild.textContent = importedTimeMachine
            ? "Open Listening Time Machine "
            : importedSeasons
              ? "Open Listening Seasons "
              : importedPulse
                ? "Open Listening Pulse "
                : importedBackToBack
                  ? "Open played back to back "
                  : importedHistoricalReturns
                    ? "Open music that came back "
                    : importedContinuity
                      ? "Open continuity map "
                      : importedPatterns
                        ? "Open listening patterns "
                        : "Open full Tasteprint ";
          resultCardLink.href = payload.tasteprint_card_url;
          resultCardDownloadLink.href = portableCardUrl(payload.tasteprint_card_url);
          result.classList.add("is-visible");
          applyProfile(payload, "Profile ready. Add a direct signal or retract one below.");
          setStatus("Done. The temporary source copy has been removed.");
          result.scrollIntoView({ behavior: "smooth", block: "nearest" });
        });
        request.addEventListener("error", () => {
          setStatus("The local Studio connection was interrupted. You can try again.", true);
          progressBar.style.width = "0%";
        });
        request.addEventListener("loadend", () => {
          busy = false;
          actionLabel.textContent = "Import and build Tasteprint";
          syncAvailability();
        });
        request.send(selectedFile);
      });

      syncTargetFields();
      syncAvailability();
      loadProfile().catch(() => {});
    })();
  </script>
</body>
</html>`;
}
