import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { meetingAgentFailureReport } from "../scripts/meeting-agent-eval.mjs";
import { terminologyAgentFailureReport } from "../scripts/terminology-agent-eval.mjs";

test("live Agent evaluation failure reports never print provider prose or secret-like codes", () => {
  const error = new Error("gateway echoed PRIVATE_TRANSCRIPT_SENTINEL sk-provider-secret");
  error.name = "PRIVATE_TRANSCRIPT_SENTINEL";
  error.code = "sk-provider-secret";
  error.agentState = {
    candidates: [{ canonical: "PRIVATE_TRANSCRIPT_SENTINEL" }],
    signal_resolutions: [{ disposition: "mapped", canonical: "sk-provider-secret" }],
  };
  error.agentTrace = [{ type: "run.failed", data: { message: "PRIVATE_TRANSCRIPT_SENTINEL" } }];

  const meetingReport = JSON.stringify(meetingAgentFailureReport(error));
  const terminologyReport = JSON.stringify(terminologyAgentFailureReport(error));
  for (const report of [meetingReport, terminologyReport]) {
    assert.doesNotMatch(report, /PRIVATE_TRANSCRIPT_SENTINEL|sk-provider-secret/u);
    assert.match(report, /evaluation failed/u);
  }
});

test("meeting semantic canary candidate IDs do not disclose gold classifications", async () => {
  const spec = JSON.parse(await readFile(new URL("../data/cloud-native-weekly-01.terminology-eval.json", import.meta.url), "utf8"));
  const canary = spec.meeting_agent.semantic_canary;
  const candidates = canary.evidence.filter((record) => record.kind === "decision" || record.kind === "action");
  assert.ok(candidates.length > 0);
  assert.ok(candidates.every((record) => /^c\d{2}$/u.test(record.id)));
  assert.deepEqual(candidates.map((record) => record.id).sort(), Object.keys(canary.expected_dispositions).sort());
});
