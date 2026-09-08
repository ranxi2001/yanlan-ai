import test from "node:test";
import assert from "node:assert/strict";
import { characterDistance, normalizeTranscriptComparison } from "../scripts/transcript-comparison.mjs";

test("comparison counts character edits without confusing similarity with audio accuracy", () => {
  assert.equal(characterDistance("工作量", "工作车辆"), 2);
  assert.equal(characterDistance("", "😀"), 1);
  assert.equal(characterDistance("策略失效", "审美失效"), 2);
  assert.equal(normalizeTranscriptComparison("Ａgent，K8S！"), "agentk8s");
});
