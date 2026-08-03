import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runTerminologyEvaluation } from "../scripts/terminology-eval.mjs";

test("real cloud-native fixture normalizes every Descheduler alias offline", async () => {
  const report = await runTerminologyEvaluation();

  assert.equal(report.ok, true);
  assert.equal(report.audio.hash_matches, true);
  assert.equal(report.terminology.observed_alias_occurrences, 7);
  assert.equal(report.terminology.canonical_occurrences, 7);
  assert.equal(report.terminology.forbidden_alias_occurrences, 0);
  assert.equal(report.terminology.accepted_ledger_entries, 7);
  assert.equal(report.terminology.rejected_ledger_entries, 0);
  assert.deepEqual(report.terminology.accepted_reasons, ["recording_consensus"]);
  assert.ok(report.model_mock.requests >= 1);
  assert.deepEqual(new Set(report.model_mock.proposed_aliases), new Set([
    "dis scheduler",
    "disk scheduler",
    "Y调度",
    "DisScheduler",
    "d schedule",
  ]));
});

test("terminology evaluation CLI exits non-zero with a machine-readable failure", () => {
  const script = fileURLToPath(new URL("../scripts/terminology-eval.mjs", import.meta.url));
  const missingSpec = fileURLToPath(new URL("../data/missing-terminology-eval.json", import.meta.url));
  const result = spawnSync(process.execPath, [script, missingSpec], { encoding: "utf8" });

  assert.equal(result.status, 1);
  const report = JSON.parse(result.stderr);
  assert.equal(report.ok, false);
  assert.equal(report.schema, 1);
  assert.match(report.error.message, /missing-terminology-eval\.json/);
});
