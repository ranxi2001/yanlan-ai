import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CONFIG,
  buildShareHtml,
  correctTranscript,
  formatTimestamp,
  joinApiUrl,
  parseTranscriptionResponse,
  publicMeeting,
  summarizeTranscript,
  toMarkdown,
  toVtt,
  transcribeAudio,
} from "../src/api.js";

const config = {
  asrBaseUrl: "https://mimo.example/v1",
  asrApiKey: "asr-secret",
  asrModel: "mimo-v2.5-asr",
  asrProtocol: "mimo-chat",
  asrPath: "chat/completions",
  chatBaseUrl: "https://gpt.example/v1",
  chatApiKey: "gpt-secret",
  chatModel: "gpt-4o-mini",
  chatProtocol: "chat-completions",
  chatPath: "chat/completions",
  contextHint: "项目名 OneFly",
};

const meeting = {
  title: "周会",
  createdAt: "2026-07-30T08:00:00.000Z",
  duration: 8,
  segments: [
    { start_seconds: 0, end_seconds: 3, speaker: "发言人 1", text: "今天讨论万福来。" },
    { start_seconds: 3, end_seconds: 8, speaker: "发言人 2", text: "由小明明天完成。" },
  ],
};

test("joins explicit base URL without changing its version path", () => {
  assert.equal(joinApiUrl("https://api.example/v1/", "/audio/transcriptions"), "https://api.example/v1/audio/transcriptions");
  assert.equal(joinApiUrl("https://api.example", "chat/completions"), "https://api.example/chat/completions");
});

test("new installs default to GPT-5.6 Luna over Responses", () => {
  assert.equal(DEFAULT_CONFIG.chatModel, "gpt-5.6-luna");
  assert.equal(DEFAULT_CONFIG.chatProtocol, "responses");
  assert.equal(DEFAULT_CONFIG.chatPath, "responses");
});

test("normalizes verbose and plain transcription responses", () => {
  assert.deepEqual(parseTranscriptionResponse({ segments: [{ start: 1.5, end: 2.5, speaker: "A", text: "你好" }] }).segments[0], {
    start_seconds: 1.5, end_seconds: 2.5, speaker: "A", text: "你好",
  });
  assert.equal(parseTranscriptionResponse({ text: "只有全文" }).segments[0].text, "只有全文");
});

