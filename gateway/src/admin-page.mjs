// The owner's page for invite codes, served at /admin. It is one static page with no data in it:
// the owner types the admin key, and the page asks /admin/invites with it. The key stays in this
// browser's storage until the owner locks the page.

export const ADMIN_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Moondog invites</title>
<style>
:root {
  --bg: #fbfbfa; --fg: #1d1d1b; --muted: #77756f; --faint: #b9b7b0; --line: #e7e5df;
  --field: #f2f1ed; --hover: #efeee9; --danger: #a3361f;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #161615; --fg: #ecebe6; --muted: #9a988f; --faint: #5c5b56; --line: #2a2a28;
    --field: #21211f; --hover: #262624; --danger: #e0846e;
    color-scheme: dark;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
}
main { max-width: 1080px; margin: 0 auto; padding: 40px 24px 80px; }
header { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin-bottom: 28px; }
h1 { font-size: 20px; font-weight: 600; margin: 0; letter-spacing: -0.01em; }
h2 { font-size: 13px; font-weight: 600; margin: 0 0 10px; color: var(--muted); }
.summary { color: var(--muted); font-variant-numeric: tabular-nums; }
button, input, textarea {
  font: inherit; color: inherit;
}
input, textarea {
  background: var(--field); border: 1px solid transparent; border-radius: 6px; padding: 7px 9px; width: 100%;
}
input:focus, textarea:focus { outline: none; border-color: var(--faint); }
textarea { resize: vertical; }
button {
  background: none; border: 1px solid var(--line); border-radius: 6px; padding: 6px 12px; cursor: pointer; white-space: nowrap;
}
button:hover { background: var(--hover); }
button.primary { background: var(--fg); color: var(--bg); border-color: var(--fg); }
button.primary:hover { opacity: 0.88; }
button.quiet { border-color: transparent; color: var(--muted); padding: 4px 8px; }
button.quiet:hover { color: var(--fg); }
button:disabled { opacity: 0.5; cursor: default; }
.gate { max-width: 340px; margin: 18vh auto 0; display: grid; gap: 12px; }
.gate p { margin: 0; color: var(--muted); }
.error { color: var(--danger); min-height: 1.4em; margin: 0; }
section { margin-bottom: 36px; }
.create { display: grid; grid-template-columns: 1fr 1fr auto; gap: 10px; align-items: start; }
.made { margin-top: 14px; display: grid; gap: 8px; }
.made-row { display: grid; grid-template-columns: minmax(80px, 160px) 1fr auto auto; gap: 10px; align-items: center; padding: 10px 12px; background: var(--field); border-radius: 8px; }
.made-row code { font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
.made p { margin: 4px 0 0; color: var(--muted); font-size: 13px; }
.tools { display: flex; gap: 10px; align-items: center; margin-bottom: 8px; }
.tools input { max-width: 280px; }
.tools label { color: var(--muted); display: flex; gap: 6px; align-items: center; white-space: nowrap; }
.tools label input { width: auto; }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; min-width: 820px; }
th { text-align: left; font-weight: 500; color: var(--muted); font-size: 12px; padding: 6px 8px; }
td { padding: 4px 8px; vertical-align: top; }
tr.row:hover td { background: var(--hover); }
tr.row td:first-child { border-radius: 6px 0 0 6px; }
tr.row td:last-child { border-radius: 0 6px 6px 0; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
td.id { color: var(--muted); font-variant-numeric: tabular-nums; padding-top: 11px; }
td.meta { color: var(--muted); padding-top: 11px; }
td.num { padding-top: 11px; }
td input, td textarea { background: transparent; padding: 6px 6px; }
td input:hover, td textarea:hover { background: var(--field); }
td input:focus, td textarea:focus { background: var(--field); }
td textarea { min-height: 33px; height: 33px; overflow: hidden; resize: none; }
th.field { padding-left: 14px; }
td textarea:focus { overflow: auto; }
td.actions { text-align: right; padding-top: 6px; white-space: nowrap; }
tr.stopped td input, tr.stopped td textarea, tr.stopped td.num, tr.stopped td.meta { color: var(--faint); }
.saved { color: var(--muted); font-size: 12px; }
.bar { display: block; height: 2px; background: var(--line); border-radius: 1px; margin-top: 4px; }
.bar > i { display: block; height: 100%; background: var(--fg); border-radius: 1px; }
.empty { color: var(--muted); padding: 24px 8px; }
[hidden] { display: none !important; }
@media (max-width: 720px) {
  main { padding: 24px 16px 60px; }
  header { flex-direction: column; gap: 4px; }
  .create { grid-template-columns: 1fr; }
  .tools { flex-wrap: wrap; }
  .made-row { grid-template-columns: 1fr auto auto; }
  .made-row .made-name { grid-column: 1 / -1; }
}
</style>
</head>
<body>
<main>
  <form class="gate" id="gate" hidden>
    <h1>Moondog invites</h1>
    <p>Enter the gateway's admin key.</p>
    <input id="key" type="password" autocomplete="current-password" placeholder="Admin key" autofocus>
    <button class="primary" type="submit">Open</button>
    <p class="error" id="gate-error"></p>
  </form>

  <div id="app" hidden>
    <header>
      <h1>Moondog invites</h1>
      <div class="tools" style="margin:0">
        <span class="summary" id="summary"></span>
        <button class="quiet" id="refresh" title="Refresh (R)">Refresh</button>
        <button class="quiet" id="lock">Lock</button>
      </div>
    </header>

    <section>
      <h2>New codes</h2>
      <form class="create" id="create">
        <textarea id="names" rows="2" placeholder="Names, one per line"></textarea>
        <textarea id="new-note" rows="2" placeholder="Note for these codes (optional)"></textarea>
        <button class="primary" type="submit">Make codes</button>
      </form>
      <p class="error" id="create-error"></p>
      <div class="made" id="made" hidden></div>
    </section>

    <section>
      <div class="tools">
        <input id="filter" type="search" placeholder="Find a name or note (/)">
        <label><input id="show-stopped" type="checkbox"> Show stopped codes</label>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th><th class="field" style="width:22%">Name</th><th class="field">Note</th>
              <th class="num">Today</th><th class="num">Requests</th><th class="num">All time</th><th>Made</th><th></th>
            </tr>
          </thead>
          <tbody id="rows"></tbody>
        </table>
      </div>
      <p class="error" id="list-error"></p>
    </section>
  </div>
</main>
<script>
(() => {
  const STORE = "moondog-admin-key";
  const $ = (id) => document.getElementById(id);
  let key = "";
  let state = { day: "", daily_tokens: 0, invites: [] };
  try { key = localStorage.getItem(STORE) || ""; } catch {}

  const millions = (n) => n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n);
  const madeOn = (ms) => ms ? new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
  const linkFor = (code) => location.origin + "/invite/" + code;

  async function call(path, method = "GET", body) {
    const reply = await fetch(path, {
      method,
      headers: { authorization: "Bearer " + key, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await reply.json().catch(() => ({}));
    if (reply.status === 401) { lock("That key isn't the admin key."); throw new Error("locked"); }
    if (!reply.ok) throw new Error((data.error && data.error.message) || "The gateway answered " + reply.status + ".");
    return data;
  }

  function lock(message = "") {
    key = "";
    try { localStorage.removeItem(STORE); } catch {}
    $("app").hidden = true;
    $("gate").hidden = false;
    $("gate-error").textContent = message;
    $("key").value = "";
    $("key").focus();
  }

  async function open() {
    $("gate").hidden = true;
    $("app").hidden = false;
    await load();
  }

  async function load() {
    try {
      state = await call("/admin/invites");
      $("list-error").textContent = "";
      render();
    } catch (error) {
      if (error.message !== "locked") $("list-error").textContent = error.message;
    }
  }

  function render() {
    const active = state.invites.filter((invite) => invite.status === "active");
    const today = state.invites.reduce((sum, invite) => sum + invite.input_today + invite.output_today, 0);
    $("summary").textContent = active.length + " active \\u00b7 " + millions(today) + " tokens today \\u00b7 " + state.day + " Beijing";

    const query = $("filter").value.trim().toLowerCase();
    const showStopped = $("show-stopped").checked;
    const shown = state.invites
      .filter((invite) => showStopped || invite.status === "active")
      .filter((invite) => !query || (invite.label + " " + (invite.note || "")).toLowerCase().includes(query))
      .sort((a, b) => b.id - a.id);

    const rows = $("rows");
    rows.replaceChildren();
    if (shown.length === 0) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 8; td.className = "empty";
      td.textContent = state.invites.length === 0 ? "No codes yet." : "No codes match.";
      tr.append(td); rows.append(tr);
      return;
    }
    for (const invite of shown) rows.append(row(invite));
    for (const area of rows.querySelectorAll("textarea")) fit(area);
  }

  function fit(area) {
    area.style.height = "33px";
    if (document.activeElement === area || area.value.includes("\\n") || area.scrollHeight > 40) area.style.height = Math.min(area.scrollHeight + 2, 200) + "px";
  }

  function row(invite) {
    const tr = document.createElement("tr");
    tr.className = "row" + (invite.status === "active" ? "" : " stopped");
    const cell = (className, content) => {
      const td = document.createElement("td");
      if (className) td.className = className;
      if (content instanceof Node) td.append(content); else td.textContent = content;
      tr.append(td);
      return td;
    };
    cell("id", String(invite.id));

    const name = document.createElement("input");
    name.value = invite.label; name.maxLength = 80; name.placeholder = "Name"; name.setAttribute("aria-label", "Name of code " + invite.id);
    cell("cell-name", name);
    const note = document.createElement("textarea");
    note.value = invite.note || ""; note.maxLength = 1000; note.placeholder = "Add a note"; note.rows = 1; note.setAttribute("aria-label", "Note for code " + invite.id);
    note.addEventListener("input", () => fit(note));
    note.addEventListener("focus", () => fit(note));
    cell("", note);
    const saved = document.createElement("span");
    saved.className = "saved";

    const limit = invite.daily_token_limit || state.daily_tokens;
    const used = invite.input_today + invite.output_today;
    const today = cell("num", millions(used));
    today.title = millions(used) + " of " + millions(limit) + " today";
    if (used > 0) {
      const bar = document.createElement("span");
      bar.className = "bar";
      const fill = document.createElement("i");
      fill.style.width = Math.min(100, (used / limit) * 100).toFixed(1) + "%";
      bar.append(fill); today.append(bar);
    }
    cell("num", String(invite.requests_today));
    cell("num", millions(invite.tokens_total));
    cell("meta", madeOn(invite.created_at));

    const actions = cell("actions", saved);
    const toggle = document.createElement("button");
    toggle.className = "quiet";
    toggle.textContent = invite.status === "active" ? "Stop" : "Restore";
    toggle.addEventListener("click", async () => {
      const action = invite.status === "active" ? "revoke" : "restore";
      if (action === "revoke" && !confirm("Stop code " + invite.id + (invite.label ? " (" + invite.label + ")" : "") + "? It stops working at once. You can restore it later.")) return;
      toggle.disabled = true;
      try {
        const result = await call("/admin/invites/" + invite.id + "/" + action, "POST");
        invite.status = result.status;
        render();
      } catch (error) {
        toggle.disabled = false;
        if (error.message !== "locked") $("list-error").textContent = error.message;
      }
    });
    actions.append(toggle);

    const save = async (field, input) => {
      const value = input.value.trim();
      if (value === (invite[field] || "")) return;
      saved.textContent = "Saving";
      try {
        const result = await call("/admin/invites/" + invite.id, "PATCH", { [field]: value });
        invite[field] = result[field];
        input.value = result[field];
        saved.textContent = "Saved";
        setTimeout(() => { if (saved.textContent === "Saved") saved.textContent = ""; }, 1600);
      } catch (error) {
        saved.textContent = "";
        if (error.message !== "locked") $("list-error").textContent = error.message;
      }
    };
    name.addEventListener("blur", () => save("label", name));
    note.addEventListener("blur", () => { save("note", note); fit(note); });
    name.addEventListener("keydown", (event) => {
      if (event.key === "Enter") name.blur();
      if (event.key === "Escape") { name.value = invite.label; name.blur(); }
    });
    note.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); note.blur(); }
      if (event.key === "Escape") { note.value = invite.note || ""; note.blur(); }
    });
    return tr;
  }

  function copyButton(label, text) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(text); button.textContent = "Copied"; }
      catch { button.textContent = "Copy failed"; }
      setTimeout(() => { button.textContent = label; }, 1400);
    });
    return button;
  }

  $("gate").addEventListener("submit", async (event) => {
    event.preventDefault();
    key = $("key").value.trim();
    if (!key) return;
    try { localStorage.setItem(STORE, key); } catch {}
    await open();
  });

  $("create").addEventListener("submit", async (event) => {
    event.preventDefault();
    const labels = $("names").value.split("\\n").map((line) => line.trim()).filter(Boolean);
    if (labels.length === 0) { $("create-error").textContent = "Write at least one name."; $("names").focus(); return; }
    const button = event.submitter || $("create").querySelector("button");
    button.disabled = true;
    try {
      const { invites } = await call("/admin/invites", "POST", { labels, note: $("new-note").value.trim() });
      $("create-error").textContent = "";
      $("names").value = ""; $("new-note").value = "";
      const made = $("made");
      made.replaceChildren();
      for (const invite of invites) {
        const line = document.createElement("div");
        line.className = "made-row";
        const name = document.createElement("strong");
        name.className = "made-name";
        name.textContent = invite.label || "Code " + invite.id;
        const code = document.createElement("code");
        code.textContent = invite.code;
        line.append(name, code, copyButton("Copy code", invite.code), copyButton("Copy link", linkFor(invite.code)));
        made.append(line);
      }
      const hint = document.createElement("p");
      hint.textContent = "Copy these now. The gateway keeps only a hash, so a code is shown once.";
      made.append(hint);
      made.hidden = false;
      await load();
    } catch (error) {
      if (error.message !== "locked") $("create-error").textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  $("refresh").addEventListener("click", load);
  $("lock").addEventListener("click", () => lock());
  $("filter").addEventListener("input", render);
  $("show-stopped").addEventListener("change", render);
  document.addEventListener("keydown", (event) => {
    const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement && document.activeElement.tagName);
    if (typing || $("app").hidden || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "/") { event.preventDefault(); $("filter").focus(); }
    if (event.key === "r") load();
    if (event.key === "n") { event.preventDefault(); $("names").focus(); }
  });

  if (key) open(); else lock();
})();
</script>
</body>
</html>
`;
