import test from "node:test";
import assert from "node:assert/strict";
import { publicMeeting, summarizeTranscript } from "../src/api.js";

const config = {
  chatBaseUrl: "https://gpt.example/v1",
  chatApiKey: "gpt-test-key",
  chatModel: "gpt-5.6-luna",
  chatProtocol: "responses",
  chatPath: "responses",
};

test("meeting analysis Agent rejects invented actions and builds speaker facts from verified quotes", async () => {
  const meeting = sourceMeeting([{ start_seconds: 0, end_seconds: 5, speaker: "A", text: "今天天气很好。" }]);
  let ledger;
  const responses = [
    messageResponse("extract", {
      title: "天气闲聊",
      summary: "竞争对手的数据中心发生火灾。",
      keywords: ["天气"],
      summary_evidence: [{ start_seconds: 0, quote: "今天天气很好" }],
      speaker_summaries: [{
        speaker: "A",
        summary: "CEO 批准一千万元并要求立即付款。",
        key_points: ["批准预算"],
        evidence: [{ start_seconds: 0, quote: "今天天气很好" }],
      }],
      action_items: [{
        task: "立即付款一千万元",
        owner: "CEO",
        due: "今天",
        start_seconds: 0,
        evidence: "今天天气很好",
      }],
    }),
    (body) => {
      ledger = meetingLedger(body);
      assert.deepEqual(ledger.map((record) => record.kind), ["summary", "action", "speaker_point"]);
      assert.equal(ledger.find((record) => record.kind === "action")?.evidence, "今天天气很好。");
      return reviewResponse("invalid", {
        reviews: [{ evidence_id: "action-does-not-exist", disposition: "confirmed" }],
      });
    },
    (body) => {
      const rejected = body.input.find((item) => item?.type === "function_call_output" && item.call_id === "call_invalid");
      assert.ok(rejected);
      const violations = JSON.parse(rejected.output).violations;
      assert.ok(violations.some((violation) => violation.code === "unknown_meeting_evidence"));
      assert.ok(violations.some((violation) => violation.code === "meeting_commitment_review_incomplete"));
      return reviewResponse("reviewed", {
        reviews: [{ evidence_id: recordId(ledger, "action"), disposition: "other" }],
      });
    },
    () => {
      return toolResponse("valid", {
        summary_evidence_ids: [recordId(ledger, "summary")],
        highlight_ids: [],
        speaker_summaries: [{ speaker: "A", evidence_ids: [recordId(ledger, "speaker_point")] }],
        decision_ids: [],
        action_item_ids: [],
      });
    },
  ];

  const result = await withResponses(responses, () => summarizeTranscript({ config, meeting }));
  assert.deepEqual(result.action_items, []);
  assert.equal(result.title, "天气会议纪要");
  assert.equal(result.summary, "[00:00] A：今天天气很好。");
  assert.deepEqual(result.speaker_summaries, [{
    speaker: "A",
    summary: "今天天气很好。",
    key_points: ["今天天气很好。"],
    evidence: [{ start_seconds: 0, speaker: "A", quote: "今天天气很好。" }],
  }]);
  assert.doesNotMatch(JSON.stringify(result), /CEO|一千万元|立即付款|竞争对手|数据中心|火灾/);
  assert.deepEqual(result.analysisRun.usage, {
    modelTurns: 4,
    toolCalls: 3,
    candidateExtractionTurns: 1,
  });
  assert.equal(result.analysisRun.trace.filter((event) => event.type === "meeting.commitments_rejected").length, 1);
  assert.equal(result.analysisRun.trace.filter((event) => event.type === "meeting.commitments_reviewed").length, 1);
  assert.equal(result.analysisRun.trace.filter((event) => event.type === "meeting.analysis_finalized").length, 1);

  const published = publicMeeting({ ...meeting, ...result });
  assert.deepEqual(published.action_items, []);
  assert.deepEqual(published.speaker_summaries, result.speaker_summaries);
});

test("meeting analysis Agent publishes only action fields present in verified evidence", async () => {
  const meeting = sourceMeeting([{
    start_seconds: 4,
    end_seconds: 9,
    speaker: "B",
    text: "由小明明天完成交付。",
  }]);
  let ledger;
  const responses = [
    messageResponse("extract-action", {
      title: "交付",
      summary: "明确了交付行动。",
      keywords: ["交付"],
      summary_evidence: [{ start_seconds: 4, quote: "由小明明天完成交付" }],
      action_items: [{
        task: "完成交付",
        owner: "小明",
        due: "明天",
        start_seconds: 4,
        evidence: "由小明明天完成交付",
      }],
    }),
    (body) => {
      ledger = meetingLedger(body);
      assert.deepEqual(ledger.map((record) => record.kind), ["summary", "action"]);
      assert.equal(ledger.find((record) => record.kind === "action")?.due, "明天");
      assert.equal(ledger.find((record) => record.kind === "action")?.evidence, "由小明明天完成交付。");
      return reviewResponse("action-review", {
        reviews: [{ evidence_id: recordId(ledger, "action"), disposition: "confirmed" }],
      });
    },
    () => {
      return toolResponse("action", {
        summary_evidence_ids: [recordId(ledger, "summary")],
        highlight_ids: [],
        speaker_summaries: [],
        decision_ids: [],
        action_item_ids: [recordId(ledger, "action")],
      });
    },
  ];

  const result = await withResponses(responses, () => summarizeTranscript({ config, meeting }));
  assert.deepEqual(result.action_items, [{
    task: "由小明明天完成交付。",
    owner: "小明",
    due: "明天",
    start_seconds: 4,
    speaker: "B",
    evidence: "由小明明天完成交付。",
  }]);
  assert.deepEqual(publicMeeting({ ...meeting, ...result }).action_items, result.action_items);
});

