import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";
import { buildShareHtml } from "../src/api.js";

let developmentServer;
let baseUrl = process.env.APP_URL || "";
if (!baseUrl) {
  developmentServer = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    logLevel: "error",
    server: {
      host: "127.0.0.1",
      port: 4173,
      strictPort: false,
      hmr: false,
      watch: { ignored: ["**/artifacts/**"] },
    },
  });
  await developmentServer.listen();
  baseUrl = developmentServer.resolvedUrls?.local?.[0]?.replace(/\/$/, "") || "http://127.0.0.1:4173";
}
const fixture = { name: "meeting-test-zh.wav", mimeType: "audio/wav", buffer: createWavFixture() };
await mkdir(new URL("../artifacts", import.meta.url), { recursive: true });

const browser = await chromium.launch({ headless: true, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, acceptDownloads: true, permissions: ["microphone"] });
const page = await context.newPage();
page.setDefaultTimeout(90_000);
page.setDefaultNavigationTimeout(180_000);
const browserErrors = [];
const gptRequests = [];
const expectedQuestionAbortRequests = new WeakSet();
let gptResponses = 0;
let transientAsrFailures = 0;
let successfulAsrResponsesRemaining = Number.POSITIVE_INFINITY;
let asrTranscript = "今天讨论万福来项目，由小明明天完成。";
let asrResponseDelayMs = 0;
let transientCorrectionFailures = 0;
let transientSummaryFailures = 0;
let correctionResponseDelayMs = 0;
let correctionResponseGate = null;
let summaryResponseDelayMs = 0;
let questionResponseDelayMs = 0;
let asrRequestCount = 0;
let correctionRequestCount = 0;
let summaryRequestCount = 0;
let questionRequestCount = 0;
let agentCallSequence = 0;
let meetingAnalysisCallSequence = 0;
page.on("console", (message) => { if (message.type() === "error") browserErrors.push(message.text()); });
page.on("pageerror", (error) => browserErrors.push(error.message));
page.on("requestfailed", (request) => {
  const errorText = request.failure()?.errorText || "unknown";
  const expectedQuestionAbort = errorText === "net::ERR_ABORTED"
    && expectedQuestionAbortRequests.has(request);
  if (!request.url().startsWith("blob:") && !expectedQuestionAbort) browserErrors.push(`Request failed: ${request.url()} (${errorText})`);
});

await page.route("https://mimo.example/v1/chat/completions", async (route) => {
  asrRequestCount += 1;
  assert.equal(route.request().method(), "POST");
  assert.match(route.request().headers().authorization || "", /^Bearer asr-test-key$/);
  const request = route.request().postDataJSON();
  assert.equal(request.model, "mimo-v2.5-asr");
  assert.match(request.messages[0].content[0].input_audio.data, /^data:audio\/wav;base64,/);
  if (asrResponseDelayMs) {
    const delay = asrResponseDelayMs;
    asrResponseDelayMs = 0;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  if (successfulAsrResponsesRemaining <= 0 || transientAsrFailures > 0) {
    transientAsrFailures = Math.max(0, transientAsrFailures - 1);
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "temporary ASR failure" } }) });
    return;
  }
  if (Number.isFinite(successfulAsrResponsesRemaining)) successfulAsrResponsesRemaining -= 1;
  await route.fulfill({
    contentType: "application/json",
    body: JSON.stringify(typeof asrTranscript === "string" ? {
      choices: [{ message: { content: asrTranscript } }],
    } : asrTranscript),
  });
});

await page.route("https://bad-mimo.example/v1/chat/completions", async (route) => {
  await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: { message: "invalid API key" } }) });
});

await page.route("https://gpt.example/v1/responses", async (route) => {
  assert.match(route.request().headers().authorization || "", /^Bearer gpt-test-key$/);
  const request = route.request().postDataJSON();
  gptRequests.push({ instructions: String(request.instructions || "").slice(0, 80), inputLength: String(request.input || "").length });
  assert.equal(request.model, "gpt-5.6-luna");
  assert.equal(request.store, false);
  assert.equal(request.messages, undefined);
  const system = request.instructions;
  const user = request.input;
  const correctionRequest = Array.isArray(request.tools)
    && request.tools.some((tool) => tool.name === "finalize_correction");
  const meetingAnalysisRequest = Array.isArray(request.tools)
    && request.tools.some((tool) => tool.name === "finalize_meeting_analysis");
  const summaryRequest = meetingAnalysisRequest || system.includes("会议纪要助手") || system.includes("面试证据提取助手");
  const questionRequest = system.includes("会议记录问答助手") || system.includes("面试证据问答助手");
  if (questionRequest) {
    questionRequestCount += 1;
    expectedQuestionAbortRequests.add(route.request());
  }
  const agentOutputs = correctionRequest
    ? request.input.filter((item) => item?.type === "function_call_output")
    : [];
  const agentStart = correctionRequest && agentOutputs.length === 0;
  if (agentStart) correctionRequestCount += 1;
  if (summaryRequest) summaryRequestCount += 1;
  if (agentStart && transientCorrectionFailures > 0) {
    transientCorrectionFailures -= 1;
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "temporary correction failure" } }) });
    return;
  }
  if (summaryRequest && transientSummaryFailures > 0) {
    transientSummaryFailures -= 1;
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "temporary summary failure" } }) });
    return;
  }
  if (summaryRequest && summaryResponseDelayMs) {
    const delay = summaryResponseDelayMs;
    summaryResponseDelayMs = 0;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  if (agentStart && correctionResponseGate) {
    const gate = correctionResponseGate;
    correctionResponseGate = null;
    await gate;
  }
  if (agentStart && correctionResponseDelayMs) {
    const delay = correctionResponseDelayMs;
    correctionResponseDelayMs = 0;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  if (questionRequest && questionResponseDelayMs) {
    const delay = questionResponseDelayMs;
    questionResponseDelayMs = 0;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  let content;
  if (correctionRequest) {
    agentCallSequence += 1;
    const initialItem = request.input.find((item) => item?.role === "user" && typeof item.content === "string");
    const initial = JSON.parse(initialItem.content);
    const readOutput = agentOutputs.find((item) => item.call_id.startsWith("browser_read_"));
    const inspectOutput = agentOutputs.find((item) => item.call_id.startsWith("browser_inspect_"));
    let output;
    if (!readOutput) {
      output = [{
        id: `browser_fc_read_${agentCallSequence}`,
        type: "function_call",
        status: "completed",
        call_id: `browser_read_${agentCallSequence}`,
        name: "read_transcript_window",
        arguments: JSON.stringify({ start_segment: 0, max_segments: 60 }),
      }];
    } else if (!inspectOutput) {
      output = [{
        id: `browser_fc_inspect_${agentCallSequence}`,
        type: "function_call",
        status: "completed",
        call_id: `browser_inspect_${agentCallSequence}`,
        name: "inspect_terminology_signals",
        arguments: JSON.stringify({}),
      }];
    } else {
      assert.equal(JSON.parse(inspectOutput.output).ok, true);
      const readResult = JSON.parse(readOutput.output);
      const transcript = readResult.segments.map((segment) => segment.text).join("\n");
      const mappings = initial.explicit_mappings.filter((mapping) => transcript.includes(mapping.alias));
      output = [{
        id: `browser_fc_finalize_${agentCallSequence}`,
        type: "function_call",
        status: "completed",
        call_id: `browser_finalize_${agentCallSequence}`,
        name: "finalize_correction",
        arguments: JSON.stringify({ mappings, join_after: [] }),
      }];
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({
      id: `browser_agent_response_${agentCallSequence}`,
      status: "completed",
      output,
    }) });
    gptResponses += 1;
    return;
  } else if (meetingAnalysisRequest) {
    meetingAnalysisCallSequence += 1;
    assert.equal(request.parallel_tool_calls, false);
    assert.deepEqual(request.tools.map((tool) => tool.name), ["review_meeting_commitments", "finalize_meeting_analysis"]);
    const reviewTool = request.tools[0];
    const finalizationTool = request.tools[1];
    assert.equal(reviewTool.strict, true);
    assert.equal(reviewTool.parameters.additionalProperties, false);
    assert.deepEqual(reviewTool.parameters.required, ["reviews"]);
    assert.deepEqual(reviewTool.parameters.properties.reviews.items.properties.disposition.enum, [
      "confirmed", "question", "unresolved", "negated", "other",
    ]);
    assert.equal(finalizationTool.strict, true);
    assert.equal(finalizationTool.parameters.additionalProperties, false);
    assert.deepEqual(finalizationTool.parameters.required, [
      "summary_evidence_ids",
      "highlight_ids",
      "speaker_summaries",
    ]);
    assert.equal(Object.hasOwn(finalizationTool.parameters.properties, "title"), false);
    assert.equal(Object.hasOwn(finalizationTool.parameters.properties, "summary"), false);
    assert.equal(Object.hasOwn(finalizationTool.parameters.properties, "keywords"), false);
    assert.equal(Object.hasOwn(finalizationTool.parameters.properties, "decision_ids"), false);
    assert.equal(Object.hasOwn(finalizationTool.parameters.properties, "action_item_ids"), false);
    assert.equal(finalizationTool.parameters.properties.speaker_summaries.items.additionalProperties, false);
    const initialItem = request.input.find((item) => item?.role === "user" && typeof item.content === "string");
    assert.ok(initialItem);
    const initial = JSON.parse(initialItem.content);
    assert.match(initial.source_signature, /^fnv1a32:[0-9a-f]{8}$/);
    assert.equal(initial.transcript_batch_count, 1);
    const evidence = initial.evidence;
    const ids = (kind) => evidence.filter((record) => record.kind === kind).map((record) => record.id);
    assert.equal(initial.commitment_candidate_count, ids("decision").length + ids("action").length);
    const summaryEvidence = evidence.find((record) => record.kind === "summary");
    assert.equal(summaryEvidence.scope, "transcript_batch");
    assert.ok([
      "今天讨论OneFly项目，由小明明天完成。",
      "今天讨论万福来项目，由小明明天完成。",
    ].includes(summaryEvidence.quote_previews[0].quote));
    const speakerEvidence = evidence.filter((record) => record.kind === "speaker_point");
    assert.ok(speakerEvidence.every((record) => record.speaker === "发言人 1"));
    assert.ok(evidence.filter((record) => record.kind === "decision" || record.kind === "action")
      .every((record) => typeof record.evidence === "string" && record.evidence.length > 0));
    const reviewOutput = request.input.find((item) => (
      item?.type === "function_call_output"
      && String(item.call_id || "").startsWith("browser_commitment_review_")
    ));
    const commitmentEvidence = evidence.filter((record) => record.kind === "decision" || record.kind === "action");
    const output = commitmentEvidence.length && !reviewOutput ? [{
      id: `browser_fc_commitment_review_${meetingAnalysisCallSequence}`,
      type: "function_call",
      status: "completed",
      call_id: `browser_commitment_review_${meetingAnalysisCallSequence}`,
      name: "review_meeting_commitments",
      arguments: JSON.stringify({
        reviews: commitmentEvidence.map((record) => ({ evidence_id: record.id, disposition: "confirmed" })),
      }),
    }] : [{
      id: `browser_fc_meeting_analysis_${meetingAnalysisCallSequence}`,
      type: "function_call",
      status: "completed",
      call_id: `browser_meeting_analysis_${meetingAnalysisCallSequence}`,
      name: "finalize_meeting_analysis",
      arguments: JSON.stringify({
        summary_evidence_ids: ids("summary"),
        highlight_ids: ids("highlight"),
        speaker_summaries: speakerEvidence.length
          ? [{ speaker: "发言人 1", evidence_ids: speakerEvidence.map((record) => record.id) }]
          : [],
      }),
    }];
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({
      id: `browser_meeting_analysis_response_${meetingAnalysisCallSequence}`,
      status: "completed",
      output,
    }) });
    gptResponses += 1;
    return;
  } else if (system.includes("面试证据提取助手")) {
    assert.match(system, /不得根据声音、口音/);
    assert.match(user, /目标岗位：平台工程师/);
    content = JSON.stringify({
      title: "平台工程师技术一面",
      summary: "候选人给出了服务降级和故障定位思路。",
      keywords: ["服务降级", "故障定位"],
      interview_report: {
        recommendation: "follow_up",
        confidence: "medium",
        overview: "候选人具备基本故障处理思路，系统设计深度需要补充验证。",
        competencies: [
          { name: "系统设计", rating: "mixed", assessment: "提到了服务降级，但缺少容量与一致性细节。", evidence: [{ start_seconds: 0, quote: "我会先做服务降级" }] },
          { name: "故障排查", rating: "adequate", assessment: "给出了日志与指标结合的定位路径。", evidence: [{ start_seconds: 0.12, quote: "通过日志和指标定位故障" }] },
          { name: "协作沟通", rating: "insufficient", assessment: "证据不足", evidence: [] },
        ],
        strengths: ["能够先控制故障影响"],
        risks: ["系统设计深度尚未验证"],
        follow_ups: ["请说明降级恢复时如何保证数据一致性。"],
      },
    });
  } else if (system.includes("会议纪要助手")) {
    content = JSON.stringify({
      title: "",
      summary: "会议明确了 OneFly 项目的近期交付安排。",
      keywords: ["OneFly"],
      summary_evidence: [{ start_seconds: 0, quote: "今天讨论OneFly项目，由小明明天完成。" }],
      highlights: [{ start_seconds: 0, speaker: "发言人 1", quote: "今天讨论OneFly项目，由小明明天完成。", reason: "明确了负责人和交付时间" }],
      speaker_summaries: [{
        speaker: "发言人 1",
        summary: "确认了 OneFly 项目的交付安排。",
        key_points: ["明天完成项目"],
        evidence: [{ start_seconds: 0, quote: "今天讨论OneFly项目，由小明明天完成。" }],
      }],
      decisions: ["项目明天完成"],
      decision_records: [{ decision: "明天完成", start_seconds: 0, evidence: "今天讨论OneFly项目，由小明明天完成。" }],
      action_items: [{
        task: "完成 OneFly 项目",
        owner: "小明",
        due: "明天",
        start_seconds: 0,
        evidence: "今天讨论OneFly项目，由小明明天完成。",
      }],
    });
  } else {
    content = "小明负责在明天完成 OneFly 项目（00:00）。";
  }
  await route.fulfill({ contentType: "application/json", body: JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: content }] }] }) });
  gptResponses += 1;
});

