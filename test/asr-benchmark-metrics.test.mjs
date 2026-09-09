import test from "node:test";
import assert from "node:assert/strict";
import { scoreAsr, mixedUnits, aggregateAsrScores } from "../src/asr-benchmark-metrics.js";

test("mixed error rate treats Chinese as characters and English as words", () => {
  assert.deepEqual(mixedUnits("我用 Agent Sandbox。"), ["我", "用", "agent", "sandbox"]);
  const scores = scoreAsr("我用 Agent Sandbox", "我用 Agent Box");
  assert.equal(scores.mer.reference_units, 4);
  assert.equal(scores.mer.substitutions, 1);
  assert.equal(scores.mer.rate, .25);
});
test("deletions, insertions and empty hypotheses remain visible", () => {
  const missing = scoreAsr("甲乙丙", "甲丙");
  assert.equal(missing.cer.deletions, 1);
  const inserted = scoreAsr("甲乙", "甲乙丙");
  assert.equal(inserted.cer.insertions, 1);
  assert.equal(scoreAsr("你好", "").cer.rate, 1);
});
test("aggregation is micro-averaged over reference units", () => {
  const result = aggregateAsrScores([{ scores: scoreAsr("甲", "乙") }, { scores: scoreAsr("甲乙丙", "甲乙丙") }]);
  assert.equal(result.cer.reference_units, 4);
  assert.equal(result.cer.rate, .25);
});
