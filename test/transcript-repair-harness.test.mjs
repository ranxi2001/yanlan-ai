import test from "node:test";
import assert from "node:assert/strict";
import { runAgent } from "../src/agent/harness.js";
import { createTranscriptRepairProfile } from "../src/agent/profiles/transcript-repair.js";

function call(id, name, args) {
  return { id: `r-${id}`, status: "completed", output: [{ type: "function_call", call_id: `c-${id}`, name, arguments: JSON.stringify(args) }] };
}
async function execute(profile, steps) {
  let index = 0;
  const adapter = { create: async (request) => {
    const step = steps[index++];
    assert.ok(step, "Unexpected extra model turn");
    return typeof step === "function" ? step(request) : step;
  } };
  const result = await runAgent({ adapter, profile, input: profile.input, initialState: profile.initialState });
  assert.equal(index, steps.length);
  return result;
}
const source = () => [
  { start_seconds: 0, end_seconds: 8, speaker: "A", text: "市场变化可能导致审美失效。" },
  { start_seconds: 8, end_seconds: 16, speaker: "B", text: "这个项目研究艺术审美，不讨论量化。" },
];
const accept = async () => ({ supported: true, same_occurrence: true, minimal: true, verbatim: true });
const patch = { segment_id: 0, start_offset: 8, before: "审美", after: "策略", audio_review_id: "review-0", reason: "复识别在目标句中为策略失效" };

test("Harness repairs an ordinary ASR error only at its audio-verified occurrence", async () => {
  const segments = source();
  let audioCalls = 0;
  const profile = createTranscriptRepairProfile({ segments, verifyPatch: accept, transcribeAudioRange: async (args) => {
    audioCalls += 1;
    assert.deepEqual(Object.keys(args).sort(), ["end_seconds", "signal", "start_seconds"]);
    return { text: "市场变化可能导致策略失效。这个项目研究艺术审美。" };
  } });
  const result = await execute(profile, [
    call(0, "read_repair_window", { start_segment: 0, max_segments: 40 }),
    call(1, "review_transcript_audio", { segment_id: 0 }),
    call(2, "propose_transcript_patch", patch),
    call(3, "finalize_transcript_repair", { unresolved: [] }),
  ]);
  assert.equal(audioCalls, 1);
  assert.equal(result.result.segments[0].text, "市场变化可能导致策略失效。");
  assert.equal(result.result.segments[1].text, segments[1].text);
  assert.equal(segments[0].text, "市场变化可能导致审美失效。");
  assert.deepEqual(result.result.segments.map(({ text, ...geometry }) => geometry), segments.map(({ text, ...geometry }) => geometry));
  assert.equal(result.result.repairs.length, 1);
  assert.doesNotMatch(JSON.stringify(result.trace), /审美|策略|市场变化/u);
});

test("matching words in audio are insufficient when independent review rejects target occurrence", async () => {
  const segments = source();
  const profile = createTranscriptRepairProfile({ segments, transcribeAudioRange: async () => "市场变化可能导致审美失效。另一个人的回答提到策略。", verifyPatch: async () => ({ supported: true, same_occurrence: false, minimal: true, verbatim: false }) });
  const result = await execute(profile, [
    call(0, "read_repair_window", { start_segment: 0, max_segments: 40 }),
    call(1, "review_transcript_audio", { segment_id: 0 }),
    call(2, "propose_transcript_patch", patch),
    (request) => {
      const output = request.input.find((item) => item.call_id === "c-2" && item.type === "function_call_output");
      assert.equal(JSON.parse(output.output).code, "independent_review_rejected");
      return call(3, "finalize_transcript_repair", { unresolved: [{ segment_id: 0, reason: "声音含糊，另一句话出现策略不能证明目标词" }] });
    },
  ]);
  assert.deepEqual(result.result.segments, segments);
  assert.equal(result.result.status, "partial");
  assert.equal(result.result.repairs.length, 0);
});

