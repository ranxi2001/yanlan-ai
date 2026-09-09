import test from "node:test";
import assert from "node:assert/strict";
import { proposeStableBoundaryRepairs, applyReviewedBoundaryRepairs } from "../src/asr-boundary-repair.js";

function source(before = "应", after = "运") {
  const left = "这个模型能够实现完整开发以及能够", right = `完整开发并${before}用的一个系统然后可以部署在这里。`;
  const text = left + `完整开发并${after}用的一个系统然后可以部署在这里。`;
  return { schema: 1, source_signature: "fixture", audio_sha256: "audio",
    segments: [{ source_window_id: 0, start_seconds: 0, end_seconds: 30, speaker: "A", text: left }, { source_window_id: 1, start_seconds: 30, end_seconds: 60, speaker: "B", text: right }],
    boundaries: [{ id: "boundary-1", left_window_id: 0, right_window_id: 1, time: 30, status: "pending" }],
    reviews: [{ boundary_id: "boundary-1", status: "pending", evidence: [
      { boundary_id: "boundary-1", start_seconds: 24, end_seconds: 36, text, source_signature: "fixture", audio_sha256: "audio", status: "completed" },
      { boundary_id: "boundary-1", start_seconds: 20, end_seconds: 40, text: `前面的声音。${text}下一句。`, source_signature: "fixture", audio_sha256: "audio", status: "completed" },
    ] }],
  };
}
test("two anchored audio hypotheses propose a minimal occurrence-local patch", () => {
  const report = source(), draft = proposeStableBoundaryRepairs(report);
  assert.equal(draft.proposals.length, 1);
  assert.equal(draft.proposals[0].before, "应");
  assert.equal(draft.proposals[0].after, "运");
  const result = applyReviewedBoundaryRepairs(report, draft, [{ id: draft.proposals[0].id, verdict: "supported", reason: "目标位置两窗一致" }]);
  assert.match(result.segments[1].text, /开发并运用/u);
  assert.match(report.segments[1].text, /开发并应用/u);
  assert.equal(result.segments[1].speaker, "B");
  assert.equal(result.segments[1].start_seconds, 30);
});

test("different or duplicate-window evidence cannot manufacture consensus", () => {
  const report = source();
  report.reviews[0].evidence[1].text = report.reviews[0].evidence[1].text.replace("运用", "采用");
  assert.equal(proposeStableBoundaryRepairs(report).proposals.length, 0);
  report.reviews[0].evidence[1] = structuredClone(report.reviews[0].evidence[0]);
  assert.equal(proposeStableBoundaryRepairs(report).proposals.length, 0);
});

test("polarity, numbers, identifiers and source mutation are not silently repaired", () => {
  for (const [before, after] of [["不", ""], ["1", "2"], ["Vercel", "Volcano"], ["如果", ""], ["讨论", "录用"]]) assert.equal(proposeStableBoundaryRepairs(source(before, after)).proposals.length, 0);
  const report = source(), draft = proposeStableBoundaryRepairs(report);
  report.segments[1].text += "新内容";
  assert.throws(() => applyReviewedBoundaryRepairs(report, draft, []), /source_changed/u);
});

test("uncertain reviews preserve text and incomplete reviews cannot commit", () => {
  const report = source(), draft = proposeStableBoundaryRepairs(report);
  assert.throws(() => applyReviewedBoundaryRepairs(report, draft, []), /incomplete/u);
  const result = applyReviewedBoundaryRepairs(report, draft, [{ id: draft.proposals[0].id, verdict: "uncertain" }]);
  assert.deepEqual(result.segments, report.segments);
  assert.equal(result.accepted.length, 0);
});
