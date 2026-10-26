import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";

import { MoondogApplication } from "../../src/core/moondog-application.mjs";
import { createSyntheticDomainServices } from "../../src/core/synthetic-domain-services.mjs";
import { openLocalMemoryStore, shortConversationTitle } from "../../src/memory/local-memory-store.mjs";
import { PiAgentRuntime } from "../../src/runtime/pi/agent-runtime.mjs";
import { cleanConversationName } from "../../src/runtime/pi/conversation-name.mjs";

const LONG = "Make me a playlist for a long night drive along the coast, with slow synth records, a little jazz, and nothing too loud after midnight please";

async function withApplication(callback) {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-conversation-naming-"));
  let application;
  try {
    const memoryStore = await openLocalMemoryStore({ databasePath: path.join(root, "memory.sqlite") });
    application = new MoondogApplication({ importsRoot: "/private/moondog-synthetic-missing-source", memoryStore,
      domainServices: createSyntheticDomainServices({ subjectScope: { subjectId: "trusted-synthetic-subject" } }) });
    return await callback(application);
  } finally {
    application?.close();
    await rm(root, { recursive: true, force: true });
  }
}

function reply(application, user, text = "Here is a start.") {
  const entryId = application.beginConversationEntry(user);
  application.finishConversationEntry({ status: "completed", text });
  return entryId;
}

const listed = (application, id) => application.listSavedSessions().find((session) => session.session_id === id);

test("a long first message is listed cut short at a word, and so is a branch's lineage", async () => {
  const short = shortConversationTitle(LONG);
  assert.ok(Array.from(short).length <= 60);
  assert.match(short, /^Make me a playlist for a long night drive along the coast,? ?[a-z]*…$/u);
  assert.equal(shortConversationTitle("Play something bright."), "Play something bright.");
  // Text without spaces is cut where it stands.
  assert.equal(Array.from(shortConversationTitle("深".repeat(90))).length, 60);

  await withApplication(async (application) => {
    const root = application.ensureMemorySession().session_id;
    const entryId = reply(application, LONG);
    assert.equal(listed(application, root).title, short);
    const branch = application.branchConversation(entryId).session_id;
    assert.equal(listed(application, branch).title, `${short} #2`);
  });
});

test("the model names an untitled conversation once, and never over the listener's name", async () => {
  await withApplication(async (application) => {
    const first = application.ensureMemorySession().session_id;
    reply(application, LONG, "Coastal synth records ahead.");
    let asked = null;
    const named = await application.nameConversation(first, async (exchange) => { asked = exchange; return "Late night coast drive"; });
    assert.deepEqual(named, { session_id: first, title: "Late night coast drive" });
    assert.equal(asked.user, LONG);
    assert.equal(asked.assistant, "Coastal synth records ahead.");
    assert.ok(asked.signal instanceof AbortSignal);
    assert.equal(listed(application, first).title, "Late night coast drive");
    // Once named, it is not named again.
    assert.equal(await application.nameConversation(first, async () => "Another name"), null);
    assert.equal(listed(application, first).title, "Late night coast drive");

    // A name the listener gives while the model is choosing stays.
    const second = application.startNewSession("user_new").session_id;
    reply(application, "Something bright for the morning");
    const choosing = Promise.withResolvers();
    const naming = application.nameConversation(second, () => choosing.promise);
    application.labelSavedSession(second, { title: "Mornings" });
    choosing.resolve("Bright morning songs");
    assert.equal(await naming, null);
    assert.equal(listed(application, second).title, "Mornings");

    // A failed or slow model keeps the first message.
    const third = application.startNewSession("user_new").session_id;
    reply(application, LONG);
    assert.equal(await application.nameConversation(third, async () => { throw new Error("offline"); }), null);
    assert.equal(await application.nameConversation(third, () => new Promise(() => {}), { timeoutMs: 20 }), null);
    assert.equal(listed(application, third).title, shortConversationTitle(LONG));
    assert.equal(listed(application, third).custom_title, false);

    // Only after the first reply: a conversation with two replies is not asked about.
    const fourth = application.startNewSession("user_new").session_id;
    reply(application, "One");
    reply(application, "Two");
    let called = false;
    assert.equal(await application.nameConversation(fourth, async () => { called = true; return "Never"; }), null);
    assert.equal(called, false);
  });
});

test("without persistent memory the model's name is saved the same way", async () => {
  const application = new MoondogApplication({ importsRoot: "/private/moondog-synthetic-missing-source" });
  try {
    const id = application.ensureMemorySession().session_id;
    reply(application, LONG);
    assert.equal(listed(application, id).title, shortConversationTitle(LONG));
    assert.deepEqual(await application.nameConversation(id, async () => "Coast drive"), { session_id: id, title: "Coast drive" });
    assert.equal(await application.nameConversation(id, async () => "Again"), null);
    assert.equal(listed(application, id).title, "Coast drive");
  } finally { application.close(); }
});

test("the model's reply is tidied into a name", () => {
  assert.equal(cleanConversationName("\"Late Night Drive.\""), "Late Night Drive");
  assert.equal(cleanConversationName("Title: 深夜海边兜风。\nMore text"), "深夜海边兜风");
  assert.equal(cleanConversationName("  \n "), null);
});

test("the agent names a new conversation in the background after its first reply, without tools", async () => {
  await withApplication(async (application) => {
    const session = application.ensureMemorySession().session_id;
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const runtime = new PiAgentRuntime({ application, models, model: faux.getModel(), provider: "faux", modelId: "faux-1", nameConversations: true });
    let namingContext = null;
    faux.setResponses([
      fauxAssistantMessage("Slow synth records for the coast."),
      (context) => { namingContext = context; return fauxAssistantMessage("\"Coastal night drive.\""); },
    ]);
    const named = Promise.withResolvers();
    const result = await runtime.prompt(LONG, { onConversationNamed: named.resolve });
    assert.equal(result.status, "completed");
    assert.equal(result.text, "Slow synth records for the coast.");
    assert.deepEqual(await named.promise, { session_id: session, title: "Coastal night drive" });
    assert.doesNotMatch(JSON.stringify(namingContext), /moondog_library_search/u);
    assert.equal(listed(application, session).title, "Coastal night drive");

    // A second reply asks the model nothing more.
    faux.setResponses([fauxAssistantMessage("More of the same.")]);
    let renamed = false;
    await runtime.prompt("Another one", { onConversationNamed: () => { renamed = true; } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(renamed, false);
    assert.equal(faux.getPendingResponseCount(), 0);
    assert.equal(listed(application, session).title, "Coastal night drive");
  });
});
