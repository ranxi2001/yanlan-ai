import test from "node:test";
import assert from "node:assert/strict";
import { reconcileTranscriptSegments, replayTranscriptReconciliations, segmentSourceHash, transcribePcmAdaptively } from "../src/asr-pipeline.js";

test("suspect 30-second ASR output is discarded and recovered from ordered 10-second pieces", async () => {
  const calls = [];
  const result = await transcribePcmAdaptively({
    pcm: new Float32Array(300),
    sampleRate: 10,
    transcribe: async ({ startSeconds, durationSeconds }) => {
      calls.push({ startSeconds, durationSeconds });
      if (durationSeconds > 10) {
        return { text: "重复生成的会议片段".repeat(250), raw: { usage: { completion_tokens: 1_500 } } };
      }
      const text = startSeconds === 0
        ? "已经完成核心服务部署"
        : (startSeconds === 10 ? "服务部署，然后检查 the deploy" : "deployment pipeline is ready");
      return { text, segments: [{ start_seconds: 0, end_seconds: durationSeconds, speaker: "发言人 1", text }] };
    },
  });

  assert.deepEqual(calls.map((item) => item.durationSeconds), [30, 10, 10, 10]);
  assert.deepEqual(result.segments.map((item) => item.start_seconds), [0, 10, 20]);
  assert.deepEqual(result.segments.map((item) => item.text), [
    "已经完成核心服务部署",
    "服务部署，然后检查 the deploy",
    "deployment pipeline is ready",
  ]);
  assert.deepEqual(result.rawSegments.map((item) => item.text), result.segments.map((item) => item.text));
  assert.equal(result.qualityEvents.length, 1);
  assert.deepEqual(result.qualityEvents[0].reason_codes, [
    "repetitive_generation",
    "excessive_character_density",
    "excessive_completion_token_density",
  ]);
  assert.deepEqual(result.reconciliations, []);
});

test("suspect output that survives minimum-size splitting fails without returning text", async () => {
  const calls = [];
  await assert.rejects(() => transcribePcmAdaptively({
    pcm: new Float32Array(300).fill(0.1),
    sampleRate: 10,
    transcribe: async ({ durationSeconds }) => {
      calls.push(durationSeconds);
      const text = "持续重复".repeat(400);
      return { text, raw: { usage: { completion_tokens: 1_000 } }, segments: [{ text }] };
    },
  }), (error) => {
    assert.equal(error.name, "TranscriptionQualityError");
    assert.match(error.message, /已停止写入逐字稿/);
    assert.equal(error.durationSeconds, 5);
    return true;
  });
  assert.deepEqual(calls, [30, 10, 5]);
});

test("boundary reconciliation preserves timestamps, ordinary overlap, and different speakers", () => {
  const original = [
    { start_seconds: 0, end_seconds: 10, speaker: "A", text: "完成服务部署" },
    { start_seconds: 9.5, end_seconds: 20, speaker: "A", text: "服务部署，然后回滚" },
    { start_seconds: 20, end_seconds: 30, speaker: "B", text: "然后回滚是否成功" },
  ];
  const result = reconcileTranscriptSegments(original);

  assert.deepEqual(result.segments.map(({ start_seconds, end_seconds }) => ({ start_seconds, end_seconds })), [
    { start_seconds: 0, end_seconds: 10 },
    { start_seconds: 9.5, end_seconds: 20 },
    { start_seconds: 20, end_seconds: 30 },
  ]);
  assert.deepEqual(result.segments.map((item) => item.text), original.map((item) => item.text));
  assert.equal(result.reconciliations.length, 0);
  assert.deepEqual(original.map((item) => item.text), ["完成服务部署", "服务部署，然后回滚", "然后回滚是否成功"]);
});

test("boundary reconciliation never deletes adjacent text without temporal overlap", () => {
  const result = reconcileTranscriptSegments([
    { start_seconds: 0, end_seconds: 10, speaker: "A", text: "这一段负责处理数据" },
    { start_seconds: 10, end_seconds: 20, speaker: "A", text: "数据库需要扩容" },
  ]);

  assert.deepEqual(result.segments.map((item) => item.text), ["这一段负责处理数据", "数据库需要扩容"]);
  assert.deepEqual(result.reconciliations, []);
});