test("text-only guesses and audio from another segment cannot authorize patches", async () => {
  const profile = createTranscriptRepairProfile({ segments: source(), transcribeAudioRange: async () => "策略", verifyPatch: accept });
  const result = await execute(profile, [
    call(0, "read_repair_window", { start_segment: 0, max_segments: 40 }),
    call(1, "propose_transcript_patch", patch),
    (request) => {
      const output = request.input.find((item) => item.call_id === "c-1" && item.type === "function_call_output");
      assert.equal(JSON.parse(output.output).code, "target_audio_evidence_required");
      return call(2, "review_transcript_audio", { segment_id: 1 });
    },
    call(3, "propose_transcript_patch", patch),
    (request) => {
      const output = request.input.find((item) => item.call_id === "c-3" && item.type === "function_call_output");
      assert.equal(JSON.parse(output.output).code, "target_audio_evidence_required");
      return call(4, "finalize_transcript_repair", { unresolved: [{ segment_id: 0, reason: "没有目标音频证据" }] });
    },
  ]);
  assert.equal(result.result.repairs.length, 0);
});

test("finalization requires full coverage rather than an empty successful result", async () => {
  const profile = createTranscriptRepairProfile({ segments: source(), transcribeAudioRange: async () => "", verifyPatch: accept });
  const result = await execute(profile, [
    call(0, "finalize_transcript_repair", { unresolved: [] }),
    (request) => {
      const output = request.input.find((item) => item.call_id === "c-0" && item.type === "function_call_output");
      assert.equal(JSON.parse(output.output).code, "transcript_coverage_incomplete");
      return call(1, "read_repair_window", { start_segment: 0, max_segments: 40 });
    },
    call(2, "finalize_transcript_repair", { unresolved: [{ segment_id: 0, reason: "待音频确认" }] }),
  ]);
  assert.equal(result.result.status, "partial");
});

test("a cross-chunk word repair cannot repeat the preceding word", async () => {
  const segments = [
    { start_seconds: 0, end_seconds: 30, speaker: "A", text: "每天四五个小时的工作" },
    { start_seconds: 30, end_seconds: 60, speaker: "A", text: "车辆给它缩小到二十分钟。" },
  ];
  const p = createTranscriptRepairProfile({ segments, transcribeAudioRange: async () => "每天四五个小时的工作量给它缩小到二十分钟。", verifyPatch: accept });
  const proposal = { segment_id: 1, start_offset: 0, before: "车辆", after: "工作量", audio_review_id: "review-0", reason: "同音词纠错" };
  const result = await execute(p, [
    call(0, "read_repair_window", { start_segment: 0, max_segments: 40 }),
    call(1, "review_transcript_audio", { segment_id: 1 }),
    call(2, "propose_transcript_patch", proposal),
    (request) => {
      const output = request.input.find((item) => item.call_id === "c-2" && item.type === "function_call_output");
      assert.equal(JSON.parse(output.output).code, "boundary_duplicate_introduced");
      return call(3, "propose_transcript_patches", { patches: [{ ...proposal, after: "量" }] });
    },
    call(4, "finalize_transcript_repair", { unresolved: [] }),
  ]);
  assert.equal(result.result.segments.map((segment) => segment.text).join(""), "每天四五个小时的工作量给它缩小到二十分钟。");
});

test("reading every segment does not discharge independently discovered ASR suspects", async () => {
  const p = createTranscriptRepairProfile({ segments: source(), suspects: [{ segment_id: 0, before: "审美失效", reason: "业务含义异常" }], transcribeAudioRange: async () => "", verifyPatch: accept });
  const result = await execute(p, [
    call(0, "read_repair_window", { start_segment: 0, max_segments: 40 }),
    call(1, "finalize_transcript_repair", { unresolved: [] }),
    (request) => {
      const output = request.input.find((item) => item.call_id === "c-1" && item.type === "function_call_output");
      assert.equal(JSON.parse(output.output).code, "suspect_disposition_incomplete");
      return call(2, "finalize_transcript_repair", { unresolved: [{ segment_id: 0, reason: "审美失效尚未取得声学支持" }] });
    },
  ]);
  assert.equal(result.result.status, "partial");
  assert.equal(result.result.suspect_inventory.length, 1);
});
