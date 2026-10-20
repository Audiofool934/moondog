import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline/promises";
import test from "node:test";
import { WindowTerminal } from "../../app/window-terminal.mjs";

function fixture() {
  const sent = [];
  const signals = new EventEmitter();
  const terminal = new WindowTerminal({ cols: 80, rows: 24 }, {
    send: (data) => sent.push(data),
    notify: () => {},
    signalTarget: signals,
  });
  return { terminal, sent, signals, screen: () => sent.join("") };
}

test("the window is the room's keyboard while the room runs", () => {
  const { terminal, signals } = fixture();
  const keys = [];
  let interrupted = false;
  signals.on("SIGINT", () => { interrupted = true; });
  terminal.start((sequence) => keys.push(sequence), () => {});
  terminal.input("a\x03");
  assert.deepEqual(keys, ["a", "\x03"], "the room handles its own Ctrl+C");
  assert.equal(interrupted, false);
  terminal.stop();
});

test("while the room steps aside, the window answers a sign-in prompt like a terminal", async () => {
  const { terminal, screen } = fixture();
  terminal.start(() => {}, () => {});
  terminal.stop();
  terminal.input("early");
  const { input, output } = terminal.streams;
  assert.equal(input.isTTY && output.isTTY, true, "sign-in sees an interactive terminal");
  assert.equal(output.columns, 80);
  output.write("Open this URL:\nhttps://example.test\n");
  output.write("Waiting.\n");
  assert.match(screen(), /\x1b\[2J\x1b\[HOpen this URL:\r\nhttps:\/\/example\.test\r\nWaiting\.\r\n$/u,
    "the sign-in starts on a clean screen, and lines end as they do in a terminal");

  const prompt = createInterface({ input, output, terminal: true });
  const answer = prompt.question("Key: ");
  terminal.input("sk-test\r");
  assert.equal(await answer, "sk-test", "keys typed before the prompt are not part of the answer");
  prompt.close();
});

test("Ctrl+C cancels a sign-in while the room steps aside", () => {
  const { terminal, signals } = fixture();
  let interrupted = 0;
  signals.on("SIGINT", () => { interrupted += 1; });
  terminal.input("\x03");
  assert.equal(interrupted, 1);
});