if (process.argv.includes("--races-only")) {
  try {
    await verifyRetryReadDeletionRace(browser, baseUrl, fixture);
    await verifyRecoveryDeletionRace(browser, baseUrl, fixture);
    await verifyCompletedTombstoneStartupCleanup(browser, baseUrl, fixture);
    console.log("Browser deletion races passed: retry reads abort before ASR, recovery cannot resurrect audio, and completed tombstones clean orphaned IndexedDB data.");
  } finally {
    await browser.close();
    await developmentServer?.close();
  }
  process.exit(0);
}

try {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator("#brandLogo").waitFor();
  assert.equal(await page.locator("#brandLogo").evaluate((image) => image.complete && image.naturalWidth === 1254), true);
  assert.match(await page.locator('link[rel="icon"]').getAttribute("href"), /yanlan-logo\.png$/);
  await page.locator("#settingsButton").click();
  await page.locator("#settingsDialog").waitFor({ state: "visible" });
  assert.equal(await page.locator("#testAsrButton").getAttribute("aria-label"), "测试 MiMo 连接");
  assert.equal(await page.locator("#testChatButton").getAttribute("aria-label"), "测试 GPT 连接");
  assert.equal(await page.locator('.provider-link[href="https://ai.tosky.top/"]').getAttribute("target"), "_blank");
  await page.getByText("OpenAI 兼容接口 · 已为本站（onefly.top）配置跨域白名单", { exact: true }).waitFor();
  assert.equal(await page.locator('.provider-link[href="https://platform.xiaomimimo.com?ref=6ENEDG"]').getAttribute("target"), "_blank");
  await page.getByText("专属链接注册，双方各得 10 元 API 体验金", { exact: true }).waitFor();
  assert.equal(await page.locator("#asrBaseUrlInput").inputValue(), "https://api.xiaomimimo.com");
  assert.equal(await page.locator("#asrProtocolInput").count(), 0);
  assert.equal(await page.locator("#asrPathInput").count(), 0);
  await page.locator("#mimoHelpButton").click();
  await page.getByText("配置 MiMo 语音转写", { exact: true }).waitFor();
  await page.getByText("Token Plan 当前面向 AI 编程工具，会议转写应使用按量 API Key。", { exact: false }).waitFor();
  await page.screenshot({ path: fileURLToPath(new URL("../artifacts/mimo-help-desktop.png", import.meta.url)), fullPage: true });
  await page.locator('#mimoHelpDialog [value="default"]').click();
  await page.screenshot({ path: fileURLToPath(new URL("../artifacts/recommended-providers-desktop.png", import.meta.url)), fullPage: true });
  await page.locator("#settingsDialog header .icon-button").click();
  assert.equal(await page.locator("#settingsDialog").evaluate((element) => element.open), false);
  await page.locator("#settingsButton").click();
  const settingsActionButtons = page.locator("#settingsDialog .settings-footer button");
  assert.equal(await settingsActionButtons.count(), 5);
  assert.deepEqual(await settingsActionButtons.evaluateAll((buttons) => buttons.map((button) => getComputedStyle(button).fontSize)), Array(5).fill("11px"));
  assert.deepEqual(await settingsActionButtons.evaluateAll((buttons) => buttons.map((button) => getComputedStyle(button).minHeight)), Array(5).fill("34px"));
  await page.locator("#saveSettingsButton").scrollIntoViewIfNeeded();
  await page.screenshot({ path: fileURLToPath(new URL("../artifacts/settings-actions-desktop.png", import.meta.url)), fullPage: true });
  await page.locator('#settingsDialog footer [value="cancel"]').click();
  assert.equal(await page.locator("#settingsDialog").evaluate((element) => element.open), false);

  await page.locator("#startRecordButton").click();
  try {
    await page.locator("#liveRecorder:not(.hidden)").waitFor({ timeout: 45_000 });
  } catch (error) {
    const recorderState = await page.evaluate(async () => ({
      toast: document.querySelector("#toast")?.textContent,
      toastClass: document.querySelector("#toast")?.className,
      activeId: JSON.parse(localStorage.getItem("yanlan.meetings.v1") || "[]")[0]?.id || null,
      mediaRecorder: typeof MediaRecorder,
      audioContext: typeof AudioContext,
      mediaDevices: Boolean(navigator.mediaDevices?.getUserMedia),
      microphonePermission: await navigator.permissions?.query?.({ name: "microphone" }).then((result) => result.state).catch(() => "unknown"),
    }));
    throw new Error(`Recorder did not start: ${JSON.stringify({ recorderState, browserErrors })}`, { cause: error });
  }
  await page.getByText("音频正在增量保存在本机", { exact: true }).waitFor();
  await page.waitForTimeout(1200);
  await page.locator("#stopRecordButton").click();
  await page.waitForFunction(() => document.querySelector("#meetingTaskLabel")?.textContent.includes("录音已保存"));
  await page.locator("#recordingPlayer:not(.hidden)").waitFor();
  await page.getByText("录音已保存在本机", { exact: true }).waitFor();
  const completedMeetingId = await page.evaluate(() => JSON.parse(localStorage.getItem("yanlan.meetings.v1"))[0].id);
  assert.equal(await recordingChunkCount(page, completedMeetingId), 0);
  assert.equal(await page.locator("#copyButton").isDisabled(), true);
  assert.equal(await page.locator("#shareButton").isDisabled(), true);
  assert.equal(await page.locator("#exportButton").isEnabled(), true);
  await page.locator("#exportButton").click();
  assert.equal(await page.locator('[data-export="markdown"]').isDisabled(), true);
  const recorderDownload = page.waitForEvent("download");
  await page.locator('[data-export="audio"]').click();
  assert.match((await recorderDownload).suggestedFilename(), /\.(webm|ogg|m4a)$/);
  await page.screenshot({ path: fileURLToPath(new URL("../artifacts/recorder-only-desktop.png", import.meta.url)), fullPage: true });
  await page.locator("#newMeetingButton").click();

  await page.locator("#startRecordButton").click();
  await page.locator("#liveRecorder:not(.hidden)").waitFor();
  const interruptedMeetingId = await page.evaluate(() => JSON.parse(localStorage.getItem("yanlan.meetings.v1"))[0].id);
  await page.waitForTimeout(1200);
  await waitForRecordingChunks(page, interruptedMeetingId, 1);
  const recoveryStorageBeforeReload = await recordingStorageState(page, interruptedMeetingId);
  page.once("dialog", (dialog) => dialog.accept());
  await page.reload({ waitUntil: "domcontentloaded" });
  try {
    await page.getByText("录音已保存在本机", { exact: true }).waitFor({ timeout: 60_000 });
  } catch (error) {
    const recoveryState = await page.evaluate(() => ({
      meetings: JSON.parse(localStorage.getItem("yanlan.meetings.v1") || "[]"),
      activeSession: sessionStorage.getItem("yanlan.active-recording.v1"),
      meta: document.querySelector("#meetingMeta")?.textContent,
      task: document.querySelector("#meetingTaskLabel")?.textContent,
      transcript: document.querySelector("#transcriptList")?.textContent,
    }));
    const recoveryStorageAfterReload = await recordingStorageState(page, interruptedMeetingId);
    throw new Error(`Interrupted recording recovery did not finish: ${JSON.stringify({ recoveryState, recoveryStorageBeforeReload, recoveryStorageAfterReload })}; browser errors: ${browserErrors.join(" | ")}`, { cause: error });
  }
  await page.locator("#recordingPlayer:not(.hidden)").waitFor();
  const recovered = await page.evaluate(async (meetingId) => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("yanlan", 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction(["recordings", "recordingChunks"], "readonly");
    const recording = await new Promise((resolve, reject) => {
      const request = transaction.objectStore("recordings").get(meetingId);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const chunks = await new Promise((resolve, reject) => {
      const request = transaction.objectStore("recordingChunks").index("meetingId").count(IDBKeyRange.only(meetingId));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return { size: recording?.blob?.size || 0, chunks };
  }, interruptedMeetingId);
  assert.ok(recovered.size > 0);
  assert.equal(recovered.chunks, 0);
  await page.locator("#newMeetingButton").click();

  await page.evaluate(() => {
    window.__yanlanOriginalIdbPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function failRecordingChunkPut(...args) {
      if (this.name === "recordingChunks") throw new DOMException("simulated quota failure", "QuotaExceededError");
      return window.__yanlanOriginalIdbPut.apply(this, args);
    };
  });
  await page.locator("#startRecordButton").click();
  await page.waitForTimeout(1200);
  await page.locator("#stopRecordButton").click();
  await page.waitForFunction(() => document.querySelector("#meetingTaskLabel")?.textContent.includes("处理失败"));
  await page.locator("#errorMessage").filter({ hasText: /录音分片未能保存到本机/ }).waitFor();
  assert.equal(await page.locator("#retryButton").isEnabled(), true);
  await page.evaluate(() => {
    IDBObjectStore.prototype.put = window.__yanlanOriginalIdbPut;
    delete window.__yanlanOriginalIdbPut;
  });
  await page.locator("#retryButton").click();
  await page.waitForFunction(() => document.querySelector("#meetingTaskLabel")?.textContent.includes("录音已保存"));
  await page.getByText("录音已保存在本机", { exact: true }).waitFor();
  await page.locator("#newMeetingButton").click();

  await page.evaluate(() => {
    window.__yanlanOriginalRecordingPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function failFinalRecordingPut(...args) {
      if (this.name === "recordings") throw new DOMException("simulated final save failure", "QuotaExceededError");
      return window.__yanlanOriginalRecordingPut.apply(this, args);
    };
  });
  await page.locator("#startRecordButton").click();
  await page.waitForTimeout(1200);
  const finalSaveFailureMeetingId = await page.evaluate(() => JSON.parse(localStorage.getItem("yanlan.meetings.v1"))[0].id);
  await page.locator("#stopRecordButton").click();
  await page.waitForFunction(() => document.querySelector("#meetingTaskLabel")?.textContent.includes("处理失败"));
  await page.locator("#errorMessage").filter({ hasText: /simulated final save failure/ }).waitFor();
  assert.equal(await page.locator("#retryButton").isEnabled(), true);
  assert.ok(await recordingChunkCount(page, finalSaveFailureMeetingId) > 0);
  await page.evaluate(() => {
    IDBObjectStore.prototype.put = window.__yanlanOriginalRecordingPut;
    delete window.__yanlanOriginalRecordingPut;
  });
  page.once("dialog", (dialog) => dialog.accept());
  await page.reload({ waitUntil: "domcontentloaded" });
  try {
    await page.getByText("录音已保存在本机", { exact: true }).waitFor({ timeout: 60_000 });
  } catch (error) {
    const recoveryState = await page.evaluate(async (id) => {
      const meeting = JSON.parse(localStorage.getItem("yanlan.meetings.v1") || "[]").find((item) => item.id === id) || {};
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open("yanlan", 2);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const transaction = database.transaction(["recordings", "recordingChunks"], "readonly");
      const recordingRequest = transaction.objectStore("recordings").get(id);
      const chunksRequest = transaction.objectStore("recordingChunks").index("meetingId").getAll(id);
      const [recording, chunks] = await Promise.all([
        new Promise((resolve, reject) => { recordingRequest.onsuccess = () => resolve(recordingRequest.result); recordingRequest.onerror = () => reject(recordingRequest.error); }),
        new Promise((resolve, reject) => { chunksRequest.onsuccess = () => resolve(chunksRequest.result); chunksRequest.onerror = () => reject(chunksRequest.error); }),
      ]);
      database.close();
      return {
        status: meeting.status,
        recoveryPending: meeting.recoveryPending === true,
        hasRecording: meeting.hasRecording === true,
        observedChunks: Number(meeting.recordingObservedChunkCount) || 0,
        committedChunks: Number(meeting.recordingChunkCount) || 0,
        recordingBytes: Number(recording?.blob?.size) || 0,
        storedChunks: chunks.length,
        hasError: Boolean(meeting.error),
      };
    }, finalSaveFailureMeetingId);
    throw new Error(`Final recording recovery did not settle: ${JSON.stringify(recoveryState)}`, { cause: error });
  }
  await page.locator("#recordingPlayer:not(.hidden)").waitFor();
  assert.equal(await recordingChunkCount(page, finalSaveFailureMeetingId), 0);
  await page.locator("#newMeetingButton").click();

  await page.evaluate(() => {
    window.__yanlanOriginalPartialPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function failLaterRecordingChunks(value, ...args) {
      if (this.name === "recordingChunks" && value.index > 0) throw new DOMException("simulated later chunk failure", "QuotaExceededError");
      return window.__yanlanOriginalPartialPut.call(this, value, ...args);
    };
  });
  await page.locator("#startRecordButton").click();
  await page.locator("#liveRecorder:not(.hidden)").waitFor({ timeout: 45_000 });
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("yanlan.meetings.v1") || "[]")[0]?.recordingObservedChunkCount > 1, null, { timeout: 30_000 });
  const partialFailureMeetingId = await page.evaluate(() => JSON.parse(localStorage.getItem("yanlan.meetings.v1"))[0].id);
  await page.locator("#stopRecordButton").click();
  await page.waitForFunction(() => document.querySelector("#meetingTaskLabel")?.textContent.includes("处理失败"));
  const expectedPartialChunks = await page.evaluate(() => JSON.parse(localStorage.getItem("yanlan.meetings.v1"))[0].recordingObservedChunkCount);
  assert.ok(expectedPartialChunks > 1);
  assert.equal(await recordingChunkCount(page, partialFailureMeetingId), 1);
  page.once("dialog", (dialog) => dialog.accept());
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => {
    const meeting = JSON.parse(localStorage.getItem("yanlan.meetings.v1") || "[]")[0];
    return meeting?.status === "error" && String(meeting.error || "").startsWith("录音恢复失败：");
  }, null, { timeout: 30_000 });
  const partialRecovery = await page.evaluate(() => JSON.parse(localStorage.getItem("yanlan.meetings.v1"))[0]);
  assert.match(partialRecovery.error, /录音分片不完整/);
  await page.locator("#errorMessage").filter({ hasText: /录音分片不完整/ }).waitFor({ timeout: 30000 });
  assert.equal(await page.locator("#retryButton").isDisabled(), true);
  assert.equal(await page.locator("#recordingPlayer").isHidden(), true);
  await page.locator("#newMeetingButton").click();

  await page.locator("#settingsButton").click();
  await page.locator("#asrBaseUrlInput").fill("https://mimo.example");
  await page.locator("#asrApiKeyInput").fill("asr-test-key");
  await page.locator("#chatBaseUrlInput").fill("https://gpt.example/v1");
  await page.locator("#chatApiKeyInput").fill("gpt-test-key");
  assert.equal(await page.locator("#chatModelInput").inputValue(), "gpt-5.6-luna");
  assert.equal(await page.locator("#chatProtocolInput").inputValue(), "responses");
  assert.equal(await page.locator("#chatPathInput").inputValue(), "responses");
  assert.equal(await page.locator("#transportModeInput").inputValue(), "direct");
  assert.equal(await page.locator("#relayPathInput").isDisabled(), true);
  await page.locator("#asrBaseUrlInput").fill("https://bad-mimo.example");
  await page.locator("#testAsrButton").click();
  await page.getByText("MiMo API Key 无效或已失效（HTTP 401）", { exact: true }).waitFor();
  const expectedUnauthorized = browserErrors.findIndex((message) => message.includes("401 (Unauthorized)"));
  assert.notEqual(expectedUnauthorized, -1);
  browserErrors.splice(expectedUnauthorized, 1);
  await page.locator("#asrBaseUrlInput").fill("https://mimo.example");
  assert.equal(await page.locator("#asrConnectionResult").textContent(), "");
  asrResponseDelayMs = 1_000;
  await page.locator("#testAsrButton").click();
  assert.equal(await page.evaluate(() => document.activeElement?.id), "testAsrButton");
  await page.waitForFunction(() => document.querySelector("#testAsrButton")?.getAttribute("aria-disabled") === "true");
  await page.getByText("MiMo 连接成功，Base URL、API Key 和模型均可用", { exact: true }).waitFor();
  await page.locator("#testChatButton").click();
  await page.getByText("GPT 连接成功，Base URL、API Key 和模型均可用", { exact: true }).waitFor();
  await page.screenshot({ path: fileURLToPath(new URL("../artifacts/connection-tests-desktop.png", import.meta.url)), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#chatConnectionResult").scrollIntoViewIfNeeded();
  await page.screenshot({ path: fileURLToPath(new URL("../artifacts/connection-tests-mobile.png", import.meta.url)), fullPage: true });
  assert.equal(await page.locator("#settingsDialog").evaluate((element) => element.scrollWidth > element.clientWidth), false);
  await page.setViewportSize({ width: 1440, height: 960 });
  transientAsrFailures = 2;
  page.once("dialog", (dialog) => dialog.accept());
  const keyDownloadPromise = page.waitForEvent("download");
  await page.locator("#exportKeysButton").click();
  const keyDownload = await keyDownloadPromise;
  const keyBackup = JSON.parse(await readFile(await keyDownload.path(), "utf8"));
  assert.equal(keyBackup.schema, "yanlan.api-keys");
  assert.deepEqual(keyBackup.keys, { mimo: "asr-test-key", gpt: "gpt-test-key" });
  assert.equal(keyBackup.asrBaseUrl, undefined);
  await page.locator("#asrApiKeyInput").fill("");
  await page.locator("#chatApiKeyInput").fill("");
  await page.locator("#importKeysInput").setInputFiles(await keyDownload.path());
  await page.getByText("API Key 已填入，请检查后保存设置", { exact: true }).waitFor();
  assert.equal(await page.locator("#asrApiKeyInput").inputValue(), "asr-test-key");
  assert.equal(await page.locator("#chatApiKeyInput").inputValue(), "gpt-test-key");
  await page.screenshot({ path: fileURLToPath(new URL("../artifacts/responses-settings-desktop.png", import.meta.url)), fullPage: true });
  assert.equal(await page.locator("#settingsDialog").evaluate((element) => element.scrollWidth > element.clientWidth), false);
  await page.locator("#chunkSecondsInput").selectOption("5");
  await page.locator("#contextHintInput").fill("项目名：万福来 -> OneFly；负责人：小明；术语：服务降机 -> 服务降级");
  await page.locator("#saveSettingsButton").click();

  const persisted = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
  assert.match(JSON.stringify(persisted.local), /asr-test-key|gpt-test-key/);
  assert.doesNotMatch(JSON.stringify(persisted.session), /asr-test-key|gpt-test-key/);
  const persistedConfig = JSON.parse(persisted.local["yanlan.config.v1"]);
  assert.equal(persistedConfig.asrBaseUrl, "https://mimo.example");
  assert.equal(persistedConfig.asrPath, "v1/chat/completions");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#configModel")?.textContent !== "未配置模型");
  await page.locator("#settingsButton").click();
  assert.equal(await page.locator("#asrApiKeyInput").inputValue(), "asr-test-key");
  assert.equal(await page.locator("#chatApiKeyInput").inputValue(), "gpt-test-key");
  await page.locator("#settingsDialog header .icon-button").click();
  await page.locator("#newMeetingButton").click();

  asrResponseDelayMs = 1_000;
  let releaseUploadCorrection;
  correctionResponseGate = new Promise((resolve) => { releaseUploadCorrection = resolve; });
  const uploadAsrRequest = page.waitForRequest(
    (request) => request.url() === "https://mimo.example/v1/chat/completions" && request.method() === "POST",
    { timeout: 60_000 },
  );
  await page.locator("#fileInput").setInputFiles(fixture);
  await uploadAsrRequest;
  await page.locator('#meetingTaskStatus[data-state="working"]').waitFor();
  assert.match(await page.locator("#meetingTaskLabel").textContent(), /正在准备音频|正在转写音频/);
  assert.equal(await page.locator("#meetingTaskStatus").getAttribute("data-state"), "working");
  assert.equal(await page.locator("#meetingTaskMark").textContent(), "ING");
  assert.equal(await page.locator("#newMeetingButton").isDisabled(), true);
  assert.equal(await page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  }), true);
  await page.waitForFunction(() => document.querySelector("#meetingTaskLabel")?.textContent.includes("Agent 正在校正逐字稿与断句"));
  await page.locator('[data-insight="qa"]').click();
  assert.equal(await page.locator("#questionInput").isDisabled(), true);
  assert.equal(await page.locator("#qaForm button").isDisabled(), true);
  await page.locator('[data-insight="summary"]').click();
  await page.screenshot({ path: fileURLToPath(new URL("../artifacts/task-status-ing-desktop.png", import.meta.url)), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  assert.ok(await page.locator("#sidebar").evaluate((element) => element.getBoundingClientRect().right <= 1));
  assert.equal(await page.locator("#meetingTaskStatus").getAttribute("data-state"), "working");
  const mobileTaskLayout = await page.locator("#meetingTaskStatus").evaluate((element) => {
    const status = element.getBoundingClientRect();
    const topbar = element.closest(".topbar").getBoundingClientRect();
    return { left: status.left, right: status.right, topbarLeft: topbar.left, topbarRight: topbar.right };
  });
  assert.ok(mobileTaskLayout.left >= mobileTaskLayout.topbarLeft && mobileTaskLayout.right <= mobileTaskLayout.topbarRight);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
  await page.screenshot({ path: fileURLToPath(new URL("../artifacts/task-status-ing-mobile.png", import.meta.url)), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 960 });
  releaseUploadCorrection();
  try {
    await page.getByText("OneFly会议纪要", { exact: true }).first().waitFor({ timeout: 60_000 });
  } catch (error) {
    const uploadState = await page.evaluate(() => {
      const meeting = JSON.parse(localStorage.getItem("yanlan.meetings.v1") || "[]")[0] || {};
      return {
        meetingStatus: meeting.status,
        hasRecording: meeting.hasRecording === true,
        rawSegmentCount: Array.isArray(meeting.rawSegments) ? meeting.rawSegments.length : 0,
        segmentCount: Array.isArray(meeting.segments) ? meeting.segments.length : 0,
        correctionFailed: Boolean(meeting.correctionError),
        summaryFailed: Boolean(meeting.summaryError),
        task: document.querySelector("#meetingTaskLabel")?.textContent || "",
      };
    });
    throw new Error(`Uploaded meeting did not finish: ${JSON.stringify({ uploadState, gptRequests, gptResponses })}; browser errors: ${browserErrors.join(" | ")}`, { cause: error });
  }
  await page.locator("#transcriptList").getByText("今天讨论OneFly项目，由小明明天完成。", { exact: true }).waitFor();
  await page.locator("#recordingPlayer:not(.hidden)").waitFor();
  assert.equal(await page.locator("#meetingTaskStatus").getAttribute("data-state"), "done");
  assert.equal(await page.locator("#meetingTaskLabel").textContent(), "已完成");
  assert.equal(await page.locator("#newMeetingButton").isEnabled(), true);
  assert.doesNotMatch(await page.locator("#meetingMeta").textContent(), /已完成|正在/);
  await page.getByText("Luna Agent · 3 轮 · 3 次工具调用", { exact: true }).waitFor();
  await page.getByText("会议解析 Agent · 3 轮 · 2 次工具调用", { exact: true }).waitFor();
  await page.getByText("已统一 1 个术语", { exact: true }).waitFor();
  const correctionLedger = await page.evaluate(() => JSON.parse(localStorage.getItem("yanlan.meetings.v1"))[0].corrections);
  assert.deepEqual(correctionLedger.map(({
    segmentId, start_seconds, from, to, status, reason, start_offset, end_offset,
  }) => ({ segmentId, start_seconds, from, to, status, reason, start_offset, end_offset })), [{
    segmentId: 0,
    start_seconds: 0,
    from: "万福来",
    to: "OneFly",
    status: "accepted",
    reason: "explicit_alias",
    start_offset: 4,
    end_offset: 7,
  }]);
  assert.match(correctionLedger[0].source_hash, /^fnv1a32:[0-9a-f]{8}$/);

  await page.locator('[data-insight="highlights"]').click();
  await page.locator(".highlight-item[data-seek='0']", { hasText: "由小明明天完成" }).waitFor();
  await page.screenshot({ path: fileURLToPath(new URL("../artifacts/meeting-highlights-desktop.png", import.meta.url)), fullPage: true });
  await page.locator('[data-insight="speakers"]').click();
  await page.locator(".speaker-summary-item p").getByText("今天讨论OneFly项目，由小明明天完成。", { exact: true }).waitFor();
  await page.locator('[data-insight="actions"]').click();
  await page.locator(".decision-record strong").getByText("今天讨论OneFly项目，由小明明天完成。", { exact: true }).waitFor();
  await page.locator(".action-task").getByText("今天讨论OneFly项目，由小明明天完成。", { exact: true }).waitFor();
  await page.screenshot({ path: fileURLToPath(new URL("../artifacts/meeting-decisions-desktop.png", import.meta.url)), fullPage: true });

  await page.locator('[data-insight="qa"]').click();
  await page.locator("#questionInput").fill("谁负责项目，什么时候完成？");
  await page.locator("#qaForm button").click();
  await page.getByText(/小明负责在明天完成/).waitFor();

  await page.locator("#exportButton").click();
  const markdownDownload = page.waitForEvent("download");
  await page.locator('[data-export="markdown"]').click();
  assert.match((await markdownDownload).suggestedFilename(), /\.md$/);

  await page.locator("#exportButton").click();
  const audioDownload = page.waitForEvent("download");
  await page.locator('[data-export="audio"]').click();
  assert.match((await audioDownload).suggestedFilename(), /\.wav$/);

  await page.locator("#shareButton").click();
  await page.locator("#shareUrlInput").waitFor();
  await page.waitForFunction(() => document.querySelector("#shareUrlInput").value.startsWith("http"));
  const shareUrl = await page.locator("#shareUrlInput").inputValue();
  assert.match(shareUrl, /#share=g\./);
  const meetingPublic = await page.evaluate(async (url) => {
    const encoded = new URLSearchParams(new URL(url).hash.slice(1)).get("share");
    const prefix = encoded.slice(0, 2);
    const value = encoded.slice(2).replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(value.padEnd(Math.ceil(value.length / 4) * 4, "=")), (char) => char.charCodeAt(0));
    const output = prefix === "g." ? new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer()) : bytes;
    return JSON.parse(new TextDecoder().decode(output));
  }, shareUrl);
  assert.equal(meetingPublic.schema, 4);
  assert.equal(meetingPublic.highlights[0].quote, "今天讨论OneFly项目，由小明明天完成。");
  assert.equal(meetingPublic.speaker_summaries[0].speaker, "发言人 1");
  assert.equal(meetingPublic.speaker_summaries[0].evidence[0].quote, "今天讨论OneFly项目，由小明明天完成。");
  assert.equal(meetingPublic.decision_records[0].start_seconds, 0);
  assert.equal(meetingPublic.decision_records[0].evidence, "今天讨论OneFly项目，由小明明天完成。");
  assert.equal(meetingPublic.action_items[0].task, "今天讨论OneFly项目，由小明明天完成。");
  assert.equal(meetingPublic.action_items[0].evidence, "今天讨论OneFly项目，由小明明天完成。");
  await page.keyboard.press("Escape");

  await page.locator('[data-insight="summary"]').click();
  await page.locator("#toast").evaluate((element) => { element.className = "toast"; });
  await page.waitForTimeout(200);
  await page.screenshot({ path: fileURLToPath(new URL("../artifacts/desktop.png", import.meta.url)), fullPage: true });
  const desktopOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  assert.equal(desktopOverflow, false);

  await page.locator("#newMeetingButton").click();
  transientCorrectionFailures = 3;
  transientSummaryFailures = 3;
  await page.locator("#fileInput").setInputFiles(fixture);
  const retryCorrection = page.locator('[data-retry-insight="correction"]');
  const retrySummary = page.locator('[data-retry-insight="summary"]');
  try {
    await retryCorrection.waitFor({ timeout: 60_000 });
  } catch (error) {
    const retryState = await page.evaluate(() => {
      const meeting = JSON.parse(localStorage.getItem("yanlan.meetings.v1") || "[]")[0] || {};
      return {
        meetingStatus: meeting.status,
        hasRecording: meeting.hasRecording === true,
        correctionFailed: Boolean(meeting.correctionError),
        summaryFailed: Boolean(meeting.summaryError),
        correctionAgentStatus: meeting.agentRun?.status || "",
        analysisAgentStatus: meeting.analysisRun?.status || "",
        task: document.querySelector("#meetingTaskLabel")?.textContent || "",
      };
    });
    throw new Error(`Retry controls did not appear: ${JSON.stringify({ retryState, correctionRequestCount, summaryRequestCount })}`, { cause: error });
  }
  await retrySummary.waitFor({ timeout: 60_000 });
  assert.equal(await page.locator("#meetingTaskStatus").getAttribute("data-state"), "warning");
  assert.equal(await page.locator("#meetingTaskLabel").textContent(), "部分 Agent 任务待重试");
  assert.equal(await retryCorrection.getAttribute("aria-label"), "重试逐字稿校正");
  assert.equal(await retrySummary.getAttribute("aria-label"), "重试生成智能纪要");
  await page.getByText("本次未生成关键词；摘要与关键词将随智能纪要一并重新生成", { exact: true }).waitFor();
  assert.equal(await page.getByText("无关键词", { exact: true }).count(), 0);
  await page.screenshot({ path: fileURLToPath(new URL("../artifacts/insight-retry-desktop.png", import.meta.url)), fullPage: true });
  await page.evaluate(() => {
    const meetings = JSON.parse(localStorage.getItem("yanlan.meetings.v1") || "[]");
    meetings[0].summary = "上一次成功生成的摘要";
    meetings[0].keywords = ["旧关键词"];
    localStorage.setItem("yanlan.meetings.v1", JSON.stringify(meetings));
  });
  await page.reload({ waitUntil: "networkidle" });
  await retrySummary.waitFor();
  await page.locator('[data-insight="qa"]').click();
  questionResponseDelayMs = 1_000;
  await page.locator("#questionInput").fill("摘要重试前谁负责项目？");
  await page.locator("#qaForm button").click();
  await page.locator(".qa-message.user").getByText("摘要重试前谁负责项目？", { exact: true }).waitFor();
  await page.locator('[data-insight="summary"]').click();
  const asrRequestsBeforeRetries = asrRequestCount;
  const summariesBeforeRetry = summaryRequestCount;
  const summarySnapshotBeforeRetry = await page.evaluate(() => JSON.parse(localStorage.getItem("yanlan.meetings.v1"))[0]);
  summaryResponseDelayMs = 800;
  await retrySummary.click();
  await page.waitForFunction(() => document.querySelector('[data-retry-insight="summary"]')?.getAttribute("aria-busy") === "true");
  assert.equal(await page.locator(".history-item.active .history-delete").isDisabled(), true);
  const persistedDuringSummaryRetry = await page.evaluate(() => JSON.parse(localStorage.getItem("yanlan.meetings.v1"))[0]);
  assert.equal(persistedDuringSummaryRetry.summary, summarySnapshotBeforeRetry.summary);
  assert.deepEqual(persistedDuringSummaryRetry.keywords, summarySnapshotBeforeRetry.keywords);
  assert.deepEqual(persistedDuringSummaryRetry.qa, []);
  await page.getByText("[00:00] 发言人 1：今天讨论万福来项目，由小明明天完成。", { exact: true }).waitFor();
  assert.equal(summaryRequestCount, summariesBeforeRetry + 2);
  assert.equal(asrRequestCount, asrRequestsBeforeRetries);
  assert.equal(await page.locator('[data-retry-insight="summary"]').count(), 0);
  await page.locator('[data-insight="qa"]').click();
  assert.equal(await page.locator(".qa-message.user").getByText("摘要重试前谁负责项目？", { exact: true }).count(), 0);
  assert.equal(await page.locator("#questionInput").isDisabled(), false);
  questionResponseDelayMs = 1_000;
  await page.locator("#questionInput").fill("重试前的逐字稿里谁负责项目？");
  await page.locator("#qaForm button").click();
  await page.locator(".qa-message.user").getByText("重试前的逐字稿里谁负责项目？", { exact: true }).waitFor();
  assert.equal(await page.locator("#questionInput").isDisabled(), true);
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("yanlan.meetings.v1"))[0].qa), []);
  await page.locator('[data-insight="summary"]').click();
  const correctionsBeforeRetry = correctionRequestCount;
  const summariesBeforeCorrection = summaryRequestCount;
  const completeMeetingBeforeCorrection = await page.evaluate(() => JSON.parse(localStorage.getItem("yanlan.meetings.v1"))[0]);
  correctionResponseDelayMs = 500;
  summaryResponseDelayMs = 1_000;
  const downstreamSummaryRequest = page.waitForRequest((request) => request.url() === "https://gpt.example/v1/responses"
    && String(request.postDataJSON()?.instructions || "").includes("会议纪要助手"));
  await retryCorrection.focus();
  await retryCorrection.click();
  await page.waitForFunction(() => document.querySelector('[data-retry-insight="correction"]')?.getAttribute("aria-busy") === "true");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-retry-insight")), "correction");
  assert.equal(await page.locator("#meetingTaskStatus").getAttribute("data-state"), "working");
  assert.equal(await page.locator("#meetingTaskMark").textContent(), "ING");
  assert.equal(await page.locator("#meetingTaskLabel").textContent(), "Agent 正在重新校正逐字稿");
  assert.equal(await page.locator("#newMeetingButton").isDisabled(), true);
  assert.equal(await page.locator("#meetingTitle").isEditable(), false);
  await page.locator('[data-retry-insight="correction"]').dispatchEvent("click");
  await page.locator('[data-insight="qa"]').click();
  assert.equal(await page.locator("#questionInput").isDisabled(), true);
  assert.equal(await page.locator("#qaForm button").isDisabled(), true);
  await downstreamSummaryRequest;
  const persistedDuringCorrection = await page.evaluate(() => JSON.parse(localStorage.getItem("yanlan.meetings.v1"))[0]);
  assert.deepEqual(persistedDuringCorrection.segments, completeMeetingBeforeCorrection.segments);
  assert.equal(persistedDuringCorrection.summary, completeMeetingBeforeCorrection.summary);
  assert.equal(persistedDuringCorrection.correctionError, completeMeetingBeforeCorrection.correctionError);
  assert.deepEqual(persistedDuringCorrection.qa, []);
  await page.waitForFunction(() => {
    const meeting = JSON.parse(localStorage.getItem("yanlan.meetings.v1") || "[]")[0];
    return meeting?.correctionError === ""
      && meeting?.summaryError === ""
      && meeting?.segments?.some((segment) => segment.text.includes("OneFly"))
      && !meeting?.asking;
  }, null, { timeout: 60_000 });
  await page.locator('[data-insight="summary"]').click();
  await page.getByText("已统一 1 个术语", { exact: true }).waitFor();
  assert.equal(correctionRequestCount, correctionsBeforeRetry + 1);
  assert.equal(summaryRequestCount, summariesBeforeCorrection + 3);
  assert.equal(asrRequestCount, asrRequestsBeforeRetries);
  assert.equal(await page.locator('[data-retry-insight="correction"]').count(), 0);
  const retriedMeeting = await page.evaluate(() => JSON.parse(localStorage.getItem("yanlan.meetings.v1"))[0]);
  assert.equal(retriedMeeting.correctionError, "");
  assert.equal(retriedMeeting.summaryError, "");
  assert.deepEqual(retriedMeeting.keywords, ["OneFly"]);
  assert.deepEqual(retriedMeeting.qa, []);
  assert.equal(await page.locator("#meetingTaskStatus").getAttribute("data-state"), "done");

  const mobile = await context.newPage();
  await mobile.setViewportSize({ width: 390, height: 844 });
  await mobile.goto(shareUrl, { waitUntil: "networkidle" });
  await mobile.getByText("这是只读分享稿，不包含原始录音与 API 配置").waitFor();
  assert.equal(await mobile.locator("[data-retry-insight]").count(), 0);
  await mobile.locator("#insightsButton").click();
  await mobile.waitForTimeout(250);
  await mobile.screenshot({ path: fileURLToPath(new URL("../artifacts/mobile-share.png", import.meta.url)), fullPage: true });
  const mobileOverflow = await mobile.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  assert.equal(mobileOverflow, false);
  await mobile.close();

  const semanticContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const semanticPage = await semanticContext.newPage();
  await semanticPage.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await semanticPage.evaluate(() => {
    localStorage.setItem("yanlan.meetings.v1", JSON.stringify([{
      id: "semantic-fixture",
      title: "会议记录 08-01_01-29",
      createdAt: "2026-08-01T01:29:00.000Z",
      duration: 53,
      status: "done",
      mode: "meeting",
      semanticJoins: 4,
      terminology: [],
      segments: [
        { start_seconds: 0, end_seconds: 10, speaker: "发言人 1", text: "赵丽蓉是一个非常漂亮、非常美丽的研究生宝宝，她是", join_next: true },
        { start_seconds: 10, end_seconds: 20, speaker: "发言人 1", text: "合肥工业大学物流和工程与管理的研究生，他现在", join_next: true },
        { start_seconds: 20, end_seconds: 30, speaker: "发言人 1", text: "正在找工作，投递了拼多多和百度的管培生，他一定会找到", join_next: true },
        { start_seconds: 30, end_seconds: 40, speaker: "发言人 1", text: "非常好的工作的，孩子一定能考上公务员。我们敬请期待他的", join_next: true },
        { start_seconds: 40, end_seconds: 50, speaker: "发言人 1", text: "的收获吧。\n这个断句不太好，是不是？对。" },
        { start_seconds: 50, end_seconds: 53, speaker: "发言人 1", text: "你发现没有花的。" },
      ],
    }]));
  });
  await semanticPage.reload({ waitUntil: "networkidle" });
  await semanticPage.locator(".transcript-segment").first().waitFor();
  assert.equal(await semanticPage.locator(".transcript-segment").count(), 2);
  assert.deepEqual(await semanticPage.locator(".segment-time").allTextContents(), ["00:00", "00:50"]);
  await semanticPage.getByText(/她是合肥工业大学物流和工程与管理的研究生/).waitFor();
  await semanticPage.getByText("优化 4 处断句", { exact: true }).waitFor();
  assert.equal(await semanticPage.locator(".segment-text").first().evaluate((element) => getComputedStyle(element).whiteSpace), "pre-line");
  assert.equal(await semanticPage.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
  await semanticPage.screenshot({ path: fileURLToPath(new URL("../artifacts/semantic-transcript-desktop.png", import.meta.url)), fullPage: true });
  await semanticContext.close();

  await page.locator("#newMeetingButton").click();
  await page.locator("#startRecordButton").click();
  await page.locator("#liveRecorder:not(.hidden)").waitFor();
  await page.waitForTimeout(1200);
  await page.locator("#stopRecordButton").click();
  await page.waitForFunction(() => document.querySelector("#meetingTaskLabel")?.textContent.includes("已完成"), null, { timeout: 60_000 });
  await page.locator("#recordingPlayer:not(.hidden)").waitFor();

  await page.locator("#newMeetingButton").click();
  successfulAsrResponsesRemaining = 0;
  await page.locator("#startRecordButton").click();
  await page.locator("#liveRecorder:not(.hidden)").waitFor();
  await page.waitForTimeout(5600);
  await page.locator("#stopRecordButton").click();
  try {
    await page.waitForFunction(() => document.querySelector("#meetingTaskLabel")?.textContent.includes("处理失败"), null, { timeout: 45_000 });
  } catch (error) {
    const failedRecordingState = await page.evaluate(() => {
      const meeting = JSON.parse(localStorage.getItem("yanlan.meetings.v1") || "[]")[0] || {};
      return {
        task: document.querySelector("#meetingTaskLabel")?.textContent,
        taskState: document.querySelector("#meetingTaskStatus")?.dataset.state,
        liveStatus: document.querySelector("#liveStatus")?.textContent,
        recorderVisible: !document.querySelector("#liveRecorder")?.classList.contains("hidden"),
        meetingStatus: meeting.status,
        hasRecording: meeting.hasRecording === true,
        transcriptIncomplete: meeting.transcriptIncomplete === true,
        rawSegmentCount: Array.isArray(meeting.rawSegments) ? meeting.rawSegments.length : 0,
        segmentCount: Array.isArray(meeting.segments) ? meeting.segments.length : 0,
      };
    });
    throw new Error(`Failed recording did not settle: ${JSON.stringify({ failedRecordingState, asrRequestCount, correctionRequestCount, summaryRequestCount })}`, { cause: error });
  }
  assert.match(await page.locator("#errorMessage").textContent(), /temporary ASR failure|HTTP 503|服务暂时不可用/);
  assert.equal(await page.locator("#shareButton").isDisabled(), true);
  assert.equal(await page.locator("#copyButton").isDisabled(), true);
  assert.equal(await page.locator("#transcriptList").isHidden(), true);
  await page.locator("#exportButton").click();
  assert.equal(await page.locator('[data-export="markdown"]').isDisabled(), true);
  assert.equal(await page.locator('[data-export="audio"]').isEnabled(), true);
  successfulAsrResponsesRemaining = Number.POSITIVE_INFINITY;
  await page.locator("#retryButton").click();
  await page.waitForFunction(() => document.querySelector("#meetingTaskLabel")?.textContent.includes("已完成"), null, { timeout: 45_000 });

  await page.locator("#newMeetingButton").click();
  asrTranscript = {
    text: "我会先做服务降机。再通过日志和指标定位故障。",
    segments: [
      { start_seconds: 0, end_seconds: 0.11, speaker: "候选人", text: "我会先做服务降机。" },
      { start_seconds: 0.11, end_seconds: 0.22, speaker: "候选人", text: "再通过日志和指标定位故障。" },
    ],
  };
  await page.locator('[data-record-mode="interview"]').click();
  assert.equal(await page.locator("#recorderHeading").textContent(), "开始一场面试记录");
  await page.locator("#uploadButton").click();
  await page.locator("#candidateAliasInput").fill("候选人 A");
  await page.locator("#interviewRoleInput").fill("平台工程师");
  await page.locator("#interviewStageInput").selectOption({ label: "技术一面" });
  await page.locator("#interviewerInput").fill("内部面试官");
  await page.locator("#competenciesInput").fill("系统设计、故障排查、协作沟通");
  await page.locator("#jobDescriptionInput").fill("内部 JD：负责核心平台可靠性与服务降级");
  await page.locator("#interviewConsentInput").check();
  const fileChooserPromise = page.waitForEvent("filechooser");
  await page.locator("#interviewContinueButton").click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles(fixture);
  await page.getByText("证据复核", { exact: true }).waitFor({ timeout: 60_000 });
  assert.equal(await page.locator('[data-insight="summary"]').textContent(), "复核");
  assert.equal(await page.locator('[data-insight="actions"]').textContent(), "证据");
  assert.equal(await page.locator('[data-insight="qa"]').textContent(), "追问");
  assert.equal(await page.locator('[data-insight="highlights"]').isHidden(), true);
  assert.equal(await page.locator('[data-insight="speakers"]').isHidden(), true);
  await page.locator(".interview-disclaimer").waitFor();
  await page.getByText("证据覆盖", { exact: true }).waitFor();
  await page.getByText("系统设计：1 条逐字稿原话，需核对说话人并人工判断", { exact: true }).waitFor();

  await page.locator('[data-insight="actions"]').click();
  await page.getByText("故障排查", { exact: true }).waitFor();
  await page.locator(".evidence-item", { hasText: "通过日志和指标定位故障" }).last().waitFor();
  assert.equal(await page.locator(".evidence-item").first().getAttribute("data-seek"), "0");
  assert.equal(await page.getByText("有待确认", { exact: true }).count(), 2);

  await page.locator("#shareButton").click();
  await page.waitForFunction(() => document.querySelector("#shareUrlInput").value.startsWith("http"));
  const interviewShareUrl = await page.locator("#shareUrlInput").inputValue();
  const decodedPublic = await page.evaluate(async (url) => {
    const encoded = new URLSearchParams(new URL(url).hash.slice(1)).get("share");
    const prefix = encoded.slice(0, 2);
    const value = encoded.slice(2).replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(value.padEnd(Math.ceil(value.length / 4) * 4, "=")), (char) => char.charCodeAt(0));
    const output = prefix === "g." ? new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer()) : bytes;
    return JSON.parse(new TextDecoder().decode(output));
  }, interviewShareUrl);
  assert.equal(decodedPublic.interviewContext.role, "平台工程师");
  assert.equal(decodedPublic.interviewReport.recommendation, "follow_up");
  assert.doesNotMatch(JSON.stringify(decodedPublic), /内部 JD|内部面试官/);
  const offlineInterview = await context.newPage();
  const offlineErrors = [];
  offlineInterview.on("pageerror", (error) => offlineErrors.push(error.message));
  await offlineInterview.setContent(buildShareHtml(decodedPublic), { waitUntil: "domcontentloaded" });
  await offlineInterview.getByText("证据复核", { exact: true }).waitFor();
  assert.equal(await offlineInterview.getByText(/置信度/).count(), 0);
  assert.deepEqual(offlineErrors, []);
  await offlineInterview.close();
  await page.keyboard.press("Escape");
  await page.locator('[data-insight="summary"]').click();
  await page.locator("#toast").evaluate((element) => { element.className = "toast"; });
  await page.screenshot({ path: fileURLToPath(new URL("../artifacts/interview-desktop.png", import.meta.url)), fullPage: true });

  const interviewMobile = await context.newPage();
  await interviewMobile.setViewportSize({ width: 390, height: 844 });
  await interviewMobile.goto(interviewShareUrl, { waitUntil: "networkidle" });
  await interviewMobile.locator("#insightsButton").click();
  await interviewMobile.waitForTimeout(250);
  await interviewMobile.getByText("证据复核", { exact: true }).waitFor();
  await interviewMobile.locator(".interview-disclaimer").waitFor();
  await interviewMobile.screenshot({ path: fileURLToPath(new URL("../artifacts/interview-mobile-share.png", import.meta.url)), fullPage: true });
  assert.equal(await interviewMobile.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
  await interviewMobile.close();

  const deletingMeetingId = await page.evaluate(() => {
    const meetings = JSON.parse(localStorage.getItem("yanlan.meetings.v1") || "[]");
    meetings[0].summaryError = "删除竞态测试：智能纪要待重试";
    localStorage.setItem("yanlan.meetings.v1", JSON.stringify(meetings));
    return meetings[0].id;
  });
  await page.reload({ waitUntil: "networkidle" });
  const staleMeetingPage = await context.newPage();
  await staleMeetingPage.addInitScript(() => {
    window.addEventListener("storage", (event) => {
      if (event.key === "yanlan.meetings.v1" || event.key?.startsWith("yanlan.meeting.deleted.v1.")) {
        event.stopImmediatePropagation();
      }
    }, true);
  });
  await staleMeetingPage.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await staleMeetingPage.locator(`.history-item[data-meeting-id="${deletingMeetingId}"]`).waitFor();
  await page.locator('[data-insight="qa"]').click();
  questionResponseDelayMs = 1_500;
  await page.locator("#questionInput").fill("删除期间不应继续发送的问题");
  await page.locator("#qaForm button").click();
  await page.getByText("删除期间不应继续发送的问题", { exact: true }).waitFor();
  const questionsAtDelete = questionRequestCount;
  const summariesAtDelete = summaryRequestCount;
  await page.evaluate(() => {
    const original = Response.prototype.arrayBuffer;
    let releaseGate;
    const gate = new Promise((resolve) => { releaseGate = resolve; });
    let delayNext = true;
    window.__releaseYanlanShareCompression = releaseGate;
    window.__restoreYanlanResponseArrayBuffer = () => { Response.prototype.arrayBuffer = original; };
    Response.prototype.arrayBuffer = async function delayedShareArrayBuffer() {
      const delayed = delayNext;
      if (delayed) {
        delayNext = false;
        window.__yanlanShareCompressionBlocked = true;
        await gate;
      }
      const result = await original.apply(this, arguments);
      if (delayed) window.__yanlanShareCompressionDone = true;
      return result;
    };
  });
  await page.locator("#shareButton").click();
  await page.waitForFunction(() => window.__yanlanShareCompressionBlocked === true);
  assert.equal(await page.locator("#shareUrlInput").inputValue(), "正在生成…");
  await page.evaluate(() => {
    const original = IDBDatabase.prototype.transaction;
    window.__restoreYanlanTransaction = () => { IDBDatabase.prototype.transaction = original; };
    let holdNextDelete = true;
    IDBDatabase.prototype.transaction = function transactionWithDeleteHold(storeNames, mode) {
      const transaction = original.apply(this, arguments);
      const names = typeof storeNames === "string" ? [storeNames] : [...storeNames];
      if (holdNextDelete && mode === "readwrite" && names.includes("recordings") && names.includes("recordingChunks")) {
        holdNextDelete = false;
        const deadline = performance.now() + 2_500;
        const keepAlive = () => {
          if (performance.now() >= deadline) return;
          let request;
          try { request = transaction.objectStore("recordings").get("__yanlan_delete_hold__"); }
          catch { return; }
          request.onsuccess = keepAlive;
          request.onerror = keepAlive;
        };
        keepAlive();
      }
      return transaction;
    };
  });
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator(".history-item.active .history-delete").dispatchEvent("click");
  await page.getByText("正在删除记录", { exact: true }).waitFor();
  await page.waitForTimeout(150);
  assert.equal(await page.locator("#shareDialog").evaluate((element) => element.open), false);
  assert.equal(await page.locator("#shareUrlInput").inputValue(), "");
  assert.equal(await page.locator("#shareHint").textContent(), "");
  assert.equal(await page.locator(".history-item.active .history-delete").isDisabled(), true);
  assert.equal(await page.locator("#newMeetingButton").isDisabled(), true);
  assert.equal(await page.locator("#meetingTitle").isEditable(), false);
  assert.equal(await page.locator("#questionInput").isDisabled(), true);
  await page.evaluate(() => {
    const input = document.querySelector("#questionInput");
    input.disabled = false;
    input.value = "强制提交也必须被删除锁拒绝";
    document.querySelector("#qaForm").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await page.locator('[data-insight="summary"]').click();
  const deleteLockedRetry = page.locator('[data-retry-insight="summary"]');
  assert.equal(await deleteLockedRetry.getAttribute("aria-disabled"), "true");
  await deleteLockedRetry.dispatchEvent("click");
  await page.waitForTimeout(100);
  assert.equal(questionRequestCount, questionsAtDelete);
  assert.equal(summaryRequestCount, summariesAtDelete);
  await page.evaluate(() => window.__releaseYanlanShareCompression?.());
  await page.waitForFunction(() => window.__yanlanShareCompressionDone === true);
  await page.waitForTimeout(100);
  assert.equal(await page.locator("#shareDialog").evaluate((element) => element.open), false);
  assert.equal(await page.locator("#shareUrlInput").inputValue(), "");
  assert.equal(await page.locator("#shareHint").textContent(), "");
  await page.evaluate(() => window.__restoreYanlanResponseArrayBuffer?.());
  await page.waitForFunction((id) => !JSON.parse(localStorage.getItem("yanlan.meetings.v1") || "[]").some((meeting) => meeting.id === id), deletingMeetingId);
  await page.locator(`.history-item[data-meeting-id="${deletingMeetingId}"]`).waitFor({ state: "detached" });
  const deletedStorage = await recordingStorageState(page, deletingMeetingId);
  assert.equal(deletedStorage.recordingSize, 0);
  assert.deepEqual(deletedStorage.chunks, []);
  await page.evaluate(() => window.__restoreYanlanTransaction?.());
  assert.equal(await staleMeetingPage.locator(`.history-item[data-meeting-id="${deletingMeetingId}"]`).count(), 1);
  await staleMeetingPage.locator("#meetingTitle").fill("休眠标签页的陈旧标题");
  await staleMeetingPage.waitForFunction((id) => (
    !JSON.parse(localStorage.getItem("yanlan.meetings.v1") || "[]").some((meeting) => meeting.id === id)
    && localStorage.getItem(`yanlan.meeting.deleted.v1.${id}`) !== null
  ), deletingMeetingId);
  await staleMeetingPage.locator(`.history-item[data-meeting-id="${deletingMeetingId}"]`).waitFor({ state: "detached" });
  await staleMeetingPage.reload({ waitUntil: "domcontentloaded" });
  assert.equal(await staleMeetingPage.locator(`.history-item[data-meeting-id="${deletingMeetingId}"]`).count(), 0);
  await staleMeetingPage.close();

  await verifyRetryReadDeletionRace(browser, baseUrl, fixture);
  await verifyRecoveryDeletionRace(browser, baseUrl, fixture);
  await verifyCompletedTombstoneStartupCleanup(browser, baseUrl, fixture);

  const legacy = await context.newPage();
  await legacy.setViewportSize({ width: 390, height: 844 });
  await legacy.addInitScript(() => localStorage.setItem("yanlan.config.v1", JSON.stringify({
    asrBaseUrl: "https://api.xiaomimimo.com/v1", asrProtocol: "openai-transcriptions", asrPath: "audio/transcriptions",
    chatModel: "gpt-4o-mini", chatPath: "chat/completions",
  })));
  await legacy.goto(baseUrl, { waitUntil: "networkidle" });
  await legacy.locator("#sidebarOpen").click();
  await legacy.locator("#openSettingsButton").click();
  await legacy.screenshot({ path: fileURLToPath(new URL("../artifacts/recommended-providers-mobile.png", import.meta.url)), fullPage: true });
  assert.equal(await legacy.locator("#chatModelInput").inputValue(), "gpt-4o-mini");
  assert.equal(await legacy.locator("#chatProtocolInput").inputValue(), "chat-completions");
  assert.equal(await legacy.locator("#chatPathInput").inputValue(), "chat/completions");
  assert.equal(await legacy.locator("#asrBaseUrlInput").inputValue(), "https://api.xiaomimimo.com");
  const migratedAsr = await legacy.evaluate(() => JSON.parse(localStorage.getItem("yanlan.config.v1")));
  assert.equal(migratedAsr.asrProtocol, "mimo-chat");
  assert.equal(migratedAsr.asrPath, "v1/chat/completions");
  await legacy.locator("#mimoHelpButton").scrollIntoViewIfNeeded();
  await legacy.locator("#mimoHelpButton").click();
  await legacy.locator("#mimoHelpDialog").waitFor();
  assert.equal(await legacy.locator("#mimoHelpDialog").evaluate((element) => element.scrollWidth > element.clientWidth), false);
  await legacy.screenshot({ path: fileURLToPath(new URL("../artifacts/mimo-help-mobile.png", import.meta.url)), fullPage: true });
  await legacy.locator('#mimoHelpDialog [value="default"]').click();
  await legacy.locator("#chatProtocolInput").scrollIntoViewIfNeeded();
  await legacy.screenshot({ path: fileURLToPath(new URL("../artifacts/responses-settings-mobile.png", import.meta.url)), fullPage: true });
  assert.equal(await legacy.locator("#settingsDialog").evaluate((element) => element.scrollWidth > element.clientWidth), false);
  const keyActionLayout = await legacy.locator(".settings-key-actions").evaluate((element) => {
    const [importButton, exportButton, clearButton] = [...element.children].map((button) => button.getBoundingClientRect());
    return { display: getComputedStyle(element).display, importTop: importButton.top, exportTop: exportButton.top, importBottom: importButton.bottom, clearTop: clearButton.top };
  });
  assert.equal(keyActionLayout.display, "grid");
  assert.equal(keyActionLayout.importTop, keyActionLayout.exportTop);
  assert.ok(keyActionLayout.clearTop > keyActionLayout.importBottom);
  await legacy.close();

  const migrationContext = await browser.newContext();
  const migrationPage = await migrationContext.newPage();
  await migrationPage.addInitScript(() => {
    sessionStorage.setItem("yanlan.asr-key.v1", "legacy-asr-key");
    sessionStorage.setItem("yanlan.chat-key.v1", "legacy-chat-key");
  });
  await migrationPage.goto(baseUrl, { waitUntil: "networkidle" });
  await migrationPage.waitForFunction(() => {
    const config = JSON.parse(localStorage.getItem("yanlan.config.v1") || "{}");
    return config.asrApiKey === "legacy-asr-key" && config.chatApiKey === "legacy-chat-key";
  });
  const migrated = await migrationPage.evaluate(() => ({
    config: JSON.parse(localStorage.getItem("yanlan.config.v1") || "{}"),
    legacyAsr: sessionStorage.getItem("yanlan.asr-key.v1"),
    legacyChat: sessionStorage.getItem("yanlan.chat-key.v1"),
  }));
  assert.equal(migrated.config.asrApiKey, "legacy-asr-key");
  assert.equal(migrated.config.chatApiKey, "legacy-chat-key");
  assert.equal(migrated.legacyAsr, null);
  assert.equal(migrated.legacyChat, null);
  await migrationContext.close();

  await page.locator("#settingsButton").click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#clearKeysButton").click();
  assert.equal(await page.locator("#asrApiKeyInput").inputValue(), "");
  assert.equal(await page.locator("#chatApiKeyInput").inputValue(), "");
  const cleared = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
  assert.doesNotMatch(JSON.stringify(cleared), /asr-test-key|gpt-test-key/);
  assert.doesNotMatch(JSON.stringify(cleared.session), /asr-test-key|gpt-test-key/);
  await page.locator("#settingsDialog header .icon-button").click();

  assert.ok(browserErrors.some((message) => /status of 503/.test(message)));
  assert.deepEqual(browserErrors.filter((message) => !/Failed to load resource: the server responded with a status of 503/.test(message)), []);
  console.log("Browser flow passed: connection tests, key JSON backup, semantic Chinese segmentation, crash recovery, ASR retries, meeting/interview workflows, cross-tab deletion tombstones, sharing, and responsive layout.");
} finally {
  await browser.close();
  await developmentServer?.close();
}

async function verifyRetryReadDeletionRace(browserHandle, appUrl, audioFixture) {
  const raceContext = await browserHandle.newContext({ viewport: { width: 1280, height: 800 } });
  raceContext.setDefaultTimeout(90_000);
  raceContext.setDefaultNavigationTimeout(180_000);
  const seedPage = await raceContext.newPage();
  const meetingId = "retry-read-delete-race";
  const meeting = raceMeeting(meetingId, { status: "error", hasRecording: true, error: "转写待重试" });
  await seedRaceStorage(seedPage, appUrl, {
    meetings: [meeting],
    recording: { id: meetingId, base64: audioFixture.buffer.toString("base64"), mimeType: audioFixture.mimeType, fileName: audioFixture.name },
  });
  await seedPage.close();

  const pageHandle = await raceContext.newPage();
  let asrRequests = 0;
  await pageHandle.route("https://mimo.example/v1/chat/completions", async (route) => {
    asrRequests += 1;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ choices: [{ message: { content: "不应上传" } }] }) });
  });
  await pageHandle.goto(appUrl, { waitUntil: "domcontentloaded" });
  await pageHandle.locator(`.history-item[data-meeting-id="${meetingId}"]`).waitFor();
  await pageHandle.waitForFunction((id) => document.querySelector("#audioPlayer")?.dataset.meetingId === id, meetingId);
  await installIdbReadGate(pageHandle, "recordings", "__yanlanRetryReadBlocked", "__releaseYanlanRetryRead");
  await pageHandle.evaluate(() => {
    window.__yanlanConfirmCalls = 0;
    window.confirm = () => { window.__yanlanConfirmCalls += 1; return true; };
  });

  await pageHandle.locator("#retryButton").click();
  await pageHandle.waitForFunction(() => window.__yanlanRetryReadBlocked === true);
  await pageHandle.waitForFunction((id) => (
    JSON.parse(localStorage.getItem("yanlan.meetings.v1") || "[]").find((meetingItem) => meetingItem.id === id)?.status === "transcribing"
  ), meetingId);
  assert.equal(await pageHandle.locator(`.history-item[data-meeting-id="${meetingId}"] .history-delete`).isDisabled(), true);
  await pageHandle.locator(`.history-item[data-meeting-id="${meetingId}"] .history-delete`).dispatchEvent("click");
  assert.equal(await pageHandle.evaluate(() => window.__yanlanConfirmCalls), 0);

  const helperPage = await raceContext.newPage();
  await helperPage.goto(`${appUrl}/yanlan-logo.png`, { waitUntil: "load" });
  await queueCrossTabDeletion(helperPage, meetingId);
  await pageHandle.locator(`.history-item[data-meeting-id="${meetingId}"]`).waitFor({ state: "detached" });
  await pageHandle.evaluate(() => window.__releaseYanlanRetryRead?.());
  await helperPage.evaluate(() => window.__yanlanQueuedDelete);
  await waitForRecordingDeleted(pageHandle, meetingId);
  assert.equal(asrRequests, 0);
  assert.equal(await pageHandle.evaluate((id) => (
    JSON.parse(localStorage.getItem("yanlan.meetings.v1") || "[]").some((meetingItem) => meetingItem.id === id)
  ), meetingId), false);
  await raceContext.close();
}

