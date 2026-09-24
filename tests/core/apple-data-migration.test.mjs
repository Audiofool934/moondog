import assert from "node:assert/strict";
import test from "node:test";

import { migrateLegacyAppleMusicData } from "../../src/core/apple-data-migration.mjs";

test("isolated runs never pull checkout Apple data into their own state", async () => {
  for (const name of ["MOONDOG_STATE_HOME", "MOONDOG_CONFIG_HOME", "MOONDOG_APPLE_IMPORTS_ROOT", "MOONDOG_APPLE_PROJECTION_PATH"]) {
    assert.deepEqual(await migrateLegacyAppleMusicData({ [name]: "/nonexistent/isolated" }), { copied: [] });
  }
});
