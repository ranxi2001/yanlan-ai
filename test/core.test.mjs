import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CONFIG,
  askTranscript,
  buildShareHtml,
  connectionTestErrorMessage,
  correctTranscript,
  formatTimestamp,
  joinApiUrl,
  normalizeMimoBaseUrl,
  mapWithConcurrency,
  parseTranscriptionResponse,
  publicMeeting,
  readableTranscriptSegments,
  requestUrlForConfig,
  summarizeTranscript,
  testAsrConnection,
  testChatConnection,
  toMarkdown,
  toVtt,
  transcribeAudio,
  transcribeAudioWithRetry,
} from "../src/api.js";
import { reconcileTranscriptSegments, segmentSourceHash, transcribePcmAdaptively } from "../src/asr-pipeline.js";

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

test("normalizes MiMo base URLs without exposing the ASR endpoint path", () => {
  assert.equal(normalizeMimoBaseUrl(""), "https://api.xiaomimimo.com");
  assert.equal(normalizeMimoBaseUrl("https://api.xiaomimimo.com"), "https://api.xiaomimimo.com");
  assert.equal(normalizeMimoBaseUrl("https://api.xiaomimimo.com/v1/"), "https://api.xiaomimimo.com");
  assert.equal(normalizeMimoBaseUrl("https://api.xiaomimimo.com/v1/chat/completions"), "https://api.xiaomimimo.com");
  assert.equal(normalizeMimoBaseUrl("https://gateway.example/openai/v1"), "https://gateway.example/openai");
});

test("new installs default to GPT-5.6 Luna over Responses", () => {
  assert.equal(DEFAULT_CONFIG.asrBaseUrl, "https://api.xiaomimimo.com");
  assert.equal(DEFAULT_CONFIG.asrProtocol, "mimo-chat");
  assert.equal(DEFAULT_CONFIG.asrPath, "v1/chat/completions");
  assert.equal(joinApiUrl(DEFAULT_CONFIG.asrBaseUrl, DEFAULT_CONFIG.asrPath), "https://api.xiaomimimo.com/v1/chat/completions");
  assert.equal(DEFAULT_CONFIG.chatModel, "gpt-5.6-luna");
  assert.equal(DEFAULT_CONFIG.chatProtocol, "responses");
  assert.equal(DEFAULT_CONFIG.chatPath, "responses");
  assert.equal(DEFAULT_CONFIG.transportMode, "direct");
});

test("local relay keeps arbitrary provider URLs in the same-origin request", () => {
  assert.equal(requestUrlForConfig("https://provider.example/v1/responses", config), "https://provider.example/v1/responses");
  assert.equal(
    requestUrlForConfig("https://provider.example/v1/responses", { ...config, transportMode: "relay", relayPath: "/api/relay" }, "http://127.0.0.1:4173/"),
    "http://127.0.0.1:4173/api/relay?url=https%3A%2F%2Fprovider.example%2Fv1%2Fresponses",
  );
});