test("official MiMo ASR uses chat completions data-URL protocol", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "https://mimo.example/v1/chat/completions");
    assert.equal(options.headers.Authorization, "Bearer asr-secret");
    const body = JSON.parse(options.body);
    assert.equal(body.model, "mimo-v2.5-asr");
    assert.equal(body.asr_options.language, "zh");
    assert.match(body.messages[0].content[0].input_audio.data, /^data:audio\/wav;base64,/);
    return new Response(JSON.stringify({ choices: [{ message: { content: "你好 OneFly" } }] }), { headers: { "content-type": "application/json" } });
  };
  try {
    const result = await transcribeAudio({ config, blob: new Blob(["wav"], { type: "audio/wav" }), language: "zh" });
    assert.equal(result.text, "你好 OneFly");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("formats transcript exports with timestamps", () => {
  assert.equal(formatTimestamp(65), "01:05");
  assert.match(toMarkdown(meeting), /### 00:03 · 发言人 2/);
  assert.match(toVtt(meeting), /00:00:03\.000 --> 00:00:08\.000/);
});

test("offline share HTML includes public content but no secrets", () => {
  const html = buildShareHtml({ ...meeting, rawSegments: meeting.segments, qa: [{ role: "user", content: "secret question" }] });
  assert.match(html, /周会/);
  assert.doesNotMatch(html, /secret question|asr-secret|rawSegments/);
});

test("GPT correction preserves timestamps while applying corrected text", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "https://gpt.example/v1/chat/completions");
    assert.equal(options.headers.Authorization, "Bearer gpt-secret");
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ segments: [
      { id: 0, speaker: "Alice", text: "今天讨论 OneFly。" },
      { id: 1, speaker: "小明", text: "由小明明天完成。" },
    ], terminology: ["OneFly"] }) } }] }), { headers: { "content-type": "application/json" } });
  };
  try {
    const result = await correctTranscript({ config, meeting });
    assert.equal(result.segments[0].start_seconds, 0);
    assert.equal(result.segments[0].text, "今天讨论 OneFly。");
    assert.deepEqual(result.terminology, ["OneFly"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GPT summary parses structured JSON", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: "```json\n{\"title\":\"OneFly 周会\",\"summary\":\"确定了交付计划\",\"keywords\":[\"OneFly\"],\"decisions\":[\"明天交付\"],\"action_items\":[{\"task\":\"完成交付\",\"owner\":\"小明\",\"due\":\"明天\"}]}\n```" } }] }), { headers: { "content-type": "application/json" } });
  try {
    const result = await summarizeTranscript({ config, meeting });
    assert.equal(result.title, "OneFly 周会");
    assert.equal(result.action_items[0].owner, "小明");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Responses API uses instructions/input and parses typed output", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "https://gpt.example/v1/responses");
    const body = JSON.parse(options.body);
    assert.equal(body.model, "gpt-5.6-luna");
    assert.match(body.instructions, /会议纪要助手/);
    assert.match(body.input, /今天讨论万福来/);
    assert.equal(body.store, false);
    assert.equal(body.messages, undefined);
    assert.equal(body.temperature, undefined);
    return new Response(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({
      title: "Responses 周会", summary: "已完成协议迁移", keywords: ["Responses"], decisions: [], action_items: [],
    }) }] }] }), { headers: { "content-type": "application/json" } });
  };
  try {
    const result = await summarizeTranscript({ config: { ...config, chatModel: "gpt-5.6-luna", chatProtocol: "responses", chatPath: "responses" }, meeting });
    assert.equal(result.title, "Responses 周会");
    assert.equal(result.summary, "已完成协议迁移");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("interview mode generates evidence-based report and privacy-safe exports", async () => {
  const interview = {
    ...meeting,
    title: "候选人 A · 平台工程师技术一面",
    mode: "interview",
    interviewContext: {
      candidateAlias: "候选人 A",
      role: "平台工程师",
      stage: "技术一面",
      interviewer: "Alice",
      competencies: ["系统设计", "故障排查"],
      jobDescription: "负责机密平台的可靠性建设",
    },
  };
  const originalFetch = globalThis.fetch;
  let prompt = "";
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    prompt = body.messages.map((item) => item.content).join("\n");
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      title: "平台工程师面试",
      summary: "候选人说明了故障恢复方案。",
      keywords: ["可靠性"],
      interview_report: {
        recommendation: "follow_up",
        confidence: "medium",
        overview: "系统设计证据较充分，故障排查仍需追问。",
        competencies: [{ name: "系统设计", rating: "strong", assessment: "给出了分层方案。", evidence: [{ start_seconds: 3, quote: "由小明明天完成" }] }],
        strengths: ["能够分解系统职责"],
        risks: ["缺少复杂故障案例"],
        follow_ups: ["请补充一次线上故障的定位过程。"],
      },
    }) } }] }), { headers: { "content-type": "application/json" } });
  };
  try {
    const result = await summarizeTranscript({ config, meeting: interview });
    assert.equal(result.interviewReport.recommendation, "follow_up");
    assert.equal(result.interviewReport.competencies[0].evidence[0].start_seconds, 3);
    assert.equal(result.interviewReport.competencies[1].rating, "insufficient");
    assert.match(prompt, /不得根据声音、口音/);
    assert.match(prompt, /系统设计、故障排查/);

    const completed = { ...interview, ...result, qa: [{ role: "user", content: "内部问题" }], rawSegments: interview.segments };
    const publicData = publicMeeting(completed);
    assert.equal(publicData.schema, 2);
    assert.equal(publicData.interviewContext.role, "平台工程师");
    assert.equal(publicData.interviewReport.recommendation, "follow_up");
    assert.doesNotMatch(JSON.stringify(publicData), /机密平台|Alice|内部问题|rawSegments/);
    assert.match(toMarkdown(completed), /仅供面试官复核，不用于自动录用决定/);
    assert.match(toMarkdown(completed), /\[00:03\]/);
    assert.match(buildShareHtml(completed), /AI 辅助评估/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
