import assert from "node:assert/strict";
import test from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, getCurrentSystemMessage } from "@earendil-works/pi-ai";
import { openLibraryStore } from "../../src/core/library-store.mjs";
import { MoondogApplication } from "../../src/core/moondog-application.mjs";
import { PiAgentRuntime } from "../../src/runtime/pi/agent-runtime.mjs";

test("a playlist named with @ reaches the model as it stands, and the model can change it", async (t) => {
  const libraryStore = await openLibraryStore({ databasePath: ":memory:" });
  t.after(() => libraryStore.close());
  const rain = libraryStore.savePlaylist({ name: "Rain", entries: [
    { kind: "song", title: "Loud One", artist_credit: "A" }, { kind: "song", title: "Quiet One", artist_credit: "B" }] });
  const app = new MoondogApplication({ importsRoot: "/private/moondog-synthetic-missing-source", libraryStore, playbackService: "apple_music" });
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const runtime = new PiAgentRuntime({ application: app, models, model: faux.getModel(), provider: "faux", modelId: "faux-1" });
  const session = (context) => getCurrentSystemMessage(context.messages)?.sections?.session ?? "";
  const seen = [];
  faux.setResponses([
    (context) => { seen.push(session(context)); return fauxAssistantMessage([fauxToolCall("moondog_collection_edit", { playlist_id: rain.id, remove: [{ title: "Loud One" }] })]); },
    () => fauxAssistantMessage([fauxText("Took it out.")]),
    (context) => { seen.push(session(context)); return fauxAssistantMessage([fauxText("One left.")]); },
    (context) => { seen.push(session(context)); return fauxAssistantMessage([fauxText("Hello.")]); },
  ]);

  await runtime.prompt("@Rain too loud, take the loudest out");
  assert.match(seen[0], /Playlist "Rain"/u);
  assert.match(seen[0], /1\. Loud One - A/u);
  assert.deepEqual(libraryStore.playlist(rain.id).entries.map((entry) => entry.title), ["Quiet One"]);

  // A later message in the conversation still has it, read again, without the song that left.
  await runtime.prompt("what's left?");
  assert.match(seen[1], /1\. Quiet One - B/u);
  assert.doesNotMatch(seen[1], /Loud One/u);

  // A new conversation starts without it.
  app.startNewSession("user_new");
  runtime.reset();
  await runtime.prompt("hello");
  assert.doesNotMatch(seen[2], /Playlist "Rain"/u);
});