test("public Agent proofs keep natural commitments idempotent without exposing their text", async () => {
  const meeting = sourceMeeting([
    { start_seconds: 0, end_seconds: 5, speaker: "A", text: "The selected database is PostgreSQL." },
    { start_seconds: 5, end_seconds: 10, speaker: "B", text: "Alex owns the release approval." },
    { start_seconds: 10, end_seconds: 15, speaker: "C", text: "We might ship Friday." },
  ]);
  let ledger;
  const responses = [
    messageResponse("extract-natural-commitments", {
      title: "Architecture decision",
      summary: "The meeting selected a database and assigned release approval.",
      keywords: ["PostgreSQL"],
      summary_evidence: [{ start_seconds: 0, quote: "The selected database is PostgreSQL" }],
      decision_records: [{
        decision: "Use PostgreSQL",
        start_seconds: 0,
        evidence: "The selected database is PostgreSQL",
      }],
      action_items: [{
        task: "Own release approval",
        owner: "Alex",
        due: "",
        start_seconds: 5,
        evidence: "Alex owns the release approval",
      }],
    }),
    (body) => {
      ledger = meetingLedger(body);
      return reviewResponse("natural-commitments-review", {
        reviews: ledger
          .filter((record) => record.kind === "decision" || record.kind === "action")
          .map((record) => ({ evidence_id: record.id, disposition: "confirmed" })),
      });
    },
    () => toolResponse("natural-commitments-final", {
      summary_evidence_ids: [recordId(ledger, "summary")],
      highlight_ids: [],
      speaker_summaries: [],
    }),
  ];

  const result = await withResponses(responses, () => summarizeTranscript({ config, meeting }));
  const published = publicMeeting({ ...meeting, ...result });
  assert.equal(published.decision_records.length, 1);
  assert.equal(published.action_items.length, 1);
  assert.deepEqual(publicMeeting(published), published);
  assert.doesNotMatch(JSON.stringify(published.analysis_proof), /PostgreSQL|Alex|release approval/u);
  const injected = publicMeeting({
    ...published,
    decision_records: [...published.decision_records, {
      decision: "Ship Friday",
      start_seconds: 10,
      evidence: "We might ship Friday.",
    }],
    action_items: [...published.action_items, {
      task: "Ship Friday",
      owner: "",
      due: "Friday",
      start_seconds: 10,
      evidence: "We might ship Friday.",
    }],
  });
  assert.equal(injected.decision_records.length, 1);
  assert.equal(injected.action_items.length, 1);
});

test("an unresolved question cannot become a published decision", async () => {
  const meeting = sourceMeeting([{
    start_seconds: 0,
    end_seconds: 5,
    speaker: "A",
    text: "我们还需要讨论是否上线？",
  }]);
  let ledger;
  const responses = [
    messageResponse("extract-unresolved-decision", {
      title: "上线讨论",
      summary: "团队仍需讨论是否上线。",
      keywords: ["上线"],
      summary_evidence: [{ start_seconds: 0, quote: "我们还需要讨论是否上线？" }],
      decisions: ["决定上线"],
      decision_records: [{
        decision: "决定上线",
        start_seconds: 0,
        evidence: "我们还需要讨论是否上线？",
      }],
    }),
    (body) => {
      ledger = meetingLedger(body);
      assert.deepEqual(ledger.map((record) => record.kind), ["summary", "decision"]);
      assert.equal(ledger.find((record) => record.kind === "decision")?.evidence, "我们还需要讨论是否上线？");
      return reviewResponse("unresolved-decision-review", {
        reviews: [{ evidence_id: recordId(ledger, "decision"), disposition: "question" }],
      });
    },
    () => {
      return toolResponse("unresolved-decision", {
        summary_evidence_ids: [recordId(ledger, "summary")],
        highlight_ids: [],
        speaker_summaries: [],
        decision_ids: [],
        action_item_ids: [],
      });
    },
  ];

  const result = await withResponses(responses, () => summarizeTranscript({ config, meeting }));
  assert.deepEqual(result.decisions, []);
  assert.deepEqual(result.decision_records, []);
  assert.deepEqual(publicMeeting({ ...meeting, ...result }).decision_records, []);
});

