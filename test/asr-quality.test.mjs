import test from "node:test";
import assert from "node:assert/strict";
import { assessTranscriptionQuality, reconcileTranscriptBoundary } from "../src/asr-quality.js";

test("quality assessment rejects an implausibly dense, repetitive 30-second transcript", () => {
  const text = "重复生成的会议片段".repeat(250);
  const assessment = assessTranscriptionQuality({
    text,
    usage: { completion_tokens: 1_500 },
  }, 30);

  assert.equal(assessment.ok, false);
  assert.equal(assessment.reasonCode, "repetitive_generation");
  assert.deepEqual(assessment.reasonCodes, [
    "repetitive_generation",
    "excessive_character_density",
    "excessive_completion_token_density",
  ]);
  assert.ok(assessment.metrics.characterCount >= 2_000);
  assert.ok(assessment.metrics.charactersPerSecond > 60);
  assert.ok(assessment.metrics.repeatedNgramRatio > 0.9);
  assert.ok(assessment.metrics.maxNgramOccurrences > 100);
  assert.equal(assessment.metrics.completionTokensPerSecond, 50);
});

test("quality assessment accepts normal Chinese, mixed technical text, and short utterances", () => {
  const chinese = assessTranscriptionQuality({
    segments: [
      { text: "今天先确认发布范围和负责人。" },
      { text: "下一步完成灰度验证，再决定正式上线时间。" },
    ],
  }, 12);
  const mixed = assessTranscriptionQuality({
    text: "API gateway 已完成 deployment，接下来检查 Redis failover 和告警链路。",
    raw: { usage: { output_tokens: 38 } },
  }, 10);
  const short = assessTranscriptionQuality({ text: "嗯，可以。", usage: { completion_tokens: 5 } }, 0.5);

  for (const assessment of [chinese, mixed, short]) {
    assert.equal(assessment.ok, true);
    assert.equal(assessment.reasonCode, "ok");
    assert.deepEqual(assessment.reasonCodes, []);
  }
});

test("quality assessment can flag impossible completion-token density independently", () => {
  const assessment = assessTranscriptionQuality({
    text: "这是一段长度正常且没有重复生成的会议说明。",
    usage: { completion_tokens: 500 },
  }, 20);

  assert.equal(assessment.ok, false);
  assert.equal(assessment.reasonCode, "excessive_completion_token_density");
  assert.equal(assessment.metrics.completionTokensPerSecond, 25);
});

test("quality assessment follows persisted segments when envelope text disagrees", () => {
  const assessment = assessTranscriptionQuality({
    text: "正常摘要",
    segments: [{ text: "重复生成的异常片段".repeat(250) }],
  }, 30);

  assert.equal(assessment.ok, false);
  assert.equal(assessment.reasonCode, "repetitive_generation");
  assert.ok(assessment.metrics.characterCount > 2_000);
});

test("boundary reconciliation preserves ordinary exact suffix-prefix overlap", () => {
  const result = reconcileTranscriptBoundary("已经完成核心服务部署", "服务部署，然后验证回滚流程");

  assert.deepEqual(result, {
    previousText: "已经完成核心服务部署",
    nextText: "服务部署，然后验证回滚流程",
    changed: false,
    reasonCode: "none",
    removedCharacters: 0,
    removedFrom: null,
  });
});

test("boundary reconciliation removes a duplicated Chinese filler across punctuation", () => {
  const result = reconcileTranscriptBoundary("我觉得可以，嗯。", "嗯，我们继续讨论");

  assert.equal(result.previousText, "我觉得可以，嗯。");
  assert.equal(result.nextText, "我们继续讨论");
  assert.equal(result.reasonCode, "chinese_filler_overlap");
  assert.equal(result.removedFrom, "next");
});

test("boundary reconciliation preserves English prefixes instead of guessing word completion", () => {
  const result = reconcileTranscriptBoundary("the deploy", "deployment pipeline is ready");

  assert.equal(result.previousText, "the deploy");
  assert.equal(result.nextText, "deployment pipeline is ready");
  assert.equal(result.reasonCode, "none");
  assert.equal(result.removedCharacters, 0);
  assert.equal(result.removedFrom, null);
});

test("boundary reconciliation preserves conditional and fact-bearing overlaps", () => {
  const conditional = reconcileTranscriptBoundary("我们说如果条件满足", "如果条件满足就录用候选人");
  const supporting = reconcileTranscriptBoundary("We support", "supporting this is risky");
  const acceptable = reconcileTranscriptBoundary("We accept", "acceptable risk only");

  assert.equal(conditional.changed, false);
  assert.equal(conditional.nextText, "如果条件满足就录用候选人");
  assert.equal(supporting.changed, false);
  assert.equal(supporting.previousText, "We support");
  assert.equal(acceptable.changed, false);
  assert.equal(acceptable.previousText, "We accept");
});

test("boundary reconciliation preserves ordinary short words and unrelated boundaries", () => {
  const shortWord = reconcileTranscriptBoundary("we use the", "the deployment is ready");
  const unrelated = reconcileTranscriptBoundary("上一段已经结束。", "现在开始新的主题。 ");

  assert.equal(shortWord.changed, false);
  assert.equal(shortWord.reasonCode, "none");
  assert.equal(shortWord.previousText, "we use the");
  assert.equal(shortWord.nextText, "the deployment is ready");
  assert.deepEqual(unrelated, {
    previousText: "上一段已经结束。",
    nextText: "现在开始新的主题。 ",
    changed: false,
    reasonCode: "none",
    removedCharacters: 0,
    removedFrom: null,
  });
});

test("boundary reconciliation preserves a two-character Chinese prefix", () => {
  const result = reconcileTranscriptBoundary("这一段负责处理数据", "数据数据库需要扩容");
  assert.equal(result.changed, false);
  assert.equal(result.nextText, "数据数据库需要扩容");
});
