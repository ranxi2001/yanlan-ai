import test from "node:test";
import assert from "node:assert/strict";
import { cleanReadingText, cleanReadingSegments, replayReadingEdits } from "../src/reading-transcript.js";
import { parseTranscriptionResponse, publicMeeting, toMarkdown } from "../src/api.js";
import { speakerCoverage } from "../src/transcript-speakers.js";
import { parseTranscriptMarkdown, evaluateContentStructure } from "../scripts/meeting-content-eval.mjs";

test("reading cleanup preserves negation, uncertainty, figures, acknowledgements and quoted fillers", () => {
  const source = "呃，我们可能不会替换搜广推，嗯，自研与开源模型仍然并行。预计20分钟以内。";
  const result = cleanReadingText(source);
  assert.equal(result.text, "我们可能不会替换搜广推，自研与开源模型仍然并行。预计20分钟以内。");
  assert.equal(replayReadingEdits(source, result.edits), result.text);
  for (const phrase of ["嗯。", "嗯，对。", "“嗯，可能不会交付”是原话。", "他们把“呃”写进样本。", "不，不是替换。", "如果失败，然后回滚。", "他说呃是口头停顿词。"])
    assert.equal(cleanReadingText(phrase).text, phrase);
  assert.equal(replayReadingEdits(source, [{ start: 0, end: source.length, from: source, to: "", reason: "isolated_filler" }]), null);
});

test("reading projection leaves source text and timing immutable, exports distinguish reading and original", () => {
  const segments = Object.freeze([Object.freeze({ start_seconds: 0, end_seconds: 10, speaker: "A", text: "呃，我们还没有决定是否发布。" })]);
  const clean = cleanReadingSegments(segments);
  assert.equal(segments[0].text, "呃，我们还没有决定是否发布。");
  assert.equal(clean[0].text, "我们还没有决定是否发布。");
  assert.equal(clean[0].start_seconds, 0);
  const meeting = { title: "发布讨论", duration: 10, createdAt: "2026-09-08", segments };
  assert.match(toMarkdown(meeting), /## 逐字稿[\s\S]*呃，我们/u);
  assert.match(toMarkdown(meeting, { reading: true }), /## 阅读稿[\s\S]*我们还没有决定/u);
  assert.doesNotMatch(toMarkdown(meeting, { reading: true }), /呃，我们/u);
});

test("missing speaker data does not invent a different person per ASR segment", () => {
  const result = parseTranscriptionResponse({ segments: [{ start: 0, end: 3, text: "问题？" }, { start: 3, end: 5, text: "回答。" }] });
  assert.equal(new Set(result.segments.map((segment) => segment.speaker)).size, 1);
  assert.ok(result.segments.every((segment) => segment.speaker_source === "unknown"));
  assert.equal(speakerCoverage(result.segments).available, false);
  assert.equal(publicMeeting({ segments: result.segments }).speaker_coverage.attributed_fraction, 0);
});

test("request-local speaker labels do not masquerade as recording-wide diarization", () => {
  const body = { segments: [{ start: 0, end: 3, speaker: "A", text: "你好。" }] };
  assert.equal(speakerCoverage(parseTranscriptionResponse(body).segments).available, false);
  const recording = parseTranscriptionResponse({ ...body, speaker_scope: "recording" });
  assert.equal(speakerCoverage(recording.segments).available, true);
  const published = publicMeeting({ segments: recording.segments });
  assert.equal(published.segments[0].speaker_scope, "recording");
  assert.deepEqual(publicMeeting(published).segments, published.segments);
});

test("baseline parser reads both export formats without absorbing summary text into transcript", () => {
  const yanlan = "# 示例\n- 时长：00:44\n\n## AI 摘要\n\n摘要内容\n\n## 逐字稿\n\n### 00:00 · A\n\n第一句。\n\n### 00:30 · B\n\n第二句。\n";
  const parsed = parseTranscriptMarkdown(yanlan);
  assert.equal(parsed.segments.length, 2);
  assert.equal(parsed.segments[1].end_seconds, 44);
  assert.equal(parsed.summary, "摘要内容");
  assert.equal(evaluateContentStructure(parsed).thirty_second_boundary_ratio, 1);
  const feishu = parseTranscriptMarkdown("# 飞书\n\n## 逐字稿\n\n- **[00:00]** 提问。\n- **[00:02]** 回答。\n");
  assert.equal(feishu.segments.length, 2);
  assert.equal(feishu.segments[0].speaker_source, "unknown");
});
