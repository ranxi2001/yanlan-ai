import test from "node:test";
import assert from "node:assert/strict";
import { planAsrWindows, stitchAsrWindows, compareGrowingHypotheses } from "../src/asr-window-planner.js";

test("VAD cuts use pause midpoints but preserve every audio sample range including silence", () => {
  const windows = planAsrWindows({ duration: 95, speech: [{ start: 0, end: 28 }, { start: 30, end: 58 }, { start: 62, end: 94 }] });
  assert.equal(windows[0].core_end, 29);
  assert.equal(windows[1].core_end, 60);
  assert.equal(windows.at(-1).core_end, 95);
  windows.slice(1).forEach((window, index) => assert.equal(window.core_start, windows[index].core_end));
  assert.equal(windows.reduce((sum, window) => sum + window.core_end - window.core_start, 0), 95);
});

test("continuous speech has a bounded fallback and context never leaves the recording", () => {
  const windows = planAsrWindows({ duration: 110, speech: [{ start: 0, end: 110 }], contextSeconds: 1 });
  assert.equal(windows[0].boundary_reason, "maximum_duration");
  assert.ok(windows.every((window) => window.core_end - window.core_start <= 40));
  assert.equal(windows[0].audio_start, 0);
  assert.equal(windows.at(-1).audio_end, 110);
  assert.throws(() => planAsrWindows({ duration: 10, speech: [{ start: 9, end: 11 }] }));
});

test("overlap projection retains raw hypotheses and marks unmatched seams", () => {
  const records = [
    { window: { core_start: 0, core_end: 30, audio_start: 0, audio_end: 31 }, text: "前面内容。我们讨论模型运行调度。" },
    { window: { core_start: 30, core_end: 60, audio_start: 29, audio_end: 61 }, text: "我们讨论模型运行调度。后面内容。" },
    { window: { core_start: 60, core_end: 90, audio_start: 59, audio_end: 90 }, text: "其他不能直接对齐的内容。" },
  ];
  const result = stitchAsrWindows(records);
  assert.equal(result.segments[1].text, "后面内容。");
  assert.equal(result.boundaries[1].status, "unresolved_overlap");
  assert.match(records[1].text, /^我们讨论/u);
});

test("future audio leaves a changed tail pending instead of committing its first guess", () => {
  const base = { audio_sha256: "fixture", audio_start: 0, audio_end: 30, text: "每天四五小时的工作车辆" };
  const next = { ...base, audio_end: 32, text: "每天四五小时的工作量缩小了。" };
  const result = compareGrowingHypotheses(base, next);
  assert.equal(result.stable_prefix, "每天四五小时的工作");
  assert.equal(result.pending_tail, "量缩小了。");
  assert.equal(result.pending_previous_tail, "车辆");
  assert.throws(() => compareGrowingHypotheses(base, { ...next, audio_start: 2 }));
  assert.throws(() => compareGrowingHypotheses(base, { ...next, audio_sha256: "other" }));
});