test("an empty completed Agent run cannot authorize injected modal, conditional, or hearsay commitments", async () => {
  const meeting = sourceMeeting([
    { start_seconds: 0, end_seconds: 5, speaker: "A", text: "We might ship Friday." },
    { start_seconds: 5, end_seconds: 10, speaker: "B", text: "If tests pass, Alex will deploy Friday." },
    { start_seconds: 10, end_seconds: 15, speaker: "C", text: "Reportedly, the committee approved the budget." },
  ]);
  let ledger;
  const responses = [
    messageResponse("extract-no-commitments", {
      title: "Release discussion",
      summary: "The team discussed possible release outcomes.",
      keywords: ["release"],
      summary_evidence: [{ start_seconds: 0, quote: "We might ship Friday" }],
    }),
    (body) => {
      ledger = meetingLedger(body);
      assert.equal(ledger.some((record) => record.kind === "decision" || record.kind === "action"), false);
      return toolResponse("finalize-no-commitments", {
        summary_evidence_ids: [recordId(ledger, "summary")],
        highlight_ids: [],
        speaker_summaries: [],
      });
    },
  ];

  const result = await withResponses(responses, () => summarizeTranscript({ config, meeting }));
  assert.deepEqual(result.analysisRun.commitmentProofs, []);
  const injected = {
    ...meeting,
    ...result,
    decision_records: meeting.segments.map((segment) => ({
      decision: segment.text,
      start_seconds: segment.start_seconds,
      evidence: segment.text,
    })),
    action_items: meeting.segments.map((segment) => ({
      task: segment.text,
      owner: "",
      due: "",
      start_seconds: segment.start_seconds,
      evidence: segment.text,
    })),
  };

  const published = publicMeeting(injected);
  assert.deepEqual(published.decision_records, []);
  assert.deepEqual(published.action_items, []);
});

test("the meeting Agent excludes questions and absent commitments while preserving explicit outcomes", async () => {
  const meeting = sourceMeeting([
    { start_seconds: 0, end_seconds: 5, speaker: "A", text: "目前没有决定采用新方案。" },
    { start_seconds: 5, end_seconds: 10, speaker: "B", text: "李雷不一定会完成部署。" },
    { start_seconds: 10, end_seconds: 15, speaker: "C", text: "We did not decide to launch Friday." },
    { start_seconds: 15, end_seconds: 20, speaker: "D", text: "这个版本谁负责发布。" },
    { start_seconds: 20, end_seconds: 25, speaker: "E", text: "We have not committed to deploy." },
    { start_seconds: 25, end_seconds: 30, speaker: "A", text: "我们决定不发布。" },
    { start_seconds: 30, end_seconds: 35, speaker: "F", text: "Alex will ship tomorrow." },
  ]);
  let ledger;
  const responses = [
    messageResponse("extract-negated-claims", {
      title: "方案讨论",
      summary: "尚未形成承诺。",
      keywords: ["方案"],
      summary_evidence: [{ start_seconds: 0, quote: "目前没有决定采用新方案" }],
      decision_records: [
        { decision: "采用新方案", start_seconds: 0, evidence: "目前没有决定采用新方案" },
        { decision: "launch Friday", start_seconds: 10, evidence: "We did not decide to launch Friday" },
        { decision: "谁负责发布", start_seconds: 15, evidence: "这个版本谁负责发布" },
        { decision: "不发布", start_seconds: 25, evidence: "我们决定不发布" },
      ],
      action_items: [
        { task: "完成部署", owner: "李雷", due: "", start_seconds: 5, evidence: "李雷不一定会完成部署" },
        { task: "负责发布", owner: "", due: "", start_seconds: 15, evidence: "这个版本谁负责发布" },
        { task: "deploy", owner: "", due: "", start_seconds: 20, evidence: "We have not committed to deploy" },
        { task: "ship", owner: "Alex", due: "tomorrow", start_seconds: 30, evidence: "Alex will ship tomorrow" },
      ],
    }),
    (body) => {
      ledger = meetingLedger(body);
      assert.deepEqual(ledger.map((record) => record.kind), [
        "summary",
        "action", "action", "action", "action",
        "decision", "decision", "decision", "decision",
      ]);
      assert.match(JSON.stringify(ledger), /谁负责发布|not committed|不一定|did not decide/u);
      return reviewResponse("negated-claims-review", {
        reviews: ledger
          .filter((record) => record.kind === "decision" || record.kind === "action")
          .map((record) => ({
            evidence_id: record.id,
            disposition: /决定不发布|Alex will ship tomorrow/u.test(record.evidence)
              ? "confirmed"
              : (/谁负责发布/u.test(record.evidence) ? "question" : (/不一定/u.test(record.evidence) ? "unresolved" : "negated")),
          })),
      });
    },
    () => {
      return toolResponse("negated-claims", {
        summary_evidence_ids: [recordId(ledger, "summary")],
        highlight_ids: [],
        speaker_summaries: [],
        decision_ids: [recordId(ledger, "decision")],
        action_item_ids: [recordId(ledger, "action")],
      });
    },
  ];

  const result = await withResponses(responses, () => summarizeTranscript({ config, meeting }));
  assert.deepEqual(result.decision_records.map((item) => item.evidence), ["我们决定不发布。"]);
  assert.deepEqual(result.action_items.map((item) => item.evidence), ["Alex will ship tomorrow."]);
  const published = publicMeeting({ ...meeting, ...result });
  assert.deepEqual(published.decision_records, result.decision_records);
  assert.deepEqual(published.action_items, result.action_items);
});

