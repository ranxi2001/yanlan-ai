import test from "node:test";
import assert from "node:assert/strict";
import { locateAudioSpan } from "../src/audio-span-locator.js";

test("two unchanged anchors locate a short audio span without using a replacement hypothesis", () => {
  const segment = { start_seconds: 0, end_seconds: 30, text: "然后让我去做一些内审之类，所以说我就参与了研发。" };
  const aligned = [{ start_seconds: 0, end_seconds: 30, words: [
    { text: "然后让我去做一些", start_seconds: 10, end_seconds: 12 },
    { text: "量化策略", start_seconds: 12, end_seconds: 14 },
    { text: "所以说我就参与了研发", start_seconds: 14, end_seconds: 17 },
  ] }];
  const result = locateAudioSpan(segment, "内审之类", -1, aligned);
  assert.equal(result.ok, true);
  assert.equal(result.timing_source, "two_sided_anchor_estimate");
  assert.ok(result.start_seconds <= 12 && result.end_seconds >= 14);
  assert.ok(result.end_seconds - result.start_seconds <= 16);
  assert.equal(segment.text.slice(result.source_start_offset, result.source_end_offset), "内审之类");
});

test("missing or ambiguous anchors fail rather than inventing word timestamps", () => {
  const segment = { start_seconds: 0, end_seconds: 30, text: "内审之类，然后继续。" };
  assert.equal(locateAudioSpan(segment, "内审之类", -1, []).code, "insufficient_alignment_anchors");
  assert.equal(locateAudioSpan({ ...segment, text: "同词同词" }, "同词", -1, []).code, "source_span_not_unique");
  assert.equal(locateAudioSpan(segment, "不存在", 0, []).code, "source_span_mismatch");
});
