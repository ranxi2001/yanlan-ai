import test from "node:test";
import assert from "node:assert/strict";
import { applyAcousticAnnotations } from "../src/acoustic-annotations.js";
import { contentSourceSignature } from "../src/meeting-content.js";
import { publicMeeting } from "../src/api.js";

const source = () => ({ segments: [{ start_seconds: 0, end_seconds: 30, speaker: "发言人 1", text: "问题？回答。" }], summary: "旧摘要", summary_content: {}, corrections: [{ old: true }] });
const annotation = (meeting) => ({ schema: 1, source_signature: contentSourceSignature(meeting.segments), audio_duration: 30,
  provider: "test-alignment", speaker_turns: [{ start_seconds: 0, end_seconds: 2, speaker: "S0" }, { start_seconds: 2, end_seconds: 5, speaker: "S1" }],
  segments: [{ source_segment_id: 0, words: [
    { start_offset: 0, end_offset: 3, text: "问题？", start_seconds: 0, end_seconds: 2 },
    { start_offset: 3, end_offset: 6, text: "回答。", start_seconds: 2, end_seconds: 5 },
  ] }],
});

test("aligned words split mixed speaker blocks and preserve exact text and source revision", () => {
  const meeting = source();
  const result = applyAcousticAnnotations(meeting, annotation(meeting));
  assert.deepEqual(result.segments.map((item) => item.speaker), ["S0", "S1"]);
  assert.equal(result.segments.map((item) => item.text).join(""), meeting.segments[0].text);
  assert.equal(result.segments[1].start_seconds, 2);
  assert.equal(result.segments[1].timing_source, "alignment");
  assert.equal(publicMeeting(result).segments[1].timing_source, "alignment");
  assert.equal(result.summary, undefined);
  assert.equal(result.summary_content, undefined);
  assert.deepEqual(result.acousticAnnotations.previous_revision.corrections, meeting.corrections);
  assert.equal(meeting.summary, "旧摘要");
});

test("unalignable text remains intact and overlap does not become a confident single speaker", () => {
  const meeting = source();
  const value = annotation(meeting);
  value.speaker_turns.push({ start_seconds: 2, end_seconds: 5, speaker: "S2" });
  const result = applyAcousticAnnotations(meeting, value);
  assert.equal(result.segments[1].speaker, "重叠发言");
  assert.equal(result.segments[1].speaker_source, "unknown");
  value.segments[0].words = [];
  const unaligned = applyAcousticAnnotations(meeting, value);
  assert.equal(unaligned.segments[0].text, meeting.segments[0].text);
  assert.equal(unaligned.acousticAnnotations.aligned_segments, 0);
});

test("source mismatch, incomplete text and invented timing cannot commit acoustic annotations", () => {
  const meeting = source();
  for (const mutate of [
    (value) => { value.source_signature = "other"; },
    (value) => { value.segments[0].words[1].text = "已经录用"; },
    (value) => { value.segments[0].words[1].end_seconds = 35; },
    (value) => { value.segments[0].words.pop(); },
    (value) => { value.segments[0].source_segment_id = 10; },
  ]) {
    const value = annotation(meeting); mutate(value);
    assert.throws(() => applyAcousticAnnotations(meeting, value));
    assert.equal(meeting.summary, "旧摘要");
  }
});
