import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CombinedAutocompleteProvider, Editor } from "@earendil-works/pi-tui";
import { withCommandCompletions } from "../../src/surfaces/cli/command-completions.mjs";

function fixture(basePath = process.cwd()) {
  const modelLookups = [];
  const commands = withCommandCompletions(
    ["theme", "art", "motion", "web", "spotify", "model", "auth", "import", "remember"].map((name) => ({ name, description: name })),
    {
      providers: () => [
        { id: "openai-codex", name: "Codex", modelCount: 2 },
        { id: "xai", name: "Grok", modelCount: 1 },
        { id: "empty", name: "No models", modelCount: 0 },
      ],
      models: (provider) => {
        modelLookups.push(provider);
        return provider === "openai-codex"
          ? [{ id: "gpt-test", name: "Test model" }, { id: "gpt-second", name: "Second model" }]
          : [{ id: "grok-test", name: "Test Grok" }];
      },
      authProviderIds: ["openai-codex", "empty"],
    },
  );
  const provider = new CombinedAutocompleteProvider(commands, basePath, null);
  const suggestions = (text, { cursor = text.length, force = false } = {}) =>
    provider.getSuggestions([text], 0, cursor, { signal: new AbortController().signal, force });
  return { provider, suggestions, commands, modelLookups };
}

function editorFixture(context, provider) {
  const identity = (value) => value;
  let renders = 0;
  const editor = new Editor({ terminal: { rows: 24 }, requestRender() { renders += 1; } }, {
    borderColor: identity,
    selectList: Object.fromEntries(["selectedPrefix", "selectedText", "description", "scrollInfo", "noMatch"].map((key) => [key, identity])),
  });
  editor.setAutocompleteProvider(provider);
  context.after(() => editor.setText(""));
  return {
    editor,
    async type(text) {
      editor.setText(text.slice(0, -1));
      const previousRenders = renders;
      editor.handleInput(text.at(-1));
      const deadline = performance.now() + 1000;
      while (renders === previousRenders && performance.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.ok(renders > previousRenders, `Autocomplete did not finish for ${text}`);
    },
  };
}

test("completion augments definitions without changing descriptions, unrelated commands, or custom completers", () => {
  const custom = () => null;
  const commands = Object.freeze([
    Object.freeze({ name: "theme", description: "Original theme description" }),
    Object.freeze({ name: "import", description: "Saved file" }),
    Object.freeze({ name: "auth", argumentHint: "custom", getArgumentCompletions: custom }),
  ]);
  const result = withCommandCompletions(commands);
  assert.equal(result[0].description, commands[0].description);
  assert.equal(typeof result[0].getArgumentCompletions, "function");
  assert.equal(commands[0].getArgumentCompletions, undefined);
  assert.equal(result[1], commands[1]);
  assert.equal(result[2].argumentHint, "custom");
  assert.equal(result[2].getArgumentCompletions, custom);
});

test("Pi applies enum and model completions to exactly the intended command arguments", async () => {
  const { provider, suggestions } = fixture();
  for (const [input, chosen, expected] of [
    ["/theme ch", "charcoal", "/theme charcoal"],
    ["/art a", "ascii", "/art ascii"],
    ["/motion of", "off", "/motion off"],
    ["/web se", "search", "/web search"],
    ["/spotify queue-", "queue-add", "/spotify queue-add"],
    ["/spotify shuffle o", "on", "/spotify shuffle on"],
    ["/spotify repeat t", "track", "/spotify repeat track"],
    ["/auth op", "openai-codex", "/auth openai-codex"],
    ["/model op", "openai-codex", "/model openai-codex"],
    ["/model openai-codex gp", "gpt-test", "/model openai-codex gpt-test"],
    ["/model  OPENAI-CODEX   gp", "gpt-test", "/model  OPENAI-CODEX   gpt-test"],
  ]) {
    const matches = await suggestions(input);
    const selected = matches?.items.find((item) => item.label === chosen);
    assert.ok(selected, `Expected ${chosen} for ${input}`);
    const result = provider.applyCompletion([input], 0, input.length, selected, matches.prefix);
    assert.deepEqual(result, { lines: [expected], cursorLine: 0, cursorCol: expected.length });
  }
  const input = "/spotify repeat t trailing text";
  const cursor = "/spotify repeat t".length;
  const matches = await suggestions(input, { cursor });
  const result = provider.applyCompletion([input], 0, cursor, matches.items[0], matches.prefix);
  assert.equal(result.lines[0], "/spotify repeat track trailing text");
  assert.equal(result.cursorCol, "/spotify repeat track".length);
});

test("provider suggestions follow model availability and authentication support without probing unknown providers", async () => {
  const { suggestions, modelLookups } = fixture();
  assert.deepEqual((await suggestions("/model ")).items.map((item) => item.value), ["openai-codex", "xai"]);
  assert.deepEqual((await suggestions("/auth ")).items.map((item) => item.value), ["openai-codex", "empty"]);
  assert.equal(await suggestions("/model unknown g"), null);
  assert.equal(await suggestions("/model empty g"), null);
  assert.deepEqual(modelLookups, []);
});

test("completed enums, paths, quoted input, and freeform positions do not acquire enum suggestions", async () => {
  const { suggestions } = fixture();
  for (const input of [
    "/theme paper ", "/theme p extra", "/theme \"p", "/art ./", "/motion on ",
    "/web search quiet jazz", "/web read https://example.com", "/web search ",
    "/spotify import-history ", "/spotify import-history \"/tmp/My History.zip\"",
    "/spotify resolve --title \"Quiet Song\"", "/spotify play spotify:track:123",
    "/spotify configure client-id", "/spotify volume 70", "/spotify seek 1000",
    "/spotify transfer device-id ", "/spotify shuffle on ", "/spotify repeat track more",
    "/spotify unknown ", "/spotify constructor ", "/spotify __proto__ ",
    "/model openai-codex gpt-test ", "/auth openai-codex secret", "/remember a preference",
    "/import \"/tmp/My History.zip\"",
  ]) assert.equal(await suggestions(input), null, input);
});

test("Pi forced file completion retains quoted paths and existing closing quotes", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-completion-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "My History.zip"), "fixture only");
  const { provider, suggestions } = fixture(root);
  for (const command of ["import", "spotify import-history"]) {
    const input = `/${command} "./My H"`;
    const cursor = input.length - 1;
    const matches = await suggestions(input, { cursor, force: true });
    assert.ok(matches?.items.length, input);
    const result = provider.applyCompletion([input], 0, cursor, matches.items[0], matches.prefix);
    const expected = `/${command} "./My History.zip"`;
    assert.equal(result.lines[0], expected);
    assert.equal(result.cursorCol, expected.length);
  }
});