test("a suspect 10.1-second chunk is split into two processable pieces", async () => {
  const calls = [];
  const result = await transcribePcmAdaptively({
    pcm: new Float32Array(101),
    sampleRate: 10,
    transcribe: async ({ startSeconds, durationSeconds }) => {
      calls.push(durationSeconds);
      if (durationSeconds > 10) return { text: "持续重复".repeat(400), raw: { usage: { completion_tokens: 1_000 } } };
      return {
        text: `片段 ${startSeconds}`,
        segments: [{ start_seconds: 0, end_seconds: durationSeconds, speaker: "A", text: `片段 ${startSeconds}` }],
      };
    },
  });

  assert.deepEqual(calls, [10.1, 5.1, 5]);
  assert.deepEqual(result.segments.map((item) => item.start_seconds), [0, 5.1]);
});

test("an empty ASR response over audible PCM is split and recovered", async () => {
  const calls = [];
  const result = await transcribePcmAdaptively({
    pcm: new Float32Array(200).fill(0.25),
    sampleRate: 10,
    transcribe: async ({ startSeconds, durationSeconds, depth }) => {
      calls.push({ durationSeconds, depth });
      if (depth === 0) return { text: "", segments: [] };
      return { text: "恢复片段", segments: [{ start_seconds: 0, end_seconds: durationSeconds, speaker: "A", text: `恢复片段 ${startSeconds}` }] };
    },
  });

  assert.deepEqual(calls, [{ durationSeconds: 20, depth: 0 }, { durationSeconds: 10, depth: 1 }, { durationSeconds: 10, depth: 1 }]);
  assert.equal(result.segments.length, 2);
  assert.equal(result.qualityEvents[0].action, "split");
  assert.equal(result.qualityEvents[0].reason_codes[0], "empty_transcript");
  assert.ok(result.qualityEvents[0].metrics.pcmRms > 0.2);
});

test("an empty ASR response over silent PCM is accepted with an audit event", async () => {
  const result = await transcribePcmAdaptively({
    pcm: new Float32Array(200),
    sampleRate: 10,
    transcribe: async () => ({ text: "", segments: [] }),
  });

  assert.deepEqual(result.rawSegments, []);
  assert.deepEqual(result.segments, []);
  assert.equal(result.qualityEvents.length, 1);
  assert.equal(result.qualityEvents[0].action, "accepted_silence");
  assert.equal(result.qualityEvents[0].metrics.pcmPeak, 0);
});

test("a string ASR response becomes the segment that quality checks and persists", async () => {
  const result = await transcribePcmAdaptively({
    pcm: new Float32Array(50).fill(0.1),
    sampleRate: 10,
    transcribe: async () => "字符串形式的有效逐字稿",
  });

  assert.deepEqual(result.rawSegments.map((segment) => segment.text), ["字符串形式的有效逐字稿"]);
  assert.deepEqual(result.segments.map((segment) => segment.text), ["字符串形式的有效逐字稿"]);
  assert.equal(result.qualityEvents.length, 0);
});

test("low-level non-zero audio is never accepted as silence", async () => {
  const sampleRate = 100;
  const pcm = Float32Array.from({ length: sampleRate * 10 }, (_, index) => 0.002 * Math.sin((2 * Math.PI * 22 * index) / sampleRate));
  let calls = 0;

  await assert.rejects(() => transcribePcmAdaptively({
    pcm,
    sampleRate,
    transcribe: async () => {
      calls += 1;
      return { text: "", segments: [] };
    },
  }), (error) => {
    assert.equal(error.name, "TranscriptionQualityError");
    assert.equal(error.qualityEvents.some((event) => event.action === "accepted_silence"), false);
    assert.equal(error.qualityEvents[0].action, "split");
    assert.ok(error.qualityEvents[0].metrics.pcmPeak >= 0.0019);
    return true;
  });
  assert.equal(calls, 2);
});

test("application segments are stably ordered by provider time", () => {
  const result = reconcileTranscriptSegments([
    { start_seconds: 10, end_seconds: 12, speaker: "A", text: "后发生" },
    { start_seconds: 0, end_seconds: 2, speaker: "A", text: "先发生" },
    { start_seconds: 10, end_seconds: 11, speaker: "B", text: "同一时间先返回" },
  ]);

  assert.deepEqual(result.segments.map((segment) => segment.text), ["先发生", "后发生", "同一时间先返回"]);
  assert.deepEqual(result.segments.map((segment) => segment.start_seconds), [0, 10, 10]);
  assert.deepEqual(replayTranscriptReconciliations([
    { start_seconds: 10, end_seconds: 12, speaker: "A", text: "后发生" },
    { start_seconds: 0, end_seconds: 2, speaker: "A", text: "先发生" },
    { start_seconds: 10, end_seconds: 11, speaker: "B", text: "同一时间先返回" },
  ], []), result.segments);
});