test("API requests reject credential-bearing remote HTTP endpoints", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests += 1; throw new Error("must not send credentials"); };
  try {
    await assert.rejects(() => transcribeAudio({
      config: { ...config, asrBaseUrl: "http://api.example/v1" },
      blob: new Blob(["wav"], { type: "audio/wav" }),
    }), /必须使用 HTTPS/);
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("normalizes verbose and plain transcription responses", () => {
  assert.deepEqual(parseTranscriptionResponse({ segments: [{ start: 1.5, end: 2.5, speaker: "A", text: "你好" }] }).segments[0], {
    start_seconds: 1.5, end_seconds: 2.5, timing_source: "provider", speaker: "A", text: "你好",
  });
  assert.deepEqual(parseTranscriptionResponse({ text: "只有全文" }).segments[0], {
    start_seconds: 0, end_seconds: 0, timing_source: "inferred", speaker: "发言人 1", text: "只有全文",
  });
  assert.deepEqual(parseTranscriptionResponse({ segments: [{ begin_time: 1_500, end_time: 2_500, text: "毫秒时间" }] }).segments[0], {
    start_seconds: 1.5, end_seconds: 2.5, timing_source: "provider", speaker: "发言人 1", text: "毫秒时间",
  });
});

test("invalid provider timestamps cannot authorize adaptive boundary deletion", async () => {
  for (const invalidStart of [-1, "not-a-time"]) {
    const parsed = parseTranscriptionResponse({ segments: [
      { start: 0, end: 6, speaker: "A", text: "完成服务部署" },
      { start: invalidStart, end: 10, speaker: "A", text: "服务部署，然后验证" },
    ] });
    assert.equal(parsed.segments[1].timing_source, "inferred");

    const result = await transcribePcmAdaptively({
      pcm: new Float32Array(100).fill(0.1),
      sampleRate: 10,
      transcribe: async () => parsed,
    });
    assert.deepEqual(result.segments.map((segment) => segment.text), ["完成服务部署", "服务部署，然后验证"]);
    assert.deepEqual(result.reconciliations, []);
  }
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

test("MiMo connection test uses the fixed endpoint and accepts an empty recognized transcription", async () => {
  const originalFetch = globalThis.fetch;
  let responseBody = { choices: [{ message: { content: "" } }] };
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "https://mimo.example/v1/chat/completions");
    assert.equal(options.headers.Authorization, "Bearer asr-secret");
    const body = JSON.parse(options.body);
    assert.equal(body.model, "mimo-v2.5-asr");
    assert.equal(body.asr_options.language, "auto");
    const audio = body.messages[0].content[0].input_audio.data;
    assert.match(audio, /^data:audio\/wav;base64,/);
    const wav = Buffer.from(audio.split(",")[1], "base64");
    assert.equal(wav.subarray(0, 4).toString("ascii"), "RIFF");
    assert.equal(wav.readUInt32LE(24), 16_000);
    return new Response(JSON.stringify(responseBody), { headers: { "content-type": "application/json" } });
  };
  try {
    const testConfig = { ...DEFAULT_CONFIG, asrBaseUrl: "https://mimo.example", asrApiKey: "asr-secret" };
    const result = await testAsrConnection({ config: testConfig });
    assert.equal(result.text, "");
    responseBody = { choices: [] };
    await assert.rejects(() => testAsrConnection({ config: testConfig }), (error) => error.code === "invalid-response");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GPT connection test follows the configured Responses or Chat Completions protocol", async () => {
  const originalFetch = globalThis.fetch;
  let protocol = "responses";
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(options.headers.Authorization, "Bearer gpt-secret");
    if (protocol === "responses") {
      assert.equal(url, "https://gpt.example/v1/responses");
      assert.deepEqual(body, {
        model: "gpt-test",
        instructions: "这是一次 API 配置连通性测试。",
        input: "只回复 OK。",
        store: false,
      });
      return new Response(JSON.stringify({ output_text: "OK" }));
    }
    assert.equal(url, "https://gpt.example/v1/chat/completions");
    assert.deepEqual(body, {
      model: "gpt-test",
      messages: [
        { role: "system", content: "这是一次 API 配置连通性测试。" },
        { role: "user", content: "只回复 OK。" },
      ],
      temperature: 0.2,
    });
    return new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }));
  };
  try {
    const base = { ...DEFAULT_CONFIG, chatBaseUrl: "https://gpt.example/v1", chatApiKey: "gpt-secret", chatModel: "gpt-test" };
    assert.equal(await testChatConnection({ config: base }), "OK");
    protocol = "chat-completions";
    assert.equal(await testChatConnection({ config: { ...base, chatProtocol: protocol, chatPath: "chat/completions" } }), "OK");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("connection tests keep HTTP and transport details without retrying", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  const testConfig = { ...DEFAULT_CONFIG, chatBaseUrl: "https://gpt.example/v1", chatApiKey: "gpt-secret", chatModel: "gpt-test" };
  try {
    globalThis.fetch = async () => {
      requests += 1;
      return new Response(JSON.stringify({ error: "Upstream API is unreachable" }), { status: 502 });
    };
    await assert.rejects(() => testChatConnection({ config: testConfig }), (error) => {
      assert.equal(error.code, "http");
      assert.equal(error.status, 502);
      assert.equal(error.message, "Upstream API is unreachable（HTTP 502）");
      return true;
    });
    assert.equal(requests, 1);

    globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
    await assert.rejects(() => testChatConnection({ config: testConfig }), (error) => error.code === "network-or-cors");
    await assert.rejects(
      () => testChatConnection({ config: { ...testConfig, transportMode: "relay", relayPath: "/api/relay" } }),
      (error) => error.code === "relay-unavailable",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("connection test errors explain auth, quota, endpoint, format, and transport failures", () => {
  const cases = [
    [401, /Key 无效/],
    [403, /无权访问/],
    [402, /额度不足/],
    [429, /请求受限/],
    [404, /Base URL 或接口路径/],
    [405, /Base URL 或接口路径/],
    [400, /模型名或接口格式/],
    [415, /模型名或接口格式/],
    [422, /模型名或接口格式/],
    [503, /服务暂时不可用/],
  ];
  for (const [status, pattern] of cases) assert.match(connectionTestErrorMessage("MiMo", { status }), pattern);
  assert.match(connectionTestErrorMessage("GPT", { code: "timeout" }), /超时/);
  assert.match(connectionTestErrorMessage("GPT", { code: "network-or-cors" }), /网络连接失败/);
  assert.match(connectionTestErrorMessage("GPT", { code: "relay-unavailable" }), /本地同源网关不可用/);
  assert.match(connectionTestErrorMessage("GPT", { code: "invalid-response" }), /不是兼容 API 响应/);
});

test("ASR retries transient upstream failures and preserves permanent failures", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts < 3) return new Response(JSON.stringify({ error: { message: "temporarily unavailable" } }), { status: 503 });
    return new Response(JSON.stringify({ choices: [{ message: { content: "重试后成功" } }] }), { status: 200 });
  };
  try {
    const result = await transcribeAudioWithRetry({
      config,
      blob: new Blob(["wav"], { type: "audio/wav" }),
      language: "zh",
    }, { attempts: 3, baseDelayMs: 0 });
    assert.equal(result.text, "重试后成功");
    assert.equal(attempts, 3);

    attempts = 0;
    globalThis.fetch = async () => {
      attempts += 1;
      return new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 });
    };
    await assert.rejects(() => transcribeAudioWithRetry({
      config,
      blob: new Blob(["wav"], { type: "audio/wav" }),
    }, { attempts: 3, baseDelayMs: 0 }), /bad key/);
    assert.equal(attempts, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ASR retries when the response body is interrupted", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts === 1) return { ok: true, status: 200, text: async () => { throw new TypeError("socket closed"); } };
    return new Response(JSON.stringify({ choices: [{ message: { content: "正文重试成功" } }] }));
  };
  try {
    const result = await transcribeAudioWithRetry({
      config,
      blob: new Blob(["wav"], { type: "audio/wav" }),
    }, { attempts: 2, baseDelayMs: 0 });
    assert.equal(result.text, "正文重试成功");
    assert.equal(attempts, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("formats transcript exports with timestamps", () => {
  assert.equal(formatTimestamp(65), "01:05");
  assert.match(toMarkdown(meeting), /### 00:03 · 发言人 2/);
  assert.match(toVtt(meeting), /00:00:03\.000 --> 00:00:08\.000/);
});

test("Markdown export never falls back to decisions without verified evidence", () => {
  const markdown = toMarkdown({
    ...meeting,
    decisions: ["未提供证据的旧决策"],
    decision_records: [{ decision: "伪造的结构化决策", start_seconds: 0, evidence: "不存在的原话" }],
  });
  assert.doesNotMatch(markdown, /未提供证据的旧决策/);
  assert.doesNotMatch(markdown, /伪造的结构化决策/);
  assert.match(markdown, /## 关键决策\n\n无/);
});

test("offline share HTML includes meeting insights but no secrets", () => {
  const html = buildShareHtml({
    ...meeting,
    summary: "确定交付计划",
    highlights: [{ start_seconds: 3, speaker: "发言人 2", quote: "由小明明天完成", reason: "明确承诺" }],
    speaker_summaries: [{ speaker: "发言人 2", summary: "确认交付", key_points: ["明天完成"] }],
    decision_records: [{ decision: "明天交付", start_seconds: 3, evidence: "由小明明天完成" }],
    rawSegments: meeting.segments,
    qa: [{ role: "user", content: "secret question" }],
  });
  assert.match(html, /周会/);
  assert.match(html, /会议金句|发言人总结|关键决策/);
  assert.doesNotMatch(html, /secret question|asr-secret|rawSegments/);
});

test("public insights omit incomplete timestamp evidence", () => {
  const data = publicMeeting({
    ...meeting,
    highlights: [{ start_seconds: null, speaker: "发言人 1", quote: "缺少时间", reason: "" }],
    decision_records: [{ decision: "缺少证据", start_seconds: null, evidence: "" }],
  });
  assert.deepEqual(data.highlights, []);
  assert.deepEqual(data.decision_records, []);
});

test("GPT correction requests compact patches and preserves segment metadata", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "https://gpt.example/v1/chat/completions");
    assert.equal(options.headers.Authorization, "Bearer gpt-secret");
    const body = JSON.parse(options.body);
    assert.match(body.messages[0].content, /"patches"/);
    assert.match(body.messages[0].content, /不得返回完整逐字稿/);
    assert.doesNotMatch(body.messages[0].content, /"segments":\[/);
    const input = body.messages[1].content.split("待检查片段：")[1];
    assert.match(input, /"speaker":"发言人 1"/);
    assert.doesNotMatch(input, /start_seconds|end_seconds/);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ patches: [{
      id: 0,
      speaker: "Alice",
      start_seconds: 999,
      replacements: [{ from: "万福来", to: "OneFly" }],
    }] }) } }] }), { headers: { "content-type": "application/json" } });
  };
  try {
    const result = await correctTranscript({ config: { ...config, contextHint: "术语：万福来 -> OneFly" }, meeting });
    assert.deepEqual(result.segments[0], { ...meeting.segments[0], text: "今天讨论OneFly。", join_next: false });
    assert.deepEqual(result.segments[1], { ...meeting.segments[1], join_next: false });
    assert.equal(result.segments[0].text, "今天讨论OneFly。");
    assert.equal(result.segments[0].speaker, "发言人 1");
    assert.deepEqual(result.terminology, ["OneFly"]);
    assert.equal(result.rejectedCorrections, 0);
    assert.deepEqual(
      result.corrections.map(({ segmentId, start_seconds, from, to, status, reason, start_offset, end_offset }) => ({
        segmentId, start_seconds, from, to, status, reason, start_offset, end_offset,
      })),
      [{
        segmentId: 0,
        start_seconds: 0,
        from: "万福来",
        to: "OneFly",
        status: "accepted",
        reason: "explicit_alias",
        start_offset: 4,
        end_offset: 7,
      }],
    );
    assert.match(result.corrections[0].source_hash, /^fnv1a32:[0-9a-f]{8}$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GPT correction converts fixed Chinese chunks into readable semantic paragraphs without merging the canonical timeline", async () => {
  const source = {
    ...meeting,
    duration: 53,
    segments: [
      { start_seconds: 0, end_seconds: 10, speaker: "发言人 1", text: "赵丽蓉是一个非常漂亮、非常美丽的研究生宝宝，她是。", provider_debug: "private" },
      { start_seconds: 10, end_seconds: 20, speaker: "发言人 1", text: "合肥工业大学物流和工程与管理的研究生，他现在。" },
      { start_seconds: 20, end_seconds: 30, speaker: "发言人 1", text: "正在找工作，投递了拼多多和百度的管培生，他一定会找到。" },
      { start_seconds: 30, end_seconds: 40, speaker: "发言人 1", text: "非常好的工作的，孩子一定能考上公务员。我们敬请期待他的。" },
      { start_seconds: 40, end_seconds: 50, speaker: "发言人 1", text: "的收获吧。这个断句不太好，是不是？对。" },
      { start_seconds: 50, end_seconds: 53, speaker: "发言人 1", text: "你发现没有花的。" },
    ],
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    assert.match(body.messages[0].content, /固定时长切片|join_after/);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      patches: [],
      join_after: [0, 1, 2, 3],
    }) } }] }));
  };
  try {
    const result = await correctTranscript({ config, meeting: source });
    assert.equal(result.segments.length, source.segments.length);
    assert.deepEqual(result.segments.map((segment) => [segment.start_seconds, segment.end_seconds]), source.segments.map((segment) => [segment.start_seconds, segment.end_seconds]));
    assert.equal(result.semanticJoins, 4);
    assert.deepEqual(result.segments.map((segment) => segment.join_next), [true, true, true, true, false, false]);

    const readable = readableTranscriptSegments(result.segments);
    assert.equal(readable.length, 2);
    assert.deepEqual([readable[0].start_seconds, readable[0].end_seconds], [0, 50]);
    assert.match(readable[0].text, /她是合肥工业大学/);
    assert.match(readable[0].text, /他现在正在找工作/);
    assert.match(readable[0].text, /他一定会找到非常好的工作/);
    assert.match(readable[0].text, /收获吧。这个断句不太好/);
    assert.equal(readable[1].start_seconds, 50);

    const completed = { ...source, rawSegments: source.segments, segments: result.segments };
    const publicData = publicMeeting(completed);
    assert.equal(publicData.segments.length, 6);
    assert.equal(publicData.segments.filter((segment) => segment.join_next).length, 4);
    assert.doesNotMatch(JSON.stringify(publicData), /provider_debug|private/);
    const markdown = toMarkdown(completed);
    assert.match(markdown, /她是合肥工业大学/);
    assert.doesNotMatch(markdown, /### 00:10/);
    assert.match(markdown, /### 00:50/);
    assert.equal((toVtt(completed).match(/-->/g) || []).length, 6);
    const shareHtml = buildShareHtml(completed);
    assert.match(shareHtml, /她是合肥工业大学/);
    assert.doesNotMatch(shareHtml, /join_next|provider_debug/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("semantic joins reject speaker changes, large gaps, and invalid join ids", async () => {
  const source = {
    ...meeting,
    segments: [
      { start_seconds: 0, end_seconds: 10, speaker: "A", text: "她现在。" },
      { start_seconds: 10, end_seconds: 20, speaker: "B", text: "正在找工作。" },
      { start_seconds: 30, end_seconds: 40, speaker: "B", text: "还在投递。" },
    ],
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    patches: [],
    join_after: [0, 1, 99, "invalid"],
  }) } }] }));
  try {
    const guarded = await correctTranscript({ config, meeting: source });
    assert.equal(guarded.semanticJoins, 0);
    assert.deepEqual(guarded.segments.map((segment) => segment.join_next), [false, false, false]);
    assert.deepEqual(guarded.segments.map((segment) => segment.text), source.segments.map((segment) => segment.text));
    assert.equal(readableTranscriptSegments(guarded.segments).length, 3);

    const layoutGuards = [
      [
        { start_seconds: 0, end_seconds: 10, speaker: "A", text: "重叠前段", join_next: true },
        { start_seconds: 9, end_seconds: 20, speaker: "A", text: "重叠后段" },
      ],
      [
        { start_seconds: 10, end_seconds: 20, speaker: "A", text: "逆序前段", join_next: true },
        { start_seconds: 5, end_seconds: 10, speaker: "A", text: "逆序后段" },
      ],
      [
        { start_seconds: 0, end_seconds: 60, speaker: "A", text: "超时前段", join_next: true },
        { start_seconds: 60, end_seconds: 100, speaker: "A", text: "超时后段" },
      ],
      [
        { start_seconds: 0, end_seconds: 10, speaker: "A", text: "长".repeat(799), join_next: true },
        { start_seconds: 10, end_seconds: 20, speaker: "A", text: "文本" },
      ],
      [
        { start_seconds: 0, speaker: "A", text: "缺少结束时间", join_next: true },
        { start_seconds: 30, end_seconds: 40, speaker: "A", text: "不应被误判为零间隔" },
      ],
    ];
    assert.deepEqual(layoutGuards.map((segments) => readableTranscriptSegments(segments).length), [2, 2, 2, 2, 2]);

    assert.equal(guarded.rejectedCorrections, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("correction batches include a bounded following-segment preview for cross-batch sentence decisions", async () => {
  const source = {
    ...meeting,
    segments: [
      { start_seconds: 0, end_seconds: 10, speaker: "A", text: `${"前".repeat(7_500)}。` },
      { start_seconds: 10, end_seconds: 20, speaker: "A", text: `${"后".repeat(700)}。` },
    ],
  };
  const payloads = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const user = JSON.parse(options.body).messages[1].content;
    const payload = JSON.parse(user.slice(user.indexOf("待检查片段：\n") + "待检查片段：\n".length));
    payloads.push(payload);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      patches: [],
      join_after: payload.segments[0]?.id === 0 ? [0] : [],
    }) } }] }));
  };
  try {
    const result = await correctTranscript({ config, meeting: source });
    assert.equal(payloads.length, 2);
    assert.equal(payloads[0].following_segment.id, 1);
    assert.ok(payloads[0].following_segment.text.length <= 500);
    assert.equal(payloads[1].following_segment, undefined);
    assert.equal(result.segments[0].join_next, false, "a join rejected by display limits is not persisted");
    assert.match(result.segments[0].text, /。$/u, "rejected joins preserve their sentence boundary punctuation");
    assert.equal(result.semanticJoins, 0, "joins rejected by display safety limits are not reported as applied");
    assert.equal(readableTranscriptSegments(result.segments).length, 2, "readable output still enforces its 800-character safety limit");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("readable semantic joins preserve natural spacing across Chinese and English boundaries", () => {
  const english = readableTranscriptSegments([
    { start_seconds: 0, end_seconds: 1, speaker: "A", text: "We discussed,", join_next: true },
    { start_seconds: 1, end_seconds: 2, speaker: "A", text: "the launch." },
  ]);
  const chinese = readableTranscriptSegments([
    { start_seconds: 0, end_seconds: 1, speaker: "A", text: "她现在", join_next: true },
    { start_seconds: 1, end_seconds: 2, speaker: "A", text: "正在找工作。" },
  ]);
  const mixed = readableTranscriptSegments([
    { start_seconds: 0, end_seconds: 1, speaker: "A", text: "讨论项目", join_next: true },
    { start_seconds: 1, end_seconds: 2, speaker: "A", text: "launch plan。" },
  ]);

  assert.equal(english[0].text, "We discussed, the launch.");
  assert.equal(chinese[0].text, "她现在正在找工作。");
  assert.equal(mixed[0].text, "讨论项目 launch plan。");
});

test("GPT correction applies multiple independent explicit mappings in one segment", async () => {
  const source = {
    ...meeting,
    segments: [{ start_seconds: 4, end_seconds: 9, speaker: "A", text: "result binding 交给 d-schedule 处理。" }],
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    patches: [{ id: 0, replacements: [
      { from: "result binding", to: "ResourceBinding" },
      { from: "d-schedule", to: "Descheduler" },
    ] }],
  }) } }] }));
  try {
    const result = await correctTranscript({
      config: { ...config, contextHint: "术语：result binding -> ResourceBinding；别名：d-schedule -> Descheduler" },
      meeting: source,
    });
    assert.equal(result.segments[0].text, "ResourceBinding 交给 Descheduler 处理。");
    assert.equal(result.segments[0].start_seconds, 4);
    assert.equal(result.segments[0].end_seconds, 9);
    assert.equal(result.segments[0].speaker, "A");
    assert.deepEqual(result.terminology, ["ResourceBinding", "Descheduler"]);
    assert.deepEqual(result.corrections.map(({ from, to, status, reason }) => ({ from, to, status, reason })), [
      { from: "result binding", to: "ResourceBinding", status: "accepted", reason: "explicit_alias" },
      { from: "d-schedule", to: "Descheduler", status: "accepted", reason: "explicit_alias" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("multiple accepted patches replay exactly when validating public evidence", async () => {
  const source = {
    ...meeting,
    rawSegments: [{ start_seconds: 4, end_seconds: 9, speaker: "A", text: "result binding 交给 d-schedule 处理并确认发布。" }],
    segments: [{ start_seconds: 4, end_seconds: 9, speaker: "A", text: "result binding 交给 d-schedule 处理并确认发布。" }],
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    patches: [{ id: 0, replacements: [
      { from: "result binding", to: "ResourceBinding" },
      { from: "d-schedule", to: "Descheduler" },
    ] }],
  }) } }] }));
  try {
    const corrected = await correctTranscript({
      config: { ...config, contextHint: "术语：result binding -> ResourceBinding；别名：d-schedule -> Descheduler" },
      meeting: source,
    });
    const shared = publicMeeting({
      ...source,
      ...corrected,
      highlights: [{ start_seconds: 4, speaker: "A", quote: "确认发布", reason: "明确确认" }],
      decision_records: [{ decision: "确认发布", start_seconds: 4, evidence: "确认发布" }],
    });
    assert.deepEqual(shared.highlights.map((item) => item.quote), ["ResourceBinding 交给 Descheduler 处理并确认发布。"]);
    assert.deepEqual(shared.decision_records.map((item) => item.evidence), ["ResourceBinding 交给 Descheduler 处理并确认发布。"]);
    assert.equal(Object.hasOwn(shared, "corrections"), false);
    assert.equal(Object.hasOwn(shared, "rawSegments"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("public evidence replays the persisted reconciliation ledger", () => {
  const rawSegments = [
    { start_seconds: 0, end_seconds: 6, timing_source: "provider", speaker: "A", text: "我觉得可以，嗯。" },
    { start_seconds: 5.5, end_seconds: 10, timing_source: "provider", speaker: "A", text: "嗯，我们确认发布" },
  ];
  const reconciled = reconcileTranscriptSegments(rawSegments);
  const source = {
    ...meeting,
    rawSegments,
    segments: reconciled.segments,
    asrReconciliations: reconciled.reconciliations,
    corrections: [],
    highlights: [{ start_seconds: 5.5, speaker: "A", quote: "确认发布", reason: "确认" }],
    decision_records: [{ decision: "确认发布", start_seconds: 5.5, evidence: "确认发布" }],
  };

  const shared = publicMeeting(source);
  assert.deepEqual(shared.highlights.map((item) => item.quote), ["我们确认发布"]);
  assert.deepEqual(shared.decision_records.map((item) => item.evidence), ["我们确认发布"]);
  assert.equal(Object.hasOwn(shared.segments[0], "timing_source"), false);

  const tampered = publicMeeting({
    ...source,
    asrReconciliations: source.asrReconciliations.map((entry) => ({ ...entry, algorithm_version: "future-version" })),
  });
  assert.deepEqual(tampered.highlights, []);
  assert.deepEqual(tampered.decision_records, []);
});

test("public evidence rejects a reconciliation ledger that inserts new claims", () => {
  const raw = { start_seconds: 0, end_seconds: 5, timing_source: "provider", speaker: "A", text: "原始内容" };
  const maliciousLedger = [{
    algorithm_version: "boundary-v1",
    segmentId: 0,
    source_hash: segmentSourceHash(raw, 0),
    start_offset: raw.text.length,
    end_offset: raw.text.length,
    from: "",
    to: "确认发布",
    at_seconds: 0,
    reason: "exact_overlap",
    removed_characters: 0,
    removed_from: "next",
  }];
  const shared = publicMeeting({
    ...meeting,
    rawSegments: [raw],
    segments: [{ ...raw, text: `${raw.text}确认发布` }],
    asrReconciliations: maliciousLedger,
    corrections: [],
    highlights: [{ start_seconds: 0, speaker: "A", quote: "确认发布", reason: "伪造" }],
    decision_records: [{ decision: "确认发布", start_seconds: 0, evidence: "确认发布" }],
  });

  assert.deepEqual(shared.highlights, []);
  assert.deepEqual(shared.decision_records, []);
});

test("terminology mappings are parsed from full context without accepting truncation markers", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    patches: [{ id: 0, replacements: [{ from: "万福来", to: "CanonicalLongName" }] }],
  }) } }] }));
  try {
    const result = await correctTranscript({
      config: { ...config, contextHint: `${"背景资料".repeat(600)}\n术语：万福来 -> CanonicalLongName` },
      meeting,
    });
    assert.equal(result.segments[0].text, "今天讨论CanonicalLongName。");
    assert.equal(result.corrections[0].to, "CanonicalLongName");
    assert.doesNotMatch(result.segments[0].text, /\.\.\./);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("terminology entry limits fail explicitly before any model request", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests += 1; throw new Error("must not request"); };
  try {
    const entries = Array.from({ length: 201 }, (_, index) => `错词${index} -> 正词${index}`).join("、");
    await assert.rejects(() => correctTranscript({
      config: { ...config, contextHint: `术语：${entries}` },
      meeting,
    }), /超过 200 项/);
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GPT correction keeps canonical-only terms as rejected candidates", async () => {
  const source = {
    ...meeting,
    segments: [{ start_seconds: 0, end_seconds: 3, speaker: "A", text: "项目叫万福来。" }],
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    patches: [{ id: 0, replacements: [{ from: "万福来", to: "OneFly" }] }],
  }) } }] }));
  try {
    const result = await correctTranscript({ config: { ...config, contextHint: "项目名 OneFly" }, meeting: source });
    assert.equal(result.segments[0].text, source.segments[0].text);
    assert.deepEqual(result.terminology, []);
    assert.equal(result.rejectedCorrections, 1);
    assert.equal(result.corrections[0].reason, "explicit_alias_required");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GPT correction rejects malformed patch responses instead of reporting success", async () => {
  const originalFetch = globalThis.fetch;
  const responses = ["not json", "{}"];
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: responses.shift() } }] }));
  try {
    for (let index = 0; index < 2; index += 1) {
      await assert.rejects(() => correctTranscript({
        config: { ...config, contextHint: "术语：万福来 -> OneFly" },
        meeting,
      }), /缺少 patches 数组.*保留原逐字稿/);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GPT correction rejects unknown entities", async () => {
  const source = {
    ...meeting,
    segments: [{ start_seconds: 0, end_seconds: 3, speaker: "A", text: "项目叫万福来。" }],
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    patches: [{ id: 0, replacements: [{ from: "万福来", to: "OtherProject" }] }],
  }) } }] }));
  try {
    const result = await correctTranscript({ config: { ...config, contextHint: "项目名 OneFly" }, meeting: source });
    assert.equal(result.segments[0].text, source.segments[0].text);
    assert.equal(result.rejectedCorrections, 1);
    assert.equal(result.corrections[0].reason, "unknown_canonical");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("explicit terminology mappings replace every repeated occurrence in a segment", async () => {
  const source = {
    ...meeting,
    segments: [{ start_seconds: 0, end_seconds: 3, speaker: "A", text: "万福来与万福来共同发布。" }],
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    patches: [],
  }) } }] }));
  try {
    const result = await correctTranscript({ config: { ...config, contextHint: "术语：万福来 -> OneFly" }, meeting: source });
    assert.equal(result.segments[0].text, "OneFly与OneFly共同发布。");
    assert.equal(result.rejectedCorrections, 0);
    assert.deepEqual(result.corrections.map(({ from, to, status, reason, start_offset, end_offset }) => ({
      from, to, status, reason, start_offset, end_offset,
    })), [
      { from: "万福来", to: "OneFly", status: "accepted", reason: "explicit_alias", start_offset: 0, end_offset: 3 },
      { from: "万福来", to: "OneFly", status: "accepted", reason: "explicit_alias", start_offset: 4, end_offset: 7 },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("explicit terminology matching treats spaces and dashes alike without rewriting inside Latin words", async () => {
  const source = {
    ...meeting,
    segments: [{ start_seconds: 0, end_seconds: 3, speaker: "A", text: "happy app，交给 d schedule 处理。" }],
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ patches: [], join_after: [] }) } }] }));
  try {
    const result = await correctTranscript({
      config: { ...config, contextHint: "术语：app -> Application、d-schedule -> Descheduler" },
      meeting: source,
    });
    assert.equal(result.segments[0].text, "happy Application，交给 Descheduler 处理。");
    assert.deepEqual(result.corrections.toSorted((left, right) => left.start_offset - right.start_offset).map(({ from, to }) => ({ from, to })), [
      { from: "app", to: "Application" },
      { from: "d schedule", to: "Descheduler" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("recording-wide consensus unifies repeated Descheduler variants across transcript and insights", async () => {
  const rawSegments = [
    { start_seconds: 0, end_seconds: 30, speaker: "发言人 1", text: "deployment 用那个 dis scheduler 是可以直接用的。" },
    { start_seconds: 30, end_seconds: 90, speaker: "发言人 1", text: "原来的那个 disk scheduler 那一坨，disk scheduler 每两分钟轮询。" },
    { start_seconds: 90, end_seconds: 120, speaker: "发言人 1", text: "适配这样的一个 Y调度 的发现接口。" },
    { start_seconds: 120, end_seconds: 210, speaker: "发言人 1", text: "适配到这个 DisScheduler 上面去，思路又转到了 DisScheduler。" },
    { start_seconds: 210, end_seconds: 240, speaker: "发言人 1", text: "继续讨论其他内容。" },
    { start_seconds: 240, end_seconds: 270, speaker: "发言人 1", text: "在这个 d schedule 里面检查状态。" },
  ];
  const source = { ...meeting, rawSegments, segments: rawSegments, asrReconciliations: [] };
  const patches = [
    { id: 0, replacements: [{ from: "dis scheduler", to: "Descheduler" }] },
    { id: 1, replacements: [{ from: "disk scheduler", to: "Descheduler" }] },
    { id: 2, replacements: [{ from: "Y调度", to: "Descheduler" }] },
    { id: 3, replacements: [{ from: "DisScheduler", to: "Descheduler" }] },
    { id: 5, replacements: [{ from: "d schedule", to: "Descheduler" }] },
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ patches, join_after: [] }) } }] }));
  try {
    const corrected = await correctTranscript({ config: { ...config, contextHint: "术语：Descheduler" }, meeting: source });
    const transcript = corrected.segments.map((segment) => segment.text).join("\n");
    assert.equal((transcript.match(/Descheduler/gu) || []).length, 7);
    assert.doesNotMatch(transcript, /dis scheduler|disk scheduler|DisScheduler|d schedule|Y调度/giu);
    assert.deepEqual(corrected.terminology, ["Descheduler"]);
    assert.equal(corrected.rejectedCorrections, 0);
    assert.equal(corrected.corrections.length, 7);
    assert.equal(corrected.corrections.every((entry) => entry.status === "accepted" && entry.reason === "recording_consensus"), true);
    assert.deepEqual(corrected.corrections.filter((entry) => entry.segmentId === 1).map((entry) => entry.start_offset), [6, 25]);

    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      title: "扩展 DisScheduler 任务类型适配方案讨论",
      summary: "disk scheduler 会发现调度问题，并把任务适配到 DisScheduler。",
      keywords: ["DisScheduler"],
      highlights: [{ start_seconds: 90, speaker: "发言人 1", quote: "Y调度", reason: "" }],
      speaker_summaries: [{ speaker: "发言人 1", summary: "讨论 d schedule。", key_points: ["使用 dis scheduler"] }],
      decisions: [], decision_records: [], action_items: [],
    }) } }] }));
    const summary = await summarizeTranscript({ config, meeting: { ...source, ...corrected } });
    const shared = publicMeeting({ ...source, ...corrected, ...summary });
    const exported = JSON.stringify(shared);
    assert.doesNotMatch(exported, /dis scheduler|disk scheduler|DisScheduler|d schedule|Y调度/giu);
    assert.match(shared.title, /Descheduler/u);
    assert.match(shared.summary, /Descheduler/u);
    assert.deepEqual(shared.keywords, ["Descheduler"]);
    assert.match(buildShareHtml({ ...source, ...corrected, ...summary }), /Descheduler/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("recording-wide terminology conflicts preserve the entire alias group", async () => {
  const source = {
    ...meeting,
    segments: [
      { start_seconds: 0, end_seconds: 3, speaker: "A", text: "disk scheduler 开始检查。" },
      { start_seconds: 3, end_seconds: 6, speaker: "A", text: "disk scheduler 完成检查。" },
    ],
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    patches: [
      { id: 0, replacements: [{ from: "disk scheduler", to: "Descheduler" }] },
      { id: 1, replacements: [{ from: "disk scheduler", to: "DiskScheduler" }] },
    ],
    join_after: [],
  }) } }] }));
  try {
    const result = await correctTranscript({ config: { ...config, contextHint: "" }, meeting: source });
    assert.deepEqual(result.segments.map((segment) => segment.text), source.segments.map((segment) => segment.text));
    assert.equal(result.terminology.length, 0);
    assert.equal(result.rejectedCorrections, 2);
    assert.equal(result.corrections.every((entry) => entry.status === "rejected"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("recording-wide terminology retry keeps a valid persisted canonical when the model later conflicts", async () => {
  const rawSegments = [
    { start_seconds: 0, end_seconds: 3, speaker: "A", text: "disk scheduler 开始检查。" },
    { start_seconds: 3, end_seconds: 6, speaker: "A", text: "disk scheduler 完成检查。" },
  ];
  const source = { ...meeting, rawSegments, segments: rawSegments, asrReconciliations: [] };
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      patches: rawSegments.map((_, id) => ({ id, replacements: [{ from: "disk scheduler", to: "Descheduler" }] })),
      join_after: [],
    }) } }] }));
    const first = await correctTranscript({ config: { ...config, contextHint: "" }, meeting: source });
    assert.deepEqual(first.segments.map((segment) => segment.text), ["Descheduler 开始检查。", "Descheduler 完成检查。"]);

    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      patches: rawSegments.map((_, id) => ({ id, replacements: [{ from: "disk scheduler", to: "DiskScheduler" }] })),
      join_after: [],
    }) } }] }));
    const retried = await correctTranscript({ config: { ...config, contextHint: "" }, meeting: { ...source, ...first } });
    assert.deepEqual(retried.segments.map((segment) => segment.text), first.segments.map((segment) => segment.text));
    assert.equal(retried.corrections.filter((entry) => entry.status === "accepted" && entry.reason === "recording_consensus").length, 2);
    assert.equal(retried.rejectedCorrections, 2);
    assert.equal(retried.corrections.filter((entry) => entry.status === "rejected").every((entry) => entry.reason === "canonical_mismatch"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("recording-wide terminology consensus closes aliases across correction batches", async () => {
  const source = {
    ...meeting,
    segments: [
      { start_seconds: 0, end_seconds: 30, speaker: "A", text: `dis scheduler ${"前".repeat(7_400)}` },
      { start_seconds: 30, end_seconds: 60, speaker: "A", text: `disk scheduler ${"后".repeat(1_000)}` },
    ],
  };
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async (url, options) => {
    requests += 1;
    const user = JSON.parse(options.body).messages[1].content;
    const payload = JSON.parse(user.slice(user.indexOf("待检查片段：\n") + "待检查片段：\n".length));
    const patches = payload.segments.map(({ id, text }) => ({
      id,
      replacements: [{ from: text.startsWith("dis scheduler") ? "dis scheduler" : "disk scheduler", to: "Descheduler" }],
    }));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ patches, join_after: [] }) } }] }));
  };
  try {
    const result = await correctTranscript({ config: { ...config, contextHint: "" }, meeting: source });
    assert.equal(requests, 2);
    assert.equal(result.segments[0].text.startsWith("Descheduler "), true);
    assert.equal(result.segments[1].text.startsWith("Descheduler "), true);
    assert.equal(result.corrections.filter((entry) => entry.status === "accepted").length, 2);
    assert.equal(result.rejectedCorrections, 0);
    assert.deepEqual(result.segments.map(({ start_seconds, end_seconds, speaker }) => ({ start_seconds, end_seconds, speaker })), source.segments.map(({ start_seconds, end_seconds, speaker }) => ({ start_seconds, end_seconds, speaker })));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GPT correction rejects explicit patches that alter protected facts", async () => {
  const source = {
    ...meeting,
    segments: [
      { start_seconds: 0, end_seconds: 1, speaker: "A", text: "我支持这个方案。" },
      { start_seconds: 1, end_seconds: 2, speaker: "A", text: "我不建议录用。" },
      { start_seconds: 2, end_seconds: 3, speaker: "A", text: "预算是 ¥100。" },
      { start_seconds: 3, end_seconds: 4, speaker: "A", text: "计划在 8 月 10 日发布。" },
      { start_seconds: 4, end_seconds: 5, speaker: "A", text: "这个方案风险很高。" },
    ],
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ patches: [
    { id: 0, replacements: [{ from: "支持", to: "反对" }] },
    { id: 1, replacements: [{ from: "不建议录用", to: "建议录用" }] },
    { id: 2, replacements: [{ from: "¥100", to: "$100" }] },
    { id: 3, replacements: [{ from: "8 月 10 日", to: "8 月 11 日" }] },
    { id: 4, replacements: [{ from: "风险很高", to: "风险很低" }] },
  ] }) } }] }));
  try {
    const result = await correctTranscript({
      config: { ...config, contextHint: "术语：支持 -> 反对；术语：不建议录用 -> 建议录用；术语：¥100 -> $100；术语：8 月 10 日 -> 8 月 11 日；术语：风险很高 -> 风险很低" },
      meeting: source,
    });
    assert.deepEqual(result.segments.map((segment) => segment.text), source.segments.map((segment) => segment.text));
    assert.equal(result.rejectedCorrections, 5);
    assert.deepEqual(result.terminology, []);
    assert.deepEqual(result.corrections.map((item) => item.reason), Array(5).fill("critical_fact_change"));
    assert.deepEqual(result.segments.map(({ start_seconds, end_seconds, speaker }) => ({ start_seconds, end_seconds, speaker })), source.segments.map(({ start_seconds, end_seconds, speaker }) => ({ start_seconds, end_seconds, speaker })));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GPT correction does not trust arbitrary short terms from an interview JD", async () => {
  const source = {
    ...meeting,
    mode: "interview",
    interviewContext: { role: "平台工程师", competencies: ["系统设计"], jobDescription: "负责低延迟系统" },
    segments: [{ start_seconds: 0, end_seconds: 3, speaker: "面试官", text: "这个方案风险很高。" }],
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    patches: [{ id: 0, replacements: [{ from: "高", to: "低" }] }],
  }) } }] }));
  try {
    const result = await correctTranscript({ config, meeting: source });
    assert.equal(result.segments[0].text, "这个方案风险很高。");
    assert.equal(result.segments[0].speaker, "面试官");
    assert.equal(result.rejectedCorrections, 1);
    assert.deepEqual(result.terminology, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GPT correction bounds context and preserves an oversized segment without sending it", async () => {
  const source = {
    ...meeting,
    segments: [
      { start_seconds: 0, end_seconds: 3, speaker: "A", text: "超长原始片段".repeat(2_000) },
      { start_seconds: 3, end_seconds: 6, speaker: "A", text: "项目叫万福来。" },
    ],
  };
  const originalFetch = globalThis.fetch;
  const prompts = [];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    const user = body.messages[1].content;
    prompts.push(user);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      patches: [{ id: 1, replacements: [{ from: "万福来", to: "OneFly" }] }],
    }) } }] }));
  };
  try {
    const result = await correctTranscript({
      config: { ...config, contextHint: `术语：万福来 -> OneFly；${"无关背景".repeat(5_000)}` },
      meeting: source,
    });
    assert.equal(prompts.length, 1);
    assert.ok(prompts[0].length <= 18_000);
    assert.equal(result.segments[0].text, source.segments[0].text);
    assert.equal(result.segments[1].text, "项目叫OneFly。");
    assert.equal(result.rejectedCorrections, 1);
    assert.deepEqual(result.terminology, ["OneFly"]);
    assert.deepEqual(result.corrections.map(({ segmentId, status, reason }) => ({ segmentId, status, reason })), [
      { segmentId: 0, status: "rejected", reason: "segment_too_large" },
      { segmentId: 1, status: "accepted", reason: "explicit_alias" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GPT correction uses bounded concurrency and preserves batch order", async () => {
  const source = {
    ...meeting,
    segments: Array.from({ length: 10 }, (_, index) => ({
      start_seconds: index * 3,
      end_seconds: index * 3 + 2,
      speaker: `发言人 ${index + 1}`,
      text: `SEGMENT_${index} ${"批次内容".repeat(700)}`,
    })),
  };
  const originalFetch = globalThis.fetch;
  let activeRequests = 0;
  let maxActiveRequests = 0;
  globalThis.fetch = async () => {
    activeRequests += 1;
    maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
    try {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ patches: [] }) } }] }));
    } finally {
      activeRequests -= 1;
    }
  };
  try {
    const result = await correctTranscript({ config, meeting: source });
    assert.equal(maxActiveRequests, 3);
    assert.deepEqual(result.segments.map((segment) => segment.start_seconds), source.segments.map((segment) => segment.start_seconds));
    assert.deepEqual(result.segments.map((segment) => segment.text), source.segments.map((segment) => segment.text));
    assert.deepEqual(result.corrections, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("bounded concurrency stops scheduling after failure and drains in-flight work", async () => {
  let rejectFirst;
  let resolveSecond;
  const firstGate = new Promise((resolve, reject) => { rejectFirst = reject; });
  const secondGate = new Promise((resolve) => { resolveSecond = resolve; });
  const started = [];
  let settled = false;
  const run = mapWithConcurrency([0, 1, 2, 3], 2, async (value) => {
    started.push(value);
    if (value === 0) return firstGate;
    if (value === 1) return secondGate;
    return value;
  }).finally(() => { settled = true; });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(started, [0, 1]);
  rejectFirst(new Error("leaf failed"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(settled, false);
  assert.deepEqual(started, [0, 1]);
  resolveSecond(1);
  await assert.rejects(run, /leaf failed/);
  assert.equal(settled, true);
  assert.deepEqual(started, [0, 1]);
});

test("GPT summary parses structured JSON", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: "```json\n{\"title\":\"OneFly 周会\",\"summary\":\"确定了交付计划\",\"keywords\":[\"OneFly\"],\"highlights\":[{\"start_seconds\":3,\"speaker\":\"发言人 2\",\"quote\":\"由小明明天完成\",\"reason\":\"明确承诺\"}],\"speaker_summaries\":[{\"speaker\":\"发言人 2\",\"summary\":\"确认交付\",\"key_points\":[\"明天完成\"]}],\"decisions\":[\"明天交付\"],\"decision_records\":[{\"decision\":\"明天交付\",\"start_seconds\":3,\"evidence\":\"由小明明天完成\"}],\"action_items\":[{\"task\":\"完成交付\",\"owner\":\"小明\",\"due\":\"明天\"}]}\n```" } }] }), { headers: { "content-type": "application/json" } });
  try {
    const result = await summarizeTranscript({ config, meeting });
    assert.equal(result.title, "OneFly 周会");
    assert.equal(result.action_items[0].owner, "小明");
    assert.equal(result.highlights[0].start_seconds, 3);
    assert.equal(result.speaker_summaries[0].key_points[0], "明天完成");
    assert.equal(result.decision_records[0].evidence, "由小明明天完成。");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("semantic display joins do not move evidence timestamps or collapse VTT cues", async () => {
  const rawSegments = [
    { start_seconds: 0, end_seconds: 10, speaker: "A", text: "她现在。" },
    { start_seconds: 10, end_seconds: 20, speaker: "A", text: "正在找工作。" },
  ];
  const source = {
    ...meeting,
    duration: 20,
    rawSegments,
    segments: [
      { ...rawSegments[0], text: "她现在", join_next: true },
      { ...rawSegments[1], join_next: false },
    ],
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    title: "求职讨论",
    summary: "讨论了求职进展。",
    highlights: [{ start_seconds: 10, speaker: "A", quote: "正在找工作", reason: "明确进展" }],
    decision_records: [],
  }) } }] }));
  try {
    const result = await summarizeTranscript({ config, meeting: source });
    assert.equal(result.highlights[0].start_seconds, 0);
    assert.equal(publicMeeting({ ...source, ...result }).highlights[0].start_seconds, 0);
    assert.equal(readableTranscriptSegments(source.segments).length, 1);
    assert.equal((toVtt(source).match(/-->/g) || []).length, 2);
    assert.match(toVtt(source), /00:00:10\.000 --> 00:00:20\.000/);

    const production = publicMeeting({
      ...source,
      corrections: [],
      asrReconciliations: [],
      highlights: [{ start_seconds: 0, speaker: "A", quote: "她现在", reason: "合法前半句" }],
    });
    assert.deepEqual(production.highlights.map((item) => item.quote), ["她现在正在找工作。"]);

    const tampered = publicMeeting({
      ...source,
      corrections: [],
      asrReconciliations: [],
      segments: [{ ...source.segments[0], text: "她现" }, source.segments[1]],
      highlights: [{ start_seconds: 0, speaker: "A", quote: "她现", reason: "非法删改" }],
    });
    assert.deepEqual(tampered.highlights, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("text requests retry a transient 429 before returning the summary", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts === 1) {
      return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429,
        headers: { "retry-after": "0" },
      });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: "已恢复", summary: "完成" }) } }] }));
  };
  try {
    const result = await summarizeTranscript({ config, meeting });
    assert.equal(attempts, 2);
    assert.equal(result.title, "已恢复");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("summary drops quotes that do not match the referenced transcript segment", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    title: "不可信纪要",
    summary: "测试证据过滤",
    highlights: [
      { start_seconds: 3, speaker: "发言人 2", quote: "由小明明天完成", reason: "有效" },
      { start_seconds: 0, speaker: "发言人 1", quote: "从未说过的原话", reason: "无效" },
    ],
    decision_records: [
      { decision: "明天完成", start_seconds: 3, evidence: "由小明明天完成" },
      { decision: "虚构决策", start_seconds: 3, evidence: "预算已经获批" },
    ],
    decisions: ["绕过证据校验的虚构决策"],
  }) } }] }));
  try {
    const result = await summarizeTranscript({ config, meeting });
    assert.deepEqual(result.highlights.map((item) => item.quote), ["由小明明天完成。"]);
    assert.deepEqual(result.decision_records.map((item) => item.decision), ["由小明明天完成。"]);
    assert.deepEqual(result.decisions, ["由小明明天完成。"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("decision evidence must also overlap the claimed decision", async () => {
  const weatherMeeting = {
    ...meeting,
    segments: [{ start_seconds: 0, end_seconds: 5, speaker: "A", text: "今天天气很好。" }],
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    decision_records: [{ decision: "批准一千万元预算", start_seconds: 0, evidence: "今天天气很好" }],
  }) } }] }));
  try {
    const result = await summarizeTranscript({ config, meeting: weatherMeeting });
    assert.deepEqual(result.decision_records, []);
    assert.deepEqual(result.decisions, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("decision validation rejects a fabricated claim padded with a real quote", async () => {
  const weatherMeeting = {
    ...meeting,
    segments: [{ start_seconds: 0, end_seconds: 5, speaker: "A", text: "今天天气很好。" }],
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    decision_records: [{ decision: "今天天气很好，因此批准一千万元预算", start_seconds: 0, evidence: "今天天气很好" }],
  }) } }] }));
  try {
    const result = await summarizeTranscript({ config, meeting: weatherMeeting });
    assert.deepEqual(result.decision_records, []);
    assert.deepEqual(result.decisions, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("evidence comparison preserves semantic symbols", async () => {
  const symbolMeeting = {
    ...meeting,
    segments: [{ start_seconds: 0, end_seconds: 5, speaker: "A", text: "预算是 ¥100，技术栈是 C++。" }],
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    highlights: [
      { start_seconds: 0, quote: "预算是 ¥100" },
      { start_seconds: 0, quote: "预算是 $100" },
      { start_seconds: 0, quote: "技术栈是 C#" },
    ],
  }) } }] }));
  try {
    const result = await summarizeTranscript({ config, meeting: symbolMeeting });
    assert.deepEqual(result.highlights.map((item) => item.quote), ["预算是 ¥100，技术栈是 C++。"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("evidence is rejected when the displayed segment cannot be traced to raw ASR", async () => {
  const alteredMeeting = {
    ...meeting,
    rawSegments: [{ start_seconds: 0, end_seconds: 3, speaker: "A", text: "我不建议录用。" }],
    segments: [{ start_seconds: 0, end_seconds: 3, speaker: "A", text: "我建议录用。" }],
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    highlights: [{ start_seconds: 0, quote: "我建议录用" }],
    decision_records: [{ decision: "建议录用", start_seconds: 0, evidence: "我建议录用" }],
  }) } }] }));
  try {
    const result = await summarizeTranscript({ config, meeting: alteredMeeting });
    assert.deepEqual(result.highlights, []);
    assert.deepEqual(result.decision_records, []);
    assert.deepEqual(result.decisions, []);
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

test("long meeting summaries use bounded transcript batches and retain verified evidence", async () => {
  const segments = [...Array.from({ length: 9 }, (_, index) => ({
    start_seconds: index * 10,
    end_seconds: index * 10 + 9,
    speaker: `发言人 ${index + 1}`,
    text: `${index === 0 ? "LONG_START 会议开场。" : ""}${"常规讨论内容。".repeat(1_300)}`,
  })),
  { start_seconds: 90, end_seconds: 99, speaker: "发言人 10", text: "最终确认发布天穹计划。" },
  { start_seconds: 100, end_seconds: 109, speaker: "发言人 11", text: "LONG_END" }];
  const longMeeting = { ...meeting, duration: 110, segments };
  const requests = [];
  let activeRequests = 0;
  let maxActiveRequests = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    activeRequests += 1;
    maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
    try {
      const user = JSON.parse(options.body).messages[1].content;
      requests.push(user);
      await new Promise((resolve) => setTimeout(resolve, 5));
      let result;
      if (user.includes("相邻分段摘要")) {
        result = { title: "长会议", summary: "会议覆盖常规讨论并最终确认天穹计划发布。", keywords: ["天穹计划"] };
      } else if (user.includes("最终确认发布天穹计划")) {
        result = {
          summary: "最终确认天穹计划发布。",
          highlights: [{ start_seconds: 90, speaker: "发言人 10", quote: "最终确认发布天穹计划", reason: "明确发布决定" }],
          decision_records: [{ decision: "发布天穹计划", start_seconds: 90, evidence: "最终确认发布天穹计划" }],
        };
      } else {
        result = { summary: user.includes("LONG_START") ? "会议开始常规讨论。" : "会议继续常规讨论。" };
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }), { headers: { "content-type": "application/json" } });
    } finally {
      activeRequests -= 1;
    }
  };
  try {
    const result = await summarizeTranscript({ config, meeting: longMeeting });
    const transcriptRequests = requests.filter((user) => user.includes("会议逐字稿"));
    const mergeRequests = requests.filter((user) => user.includes("相邻分段摘要"));
    assert.ok(transcriptRequests.length > 4);
    assert.ok(mergeRequests.length > 1);
    assert.equal(maxActiveRequests, 3);
    assert.ok(requests.every((user) => user.length <= 18_000));
    assert.ok(requests.every((user) => !(user.includes("LONG_START") && user.includes("LONG_END"))));
    assert.match(result.summary, /天穹计划/);
    assert.deepEqual(result.highlights.map((item) => item.quote), ["最终确认发布天穹计划。"]);
    assert.deepEqual(result.decision_records.map((item) => item.decision), ["最终确认发布天穹计划。"]);
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
        competencies: [{ name: "系统设计", rating: "strong", assessment: "给出了分层方案。", evidence: [
          { start_seconds: 3, quote: "由小明明天完成" },
          { start_seconds: 0, quote: "并不存在的面试原话" },
          { start_seconds: "unknown", quote: "由小明明天完成" },
        ] }],
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
    assert.equal(result.interviewReport.competencies[0].evidence.length, 1);
    assert.equal(result.interviewReport.competencies[1].rating, "insufficient");
    assert.deepEqual(result.interviewReport.strengths, []);
    assert.deepEqual(result.interviewReport.risks, ["故障排查：证据不足"]);
    assert.doesNotMatch(JSON.stringify(result.interviewReport), /能够分解系统职责|缺少复杂故障案例/);
    assert.match(prompt, /不得根据声音、口音/);
    assert.match(prompt, /系统设计、故障排查/);

    const completed = { ...interview, ...result, qa: [{ role: "user", content: "内部问题" }], rawSegments: interview.segments };
    const publicData = publicMeeting(completed);
    assert.equal(publicData.schema, 3);
    assert.equal(publicData.interviewContext.role, "平台工程师");
    assert.equal(publicData.interviewReport.recommendation, "follow_up");
    assert.doesNotMatch(JSON.stringify(publicData), /机密平台|Alice|内部问题|rawSegments/);
    assert.match(toMarkdown(completed), /不判断原话是否来自候选人或证明能力/);
    assert.match(toMarkdown(completed), /\[00:03\]/);
    const shareHtml = buildShareHtml(completed);
    assert.match(shareHtml, /程序只校验时间和原话/);
    assert.match(shareHtml, /证据复核/);
    assert.doesNotMatch(shareHtml, /置信度/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("interview output never turns an unrelated quote into an automatic competency rating", async () => {
  const interview = {
    ...meeting,
    mode: "interview",
    interviewContext: { role: "平台工程师", competencies: ["系统设计"] },
    segments: [{ start_seconds: 0, end_seconds: 5, speaker: "候选人", text: "今天天气很好。" }],
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    interview_report: {
      recommendation: "advance",
      confidence: "high",
      competencies: [
        {
          name: "系统设计",
          rating: "strong",
          assessment: "具备千万级系统架构能力。",
          evidence: [{ start_seconds: 0, quote: "今天天气很好" }],
        },
        { name: "天气聊天", rating: "strong", evidence: [{ start_seconds: 0, quote: "今天天气很好" }] },
      ],
      strengths: ["架构能力突出"],
    },
  }) } }] }));
  try {
    const result = await summarizeTranscript({ config, meeting: interview });
    const competency = result.interviewReport.competencies[0];
    assert.equal(competency.rating, "mixed");
    assert.equal(competency.assessment, "仅展示可核验原话；是否支持该能力项需面试官人工判断。");
    assert.equal(competency.evidence[0].quote, "今天天气很好。");
    assert.deepEqual(result.interviewReport.competencies.map((item) => item.name), ["系统设计"]);
    assert.deepEqual(result.interviewReport.strengths, []);
    assert.equal(result.interviewReport.recommendation, "follow_up");
    assert.equal(result.interviewReport.confidence, "medium");
    assert.doesNotMatch(JSON.stringify(result), /千万级|架构能力突出/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("long interviews merge same-competency evidence from bounded transcript batches", async () => {
  const segments = [
    { start_seconds: 0, end_seconds: 9, speaker: "候选人", text: "候选人说明系统边界。" },
    ...Array.from({ length: 8 }, (_, index) => ({
    start_seconds: index * 10 + 10,
    end_seconds: index * 10 + 19,
    speaker: "候选人",
    text: `${index === 0 ? "LONG_INTERVIEW_START" : ""}${"面试过程记录。".repeat(700)}`,
  })),
    { start_seconds: 90, end_seconds: 99, speaker: "候选人", text: "候选人说明故障回滚。" },
    { start_seconds: 100, end_seconds: 109, speaker: "候选人", text: "LONG_INTERVIEW_END" },
  ];
  const interview = {
    ...meeting,
    mode: "interview",
    duration: 110,
    segments,
    interviewContext: { role: "平台工程师", competencies: ["系统设计"] },
  };
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const user = JSON.parse(options.body).messages[1].content;
    requests.push(user);
    const evidence = [];
    if (user.includes("候选人说明系统边界")) evidence.push({ start_seconds: 0, quote: "候选人说明系统边界" });
    if (user.includes("候选人说明故障回滚")) evidence.push({ start_seconds: 90, quote: "候选人说明故障回滚" });
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      title: "长面试",
      interview_report: {
        competencies: evidence.length ? [{ name: "系统设计", rating: "strong", assessment: "模型评分", evidence }] : [],
        follow_ups: evidence.length ? ["请说明取舍。"] : [],
      },
    }) } }] }), { headers: { "content-type": "application/json" } });
  };
  try {
    const result = await summarizeTranscript({ config, meeting: interview });
    const competency = result.interviewReport.competencies[0];
    assert.ok(requests.length > 2);
    assert.ok(requests.every((user) => user.length <= 18_000));
    assert.ok(requests.every((user) => !(user.includes("LONG_INTERVIEW_START") && user.includes("LONG_INTERVIEW_END"))));
    assert.equal(competency.rating, "mixed");
    assert.equal(competency.assessment, "仅展示可核验原话；是否支持该能力项需面试官人工判断。");
    assert.deepEqual(competency.evidence.map((item) => item.quote), ["候选人说明系统边界。", "候选人说明故障回滚。"]);
    assert.deepEqual(result.interviewReport.strengths, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("interview report limits high-confidence advancement when competency coverage is sparse", async () => {
  const interview = {
    ...meeting,
    mode: "interview",
    interviewContext: { role: "平台工程师", competencies: ["系统设计", "故障排查"] },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    summary: "模型给出了过强结论。",
    interview_report: {
      recommendation: "advance",
      confidence: "high",
      overview: "候选人精通零信任。",
      competencies: [{ name: "系统设计", rating: "strong", assessment: "给出了具体方案。", evidence: [{ start_seconds: 3, quote: "由小明明天完成" }] }],
      strengths: ["精通零信任架构"],
      risks: ["未经证实的风险"],
    },
  }) } }] }));
  try {
    const result = await summarizeTranscript({ config, meeting: interview });
    assert.equal(result.interviewReport.recommendation, "follow_up");
    assert.equal(result.interviewReport.confidence, "medium");
    assert.deepEqual(result.interviewReport.strengths, []);
    assert.deepEqual(result.interviewReport.risks, ["故障排查：证据不足"]);
    assert.doesNotMatch(JSON.stringify(result), /精通零信任|未经证实的风险|过强结论/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("interview evidence is unique across competencies and cannot preserve a sparse hold decision", async () => {
  const interview = {
    ...meeting,
    mode: "interview",
    interviewContext: { role: "平台工程师", competencies: ["系统设计", "故障排查"] },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    interview_report: {
      recommendation: "hold",
      confidence: "high",
      competencies: [
        { name: "系统设计", rating: "strong", assessment: "有项目经验。", evidence: [{ start_seconds: 3, quote: "由小明明天完成" }] },
        { name: "故障排查", rating: "strong", assessment: "模型重复使用同一证据。", evidence: [{ start_seconds: 3, quote: "由小明明天完成" }] },
      ],
    },
  }) } }] }));
  try {
    const result = await summarizeTranscript({ config, meeting: interview });
    assert.equal(result.interviewReport.recommendation, "follow_up");
    assert.equal(result.interviewReport.confidence, "medium");
    assert.equal(result.interviewReport.competencies[0].evidence.length, 1);
    assert.equal(result.interviewReport.competencies[1].evidence.length, 0);
    assert.equal(result.interviewReport.competencies[1].rating, "insufficient");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("interview automation never advances or rejects a candidate even with full evidence coverage", async () => {
  const interview = {
    ...meeting,
    mode: "interview",
    interviewContext: { role: "平台工程师", competencies: ["系统设计", "故障排查"] },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    interview_report: {
      recommendation: "advance",
      confidence: "high",
      competencies: [
        { name: "系统设计", rating: "adequate", assessment: "有一条证据。", evidence: [{ start_seconds: 0, quote: "今天讨论万福来" }] },
        { name: "故障排查", rating: "adequate", assessment: "有一条证据。", evidence: [{ start_seconds: 3, quote: "由小明明天完成" }] },
      ],
    },
  }) } }] }));
  try {
    const result = await summarizeTranscript({ config, meeting: interview });
    assert.equal(result.interviewReport.recommendation, "follow_up");
    assert.equal(result.interviewReport.confidence, "medium");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("interview report downgrades conclusions when no evidence survives validation", async () => {
  const interview = {
    ...meeting,
    mode: "interview",
    interviewContext: { role: "平台工程师", competencies: ["系统设计"] },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    summary: "模型声称候选人表现突出。",
    interview_report: {
      recommendation: "advance",
      confidence: "high",
      overview: "建议录用。",
      competencies: [{ name: "系统设计", rating: "strong", assessment: "能力突出。", evidence: [{ start_seconds: 0, quote: "不存在的证据" }] }],
      strengths: ["架构能力突出"],
      risks: [],
    },
  }) } }] }));
  try {
    const result = await summarizeTranscript({ config, meeting: interview });
    assert.equal(result.interviewReport.recommendation, "insufficient");
    assert.equal(result.interviewReport.confidence, "low");
    assert.equal(result.interviewReport.competencies[0].rating, "insufficient");
    assert.deepEqual(result.interviewReport.strengths, []);
    assert.match(result.interviewReport.overview, /没有通过逐字稿校验/);
    assert.equal(result.summary, result.interviewReport.overview);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("long transcript questions select bounded relevant excerpts and fall back to both edges", async () => {
  const segments = Array.from({ length: 12 }, (_, index) => ({
    start_seconds: index * 5,
    end_seconds: index * 5 + 4,
    speaker: "发言人",
    text: `${index === 0 ? "EDGE_START。" : ""}${"普通背景内容。".repeat(450)}${index === 6 ? "天穹计划采用星河数据库。" : ""}${index === 11 ? "EDGE_END。" : ""}`,
  }));
  const longMeeting = { ...meeting, duration: 60, segments };
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const user = JSON.parse(options.body).messages[1].content;
    requests.push(user);
    return new Response(JSON.stringify({ choices: [{ message: { content: "已根据选取片段回答。" } }] }));
  };
  try {
    await askTranscript({ config, meeting: longMeeting, question: "天穹计划采用什么数据库？" });
    await askTranscript({ config, meeting: longMeeting, question: "火星殖民补给方案是什么？" });
    assert.equal(requests.length, 2);
    assert.ok(requests.every((user) => user.length <= 18_000));
    assert.ok(requests.every((user) => user.includes("按问题选取的片段") && user.includes("非完整逐字稿")));
    assert.match(requests[0], /天穹计划采用星河数据库/);
    assert.doesNotMatch(requests[0], /EDGE_START.*EDGE_END/s);
    assert.match(requests[1], /EDGE_START/);
    assert.match(requests[1], /EDGE_END/);
    assert.ok(requests[1].indexOf("EDGE_START") < requests[1].indexOf("EDGE_END"));
    for (const request of requests) {
      const times = [...request.matchAll(/\[(\d{2}):(\d{2})\]/g)].map((match) => Number(match[1]) * 60 + Number(match[2]));
      assert.deepEqual(times, [...times].sort((left, right) => left - right));
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("public evidence rejects a fabricated boundary deletion that removes a negation", () => {
  const rawSegments = [
    { start_seconds: 0, end_seconds: 6, timing_source: "provider", speaker: "A", text: "讨论预算方案" },
    { start_seconds: 5.5, end_seconds: 10, timing_source: "provider", speaker: "A", text: "不要批准预算" },
  ];
  const target = rawSegments[1];
  const maliciousLedger = [{
    algorithm_version: "boundary-v1",
    segmentId: 1,
    source_hash: segmentSourceHash(target, 1),
    start_offset: 0,
    end_offset: 2,
    from: "不要",
    to: "",
    at_seconds: 5.5,
    reason: "exact_overlap",
    removed_characters: 2,
    removed_from: "next",
  }];
  const shared = publicMeeting({
    ...meeting,
    rawSegments,
    segments: [rawSegments[0], { ...target, text: "批准预算" }],
    asrReconciliations: maliciousLedger,
    corrections: [],
    highlights: [{ start_seconds: 5.5, speaker: "A", quote: "批准预算" }],
    decision_records: [{ decision: "批准预算", start_seconds: 5.5, evidence: "批准预算" }],
  });

  assert.deepEqual(shared.highlights, []);
  assert.deepEqual(shared.decision_records, []);
});

test("legacy meetings without a reconciliation ledger replay their original timeline unchanged", () => {
  const rawSegments = [
    { start_seconds: 0, end_seconds: 6, timing_source: "provider", speaker: "A", text: "完成服务部署" },
    { start_seconds: 5.5, end_seconds: 10, timing_source: "provider", speaker: "A", text: "服务部署，然后确认发布" },
  ];
  const shared = publicMeeting({
    ...meeting,
    rawSegments,
    segments: rawSegments,
    highlights: [{ start_seconds: 5.5, speaker: "A", quote: "确认发布" }],
    decision_records: [{ decision: "确认发布", start_seconds: 5.5, evidence: "确认发布" }],
  });

  assert.deepEqual(shared.highlights.map((item) => item.quote), ["服务部署，然后确认发布"]);
  assert.deepEqual(shared.decision_records.map((item) => item.evidence), ["服务部署，然后确认发布"]);
});

test("public evidence rejects transcript timestamps that drift from raw ASR geometry", () => {
  const raw = { start_seconds: 0, end_seconds: 5, speaker: "A", text: "确认发布" };
  const shared = publicMeeting({
    ...meeting,
    rawSegments: [raw],
    segments: [{ ...raw, start_seconds: 3_600, end_seconds: 3_605 }],
    asrReconciliations: [],
    corrections: [],
    highlights: [{ start_seconds: 3_600, speaker: "A", quote: "确认发布" }],
  });

  assert.deepEqual(shared.highlights, []);
});

test("accepted term patches remain replayable after display terminology deduplication", async () => {
  const rawSegments = [
    { start_seconds: 0, end_seconds: 4, speaker: "A", text: "万福来确认需求" },
    { start_seconds: 4, end_seconds: 8, speaker: "A", text: "万福莱确认发布" },
  ];
  const source = { ...meeting, rawSegments, segments: rawSegments, asrReconciliations: [] };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    patches: [
      { id: 0, replacements: [{ from: "万福来", to: "OneFly" }] },
      { id: 1, replacements: [{ from: "万福莱", to: "onefly" }] },
    ],
    join_after: [],
  }) } }] }));
  try {
    const corrected = await correctTranscript({
      config: { ...config, contextHint: "术语：万福来 -> OneFly、万福莱 -> onefly" },
      meeting: source,
    });
    assert.deepEqual(corrected.terminology, ["OneFly"]);
    assert.equal(corrected.corrections.filter((item) => item.status === "accepted").length, 2);

    const shared = publicMeeting({
      ...source,
      ...corrected,
      highlights: [{ start_seconds: 4, speaker: "A", quote: "确认发布" }],
    });
    assert.deepEqual(shared.highlights.map((item) => item.quote), ["onefly确认发布"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("explicit terminology mappings can normalize case and spacing", async () => {
  const rawSegments = [
    { start_seconds: 0, end_seconds: 4, speaker: "A", text: "onefly确认需求" },
    { start_seconds: 4, end_seconds: 8, speaker: "A", text: "open sandbox确认发布" },
  ];
  const source = { ...meeting, rawSegments, segments: rawSegments, asrReconciliations: [] };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    patches: [
      { id: 0, replacements: [{ from: "onefly", to: "OneFly" }] },
      { id: 1, replacements: [{ from: "open sandbox", to: "OpenSandbox" }] },
    ],
    join_after: [],
  }) } }] }));
  try {
    const corrected = await correctTranscript({
      config: { ...config, contextHint: "术语：onefly -> OneFly、open sandbox -> OpenSandbox" },
      meeting: source,
    });
    assert.deepEqual(corrected.segments.map((item) => item.text), ["OneFly确认需求", "OpenSandbox确认发布"]);
    assert.equal(corrected.rejectedCorrections, 0);
    const shared = publicMeeting({
      ...source,
      ...corrected,
      highlights: [{ start_seconds: 4, speaker: "A", quote: "确认发布" }],
    });
    assert.deepEqual(shared.highlights.map((item) => item.quote), ["OpenSandbox确认发布"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("correction retry reuses valid accepted patches and ignores invalid model ids", async () => {
  const raw = { start_seconds: 0, end_seconds: 5, speaker: "A", text: "万福来确认发布" };
  const source = { ...meeting, rawSegments: [raw], segments: [raw], asrReconciliations: [] };
  const correctionConfig = { ...config, contextHint: "术语：万福来 -> OneFly" };
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      patches: [{ id: 0, replacements: [{ from: "万福来", to: "OneFly" }] }],
      join_after: [],
    }) } }] }));
    const first = await correctTranscript({ config: correctionConfig, meeting: source });

    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ patches: [], join_after: [] }) } }] }));
    const retried = await correctTranscript({ config: correctionConfig, meeting: { ...source, ...first } });
    assert.equal(retried.segments[0].text, "OneFly确认发布");

    for (const id of [null, "", false]) {
      globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        patches: [{ id, replacements: [{ from: "万福来", to: "OneFly" }] }],
        join_after: [],
      }) } }] }));
      const result = await correctTranscript({ config: correctionConfig, meeting: { ...source, ...first } });
      assert.equal(result.segments[0].text, "OneFly确认发布");
      assert.equal(result.corrections.some((item) => item.status === "accepted"), true);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("all accepted mappings remain available beyond the old sixty-term display cap", async () => {
  const rawSegments = Array.from({ length: 61 }, (_, index) => ({
    start_seconds: index,
    end_seconds: index + 1,
    speaker: "A",
    text: `错词${index}确认发布`,
  }));
  const mappings = rawSegments.map((_, index) => `错词${index} -> 正词${index}`).join("、");
  const patches = rawSegments.map((_, index) => ({
    id: index,
    replacements: [{ from: `错词${index}`, to: `正词${index}` }],
  }));
  const source = { ...meeting, rawSegments, segments: rawSegments, asrReconciliations: [] };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ patches, join_after: [] }) } }] }));
  try {
    const corrected = await correctTranscript({ config: { ...config, contextHint: `术语：${mappings}` }, meeting: source });
    assert.equal(corrected.terminology.length, 61);
    assert.equal(corrected.corrections.filter((item) => item.status === "accepted").length, 61);
    const shared = publicMeeting({
      ...source,
      ...corrected,
      highlights: [{ start_seconds: 60, speaker: "A", quote: "确认发布" }],
    });
    assert.deepEqual(shared.highlights.map((item) => item.quote), ["正词60确认发布"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("duplicate quotes use the model speaker hint and reject an unhinted timestamp tie", () => {
  const segments = [
    { start_seconds: 0, end_seconds: 10, speaker: "A", text: "确认发布" },
    { start_seconds: 0, end_seconds: 10, speaker: "B", text: "确认发布" },
  ];
  const shared = publicMeeting({
    ...meeting,
    segments,
    highlights: [{ start_seconds: 0, speaker: "B", quote: "确认发布" }],
    decision_records: [{ decision: "确认发布", start_seconds: 0, evidence: "确认发布" }],
  });

  assert.deepEqual(shared.highlights.map((item) => item.speaker), ["B"]);
  assert.deepEqual(shared.decision_records, []);
});

test("evidence quotes preserve Chinese and English negation context", () => {
  const chinese = publicMeeting({
    ...meeting,
    segments: [{ start_seconds: 0, end_seconds: 5, speaker: "A", text: "我不建议录用候选人。" }],
    highlights: [{ start_seconds: 0, speaker: "A", quote: "建议录用候选人" }],
  });
  const english = publicMeeting({
    ...meeting,
    segments: [{ start_seconds: 0, end_seconds: 5, speaker: "A", text: "I do not recommend, hiring the candidate." }],
    highlights: [{ start_seconds: 0, speaker: "A", quote: "hiring the candidate" }],
  });

  assert.deepEqual(chinese.highlights.map((item) => item.quote), ["我不建议录用候选人。"]);
  assert.deepEqual(english.highlights.map((item) => item.quote), ["I do not recommend, hiring the candidate."]);
});

test("validated semantic joins restore preceding negation and its timestamp", () => {
  const rawSegments = [
    { start_seconds: 0, end_seconds: 5, speaker: "A", text: "我不建议。" },
    { start_seconds: 5, end_seconds: 10, speaker: "A", text: "录用候选人。" },
  ];
  const segments = [
    { ...rawSegments[0], text: "我不建议", join_next: true },
    { ...rawSegments[1], join_next: false },
  ];
  const shared = publicMeeting({
    ...meeting,
    rawSegments,
    segments,
    asrReconciliations: [],
    corrections: [],
    highlights: [{ start_seconds: 5, speaker: "A", quote: "录用候选人" }],
  });

  assert.deepEqual(shared.highlights.map(({ start_seconds, quote }) => ({ start_seconds, quote })), [{
    start_seconds: 0,
    quote: "我不建议录用候选人。",
  }]);
});

test("decision titles cannot reverse the polarity of contextual evidence", () => {
  const shared = publicMeeting({
    ...meeting,
    segments: [{ start_seconds: 0, end_seconds: 5, speaker: "A", text: "我们不确认发布。" }],
    decision_records: [{ decision: "确认发布", start_seconds: 0, evidence: "确认发布" }],
  });

  assert.deepEqual(shared.decision_records, [{
    decision: "我们不确认发布。",
    start_seconds: 0,
    evidence: "我们不确认发布。",
  }]);
  assert.deepEqual(shared.decisions, ["我们不确认发布。"]);
});

test("interview competency matching preserves the requested display name across casing", async () => {
  const interview = {
    ...meeting,
    mode: "interview",
    interviewContext: { role: "Platform Engineer", competencies: ["System Design"] },
    segments: [{ start_seconds: 0, end_seconds: 5, speaker: "Candidate", text: "I designed the service boundary." }],
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    interview_report: {
      competencies: [{ name: "system design", evidence: [{ start_seconds: 0, quote: "designed the service boundary" }] }],
    },
  }) } }] }));
  try {
    const result = await summarizeTranscript({ config, meeting: interview });
    assert.equal(result.interviewReport.competencies[0].name, "System Design");
    assert.equal(result.interviewReport.competencies[0].evidence.length, 1);
    assert.equal(result.interviewReport.recommendation, "follow_up");
    assert.match(result.interviewReport.overview, /1\/1/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("evidence always preserves conditional, modal, and hearsay context", () => {
  const cases = [
    { text: "如果条件满足，就录用候选人。", quote: "录用候选人", expected: "如果条件满足，就录用候选人。" },
    { text: "We might hire the candidate.", quote: "hire the candidate", expected: "We might hire the candidate." },
    { text: "听说他支持这个方案。", quote: "支持这个方案", expected: "听说他支持这个方案。" },
  ];

  for (const item of cases) {
    const shared = publicMeeting({
      ...meeting,
      segments: [{ start_seconds: 0, end_seconds: 5, speaker: "A", text: item.text }],
      highlights: [{ start_seconds: 0, speaker: "A", quote: item.quote }],
    });
    assert.deepEqual(shared.highlights.map((entry) => entry.quote), [item.expected]);
  }
});

test("decision records publish only the complete verified evidence clause", () => {
  const cases = [
    { text: "如果条件满足，就确认发布。", claim: "确认发布", expected: "如果条件满足，就确认发布。" },
    { text: "我们可能确认发布。", claim: "确认发布", expected: "我们可能确认发布。" },
    { text: "听说负责人确认发布。", claim: "确认发布", expected: "听说负责人确认发布。" },
    { text: "We might approve the release.", claim: "approve the release", expected: "We might approve the release." },
  ];

  for (const item of cases) {
    const shared = publicMeeting({
      ...meeting,
      segments: [{ start_seconds: 0, end_seconds: 5, speaker: "A", text: item.text }],
      decision_records: [{ decision: item.claim, start_seconds: 0, evidence: item.claim }],
    });
    assert.deepEqual(shared.decision_records, [{ decision: item.expected, start_seconds: 0, evidence: item.expected }]);
  }
});

test("punctuation never strips conditions or hearsay from evidence", () => {
  const cases = [
    { text: "如果条件满足；就确认发布。", claim: "就确认发布", expected: "如果条件满足；就确认发布。" },
    { text: "If all tests pass; approve the release.", claim: "approve the release", expected: "If all tests pass; approve the release." },
    { text: "这只是听说；负责人确认发布。", claim: "负责人确认发布", expected: "这只是听说；负责人确认发布。" },
  ];

  for (const item of cases) {
    const shared = publicMeeting({
      ...meeting,
      segments: [{ start_seconds: 0, end_seconds: 5, speaker: "A", text: item.text }],
      highlights: [{ start_seconds: 0, speaker: "A", quote: item.claim }],
      decision_records: [{ decision: item.claim, start_seconds: 0, evidence: item.claim }],
    });
    assert.equal(shared.highlights[0].quote, item.expected);
    assert.equal(shared.decision_records[0].decision, item.expected);
  }
});

test("highlight rationales are not published as verified facts", () => {
  const shared = publicMeeting({
    ...meeting,
    segments: [{ start_seconds: 0, end_seconds: 5, speaker: "A", text: "我们不支持这个方案。" }],
    highlights: [{ start_seconds: 0, speaker: "A", quote: "不支持这个方案", reason: "明确支持，应立即采用" }],
  });

  assert.equal(shared.highlights[0].quote, "我们不支持这个方案。");
  assert.equal(shared.highlights[0].reason, "");
});

test("context expansion deduplicates highlights and decisions after validation", () => {
  const shared = publicMeeting({
    ...meeting,
    segments: [{ start_seconds: 0, end_seconds: 5, speaker: "A", text: "负责人最终确认发布天穹计划。" }],
    highlights: [
      { start_seconds: 0, speaker: "A", quote: "确认发布" },
      { start_seconds: 0, speaker: "A", quote: "发布天穹计划" },
    ],
    decision_records: [
      { decision: "确认发布", start_seconds: 0, evidence: "确认发布" },
      { decision: "发布天穹计划", start_seconds: 0, evidence: "发布天穹计划" },
    ],
  });

  assert.equal(shared.highlights.length, 1);
  assert.equal(shared.decision_records.length, 1);
  assert.equal(shared.highlights[0].quote, "负责人最终确认发布天穹计划。");
});

test("interview evidence keeps the actual transcript speaker in exports and shares", () => {
  const interview = {
    ...meeting,
    mode: "interview",
    interviewContext: { candidateAlias: "候选人", role: "平台工程师", stage: "技术一面", competencies: ["系统设计"] },
    segments: [{ start_seconds: 0, end_seconds: 5, speaker: "面试官", text: "请说明你如何设计系统边界。" }],
    interviewReport: {
      competencies: [{ name: "系统设计", evidence: [{ start_seconds: 0, quote: "请说明你如何设计系统边界" }] }],
    },
  };
  const shared = publicMeeting(interview);
  const evidence = shared.interviewReport.competencies[0].evidence[0];

  assert.equal(evidence.speaker, "面试官");
  assert.match(toMarkdown(interview), /面试官：“请说明你如何设计系统边界。”/);
  assert.doesNotMatch(toMarkdown(interview), /候选原话/);
  assert.match(buildShareHtml(interview), /v\.speaker\|\|"发言人"/);
});

test("large-meeting evidence validation replays correction state once per view", () => {
  const segmentCount = 2_000;
  const segments = Array.from({ length: segmentCount }, (_, index) => ({
    start_seconds: index * 2,
    end_seconds: index * 2 + 1,
    speaker: "A",
    text: `片段${index}确认发布。`,
  }));
  const highlights = Array.from({ length: 50 }, (_, index) => {
    const segmentIndex = index * 39;
    return { start_seconds: segmentIndex * 2, speaker: "A", quote: "确认发布" };
  });
  const corrections = segments.map((segment, segmentId) => ({
    segmentId,
    source_hash: segmentSourceHash(segment, segmentId),
    status: "rejected",
    reason: "explicit_alias_required",
  }));
  const startedAt = performance.now();
  const shared = publicMeeting({
    ...meeting,
    rawSegments: segments,
    segments,
    asrReconciliations: [],
    corrections,
    highlights,
  });
  const elapsedMs = performance.now() - startedAt;

  assert.equal(shared.highlights.length, 20);
  assert.ok(elapsedMs < 1_500, `evidence validation took ${elapsedMs.toFixed(1)}ms`);
});
