import { validateFirstRunUsabilityProtocol } from "./first-run-usability.mjs";

function safeJsonForHtml(value) {
  return JSON.stringify(value)
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

export function renderFirstRunUsabilityForm(protocol) {
  validateFirstRunUsabilityProtocol(protocol);
  const protocolJson = safeJsonForHtml(protocol);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'">
  <title>Moondog First-run Session</title>
  <style>
    :root {
      color-scheme: dark;
      --night: #111315;
      --panel: #191c1f;
      --panel-soft: #202428;
      --paper: #f4efe6;
      --muted: #a8acae;
      --line: rgba(244, 239, 230, 0.14);
      --blue: #94b7d0;
      --gold: #d9b777;
      --red: #e38d82;
      --green: #9fc3a5;
      --shadow: 0 28px 80px rgba(0, 0, 0, 0.28);
    }

    * { box-sizing: border-box; }

    html { scroll-behavior: smooth; }

    body {
      min-width: 0;
      margin: 0;
      color: var(--paper);
      background:
        radial-gradient(circle at 82% -8%, rgba(148, 183, 208, 0.15), transparent 36rem),
        linear-gradient(180deg, #141719 0%, var(--night) 42%, #0e1011 100%);
      font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.55;
    }

    button, input, select, textarea { font: inherit; }

    button, select, input, textarea { color: inherit; }

    .shell {
      width: min(1120px, calc(100% - 32px));
      margin: 0 auto;
      padding: 30px 0 100px;
    }

    .hero {
      position: relative;
      min-width: 0;
      overflow: hidden;
      padding: clamp(34px, 6vw, 72px);
      border: 1px solid var(--line);
      border-radius: 28px;
      background: rgba(24, 27, 30, 0.86);
      box-shadow: var(--shadow);
    }

    .orbit {
      position: absolute;
      width: 420px;
      height: 420px;
      top: -185px;
      right: -105px;
      border: 1px solid rgba(244, 239, 230, 0.16);
      border-radius: 50%;
      box-shadow:
        0 0 0 28px rgba(244, 239, 230, 0.025),
        0 0 0 64px rgba(244, 239, 230, 0.018);
      pointer-events: none;
    }

    .orbit::after {
      position: absolute;
      width: 11px;
      height: 11px;
      left: 90px;
      bottom: 46px;
      content: "";
      border-radius: 50%;
      background: var(--paper);
      box-shadow: 0 0 0 8px rgba(244, 239, 230, 0.09);
    }

    .eyebrow {
      margin: 0 0 22px;
      color: var(--blue);
      font-size: 12px;
      font-weight: 750;
      letter-spacing: 0.17em;
      text-transform: uppercase;
    }

    h1, h2, h3, p { margin-top: 0; }

    h1 {
      max-width: 760px;
      margin-bottom: 20px;
      font-family: Georgia, "Times New Roman", serif;
      font-size: clamp(44px, 7.5vw, 82px);
      font-weight: 500;
      letter-spacing: -0.052em;
      line-height: 0.94;
    }

    .lede {
      max-width: 720px;
      margin-bottom: 34px;
      color: #c9c5be;
      font-size: 17px;
    }

    .boundary {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 1px;
      overflow: hidden;
      max-width: 820px;
      border: 1px solid var(--line);
      border-radius: 16px;
      background: var(--line);
    }

    .boundary div {
      min-width: 0;
      padding: 18px;
      background: rgba(17, 19, 21, 0.86);
    }

    .boundary strong, .boundary span { display: block; }

    .boundary strong {
      margin-bottom: 6px;
      color: var(--paper);
      font-size: 14px;
    }

    .boundary span {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.45;
    }

    .progress-shell {
      position: sticky;
      z-index: 20;
      top: 14px;
      display: flex;
      align-items: center;
      gap: 16px;
      margin: 20px 0;
      padding: 14px 18px;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: rgba(17, 19, 21, 0.92);
      box-shadow: 0 12px 34px rgba(0, 0, 0, 0.24);
      backdrop-filter: blur(16px);
    }

    .progress-label {
      flex: 0 0 auto;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .progress-track {
      min-width: 0;
      height: 7px;
      flex: 1;
      overflow: hidden;
      border-radius: 99px;
      background: rgba(244, 239, 230, 0.1);
    }

    .progress-fill {
      width: 0;
      height: 100%;
      border-radius: inherit;
      background: linear-gradient(90deg, var(--blue), var(--gold));
      transition: width 180ms ease;
    }

    .progress-count {
      min-width: 46px;
      color: var(--paper);
      font-variant-numeric: tabular-nums;
      text-align: right;
    }

    .section {
      min-width: 0;
      margin-top: 20px;
      padding: clamp(24px, 4vw, 42px);
      border: 1px solid var(--line);
      border-radius: 24px;
      background: rgba(25, 28, 31, 0.82);
    }

    .section-head {
      display: grid;
      grid-template-columns: 54px minmax(0, 1fr);
      gap: 18px;
      align-items: start;
      margin-bottom: 28px;
    }

    .section-number {
      display: grid;
      width: 46px;
      height: 46px;
      place-items: center;
      border: 1px solid var(--line);
      border-radius: 50%;
      color: var(--blue);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 13px;
    }

    h2 {
      margin-bottom: 8px;
      font-family: Georgia, "Times New Roman", serif;
      font-size: clamp(28px, 4vw, 42px);
      font-weight: 500;
      letter-spacing: -0.025em;
      line-height: 1.05;
    }

    h3 {
      margin-bottom: 8px;
      font-size: 18px;
      line-height: 1.25;
    }

    .section-head p, .helper {
      margin-bottom: 0;
      color: var(--muted);
      font-size: 14px;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 18px;
    }

    .field {
      min-width: 0;
    }

    .field.full { grid-column: 1 / -1; }

    label, legend {
      display: block;
      margin-bottom: 8px;
      color: #ded9d0;
      font-size: 13px;
      font-weight: 680;
    }

    fieldset {
      min-width: 0;
      margin: 0;
      padding: 0;
      border: 0;
    }

    input[type="text"],
    input[type="number"],
    select,
    textarea {
      width: 100%;
      min-width: 0;
      border: 1px solid rgba(244, 239, 230, 0.18);
      border-radius: 11px;
      outline: none;
      background: #111416;
      transition: border-color 150ms ease, box-shadow 150ms ease;
    }

    input[type="text"], input[type="number"], select { height: 46px; padding: 0 13px; }

    textarea {
      min-height: 88px;
      padding: 12px 13px;
      resize: vertical;
    }

    input:focus, select:focus, textarea:focus {
      border-color: var(--blue);
      box-shadow: 0 0 0 3px rgba(148, 183, 208, 0.13);
    }

    input:disabled, select:disabled, textarea:disabled {
      cursor: not-allowed;
      opacity: 0.42;
    }

    .choice-row {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }

    .choice {
      display: flex;
      min-width: 0;
      align-items: flex-start;
      gap: 10px;
      margin: 0;
      padding: 13px;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: #15181a;
      font-weight: 520;
      line-height: 1.35;
    }

    .choice input { flex: 0 0 auto; margin-top: 2px; accent-color: var(--blue); }

    .tasks { display: grid; gap: 14px; }

    .task {
      min-width: 0;
      padding: 22px;
      border: 1px solid var(--line);
      border-radius: 17px;
      background: var(--panel-soft);
    }

    .task-head {
      display: grid;
      grid-template-columns: 44px minmax(0, 1fr);
      gap: 14px;
      margin-bottom: 18px;
    }

    .task-index {
      display: grid;
      width: 38px;
      height: 38px;
      place-items: center;
      border-radius: 10px;
      color: #111315;
      background: var(--paper);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      font-weight: 800;
    }

    .task p { margin-bottom: 0; color: var(--muted); font-size: 13px; }

    .criterion {
      margin-top: 11px !important;
      padding-left: 12px;
      border-left: 2px solid var(--gold);
      color: #cfc8bd !important;
    }

    .task-fields {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 0.7fr) minmax(0, 1fr);
      gap: 12px;
    }

    .task-note { grid-column: 1 / -1; }

    .observation-grid { display: grid; gap: 16px; }

    .observation {
      min-width: 0;
      padding: 20px;
      border: 1px solid var(--line);
      border-radius: 16px;
      background: #15181a;
    }

    .observation .grid { margin-top: 16px; }

    .category-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }

    .confirmation {
      display: grid;
      gap: 10px;
      margin-top: 18px;
      padding: 18px;
      border: 1px solid rgba(217, 183, 119, 0.32);
      border-radius: 14px;
      background: rgba(217, 183, 119, 0.07);
    }

    .confirmation .choice { background: transparent; }

    .submit-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 14px;
      margin-top: 22px;
    }

    button {
      min-height: 48px;
      padding: 0 20px;
      border: 0;
      border-radius: 999px;
      cursor: pointer;
      color: #111315;
      background: var(--paper);
      font-weight: 760;
    }

    button:hover { background: #fffaf1; }

    .status { min-width: 0; margin: 0; color: var(--green); font-size: 13px; }

    .status.error { color: var(--red); }

    .footer {
      max-width: 760px;
      margin: 28px auto 0;
      color: #85898c;
      font-size: 12px;
      text-align: center;
    }

    @media (max-width: 720px) {
      .shell { width: min(100% - 20px, 1120px); padding-top: 10px; }
      .hero, .section { border-radius: 18px; }
      .hero { padding: 30px 22px; }
      .boundary, .grid, .choice-row, .task-fields, .category-grid {
        grid-template-columns: minmax(0, 1fr);
      }
      .field.full, .task-note { grid-column: auto; }
      .section { padding: 24px 18px; }
      .section-head { grid-template-columns: 42px minmax(0, 1fr); gap: 12px; }
      .section-number { width: 38px; height: 38px; }
      .task { padding: 18px 15px; }
      .progress-shell { top: 8px; gap: 10px; }
      .progress-label { display: none; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <header class="hero">
      <div class="orbit" aria-hidden="true"></div>
      <p class="eyebrow">Moondog / private local research</p>
      <h1>First-run field notes.</h1>
      <p class="lede">Observe one independent newcomer using a clean Moondog source checkout. Record the first hesitation before helping, the first successful outcome, and every misleading privacy or capability assumption.</p>
      <div class="boundary" aria-label="Session boundaries">
        <div><strong>Fictional only</strong><span>Use the built-in profile or Moondog-generated archive, never a participant export.</span></div>
        <div><strong>Private raw notes</strong><span>Keep the downloaded JSON in the ignored runs directory.</span></div>
        <div><strong>Aggregate later</strong><span>Only category counts and task rates may become public.</span></div>
      </div>
    </header>

    <div class="progress-shell">
      <span class="progress-label">Required fields</span>
      <div class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="1" aria-valuenow="0"><div class="progress-fill"></div></div>
      <span class="progress-count">0 / 0</span>
    </div>

    <form id="session-form">
      <section class="section">
        <div class="section-head">
          <div class="section-number">01</div>
          <div><h2>Set the clean boundary</h2><p>Use an opaque participant label. Do not enter a name, email address, account handle, or music preference.</p></div>
        </div>
        <div class="grid">
          <div class="field full">
            <label for="participant-id">Opaque participant ID</label>
            <input id="participant-id" type="text" maxlength="64" pattern="[A-Za-z0-9._-]+" placeholder="newcomer-01" required autocomplete="off">
          </div>
          <fieldset class="field">
            <legend>Platform</legend>
            <div class="choice-row">
              <label class="choice"><input type="radio" name="platform" value="macos" required> macOS</label>
              <label class="choice"><input type="radio" name="platform" value="linux" required> Linux</label>
            </div>
          </fieldset>
          <fieldset class="field">
            <legend>Install source</legend>
            <div class="choice-row">
              <label class="choice"><input type="radio" name="installation-source" value="clean_source_checkout" required> Clean source</label>
              <label class="choice"><input type="radio" name="installation-source" value="package_tarball" required> Package tarball</label>
            </div>
          </fieldset>
          <div class="field">
            <label for="node-major">Node major version</label>
            <input id="node-major" type="number" min="22" max="99" step="1" placeholder="24" required>
          </div>
          <div class="field">
            <label for="session-mode">Session mode</label>
            <select id="session-mode" required>
              <option value="">Choose one</option>
              <option value="in_person">In person</option>
              <option value="remote_screen_share">Remote screen share</option>
              <option value="unmoderated">Unmoderated</option>
            </select>
          </div>
        </div>
        <div class="confirmation">
          <label class="choice"><input id="independent" type="checkbox" required> I confirm this participant did not build Moondog and is independent of its implementation.</label>
        </div>
      </section>

      <section class="section">
        <div class="section-head">
          <div class="section-number">02</div>
          <div><h2>Observe the path</h2><p>Start timing when the participant begins each task. Record a hint or takeover before intervening.</p></div>
        </div>
        <div id="tasks" class="tasks"></div>
      </section>

      <section class="section">
        <div class="section-head">
          <div class="section-number">03</div>
          <div><h2>Capture the turning points</h2><p>These bounded observations make sessions comparable. Free text remains private and is never copied into the public aggregate.</p></div>
        </div>
        <div class="observation-grid">
          <article class="observation">
            <h3>First hesitation</h3>
            <p class="helper">Record the earliest visible pause, uncertainty, wrong turn, or request for help. Choose none only if no hesitation occurred.</p>
            <div class="grid">
              <div class="field"><label for="hesitation-status">Observation</label><select id="hesitation-status" required><option value="">Choose one</option><option value="observed">Hesitation observed</option><option value="none">No hesitation observed</option></select></div>
              <div class="field"><label for="hesitation-task">Task</label><select id="hesitation-task"></select></div>
              <div class="field"><label for="hesitation-category">Category</label><select id="hesitation-category"></select></div>
              <div class="field full"><label for="hesitation-note">Private note</label><textarea id="hesitation-note" maxlength="2000" placeholder="What did the participant do or say?"></textarea></div>
            </div>
          </article>

          <article class="observation">
            <h3>First successful outcome</h3>
            <p class="helper">This must match the first task marked completed, or none if no task was completed.</p>
            <div class="grid">
              <div class="field"><label for="success-status">Observation</label><select id="success-status" required><option value="">Choose one</option><option value="observed">Success observed</option><option value="none">No successful outcome</option></select></div>
              <div class="field"><label for="success-task">Task</label><select id="success-task"></select></div>
              <div class="field"><label for="success-seconds">Seconds to first success</label><input id="success-seconds" type="number" min="0" max="14400" step="1"></div>
            </div>
          </article>

          <article class="observation">
            <h3>Misleading assumptions</h3>
            <p class="helper">Record every observed privacy or capability misunderstanding. Multiple categories are allowed.</p>
            <div class="grid">
              <div class="field"><label for="assumption-status">Observation</label><select id="assumption-status" required><option value="">Choose one</option><option value="observed">One or more observed</option><option value="none">None observed</option></select></div>
              <div class="field"><label for="assumption-task">First task where observed</label><select id="assumption-task"></select></div>
              <fieldset class="field full"><legend>Categories</legend><div id="assumption-categories" class="category-grid"></div></fieldset>
              <div class="field full"><label for="assumption-note">Private note</label><textarea id="assumption-note" maxlength="2000" placeholder="What did the participant believe, and what evidence corrected it?"></textarea></div>
            </div>
          </article>

          <article class="observation">
            <h3>Stopping point</h3>
            <p class="helper">If every task was completed, choose completed all. Otherwise choose the first task that was not completed.</p>
            <div class="grid">
              <div class="field"><label for="stopping-task">Stopping point</label><select id="stopping-task" required></select></div>
              <div class="field"><label for="stopping-reason">Reason</label><select id="stopping-reason" required><option value="">Choose one</option><option value="completed_all">Completed all</option><option value="blocked">Blocked</option><option value="participant_choice">Participant chose to stop</option><option value="time_limit">Time limit</option><option value="technical_environment">Technical environment</option></select></div>
              <div class="field full"><label for="stopping-note">Private note</label><textarea id="stopping-note" maxlength="2000" placeholder="Optional context for the stopping point."></textarea></div>
            </div>
          </article>
        </div>

        <div class="confirmation">
          <label class="choice"><input id="no-personal-data" type="checkbox" required> I confirm this session used only built-in or Moondog-generated fictional data and collected no personal music history or provider credentials.</label>
          <label class="choice"><input id="aggregate-consent" type="checkbox" required> I confirm the participant agreed to anonymous aggregate reporting with IDs and free text omitted.</label>
        </div>
        <div class="submit-row">
          <button type="submit">Download private session JSON</button>
          <p id="status" class="status" role="status" aria-live="polite"></p>
        </div>
      </section>
    </form>
    <p class="footer">Protocol <span id="protocol-id"></span>. Keep the downloaded file local, validate it with the Moondog usability command, and publish only an aggregate summary.</p>
  </main>

  <script id="protocol-data" type="application/json">${protocolJson}</script>
  <script>
    const protocol = JSON.parse(document.getElementById('protocol-data').textContent);
    const form = document.getElementById('session-form');
    const tasksRoot = document.getElementById('tasks');
    const statusNode = document.getElementById('status');
    const taskControls = new Map();

    const labels = {
      navigation: 'Navigation or next step',
      terminology: 'Terminology or copy',
      command_or_setup: 'Command or setup',
      waiting_or_feedback: 'Waiting or feedback',
      privacy_boundary: 'Privacy boundary',
      capability_boundary: 'Capability boundary',
      error_recovery: 'Error recovery',
      other: 'Other',
      thought_real_data_was_required: 'Thought real music data was required',
      thought_data_was_uploaded: 'Thought music data was uploaded',
      thought_provider_action_occurred: 'Thought a provider action occurred',
      thought_output_was_safe_to_publish: 'Thought the output was automatically safe to publish',
      thought_correction_rewrote_history: 'Thought a correction rewrote history',
      thought_fictional_data_was_personal: 'Thought fictional data was personal',
      thought_feature_was_available: 'Thought an unavailable feature was available',
    };

    function make(tag, className, text) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    }

    function append(parent, children) {
      for (const child of children) parent.appendChild(child);
      return parent;
    }

    function option(value, text) {
      const node = document.createElement('option');
      node.value = value;
      node.textContent = text;
      return node;
    }

    function labeledField(labelText, control, className) {
      const field = make('div', 'field' + (className ? ' ' + className : ''));
      const label = make('label', '', labelText);
      label.htmlFor = control.id;
      append(field, [label, control]);
      return field;
    }

    function taskSelect(id, includeCompletedAll) {
      const select = document.getElementById(id);
      select.appendChild(option('', 'Choose one'));
      if (includeCompletedAll) select.appendChild(option('completed_all', 'Completed every task'));
      for (const task of protocol.tasks) select.appendChild(option(task.id, task.position + '. ' + task.title));
      return select;
    }

    function renderTasks() {
      for (const task of protocol.tasks) {
        const card = make('article', 'task');
        card.dataset.taskId = task.id;
        const head = make('div', 'task-head');
        const copy = make('div');
        append(copy, [
          make('h3', '', task.title),
          make('p', '', task.instruction),
          make('p', 'criterion', 'Visible success: ' + task.success_criterion),
        ]);
        append(head, [make('div', 'task-index', String(task.position).padStart(2, '0')), copy]);

        const fields = make('div', 'task-fields');
        const outcome = document.createElement('select');
        outcome.id = task.id + '-outcome';
        outcome.required = true;
        append(outcome, [option('', 'Choose one'), option('completed', 'Completed'), option('blocked', 'Blocked'), option('skipped', 'Skipped')]);
        const seconds = document.createElement('input');
        seconds.id = task.id + '-seconds';
        seconds.type = 'number';
        seconds.min = '0';
        seconds.max = '14400';
        seconds.step = '1';
        seconds.placeholder = 'Seconds';
        const assistance = document.createElement('select');
        assistance.id = task.id + '-assistance';
        assistance.required = true;
        append(assistance, [option('none', 'No help'), option('hint', 'Hint'), option('takeover', 'Takeover')]);
        const note = document.createElement('textarea');
        note.id = task.id + '-note';
        note.maxLength = 2000;
        note.placeholder = 'Private task note. Do not enter identifying information or music data.';
        append(fields, [
          labeledField('Outcome', outcome),
          labeledField('Elapsed seconds', seconds),
          labeledField('Facilitator help', assistance),
          labeledField('Private note', note, 'task-note'),
        ]);
        append(card, [head, fields]);
        tasksRoot.appendChild(card);
        taskControls.set(task.id, { outcome, seconds, assistance, note });
        outcome.addEventListener('change', () => {
          const skipped = outcome.value === 'skipped';
          seconds.disabled = skipped;
          seconds.required = Boolean(outcome.value) && !skipped;
          if (skipped) seconds.value = '';
          updateProgress();
        });
      }
    }

    function setConditionalGroup(statusId, controlIds, observedValue) {
      const status = document.getElementById(statusId);
      function update() {
        const enabled = status.value === observedValue;
        for (const id of controlIds) {
          const control = document.getElementById(id);
          control.disabled = !enabled;
          control.required = enabled && control.dataset.optional !== 'true';
          if (!enabled && control.type !== 'textarea') control.value = '';
        }
        updateProgress();
      }
      status.addEventListener('change', update);
      update();
    }

    function renderAssumptionCategories() {
      const root = document.getElementById('assumption-categories');
      for (const category of [
        'thought_real_data_was_required',
        'thought_data_was_uploaded',
        'thought_provider_action_occurred',
        'thought_output_was_safe_to_publish',
        'thought_correction_rewrote_history',
        'thought_fictional_data_was_personal',
        'thought_feature_was_available',
        'other',
      ]) {
        const label = make('label', 'choice');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.name = 'assumption-category';
        input.value = category;
        append(label, [input, document.createTextNode(labels[category])]);
        root.appendChild(label);
      }
    }

    function updateAssumptionState() {
      const observed = document.getElementById('assumption-status').value === 'observed';
      document.getElementById('assumption-task').disabled = !observed;
      document.getElementById('assumption-task').required = observed;
      for (const input of document.querySelectorAll('[name="assumption-category"]')) {
        input.disabled = !observed;
        if (!observed) input.checked = false;
      }
      updateProgress();
    }

    function checkedValue(name) {
      return document.querySelector('[name="' + name + '"]:checked')?.value ?? null;
    }

    function selectedAssumptions() {
      return [...document.querySelectorAll('[name="assumption-category"]:checked')].map((input) => input.value);
    }

    function taskRows() {
      return protocol.tasks.map((task) => {
        const controls = taskControls.get(task.id);
        return {
          task_id: task.id,
          outcome: controls.outcome.value,
          elapsed_seconds: controls.outcome.value === 'skipped' ? null : Number(controls.seconds.value),
          assistance: controls.assistance.value,
          note: controls.note.value.trim(),
        };
      });
    }

    function validateRelationships() {
      const rows = taskRows();
      const firstCompleted = rows.find((row) => row.outcome === 'completed');
      const successStatus = document.getElementById('success-status').value;
      const successTask = document.getElementById('success-task').value;
      if ((firstCompleted && (successStatus !== 'observed' || successTask !== firstCompleted.task_id)) || (!firstCompleted && successStatus !== 'none')) {
        return 'First successful outcome must match the first task marked completed, or be none when no task was completed.';
      }
      const assumptionStatus = document.getElementById('assumption-status').value;
      if (assumptionStatus === 'observed' && selectedAssumptions().length === 0) {
        return 'Choose at least one misleading-assumption category.';
      }
      const firstIncomplete = rows.find((row) => row.outcome !== 'completed');
      const stoppingTask = document.getElementById('stopping-task').value;
      const stoppingReason = document.getElementById('stopping-reason').value;
      if (!firstIncomplete && (stoppingTask !== 'completed_all' || stoppingReason !== 'completed_all')) {
        return 'A fully completed session must use the completed-all stopping point and reason.';
      }
      if (firstIncomplete && (stoppingTask !== firstIncomplete.task_id || stoppingReason === 'completed_all')) {
        return 'An incomplete session must stop at the first task not completed with a non-completion reason.';
      }
      return null;
    }

    function completedSession() {
      const hesitationStatus = document.getElementById('hesitation-status').value;
      const successStatus = document.getElementById('success-status').value;
      const assumptionStatus = document.getElementById('assumption-status').value;
      return {
        session_version: 'first-run-usability-session/1',
        protocol_id: protocol.protocol_id,
        protocol_sha256: protocol.protocol_sha256,
        completed_at: new Date().toISOString(),
        privacy: {
          classification: 'private_local_usability_session',
          no_personal_music_data: document.getElementById('no-personal-data').checked,
          consent_to_aggregate: document.getElementById('aggregate-consent').checked,
        },
        participant: {
          participant_id: document.getElementById('participant-id').value.trim(),
          independent: document.getElementById('independent').checked,
          built_moondog_before: false,
        },
        environment: {
          platform: checkedValue('platform'),
          installation_source: checkedValue('installation-source'),
          node_major: Number(document.getElementById('node-major').value),
          session_mode: document.getElementById('session-mode').value,
        },
        tasks: taskRows(),
        observations: {
          first_hesitation: {
            status: hesitationStatus,
            task_id: hesitationStatus === 'observed' ? document.getElementById('hesitation-task').value : null,
            category: hesitationStatus === 'observed' ? document.getElementById('hesitation-category').value : null,
            note: document.getElementById('hesitation-note').value.trim(),
          },
          first_success: {
            status: successStatus,
            task_id: successStatus === 'observed' ? document.getElementById('success-task').value : null,
            elapsed_seconds: successStatus === 'observed' ? Number(document.getElementById('success-seconds').value) : null,
          },
          misleading_assumptions: {
            observed: assumptionStatus === 'observed',
            categories: assumptionStatus === 'observed' ? selectedAssumptions() : [],
            first_task_id: assumptionStatus === 'observed' ? document.getElementById('assumption-task').value : null,
            note: document.getElementById('assumption-note').value.trim(),
          },
          stopping_point: {
            task_id: document.getElementById('stopping-task').value,
            reason: document.getElementById('stopping-reason').value,
            note: document.getElementById('stopping-note').value.trim(),
          },
        },
      };
    }

    function downloadSession(session) {
      const blob = new Blob([JSON.stringify(session, null, 2) + '\\n'], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'completed-first-run-usability-' + session.protocol_id + '-' + session.participant.participant_id + '.json';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function updateProgress() {
      const required = [...form.querySelectorAll('[required]')].filter((control) => !control.disabled);
      let answered = 0;
      const seenRadioGroups = new Set();
      let total = 0;
      for (const control of required) {
        if (control.type === 'radio') {
          if (seenRadioGroups.has(control.name)) continue;
          seenRadioGroups.add(control.name);
          total += 1;
          if (checkedValue(control.name)) answered += 1;
          continue;
        }
        total += 1;
        if (control.type === 'checkbox' ? control.checked : Boolean(control.value)) answered += 1;
      }
      const percentage = total ? Math.round((answered / total) * 100) : 0;
      const track = document.querySelector('.progress-track');
      document.querySelector('.progress-fill').style.width = percentage + '%';
      document.querySelector('.progress-count').textContent = answered + ' / ' + total;
      track.setAttribute('aria-valuemax', String(total));
      track.setAttribute('aria-valuenow', String(answered));
    }

    document.getElementById('protocol-id').textContent = protocol.protocol_id;
    renderTasks();
    taskSelect('hesitation-task', false);
    taskSelect('success-task', false);
    taskSelect('assumption-task', false);
    taskSelect('stopping-task', true);
    const hesitationCategory = document.getElementById('hesitation-category');
    hesitationCategory.appendChild(option('', 'Choose one'));
    for (const category of ['navigation', 'terminology', 'command_or_setup', 'waiting_or_feedback', 'privacy_boundary', 'capability_boundary', 'error_recovery', 'other']) {
      hesitationCategory.appendChild(option(category, labels[category]));
    }
    renderAssumptionCategories();
    setConditionalGroup('hesitation-status', ['hesitation-task', 'hesitation-category'], 'observed');
    document.getElementById('hesitation-note').dataset.optional = 'true';
    setConditionalGroup('success-status', ['success-task', 'success-seconds'], 'observed');
    document.getElementById('assumption-status').addEventListener('change', updateAssumptionState);
    updateAssumptionState();
    form.addEventListener('input', updateProgress);
    form.addEventListener('change', updateProgress);
    updateProgress();

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      statusNode.className = 'status';
      statusNode.textContent = '';
      if (!form.reportValidity()) {
        statusNode.className = 'status error';
        statusNode.textContent = 'Complete every required field before downloading.';
        return;
      }
      const relationshipError = validateRelationships();
      if (relationshipError) {
        statusNode.className = 'status error';
        statusNode.textContent = relationshipError;
        return;
      }
      const session = completedSession();
      downloadSession(session);
      statusNode.textContent = 'Downloaded a private session. Validate it before aggregation.';
    });
  </script>
</body>
</html>
`;
}