test("the Agent revises a bad commitment review and preserves resolved assignments and obligations", async () => {
  const meeting = sourceMeeting([
    { start_seconds: 0, end_seconds: 5, speaker: "A", text: "We discussed who will ship Friday." },
    { start_seconds: 5, end_seconds: 10, speaker: "B", text: "我们已经明确谁负责发布：小明。" },
    { start_seconds: 10, end_seconds: 15, speaker: "C", text: "Alex must approve the release." },
    { start_seconds: 15, end_seconds: 20, speaker: "D", text: "关于发布，最终决定仍未作出。" },
  ]);
  let ledger;
  const responses = [
    messageResponse("extract-agent-semantics", {
      title: "发布讨论",
      summary: "讨论发布责任和审批。",
      keywords: ["发布"],
      summary_evidence: [{ start_seconds: 5, quote: "我们已经明确谁负责发布：小明" }],
      decision_records: [
        { decision: "Friday shipper", start_seconds: 0, evidence: "We discussed who will ship Friday" },
        { decision: "小明负责发布", start_seconds: 5, evidence: "我们已经明确谁负责发布：小明" },
        { decision: "发布决定", start_seconds: 15, evidence: "关于发布，最终决定仍未作出" },
      ],
      action_items: [
        { task: "ship Friday", owner: "", due: "Friday", start_seconds: 0, evidence: "We discussed who will ship Friday" },
        { task: "负责发布", owner: "小明", due: "", start_seconds: 5, evidence: "我们已经明确谁负责发布：小明" },
        { task: "approve release", owner: "Alex", due: "", start_seconds: 10, evidence: "Alex must approve the release" },
      ],
    }),
    (body) => {
      ledger = meetingLedger(body);
      assert.equal(ledger.filter((record) => record.kind === "decision" || record.kind === "action").length, 6);
      assert.ok(ledger.filter((record) => record.kind === "decision" || record.kind === "action")
        .every((record) => record.evidence));
      return reviewResponse("agent-semantics-bad-review", {
        reviews: ledger
          .filter((record) => record.kind === "decision" || record.kind === "action")
          .map((record) => ({ evidence_id: record.id, disposition: "confirmed" })),
      });
    },
    (body) => {
      const rejected = body.input.find((item) => item?.type === "function_call_output" && item.call_id === "call_agent-semantics-bad-review");
      assert.ok(rejected);
      const violations = JSON.parse(rejected.output).violations;
      assert.ok(violations.some((violation) => violation.code === "meeting_commitment_defensive_floor_rejected"));
      return reviewResponse("agent-semantics-corrected-review", {
        reviews: ledger
          .filter((record) => record.kind === "decision" || record.kind === "action")
          .map((record) => ({
            evidence_id: record.id,
            disposition: /discussed who/u.test(record.evidence)
              ? "question"
              : (/仍未作出/u.test(record.evidence) ? "negated" : "confirmed"),
          })),
      });
    },
    () => toolResponse("agent-semantics-final", {
      summary_evidence_ids: [recordId(ledger, "summary")],
      highlight_ids: [],
      speaker_summaries: [],
      decision_ids: [],
      action_item_ids: [],
    }),
  ];

  const result = await withResponses(responses, () => summarizeTranscript({ config, meeting }));
  assert.deepEqual(result.decision_records.map((item) => item.evidence), ["我们已经明确谁负责发布：小明。"]);
  assert.deepEqual(result.action_items.map((item) => item.evidence), [
    "我们已经明确谁负责发布：小明。",
    "Alex must approve the release.",
  ]);
  assert.equal(result.analysisRun.trace.filter((event) => event.type === "meeting.commitments_rejected").length, 1);
  const published = publicMeeting({ ...meeting, ...result });
  assert.deepEqual(published.decision_records, result.decision_records);
  assert.deepEqual(published.action_items, result.action_items);
});