test("provider segments keep ordinary time-backed overlap in the fact layer", async () => {
  const result = await transcribePcmAdaptively({
    pcm: new Float32Array(100).fill(0.1),
    sampleRate: 10,
    transcribe: async () => ({
      text: "完成服务部署 服务部署，然后验证",
      segments: [
        { start_seconds: 0, end_seconds: 6, speaker: "A", text: "完成服务部署" },
        { start_seconds: 5.5, end_seconds: 10, speaker: "A", text: "服务部署，然后验证" },
      ],
    }),
  });

  assert.deepEqual(result.rawSegments.map((item) => item.text), ["完成服务部署", "服务部署，然后验证"]);
  assert.deepEqual(result.segments.map((item) => item.text), result.rawSegments.map((item) => item.text));
  assert.equal(result.reconciliations.length, 0);
});

test("provider-local timestamps are clamped to the PCM range before reconciliation", async () => {
  const result = await transcribePcmAdaptively({
    pcm: new Float32Array(200).fill(0.1),
    sampleRate: 10,
    transcribe: async ({ startSeconds, durationSeconds, depth }) => depth === 0
      ? { text: "持续重复".repeat(400), raw: { usage: { completion_tokens: 1_000 } } }
      : {
        text: `边界文本 ${startSeconds}`,
        segments: [{ start_seconds: -1, end_seconds: durationSeconds + 0.1, speaker: "A", text: `边界文本 ${startSeconds}` }],
      },
  });

  assert.deepEqual(result.rawSegments.map(({ start_seconds, end_seconds }) => ({ start_seconds, end_seconds })), [
    { start_seconds: 0, end_seconds: 10 },
    { start_seconds: 10, end_seconds: 20 },
  ]);
  assert.deepEqual(result.reconciliations, []);
});

test("inferred timestamps never authorize boundary deletion", () => {
  const result = reconcileTranscriptSegments([
    { start_seconds: 0, end_seconds: 10, timing_source: "inferred", speaker: "A", text: "完成服务部署" },
    { start_seconds: 0, end_seconds: 10, timing_source: "inferred", speaker: "A", text: "服务部署，然后验证" },
  ]);

  assert.deepEqual(result.segments.map((item) => item.text), ["完成服务部署", "服务部署，然后验证"]);
  assert.deepEqual(result.reconciliations, []);
});

test("persisted reconciliation patches replay only when the v1 boundary can be re-derived", () => {
  const raw = [
    { start_seconds: 0, end_seconds: 6, timing_source: "provider", speaker: "A", text: "我觉得可以，嗯。" },
    { start_seconds: 5.5, end_seconds: 10, timing_source: "provider", speaker: "A", text: "嗯，我们继续讨论" },
  ];
  const derived = reconcileTranscriptSegments(raw);
  const entry = derived.reconciliations[0];

  assert.equal(entry.algorithm_version, "boundary-v1");
  assert.equal(entry.segmentId, 1);
  assert.equal(entry.from, "嗯，");
  assert.equal(entry.to, "");
  assert.match(entry.source_hash, /^fnv1a32:[0-9a-f]{8}$/);
  assert.deepEqual(
    replayTranscriptReconciliations(raw, derived.reconciliations).map((item) => item.text),
    derived.segments.map((item) => item.text),
  );
  assert.equal(replayTranscriptReconciliations(raw, [{ ...entry, from: "伪造原文" }]), null);
  assert.equal(replayTranscriptReconciliations([raw[1]], [{
    ...entry,
    segmentId: 0,
    source_hash: segmentSourceHash(raw[1], 0),
  }]), null);
  assert.equal(replayTranscriptReconciliations(raw, [{
    ...entry,
    start_offset: entry.end_offset,
    from: "",
    to: "确认发布",
    removed_characters: 0,
  }]), null);
});

test("boundary reconciliation never removes negation or other critical fact context", () => {
  const raw = [
    { start_seconds: 0, end_seconds: 6, timing_source: "provider", speaker: "A", text: "我认为并不建议" },
    { start_seconds: 5.5, end_seconds: 10, timing_source: "provider", speaker: "A", text: "并不建议录用候选人" },
  ];
  const result = reconcileTranscriptSegments(raw);

  assert.deepEqual(result.segments.map((item) => item.text), raw.map((item) => item.text));
  assert.deepEqual(result.reconciliations, []);
});

test("empty PCM returns the complete pipeline result shape", async () => {
  const result = await transcribePcmAdaptively({
    pcm: new Float32Array(),
    sampleRate: 16_000,
    transcribe: async () => { throw new Error("must not call"); },
  });
  assert.deepEqual(result, { rawSegments: [], segments: [], qualityEvents: [], reconciliations: [] });
});