test("accepting an argument suggestion with Enter or Tab edits the Pi composer without submitting", async (context) => {
  const { provider } = fixture();
  const { editor, type } = editorFixture(context, provider);
  let submissions = 0;
  editor.onSubmit = () => { submissions += 1; };
  for (const key of ["\r", "\t"]) {
    await type("/spotify shuffle o");
    assert.equal(editor.isShowingAutocomplete(), true);
    editor.handleInput(key);
    assert.equal(editor.getText(), "/spotify shuffle on");
    assert.equal(submissions, 0);
  }
});

test("fully typed legal arguments submit on the first Enter after autocomplete finishes", async (context) => {
  const { provider } = fixture();
  const { editor, type } = editorFixture(context, provider);
  const submissions = [];
  editor.onSubmit = (text) => { submissions.push(text); };
  for (const input of [
    "/spotify status", "/spotify queue", "/spotify repeat track", "/theme paper",
    "/model openai-codex", "/model openai-codex gpt-test",
  ]) {
    await type(input);
    assert.equal(editor.isShowingAutocomplete(), false, input);
    const before = submissions.length;
    editor.handleInput("\r");
    assert.equal(submissions.length, before + 1, input);
    assert.equal(submissions.at(-1), input);
    assert.equal(editor.getText(), "");
  }
});

test("differently cased arguments can still be completed to the spelling accepted by the command", async (context) => {
  const { provider } = fixture();
  const { editor, type } = editorFixture(context, provider);
  let submissions = 0;
  editor.onSubmit = () => { submissions += 1; };
  await type("/theme PAPER");
  assert.equal(editor.isShowingAutocomplete(), true);
  editor.handleInput("\r");
  assert.equal(editor.getText(), "/theme paper");
  assert.equal(submissions, 0);
});