test("the chat-completions fallback rejects denied decisions and merely planned actions", async () => {
  const meeting = sourceMeeting([
    { start_seconds: 0, end_seconds: 5, speaker: "A", text: "目前没有决定采用新方案。" },
    { start_seconds: 5, end_seconds: 10, speaker: "B", text: "李雷计划完成部署，但尚未承诺。" },
    { start_seconds: 10, end_seconds: 15, speaker: "C", text: "We did not decide to launch Friday." },
  ]);
  const fallbackConfig = { ...config, chatProtocol: "chat-completions", chatPath: "chat/completions" };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({
      title: "方案讨论",
      summary: "没有形成决策或行动承诺。",
      keywords: ["方案"],
      summary_evidence: [{ start_seconds: 0, quote: "目前没有决定采用新方案" }],
      decision_records: [
        { decision: "采用新方案", start_seconds: 0, evidence: "目前没有决定采用新方案" },
        { decision: "launch Friday", start_seconds: 10, evidence: "We did not decide to launch Friday" },
      ],
      action_items: [{
        task: "完成部署",
        owner: "李雷",
        due: "",
        start_seconds: 5,
        evidence: "李雷计划完成部署，但尚未承诺",
      }],
    }) } }],
  }), { headers: { "content-type": "application/json" } });
  try {
    const result = await summarizeTranscript({ config: fallbackConfig, meeting });
    assert.deepEqual(result.decision_records, []);
    assert.deepEqual(result.action_items, []);
    assert.deepEqual(publicMeeting({ ...meeting, ...result }).decision_records, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Responses providers without function tools fall back to the bounded verified workflow", async () => {
  const meeting = sourceMeeting([{ start_seconds: 0, end_seconds: 5, speaker: "A", text: "今天讨论交付。" }]);
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    if (requests === 1) {
      return new Response(JSON.stringify(messageResponse("fallback", {
        title: "交付讨论",
        summary: "讨论了交付。",
        keywords: ["交付"],
        summary_evidence: [{ start_seconds: 0, quote: "今天讨论交付。" }],
        decision_records: [{ decision: "决定交付", start_seconds: 0, evidence: "今天讨论交付。" }],
        action_items: [{ task: "交付", owner: "", due: "", start_seconds: 0, evidence: "今天讨论交付。" }],
      })), { headers: { "content-type": "application/json" } });
    }
      return new Response(JSON.stringify({ error: { message: "function tools are unsupported; echoed gpt-test-key PRIVATE_TRANSCRIPT_SENTINEL" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const result = await summarizeTranscript({ config, meeting });
    assert.equal(requests, 2);
    assert.equal(result.title, "交付会议纪要");
    assert.equal(result.summary, "[00:00] A：今天讨论交付。");
    assert.equal(result.analysisRun.status, "unsupported");
    assert.equal(result.analysisRun.profile, "meeting-analysis");
    assert.doesNotMatch(JSON.stringify(result.analysisRun), /gpt-test-key|PRIVATE_TRANSCRIPT_SENTINEL/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a chat-shaped 200 response to a Responses tool request uses the verified fallback", async () => {
  const meeting = sourceMeeting([{ start_seconds: 0, end_seconds: 5, speaker: "A", text: "今天确认交付范围。" }]);
  const responses = [
    messageResponse("extract-chat-envelope", {
      title: "交付范围",
      summary: "确认交付范围。",
      keywords: ["交付"],
      summary_evidence: [{ start_seconds: 0, quote: "今天确认交付范围" }],
    }),
    { choices: [{ message: { content: "This endpoint ignored function tools." } }] },
  ];

  const result = await withResponses(responses, () => summarizeTranscript({ config, meeting }));
  assert.equal(result.analysisRun.status, "unsupported");
  assert.deepEqual(result.decision_records, []);
  assert.deepEqual(result.action_items, []);
  assert.equal(result.analysisRun.usage.toolCalls, 0);
  assert.equal(result.summary, "[00:00] A：今天确认交付范围。");
});

test("an oversized single ASR segment still produces bounded exact summary evidence", async () => {
  const text = `LONG_START ${"超长逐字稿内容".repeat(180)} LONG_END`;
  const meeting = sourceMeeting([{ start_seconds: 0, end_seconds: 120, speaker: "A", text }]);
  let ledger;
  const responses = [
    messageResponse("extract-oversized-segment", { title: "超长记录", summary: "", keywords: [] }),
    (body) => {
      ledger = meetingLedger(body);
      const summary = ledger.find((record) => record.kind === "summary");
      assert.ok(summary);
      assert.ok(summary.quote_previews.length > 0);
      assert.ok(summary.quote_previews.every((entry) => entry.quote.length <= 320));
      return toolResponse("oversized-segment", {
        summary_evidence_ids: [summary.id],
        highlight_ids: [],
        speaker_summaries: [],
        decision_ids: [],
        action_item_ids: [],
      });
    },
  ];

  const result = await withResponses(responses, () => summarizeTranscript({ config, meeting }));
  assert.match(result.summary, /LONG_START/u);
  assert.match(result.summary, /LONG_END/u);
  assert.ok(result.summary.length <= 4_000);
});

test("long Responses meetings retain one grounded ledger record for every transcript batch", async () => {
  const segments = Array.from({ length: 48 }, (_, index) => ({
    start_seconds: index * 5,
    end_seconds: index * 5 + 4,
    speaker: "A",
    text: `${index === 0 ? "LONG_START 开场。" : ""}${"常规内容。".repeat(90)}${index === 47 ? "LONG_END 收尾。" : ""}`,
  }));
  const meeting = sourceMeeting(segments);
  const originalFetch = globalThis.fetch;
  let transcriptRequests = 0;
  let agentTurns = 0;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.tools) {
      agentTurns += 1;
      const ledger = meetingLedger(body);
      const summaries = ledger.filter((record) => record.kind === "summary");
      const batchIds = summaries.filter((record) => record.scope === "transcript_batch").map((record) => record.id);
      const allSummaryIds = summaries.map((record) => record.id);
      assert.equal(body.input.find((item) => item?.role === "user") != null, true);
      assert.equal(JSON.parse(body.input.find((item) => item?.role === "user").content).transcript_batch_count, transcriptRequests);
      assert.equal(batchIds.length, transcriptRequests);
      if (agentTurns === 2) {
        const rejected = body.input.find((item) => item?.type === "function_call_output" && item.call_id === "call_long_incomplete");
        const violations = JSON.parse(rejected.output).violations;
        assert.ok(violations.some((violation) => violation.code === "meeting_summary_coverage_incomplete"));
      }
      return new Response(JSON.stringify(toolResponse(
        agentTurns === 1 ? "long_incomplete" : "long_complete",
        {
          summary_evidence_ids: agentTurns === 1 ? [batchIds[0]] : allSummaryIds,
          highlight_ids: [],
          speaker_summaries: [],
          decision_ids: [],
          action_item_ids: [],
        },
      )), { headers: { "content-type": "application/json" } });
    }
    const input = String(body.input || "");
    if (input.includes("相邻分段摘要")) {
      return new Response(JSON.stringify(messageResponse("merge-long", {
        title: "长会",
        summary: "会议覆盖开场、常规内容与收尾。",
        keywords: ["常规内容"],
      })), { headers: { "content-type": "application/json" } });
    }
    transcriptRequests += 1;
    return new Response(JSON.stringify(messageResponse(`batch-${transcriptRequests}`, {
      title: "长会",
      summary: input.includes("LONG_START") ? "开场并讨论常规内容。" : (input.includes("LONG_END") ? "常规内容讨论后收尾。" : "继续讨论常规内容。"),
      keywords: ["常规内容"],
    })), { headers: { "content-type": "application/json" } });
  };
  try {
    const result = await summarizeTranscript({ config, meeting });
    assert.ok(transcriptRequests > 1);
    assert.equal(agentTurns, 2);
    assert.equal(result.analysisRun.usage.candidateExtractionTurns, transcriptRequests);
    assert.equal(result.analysisRun.usage.modelTurns, transcriptRequests + agentTurns);
    assert.match(result.summary, /LONG_START/);
    assert.match(result.summary, /LONG_END/);
    assert.doesNotMatch(result.summary, /会议覆盖开场、常规内容与收尾/);
    assert.equal(result.analysisRun.trace.filter((event) => event.type === "meeting.analysis_rejected").length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("hundreds of bounded transcript batches preserve both ends of the visible summary", async () => {
  const segments = Array.from({ length: 102 }, (_, index) => ({
    start_seconds: index * 5,
    end_seconds: index * 5 + 4,
    speaker: "A",
    text: `${index === 0 ? "LONG_START " : ""}${"批次内容".repeat(4_000)}${index === 101 ? " LONG_END" : ""}`,
  }));
  const meeting = sourceMeeting(segments);
  const originalFetch = globalThis.fetch;
  let transcriptRequests = 0;
  let agentRequests = 0;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.tools) {
      agentRequests += 1;
      const ledger = meetingLedger(body);
      const summaryIds = ledger.filter((record) => record.kind === "summary").map((record) => record.id);
      return new Response(JSON.stringify(toolResponse("many-batches", {
        summary_evidence_ids: summaryIds,
        highlight_ids: [],
        speaker_summaries: [],
        decision_ids: [],
        action_item_ids: [],
      })), { headers: { "content-type": "application/json" } });
    }
    transcriptRequests += 1;
    return new Response(JSON.stringify(messageResponse(`many-batch-${transcriptRequests}`, {
      title: "长会",
      summary: "",
      keywords: [],
    })), { headers: { "content-type": "application/json" } });
  };
  try {
    const result = await summarizeTranscript({ config, meeting });
    assert.ok(transcriptRequests >= 102);
    assert.ok(agentRequests <= 1);
    assert.ok(result.summary.length <= 4_000);
    assert.match(result.summary, /LONG_START/u);
    assert.match(result.summary, /LONG_END/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a 200 response that ignores function tools falls back without losing grounded output", async () => {
  const meeting = sourceMeeting([{ start_seconds: 0, end_seconds: 5, speaker: "A", text: "今天确认交付范围。" }]);
  const responses = [
    messageResponse("extract-ignore", {
      title: "交付范围",
      summary: "确认交付范围。",
      keywords: ["交付"],
      summary_evidence: [{ start_seconds: 0, quote: "今天确认交付范围" }],
    }),
    messageResponse("ignored-tool-1", { message: "tools ignored" }),
    messageResponse("ignored-tool-2", { message: "tools still ignored" }),
  ];

  const result = await withResponses(responses, () => summarizeTranscript({ config, meeting }));
  assert.equal(result.analysisRun.status, "unsupported");
  assert.equal(result.analysisRun.usage.toolCalls, 0);
  assert.equal(result.summary, "[00:00] A：今天确认交付范围。");
});

test("meeting tool returns bounded feedback for a schema-valid oversized invalid selection", async () => {
  const meeting = sourceMeeting([{ start_seconds: 0, end_seconds: 5, speaker: "A", text: "今天讨论交付。" }]);
  let ledger;
  const oversizedGroups = Array.from({ length: 30 }, (_, groupIndex) => ({
    speaker: `S${groupIndex}`,
    evidence_ids: Array.from({ length: 40 }, (_, itemIndex) => `missing-${groupIndex}-${itemIndex}`),
  }));
  const responses = [
    messageResponse("extract-bounded", {
      title: "交付",
      summary: "讨论交付。",
      keywords: ["交付"],
      summary_evidence: [{ start_seconds: 0, quote: "今天讨论交付" }],
    }),
    (body) => {
      ledger = meetingLedger(body);
      return toolResponse("oversized_invalid", {
        summary_evidence_ids: [recordId(ledger, "summary")],
        highlight_ids: [],
        speaker_summaries: oversizedGroups,
        decision_ids: [],
        action_item_ids: [],
      });
    },
    (body) => {
      const feedback = body.input.find((item) => item?.type === "function_call_output" && item.call_id === "call_oversized_invalid");
      assert.ok(feedback);
      assert.ok(feedback.output.length < 20_000);
      const parsed = JSON.parse(feedback.output);
      assert.equal(parsed.violations.length, 40);
      assert.equal(parsed.omitted_violation_count, 1_160);
      return toolResponse("oversized_valid", {
        summary_evidence_ids: [recordId(ledger, "summary")],
        highlight_ids: [],
        speaker_summaries: [],
        decision_ids: [],
        action_item_ids: [],
      });
    },
  ];

  const result = await withResponses(responses, () => summarizeTranscript({ config, meeting }));
  assert.equal(result.analysisRun.status, "completed");
  assert.equal(result.analysisRun.trace.filter((event) => event.type === "meeting.analysis_rejected").length, 1);
});

test("meeting source mutation after ledger creation is rejected before finalization", async () => {
  const meeting = sourceMeeting([{ start_seconds: 0, end_seconds: 5, speaker: "A", text: "今天讨论交付。" }]);
  const originalText = meeting.segments[0].text;
  let ledger;
  const responses = [
    messageResponse("extract-source", {
      title: "交付",
      summary: "讨论交付。",
      keywords: ["交付"],
      summary_evidence: [{ start_seconds: 0, quote: "今天讨论交付" }],
    }),
    (body) => {
      ledger = meetingLedger(body);
      meeting.segments[0].text = "内容在建账后被修改。";
      return toolResponse("mutated_source", {
        summary_evidence_ids: [recordId(ledger, "summary")],
        highlight_ids: [],
        speaker_summaries: [],
        decision_ids: [],
        action_item_ids: [],
      });
    },
    (body) => {
      const feedback = body.input.find((item) => item?.type === "function_call_output" && item.call_id === "call_mutated_source");
      assert.ok(feedback);
      assert.ok(JSON.parse(feedback.output).violations.some((violation) => violation.code === "meeting_source_changed"));
      meeting.segments[0].text = originalText;
      return toolResponse("restored_source", {
        summary_evidence_ids: [recordId(ledger, "summary")],
        highlight_ids: [],
        speaker_summaries: [],
        decision_ids: [],
        action_item_ids: [],
      });
    },
  ];

  const result = await withResponses(responses, () => summarizeTranscript({ config, meeting }));
  assert.equal(result.summary, "[00:00] A：今天讨论交付。");
});

test("negative or unrelated owner and date mentions do not become action fields", async () => {
  const meeting = sourceMeeting([{ start_seconds: 0, end_seconds: 5, speaker: "A", text: "老王不负责交付，今天休假。" }]);
  let ledger;
  const responses = [
    messageResponse("extract-negative-action", {
      title: "交付",
      summary: "老王不负责交付。",
      keywords: ["交付"],
      summary_evidence: [{ start_seconds: 0, quote: "老王不负责交付" }],
      action_items: [{
        task: "交付",
        owner: "老王",
        due: "今天",
        start_seconds: 0,
        evidence: "老王不负责交付，今天休假",
      }],
    }),
    (body) => {
      ledger = meetingLedger(body);
      assert.deepEqual(ledger.map((record) => record.kind), ["summary", "action"]);
      return reviewResponse("negative-action-review", {
        reviews: [{ evidence_id: recordId(ledger, "action"), disposition: "negated" }],
      });
    },
    () => {
      return toolResponse("negative_action", {
        summary_evidence_ids: [recordId(ledger, "summary")],
        highlight_ids: [],
        speaker_summaries: [],
        decision_ids: [],
        action_item_ids: [],
      });
    },
  ];

  const result = await withResponses(responses, () => summarizeTranscript({ config, meeting }));
  assert.deepEqual(result.action_items, []);
  assert.deepEqual(publicMeeting({ ...meeting, ...result }).action_items, []);
});

test("a deadline from another clause cannot attach to the selected action", async () => {
  const meeting = sourceMeeting([{
    start_seconds: 0,
    end_seconds: 5,
    speaker: "A",
    text: "今天确认需求，老王负责下周上线。",
  }]);
  let ledger;
  const responses = [
    messageResponse("extract-mismatched-due", {
      title: "上线安排",
      summary: "明确上线安排。",
      keywords: ["上线"],
      summary_evidence: [{ start_seconds: 0, quote: "今天确认需求，老王负责下周上线" }],
      action_items: [{
        task: "上线",
        owner: "老王",
        due: "今天",
        start_seconds: 0,
        evidence: "今天确认需求，老王负责下周上线",
      }],
    }),
    (body) => {
      ledger = meetingLedger(body);
      const action = ledger.find((record) => record.kind === "action");
      assert.ok(action);
      assert.equal(action.owner, "老王");
      assert.equal(action.due, "");
      return reviewResponse("mismatched-due-review", {
        reviews: [{ evidence_id: action.id, disposition: "confirmed" }],
      });
    },
    () => {
      return toolResponse("mismatched-due", {
        summary_evidence_ids: [recordId(ledger, "summary")],
        highlight_ids: [],
        speaker_summaries: [],
        decision_ids: [],
        action_item_ids: [],
      });
    },
  ];

  const result = await withResponses(responses, () => summarizeTranscript({ config, meeting }));
  assert.equal(result.action_items[0].owner, "老王");
  assert.equal(result.action_items[0].due, "");
  assert.doesNotMatch(JSON.stringify(result.action_items), /"due":"今天"/u);
});

function sourceMeeting(segments) {
  return {
    id: "meeting-analysis-test",
    title: "会议",
    createdAt: "2026-08-04T00:00:00.000Z",
    duration: Math.max(...segments.map((segment) => segment.end_seconds)),
    rawSegments: segments.map((segment) => ({ ...segment })),
    segments: segments.map((segment) => ({ ...segment })),
    asrReconciliations: [],
    corrections: [],
    terminology: [],
  };
}

function messageResponse(id, value) {
  return {
    id: `response_${id}`,
    status: "completed",
    output: [{
      id: `message_${id}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: JSON.stringify(value) }],
    }],
  };
}

function toolResponse(id, args) {
  const finalization = {
    summary_evidence_ids: args.summary_evidence_ids,
    highlight_ids: args.highlight_ids,
    speaker_summaries: args.speaker_summaries,
  };
  return {
    id: `response_${id}`,
    status: "completed",
    output: [{
      id: `function_${id}`,
      type: "function_call",
      status: "completed",
      call_id: `call_${id}`,
      name: "finalize_meeting_analysis",
      arguments: JSON.stringify(finalization),
    }],
  };
}

function reviewResponse(id, args) {
  return {
    id: `response_${id}`,
    status: "completed",
    output: [{
      id: `function_${id}`,
      type: "function_call",
      status: "completed",
      call_id: `call_${id}`,
      name: "review_meeting_commitments",
      arguments: JSON.stringify(args),
    }],
  };
}

function meetingLedger(body) {
  assert.equal(body.parallel_tool_calls, false);
  assert.deepEqual(body.tools.map((tool) => tool.name), ["review_meeting_commitments", "finalize_meeting_analysis"]);
  const reviewTool = body.tools[0];
  const finalizationTool = body.tools[1];
  assert.equal(reviewTool.strict, true);
  assert.equal(reviewTool.parameters.additionalProperties, false);
  assert.deepEqual(reviewTool.parameters.required, ["reviews"]);
  assert.deepEqual(reviewTool.parameters.properties.reviews.items.properties.disposition.enum, [
    "confirmed", "question", "unresolved", "negated", "other",
  ]);
  assert.equal(finalizationTool.strict, true);
  assert.equal(finalizationTool.parameters.additionalProperties, false);
  assert.deepEqual(finalizationTool.parameters.required, Object.keys(finalizationTool.parameters.properties));
  const properties = finalizationTool.parameters.properties;
  assert.equal(Object.hasOwn(properties, "title"), false);
  assert.equal(Object.hasOwn(properties, "summary"), false);
  assert.equal(Object.hasOwn(properties, "keywords"), false);
  assert.equal(Object.hasOwn(properties, "decision_ids"), false);
  assert.equal(Object.hasOwn(properties, "action_item_ids"), false);
  assert.equal(properties.speaker_summaries.items.additionalProperties, false);
  assert.deepEqual(
    properties.speaker_summaries.items.required,
    Object.keys(properties.speaker_summaries.items.properties),
  );
  const input = body.input.find((item) => item?.role === "user");
  assert.ok(input);
  const parsed = JSON.parse(input.content);
  assert.equal(parsed.transcript_batch_count, parsed.evidence.filter((record) => record.kind === "summary").length);
  assert.equal(parsed.commitment_candidate_count, parsed.evidence.filter((record) => record.kind === "decision" || record.kind === "action").length);
  return parsed.evidence;
}

function recordId(ledger, kind) {
  const record = ledger.find((item) => item.kind === kind);
  assert.ok(record, `missing ${kind} evidence`);
  return record.id;
}

async function withResponses(steps, operation) {
  const originalFetch = globalThis.fetch;
  let requestIndex = 0;
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), "https://gpt.example/v1/responses");
    const step = steps[requestIndex];
    assert.ok(step, `unexpected Responses request ${requestIndex + 1}`);
    requestIndex += 1;
    const body = JSON.parse(options.body);
    const payload = typeof step === "function" ? step(body) : step;
    return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
  };
  try {
    const result = await operation();
    assert.equal(requestIndex, steps.length);
    return result;
  } finally {
    globalThis.fetch = originalFetch;
  }
}
