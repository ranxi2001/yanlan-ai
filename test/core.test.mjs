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
    assert.equal(result.segments[0].speaker, "发言人 1");
    assert.deepEqual(result.terminology, ["OneFly"]);
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
  const correctedText = [
    "赵丽蓉是一个非常漂亮、非常美丽的研究生宝宝，她是",
    "合肥工业大学物流和工程与管理的研究生，他现在",
    "正在找工作，投递了拼多多和百度的管培生，他一定会找到",
    "非常好的工作的，孩子一定能考上公务员。我们敬请期待他的",
    "的收获吧。\n这个断句不太好，是不是？对。",
    "你发现没有花的。",
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    assert.match(body.messages[0].content, /固定时长切片|join_next/);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      segments: correctedText.map((text, id) => ({ id, speaker: "发言人 1", text, join_next: id < 4 })),
      terminology: [],
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
    assert.match(readable[0].text, /收获吧。\n这个断句不太好/);
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

test("semantic joins reject speaker changes, large gaps, and structurally invalid model output", async () => {
  const source = {
    ...meeting,
    segments: [
      { start_seconds: 0, end_seconds: 10, speaker: "A", text: "她现在。" },
      { start_seconds: 10, end_seconds: 20, speaker: "B", text: "正在找工作。" },
      { start_seconds: 30, end_seconds: 40, speaker: "B", text: "还在投递。" },
    ],
  };
  const originalFetch = globalThis.fetch;
  let invalid = false;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    segments: invalid
      ? [{ id: 0, text: "恶意改写", join_next: true }, { id: 0, text: "重复 ID", join_next: true }, { id: 2, text: "还在投递", join_next: true }]
      : source.segments.map((segment, id) => ({ id, speaker: "A", text: segment.text, join_next: true })),
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
    ];
    assert.deepEqual(layoutGuards.map((segments) => readableTranscriptSegments(segments).length), [2, 2, 2, 2]);

    invalid = true;
    const rejected = await correctTranscript({ config, meeting: source });
    assert.equal(rejected.rejectedCorrections, 3);
    assert.equal(rejected.semanticJoins, 0);
    assert.deepEqual(rejected.segments.map((segment) => segment.text), source.segments.map((segment) => segment.text));
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
    const payload = JSON.parse(user.slice(user.indexOf("待校对片段：\n") + "待校对片段：\n".length));
    payloads.push(payload);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      segments: payload.segments.map((segment) => ({ ...segment, join_next: segment.id === 0 })),
    }) } }] }));
  };
  try {
    const result = await correctTranscript({ config, meeting: source });
    assert.equal(payloads.length, 2);
    assert.equal(payloads[0].following_segment.id, 1);
    assert.ok(payloads[0].following_segment.text.length <= 500);
    assert.equal(payloads[1].following_segment, undefined);
    assert.equal(result.segments[0].join_next, true);
    assert.equal(result.semanticJoins, 0, "joins rejected by display safety limits are not reported as applied");
    assert.equal(readableTranscriptSegments(result.segments).length, 2, "readable output still enforces its 800-character safety limit");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GPT correction rejects material rewrites", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    segments: [
      { id: 0, speaker: "Alice", text: "预算已经获批，产品今天正式上线。" },
      { id: 1, speaker: "小明", text: "客户已经签约并完成全部付款。" },
    ],
  }) } }] }));
  try {
    const result = await correctTranscript({ config, meeting });
    assert.deepEqual(result.segments.map((segment) => segment.text), meeting.segments.map((segment) => segment.text));
    assert.equal(result.rejectedCorrections, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GPT correction rejects semantic reversals and critical value changes", async () => {
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
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ segments: [
    { id: 0, speaker: "A", text: "我反对这个方案。" },
    { id: 1, speaker: "A", text: "我建议录用。" },
    { id: 2, speaker: "A", text: "预算是 $100。" },
    { id: 3, speaker: "A", text: "计划在 8 月 11 日发布。" },
    { id: 4, speaker: "候选人", text: "这个方案风险很低。" },
  ], terminology: ["反对", "$100"] }) } }] }));
  try {
    const result = await correctTranscript({ config, meeting: source });
    assert.deepEqual(result.segments.map((segment) => segment.text), source.segments.map((segment) => segment.text));
    assert.equal(result.rejectedCorrections, 5);
    assert.deepEqual(result.terminology, []);
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
    segments: [{ id: 0, speaker: "候选人", text: "这个方案风险很低。" }],
    terminology: ["低"],
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

test("GPT correction rejects a semantic reversal even when the replacement is an explicit multi-character term", async () => {
  const source = {
    ...meeting,
    segments: [{ start_seconds: 0, end_seconds: 3, speaker: "A", text: "这个方案属于高风险。" }],
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    segments: [{ id: 0, speaker: "A", text: "这个方案属于低风险。" }],
    terminology: ["低风险"],
  }) } }] }));
  try {
    const result = await correctTranscript({ config: { ...config, contextHint: "术语：低风险" }, meeting: source });
    assert.equal(result.segments[0].text, "这个方案属于高风险。");
    assert.equal(result.rejectedCorrections, 1);
    assert.deepEqual(result.terminology, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GPT correction can unify a second occurrence of an explicit term", async () => {
  const source = {
    ...meeting,
    segments: [{ start_seconds: 0, end_seconds: 3, speaker: "A", text: "OneFly 与万福来项目。" }],
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    segments: [{ id: 0, speaker: "A", text: "OneFly 与 OneFly 项目。" }],
    terminology: ["OneFly"],
  }) } }] }));
  try {
    const result = await correctTranscript({ config, meeting: source });
    assert.equal(result.segments[0].text, "OneFly 与 OneFly 项目。");
    assert.deepEqual(result.terminology, ["OneFly"]);
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
      segments: [{ id: 1, speaker: "A", text: "项目叫 OneFly。" }],
      terminology: ["OneFly"],
    }) } }] }));
  };
  try {
    const result = await correctTranscript({
      config: { ...config, contextHint: `项目名：OneFly；${"无关背景".repeat(5_000)}` },
      meeting: source,
    });
    assert.equal(prompts.length, 1);
    assert.ok(prompts[0].length <= 18_000);
    assert.equal(result.segments[0].text, source.segments[0].text);
    assert.equal(result.segments[1].text, "项目叫 OneFly。");
    assert.equal(result.rejectedCorrections, 1);
    assert.deepEqual(result.terminology, ["OneFly"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
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
    assert.equal(result.decision_records[0].evidence, "由小明明天完成");
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
    assert.equal(result.highlights[0].start_seconds, 10);
    assert.equal(publicMeeting({ ...source, ...result }).highlights[0].start_seconds, 10);
    assert.equal(readableTranscriptSegments(source.segments).length, 1);
    assert.equal((toVtt(source).match(/-->/g) || []).length, 2);
    assert.match(toVtt(source), /00:00:10\.000 --> 00:00:20\.000/);
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
    assert.deepEqual(result.highlights.map((item) => item.quote), ["由小明明天完成"]);
    assert.deepEqual(result.decision_records.map((item) => item.decision), ["明天完成"]);
    assert.deepEqual(result.decisions, ["明天完成"]);
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
    assert.deepEqual(result.highlights.map((item) => item.quote), ["预算是 ¥100"]);
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
  const segments = Array.from({ length: 9 }, (_, index) => ({
    start_seconds: index * 10,
    end_seconds: index * 10 + 9,
    speaker: `发言人 ${index + 1}`,
    text: `${index === 0 ? "LONG_START 会议开场。" : ""}${"常规讨论内容。".repeat(1_300)}${index === 8 ? "最终确认发布天穹计划。LONG_END" : ""}`,
  }));
  const longMeeting = { ...meeting, duration: 90, segments };
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const user = JSON.parse(options.body).messages[1].content;
    requests.push(user);
    let result;
    if (user.includes("相邻分段摘要")) {
      result = { title: "长会议", summary: "会议覆盖常规讨论并最终确认天穹计划发布。", keywords: ["天穹计划"] };
    } else if (user.includes("最终确认发布天穹计划")) {
      result = {
        summary: "最终确认天穹计划发布。",
        highlights: [{ start_seconds: 80, speaker: "发言人 9", quote: "最终确认发布天穹计划", reason: "明确发布决定" }],
        decision_records: [{ decision: "发布天穹计划", start_seconds: 80, evidence: "最终确认发布天穹计划" }],
      };
    } else {
      result = { summary: user.includes("LONG_START") ? "会议开始常规讨论。" : "会议继续常规讨论。" };
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }), { headers: { "content-type": "application/json" } });
  };
  try {
    const result = await summarizeTranscript({ config, meeting: longMeeting });
    const transcriptRequests = requests.filter((user) => user.includes("会议逐字稿"));
    const mergeRequests = requests.filter((user) => user.includes("相邻分段摘要"));
    assert.ok(transcriptRequests.length > 4);
    assert.ok(mergeRequests.length > 1);
    assert.ok(requests.every((user) => user.length <= 18_000));
    assert.ok(requests.every((user) => !(user.includes("LONG_START") && user.includes("LONG_END"))));
    assert.match(result.summary, /天穹计划/);
    assert.deepEqual(result.highlights.map((item) => item.quote), ["最终确认发布天穹计划"]);
    assert.deepEqual(result.decision_records.map((item) => item.decision), ["发布天穹计划"]);
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
    assert.match(toMarkdown(completed), /不判断原话是否证明能力/);
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
    assert.equal(competency.evidence[0].quote, "今天天气很好");
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
  const segments = Array.from({ length: 8 }, (_, index) => ({
    start_seconds: index * 10,
    end_seconds: index * 10 + 9,
    speaker: "候选人",
    text: `${index === 0 ? "候选人说明系统边界。LONG_INTERVIEW_START" : ""}${"面试过程记录。".repeat(700)}${index === 7 ? "候选人说明故障回滚。LONG_INTERVIEW_END" : ""}`,
  }));
  const interview = {
    ...meeting,
    mode: "interview",
    duration: 80,
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
    if (user.includes("候选人说明故障回滚")) evidence.push({ start_seconds: 70, quote: "候选人说明故障回滚" });
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
    assert.deepEqual(competency.evidence.map((item) => item.quote), ["候选人说明系统边界", "候选人说明故障回滚"]);
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
