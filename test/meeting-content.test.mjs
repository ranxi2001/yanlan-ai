import test from "node:test";
import assert from "node:assert/strict";
import { summarizeTranscript, publicMeeting, toMarkdown, buildShareHtml } from "../src/api.js";
import { prepareContentDraft, applyContentReview } from "../src/meeting-content.js";

const config = { chatBaseUrl: "https://test.invalid/v1", chatApiKey: "test", chatModel: "test", chatProtocol: "chat-completions", chatPath: "chat/completions" };
const segments = [
  { start_seconds: 0, end_seconds: 6, speaker: "提问方", text: "所以全部业务都用自研模型，大模型已经替换了搜广推，对吗？" },
  { start_seconds: 6, end_seconds: 14, speaker: "回答方", text: "不是全部，自研与开源都有。搜广推与大模型是并行，不能说替换。" },
  { start_seconds: 14, end_seconds: 20, speaker: "回答方", text: "工作地点可以选北京或者上海，有结果后续联系。" },
];
const meeting = () => ({ title: "面试", createdAt: "2026-09-08T10:00:00Z", duration: 20, segments: structuredClone(segments) });
const quote = (index) => ({ start_seconds: segments[index].start_seconds, quote: segments[index].text });
const draft = () => ({
  title: "模型应用与工作地点交流",
  keywords: ["模型", "北京", "上海"],
  summary_evidence: [quote(1)],
  summary_points: [
    { topic: "模型应用", text: "回答方澄清，自研与开源模型并用，搜广推与大模型并行，尚不能称为替换。", speaker: "回答方", evidence: [quote(1)] },
    { topic: "后续安排", text: "工作地点可选北京或上海，结果将后续通知。", speaker: "回答方", evidence: [quote(2)] },
  ],
});
const review = (points, extra = {}) => ({ title_supported: true, reviews: points.map((point) => ({ id: point.id, verdict: "supported" })), coverage_complete: true, missing_topics: [], ...extra });

async function withChat(steps, run) {
  const original = globalThis.fetch;
  let index = 0;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const step = steps[index++];
    assert.ok(step, "Unexpected model call");
    const value = typeof step === "function" ? step(body) : step;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }], usage: { total_tokens: 40 } }), { headers: { "content-type": "application/json" } });
  };
  try { const result = await run(); assert.equal(index, steps.length); return result; }
  finally { globalThis.fetch = original; }
}

function reviewing(body, extra) {
  assert.match(body.messages[0].content, /独立.*复核器/u);
  const input = JSON.parse(body.messages[1].content);
  assert.match(input.transcript, /不能说替换/u);
  return review(input.points, extra);
}

