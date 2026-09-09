import test from "node:test";
import assert from "node:assert/strict";
import { confirmAsrBoundaries, verifyBoundaryPublication, planBoundaryAudioReviews, confirmBoundaryWithBridge } from "../src/asr-boundary-confirmation.js";

function record(id, start, end, text, context = false) {
  return { status: "completed", window: { id, core_start: start, core_end: end, audio_start: context ? Math.max(0, start - 1) : start, audio_end: context ? Math.min(60, end + 1) : end }, text };
}
test("short overlaps and pause variations cannot duplicate or delete published core speech", () => {
  const input = { audioHash: "fixture", core: [record(0, 0, 30, "欢迎参加面试。好的，呃。"), record(1, 30, 60, "我是计算机技术的研究生。")],
    contextual: [record(0, 0, 30, "欢迎参加面试。好的，嗯，我是。", true), record(1, 30, 60, "呃，我是计算机技术的研究生。", true)] };
  const result = confirmAsrBoundaries(input);
  assert.equal(result.boundaries[0].status, "confirmed");
  assert.equal(result.segments.map((segment) => segment.text).join(""), input.core.map((item) => item.text).join(""));
  assert.equal(verifyBoundaryPublication(result, input), true);
});

test("negation and numbers that disagree across the boundary remain pending", () => {
  for (const [right, future] of [["不会发布这个版本。", "会发布"], ["20万元预算待定。", "30万元"]]) {
    const input = { audioHash: "fixture", core: [record(0, 0, 30, "我们讨论下阶段安排。"), record(1, 30, 60, right)],
      contextual: [record(0, 0, 30, "我们讨论下阶段安排。" + future, true), record(1, 30, 60, right, true)] };
    const result = confirmAsrBoundaries(input);
    assert.equal(result.boundaries[0].status, "pending");
    assert.equal(result.segments[1].text, right);
  }
});

test("genuine repeated phrases and questions are preserved, regardless of overlap matching", () => {
  const input = { audioHash: "fixture", core: [record(0, 0, 30, "这个版本需要再测试。"), record(1, 30, 60, "需要再测试？你确定吗？")],
    contextual: [record(0, 0, 30, "这个版本需要再测试。需要再测试？", true), record(1, 30, 60, "需要再测试。需要再测试？你确定吗？", true)] };
  const result = confirmAsrBoundaries(input);
  assert.equal(result.segments.map((segment) => segment.text).join(""), "这个版本需要再测试。需要再测试？你确定吗？");
  const changed = structuredClone(result); changed.segments[1].text = "你确定吗？";
  assert.equal(verifyBoundaryPublication(changed, input), false);
});

test("source timeline changes and invalid ranges cannot be confirmed", () => {
  const input = { audioHash: "fixture", core: [record(0, 0, 30, "完整的一句话。")], contextual: [record(0, 1, 30, "完整的一句话。", true)] };
  assert.throws(() => confirmAsrBoundaries(input));
  const plan = planBoundaryAudioReviews({ segments: [{ end_seconds: 100 }], boundaries: [{ id: "b0", time: 2, status: "pending", reason: "cross_boundary_content_disagreement" }] });
  assert.deepEqual(plan.selected[0], { boundary_id: "b0", time: 2, start_seconds: 0, end_seconds: 8, reason: "cross_boundary_content_disagreement" });
});

test("a bridge can confirm a core seam but cannot silently insert a negation or use another source", () => {
  const core = [record(0, 0, 30, "我们讨论下阶段安排"), record(1, 30, 60, "继续执行已有部署方案")];
  const input = { core, contextual: [record(0, 0, 30, "暂不一致的左侧文本", true), record(1, 30, 60, "暂不一致的右侧文本", true)], audioHash: "audio" };
  const artifact = confirmAsrBoundaries(input);
  const bridge = { boundary_id: "boundary-1", audio_sha256: "audio", source_signature: artifact.source_signature, start_seconds: 24, end_seconds: 36, text: "我们讨论下阶段安排，继续执行已有部署方案。", status: "completed" };
  assert.equal(confirmBoundaryWithBridge({ artifact, core, bridge }).status, "confirmed");
  assert.equal(confirmBoundaryWithBridge({ artifact, core, bridge: { ...bridge, text: "我们讨论下阶段安排，不继续执行已有部署方案。" } }).reason, "possible_boundary_omission");
  assert.throws(() => confirmBoundaryWithBridge({ artifact, core, bridge: { ...bridge, audio_sha256: "other" } }));
  assert.equal(artifact.segments.map((segment) => segment.text).join(""), core.map((record) => record.text).join(""));
});
