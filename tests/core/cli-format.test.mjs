import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeTerminalText } from "../../src/surfaces/cli/format-output.mjs";

test("terminal sanitizer removes escape and bidi control sequences", () => {
  const source = "safe\u001b[2J\u202ehidden\u202c\nnext";
  const sanitized = sanitizeTerminalText(source);

  assert.equal(sanitized, "safe[2Jhidden\nnext");
  assert.equal(sanitized.includes("\u001b"), false);
  assert.equal(sanitized.includes("\u202e"), false);
});