async function verifyRecoveryDeletionRace(browserHandle, appUrl, audioFixture) {
  const raceContext = await browserHandle.newContext({ viewport: { width: 1280, height: 800 } });
  raceContext.setDefaultTimeout(90_000);
  raceContext.setDefaultNavigationTimeout(180_000);
  const seedPage = await raceContext.newPage();
  const meetingId = "recovery-delete-race";
  const meeting = raceMeeting(meetingId, {
    status: "error",
    hasRecording: false,
    recoveryPending: true,
    recordingStopped: true,
    recordingChunkCount: 1,
    recordingObservedChunkCount: 1,
    recordingHeartbeat: 0,
    error: "录音恢复待处理",
  });
  await seedRaceStorage(seedPage, appUrl, {
    meetings: [meeting],
    chunk: { meetingId, index: 0, base64: audioFixture.buffer.toString("base64"), mimeType: audioFixture.mimeType, fileName: audioFixture.name },
  });
  await seedPage.close();

  const pageHandle = await raceContext.newPage();
  await pageHandle.addInitScript(readGateInitScript, {
    storeName: "recordingChunks",
    blockedFlag: "__yanlanRecoveryReadBlocked",
    releaseName: "__releaseYanlanRecoveryRead",
  });
  await pageHandle.goto(appUrl, { waitUntil: "domcontentloaded" });
  await pageHandle.waitForFunction(() => window.__yanlanRecoveryReadBlocked === true);

  const helperPage = await raceContext.newPage();
  await helperPage.goto(`${appUrl}/yanlan-logo.png`, { waitUntil: "load" });
  await queueCrossTabDeletion(helperPage, meetingId);
  await pageHandle.evaluate(() => window.__releaseYanlanRecoveryRead?.());
  await helperPage.evaluate(() => window.__yanlanQueuedDelete);
  await waitForRecordingDeleted(pageHandle, meetingId);
  assert.equal(await pageHandle.evaluate((id) => (
    JSON.parse(localStorage.getItem("yanlan.meetings.v1") || "[]").some((meetingItem) => meetingItem.id === id)
  ), meetingId), false);
  await raceContext.close();
}

