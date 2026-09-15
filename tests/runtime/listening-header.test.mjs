import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ListeningHeader } from "../../src/surfaces/cli/brand-components.mjs";
import { createMoondogTheme } from "../../src/surfaces/cli/brand-theme.mjs";

const plainTheme = createMoondogTheme({ environment: { NO_COLOR: "1" } });
const ready = { profileReady: true, modelReady: true, spotifyReady: true, provider: "zai", model: "glm-4.7" };

test("the two-row header shows model identity and preserves its existing layout", () => {
  for (const theme of [plainTheme, createMoondogTheme({ mode: "paper", environment: { COLORTERM: "truecolor" } })]) {
    const header = new ListeningHeader(() => theme, () => ready);
    for (const width of [20, 40, 60, 100]) {
      const lines = header.render(width);
      assert.equal(lines.length, 2);
      for (const line of lines) assert.equal(visibleWidth(line), width);
      const [title, status] = lines.map(stripVTControlCharacters);
      assert.match(title, /^ MOONDOG/u);
      assert.match(status, /glm-4\.7/u, `model remains visible at ${width} columns`);
      if (width >= 60) assert.match(status, /zai \/ glm-4\.7/u);
      if (width === 100) assert.match(status, /local profile.*Spotify connected/u);
      if (theme.plain) assert.ok(lines.every((line) => !line.includes("\x1b")));
    }
  }
});

test("width pressure removes optional status before truncating the active model", () => {
  const header = new ListeningHeader(() => plainTheme, () => ({
    ...ready, provider: "a-provider-with-a-long-name", model: "claude-sonnet-4.5",
  }));
  const narrow = header.render(20)[1];
  assert.equal(narrow.trim(), "claude-sonnet-4.5");
  assert.equal(header.render(40)[1].trim(), "profile ready  ·  claude-sonnet-4.5");

  const unicode = new ListeningHeader(() => plainTheme, () => ({ ...ready, model: "音乐".repeat(20) }));
  for (const width of [20, 40, 60, 100]) {
    const lines = unicode.render(width);
    for (const line of lines) assert.equal(visibleWidth(line), width);
    assert.match(lines[1], /音乐/u);
  }
  assert.match(unicode.render(20)[1], /…/u);
});

test("offline status remains explicit and an updated model appears on the next render", () => {
  let status = { ...ready };
  const header = new ListeningHeader(() => plainTheme, () => status);
  assert.match(header.render(100)[1], /zai \/ glm-4\.7/u);
  status = { ...status, provider: "openai", model: "gpt-5.4" };
  assert.match(header.render(100)[1], /openai \/ gpt-5\.4/u);
  assert.doesNotMatch(header.render(100)[1], /glm-4\.7/u);
  status.modelReady = false;
  for (const width of [20, 40, 60, 100]) {
    const line = header.render(width)[1];
    assert.match(line, /model offline/u);
    assert.doesNotMatch(line, /openai|gpt-5\.4/u);
    assert.equal(visibleWidth(line), width);
  }

  status = { profileReady: true, modelReady: true };
  assert.match(header.render(40)[1], /model ready/u);
  assert.match(header.render(100)[1], /conversation ready/u);
});

test("provider and model labels cannot inject terminal controls or extra rows", () => {
  const header = new ListeningHeader(() => plainTheme, () => ({
    ...ready,
    provider: "\x1b[31mzai\x1b[0m\n\t",
    model: "\x1b]2;renamed\x07glm-\u202e4.7\x1b[2J\r\n\x00",
  }));
  const lines = header.render(100);
  assert.equal(lines.length, 2);
  assert.match(lines[1], /zai \/ glm-4\.7/u);
  assert.doesNotMatch(lines.join(""), /[\x00-\x1f\x7f-\x9f\u202e]|renamed|\[2J/u);
});