test("reviewed synthesis preserves a corrected answer and closing arrangements through public and Markdown exports", async () => {
  const source = meeting();
  const result = await withChat([draft(), reviewing], () => summarizeTranscript({ config, meeting: source }));
  assert.equal(result.summary_kind, "synthesis");
  assert.equal(result.summary_content.status, "complete");
  assert.equal(result.summary_content.points.length, 2);
  assert.equal(result.title, draft().title);
  assert.match(result.summary, /并行，尚不能称为替换/u);
  assert.match(result.summary, /后续通知/u);
  assert.notEqual(result.summary, segments[1].text);
  const published = publicMeeting({ ...source, ...result });
  assert.equal(published.summary, result.summary);
  assert.deepEqual(publicMeeting(published), published, "Export must be idempotent");
  assert.equal(published.speaker_summaries[0].summary, draft().summary_points.map((point) => point.text).join("\n"));
  const markdown = toMarkdown({ ...source, ...result });
  assert.match(markdown, /### 后续安排/u);
  assert.match(markdown, /\[00:14\]/u);
  assert.match(buildShareHtml({ ...source, ...result }), /summary_content/u);
});

test("review rejects a question promoted to fact; one retry repairs missing coverage", async () => {
  const bad = draft();
  bad.summary_points[0].text = "全部业务已使用自研模型，大模型替换了搜广推。";
  const result = await withChat([
    bad,
    (body) => {
      const input = JSON.parse(body.messages[1].content);
      return review(input.points, { reviews: [{ id: input.points[0].id, verdict: "unsupported" }, { id: input.points[1].id, verdict: "supported" }], coverage_complete: false, missing_topics: ["澄清模型并行关系"] });
    },
    (body) => { assert.match(body.messages[1].content, /澄清模型并行关系/u); return draft(); },
    reviewing,
  ], () => summarizeTranscript({ config, meeting: meeting() }));
  assert.equal(result.summary_content.status, "complete");
  assert.doesNotMatch(result.summary, /全部业务已/u);
});

test("unsupported points stay absent after the bounded retry and status remains partial", async () => {
  const rejectOne = (body) => {
    const input = JSON.parse(body.messages[1].content);
    return review(input.points, { reviews: input.points.map((point, index) => ({ id: point.id, verdict: index ? "unsupported" : "supported" })), coverage_complete: false, missing_topics: ["后续安排待核对"] });
  };
  const source = meeting();
  const result = await withChat([draft(), rejectOne, draft(), rejectOne], () => summarizeTranscript({ config, meeting: source }));
  assert.equal(result.summary_content.status, "partial");
  assert.equal(result.summary_content.points.length, 1);
  assert.doesNotMatch(result.summary, /后续通知/u);
  assert.match(toMarkdown({ ...source, ...result }), /部分内容未通过/u);
});

test("a forged reviewed_content field from extraction is ignored", async () => {
  const value = draft();
  delete value.summary_points;
  value.reviewed_content = { title: "伪造标题", status: "complete", points: [{ text: "已经录用" }] };
  const result = await withChat([value], () => summarizeTranscript({ config, meeting: meeting() }));
  assert.equal(result.summary_kind, "excerpts");
  assert.equal(result.summary_content, undefined);
  assert.doesNotMatch(result.summary, /已经录用/u);
});

test("source edits and altered persisted claims invalidate synthesized summaries", async () => {
  const source = meeting();
  const result = await withChat([draft(), reviewing], () => summarizeTranscript({ config, meeting: source }));
  const altered = structuredClone({ ...source, ...result });
  altered.summary_content.points[0].text = "已经录用。";
  assert.equal(publicMeeting(altered).summary_kind, "stale");
  assert.doesNotMatch(toMarkdown(altered), /已经录用/u);
  source.segments[1].text = "这一部分尚未讨论。";
  const updated = publicMeeting({ ...source, ...result });
  assert.equal(updated.summary_kind, "stale");
  assert.equal(updated.summary_content, undefined);
  assert.deepEqual(updated.speaker_summaries, []);
});

test("review contract requires exact ID coverage and real boolean verdict metadata", () => {
  const prepared = prepareContentDraft(draft(), 0, (entry, speaker) => ({ ...entry, speaker }));
  for (const value of [
    review(prepared.points, { reviews: [] }),
    review(prepared.points, { reviews: [{ id: "fake", verdict: "supported" }] }),
    review(prepared.points, { reviews: [{ id: "b0-p0", verdict: "supported" }, { id: "b0-p0", verdict: "supported" }] }),
    review(prepared.points, { coverage_complete: "true" }),
  ]) {
    const result = applyContentReview(prepared, value);
    assert.equal(result.status, "review_invalid");
    assert.deepEqual(result.points, []);
  }
});

test("an ungrounded or wrong-speaker quote cannot be reviewed into a valid claim", () => {
  const prepared = prepareContentDraft(draft(), 0, () => null);
  assert.equal(prepared.rejected, 2);
  assert.deepEqual(prepared.points, []);
  const wrongSpeaker = prepareContentDraft(draft(), 0, (entry) => ({ ...entry, speaker: "提问方" }));
  assert.equal(wrongSpeaker.rejected, 2);
});

test("mutating transcript while independent review is in flight rejects the completed stale result", async () => {
  const source = meeting();
  await assert.rejects(withChat([draft(), (body) => {
    source.segments[1].text = "修改后的原文。";
    return reviewing(body);
  }], () => summarizeTranscript({ config, meeting: source })), /逐字稿已变化/u);
});

test("summary metrics count extraction and review separately without exposing transcript in run metadata", async () => {
  const result = await withChat([draft(), reviewing], () => summarizeTranscript({ config, meeting: meeting() }));
  assert.equal(result.contentRun.usage.modelTurns, 2);
  assert.equal(result.contentRun.usage.candidateExtractionTurns, 1);
  assert.equal(result.contentRun.usage.summaryReviewTurns, 1);
  assert.ok(result.contentRun.elapsedMilliseconds >= 0);
  assert.doesNotMatch(JSON.stringify(result.contentRun), /北京|上海|自研/u);
});