async function verifyCompletedTombstoneStartupCleanup(browserHandle, appUrl, audioFixture) {
  const raceContext = await browserHandle.newContext({ viewport: { width: 1280, height: 800 } });
  raceContext.setDefaultTimeout(90_000);
  raceContext.setDefaultNavigationTimeout(180_000);
  const seedPage = await raceContext.newPage();
  const meetingId = "completed-tombstone-orphan";
  await seedRaceStorage(seedPage, appUrl, {
    meetings: [],
    tombstones: [{ id: meetingId, status: "deleted" }],
    recording: { id: meetingId, base64: audioFixture.buffer.toString("base64"), mimeType: audioFixture.mimeType, fileName: audioFixture.name },
    chunk: { meetingId, index: 0, base64: audioFixture.buffer.toString("base64"), mimeType: audioFixture.mimeType, fileName: audioFixture.name },
  });
  await seedPage.close();
  const pageHandle = await raceContext.newPage();
  await pageHandle.goto(appUrl, { waitUntil: "domcontentloaded" });
  await waitForRecordingDeleted(pageHandle, meetingId);
  assert.equal(await pageHandle.evaluate((id) => localStorage.getItem(`yanlan.meeting.deleted.v1.${id}`), meetingId), "deleted");
  await raceContext.close();
}

