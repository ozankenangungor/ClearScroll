import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { MODEL_PROFILES } from "../../src/shared/models.ts";

test("shipped thresholds equal the published calibration (docs/evaluation/results.json)", () => {
  const results = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../../docs/evaluation/results.json"), "utf8"));
  for (const [id, profile] of Object.entries(MODEL_PROFILES)) {
    assert.ok(results[id], `no published evaluation for ${id}`);
    for (const mode of ["precision", "balanced", "aggressive"] as const) {
      assert.equal(profile.thresholds[mode], results[id].modes[mode].threshold, `${id}/${mode}`);
    }
  }
});
