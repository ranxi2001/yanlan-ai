import test from "node:test";
import assert from "node:assert/strict";
import { createTranscriptEvidenceTools, corroboratingViews } from "../src/agent/profiles/transcript-evidence-tools.js";
import { createTranscriptRepairProfile } from "../src/agent/profiles/transcript-repair.js";
import { createToolRegistry } from "../src/agent/tool-registry.js";

const source = [
  { id: 0, start_seconds: 0, end_seconds: 30, text: "Agent处理一天的工作" },
  { id: 1, start_seconds: 30, end_seconds: 60, text: "车辆。这是Agent相关的工具。" },
];
test("term search returns exact occurrences and boundary tool exposes unaltered joins", async () => {
  const tools = createTranscriptEvidenceTools({ source });
  const searched = await tools[0].execute({ terms: ["agent", "AIGC"] });
  assert.equal(searched.output.results[0].count, 2);
  assert.equal(searched.output.results[1].count, 0);
  assert.equal(searched.output.results[0].occurrences[1].start_offset, 5);
  const boundary = await tools[1].execute({ segment_id: 1 });
  assert.match(boundary.output.left_join, /工作车辆/u);
});

test("the same audio range cannot corroborate itself under another review id", () => {
  const reviews = [
    { id: "a", segment_id: 1, start_seconds: 29, end_seconds: 60, status: "completed", text: "工作量", variant: "primary" },
    { id: "b", segment_id: 1, start_seconds: 29, end_seconds: 60, status: "completed", text: "工作量", variant: "expanded" },
  ];
  assert.deepEqual(corroboratingViews(source[1], "量", reviews, [], "a"), []);
  reviews[1].start_seconds = 15;
  assert.equal(corroboratingViews(source[1], "量", reviews, [], "a")[0].id, "b");
  assert.equal(corroboratingViews(source[1], "量", reviews, [], "b")[0].id, "a");
});

test("a familiar new brand cannot be accepted from a single short recognition", async () => {
  const segments = [{ start_seconds: 0, end_seconds: 30, text: "我做了020 code网站。", speaker: "A" }, { start_seconds: 30, end_seconds: 60, text: "后续介绍。", speaker: "A" }];
  const profile = createTranscriptRepairProfile({ segments, requireCorroboration: true,
    alternatives: [{ start_seconds: 0, end_seconds: 30, text: "LeetCode网站" }],
    transcribeAudioRange: async () => "我做了LeetCode网站。", verifyPatch: async () => ({ supported: true, same_occurrence: true, minimal: true, verbatim: true }),
  });
  createToolRegistry(profile.tools); // Every new tool must satisfy the actual strict-schema contract.
  let state = profile.initialState;
  const invoke = async (name, args) => { const result = await profile.tools.find((tool) => tool.name === name).execute(args, { state, trace: { append() {} } }); state = result.state || state; return result.output; };
  await invoke("read_repair_window", { start_segment: 0, max_segments: 40 });
  await invoke("review_transcript_audio", { segment_id: 0 });
  const patch = { segment_id: 0, start_offset: -1, before: "020 code", after: "LeetCode", audio_review_id: "review-0", reason: "识别候选" };
  assert.equal((await invoke("propose_transcript_patch", patch)).code, "new_identifier_requires_context_review");
  const expanded = await invoke("review_audio_context", { segment_id: 0 });
  assert.equal(expanded.end_seconds, 45);
  assert.equal((await invoke("propose_transcript_patch", patch)).ok, true);
  const withdrawn = await invoke("retract_transcript_patch", { segment_id: 0, start_offset: 3, reason: "后续证据冲突" });
  assert.equal(withdrawn.ok, true);
  assert.equal(state.patches.length, 0);
});