function raceMeeting(id, overrides = {}) {
  return {
    id,
    title: "删除竞态录音",
    createdAt: "2026-08-04T00:00:00.000Z",
    duration: 1,
    sourceName: "race.wav",
    sourceType: "audio/wav",
    language: "zh",
    mode: "meeting",
    status: "error",
    hasRecording: false,
    rawSegments: [],
    segments: [],
    qa: [],
    keywords: [],
    highlights: [],
    speaker_summaries: [],
    decisions: [],
    decision_records: [],
    action_items: [],
    ...overrides,
  };
}

function raceConfig() {
  return {
    asrBaseUrl: "https://mimo.example",
    asrApiKey: "asr-test-key",
    asrModel: "mimo-v2.5-asr",
    asrProtocol: "mimo-chat",
    asrPath: "v1/chat/completions",
    chatBaseUrl: "https://gpt.example/v1",
    chatApiKey: "gpt-test-key",
    chatModel: "gpt-5.6-luna",
    chatProtocol: "responses",
    chatPath: "responses",
    transportMode: "direct",
  };
}

async function seedRaceStorage(pageHandle, appUrl, { meetings, tombstones = [], recording, chunk }) {
  await pageHandle.goto(`${appUrl}/yanlan-logo.png`, { waitUntil: "load" });
  await pageHandle.evaluate(async ({ storedMeetings, config, tombstoneEntries, recordingEntry, chunkEntry }) => {
    localStorage.setItem("yanlan.config.v1", JSON.stringify(config));
    localStorage.setItem("yanlan.meetings.v1", JSON.stringify(storedMeetings));
    for (const entry of tombstoneEntries) {
      localStorage.setItem(`yanlan.meeting.deleted.v1.${entry.id}`, entry.status);
    }
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("yanlan", 2);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("recordings")) request.result.createObjectStore("recordings", { keyPath: "id" });
        if (!request.result.objectStoreNames.contains("recordingChunks")) {
          const chunks = request.result.createObjectStore("recordingChunks", { keyPath: ["meetingId", "index"] });
          chunks.createIndex("meetingId", "meetingId", { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction(["recordings", "recordingChunks"], "readwrite");
    const blobFrom = (entry) => {
      const bytes = Uint8Array.from(atob(entry.base64), (character) => character.charCodeAt(0));
      return new Blob([bytes], { type: entry.mimeType });
    };
    if (recordingEntry) {
      transaction.objectStore("recordings").put({
        id: recordingEntry.id,
        blob: blobFrom(recordingEntry),
        fileName: recordingEntry.fileName,
        mimeType: recordingEntry.mimeType,
      });
    }
    if (chunkEntry) {
      transaction.objectStore("recordingChunks").put({
        meetingId: chunkEntry.meetingId,
        index: chunkEntry.index,
        blob: blobFrom(chunkEntry),
        fileName: chunkEntry.fileName,
        mimeType: chunkEntry.mimeType,
      });
    }
    await new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
  }, {
    storedMeetings: meetings,
    config: raceConfig(),
    tombstoneEntries: tombstones,
    recordingEntry: recording || null,
    chunkEntry: chunk || null,
  });
}

async function installIdbReadGate(pageHandle, storeName, blockedFlag, releaseName) {
  await pageHandle.evaluate(readGateInitScript, { storeName, blockedFlag, releaseName });
}

function readGateInitScript({ storeName, blockedFlag, releaseName }) {
  const original = IDBDatabase.prototype.transaction;
  let armed = true;
  let released = false;
  window[releaseName] = () => { released = true; };
  IDBDatabase.prototype.transaction = function transactionWithReadGate(storeNames, mode) {
    const transaction = original.apply(this, arguments);
    const names = typeof storeNames === "string" ? [storeNames] : [...storeNames];
    if (!armed || mode !== "readonly" || !names.includes(storeName)) return transaction;
    armed = false;
    window[blockedFlag] = true;
    const keepAlive = () => {
      if (released) return;
      let request;
      try { request = transaction.objectStore(storeName).get("__yanlan_read_gate__"); }
      catch { return; }
      request.onsuccess = keepAlive;
      request.onerror = keepAlive;
    };
    keepAlive();
    return transaction;
  };
}

async function queueCrossTabDeletion(pageHandle, meetingId) {
  await pageHandle.evaluate(async (id) => {
    localStorage.setItem(`yanlan.meeting.deleted.v1.${id}`, "pending");
    const meetings = JSON.parse(localStorage.getItem("yanlan.meetings.v1") || "[]");
    localStorage.setItem("yanlan.meetings.v1", JSON.stringify(meetings.filter((meeting) => meeting.id !== id)));
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("yanlan", 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction(["recordings", "recordingChunks"], "readwrite");
    transaction.objectStore("recordings").delete(id);
    const cursorRequest = transaction.objectStore("recordingChunks").index("meetingId").openKeyCursor(IDBKeyRange.only(id));
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) return;
      transaction.objectStore("recordingChunks").delete(cursor.primaryKey);
      cursor.continue();
    };
    window.__yanlanQueuedDelete = new Promise((resolve, reject) => {
      transaction.oncomplete = () => {
        localStorage.setItem(`yanlan.meeting.deleted.v1.${id}`, "deleted");
        database.close();
        resolve(true);
      };
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }, meetingId);
}

async function waitForRecordingDeleted(pageHandle, meetingId, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const stored = await recordingStorageState(pageHandle, meetingId);
    if (stored.recordingSize === 0 && stored.chunks.length === 0) return;
    await pageHandle.waitForTimeout(50);
  }
  throw new Error(`Timed out waiting for local audio cleanup: ${meetingId}`);
}

function recordingChunkCount(pageHandle, meetingId) {
  return pageHandle.evaluate(async (id) => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("yanlan", 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const count = await new Promise((resolve, reject) => {
      const store = database.transaction("recordingChunks", "readonly").objectStore("recordingChunks");
      const request = store.index("meetingId").count(IDBKeyRange.only(id));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return count;
  }, meetingId);
}

async function waitForRecordingChunks(pageHandle, meetingId, minimum, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await recordingChunkCount(pageHandle, meetingId) >= minimum) return;
    await pageHandle.waitForTimeout(100);
  }
  throw new Error(`Timed out waiting for ${minimum} persisted recording chunk(s)`);
}

function recordingStorageState(pageHandle, meetingId) {
  return pageHandle.evaluate(async (id) => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("yanlan", 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction(["recordings", "recordingChunks"], "readonly");
    const recording = await new Promise((resolve, reject) => {
      const request = transaction.objectStore("recordings").get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const chunks = await new Promise((resolve, reject) => {
      const request = transaction.objectStore("recordingChunks").index("meetingId").getAll(IDBKeyRange.only(id));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return {
      recordingSize: recording?.blob?.size || 0,
      chunks: chunks.map((chunk) => ({ index: chunk.index, size: chunk.blob?.size || 0 })),
    };
  }, meetingId);
}

function createWavFixture({ seconds = 1, sampleRate = 16000 } = {}) {
  const sampleCount = Math.round(seconds * sampleRate);
  const buffer = Buffer.alloc(44 + sampleCount * 2);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + sampleCount * 2, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(sampleCount * 2, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 0.08;
    buffer.writeInt16LE(Math.round(sample * 0x7fff), 44 + index * 2);
  }
  return buffer;
}
