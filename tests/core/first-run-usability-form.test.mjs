import assert from "node:assert/strict";
import test from "node:test";

import { createFirstRunUsabilityProtocol } from "../../src/evaluation/first-run-usability.mjs";
import { renderFirstRunUsabilityForm } from "../../src/evaluation/first-run-usability-form.mjs";

test("first-run observer form is self-contained, private, and task complete", () => {
  const protocol = createFirstRunUsabilityProtocol({
    generatedAt: "2026-09-03T08:00:00.000Z",
  });
  const html = renderFirstRunUsabilityForm(protocol);

  assert.match(html, /Content-Security-Policy/u);
  assert.match(html, /connect-src 'none'/u);
  assert.match(html, /First-run field notes/u);
  assert.match(html, /clean Moondog source checkout/u);
  assert.match(html, /Keep the downloaded JSON in the ignored runs directory/u);
  assert.match(html, /Fictional only/u);
  assert.match(html, /Moondog-generated archive/u);
  assert.match(html, /Exercise the real importer with fictional history/u);
  assert.match(html, /Download private session JSON/u);
  assert.match(html, /completed-first-run-usability-/u);
  assert.match(html, new RegExp(protocol.protocol_id, "u"));
  for (const task of protocol.tasks) {
    assert.match(html, new RegExp(task.title, "u"));
  }
  assert.doesNotMatch(html, /https?:\/\//u);
  assert.doesNotMatch(html, /<script[^>]+src=/u);
  assert.doesNotMatch(html, /Spotify export|listening archive[^,]/u);
});

test("first-run observer form rejects a protocol with changed task content", () => {
  const protocol = createFirstRunUsabilityProtocol({
    generatedAt: "2026-09-03T08:00:00.000Z",
  });
  protocol.tasks[0].title = "Changed without a digest update";

  assert.throws(
    () => renderFirstRunUsabilityForm(protocol),
    /digest does not match/u,
  );
});
