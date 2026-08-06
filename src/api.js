import { reconcileTranscriptSegments, replayTranscriptReconciliations, segmentSourceHash } from "./asr-pipeline.js";
import { runAgent } from "./agent/harness.js";
import { createResponsesAdapter } from "./agent/responses-adapter.js";
import { createMeetingAnalysisAgentProfile } from "./agent/profiles/meeting-analysis.js";
import { createTerminologyAgentProfile, createTerminologyCanonicalReviewInventory } from "./agent/profiles/terminology.js";

export const DEFAULT_MIMO_BASE_URL = "https://api.xiaomimimo.com";

export const DEFAULT_CONFIG = Object.freeze({
  asrBaseUrl: DEFAULT_MIMO_BASE_URL,
  asrApiKey: "",
  asrModel: "mimo-v2.5-asr",
  asrProtocol: "mimo-chat",
  asrPath: "v1/chat/completions",
  chatBaseUrl: "",
  chatApiKey: "",
  chatModel: "gpt-5.6-luna",
  chatProtocol: "responses",
  chatPath: "responses",
  transportMode: "direct",
  relayPath: "/api/relay",
  contextHint: "",
  chunkSeconds: 10,
});

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_ASR_ATTEMPTS = 3;
const CONNECTION_TEST_AUDIO_SECONDS = 1;
const CONNECTION_TEST_AUDIO_SAMPLE_RATE = 16_000;
const MAX_TEXT_INPUT_CHARACTERS = 18_000;
const MAX_SUMMARY_EVIDENCE_PER_BATCH = 3;
const MAX_MEETING_SUMMARY_CHARACTERS = 4_000;
const MAX_MEETING_EVIDENCE_RECORDS = 400;
const MAX_MEETING_AGENT_INPUT_CHARACTERS = 80_000;
const TEXT_REQUEST_CONCURRENCY = 3;
const DEFAULT_TEXT_ATTEMPTS = 3;
const TEXT_RETRY_BASE_DELAY_MS = 500;
const MAX_CORRECTION_CONTEXT_CHARACTERS = 2_000;
const MAX_CORRECTION_BATCH_JSON_CHARACTERS = 10_000;
const MAX_BOUNDARY_PREVIEW_CHARACTERS = 500;
const MAX_READABLE_SEGMENT_CHARACTERS = 800;
const MAX_READABLE_SEGMENT_SECONDS = 90;
const MAX_SEMANTIC_JOIN_GAP_SECONDS = 3;
const MAX_SEMANTIC_JOIN_OVERLAP_SECONDS = 0.25;
const MIN_DISPLAY_CJK_OVERLAP_UNITS = 4;
const MIN_DISPLAY_WORD_OVERLAP_UNITS = 10;
const MIN_DISPLAY_TEMPORAL_OVERLAP_SECONDS = 0.25;
const DISPLAY_OVERLAP_TIMING_TOLERANCE_SECONDS = 0.2;
const DISPLAY_MAX_CJK_UNITS_PER_SECOND = 12;
const DISPLAY_MAX_OTHER_WORD_UNITS_PER_SECOND = 30;
const DISPLAY_MAX_WORDS_PER_SECOND = 6;
const DISPLAY_OVERLAP_ALGORITHM_VERSION = "display-overlap-v1";
const DISPLAY_TECHNICAL_CONNECTORS = new Set(["+", "*", "#", "@", "%", ":", "\\"]);
const DISPLAY_GRAPHEME_SEGMENTER = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;
const MAX_TERMINOLOGY_ENTRIES = 200;
const MAX_TERMINOLOGY_ENTRY_CHARACTERS = 120;
const MAX_TERMINOLOGY_PROMPT_CHARACTERS = 2_000;
const MAX_CANONICAL_REVIEW_GROUPS = 20;
const MAX_CANONICAL_REVIEW_CONFIRMATIONS = 8;
const MAX_CANONICAL_REVIEW_CONTEXT_CHARACTERS = 1_200;
const MAX_CANONICAL_REVIEW_OUTPUT_TOKENS = 512;
const ACCEPTED_CORRECTION_REASONS = new Set(["explicit_alias", "recording_consensus"]);

export function joinApiUrl(baseUrl, endpointPath) {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "");
  const path = String(endpointPath || "").trim().replace(/^\/+/, "");
  if (!base) throw new Error("请先填写 API Base URL");
  if (!path) throw new Error("API 路径不能为空");
  try {
    return new URL(`${base}/${path}`).toString();
  } catch {
    throw new Error("API Base URL 格式不正确");
  }
}

export function normalizeMimoBaseUrl(value) {
  const input = String(value || "").trim().replace(/\/+$/, "");
  if (!input) return DEFAULT_MIMO_BASE_URL;
  let url;
  try { url = new URL(input); }
  catch { return input; }
  let pathname = url.pathname.replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(pathname)) pathname = pathname.slice(0, -"/chat/completions".length);
  if (/\/v1$/i.test(pathname)) pathname = pathname.slice(0, -"/v1".length);
  url.pathname = pathname || "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

function authHeaders(apiKey, contentType = "application/json") {
  if (!apiKey?.trim()) throw new Error("请先填写对应服务的 API Key");
  const headers = { Authorization: `Bearer ${apiKey.trim()}` };
  if (contentType) headers["Content-Type"] = contentType;
  return headers;
}

async function apiFetch(url, options, config = DEFAULT_CONFIG) {
  requireSecureApiUrl(url);
  const requestUrl = requestUrlForConfig(url, config);
  let response;
  try {
    response = await fetch(requestUrl, { ...options, signal: requestSignal(options?.signal) });
  } catch (error) {
    if (error?.name === "TimeoutError") throw retryableError("API 请求超时，请稍后重试", error, "timeout");
    if (error?.name === "AbortError") throw codedError("API 请求已取消", "aborted", error);
    if (error instanceof TypeError) {
      if (config.transportMode === "relay") throw retryableError("本地同源网关不可用，请使用 npm run local 启动言澜", error, "relay-unavailable");
      throw retryableError("无法访问 API，请检查 Base URL 与网络连接；浏览器直连时还需检查服务端 CORS", error, "network-or-cors");
    }
    throw error;
  }
  let raw;
  try {
    raw = await response.text();
  } catch (error) {
    if (error?.name === "AbortError") throw codedError("API 请求已取消", "aborted", error);
    throw retryableError("读取 API 响应时连接中断，请稍后重试", error, "response-interrupted");
  }
  let body;
  try { body = raw ? JSON.parse(raw) : {}; }
  catch { body = { message: raw }; }
  if (!response.ok) {
    const providerMessage = body?.error?.message || (typeof body?.error === "string" ? body.error : "") || body?.message || body?.detail || "";
    const error = new Error(`API 请求失败（HTTP ${response.status}）`);
    error.code = "http";
    error.status = response.status;
    error.toolCompatibilityFailure = toolCompatibilityMessage(providerMessage);
    error.retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
    error.retryAfterMs = retryAfterMilliseconds(response.headers?.get?.("retry-after"));
    throw error;
  }
  return body;
}

function toolCompatibilityMessage(value) {
  return /tool|function|parallel_tool_calls|strict|unsupported|unknown (?:field|parameter)|不支持|未知(?:字段|参数)/iu.test(String(value || ""));
}

function retryAfterMilliseconds(value) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

function requestSignal(signal) {
  const timeout = AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS);
  if (!signal) return timeout;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([signal, timeout]);
  const controller = new AbortController();
  const abort = (source) => {
    if (!controller.signal.aborted) controller.abort(source.reason);
  };
  if (signal.aborted) abort(signal);
  else signal.addEventListener("abort", () => abort(signal), { once: true });
  timeout.addEventListener("abort", () => abort(timeout), { once: true });
  return controller.signal;
}

function codedError(message, code, cause) {
  const error = new Error(message, { cause });
  error.code = code;
  return error;
}

function retryableError(message, cause, code) {
  const error = codedError(message, code, cause);
  error.retryable = true;
  return error;
}

function requireSecureApiUrl(value) {
  let url;
  try { url = new URL(value); }
  catch { throw new Error("API Base URL 不是有效的绝对 URL"); }
  if (url.username || url.password) throw new Error("API Base URL 不能包含用户名或密码");
  if (url.protocol === "https:") return;
  const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (url.protocol === "http:" && loopback) return;
  throw new Error("为避免泄露 API Key，远程 API Base URL 必须使用 HTTPS；仅本机回环地址可使用 HTTP");
}

export function requestUrlForConfig(targetUrl, config = DEFAULT_CONFIG, pageUrl = globalThis.location?.href) {
  if (config.transportMode !== "relay") return targetUrl;
  const relay = new URL(config.relayPath || DEFAULT_CONFIG.relayPath, pageUrl || "http://127.0.0.1/");
  relay.searchParams.set("url", targetUrl);
  return relay.toString();
}

export async function transcribeAudio({ config, blob, fileName = "audio.wav", language = "auto", signal }) {
  if (!config.asrModel?.trim()) throw new Error("请先填写语音模型名称");
  if (config.asrProtocol !== "openai-transcriptions") {
    const dataUrl = await blobToDataUrl(blob);
    const body = await apiFetch(joinApiUrl(config.asrBaseUrl, config.asrPath), {
      method: "POST",
      headers: authHeaders(config.asrApiKey),
      body: JSON.stringify({
        model: config.asrModel.trim(),
        messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: dataUrl } }] }],
        asr_options: { language: language || "auto" },
      }),
      signal,
    }, config);
    return parseTranscriptionResponse(body);
  }
  const form = new FormData();
  form.append("file", blob, fileName);
  form.append("model", config.asrModel.trim());
  form.append("response_format", "verbose_json");
  if (language && language !== "auto") form.append("language", language);
  const body = await apiFetch(joinApiUrl(config.asrBaseUrl, config.asrPath), {
    method: "POST",
    headers: authHeaders(config.asrApiKey, null),
    body: form,
    signal,
  }, config);
  return parseTranscriptionResponse(body);
}

export async function testAsrConnection({ config, signal }) {
  const result = await transcribeAudio({
    config,
    blob: connectionTestAudio(),
    fileName: "yanlan-connection-test.wav",
    language: "auto",
    signal,
  });
  if (!recognizedTranscriptionEnvelope(result.raw)) throw codedError("API 已响应，但返回的不是兼容的语音转写结果", "invalid-response");
  return result;
}

export async function testChatConnection({ config, signal }) {
  return chatCompletion({
    config,
    system: "这是一次 API 配置连通性测试。",
    user: "只回复 OK。",
    signal,
    attempts: 1,
  });
}

export function connectionTestErrorMessage(provider, error) {
  const name = String(provider || "API").trim() || "API";
  const status = Number(error?.status);
  if (status === 401) return `${name} API Key 无效或已失效（HTTP 401）`;
  if (status === 403) return `${name} API Key 无权访问当前模型（HTTP 403）`;
  if (status === 402) return `${name} 账户余额或调用额度不足（HTTP 402）`;
  if (status === 429) return `${name} 请求受限，请检查额度或稍后重试（HTTP 429）`;
  if (status === 404 || status === 405) return `${name} Base URL 或接口路径不正确（HTTP ${status}）`;
  if (status === 400 || status === 415 || status === 422) return `${name} 模型名或接口格式不兼容（HTTP ${status}）`;
  if (status === 408 || status === 425 || status >= 500) return `${name} 服务暂时不可用（HTTP ${status}），请稍后重试`;
  if (error?.code === "timeout") return `${name} 连接测试超时，请检查 Base URL 与网络`;
  if (error?.code === "network-or-cors") return `${name} 网络连接失败；浏览器直连时也可能是服务端未允许 CORS`;
  if (error?.code === "relay-unavailable") return "本地同源网关不可用，请先运行 npm run local";
  if (error?.code === "invalid-response") return `${name} 地址可访问，但返回的不是兼容 API 响应`;
  return error?.message || `${name} 连接测试失败`;
}

export async function transcribeAudioWithRetry(args, { attempts = DEFAULT_ASR_ATTEMPTS, baseDelayMs = 500 } = {}) {
  const count = Math.max(1, Math.min(5, Number(attempts) || DEFAULT_ASR_ATTEMPTS));
  const signal = args.signal || AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS);
  const request = { ...args, signal };
  let lastError;
  for (let attempt = 1; attempt <= count; attempt += 1) {
    try {
      return await transcribeAudio(request);
    } catch (error) {
      lastError = error;
      if (signal.aborted || !error?.retryable || attempt === count) throw error;
      await retryDelay(baseDelayMs * (2 ** (attempt - 1)), signal);
    }
  }
  throw lastError;
}

function retryDelay(milliseconds, signal) {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason || new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return `data:${blob.type || "audio/wav"};base64,${btoa(binary)}`;
}

function connectionTestAudio() {
  const sampleCount = Math.round(CONNECTION_TEST_AUDIO_SECONDS * CONNECTION_TEST_AUDIO_SAMPLE_RATE);
  const buffer = new ArrayBuffer(44 + sampleCount * 2);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + sampleCount * 2, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, CONNECTION_TEST_AUDIO_SAMPLE_RATE, true);
  view.setUint32(28, CONNECTION_TEST_AUDIO_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, sampleCount * 2, true);
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = Math.sin((2 * Math.PI * 440 * index) / CONNECTION_TEST_AUDIO_SAMPLE_RATE) * 0.04;
    view.setInt16(44 + index * 2, Math.round(sample * 0x7fff), true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

function writeAscii(view, offset, value) {
  for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
}

export function parseTranscriptionResponse(body) {
  const choiceContent = body?.choices?.[0]?.message?.content;
  const text = String(body?.text ?? body?.transcript ?? (typeof choiceContent === "string" ? choiceContent : "")).trim();
  const sourceSegments = Array.isArray(body?.segments) ? body.segments : [];
  const segments = sourceSegments.map((segment, index) => {
    const providerTimes = providerSegmentTimes(segment);
    const start = providerTimes?.start ?? 0;
    const end = providerTimes?.end ?? 0;
    return {
      start_seconds: start,
      end_seconds: end,
      timing_source: providerTimes ? "provider" : "inferred",
      speaker: String(segment.speaker ?? segment.speaker_id ?? `发言人 ${index + 1}`),
      text: String(segment.text ?? segment.transcript ?? "").trim(),
    };
  }).filter((segment) => segment.text);
  if (!segments.length && text) segments.push({ start_seconds: 0, end_seconds: 0, timing_source: "inferred", speaker: "发言人 1", text });
  return { text: text || segments.map((segment) => segment.text).join(" "), segments, raw: body };
}

function recognizedTranscriptionEnvelope(body) {
  return (Array.isArray(body?.choices) && body.choices.some((choice) => typeof choice?.message?.content === "string"))
    || typeof body?.text === "string"
    || typeof body?.transcript === "string"
    || Array.isArray(body?.segments);
}

function providerSegmentTimes(segment) {
  const candidates = [
    ["start_seconds", "end_seconds", 1],
    ["start", "end", 1],
    ["begin_time", "end_time", 0.001],
  ];
  for (const [startKey, endKey, scale] of candidates) {
    const rawStart = segment?.[startKey];
    const rawEnd = segment?.[endKey];
    if (rawStart == null && rawEnd == null) continue;
    const start = strictTimestamp(rawStart);
    const end = strictTimestamp(rawEnd);
    if (start == null || end == null || end <= start) return null;
    return { start: start * scale, end: end * scale };
  }
  return null;
}

function strictTimestamp(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export async function summarizeTranscript({ config, meeting, signal }) {
  const segments = meeting.segments || [];
  if (!segments.some((segment) => String(segment?.text || "").trim())) return emptySummary();
  if (meeting.mode === "interview") return summarizeInterviewTranscript({ config, meeting, signal });
  const candidates = await extractMeetingSummaryCandidates({ config, meeting, signal });
  if (textProtocol(config) === "responses") {
    try {
      return await summarizeMeetingTranscriptWithAgent({ config, meeting, signal, candidates });
    } catch (error) {
      error.agentUsage = combinedMeetingAnalysisUsage(error.agentUsage, candidates.extractionUsage);
      if (!agentToolsUnsupported(error) && !agentToolsIgnored(error)) throw error;
      return {
        ...meetingSummaryFromCandidates({ meeting, ...candidates }),
        analysisRun: {
          id: error.agentTrace?.[0]?.run_id || "",
          profile: "meeting-analysis",
          model: config.chatModel.trim(),
          status: "unsupported",
          sourceSignature: meetingAnalysisSourceSignature(meeting.segments || []),
          usage: error.agentUsage || {},
          trace: error.agentTrace || [],
        },
      };
    }
  }
  return meetingSummaryFromCandidates({ meeting, ...candidates });
}

function agentToolsUnsupported(error) {
  if (error?.code !== "http" || ![400, 404, 405, 415, 422].includes(Number(error?.status))) return false;
  return error?.toolCompatibilityFailure === true || toolCompatibilityMessage(error?.message);
}

function agentToolsIgnored(error) {
  const auxiliaryTurns = Math.max(0, Number(error?.agentUsage?.candidateExtractionTurns) || 0)
    + Math.max(0, Number(error?.agentUsage?.canonicalReviewTurns) || 0);
  const agentTurns = Math.max(0, Number(error?.agentUsage?.modelTurns) || 0) - auxiliaryTurns;
  if (Number(error?.agentUsage?.toolCalls) !== 0 || agentTurns < 1) return false;
  if (error?.code === "invalid_response_output" && agentTurns === 1) return true;
  if (error?.code !== "agent_budget_exceeded" || error?.kind !== "idle_turns") return false;
  const responses = (Array.isArray(error?.agentTrace) ? error.agentTrace : [])
    .filter((event) => event?.type === "model.responded");
  return responses.length > 0 && responses.every((event) => Number(event?.data?.tool_calls) === 0);
}

async function extractMeetingSummaryCandidates({ config, meeting, signal }) {
  const segments = meeting.segments || [];
  const terminologyMappings = validatedTerminologyMappings(meeting);
  const system = `你是严谨的会议纪要助手。请仅依据带时间和发言人的逐字稿输出纯 JSON，不要使用 Markdown 代码块。
字段必须为：
1. title（简短标题）、summary（完整摘要）、keywords（字符串数组）、summary_evidence（支撑摘要的原话证据数组，每项含 start_seconds、quote）；
2. highlights（会议金句数组，每项含 start_seconds、speaker、quote、reason）；
3. speaker_summaries（发言人总结数组，每项含 speaker、summary、key_points 字符串数组、evidence 原话证据数组；每条 evidence 含 start_seconds、quote）；
4. decisions（关键决策字符串数组）；
5. decision_records（关键决策证据数组，每项含 decision、start_seconds、evidence）；
6. action_items（行动项数组，每项含 task、owner、due、start_seconds、evidence；未知 owner/due 填空字符串）。
summary_evidence 必须为本段最重要的 1 至 3 条简短原话。金句、summary_evidence、发言人 evidence、关键决策 evidence 和行动项 evidence 必须是逐字稿中的原话并使用对应 start_seconds。speaker 必须对应原片段；owner 或 due 未在原话中明确出现时必须留空。只总结有实际发言的说话人。不得虚构逐字稿里没有的信息、时间或原话。`;
  const transcriptBatches = splitTranscriptPromptBatchRecords(segments, MAX_TEXT_INPUT_CHARACTERS - 300);
  const responses = await mapWithConcurrency(transcriptBatches, TEXT_REQUEST_CONCURRENCY, async (batch, index) => {
    const batchLabel = transcriptBatches.length > 1 ? `（第 ${index + 1}/${transcriptBatches.length} 段，仅总结本段）` : "";
    const response = await chatCompletionResult({
      config,
      system,
      user: `会议逐字稿${batchLabel}：\n${batch.text}`,
      signal,
    });
    return {
      partial: normalizeGeneratedTerminology(parseJsonObject(response.content), terminologyMappings),
      usage: response.usage,
    };
  });
  const partials = responses.map((response) => response.partial);
  const extractionTokens = responses.reduce((total, response) => total + Math.max(0, Number(response.usage?.modelTokens) || 0), 0);
  const merged = partials.length === 1 ? partials[0] : {};
  return {
    partials,
    merged,
    terminologyMappings,
    batches: transcriptBatches.map((batch) => ({ segment_ids: [...batch.segment_ids] })),
    extractionUsage: {
      modelTurns: responses.length,
      ...(extractionTokens ? { modelTokens: extractionTokens } : {}),
    },
  };
}

function meetingSummaryFromCandidates({ meeting, ...candidates }) {
  const evidence = buildMeetingEvidenceLedger({ meeting, ...candidates });
  const sourceSignature = meetingAnalysisSourceSignature(meeting.segments || []);
  const result = finalizeMeetingAnalysis({
    outline: selectAllMeetingEvidence(evidence, { defensiveCommitmentGate: true }),
    evidence,
    sourceSignature,
    meeting,
    terminologyMappings: candidates.terminologyMappings,
  });
  return result.artifact || emptySummary();
}

async function summarizeMeetingTranscriptWithAgent({ config, meeting, signal, candidates }) {
  const sourceSignature = meetingAnalysisSourceSignature(meeting.segments || []);
  const evidence = buildMeetingEvidenceLedger({ meeting, ...candidates });
  if (evidence.length > MAX_MEETING_EVIDENCE_RECORDS) {
    return boundedMeetingAnalysisFallback({
      config,
      meeting,
      candidates,
      sourceSignature,
      reason: "evidence_record_budget",
    });
  }
  const profile = createMeetingAnalysisAgentProfile({
    evidence,
    sourceSignature,
    reviewCommitments: (reviews, context) => validateMeetingCommitmentReview({
      reviews,
      evidence: context.evidence,
      sourceSignature: context.sourceSignature,
      meeting,
    }),
    finalizeAnalysis: (outline, context) => finalizeMeetingAnalysis({
      outline,
      evidence: context.evidence,
      sourceSignature: context.sourceSignature,
      meeting,
      terminologyMappings: candidates.terminologyMappings,
    }),
  });
  if (profile.input.length > MAX_MEETING_AGENT_INPUT_CHARACTERS) {
    return boundedMeetingAnalysisFallback({
      config,
      meeting,
      candidates,
      sourceSignature,
      reason: "agent_input_budget",
    });
  }
  const adapter = createResponsesAdapter({
    model: config.chatModel,
    store: false,
    includeEncryptedReasoning: true,
    request: (body, options) => requestResponsesBody({ config, body, signal: options.signal || signal }),
  });
  const run = await runAgent({
    adapter,
    profile,
    input: profile.input,
    initialState: profile.initialState,
    signal,
    policy: {
      maxModelTurns: 5,
      maxToolCalls: 5,
      maxIdleTurns: 1,
      maxToolOutputCharacters: 20_000,
      maxHistoryCharacters: 600_000,
    },
  });
  return {
    ...run.result,
    analysisRun: {
      id: run.trace[0]?.run_id || "",
      profile: profile.name,
      model: config.chatModel.trim(),
      status: "completed",
      sourceSignature,
      commitmentProofVersion: 1,
      commitmentProofs: meetingAnalysisCommitmentProofs(run.result),
      usage: combinedMeetingAnalysisUsage(run.usage, candidates.extractionUsage),
      trace: run.trace,
    },
  };
}

function boundedMeetingAnalysisFallback({ config, meeting, candidates, sourceSignature, reason }) {
  return {
    ...meetingSummaryFromCandidates({ meeting, ...candidates }),
    analysisRun: {
      id: "",
      profile: "meeting-analysis",
      model: config.chatModel.trim(),
      status: "bounded_fallback",
      reason,
      sourceSignature,
      usage: combinedMeetingAnalysisUsage({}, candidates.extractionUsage),
      trace: [],
    },
  };
}

function combinedMeetingAnalysisUsage(agentUsage, extractionUsage) {
  const extractionTurns = Math.max(0, Number(extractionUsage?.modelTurns) || 0);
  const extractionTokens = Math.max(0, Number(extractionUsage?.modelTokens) || 0);
  const agentTokens = Math.max(0, Number(agentUsage?.modelTokens) || 0);
  return {
    ...(agentUsage || {}),
    modelTurns: Math.max(0, Number(agentUsage?.modelTurns) || 0) + extractionTurns,
    ...(extractionTokens || agentTokens ? { modelTokens: extractionTokens + agentTokens } : {}),
    ...(extractionTurns ? { candidateExtractionTurns: extractionTurns } : {}),
    ...(extractionTokens ? { candidateExtractionTokens: extractionTokens } : {}),
  };
}

function buildMeetingEvidenceLedger({ meeting, partials, batches = [] }) {
  const records = [];
  const seen = new Set();
  const add = (kind, value, key) => {
    const dedupeKey = `${kind}:${key}`;
    if (!key || seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    records.push({ id: `${kind}-${records.length + 1}`, kind, ...value });
  };
  const transcriptText = (meeting.segments || []).map((segment) => String(segment?.text || "")).join("\n");
  const evidenceContext = prepareEvidenceContext(
    meeting.segments,
    meeting.rawSegments,
    meeting.terminology,
    meeting.corrections,
    meeting.asrReconciliations,
  );
  partials.forEach((item, batchIndex) => {
    const batch = batches[batchIndex] || { segment_ids: [] };
    const quotes = verifiedBatchSummaryEvidence(item, batch, meeting, evidenceContext);
    const keywords = supportedMeetingKeywords(
      [item?.title, ...stringArray(item?.keywords)],
      transcriptText,
    ).slice(0, 12);
    records.push({
      id: `summary-${records.length + 1}`,
      kind: "summary",
      scope: "transcript_batch",
      batch_index: batchIndex,
      quotes,
      keywords,
    });
  });

  const highlights = normalizeHighlights(
    partials.flatMap((item) => Array.isArray(item?.highlights) ? item.highlights : []),
    meeting.segments,
    meeting.rawSegments,
    meeting.terminology,
    meeting.corrections,
    meeting.asrReconciliations,
  );
  highlights.forEach((item) => add("highlight", item, `${item.start_seconds}:${comparableText(item.quote)}`));

  const decisions = normalizeMeetingDecisionCandidates(
    partials.flatMap((item) => Array.isArray(item?.decision_records) ? item.decision_records : []),
    meeting.segments,
    meeting.rawSegments,
    meeting.terminology,
    meeting.corrections,
    meeting.asrReconciliations,
  );
  decisions.forEach((item) => add("decision", item, `${item.start_seconds}:${comparableText(item.evidence)}`));

  for (const item of partials.flatMap((value) => Array.isArray(value?.speaker_summaries) ? value.speaker_summaries : [])) {
    const speaker = stringOr(item?.speaker, "发言人");
    for (const entry of Array.isArray(item?.evidence) ? item.evidence : []) {
      const verified = verifiedEvidence(
        entry?.start_seconds,
        entry?.quote,
        meeting.segments,
        meeting.rawSegments,
        meeting.terminology,
        meeting.corrections,
        meeting.asrReconciliations,
        speaker,
        evidenceContext,
      );
      if (!verified) continue;
      add("speaker_point", verified, `${verified.start_seconds}:${comparableText(verified.speaker)}:${comparableText(verified.quote)}`);
    }
  }

  for (const item of partials.flatMap((value) => Array.isArray(value?.action_items) ? value.action_items : [])) {
    const verified = verifiedEvidence(
      item?.start_seconds,
      item?.evidence,
      meeting.segments,
      meeting.rawSegments,
      meeting.terminology,
      meeting.corrections,
      meeting.asrReconciliations,
      "",
      evidenceContext,
    );
    if (!verified) continue;
    add("action", {
      task: verified.quote,
      owner: evidenceSupportsActionOwner(verified.quote, item?.owner) ? stringOr(item?.owner, "") : "",
      due: evidenceSupportsActionDue(verified.quote, item?.due, item?.task, item?.owner) ? stringOr(item?.due, "") : "",
      start_seconds: verified.start_seconds,
      speaker: verified.speaker,
      evidence: verified.quote,
    }, `${verified.start_seconds}:${comparableText(verified.quote)}`);
  }
  return boundedMeetingEvidenceLedger(records);
}

function boundedMeetingEvidenceLedger(records) {
  const summaries = records.filter((record) => record.kind === "summary")
    .sort((left, right) => left.batch_index - right.batch_index);
  if (summaries.length >= MAX_MEETING_EVIDENCE_RECORDS) return summaries;
  const actions = records.filter((record) => record.kind === "action").slice(0, 60);
  const decisions = records.filter((record) => record.kind === "decision").slice(0, 30);
  const highlights = records.filter((record) => record.kind === "highlight").slice(0, 30);
  const prioritized = [...summaries, ...actions, ...decisions, ...highlights]
    .slice(0, MAX_MEETING_EVIDENCE_RECORDS);
  const remaining = MAX_MEETING_EVIDENCE_RECORDS - prioritized.length;
  if (remaining <= 0) return prioritized;
  return [...prioritized, ...roundRobinSpeakerEvidence(
    records.filter((record) => record.kind === "speaker_point"),
    Math.min(120, remaining),
  )];
}

function roundRobinSpeakerEvidence(records, limit) {
  const groups = new Map();
  for (const record of records) {
    const key = comparableText(record.speaker);
    if (!groups.has(key) && groups.size >= 30) continue;
    if (!groups.has(key)) groups.set(key, []);
    if (groups.get(key).length < 40) groups.get(key).push(record);
  }
  const queues = [...groups.values()];
  const selected = [];
  while (selected.length < limit && queues.some((queue) => queue.length)) {
    for (const queue of queues) {
      if (selected.length >= limit) break;
      const record = queue.shift();
      if (record) selected.push(record);
    }
  }
  return selected;
}

function verifiedBatchSummaryEvidence(item, batch, meeting, evidenceContext) {
  const segmentIds = [...new Set((batch?.segment_ids || []).filter((id) => Number.isInteger(id)))];
  const segmentIdSet = new Set(segmentIds);
  const verify = (entry) => {
    const time = evidenceTime(entry?.start_seconds);
    if (time == null || !segmentIds.some((id) => {
      const segment = meeting.segments?.[id];
      if (!segment) return false;
      const start = Math.max(0, Number(segment.start_seconds) || 0);
      const end = Math.max(start, Number(segment.end_seconds) || start + 5);
      return time >= start - 0.5 && time <= end + 0.5;
    })) return null;
    return verifiedEvidence(
      time,
      entry?.quote,
      meeting.segments,
      meeting.rawSegments,
      meeting.terminology,
      meeting.corrections,
      meeting.asrReconciliations,
      entry?.speaker,
      evidenceContext,
    );
  };
  let verified = uniqueItems(
    (Array.isArray(item?.summary_evidence) ? item.summary_evidence : []).map(verify).filter(Boolean),
    (entry) => `${entry.start_seconds}:${comparableText(entry.quote)}`,
  ).slice(0, MAX_SUMMARY_EVIDENCE_PER_BATCH);
  if (verified.length) return verified;

  const fallbackCandidates = representativeBatchSegments(segmentIds
    .map((id) => ({ id, segment: meeting.segments?.[id] }))
    .filter(({ segment }) => String(segment?.text || "").trim()));
  const fallback = [];
  for (const { id, segment } of fallbackCandidates) {
    if (!segmentIdSet.has(id) || fallback.length >= MAX_SUMMARY_EVIDENCE_PER_BATCH) continue;
    if (oversizedEvidenceSegment(segment)) {
      fallback.push(...verifiedOversizedBatchEvidence(segment, id, evidenceContext)
        .slice(0, MAX_SUMMARY_EVIDENCE_PER_BATCH - fallback.length));
      continue;
    }
    const direct = verifiedEvidence(
      segment.start_seconds,
      segment.text,
      meeting.segments,
      meeting.rawSegments,
      meeting.terminology,
      meeting.corrections,
      meeting.asrReconciliations,
      segment.speaker,
      evidenceContext,
    );
    if (direct) {
      fallback.push(direct);
      continue;
    }
    fallback.push(...verifiedOversizedBatchEvidence(segment, id, evidenceContext)
      .slice(0, MAX_SUMMARY_EVIDENCE_PER_BATCH - fallback.length));
  }
  fallback.sort((left, right) => left.start_seconds - right.start_seconds);
  return uniqueItems(fallback, (entry) => `${entry.start_seconds}:${comparableText(entry.quote)}`);
}

function representativeBatchSegments(values) {
  const ordered = [...values].sort((left, right) => left.id - right.id);
  if (ordered.length <= MAX_SUMMARY_EVIDENCE_PER_BATCH) return ordered;
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  const middle = ordered.slice(1, -1)
    .sort((left, right) => String(right.segment.text).length - String(left.segment.text).length || left.id - right.id)[0];
  return [first, middle, last].filter(Boolean).sort((left, right) => left.id - right.id);
}

function verifiedOversizedBatchEvidence(segment, segmentId, evidenceContext) {
  const text = String(segment?.text || "").trim();
  const start = Math.max(0, Number(segment?.start_seconds) || 0);
  if (!oversizedEvidenceSegment(segment) || evidenceContext.invalid || evidenceContext.segmentValidity?.[segmentId] === false) return [];
  return exactTranscriptExcerpts(text, MAX_READABLE_SEGMENT_CHARACTERS, MAX_SUMMARY_EVIDENCE_PER_BATCH)
    .map((quote) => ({
      start_seconds: start,
      speaker: stringOr(segment?.speaker, "发言人"),
      quote,
    }));
}

function oversizedEvidenceSegment(segment) {
  const start = Math.max(0, Number(segment?.start_seconds) || 0);
  const end = Math.max(start, Number(segment?.end_seconds) || start);
  return String(segment?.text || "").trim().length > MAX_READABLE_SEGMENT_CHARACTERS
    || end - start > MAX_READABLE_SEGMENT_SECONDS;
}

function exactTranscriptExcerpts(value, maxCharacters, limit) {
  const text = String(value || "").trim();
  if (!text) return [];
  if (text.length <= maxCharacters) return [text];
  const lastStart = Math.max(0, text.length - maxCharacters);
  const offsets = [0, Math.floor(lastStart / 2), lastStart];
  return [...new Set(offsets.map((offset) => text.slice(offset, offset + maxCharacters).trim()).filter(Boolean))]
    .slice(0, limit);
}

function supportedMeetingKeywords(values, transcript) {
  const supported = comparableText(transcript);
  return uniqueStrings(values.map((value) => truncateText(value, 80))).filter((value) => {
    const key = comparableText(value);
    return key.length >= 2 && supported.includes(key);
  });
}

function selectAllMeetingEvidence(evidence, { defensiveCommitmentGate = false } = {}) {
  const speakerGroups = new Map();
  for (const record of evidence) {
    if (record.kind !== "speaker_point") continue;
    const key = comparableText(record.speaker);
    if (!key) continue;
    if (!speakerGroups.has(key)) speakerGroups.set(key, { speaker: record.speaker, evidence_ids: [] });
    speakerGroups.get(key).evidence_ids.push(record.id);
  }
  return {
    summary_evidence_ids: evidence.filter((record) => record.kind === "summary").map((record) => record.id),
    highlight_ids: evidence.filter((record) => record.kind === "highlight").map((record) => record.id),
    speaker_summaries: [...speakerGroups.values()],
    decision_ids: evidence.filter((record) => (
      record.kind === "decision"
      && (!defensiveCommitmentGate || looksLikeDecisionEvidence(record.evidence))
    )).map((record) => record.id),
    action_item_ids: evidence.filter((record) => (
      record.kind === "action"
      && (!defensiveCommitmentGate || looksLikeAffirmativeActionEvidence(record.evidence))
    )).map((record) => record.id),
  };
}

function normalizeMeetingDecisionCandidates(value, segments = [], rawSegments = [], trustedTerms = [], correctionLedger, reconciliationLedger) {
  if (!Array.isArray(value) || !value.length) return [];
  const evidenceContext = prepareEvidenceContext(segments, rawSegments, trustedTerms, correctionLedger, reconciliationLedger);
  return uniqueItems(value.map((item) => {
    const evidence = verifiedEvidence(
      item?.start_seconds,
      item?.evidence,
      segments,
      rawSegments,
      trustedTerms,
      correctionLedger,
      reconciliationLedger,
      "",
      evidenceContext,
    );
    if (!evidence || stringOr(item?.decision, "").length < 2) return null;
    return { decision: evidence.quote, start_seconds: evidence.start_seconds, evidence: evidence.quote };
  }).filter(Boolean), (item) => `${item.start_seconds}:${comparableText(item.evidence)}`).slice(0, 30);
}

function validateMeetingCommitmentReview({ reviews, evidence, sourceSignature, meeting }) {
  const violations = [];
  if (sourceSignature !== meetingAnalysisSourceSignature(meeting.segments || [])) {
    return { violations: [{ code: "meeting_source_changed" }] };
  }
  const byId = new Map(evidence.map((record) => [record.id, record]));
  for (const review of reviews || []) {
    if (review.disposition !== "confirmed") continue;
    const record = byId.get(review.evidence_id);
    if (!record || !meetingCommitmentPassesDefensiveFloor(record)) {
      violations.push({
        code: "meeting_commitment_defensive_floor_rejected",
        evidence_id: review.evidence_id,
      });
    }
  }
  return { violations };
}

function meetingCommitmentPassesDefensiveFloor(record) {
  const evidence = String(record?.evidence || "").trim();
  if (!evidence || /[?？]/u.test(evidence) || looksLikeDirectQuestionEvidence(evidence)) return false;
  return !commitmentActWasNotMade(evidence);
}

function finalizeMeetingAnalysis({ outline, evidence, sourceSignature, meeting, terminologyMappings }) {
  const violations = [];
  const currentSignature = meetingAnalysisSourceSignature(meeting.segments || []);
  if (sourceSignature !== currentSignature) {
    violations.push({ code: "meeting_source_changed" });
    return { violations };
  }
  const byId = new Map(evidence.map((record) => [record.id, record]));
  const select = (ids, kinds, field) => {
    const selected = [];
    const seen = new Set();
    for (const id of ids || []) {
      if (seen.has(id)) continue;
      seen.add(id);
      const record = byId.get(id);
      if (!record) {
        violations.push({ code: "unknown_meeting_evidence", field, evidence_id: id });
        continue;
      }
      if (!kinds.includes(record.kind)) {
        violations.push({ code: "meeting_evidence_kind_mismatch", field, evidence_id: id, kind: record.kind });
        continue;
      }
      selected.push(record);
    }
    return selected;
  };

  const summaryEvidence = select(
    outline.summary_evidence_ids,
    ["summary"],
    "summary_evidence_ids",
  );
  if (!summaryEvidence.some((record) => record.kind === "summary")) {
    violations.push({ code: "meeting_summary_source_required" });
  }
  const selectedSummaryIds = new Set(summaryEvidence.filter((record) => record.kind === "summary").map((record) => record.id));
  const requiredBatchSummaries = evidence.filter((record) => record.kind === "summary" && record.scope === "transcript_batch");
  const emptyBatchSummaryIds = requiredBatchSummaries
    .filter((record) => !Array.isArray(record.quotes) || !record.quotes.length)
    .map((record) => record.id);
  if (emptyBatchSummaryIds.length) {
    violations.push({
      code: "meeting_summary_batch_has_no_verified_evidence",
      evidence_ids: emptyBatchSummaryIds.slice(0, 100),
      missing_count: emptyBatchSummaryIds.length,
    });
  }
  const missingBatchSummaryIds = requiredBatchSummaries
    .filter((record) => !selectedSummaryIds.has(record.id))
    .map((record) => record.id);
  if (missingBatchSummaryIds.length) {
    violations.push({
      code: "meeting_summary_coverage_incomplete",
      missing_count: missingBatchSummaryIds.length,
      missing_evidence_ids: missingBatchSummaryIds.slice(0, 100),
    });
  }
  const orderedSummaryRecords = summaryEvidence.filter((record) => record.kind === "summary")
    .sort((left, right) => left.batch_index - right.batch_index);
  const summaryKeywords = uniqueStrings(orderedSummaryRecords.flatMap((record) => stringArray(record.keywords))).slice(0, 30);
  const derivedTitle = summaryKeywords.length ? `${summaryKeywords.slice(0, 3).join(" / ")}会议纪要` : "会议纪要";
  const derivedSummary = groundedMeetingSummary(orderedSummaryRecords);
  const groundedQuoteText = orderedSummaryRecords
    .flatMap((record) => record.quotes || [])
    .map((record) => record.quote || "")
    .join("\n");
  const unsupportedCriticalFacts = missingCriticalFacts(
    groundedQuoteText,
    (meeting.segments || []).map((segment) => segment.text).join("\n"),
  );
  if (unsupportedCriticalFacts.length) {
    violations.push({ code: "unsupported_summary_critical_facts", facts: unsupportedCriticalFacts.slice(0, 20) });
  }
  const highlights = select(outline.highlight_ids, ["highlight"], "highlight_ids");
  const decisions = select(outline.decision_ids, ["decision"], "decision_ids");
  const actions = select(outline.action_item_ids, ["action"], "action_item_ids");

  const speakerSummaries = [];
  const usedSpeakerEvidence = new Set();
  for (const group of outline.speaker_summaries || []) {
    const points = select(group.evidence_ids, ["speaker_point"], "speaker_summaries.evidence_ids")
      .filter((record) => {
        if (comparableText(record.speaker) !== comparableText(group.speaker)) {
          violations.push({
            code: "speaker_evidence_mismatch",
            evidence_id: record.id,
            expected_speaker: group.speaker,
            actual_speaker: record.speaker,
          });
          return false;
        }
        if (usedSpeakerEvidence.has(record.id)) {
          violations.push({ code: "speaker_evidence_reused", evidence_id: record.id });
          return false;
        }
        usedSpeakerEvidence.add(record.id);
        return true;
      });
    if (!points.length) continue;
    const keyPoints = uniqueStrings(points.map((record) => record.quote)).slice(0, 12);
    speakerSummaries.push({
      speaker: points[0].speaker,
      summary: truncateText(keyPoints.join("；"), 1_200),
      key_points: keyPoints,
      evidence: points.map(({ start_seconds, speaker, quote }) => ({ start_seconds, speaker, quote })),
    });
  }

  if (violations.length) return { violations };
  const supportedText = (meeting.segments || []).map((segment) => String(segment?.text || "")).join("\n");
  const selectedSummaryText = orderedSummaryRecords.flatMap((record) => record.quotes || []).map((record) => record.quote || "").join("\n");
  const keywords = summaryKeywords.filter((keyword) => (
    comparableText(supportedText).includes(comparableText(keyword))
    || comparableText(selectedSummaryText).includes(comparableText(keyword))
  )).slice(0, 30);
  const artifact = {
    title: derivedTitle,
    summary: truncateText(derivedSummary, MAX_MEETING_SUMMARY_CHARACTERS),
    keywords,
    highlights: highlights.map(({ start_seconds, speaker, quote }) => ({ start_seconds, speaker, quote, reason: "" })),
    speaker_summaries: speakerSummaries,
    decisions: decisions.map((record) => record.decision),
    decision_records: decisions.map(({ decision, start_seconds, evidence: quote }) => ({ decision, start_seconds, evidence: quote })),
    action_items: actions.map(({ task, owner, due, start_seconds, speaker, evidence: quote }) => ({ task, owner, due, start_seconds, speaker, evidence: quote })),
  };
  return { artifact, violations: [] };
}

function groundedMeetingSummary(records) {
  const batches = records.filter((record) => record.scope === "transcript_batch");
  if (!batches.length) return "";
  let lines = batches.map((record) => {
    const quotes = uniqueItems(record.quotes || [], (entry) => `${entry.start_seconds}:${comparableText(entry.quote)}`);
    if (!quotes.length) return null;
    const first = quotes[0];
    return {
      prefix: `[${formatTimestamp(first.start_seconds)}] ${truncateText(stringOr(first.speaker, "发言人"), 80)}：`,
      quotes,
    };
  }).filter(Boolean);
  while (minimumSummaryCharacters(lines) > MAX_MEETING_SUMMARY_CHARACTERS && lines.length > 2) {
    const last = lines.length - 1;
    const reduced = lines.filter((_, index) => index === 0 || index === last || index % 2 === 0);
    lines = reduced.length < lines.length ? reduced : [lines[0], lines[last]];
  }
  const fixedCharacters = lines.reduce((total, line) => (
    total + line.prefix.length + Math.max(0, line.quotes.length - 1)
  ), Math.max(0, lines.length - 1));
  const quoteCount = lines.reduce((total, line) => total + line.quotes.length, 0);
  const available = Math.max(0, MAX_MEETING_SUMMARY_CHARACTERS - fixedCharacters);
  const baseBudget = quoteCount ? Math.floor(available / quoteCount) : 0;
  let remainder = quoteCount ? available % quoteCount : 0;
  const rendered = lines.map((line) => {
    const content = line.quotes.map((entry) => {
      const budget = baseBudget + (remainder > 0 ? 1 : 0);
      remainder = Math.max(0, remainder - 1);
      return middleTruncateText(entry.quote, budget);
    }).join("；");
    return `${line.prefix}${content}`;
  });
  return rendered.join("\n");
}

function minimumSummaryCharacters(lines) {
  return lines.reduce((total, line) => (
    total + line.prefix.length + Math.max(0, line.quotes.length - 1) + line.quotes.length
  ), Math.max(0, lines.length - 1));
}

function middleTruncateText(value, maxCharacters) {
  const text = String(value || "").trim();
  if (maxCharacters <= 0) return "";
  if (text.length <= maxCharacters) return text;
  if (maxCharacters <= 3) return text.slice(0, maxCharacters);
  const available = Math.max(2, maxCharacters - 3);
  const head = Math.ceil(available / 2);
  const tail = Math.floor(available / 2);
  return `${text.slice(0, head)}...${text.slice(-tail)}`;
}

function meetingAnalysisSourceSignature(segments) {
  const hashes = (segments || []).map((segment, index) => segmentSourceHash(segment, index));
  return segmentSourceHash({
    start_seconds: 0,
    end_seconds: segments.reduce((maximum, segment) => Math.max(maximum, Number(segment?.end_seconds) || 0), 0),
    speaker: `segments:${segments.length}`,
    text: hashes.join("|"),
  }, segments.length);
}

function meetingAnalysisCommitmentProof(kind, item) {
  const start = evidenceTime(item?.start_seconds);
  const evidence = String(item?.evidence || "").trim();
  if (!new Set(["decision", "action"]).has(kind) || start == null || !evidence) return "";
  return `${kind}:${segmentSourceHash({
    start_seconds: start,
    end_seconds: start,
    speaker: kind,
    text: evidence,
  }, 0)}`;
}

function meetingAnalysisCommitmentProofs(artifact) {
  return uniqueStrings([
    ...(Array.isArray(artifact?.decision_records) ? artifact.decision_records : [])
      .map((item) => meetingAnalysisCommitmentProof("decision", item)),
    ...(Array.isArray(artifact?.action_items) ? artifact.action_items : [])
      .map((item) => meetingAnalysisCommitmentProof("action", item)),
  ]).sort();
}

function trustedMeetingCommitmentProofs(meeting) {
  const currentSignature = meetingAnalysisSourceSignature(meeting.segments || []);
  const run = meeting?.analysisRun;
  const publicProof = meeting?.analysis_proof;
  const proofVersion = run?.profile === "meeting-analysis" && run.status === "completed"
    ? run.commitmentProofVersion
    : publicProof?.schema;
  const sourceSignature = run?.profile === "meeting-analysis" && run.status === "completed"
    ? run.sourceSignature
    : publicProof?.source_signature;
  const proofs = run?.profile === "meeting-analysis" && run.status === "completed"
    ? run.commitmentProofs
    : publicProof?.commitment_proofs;
  if (
    proofVersion !== 1
    || sourceSignature !== currentSignature
    || !Array.isArray(proofs)
    || proofs.length > 90
  ) return new Set();
  return new Set(proofs.filter((proof) => /^(?:decision|action):fnv1a32:[0-9a-f]{8}$/u.test(proof)));
}

function missingCriticalFacts(value, transcript) {
  const supported = new Set(meetingCriticalFacts(transcript));
  return meetingCriticalFacts(value).filter((fact) => !supported.has(fact));
}

function meetingCriticalFacts(value) {
  const source = String(value || "").normalize("NFKC").toLocaleLowerCase();
  const general = criticalFingerprint(source).split("|").filter(Boolean);
  const meetingSpecific = source.match(/决定|确认|批准|否决|同意|通过|安排|负责|完成|上线|发布|交付|采用|选择|必须|需要|不得|取消|延期|[零一二两三四五六七八九十百千万亿]+(?:元|人|天|周|月|年|%|个|次|份|台|套)/gu) || [];
  return [...new Set([...general, ...meetingSpecific].map((fact) => comparableText(fact)).filter(Boolean))];
}

function evidenceContainsField(evidence, value) {
  const field = comparableText(value);
  return Boolean(field && comparableText(evidence).includes(field));
}

function evidenceSupportsActionOwner(evidence, value) {
  const owner = String(value || "").trim();
  if (!owner || !evidenceContainsField(evidence, owner)) return false;
  const clause = evidenceClauseContaining(evidence, owner);
  if (!clause || actionEvidenceIsUncertainOrNegative(clause)) return false;
  const escaped = escapeRegExp(owner);
  return new RegExp(`(?:由|让|请|安排|指定)\\s*${escaped}(?:来|去)?|${escaped}\\s*(?:负责|完成|跟进|处理|交付|执行|推进|承担)|\\b${escaped}\\s+(?:will|must|shall|owns?|is\\s+responsible|to\\s+(?:complete|deliver|ship|publish|launch))\\b`, "iu").test(clause);
}

function evidenceSupportsActionDue(evidence, value, taskValue, ownerValue) {
  const due = String(value || "").trim();
  if (!due || !plausibleDueValue(due) || !evidenceContainsField(evidence, due)) return false;
  const clauses = evidenceClauses(evidence);
  const dueKey = comparableText(due);
  const dueIndex = clauses.findIndex((clause) => comparableText(clause).includes(dueKey));
  if (dueIndex < 0) return false;
  const taskKey = comparableText(taskValue);
  const owner = String(ownerValue || "").trim();
  const actionIndexes = clauses.map((clause, index) => ({ clause, index })).filter(({ clause }) => (
    looksLikeConcreteActionEvidence(clause)
    && !actionEvidenceIsUncertainOrNegative(clause)
    && ((taskKey.length >= 2 && comparableText(clause).includes(taskKey))
      || (owner && evidenceSupportsActionOwner(clause, owner)))
  ));
  if (actionIndexes.length !== 1) return false;
  if (actionIndexes[0].index === dueIndex) return true;
  return Math.abs(actionIndexes[0].index - dueIndex) === 1 && standaloneDueClause(clauses[dueIndex], due);
}

function evidenceClauseContaining(evidence, value) {
  const key = comparableText(value);
  return evidenceClauses(evidence)
    .find((clause) => key && comparableText(clause).includes(key)) || "";
}

function evidenceClauses(evidence) {
  return String(evidence || "").split(/[，。；;,.!?！？\n]+/u)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

function standaloneDueClause(clause, due) {
  const remainder = String(clause || "").replace(new RegExp(escapeRegExp(due), "giu"), "")
    .replace(/\s+/gu, "")
    .toLocaleLowerCase();
  return /^(?:截止(?:到)?|到|前|之前|以前|以内|为止|by|before|due)?$/u.test(remainder);
}

const ACTION_VERBS_ZH = "负责|完成|跟进|处理|交付|执行|推进|承担|上线|发布|批准|提交|发送|修复|实现|部署|验证|通知|准备|整理|更新|迁移|申请|采购|签署|支付|联系|预约|召开|输出|同步|汇报";
const ACTION_VERBS_EN = "responsible|complete|deliver|execute|ship|launch|publish|approve|submit|send|fix|implement|deploy|verify|notify|prepare|update|migrate|contact|schedule|report|follow\\s*up";
const CONCRETE_ACTION_PATTERN = new RegExp(`安排|指定|${ACTION_VERBS_ZH}|\\b(?:assign(?:ed)?|${ACTION_VERBS_EN}|will|must|shall)\\b`, "iu");
const NEGATED_ACTION_PATTERN = new RegExp(
  `(?:不|未|没有|并未|尚未|还未|无需|不再|拒绝|取消)\\s*(?:会|将|再|继续|去|来|由[^，。；;,.!?！？\\n]{0,20})?\\s*(?:${ACTION_VERBS_ZH}|安排|指定)|(?:${ACTION_VERBS_ZH}|安排|指定)\\s*(?:不了|不成|失败)|\\b(?:not|never|won't|will\\s+not|would\\s+not|isn't|is\\s+not|aren't|are\\s+not|didn't|did\\s+not|doesn't|does\\s+not|don't|do\\s+not|hasn't|has\\s+not|haven't|have\\s+not|cannot|can't|cancel(?:led)?)\\b.{0,40}\\b(?:${ACTION_VERBS_EN})\\b`,
  "iu",
);
const REJECTED_ACTION_PATTERN = new RegExp(
  `(?:否决|驳回)(?:了)?[^，。；;,.!?！？\n]{0,40}(?:${ACTION_VERBS_ZH})|\b(?:reject(?:s|ed)?|declin(?:e|es|ed))\b.{0,40}\b(?:${ACTION_VERBS_EN})\b`,
  "iu",
);

function looksLikeConcreteActionEvidence(value) {
  return CONCRETE_ACTION_PATTERN.test(String(value || ""));
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function actionEvidenceIsUncertainOrNegative(value) {
  const text = String(value || "");
  if (/[?？]/u.test(text)
    || looksLikeDirectQuestionEvidence(text)
    || commitmentActWasNotMade(text)
    || /如果|假如|若(?:是|果)?|是否|能否|可否|可能|也许|或许|不一定|待定|尚未确定|预计|预期|计划|打算|考虑|未承诺|尚未承诺/u.test(text)
    || /\b(?:if|whether|maybe|perhaps|might|could|possibly|probably|plan(?:s|ned)?\s+to|expect(?:s|ed)?\s+to|intend(?:s|ed)?\s+to|not\s+committed|uncommitted)\b/iu.test(text)) return true;
  return NEGATED_ACTION_PATTERN.test(text) || REJECTED_ACTION_PATTERN.test(text);
}

function looksLikeDirectQuestionEvidence(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  if (/[?？]\s*$/u.test(text) || /(?:吗|嘛|呢|对吗|对不对)[。.!！]*$/u.test(text)) return true;
  if (/\b(?:the\s+)?(?:open\s+)?question\s+(?:is|was|remains?)\s+(?:who|when|which|what|where|whether|why|how)\b/iu.test(text)) return true;
  const hasPredicate = CONCRETE_ACTION_PATTERN.test(text) || looksLikeExplicitDecisionEvidence(text);
  if (!hasPredicate) return false;
  const answeredInClause = /(?:答案|结论)\s*(?:是|为)|(?:已|已经|最终|现已)\s*(?:确认|确定|明确|敲定)(?:\s*(?:由|为)|[^，。；;,.!?！？\n]{0,80}(?:谁|哪位|哪个人|何人|何时|什么时候|哪天|几号)[^，。；;,.!?！？\n]{0,80}(?:[:：]|(?:是|为|由)))/u.test(text)
    || /\b(?:decid(?:e|ed)|confirm(?:ed)?|determin(?:e|ed)|clarif(?:y|ied))\b.{0,80}\b(?:who|when|which|what|where|whether|why|how)\b.{0,80}(?::|\b(?:is|was|will\s+be)\b)/iu.test(text);
  const genericPolicy = /(?:无论|不论|不管)\s*(?:谁|哪位|哪个人|何人).{0,80}都/u.test(text);
  if (!answeredInClause && !genericPolicy) {
    const chineseWh = /谁|哪位|哪个人|何人|何时|什么时候|哪天|几号|什么|哪个|哪种/u;
    if (evidenceClauses(text).some((clause) => (
      chineseWh.test(clause)
      && (CONCRETE_ACTION_PATTERN.test(clause) || looksLikeExplicitDecisionEvidence(clause))
    ))) return true;
    if (/是否|能否|可否|要不要|该不该|是不是/u.test(text)) return true;
    if (/\b(?:discuss(?:ed|es|ing)?|debate(?:d|s|ing)?|wonder(?:ed|s|ing)?|ask(?:ed|s|ing)?|remain(?:s|ed)?\s+(?:unclear|unknown|unresolved)|(?:is|are|was|were)\s+(?:unclear|unknown|unresolved))\b.{0,80}\b(?:who|when|which|what|where|whether|why|how)\b/iu.test(text)) return true;
  }
  return /^\s*(?:(?:so|then|okay|well)\s+)?(?:who|when|which|what|where|why|how)\b\s+(?:will|would|can|could|should|is|are|do|does|did|has|have)\b/iu.test(text)
    || /^\s*(?:(?:so|then|okay|well)\s+)?(?:will|would|can|could|should|is|are|do|does|did|has|have)\b\s+[^\s,.!?]+\s+/iu.test(text);
}

function commitmentActWasNotMade(value) {
  const text = String(value || "");
  const chinesePendingDecision = /(?:还|仍|尚)?\s*(?:需要|需)\s*(?:(?:就|对|针对)[^，。；;,.!?！？\n]{0,40}(?:作出|做出|形成|达成)\s*|(?:作出|做出|形成|达成)\s*)?(?:决定|决策|确认|承诺|敲定|同意|批准|通过|安排|指定)/u.test(text);
  const chinesePostposedAbsence = /(?:最终\s*)?(?:决定|决策|确认|承诺|同意|批准|通过|安排|指定)\s*(?:仍|还|尚|暂)?\s*(?:未|没有|并未)\s*(?:最终\s*)?(?:作出|做出|形成|达成|完成|明确|敲定)/u.test(text);
  return /(?:没有|并没有|还没有|还没|尚未|暂未|并未|未能|尚无|暂无)\s*(?:最终\s*)?(?:(?:作出|做出|形成|达成)\s*)?(?:决定|决策|确认|承诺|敲定|同意|批准|通过|安排|指定)|未\s*(?:最终\s*)?(?:作出|做出|形成|达成)\s*(?:决定|决策|确认|承诺|敲定|同意|批准|通过|安排|指定)|(?:没有人|没人|无人)\s*(?:决定|确认|承诺|同意|批准|安排|指定)|(?:不|未)\s*(?:决定|确认|承诺|敲定)/u.test(text)
    || chinesePendingDecision
    || chinesePostposedAbsence
    || /\b(?:(?:(?:did|do|does|has|have|had|is|are|was|were)\s+not|(?:didn't|doesn't|don't|hasn't|haven't|hadn't|isn't|aren't|wasn't|weren't))\s+(?:yet\s+)?(?:been\s+)?(?:decid(?:e|ed)|confirm(?:ed)?|commit(?:ted)?|agree(?:d)?|approv(?:e|ed)|assign(?:ed)?)|not\s+(?:yet\s+)?(?:decided|confirmed|committed|agreed|approved|assigned)|no\s+(?:final\s+)?(?:decision|confirmation|commitment|agreement|approval|assignment)|(?:nobody|no\s+one).{0,40}\b(?:decid(?:e|ed)|confirm(?:ed)?|commit(?:ted)?|agree(?:d)?|approv(?:e|ed)|assign(?:ed)?|will)|never\s+(?:decid(?:e|ed)|confirm(?:ed)?|commit(?:ted)?|agree(?:d)?|approv(?:e|ed)|assign(?:ed)?)|(?:have|has|had)\s+yet\s+to\s+(?:decide|confirm|commit|agree|approve|assign)|(?:fail(?:s|ed)?\s+to|(?:still\s+)?need(?:s|ed)?\s+to)\s+(?:decide|confirm|commit|agree|approve|assign)|(?:must|should)\s+decide|(?:decision|confirmation|commitment|agreement|approval|assignment)\s+(?:is|remains?)\s+(?:pending|unresolved)|remains?\s+(?:undecided|unconfirmed|uncommitted))\b/iu.test(text);
}

function looksLikeAffirmativeActionEvidence(value) {
  const text = String(value || "");
  return looksLikeConcreteActionEvidence(text)
    && looksLikeCommittedActionEvidence(text)
    && !decisionEvidenceIsUncertainOrUnresolved(text)
    && !actionEvidenceIsUncertainOrNegative(text);
}

function looksLikeCommittedActionEvidence(value) {
  const text = String(value || "");
  return looksLikeExplicitDecisionEvidence(text)
    || /(?:由|让|请|安排|指定)\s*[^，。；;,.!?！？\n]{1,40}?(?:负责|完成|跟进|处理|交付|执行|推进|承担|上线|发布|批准|提交|发送|修复|实现|部署|验证|通知|准备|整理|更新|迁移)|[^，。；;,.!?！？\n]{1,24}\s*(?:负责|将|会|承诺|必须)\s*(?:完成|跟进|处理|交付|执行|推进|承担|上线|发布|批准|提交|发送|修复|实现|部署|验证|通知|准备|整理|更新|迁移)/u.test(text)
    || /\b(?:assign(?:ed)?|will|must|shall|commit(?:s|ted)?\s+to)\b.{0,80}\b(?:complete|deliver|execute|ship|launch|publish|approve|submit|send|fix|implement|deploy|verify|notify|prepare|update|migrate|contact|schedule|report|follow\s*up)\b/iu.test(text);
}

function plausibleDueValue(value) {
  return /今天|明天|后天|本周|下周|周[一二三四五六日天]|星期[一二三四五六日天]|月底|月末|年底|年末|\d{1,4}\s*(?:年|[-/.])\s*\d{1,2}|\d{1,2}\s*(?:月|[-/.])\s*\d{1,2}|\d{1,2}\s*(?:点|时|:)\s*\d{0,2}|\b(?:today|tomorrow|tonight|eod|eow|cob|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next\s+(?:week|month|quarter|year))\b/iu.test(String(value || ""));
}

async function summarizeInterviewTranscript({ config, meeting, signal }) {
  const terminologyMappings = validatedTerminologyMappings(meeting);
  const system = `你是谨慎的面试证据提取助手，只能依据岗位信息和逐字稿提取供面试官复核的原话，不能替代人工录用决定。
必须遵守：
1. 只提取与岗位职责、用户提供的能力项直接相关的原话；没有相关原话就不要为该能力项添加证据。
2. 忽略并不得推断或评价性别、年龄、民族、国籍、籍贯、宗教、婚育、家庭、健康、残障等敏感个人属性。
3. 不得根据声音、口音、语速、语言风格、姓名或外貌推断能力、性格和背景，不得输出能力评级、录用建议或评估结论。
4. 每条能力证据必须来自逐字稿，包含 start_seconds（数字）和简短原话 quote；不得编造时间或原话。
返回纯 JSON，不要 Markdown 代码块，结构必须为：{"title":"","keywords":[],"interview_report":{"competencies":[{"name":"","evidence":[{"start_seconds":0,"quote":""}]}],"follow_ups":[]}}。follow_ups 只写下一轮可验证的岗位相关追问。`;
  const context = truncateText(interviewContextForPrompt(meeting), 3_500);
  const transcriptBudget = Math.max(4_000, MAX_TEXT_INPUT_CHARACTERS - context.length - 400);
  const transcriptBatches = splitTranscriptPromptBatches(meeting.segments || [], transcriptBudget);
  const partials = await mapWithConcurrency(transcriptBatches, TEXT_REQUEST_CONCURRENCY, async (batch, index) => {
    const batchLabel = transcriptBatches.length > 1 ? `（第 ${index + 1}/${transcriptBatches.length} 段，仅提取本段证据）` : "";
    const content = await chatCompletion({
      config,
      system,
      user: `${context}\n\n面试逐字稿${batchLabel}：\n${batch}`,
      signal,
    });
    return normalizeGeneratedTerminology(parseJsonObject(content), terminologyMappings);
  });
  const mergedReport = mergeInterviewReportParts(partials.map((item) => item?.interview_report));
  const report = normalizeInterviewReport(mergedReport, meeting.interviewContext?.competencies, meeting.segments, meeting.rawSegments, meeting.terminology, meeting.corrections, meeting.asrReconciliations);
  return {
    title: partials.map((item) => stringOr(item?.title, "")).find(Boolean) || "",
    summary: report.overview,
    keywords: uniqueStrings(partials.flatMap((item) => stringArray(item?.keywords))).slice(0, 60),
    highlights: [],
    speaker_summaries: [],
    decisions: [],
    decision_records: [],
    action_items: [],
    interviewReport: report,
  };
}

export async function correctTranscript({ config, meeting, signal, transcribeAudioRange }) {
  if (textProtocol(config) === "responses") {
    try {
      return await correctTranscriptWithAgent({ config, meeting, signal, transcribeAudioRange });
    } catch (error) {
      if (!agentToolsUnsupported(error) && !agentToolsIgnored(error)) throw error;
      const result = await correctTranscriptWithWorkflow({ config, meeting, signal });
      return {
        ...result,
        agentRun: {
          id: error.agentTrace?.[0]?.run_id || "",
          profile: "terminology-supervisor",
          model: config.chatModel.trim(),
          status: "unsupported",
          usage: error.agentUsage || {},
          ...(error.canonicalReview ? { canonicalReview: error.canonicalReview } : {}),
          trace: error.agentTrace || [],
        },
      };
    }
  }
  return correctTranscriptWithWorkflow({ config, meeting, signal });
}

async function correctTranscriptWithWorkflow({ config, meeting, signal }) {
  const original = correctionSourceSegments(meeting);
  if (!original.length) return { segments: [], terminology: [], rejectedCorrections: 0, semanticJoins: 0, corrections: [] };
  const batches = splitSegmentBatches(original, 8_000);
  const fullContext = String(config.contextHint || "");
  const sharedContext = truncateText(fullContext, MAX_CORRECTION_CONTEXT_CHARACTERS);
  const terminologyContext = parseTerminologyContext(fullContext);
  if (terminologyContext.overflow) {
    throw new Error(`术语配置超过 ${MAX_TERMINOLOGY_ENTRIES} 项，请精简后重试；逐字稿原文不受影响`);
  }
  if (meeting.mode === "interview") {
    terminologyContext.canonicalTerms.push(meeting.interviewContext?.role || "", ...stringArray(meeting.interviewContext?.competencies));
  }
  terminologyContext.canonicalTerms = uniqueStrings(terminologyContext.canonicalTerms);
  terminologyContext.canonicalKeys = new Set(terminologyContext.canonicalTerms.map(correctionText).filter(Boolean));
  const explicitMappings = [...terminologyContext.aliasMappings.values()].map((item) => `${item.alias} -> ${item.canonical}`);
  const mappedCanonicalKeys = new Set([...terminologyContext.aliasMappings.values()].map((item) => correctionText(item.canonical)));
  const unaliasedCanonicalTerms = terminologyContext.canonicalTerms.filter((term) => !mappedCanonicalKeys.has(correctionText(term)));
  const terminologyPrompt = `程序会在整段录音中全量应用的明确别名映射：\n${explicitMappings.join("\n") || "无"}\n\n仅有规范词、没有明确别名的候选（只有同一实体在录音中重复出现并通过全局一致性校验时才会接受）：\n${unaliasedCanonicalTerms.join("、") || "无"}`;
  if (terminologyPrompt.length > MAX_TERMINOLOGY_PROMPT_CHARACTERS) {
    throw new Error("术语配置过长，无法在不截断映射的情况下安全发送；请精简术语表后重试，逐字稿原文不受影响");
  }
  let nextSegmentId = 0;
  const jobs = batches.map((batch) => {
    const batchStartId = nextSegmentId;
    nextSegmentId += batch.length;
    return { batch, batchStartId };
  });
  const responses = await mapWithConcurrency(jobs, TEXT_REQUEST_CONCURRENCY, async ({ batch, batchStartId }) => {
    const input = batch.map((segment, localIndex) => ({
      id: batchStartId + localIndex,
      speaker: segment.speaker || "发言人",
      text: segment.text,
    }));
    const following = original[batchStartId + batch.length];
    const payload = { segments: input };
    if (following) {
      payload.following_segment = {
        id: batchStartId + batch.length,
        speaker: following.speaker || "发言人",
        text: truncateText(following.text, MAX_BOUNDARY_PREVIEW_CHARACTERS),
      };
    }
    const serializedInput = JSON.stringify(payload);
    if (serializedInput.length > MAX_CORRECTION_BATCH_JSON_CHARACTERS) {
      return {
        batch,
        batchStartId,
        patches: [],
        joinAfter: new Set(),
        preliminaryCorrections: batch.map((segment, localIndex) => correctionLedgerEntry({
          segmentId: batchStartId + localIndex,
          segment,
          status: "rejected",
          reason: "segment_too_large",
        })),
      };
    }
    const interviewRules = meeting.mode === "interview" ? "这是面试逐字稿。不得依据声音、口音、姓名或敏感个人属性推断角色。" : "";
    const system = `你是逐字稿校对中的术语候选提取器与断句助手。只找可能需要统一的专有名词，并判断固定时长切片边界是否截断了同一句话；不得总结、改写、删减或添加事实。${interviewRules}同一录音里指向同一实体的不同写法必须使用同一个正确 canonical；优先采用用户提供的规范词，没有规范词时只对重复出现且有把握的技术名词给出通行的正确拼写。只返回最小补丁和结构信号，不得返回完整逐字稿、segments、speaker 或时间信息。必须返回纯 JSON：{"patches":[{"id":数字,"replacements":[{"from":"片段中的原文","to":"统一后的 canonical"}]}],"join_after":[数字]}。from 必须是对应片段中的原样子串；同一 from 在片段中出现多次时只需列一次，程序会在整段录音中全量匹配。join_after 只包含语义明显未完成、下一相邻片段是同一句直接续接的当前片段 id；完整句、同一话题但不同句、不同发言人都不得连接。没有候选时返回 {"patches":[],"join_after":[]}。`;
    const context = meeting.mode === "interview"
      ? `${truncateText(interviewContextForPrompt(meeting), 3_000)}\n\n通用背景 / 专有名词：\n${sharedContext || "未提供"}`
      : `会议背景 / 术语表：\n${sharedContext || "未提供"}`;
    const user = `${context}\n\n${terminologyPrompt}\n\n待检查片段：\n${serializedInput}`;
    if (user.length > MAX_TEXT_INPUT_CHARACTERS) {
      throw new Error("术语、面试背景与逐字稿片段合计过长，无法安全发送校正请求；请精简配置后重试");
    }
    const content = await chatCompletion({ config, system, user, signal });
    const parsed = parseJsonObject(content);
    if (!Array.isArray(parsed?.patches)) {
      throw new Error("术语校正响应格式无效：缺少 patches 数组，已保留原逐字稿");
    }
    const scoped = scopeCorrectionPatches(parsed.patches, batchStartId, batch.length);
    const joinAfter = new Set((Array.isArray(parsed.join_after) ? parsed.join_after : [])
      .map(Number)
      .filter((id) => Number.isInteger(id) && id >= batchStartId && id < batchStartId + batch.length));
    return {
      batch,
      batchStartId,
      patches: scoped.patches,
      joinAfter,
      preliminaryCorrections: scoped.rejections,
    };
  });
  inferRecordingAliasMappings(
    original,
    responses.flatMap((response) => response.patches),
    terminologyContext,
    meeting.corrections,
  );
  const results = responses.map(({ batch, batchStartId, patches, joinAfter, preliminaryCorrections }) => {
    const unresolved = unresolvedCorrectionPatches(patches, terminologyContext);
    const globalPatches = recordingMappingPatches(batch, batchStartId, terminologyContext);
    const result = applyCorrectionPatches(batch, batchStartId, mergeCorrectionPatches(unresolved, globalPatches), terminologyContext);
    result.corrections = [...preliminaryCorrections, ...result.corrections];
    result.segments = result.segments.map((segment, localIndex) => ({
      ...segment,
      join_next: joinAfter.has(batchStartId + localIndex),
    }));
    return result;
  });
  const corrections = results.flatMap((result) => result.corrections);
  const normalized = normalizeSemanticJoins(results.flatMap((result) => result.segments), original);
  return {
    segments: normalized,
    terminology: uniqueStrings(results.flatMap((result) => result.terminology)).slice(0, MAX_TERMINOLOGY_ENTRIES),
    rejectedCorrections: corrections.filter((item) => item.status === "rejected").length,
    semanticJoins: normalized.filter((segment) => segment.join_next === true).length,
    corrections,
  };
}

async function correctTranscriptWithAgent({ config, meeting, signal, transcribeAudioRange }) {
  const original = correctionSourceSegments(meeting);
  if (!original.length) {
    return { segments: [], terminology: [], rejectedCorrections: 0, semanticJoins: 0, corrections: [], agentRun: null };
  }
  if (!config.chatModel?.trim()) throw new Error("请先填写文本模型名称");
  const fullContext = String(config.contextHint || "");
  const terminologyContext = parseTerminologyContext(fullContext);
  if (terminologyContext.overflow) {
    throw new Error(`术语配置超过 ${MAX_TERMINOLOGY_ENTRIES} 项，请精简后重试；逐字稿原文不受影响`);
  }
  if (meeting.mode === "interview") {
    terminologyContext.canonicalTerms.push(meeting.interviewContext?.role || "", ...stringArray(meeting.interviewContext?.competencies));
  }
  terminologyContext.canonicalTerms = uniqueStrings(terminologyContext.canonicalTerms);
  terminologyContext.canonicalKeys = new Set(terminologyContext.canonicalTerms.map(correctionText).filter(Boolean));

  const scanOccurrences = (alias, canonical) => recordingAliasOccurrences(original, alias, canonical);
  const reusableMappings = validatedTerminologyMappings(meeting)
    .filter((mapping) => correctionText(mapping.alias) !== correctionText(mapping.canonical));
  const explicitProfileMappings = [...terminologyContext.aliasMappings.values()]
    .map(({ alias, canonical }) => ({ alias, canonical }));
  const explicitAliasKeys = new Set(explicitProfileMappings.map((mapping) => correctionText(mapping.alias)));
  const priorProfileMappings = uniqueItems(
    reusableMappings.filter((mapping) => !explicitAliasKeys.has(correctionText(mapping.alias))),
    mappingKeyForAgent,
  );
  const profileContext = meeting.mode === "interview"
    ? `${truncateText(interviewContextForPrompt(meeting), 3_000)}\n\n通用背景 / 专有名词：\n${truncateText(fullContext, MAX_CORRECTION_CONTEXT_CHARACTERS) || "未提供"}`
    : truncateText(fullContext, MAX_CORRECTION_CONTEXT_CHARACTERS);
  const canonicalReviews = await reviewTerminologyCanonicals({
    config,
    segments: original,
    contextHint: profileContext,
    canonicalTerms: terminologyContext.canonicalTerms,
    explicitMappings: explicitProfileMappings,
    signal,
  });
  const finalizationTerminologyContext = cloneTerminologyContext(terminologyContext);
  finalizationTerminologyContext.reviewedCanonicalKeys = new Set();
  for (const review of canonicalReviews.reviews) {
    if (review.confidence !== "high") continue;
    const canonical = String(review.canonical || "").trim();
    const canonicalKey = correctionText(canonical);
    if (!canonical || !canonicalKey) continue;
    finalizationTerminologyContext.canonicalTerms.push(canonical);
    finalizationTerminologyContext.canonicalKeys.add(canonicalKey);
    finalizationTerminologyContext.reviewedCanonicalKeys.add(canonicalKey);
  }
  finalizationTerminologyContext.canonicalTerms = uniqueStrings(finalizationTerminologyContext.canonicalTerms);
  const profile = createTerminologyAgentProfile({
    segments: original,
    contextHint: profileContext,
    canonicalTerms: uniqueStrings(terminologyContext.canonicalTerms),
    explicitMappings: explicitProfileMappings,
    priorMappings: priorProfileMappings,
    canonicalReviews: canonicalReviews.reviews,
    scanOccurrences,
    transcribeAudioRange,
    finalizeMappings: ({ mappings, joinAfter, candidates, audioReviews }) => finalizeAgentCorrection({
      original,
      mappings,
      joinAfter,
      candidates,
      audioReviews,
      terminologyContext: finalizationTerminologyContext,
      correctionLedger: (Array.isArray(meeting.corrections) ? meeting.corrections : [])
        .filter((entry) => entry?.reason === "explicit_alias"),
    }),
  });
  const adapter = createResponsesAdapter({
    model: config.chatModel,
    store: false,
    includeEncryptedReasoning: true,
    request: (body, options) => requestResponsesBody({ config, body, signal: options.signal || signal }),
  });
  const policy = terminologyAgentPolicy(profile);
  let run;
  try {
    run = await runAgent({
      adapter,
      profile,
      input: profile.input,
      initialState: profile.initialState,
      signal,
      policy: {
        ...policy,
        maxIdleTurns: 2,
        maxToolOutputCharacters: 60_000,
      },
    });
  } catch (error) {
    error.agentUsage = combinedTerminologyAgentUsage(error.agentUsage, canonicalReviews.usage);
    error.canonicalReview = terminologyCanonicalReviewMetadata(canonicalReviews);
    throw error;
  }
  const { agentViolations: _agentViolations, ...artifact } = run.result;
  return {
    ...artifact,
    agentRun: {
      id: run.trace[0]?.run_id || "",
      profile: profile.name,
      model: config.chatModel.trim(),
      status: canonicalReviews.status === "degraded" ? "degraded" : "completed",
      usage: combinedTerminologyAgentUsage(run.usage, canonicalReviews.usage),
      canonicalReview: terminologyCanonicalReviewMetadata(canonicalReviews),
      trace: run.trace,
    },
  };
}

function terminologyCanonicalReviewMetadata(review) {
  return {
    status: review.status,
    requestedGroups: review.requestedGroups,
    reviewedGroups: review.reviewedGroups,
    highConfidenceGroups: review.highConfidenceGroups,
    requestAttempted: review.requestAttempted,
    ...(review.budgetLimitedGroups ? { budgetLimitedGroups: review.budgetLimitedGroups } : {}),
    ...(review.incompleteReviewGroups ? { incompleteReviewGroups: review.incompleteReviewGroups } : {}),
    ...(review.unreviewedGroups ? { unreviewedGroups: review.unreviewedGroups } : {}),
    ...(review.reason ? { reason: review.reason } : {}),
  };
}

function terminologyAgentPolicy(profile) {
  const hints = profile?.budgetHints || {};
  const modelTurns = boundedPolicyValue(hints.recommendedModelTurns, 24, 64, 24);
  const readTurns = boundedPolicyValue(hints.readTurns, 0, 64, 0);
  const sourceCharacters = Math.max(0, Number(hints.sourceCharacters) || 0);
  const inputCharacters = String(profile?.input || "").length;
  return {
    maxModelTurns: modelTurns,
    maxToolCalls: boundedPolicyValue(readTurns + 24, 64, 128, 64),
    maxHistoryCharacters: boundedPolicyValue(
      inputCharacters + sourceCharacters + (modelTurns * 20_000) + 100_000,
      500_000,
      2_000_000,
      500_000,
    ),
    maxTotalTokens: boundedPolicyValue(modelTurns * 50_000, 100_000, 2_000_000, 100_000),
    maxRunMilliseconds: boundedPolicyValue(modelTurns * 15_000, 300_000, 900_000, 300_000),
  };
}

function boundedPolicyValue(value, minimum, maximum, fallback) {
  const number = Math.ceil(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, number));
}

async function reviewTerminologyCanonicals({
  config,
  segments,
  contextHint,
  canonicalTerms,
  explicitMappings,
  signal,
}) {
  const skipped = {
    reviews: [],
    status: "skipped",
    requestedGroups: 0,
    reviewedGroups: 0,
    highConfidenceGroups: 0,
    requestAttempted: false,
    usage: {},
  };
  if (config.canonicalArbitration === false) return skipped;
  const inventory = createTerminologyCanonicalReviewInventory({
    segments,
    canonicalTerms,
    explicitMappings,
  });
  const groups = inventory
    .slice(0, MAX_CANONICAL_REVIEW_GROUPS)
    .map((item) => ({
      signal_id: item.id,
      required_disposition: item.required_disposition,
      variants: item.terms.map((term) => ({
        text: term.text,
        occurrence_count: term.occurrence_count,
      })),
    }));
  if (!groups.length) return skipped;

  const perspectives = ["official_registry", "false_friend_critic", "naming_morphology"];
  let confirmationBudget = MAX_CANONICAL_REVIEW_CONFIRMATIONS;
  const plans = groups.map((group) => {
    const requiredVotes = canonicalReviewNeedsConsensus(group) ? 3 : 1;
    const scheduledVotes = requiredVotes === 3 && confirmationBudget >= 2 ? 3 : 1;
    if (scheduledVotes === 3) confirmationBudget -= 2;
    return { group, requiredVotes, scheduledVotes };
  });
  const jobs = plans.flatMap(({ group, scheduledVotes }) => (
    Array.from({ length: scheduledVotes }, (_, voteIndex) => ({ group, voteIndex, perspective: perspectives[voteIndex] }))
  ));
  const reviewOutcome = async ({ group, voteIndex, perspective }) => {
    try {
      const response = await chatCompletionResult({
        config,
        system: `You are an independent canonical-spelling arbiter for one established public technical identifier. Infer its exact official identifier from the domain and noisy ASR surface variants. Evaluate this signal in isolation; other groups are intentionally absent. Do not vote by frequency and do not trust a spelling merely because it looks like CamelCase. Distinguish an official product, project, API, protocol, or component name from ordinary phrases. Use high confidence only when the exact public spelling and capitalization are well established; use medium or low for proprietary, ambiguous, or uncertain names. Return pure JSON only: {"reviews":[{"signal_id":"surface-1","canonical":"ExactIdentifier","confidence":"high|medium|low","rationale":"brief spelling basis"}]}. Return exactly one review for the supplied signal_id and never add transcript facts.`,
        user: JSON.stringify({
          domain_context: truncateText(contextHint, MAX_CANONICAL_REVIEW_CONTEXT_CHARACTERS),
          surface_variant_group: group,
          independent_review_perspective: perspective,
        }),
        signal,
        maxOutputTokens: MAX_CANONICAL_REVIEW_OUTPUT_TOKENS,
      });
      const parsed = parseJsonObject(response.content);
      const candidate = (Array.isArray(parsed?.reviews) ? parsed.reviews : [])
        .find((review) => String(review?.signal_id || "").trim() === group.signal_id);
      const canonical = String(candidate?.canonical || "").trim();
      const confidence = String(candidate?.confidence || "").trim().toLocaleLowerCase("en-US");
      const review = canonical
        && canonical.length <= MAX_TERMINOLOGY_ENTRY_CHARACTERS
        && ["high", "medium", "low"].includes(confidence)
        ? { ...candidate, signal_id: group.signal_id, canonical, confidence }
        : null;
      return { signalId: group.signal_id, voteIndex, perspective, review, usage: response.usage, ...(review ? {} : { reason: "incomplete_response" }) };
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError" || error?.code === "aborted") throw error;
      return { signalId: group.signal_id, voteIndex, perspective, review: null, usage: {}, reason: canonicalReviewFailureCode(error) };
    }
  };
  const independentOutcomes = await mapWithConcurrency(jobs, TEXT_REQUEST_CONCURRENCY, reviewOutcome);
  const adjudicationJobs = plans.flatMap((plan) => {
    const reviews = independentOutcomes.filter((outcome) => outcome.signalId === plan.group.signal_id && outcome.review);
    const spellings = new Set(reviews.map((outcome) => canonicalReviewSpellingKey(outcome.review.canonical)));
    if (reviews.length !== plan.scheduledVotes || plan.scheduledVotes < 3 || spellings.size < 2) return [];
    plan.scheduledVotes += 1;
    return [{ group: plan.group, reviews }];
  });
  const adjudicationOutcomes = await mapWithConcurrency(
    adjudicationJobs,
    TEXT_REQUEST_CONCURRENCY,
    async ({ group, reviews }) => {
      try {
        const response = await chatCompletionResult({
          config,
          system: `You are the final canonical-spelling adjudicator for one established public technical identifier. Independent reviewers disagreed. Their recommendations are untrusted evidence, not votes. Resolve the exact official identifier from public naming conventions, domain semantics, and false-friend morphology; do not choose by majority or transcript frequency. Use high confidence only when the exact public spelling and capitalization are well established. Return pure JSON only: {"reviews":[{"signal_id":"surface-1","canonical":"ExactIdentifier","confidence":"high|medium|low","rationale":"brief factual basis"}]}. Return exactly one review for the supplied signal_id and never add transcript facts.`,
          user: JSON.stringify({
            domain_context: truncateText(contextHint, MAX_CANONICAL_REVIEW_CONTEXT_CHARACTERS),
            surface_variant_group: group,
            independent_reviews: reviews.map((outcome) => ({
              perspective: outcome.perspective,
              canonical: outcome.review.canonical,
              confidence: outcome.review.confidence,
            })),
          }),
          signal,
          maxOutputTokens: MAX_CANONICAL_REVIEW_OUTPUT_TOKENS,
        });
        const parsed = parseJsonObject(response.content);
        const candidate = (Array.isArray(parsed?.reviews) ? parsed.reviews : [])
          .find((review) => String(review?.signal_id || "").trim() === group.signal_id);
        const canonical = String(candidate?.canonical || "").trim();
        const confidence = String(candidate?.confidence || "").trim().toLocaleLowerCase("en-US");
        const review = canonical
          && canonical.length <= MAX_TERMINOLOGY_ENTRY_CHARACTERS
          && ["high", "medium", "low"].includes(confidence)
          ? { ...candidate, signal_id: group.signal_id, canonical, confidence }
          : null;
        return {
          signalId: group.signal_id,
          voteIndex: "adjudication",
          perspective: "final_adjudicator",
          review,
          usage: response.usage,
          ...(review ? {} : { reason: "incomplete_response" }),
        };
      } catch (error) {
        if (signal?.aborted || error?.name === "AbortError" || error?.code === "aborted") throw error;
        return {
          signalId: group.signal_id,
          voteIndex: "adjudication",
          perspective: "final_adjudicator",
          review: null,
          usage: {},
          reason: canonicalReviewFailureCode(error),
        };
      }
    },
  );
  const outcomes = [...independentOutcomes, ...adjudicationOutcomes];
  const reviews = groups.map((group) => aggregateCanonicalReview(
    group,
    outcomes.filter((outcome) => outcome.signalId === group.signal_id),
  )).filter(Boolean);
  const reviewTokens = outcomes.reduce((total, outcome) => total + Math.max(0, Number(outcome.usage?.modelTokens) || 0), 0);
  const budgetLimitedGroups = plans.filter((plan) => plan.scheduledVotes < plan.requiredVotes).length;
  const incompleteReviewGroups = plans.filter((plan) => (
    outcomes.filter((outcome) => outcome.signalId === plan.group.signal_id && outcome.review).length < plan.scheduledVotes
  )).length;
  const unreviewedGroups = Math.max(0, inventory.length - groups.length);
  const complete = reviews.length === groups.length
    && budgetLimitedGroups === 0
    && incompleteReviewGroups === 0
    && unreviewedGroups === 0;
  const reason = unreviewedGroups
    ? "group_budget_exhausted"
    : (outcomes.find((outcome) => outcome.reason)?.reason
      || (budgetLimitedGroups ? "confirmation_budget_exhausted" : "incomplete_response"));
  return {
    reviews,
    status: complete ? "completed" : "degraded",
    requestedGroups: inventory.length,
    reviewedGroups: reviews.length,
    highConfidenceGroups: reviews.filter((review) => review.confidence === "high").length,
    requestAttempted: true,
    ...(budgetLimitedGroups ? { budgetLimitedGroups } : {}),
    ...(incompleteReviewGroups ? { incompleteReviewGroups } : {}),
    ...(unreviewedGroups ? { unreviewedGroups } : {}),
    usage: { modelTurns: outcomes.length, ...(reviewTokens ? { modelTokens: reviewTokens } : {}) },
    ...(complete ? {} : { reason }),
  };
}

function canonicalReviewNeedsConsensus(group) {
  return group?.required_disposition === "mapped"
    || (Array.isArray(group?.variants) && group.variants.some((variant) => canonicalReviewIdentifierLike(variant?.text)));
}

function canonicalReviewIdentifierLike(value) {
  const text = String(value || "").normalize("NFKC");
  return /[_-]/u.test(text)
    || /[a-z][A-Z]/u.test(text)
    || /[A-Z]{2,}|[0-9+#]/u.test(text);
}

function canonicalReviewSpellingKey(value) {
  return String(value || "").normalize("NFKC").trim();
}

function aggregateCanonicalReview(group, outcomes) {
  const adjudication = outcomes.find((outcome) => outcome.voteIndex === "adjudication")?.review;
  if (adjudication) return adjudication;
  const independentOutcomes = outcomes.filter((outcome) => outcome.voteIndex !== "adjudication");
  const votes = independentOutcomes.map((outcome) => outcome.review).filter(Boolean);
  if (!votes.length) return null;
  if (independentOutcomes.length < 3) {
    const vote = votes[0];
    return vote.confidence === "high" ? {
      ...vote,
      confidence: "medium",
      rationale: `A single spelling review cannot establish canonical authority. ${String(vote.rationale || "").trim()}`.trim(),
    } : vote;
  }
  const byCanonical = new Map();
  for (const vote of votes) {
    const key = String(vote.canonical || "").normalize("NFKC").trim();
    if (!byCanonical.has(key)) byCanonical.set(key, []);
    byCanonical.get(key).push(vote);
  }
  if (
    votes.length === independentOutcomes.length
    && byCanonical.size === 1
    && votes.every((vote) => vote.confidence === "high")
  ) return votes[0];
  const winner = [...byCanonical.values()].sort((left, right) => right.length - left.length)[0] || [];
  const fallback = winner[0] || votes[0];
  return {
    ...fallback,
    signal_id: group.signal_id,
    confidence: fallback.confidence === "low" ? "low" : "medium",
    rationale: `Independent canonical reviews did not reach a high-confidence majority. ${String(fallback.rationale || "").trim()}`.trim(),
  };
}

function canonicalReviewFailureCode(error) {
  const status = Number(error?.status);
  if (Number.isInteger(status) && status >= 400 && status <= 599) return `http_${status}`;
  const code = String(error?.code || "").trim();
  return ["timeout", "network-or-cors", "response-interrupted"].includes(code) ? code : "request_failed";
}

function combinedTerminologyAgentUsage(agentUsage, reviewUsage) {
  const reviewTurns = Math.max(0, Number(reviewUsage?.modelTurns) || 0);
  if (!reviewTurns) return agentUsage;
  const reviewTokens = Math.max(0, Number(reviewUsage?.modelTokens) || 0);
  const agentTokens = Math.max(0, Number(agentUsage?.modelTokens) || 0);
  return {
    ...agentUsage,
    modelTurns: Math.max(0, Number(agentUsage?.modelTurns) || 0) + reviewTurns,
    ...(reviewTokens || agentTokens ? { modelTokens: reviewTokens + agentTokens } : {}),
    canonicalReviewTurns: reviewTurns,
    ...(reviewTokens ? { canonicalReviewTokens: reviewTokens } : {}),
  };
}

function mappingKeyForAgent(mapping) {
  return `${agentMappingAliasKey(mapping?.alias)}=>${String(mapping?.canonical || "").normalize("NFKC").trim()}`;
}

function agentMappingAliasKey(value) {
  return String(value || "").normalize("NFKC").trim().toLocaleLowerCase("en-US").replace(/[\s\p{Pd}_]+/gu, "");
}

function recordingAliasOccurrences(segments, alias, canonical) {
  const occurrences = [];
  segments.forEach((segment, segmentId) => {
    if (occurrences.length >= 500) return;
    const text = String(segment?.text || "");
    for (const range of normalizedMatchRanges(text, alias, canonical)) {
      if (occurrences.length >= 500) break;
      occurrences.push({
        segment_id: segmentId,
        start_offset: range.start,
        end_offset: range.end,
        matched_text: text.slice(range.start, range.end),
      });
    }
  });
  return occurrences;
}

function finalizeAgentCorrection({ original, mappings, joinAfter, candidates, audioReviews, terminologyContext, correctionLedger }) {
  const workingTerminologyContext = cloneTerminologyContext(terminologyContext);
  authorizeAgentSemanticAliases({
    original,
    mappings,
    candidates,
    audioReviews,
    terminologyContext: workingTerminologyContext,
  });
  const proposedBySegment = new Map();
  for (const mapping of mappings) {
    for (const occurrence of recordingAliasOccurrences(original, mapping.alias, mapping.canonical)) {
      if (!proposedBySegment.has(occurrence.segment_id)) proposedBySegment.set(occurrence.segment_id, []);
      const replacements = proposedBySegment.get(occurrence.segment_id);
      const matchedAlias = occurrence.matched_text || mapping.alias;
      if (!replacements.some((item) => correctionText(item.from) === correctionText(matchedAlias))) {
        replacements.push({ from: matchedAlias, to: mapping.canonical });
      }
    }
  }
  const patches = [...proposedBySegment].map(([id, replacements]) => ({ id, replacements }));
  inferRecordingAliasMappings(original, patches, workingTerminologyContext, correctionLedger);

  const joinIds = new Set(joinAfter.filter((id) => Number.isInteger(id) && id >= 0 && id < original.length));
  const batches = splitSegmentBatches(original, 8_000);
  let batchStartId = 0;
  const results = batches.map((batch) => {
    const batchEndId = batchStartId + batch.length;
    const scoped = patches.filter((patch) => patch.id >= batchStartId && patch.id < batchEndId);
    const unresolved = unresolvedCorrectionPatches(scoped, workingTerminologyContext);
    const globalPatches = recordingMappingPatches(batch, batchStartId, workingTerminologyContext);
    const result = applyCorrectionPatches(batch, batchStartId, mergeCorrectionPatches(unresolved, globalPatches), workingTerminologyContext);
    result.segments = result.segments.map((segment, localIndex) => ({
      ...segment,
      join_next: joinIds.has(batchStartId + localIndex),
    }));
    batchStartId = batchEndId;
    return result;
  });
  const corrections = results.flatMap((result) => result.corrections);
  const normalized = normalizeSemanticJoins(results.flatMap((result) => result.segments), original);
  const agentViolations = corrections.filter((item) => item.status === "rejected").map((item) => ({
    code: "runtime_mapping_rejected",
    alias: item.from,
    canonical: item.to,
    reason: item.reason,
    segment_id: item.segmentId,
  }));
  return {
    segments: normalized,
    terminology: uniqueStrings(results.flatMap((result) => result.terminology)).slice(0, MAX_TERMINOLOGY_ENTRIES),
    rejectedCorrections: agentViolations.length,
    semanticJoins: normalized.filter((segment) => segment.join_next === true).length,
    corrections,
    agentViolations,
  };
}

function cloneTerminologyContext(value) {
  return {
    canonicalTerms: [...value.canonicalTerms],
    canonicalKeys: new Set(value.canonicalKeys),
    aliasMappings: new Map([...value.aliasMappings].map(([key, mapping]) => [key, { ...mapping }])),
    conflictingAliases: new Set(value.conflictingAliases),
    reviewedCanonicalKeys: new Set(value.reviewedCanonicalKeys || []),
    overflow: Boolean(value.overflow),
  };
}

function authorizeAgentSemanticAliases({ original, mappings, candidates, audioReviews, terminologyContext }) {
  const groups = new Map();
  for (const mapping of mappings) {
    const canonicalKey = correctionText(mapping.canonical);
    if (!canonicalKey) continue;
    if (!groups.has(canonicalKey)) groups.set(canonicalKey, { canonical: mapping.canonical, mappings: [] });
    groups.get(canonicalKey).mappings.push(mapping);
  }
  let changed = false;
  for (const [canonicalKey, group] of groups) {
    const independentlyReviewed = terminologyContext.reviewedCanonicalKeys.has(canonicalKey);
    if (independentlyReviewed) {
      for (const mapping of group.mappings) {
        if (sameCorrectionSpelling(mapping.alias, group.canonical)) continue;
        const candidate = (Array.isArray(candidates) ? candidates : []).find((item) => (
          item.confidence === "high" && mappingKeyForAgent(item) === mappingKeyForAgent(mapping)
        ));
        if (!candidate) continue;
        const occurrenceIds = new Set(recordingAliasOccurrences(original, mapping.alias, mapping.canonical)
          .map((occurrence) => occurrence.segment_id));
        if (!candidate.evidence_segment_ids.some((id) => occurrenceIds.has(id))) continue;
        const aliasKey = correctionText(mapping.alias);
        if (!aliasKey || terminologyContext.conflictingAliases.has(aliasKey) || terminologyContext.aliasMappings.has(aliasKey)) continue;
        terminologyContext.aliasMappings.set(aliasKey, {
          alias: mapping.alias,
          canonical: group.canonical,
          reason: "recording_consensus",
        });
        changed = true;
      }
      continue;
    }
    if (terminologyContext.canonicalKeys.has(canonicalKey)) continue;
    const anchors = group.mappings.filter((mapping) => plausibleTerminologyPair(mapping.alias, group.canonical));
    if (new Set(anchors.map((mapping) => correctionText(mapping.alias))).size < 2) continue;
    const anchorSegments = new Set(anchors.flatMap((mapping) => (
      recordingAliasOccurrences(original, mapping.alias, mapping.canonical).map((occurrence) => occurrence.segment_id)
    )));
    if (anchorSegments.size < 2) continue;
    for (const mapping of group.mappings) {
      if (plausibleTerminologyPair(mapping.alias, group.canonical)) continue;
      const candidate = (Array.isArray(candidates) ? candidates : []).find((item) => mappingKeyForAgent(item) === mappingKeyForAgent(mapping));
      if (!candidate) continue;
      const evidenceIds = candidate.evidence_segment_ids.filter((id) => Number.isInteger(id));
      const contextAnchored = evidenceIds.some((id) => [...anchorSegments].some((anchorId) => Math.abs(anchorId - id) <= 1));
      const audioBacked = evidenceIds.some((id) => {
        const segment = original[id];
        return segment && (Array.isArray(audioReviews) ? audioReviews : []).some((review) => (
          review?.status === "completed"
          && Array.isArray(review.segment_ids)
          && review.segment_ids.includes(id)
          && Array.isArray(review.signal_terms)
          && review.signal_terms.some((term) => correctionText(term) === correctionText(mapping.alias))
          && audioReviewSupportsMapping(review.evidence_text, mapping)
        ));
      });
      if (!contextAnchored || (candidate.confidence !== "high" && !audioBacked)) continue;
      const aliasKey = correctionText(mapping.alias);
      if (!aliasKey || terminologyContext.conflictingAliases.has(aliasKey) || terminologyContext.aliasMappings.has(aliasKey)) continue;
      terminologyContext.aliasMappings.set(aliasKey, {
        alias: mapping.alias,
        canonical: group.canonical,
        reason: "recording_consensus",
      });
      changed = true;
    }
  }
  if (!changed) return;
  resolveTerminologyMappingGraph(terminologyContext.aliasMappings, terminologyContext.conflictingAliases);
}

function sameCorrectionSpelling(left, right) {
  return String(left || "").normalize("NFKC") === String(right || "").normalize("NFKC");
}

function audioReviewSupportsMapping(evidenceText, mapping) {
  const evidence = correctionText(evidenceText);
  const alias = correctionText(mapping?.alias);
  const canonical = correctionText(mapping?.canonical);
  return Boolean(evidence && (
    (alias && evidence.includes(alias))
    || (canonical && evidence.includes(canonical))
  ));
}

function correctionSourceSegments(meeting) {
  const rawSegments = meeting.rawSegments || [];
  if (!rawSegments.length) return meeting.segments || [];
  const ledger = Array.isArray(meeting.asrReconciliations) ? meeting.asrReconciliations : [];
  const replayed = replayTranscriptReconciliations(rawSegments, ledger);
  if (!replayed) throw new Error("ASR 边界校验记录无效，已停止重新校正并保留当前逐字稿");
  return replayed;
}

export function readableTranscriptSegments(segments = []) {
  return projectReadableTranscriptSegments(segments, false);
}

export function transcriptDisplaySegments(segments = []) {
  return projectReadableTranscriptSegments(segments, true);
}

function projectReadableTranscriptSegments(segments, collapseOverlaps) {
  const readable = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] || {};
    const clean = {
      start_seconds: Math.max(0, Number(segment.start_seconds) || 0),
      end_seconds: Math.max(0, Number(segment.end_seconds) || 0),
      speaker: stringOr(segment.speaker, "发言人"),
      text: stringOr(segment.text, ""),
      ...(collapseOverlaps ? { source_segment_ids: [index] } : {}),
    };
    const previousSource = segments[index - 1];
    const previous = readable[readable.length - 1];
    const overlap = collapseOverlaps && previousSource
      ? displayBoundaryOverlap(previousSource, segment, index - 1, index)
      : null;
    if (overlap) {
      clean.text = overlap.display_text;
      clean.source_text = String(segment.text || "");
      clean.collapsed_overlap = overlap.provenance;
      readable.push(clean);
      continue;
    }
    const joinedText = previous ? joinTranscriptText(previous.text, clean.text) : clean.text;
    const joinedEnd = Math.max(previous?.end_seconds || 0, clean.end_seconds || clean.start_seconds);
    const joinsPrevious = previous
      && !previous.collapsed_overlap
      && previousSource?.join_next === true
      && canJoinTranscriptSegments(previousSource, segment)
      && comparableText(previous.speaker) === comparableText(clean.speaker)
      && joinedText.length <= MAX_READABLE_SEGMENT_CHARACTERS
      && joinedEnd - previous.start_seconds <= MAX_READABLE_SEGMENT_SECONDS;
    if (!joinsPrevious) {
      readable.push(clean);
      continue;
    }
    previous.text = joinedText;
    previous.end_seconds = joinedEnd;
    if (collapseOverlaps) previous.source_segment_ids.push(index);
  }
  return readable.filter((segment) => segment.text || segment.collapsed_overlap);
}

function displayBoundaryOverlap(left, right, leftId, rightId) {
  if (!hasDisplayTemporalOverlap(left, right)) return null;
  if (comparableDisplaySpeaker(left.speaker) !== comparableDisplaySpeaker(right.speaker)) return null;
  const leftText = String(left.text || "");
  const rightText = String(right.text || "");
  const match = exactDisplayBoundaryOverlap(leftText, rightText);
  if (!match) return null;
  if (!startsAtStandaloneDisplayBoundary(leftText, match.left_start_offset)) return null;
  if (unsafeDisplayOverlapLeadingWrapper(rightText, match.right_start_offset)) return null;
  const matchedSource = rightText.slice(match.right_start_offset, match.right_end_offset);
  if (!displayOverlapFitsTemporalWindow(match.normalized_text, matchedSource, left, right)) return null;
  const hiddenEnd = displayOverlapHiddenEnd(rightText, match.right_end_offset);
  if (repeatsDisplayOverlap(rightText.slice(hiddenEnd), match.normalized_text)) return null;
  const visibleRemainder = rightText.slice(hiddenEnd).trim();
  if (visibleRemainder && (
    /^[\p{Punctuation}\p{Mark}\p{Symbol}\p{Other}]/u.test(visibleRemainder)
    || !displayOverlapUnits(visibleRemainder).length
  )) return null;
  if (!displayOverlapContinuationIsSafe(match.normalized_text, matchedSource, visibleRemainder)) return null;
  return {
    display_text: rightText.slice(hiddenEnd).trim(),
    provenance: {
      algorithm_version: DISPLAY_OVERLAP_ALGORITHM_VERSION,
      reason: "exact_normalized_boundary_overlap",
      matched_segment_id: leftId,
      matched_start_offset: match.left_start_offset,
      matched_end_offset: match.left_end_offset,
      source_segment_id: rightId,
      source_start_offset: match.right_start_offset,
      source_end_offset: match.right_end_offset,
      hidden_end_offset: hiddenEnd,
      matched_text: leftText.slice(match.left_start_offset, match.left_end_offset),
      source_text: rightText.slice(match.right_start_offset, match.right_end_offset),
      hidden_text: rightText.slice(0, hiddenEnd),
      normalized_text: match.normalized_text,
    },
  };
}

function hasDisplayTemporalOverlap(left, right) {
  if (!hasVerifiedDisplayTiming(left) || !hasVerifiedDisplayTiming(right)) return false;
  const leftStart = Number(left?.start_seconds);
  const leftEnd = Number(left?.end_seconds);
  const rightStart = Number(right?.start_seconds);
  const rightEnd = Number(right?.end_seconds);
  return Number.isFinite(leftStart)
    && Number.isFinite(leftEnd)
    && Number.isFinite(rightStart)
    && Number.isFinite(rightEnd)
    && leftStart >= 0
    && rightStart >= leftStart
    && leftEnd > leftStart
    && rightEnd > rightStart
    && displayTemporalOverlapSeconds(left, right) >= MIN_DISPLAY_TEMPORAL_OVERLAP_SECONDS;
}

function hasVerifiedDisplayTiming(segment) {
  if (segment?.timing_source === "inferred" || segment?.timing_inferred === true) return false;
  return segment?.timing_source === "provider" || segment?.timing_verified === true;
}

function exactDisplayBoundaryOverlap(leftText, rightText) {
  const leftUnits = displayOverlapUnits(leftText);
  const rightUnits = displayOverlapUnits(rightText);
  if (!leftUnits.length || !rightUnits.length) return null;

  const pattern = rightUnits.map((unit) => unit.value);
  const prefixLengths = displayOverlapPrefixLengths(pattern);
  let length = 0;
  for (let index = 0; index < leftUnits.length; index += 1) {
    const value = leftUnits[index].value;
    while (length > 0 && pattern[length] !== value) length = prefixLengths[length - 1];
    if (pattern[length] === value) length += 1;
    if (length === pattern.length && index < leftUnits.length - 1) length = prefixLengths[length - 1];
  }
  if (!length) return null;

  const leftOffset = leftUnits.length - length;
  if (leftOffset > 0 && leftUnits[leftOffset - 1].start === leftUnits[leftOffset].start) return null;
  if (length < rightUnits.length && rightUnits[length - 1].start === rightUnits[length].start) return null;
  const normalizedText = rightUnits.slice(0, length).map((unit) => unit.value).join("");
  const leftStart = leftUnits[leftOffset].start;
  const leftEnd = leftUnits.at(-1).end;
  const rightStart = rightUnits[0].start;
  const rightEnd = rightUnits[length - 1].end;
  if (
    displayOverlapNormalizedText(leftText.slice(leftStart, leftEnd)) !== normalizedText
    || displayOverlapNormalizedText(rightText.slice(rightStart, rightEnd)) !== normalizedText
    || !strongDisplayOverlap(normalizedText, leftText, rightText, leftStart, leftEnd, rightStart, rightEnd)
  ) return null;
  return {
    left_start_offset: leftStart,
    left_end_offset: leftEnd,
    right_start_offset: rightStart,
    right_end_offset: rightEnd,
    normalized_text: normalizedText,
  };
}

function displayOverlapPrefixLengths(pattern) {
  const lengths = new Array(pattern.length).fill(0);
  for (let index = 1; index < pattern.length; index += 1) {
    let length = lengths[index - 1];
    while (length > 0 && pattern[index] !== pattern[length]) length = lengths[length - 1];
    if (pattern[index] === pattern[length]) length += 1;
    lengths[index] = length;
  }
  return lengths;
}

function displayOverlapUnits(value) {
  const units = [];
  const source = displayGraphemes(value);
  for (let index = 0; index < source.length; index += 1) {
    const item = source[index];
    for (const character of item.value.normalize("NFKC").toLocaleLowerCase()) {
      if (/^[\p{Letter}\p{Number}\p{Mark}\p{Symbol}]$/u.test(character) || character === "\u200d") {
        units.push({ value: character, start: item.start, end: item.end });
        continue;
      }
      const connector = displaySemanticConnector(character, source[index - 1]?.value, source[index + 1]?.value);
      if (connector) units.push({ value: connector, start: item.start, end: item.end });
    }
  }
  return units;
}

function displayGraphemes(value) {
  const text = String(value || "");
  if (DISPLAY_GRAPHEME_SEGMENTER) {
    return [...DISPLAY_GRAPHEME_SEGMENTER.segment(text)].map((item) => ({
      value: item.segment,
      start: item.index,
      end: item.index + item.segment.length,
    }));
  }
  const graphemes = [];
  let offset = 0;
  for (const character of text) {
    if (/^\p{Mark}$/u.test(character) && graphemes.length) {
      graphemes.at(-1).value += character;
      graphemes.at(-1).end += character.length;
    } else {
      graphemes.push({ value: character, start: offset, end: offset + character.length });
    }
    offset += character.length;
  }
  return graphemes;
}

function displaySemanticConnector(character, previous, next) {
  const previousWord = displayWordCharacter(previous);
  const nextWord = displayWordCharacter(next);
  if (/^['’\p{Pd}._/&]$/u.test(character) && previousWord && nextWord) {
    if (character === "’") return "'";
    if (/\p{Pd}/u.test(character)) return "-";
    return character;
  }
  if (DISPLAY_TECHNICAL_CONNECTORS.has(character)
    && (previousWord || nextWord || previous === character || next === character)) return character;
  return "";
}

function displayWordCharacter(value) {
  return /^[\p{Letter}\p{Number}]$/u.test(String(value || "").normalize("NFKC"));
}

function comparableDisplaySpeaker(value) {
  return String(value || "发言人").normalize("NFKC").toLocaleLowerCase().trim().replace(/\s+/gu, " ");
}

function displayOverlapNormalizedText(value) {
  return displayOverlapUnits(value).map((unit) => unit.value).join("");
}

function repeatsDisplayOverlap(value, normalizedText) {
  return displayOverlapNormalizedText(value).includes(normalizedText);
}

function startsAtStandaloneDisplayBoundary(text, start) {
  const prefix = String(text || "").slice(0, start).trimEnd();
  if (!displayOverlapUnits(prefix).length) return true;
  return /[。！？!?؟.][”’"'）)\]]*$/u.test(prefix);
}

function strongDisplayOverlap(normalizedText, leftText, rightText, leftStart, leftEnd, rightStart, rightEnd) {
  if (!normalizedText) return false;
  const matchedLeftSource = leftText.slice(leftStart, leftEnd);
  const matchedSource = rightText.slice(rightStart, rightEnd);
  const leftContext = displayOverlapClauseContext(leftText.slice(0, leftStart));
  const leftTrailingPunctuation = leftText.slice(leftEnd);
  if (
    !sameDisplaySourceText(matchedLeftSource, matchedSource)
    || criticalFingerprint(matchedSource)
    || criticalFingerprint(leftContext)
    || unsafeDisplayOverlapQualifier(leftContext)
    || unsafeDisplayOverlapQualifier(matchedSource)
    || unsafeDisplayOverlapWrapper(leftText, leftStart, leftEnd)
    || /[!?！？؟]/u.test(leftTrailingPunctuation)
  ) return false;
  if (!sameDisplayLexicalSequence(matchedLeftSource, matchedSource)) return false;
  const hasLettersOrNumbers = /[\p{Letter}\p{Number}]/u.test(normalizedText);
  if (hasLettersOrNumbers && (
    !displayLexicalBoundary(leftText, leftStart, "before")
    || !displayLexicalBoundary(rightText, rightEnd, "after")
  )) return false;
  const cjkCount = (normalizedText.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) || []).length;
  if (cjkCount >= MIN_DISPLAY_CJK_OVERLAP_UNITS) return true;
  if (cjkCount > 0) return false;
  const letterCount = (normalizedText.match(/\p{Letter}/gu) || []).length;
  if (letterCount < MIN_DISPLAY_WORD_OVERLAP_UNITS) return false;
  const words = matchedSource.match(/[\p{Letter}\p{Number}]+(?:['’\p{Pd}][\p{Letter}\p{Number}]+)*/gu) || [];
  if (words.length < 2 && letterCount < 12) return false;
  return true;
}

function sameDisplaySourceText(left, right) {
  return String(left || "").normalize("NFC") === String(right || "").normalize("NFC");
}

function unsafeDisplayOverlapWrapper(text, start, end) {
  const leading = String(text || "").slice(0, start).trim();
  const trailing = String(text || "").slice(end).trim();
  if (leading && !displayOverlapUnits(leading).length) return true;
  return Boolean(trailing && !/^[、，。．：；,.:;]$/u.test(trailing));
}

function unsafeDisplayOverlapLeadingWrapper(text, start) {
  const leading = String(text || "").slice(0, start).trim();
  return Boolean(leading && !displayOverlapUnits(leading).length);
}

function displayOverlapContinuationIsSafe(normalizedText, matchedSource, visibleRemainder) {
  if (!visibleRemainder) return true;
  const cjkUnits = (normalizedText.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) || []).length;
  const wordRuns = displayLexicalRuns(matchedSource)
    .filter((run) => /[\p{Letter}\p{Number}]/u.test(run)
      && !/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u.test(run))
    .length;
  return cjkUnits <= 8 && wordRuns <= 4;
}

function displayOverlapClauseContext(value) {
  return String(value || "").split(/[。！？!?\n]/u).at(-1).slice(-200);
}

function sameDisplayLexicalSequence(left, right) {
  const leftRuns = displayLexicalRuns(left);
  const rightRuns = displayLexicalRuns(right);
  return leftRuns.length === rightRuns.length
    && leftRuns.every((run, index) => run === rightRuns[index]);
}

function displayLexicalRuns(value) {
  const runs = [];
  let current = "";
  let previousEnd = -1;
  for (const unit of displayOverlapUnits(value)) {
    if (current && unit.start > previousEnd) {
      runs.push(current);
      current = "";
    }
    current += unit.value;
    previousEnd = Math.max(previousEnd, unit.end);
  }
  if (current) runs.push(current);
  return runs;
}

function unsafeDisplayOverlapQualifier(value) {
  return /(?:如果|若|假如|假设|除非|一旦|倘若|前提是|可能|也许|或许|未必|不一定|是否|能否|可否|要不要|听说|据说|传闻|似乎|好像|看起来|[吗呢么嘛吧]\s*$|\b(?:if|unless|once|when|whenever|provided|assuming|in case|as long as|whether|should|would|may|maybe|might|could|likely|possibly|perhaps|apparently|seemingly|reportedly|allegedly)\b)/iu.test(String(value || ""));
}

function displayOverlapFitsTemporalWindow(normalizedText, matchedSource, left, right) {
  const overlapSeconds = displayTemporalOverlapSeconds(left, right);
  const cjkUnits = (normalizedText.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) || []).length;
  const wordUnits = (normalizedText.match(/[\p{Letter}\p{Number}]/gu) || []).length - cjkUnits;
  const wordRuns = displayLexicalRuns(matchedSource)
    .filter((run) => /[\p{Letter}\p{Number}]/u.test(run)
      && !/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u.test(run))
    .length;
  const minimumSeconds = Math.max(
    cjkUnits / DISPLAY_MAX_CJK_UNITS_PER_SECOND,
    wordUnits / DISPLAY_MAX_OTHER_WORD_UNITS_PER_SECOND,
    wordRuns / DISPLAY_MAX_WORDS_PER_SECOND,
  );
  return minimumSeconds <= overlapSeconds + DISPLAY_OVERLAP_TIMING_TOLERANCE_SECONDS;
}

function displayTemporalOverlapSeconds(left, right) {
  return Math.max(0, Math.min(Number(left?.end_seconds), Number(right?.end_seconds))
    - Math.max(Number(left?.start_seconds), Number(right?.start_seconds)));
}

function displayLexicalBoundary(text, offset, direction) {
  const value = direction === "before" ? text.slice(0, offset) : text.slice(offset);
  const character = direction === "before" ? [...value].at(-1) : [...value][0];
  return !character || !/[\p{Letter}\p{Number}\p{Mark}\p{Other}]/u.test(character);
}

function displayOverlapHiddenEnd(text, matchEnd) {
  const tail = text.slice(matchEnd);
  const leadingSpace = tail.match(/^\s*/u)?.[0] || "";
  const remainder = tail.slice(leadingSpace.length);
  let punctuation = remainder.match(/^[、，。．：；,.:;]/u)?.[0] || "";
  const afterPunctuation = remainder.slice(punctuation.length);
  const punctuationSpace = afterPunctuation.match(/^\s*/u)?.[0] || "";
  if (punctuation && /^[．：；.:;]/u.test(punctuation) && afterPunctuation && !punctuationSpace) {
    punctuation = "";
  }
  const trailingSpace = punctuation
    ? punctuationSpace
    : "";
  return matchEnd + leadingSpace.length + punctuation.length + trailingSpace.length;
}

function publicTranscriptSegments(segments = []) {
  return segments.map((segment) => {
    const timingInferred = segment?.timing_source === "inferred" || segment?.timing_inferred === true;
    const timingVerified = !timingInferred
      && (segment?.timing_source === "provider" || segment?.timing_verified === true);
    return {
      start_seconds: Math.max(0, Number(segment?.start_seconds) || 0),
      end_seconds: Math.max(0, Number(segment?.end_seconds) || 0),
      speaker: stringOr(segment?.speaker, "发言人"),
      text: stringOr(segment?.text, ""),
      ...(timingInferred ? { timing_inferred: true } : {}),
      ...(timingVerified ? { timing_verified: true } : {}),
      ...(segment?.join_next === true ? { join_next: true } : {}),
    };
  }).filter((segment) => segment.text);
}

export async function askTranscript({ config, meeting, question, signal }) {
  const fragments = transcriptPromptFragments(meeting.segments || []);
  if (!fragments.length) throw new Error("当前记录还没有逐字稿");
  const interview = meeting.mode === "interview";
  const questionText = truncateText(question, 2_000);
  const context = interview ? `${truncateText(interviewContextForPrompt(meeting), 3_000)}\n\n` : "";
  const fullTranscript = fragments.map((item) => item.line).join("\n");
  const fullPrefix = `${context}逐字稿：\n`;
  const questionSuffix = `\n\n问题：${questionText}`;
  const selectedPrefix = `${context}从超长逐字稿中按问题选取的片段（按时间顺序，非完整逐字稿）：\n`;
  const fullFits = fullPrefix.length + fullTranscript.length + questionSuffix.length <= MAX_TEXT_INPUT_CHARACTERS;
  const prefix = fullFits ? fullPrefix : selectedPrefix;
  const transcriptBudget = Math.max(1_000, MAX_TEXT_INPUT_CHARACTERS - prefix.length - questionSuffix.length);
  const transcript = fullFits ? fullTranscript : selectQuestionRelevantFragments(fragments, questionText, transcriptBudget);
  const answer = await chatCompletion({
    config,
    system: interview
      ? `你是面试证据问答助手。只能依据岗位信息与给定逐字稿${fullFits ? "" : "选取片段"}回答，优先给出时间点和原话；没有依据时明确说证据不足。只讨论岗位相关信息，忽略且不得推断敏感个人属性，不得根据声音、口音或表达风格推断能力，不替代人工录用决定。${fullFits ? "" : "给定内容只是从超长逐字稿中按问题选取的片段，不代表完整逐字稿。"}`
      : `你是会议记录问答助手。只能依据给定逐字稿${fullFits ? "" : "选取片段"}回答；没有依据时明确说逐字稿中未提及。回答简洁，并尽量引用相关时间点。${fullFits ? "" : "给定内容只是从超长逐字稿中按问题选取的片段，不代表完整逐字稿。"}`,
    user: `${prefix}${transcript}${questionSuffix}`,
    signal,
  });
  return normalizeGeneratedTerminology(answer, validatedTerminologyMappings(meeting));
}

async function chatCompletion({ config, system, user, signal, attempts = DEFAULT_TEXT_ATTEMPTS }) {
  const result = await chatCompletionResult({ config, system, user, signal, attempts });
  return result.content;
}

async function chatCompletionResult({ config, system, user, signal, attempts = DEFAULT_TEXT_ATTEMPTS, maxOutputTokens }) {
  if (!config.chatModel?.trim()) throw new Error("请先填写文本模型名称");
  const protocol = textProtocol(config);
  const requestBody = protocol === "responses" ? {
    model: config.chatModel.trim(),
    instructions: system,
    input: user,
    store: false,
  } : {
    model: config.chatModel.trim(),
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    temperature: 0.2,
  };
  const outputTokenLimit = Number(maxOutputTokens);
  if (Number.isInteger(outputTokenLimit) && outputTokenLimit > 0) {
    if (protocol === "responses") requestBody.max_output_tokens = outputTokenLimit;
    else requestBody.max_tokens = outputTokenLimit;
  }
  const requestUrl = joinApiUrl(config.chatBaseUrl, config.chatPath);
  const requestHeaders = authHeaders(config.chatApiKey);
  const requestBodyJson = JSON.stringify(requestBody);
  const requestAbortSignal = signal || AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS);
  const attemptCount = Math.max(1, Math.min(DEFAULT_TEXT_ATTEMPTS, Number(attempts) || DEFAULT_TEXT_ATTEMPTS));
  let lastError;
  for (let attempt = 1; attempt <= attemptCount; attempt += 1) {
    try {
      const body = await apiFetch(requestUrl, {
        method: "POST",
        headers: requestHeaders,
        body: requestBodyJson,
        signal: requestAbortSignal,
      }, config);
      const content = responseText(body);
      if (!content) throw retryableError("文本模型没有返回内容");
      return { content, usage: textModelUsage(body?.usage) };
    } catch (error) {
      lastError = error;
      if (requestAbortSignal.aborted || !error?.retryable || attempt === attemptCount) throw error;
      const exponentialDelay = TEXT_RETRY_BASE_DELAY_MS * (2 ** (attempt - 1));
      await retryDelay(Math.max(exponentialDelay, Number(error.retryAfterMs) || 0), requestAbortSignal);
    }
  }
  throw lastError;
}

function textModelUsage(usage) {
  const total = Number(usage?.total_tokens);
  const input = Number(usage?.input_tokens ?? usage?.prompt_tokens);
  const output = Number(usage?.output_tokens ?? usage?.completion_tokens);
  const modelTokens = Number.isFinite(total) && total >= 0
    ? Math.floor(total)
    : Math.max(0, Math.floor((Number.isFinite(input) ? input : 0) + (Number.isFinite(output) ? output : 0)));
  return modelTokens > 0 ? { modelTokens } : {};
}

async function requestResponsesBody({ config, body, signal, attempts = DEFAULT_TEXT_ATTEMPTS }) {
  const requestUrl = joinApiUrl(config.chatBaseUrl, config.chatPath);
  const requestHeaders = authHeaders(config.chatApiKey);
  const requestBodyJson = JSON.stringify(body);
  const requestAbortSignal = signal || AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS);
  const attemptCount = Math.max(1, Math.min(DEFAULT_TEXT_ATTEMPTS, Number(attempts) || DEFAULT_TEXT_ATTEMPTS));
  let lastError;
  for (let attempt = 1; attempt <= attemptCount; attempt += 1) {
    try {
      return await apiFetch(requestUrl, {
        method: "POST",
        headers: requestHeaders,
        body: requestBodyJson,
        signal: requestAbortSignal,
      }, config);
    } catch (error) {
      lastError = error;
      if (requestAbortSignal.aborted || !error?.retryable || attempt === attemptCount) throw error;
      const exponentialDelay = TEXT_RETRY_BASE_DELAY_MS * (2 ** (attempt - 1));
      await retryDelay(Math.max(exponentialDelay, Number(error.retryAfterMs) || 0), requestAbortSignal);
    }
  }
  throw lastError;
}

function textProtocol(config) {
  return config.chatProtocol || (/\bresponses\/?$/i.test(config.chatPath || "") ? "responses" : "chat-completions");
}

function responseText(body) {
  const direct = body?.output_text ?? body?.choices?.[0]?.message?.content ?? body?.text;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const chunks = [];
  for (const item of Array.isArray(body?.output) ? body.output : []) {
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      const text = content?.text?.value ?? content?.text;
      if ((content?.type === "output_text" || typeof text === "string") && String(text || "").trim()) chunks.push(String(text).trim());
    }
  }
  return chunks.join("\n").trim();
}

function splitTranscriptPromptBatches(segments, maxCharacters) {
  return splitTranscriptPromptBatchRecords(segments, maxCharacters).map((batch) => batch.text);
}

function splitTranscriptPromptBatchRecords(segments, maxCharacters) {
  const fragments = transcriptPromptFragments(segments, Math.min(2_000, maxCharacters));
  const batches = [];
  let lines = [];
  let segmentIds = new Set();
  let size = 0;
  for (const fragment of fragments) {
    const separatorSize = lines.length ? 1 : 0;
    if (lines.length && size + separatorSize + fragment.line.length > maxCharacters) {
      batches.push({ text: lines.join("\n"), segment_ids: [...segmentIds] });
      lines = [];
      segmentIds = new Set();
      size = 0;
    }
    lines.push(fragment.line);
    segmentIds.add(fragment.segmentIndex);
    size += (lines.length > 1 ? 1 : 0) + fragment.line.length;
  }
  if (lines.length) batches.push({ text: lines.join("\n"), segment_ids: [...segmentIds] });
  return batches;
}

function transcriptPromptFragments(segments, maxLineCharacters = 2_000) {
  const fragments = [];
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex];
    const text = String(segment?.text || "").trim();
    if (!text) continue;
    const speaker = truncateText(segment?.speaker || "发言人", 80);
    const prefix = `[${formatTimestamp(segment?.start_seconds)}] ${speaker}：`;
    const textBudget = Math.max(1, maxLineCharacters - prefix.length);
    for (let offset = 0; offset < text.length; offset += textBudget) {
      const part = text.slice(offset, offset + textBudget);
      fragments.push({
        order: fragments.length,
        segmentIndex,
        line: `${prefix}${part}`,
        searchable: `${speaker} ${part}`,
      });
    }
  }
  return fragments;
}

function selectQuestionRelevantFragments(fragments, question, maxCharacters) {
  const tokens = retrievalTokens(question);
  const scored = fragments.map((fragment, index) => ({
    index,
    score: tokens.reduce((total, token) => total + (comparableText(fragment.searchable).includes(token) ? Math.max(1, token.length - 1) : 0), 0),
  })).filter((item) => item.score > 0).sort((left, right) => right.score - left.score || left.index - right.index);
  const priorities = [];
  const seenPriorities = new Set();
  const addPriority = (index) => {
    if (index < 0 || index >= fragments.length || seenPriorities.has(index)) return;
    seenPriorities.add(index);
    priorities.push(index);
  };
  if (scored.length) {
    for (const item of scored) addPriority(item.index);
    for (const item of scored) {
      addPriority(item.index - 1);
      addPriority(item.index + 1);
    }
  } else {
    for (let offset = 0; offset < fragments.length; offset += 1) {
      addPriority(offset);
      addPriority(fragments.length - 1 - offset);
    }
  }
  const selected = [];
  let size = 0;
  for (const index of priorities) {
    const lineSize = fragments[index].line.length + (selected.length ? 1 : 0);
    if (size + lineSize > maxCharacters) continue;
    selected.push(index);
    size += lineSize;
  }
  selected.sort((left, right) => fragments[left].order - fragments[right].order);
  return selected.map((index) => fragments[index].line).join("\n");
}

function retrievalTokens(value) {
  const text = String(value || "").normalize("NFKC").toLocaleLowerCase();
  const tokens = text.match(/[a-z0-9+#]{2,}/gu) || [];
  for (const match of text.matchAll(/[\p{Script=Han}]+/gu)) {
    const characters = [...match[0]];
    if (characters.length <= 12) tokens.push(characters.join(""));
    for (let width = 2; width <= Math.min(4, characters.length); width += 1) {
      for (let index = 0; index + width <= characters.length; index += 1) tokens.push(characters.slice(index, index + width).join(""));
    }
  }
  return [...new Set(tokens.map(comparableText).filter((token) => token.length >= 2))];
}

function splitSegmentBatches(segments, maxCharacters) {
  const batches = [];
  let batch = [];
  let size = 0;
  for (const segment of segments) {
    const nextSize = String(segment.text || "").length + String(segment.speaker || "").length + 40;
    if (batch.length && size + nextSize > maxCharacters) {
      batches.push(batch);
      batch = [];
      size = 0;
    }
    batch.push(segment);
    size += nextSize;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

function canJoinTranscriptSegments(left, right) {
  if (!left || !right) return false;
  if (comparableText(left.speaker || "发言人") !== comparableText(right.speaker || "发言人")) return false;
  const rawLeftStart = Number(left.start_seconds);
  const rawRightStart = Number(right.start_seconds);
  const explicitEnd = Number(left.end_seconds);
  if (!Number.isFinite(rawLeftStart) || !Number.isFinite(rawRightStart) || !Number.isFinite(explicitEnd)) return false;
  const leftStart = Math.max(0, rawLeftStart);
  const rightStart = Math.max(0, rawRightStart);
  if (rightStart < leftStart) return false;
  if (explicitEnd <= leftStart) return false;
  const gap = rightStart - explicitEnd;
  return gap >= -MAX_SEMANTIC_JOIN_OVERLAP_SECONDS && gap <= MAX_SEMANTIC_JOIN_GAP_SECONDS;
}

function normalizeSemanticJoins(segments, sourceSegments) {
  const normalized = segments.map((segment) => ({ ...segment, join_next: false }));
  if (!normalized.length) return normalized;
  let groupStart = Math.max(0, Number(normalized[0].start_seconds) || 0);
  let groupEnd = Math.max(groupStart, Number(normalized[0].end_seconds) || groupStart);
  let groupText = stringOr(normalized[0].text, "");

  for (let index = 0; index < normalized.length - 1; index += 1) {
    const current = normalized[index];
    const next = normalized[index + 1];
    const sourceCurrent = sourceSegments[index] || current;
    const sourceNext = sourceSegments[index + 1] || next;
    const strippedCurrentText = stripArtificialBoundaryPunctuation(current.text);
    const joinedText = joinTranscriptText(stripArtificialBoundaryPunctuation(groupText), next.text);
    const joinedEnd = Math.max(groupEnd, Number(next.end_seconds) || Number(next.start_seconds) || groupEnd);
    const accepted = segments[index]?.join_next === true
      && canJoinTranscriptSegments(sourceCurrent, sourceNext)
      && comparableText(current.speaker) === comparableText(next.speaker)
      && joinedText.length <= MAX_READABLE_SEGMENT_CHARACTERS
      && joinedEnd - groupStart <= MAX_READABLE_SEGMENT_SECONDS;

    if (accepted) {
      current.text = strippedCurrentText;
      current.join_next = true;
      groupText = joinedText;
      groupEnd = joinedEnd;
      continue;
    }

    if (segments[index]?.join_next === true) current.text = restoreBoundaryPunctuation(current.text, sourceCurrent.text);
    groupStart = Math.max(0, Number(next.start_seconds) || 0);
    groupEnd = Math.max(groupStart, Number(next.end_seconds) || groupStart);
    groupText = stringOr(next.text, "");
  }
  return normalized;
}

function stripArtificialBoundaryPunctuation(value) {
  const text = String(value || "").trim();
  const stripped = text.replace(/[。；;.]+$/u, "").trimEnd();
  return stripped || text;
}

function restoreBoundaryPunctuation(value, sourceValue) {
  const text = String(value || "").trimEnd();
  if (!text || /[。！？!?；;.,，：:]$/u.test(text)) return text;
  const punctuation = String(sourceValue || "").trim().match(/[。！？!?；;.]+$/u)?.[0];
  return punctuation ? `${text}${punctuation}` : text;
}

function joinTranscriptText(leftValue, rightValue) {
  const left = String(leftValue || "").trimEnd();
  const right = String(rightValue || "").trimStart();
  if (!left) return right;
  if (!right) return left;
  const leftCharacter = [...left].at(-1) || "";
  const rightCharacter = [...right][0] || "";
  const cjkBoundary = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(leftCharacter)
    || /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(rightCharacter);
  const wordBoundary = /[\p{Letter}\p{Number}]$/u.test(leftCharacter) && /^[\p{Letter}\p{Number}]/u.test(rightCharacter);
  const latinContinuation = /[\p{Script=Latin}\p{Number}]/u.test(rightCharacter)
    && /[\p{Script=Latin}\p{Number},:;.!?]/u.test(leftCharacter);
  const chineseToLatin = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(leftCharacter)
    && /\p{Script=Latin}/u.test(rightCharacter);
  return `${left}${(wordBoundary && !cjkBoundary) || latinContinuation || chineseToLatin ? " " : ""}${right}`;
}

export async function mapWithConcurrency(values, concurrency, mapper) {
  const source = Array.from(values || []);
  if (!source.length) return [];
  const results = new Array(source.length);
  let nextIndex = 0;
  let failure = null;
  const workerCount = Math.min(source.length, Math.max(1, Number(concurrency) || 1));
  const workers = Array.from({ length: workerCount }, async () => {
    while (!failure && nextIndex < source.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = await mapper(source[index], index);
      } catch (error) {
        failure ||= { error, index };
      }
    }
  });
  await Promise.all(workers);
  if (failure) throw failure.error;
  return results;
}

function parseJsonObject(value) {
  const text = String(value || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(text); } catch {}
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try { return JSON.parse(text.slice(first, last + 1)); } catch {}
  }
  return { summary: text };
}

function stringOr(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function stringArray(value) {
  return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
}

function truncateText(value, maxCharacters) {
  const text = String(value || "").trim();
  if (text.length <= maxCharacters) return text;
  return `${text.slice(0, Math.max(0, maxCharacters - 3))}...`;
}

function uniqueStrings(values) {
  const seen = new Set();
  return values.filter((value) => {
    const text = String(value || "").trim();
    const key = comparableText(text);
    if (!text || !key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((value) => String(value).trim());
}

function uniqueItems(values, keyForItem) {
  const seen = new Set();
  return values.filter((item) => {
    if (!item) return false;
    const key = keyForItem(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function highlightKey(item) {
  return `${evidenceTime(item?.start_seconds) ?? ""}:${comparableText(item?.quote)}`;
}

function decisionRecordKey(item) {
  return `${evidenceTime(item?.start_seconds) ?? ""}:${comparableText(item?.evidence)}:${comparableText(item?.decision)}`;
}

function normalizeActionItems(value) {
  const items = Array.isArray(value) ? value.map((item) => ({
    task: stringOr(item?.task, ""),
    owner: stringOr(item?.owner, ""),
    due: stringOr(item?.due, ""),
  })).filter((item) => item.task) : [];
  return uniqueItems(items, (item) => `${comparableText(item.task)}:${comparableText(item.owner)}:${comparableText(item.due)}`).slice(0, 60);
}

function normalizeVerifiedActionItems(value, segments = [], rawSegments = [], trustedTerms = [], correctionLedger, reconciliationLedger, agentCommitmentProofs = new Set()) {
  if (!Array.isArray(value) || !value.length) return [];
  const evidenceContext = prepareEvidenceContext(segments, rawSegments, trustedTerms, correctionLedger, reconciliationLedger);
  return uniqueItems(value.map((item) => {
    const agentReviewed = agentCommitmentProofs.has(meetingAnalysisCommitmentProof("action", item));
    if (agentReviewed
      ? !meetingCommitmentPassesDefensiveFloor({ kind: "action", evidence: item?.evidence })
      : !looksLikeAffirmativeActionEvidence(item?.evidence)) return null;
    const evidence = verifiedEvidence(
      item?.start_seconds,
      item?.evidence,
      segments,
      rawSegments,
      trustedTerms,
      correctionLedger,
      reconciliationLedger,
      item?.speaker,
      evidenceContext,
    );
    if (!evidence) return null;
    const verifiedAgentReview = agentCommitmentProofs.has(meetingAnalysisCommitmentProof("action", {
      start_seconds: evidence.start_seconds,
      evidence: evidence.quote,
    }));
    if (verifiedAgentReview
      ? !meetingCommitmentPassesDefensiveFloor({ kind: "action", evidence: evidence.quote })
      : !looksLikeAffirmativeActionEvidence(evidence.quote)) return null;
    return {
      task: evidence.quote,
      owner: evidenceSupportsActionOwner(evidence.quote, item?.owner) ? stringOr(item?.owner, "") : "",
      due: evidenceSupportsActionDue(evidence.quote, item?.due, item?.task, item?.owner) ? stringOr(item?.due, "") : "",
      start_seconds: evidence.start_seconds,
      speaker: evidence.speaker,
      evidence: evidence.quote,
    };
  }).filter(Boolean), (item) => `${item.start_seconds}:${comparableText(item.evidence)}`).slice(0, 60);
}

function mergeSpeakerSummaries(value) {
  const merged = new Map();
  for (const item of normalizeSpeakerSummaries(value)) {
    const key = comparableText(item.speaker);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...item });
      continue;
    }
    if (!existing.summary && item.summary) existing.summary = item.summary;
    existing.key_points = uniqueStrings([...existing.key_points, ...item.key_points]).slice(0, 12);
  }
  return [...merged.values()].slice(0, 30);
}

function mergeInterviewReportParts(values) {
  const competencies = new Map();
  const followUps = [];
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    followUps.push(...stringArray(value.follow_ups));
    for (const item of Array.isArray(value.competencies) ? value.competencies : []) {
      const name = stringOr(item?.name, "");
      if (!name) continue;
      const key = comparableText(name);
      if (!competencies.has(key)) competencies.set(key, { name, evidence: [] });
      if (Array.isArray(item?.evidence)) competencies.get(key).evidence.push(...item.evidence);
    }
  }
  return {
    competencies: [...competencies.values()],
    follow_ups: uniqueStrings(followUps).slice(0, 12),
  };
}

function parseTerminologyContext(value) {
  const labels = /^(术语|专有名词|项目名|产品名|公司名|组织名|人名|姓名|负责人|参会人|人员|别名|terms?|project|product|company|organization|names?|aliases?)\s*[:：=]?\s*(.+)$/i;
  const canonicalTerms = [];
  const aliasMappings = new Map();
  const conflictingAliases = new Set();
  let entryCount = 0;
  let overflow = false;
  clauseLoop: for (const clause of String(value || "").split(/[；;\n]+/u)) {
    const match = clause.trim().match(labels);
    if (!match) continue;
    const label = match[1];
    const separator = /(?:->|→)/u.test(match[2]) ? /[、,，|]+/u : /[、,，|/]+/u;
    for (const entry of match[2].split(separator).map((item) => item.trim()).filter(Boolean)) {
      if (entryCount >= MAX_TERMINOLOGY_ENTRIES) {
        overflow = true;
        break clauseLoop;
      }
      entryCount += 1;
      const mapping = entry.match(/^(.+?)\s*(?:->|→)\s*(.+)$/u);
      if (!mapping) {
        if (
          !/^(?:别名|aliases?)$/i.test(label)
          && codePointLength(entry) >= 2
          && codePointLength(entry) <= MAX_TERMINOLOGY_ENTRY_CHARACTERS
        ) canonicalTerms.push(entry);
        continue;
      }
      const alias = mapping[1].trim();
      const canonical = mapping[2].trim();
      const aliasKey = correctionText(alias);
      if (
        codePointLength(alias) > MAX_TERMINOLOGY_ENTRY_CHARACTERS
        || codePointLength(canonical) > MAX_TERMINOLOGY_ENTRY_CHARACTERS
        || aliasKey.length < 2
        || correctionText(canonical).length < 2
        || alias.normalize("NFKC") === canonical.normalize("NFKC")
      ) continue;
      canonicalTerms.push(canonical);
      const existing = aliasMappings.get(aliasKey);
      if (existing && existing.canonical.normalize("NFKC") !== canonical.normalize("NFKC")) {
        aliasMappings.delete(aliasKey);
        conflictingAliases.add(aliasKey);
      } else if (!conflictingAliases.has(aliasKey)) {
        aliasMappings.set(aliasKey, { alias, canonical });
      }
    }
  }
  resolveTerminologyMappingGraph(aliasMappings, conflictingAliases);
  return {
    canonicalTerms: terminalTerminologyCanonicals(canonicalTerms, aliasMappings, conflictingAliases),
    aliasMappings,
    conflictingAliases,
    overflow,
  };
}

function terminalTerminologyCanonicals(canonicalTerms, aliasMappings, conflictingAliases) {
  const terminals = canonicalTerms.filter((term) => {
    const key = correctionText(term);
    if (!key || conflictingAliases.has(key)) return false;
    const mapping = aliasMappings.get(key);
    return !mapping || correctionText(mapping.canonical) === key;
  });
  terminals.push(...[...aliasMappings.values()].map((mapping) => mapping.canonical));
  return uniqueStrings(terminals);
}

function resolveTerminologyMappingGraph(aliasMappings, conflictingAliases) {
  const resolved = new Map();
  const invalid = new Set();
  for (const startKey of aliasMappings.keys()) {
    if (resolved.has(startKey) || invalid.has(startKey)) continue;
    const path = [];
    const positions = new Map();
    let currentKey = startKey;
    let terminal = null;
    while (aliasMappings.has(currentKey)) {
      if (invalid.has(currentKey)) {
        for (const key of path) invalid.add(key);
        terminal = null;
        break;
      }
      if (positions.has(currentKey)) {
        for (const key of path) invalid.add(key);
        terminal = null;
        break;
      }
      positions.set(currentKey, path.length);
      path.push(currentKey);
      const mapping = aliasMappings.get(currentKey);
      const nextKey = correctionText(mapping.canonical);
      if (conflictingAliases.has(nextKey)) {
        for (const key of path) invalid.add(key);
        terminal = null;
        break;
      }
      if (!nextKey || nextKey === currentKey || !aliasMappings.has(nextKey)) {
        terminal = mapping.canonical;
        break;
      }
      currentKey = nextKey;
    }
    if (!terminal) continue;
    for (const key of path) resolved.set(key, terminal);
  }
  for (const key of invalid) {
    aliasMappings.delete(key);
    conflictingAliases.add(key);
  }
  for (const [key, canonical] of resolved) {
    const mapping = aliasMappings.get(key);
    if (mapping) aliasMappings.set(key, { ...mapping, canonical });
  }
}

function codePointLength(value) {
  return [...String(value || "")].length;
}

function scopeCorrectionPatches(patches, batchStartId, batchLength) {
  const scoped = [];
  const rejections = [];
  const batchEndId = batchStartId + batchLength;
  for (const patch of Array.isArray(patches) ? patches : []) {
    const segmentId = correctionSegmentId(patch?.id);
    if (segmentId != null && segmentId >= batchStartId && segmentId < batchEndId) {
      scoped.push(patch);
      continue;
    }
    const replacements = Array.isArray(patch?.replacements) ? patch.replacements : [];
    if (replacements.length) {
      for (const replacement of replacements) {
        rejections.push(rejectedPatchEntry({ segmentId, replacement }, null, "out_of_batch_segment"));
      }
    } else {
      rejections.push(correctionLedgerEntry({
        segmentId,
        status: "rejected",
        reason: "out_of_batch_segment",
      }));
    }
  }
  return { patches: scoped, rejections };
}

function inferRecordingAliasMappings(segments, patches, terminologyContext, correctionLedger = []) {
  const candidates = [];
  const addCandidate = (segmentId, fromValue, toValue, persisted = false) => {
    const segment = segments[segmentId];
    const from = typeof fromValue === "string" ? fromValue.trim() : "";
    let canonical = typeof toValue === "string" ? toValue.trim() : "";
    const terminalMapping = terminologyContext.aliasMappings.get(correctionText(canonical));
    if (terminalMapping) canonical = terminalMapping.canonical;
    const aliasKey = correctionText(from);
    const canonicalKey = correctionText(canonical);
    if (
      !segment
      || !from
      || !canonical
      || aliasKey.length < 2
      || canonicalKey.length < 2
      || codePointLength(from) > MAX_TERMINOLOGY_ENTRY_CHARACTERS
      || codePointLength(canonical) > MAX_TERMINOLOGY_ENTRY_CHARACTERS
      || !literalMatchOffsets(String(segment.text || ""), from).length
      || from.normalize("NFKC") === canonical.normalize("NFKC")
    ) return;
    candidates.push({ segmentId, from, canonical, aliasKey, canonicalKey, persisted });
  };

  for (const patch of Array.isArray(patches) ? patches : []) {
    const segmentId = correctionSegmentId(patch?.id);
    if (segmentId == null || !Array.isArray(patch?.replacements)) continue;
    for (const replacement of patch.replacements) addCandidate(segmentId, replacement?.from, replacement?.to);
  }
  for (const entry of Array.isArray(correctionLedger) ? correctionLedger : []) {
    const segmentId = Number(entry?.segmentId);
    const segment = segments[segmentId];
    const start = Number(entry?.start_offset);
    const end = Number(entry?.end_offset);
    if (
      entry?.status !== "accepted"
      || entry.reason !== "recording_consensus"
      || !Number.isInteger(segmentId)
      || !segment
      || entry.source_hash !== segmentSourceHash(segment, segmentId)
      || !Number.isInteger(start)
      || !Number.isInteger(end)
      || start < 0
      || end <= start
      || String(segment.text || "").slice(start, end) !== entry.from
    ) continue;
    addCandidate(segmentId, entry.from, entry.to, true);
  }

  const byAlias = new Map();
  for (const candidate of candidates) {
    if (terminologyContext.aliasMappings.has(candidate.aliasKey) || terminologyContext.conflictingAliases.has(candidate.aliasKey)) continue;
    if (!byAlias.has(candidate.aliasKey)) byAlias.set(candidate.aliasKey, {
      aliases: new Map(), canonicals: new Map(), persistedCanonicals: new Map(), proposalSegmentIds: new Set(),
    });
    const bucket = byAlias.get(candidate.aliasKey);
    bucket.aliases.set(candidate.from.normalize("NFKC"), candidate.from);
    if (!bucket.canonicals.has(candidate.canonicalKey)) bucket.canonicals.set(candidate.canonicalKey, candidate.canonical);
    if (candidate.persisted && !bucket.persistedCanonicals.has(candidate.canonicalKey)) {
      bucket.persistedCanonicals.set(candidate.canonicalKey, candidate.canonical);
    }
    bucket.proposalSegmentIds.add(candidate.segmentId);
  }

  const groups = new Map();
  for (const [aliasKey, bucket] of byAlias) {
    const canonicalOptions = bucket.persistedCanonicals.size ? bucket.persistedCanonicals : bucket.canonicals;
    if (canonicalOptions.size !== 1) {
      terminologyContext.conflictingAliases.add(aliasKey);
      continue;
    }
    const [canonicalKey, canonical] = canonicalOptions.entries().next().value;
    if (!groups.has(canonicalKey)) groups.set(canonicalKey, { canonical, records: [] });
    groups.get(canonicalKey).records.push({
      aliasKey,
      alias: bucket.aliases.values().next().value,
      persisted: bucket.persistedCanonicals.size > 0,
      proposalSegmentIds: bucket.proposalSegmentIds,
    });
  }

  for (const [canonicalKey, group] of groups) {
    for (const record of group.records) {
      record.occurrences = new Set();
      record.occurrenceSegmentIds = new Set();
      segments.forEach((segment, segmentId) => {
        for (const range of normalizedMatchRanges(String(segment.text || ""), record.alias, group.canonical)) {
          record.occurrences.add(`${segmentId}:${range.start}:${range.end}`);
          record.occurrenceSegmentIds.add(segmentId);
        }
      });
    }
    const trustedCanonical = terminologyContext.canonicalKeys.has(canonicalKey);
    const eligibleRecords = group.records.filter((record) => (
      record.persisted
      || plausibleTerminologyPair(record.alias, group.canonical)
      || trustedCanonical
    ));
    const occurrences = new Set(eligibleRecords.flatMap((record) => [...record.occurrences]));
    if (occurrences.size < 2 || !eligibleRecords.length) continue;
    if (terminologyContext.aliasMappings.size + eligibleRecords.length > MAX_TERMINOLOGY_ENTRIES) continue;
    terminologyContext.canonicalTerms.push(group.canonical);
    terminologyContext.canonicalKeys.add(canonicalKey);
    for (const record of eligibleRecords) {
      terminologyContext.aliasMappings.set(record.aliasKey, {
        alias: record.alias,
        canonical: group.canonical,
        reason: "recording_consensus",
      });
    }
  }
  resolveTerminologyMappingGraph(terminologyContext.aliasMappings, terminologyContext.conflictingAliases);
  terminologyContext.canonicalTerms = terminalTerminologyCanonicals(
    terminologyContext.canonicalTerms,
    terminologyContext.aliasMappings,
    terminologyContext.conflictingAliases,
  );
  terminologyContext.canonicalKeys = new Set(terminologyContext.canonicalTerms.map(correctionText).filter(Boolean));
}

function plausibleTerminologyPair(aliasValue, canonicalValue) {
  const alias = correctionText(aliasValue);
  const canonical = correctionText(canonicalValue);
  if (alias.length < 3 || canonical.length < 3) return false;
  if (alias === canonical) return String(aliasValue).normalize("NFKC") !== String(canonicalValue).normalize("NFKC");
  const asciiAlias = /^[a-z0-9+#]+$/u.test(alias);
  const asciiCanonical = /^[a-z0-9+#]+$/u.test(canonical);
  if (asciiAlias && asciiCanonical && alias[0] !== canonical[0]) return false;
  const limit = Math.max(2, Math.ceil(Math.max(alias.length, canonical.length) * 0.45));
  return editDistance(alias, canonical, limit) <= limit;
}

function unresolvedCorrectionPatches(patches, terminologyContext) {
  return (Array.isArray(patches) ? patches : []).map((patch) => {
    if (!Array.isArray(patch?.replacements)) return patch;
    return {
      ...patch,
      replacements: patch.replacements.filter((replacement) => {
        const mapping = terminologyContext.aliasMappings.get(correctionText(replacement?.from));
        const proposedTo = String(replacement?.to || "").trim();
        const proposedMapping = terminologyContext.aliasMappings.get(correctionText(proposedTo));
        // Configured aliases close canonical chains; inferred aliases must still expose retry conflicts.
        const proposedTerminal = proposedMapping && proposedMapping.reason !== "recording_consensus"
          ? proposedMapping.canonical
          : proposedTo;
        return !mapping || proposedTerminal.normalize("NFKC") !== mapping.canonical.normalize("NFKC");
      }),
    };
  }).filter((patch) => !Array.isArray(patch?.replacements) || patch.replacements.length);
}

function recordingMappingPatches(batch, batchStartId, terminologyContext) {
  const mappings = [...terminologyContext.aliasMappings.values()]
    .sort((left, right) => correctionText(right.alias).length - correctionText(left.alias).length);
  return batch.map((segment, localIndex) => ({
    id: batchStartId + localIndex,
    replacements: mappings.filter((mapping) => normalizedMatchRanges(String(segment.text || ""), mapping.alias, mapping.canonical)
      .some((range) => String(segment.text || "").slice(range.start, range.end) !== mapping.canonical))
      .map((mapping) => ({ from: mapping.alias, to: mapping.canonical })),
  })).filter((patch) => patch.replacements.length);
}

function applyCorrectionPatches(batch, batchStartId, value, terminologyContext) {
  const patches = Array.isArray(value) ? value : [];
  const sources = batch.map((segment, localIndex) => ({ segmentId: batchStartId + localIndex, segment, proposals: [] }));
  const byId = new Map(sources.map((item) => [item.segmentId, item]));
  const corrections = [];
  let order = 0;

  for (const patch of patches) {
    const segmentId = correctionSegmentId(patch?.id);
    const replacements = Array.isArray(patch?.replacements) ? patch.replacements : null;
    if (!replacements) {
      corrections.push({ ...correctionLedgerEntry({ segmentId, segment: byId.get(segmentId)?.segment, status: "rejected", reason: "invalid_replacements" }), order: order += 1 });
      continue;
    }
    for (const replacement of replacements) {
      const proposal = { segmentId, replacement, order: order += 1 };
      const target = byId.get(segmentId);
      if (target) target.proposals.push(proposal);
      else corrections.push({ ...rejectedPatchEntry(proposal, null, "unknown_segment"), order: proposal.order });
    }
  }

  const acceptedTerminology = [];
  const segments = sources.map(({ segmentId, segment, proposals }) => {
    const accepted = [];
    for (const proposal of proposals) {
      const replacement = proposal.replacement;
      const from = typeof replacement?.from === "string" ? replacement.from.trim() : "";
      const proposedTo = typeof replacement?.to === "string" ? replacement.to.trim() : "";
      const reject = (reason) => corrections.push({
        ...correctionLedgerEntry({ segmentId, segment, from, to: proposedTo, status: "rejected", reason }),
        order: proposal.order,
      });
      if (!from || !proposedTo) {
        reject("invalid_replacement");
        continue;
      }
      const aliasKey = correctionText(from);
      if (terminologyContext.conflictingAliases.has(aliasKey)) {
        reject("conflicting_alias_mapping");
        continue;
      }
      const mapping = terminologyContext.aliasMappings.get(aliasKey);
      if (!mapping) {
        reject(terminologyContext.canonicalKeys.has(correctionText(proposedTo)) ? "explicit_alias_required" : "unknown_canonical");
        continue;
      }
      if (proposedTo.normalize("NFKC") !== mapping.canonical.normalize("NFKC")) {
        reject("canonical_mismatch");
        continue;
      }
      const ranges = normalizedMatchRanges(String(segment.text || ""), from, mapping.canonical);
      if (!ranges.length) {
        reject("from_not_found");
        continue;
      }
      for (const match of ranges) {
        const matchedFrom = String(segment.text || "").slice(match.start, match.end);
        if (matchedFrom === mapping.canonical) continue;
        const range = { ...match, to: mapping.canonical };
        const overlap = accepted.find((item) => range.start < item.end && range.end > item.start);
        if (overlap) {
          if (overlap.start !== range.start || overlap.end !== range.end || overlap.to !== range.to) reject("overlapping_replacement");
          continue;
        }
        const candidate = `${String(segment.text || "").slice(0, range.start)}${range.to}${String(segment.text || "").slice(range.end)}`;
        if (criticalFingerprint(segment.text) !== criticalFingerprint(candidate)) {
          reject("critical_fact_change");
          continue;
        }
        accepted.push(range);
        acceptedTerminology.push(mapping.canonical);
        corrections.push({
          ...correctionLedgerEntry({
            segmentId,
            segment,
            from: matchedFrom,
            to: mapping.canonical,
            status: "accepted",
            reason: mapping.reason || "explicit_alias",
            startOffset: range.start,
            endOffset: range.end,
          }),
          order: proposal.order,
        });
      }
    }
    let text = String(segment.text || "");
    for (const replacement of accepted.sort((left, right) => right.start - left.start)) {
      text = `${text.slice(0, replacement.start)}${replacement.to}${text.slice(replacement.end)}`;
    }
    return { ...segment, text };
  });

  return {
    segments,
    terminology: uniqueStrings(acceptedTerminology),
    corrections: corrections.sort((left, right) => left.order - right.order).map(({ order: _order, ...entry }) => entry),
  };
}

function rejectedPatchEntry(proposal, segment, reason) {
  const replacement = proposal.replacement;
  return correctionLedgerEntry({
    segmentId: proposal.segmentId,
    segment,
    from: typeof replacement?.from === "string" ? replacement.from.trim() : "",
    to: typeof replacement?.to === "string" ? replacement.to.trim() : "",
    status: "rejected",
    reason,
  });
}

function correctionLedgerEntry({ segmentId, segment, from = "", to = "", status, reason, startOffset, endOffset }) {
  return {
    segmentId: Number.isInteger(segmentId) ? segmentId : null,
    start_seconds: segment ? Math.max(0, Number(segment.start_seconds) || 0) : null,
    source_hash: segment ? segmentSourceHash(segment, segmentId) : null,
    from,
    to,
    status,
    reason,
    ...(Number.isInteger(startOffset) && Number.isInteger(endOffset) ? {
      start_offset: startOffset,
      end_offset: endOffset,
    } : {}),
  };
}

function literalMatchOffsets(value, search) {
  const offsets = [];
  let offset = String(value).indexOf(search);
  while (offset !== -1) {
    offsets.push(offset);
    offset = String(value).indexOf(search, offset + 1);
  }
  return offsets;
}

function normalizedMatchRanges(value, search, canonicalValue = "") {
  const needle = terminologyMatchText(search);
  if (!needle) return [];
  const source = String(value || "");
  const index = normalizedTerminologyIndex(source);
  const ranges = terminologyRangesFromIndex(source, index, needle);
  const canonicalNeedle = terminologyMatchText(canonicalValue);
  if (!canonicalNeedle || canonicalNeedle === needle || !canonicalNeedle.includes(needle)) return ranges;
  const canonicalRanges = terminologyRangesFromIndex(source, index, canonicalNeedle);
  return ranges.filter((range) => !canonicalRanges.some((canonicalRange) => (
    range.start >= canonicalRange.start && range.end <= canonicalRange.end
  )));
}

function terminologyMatchText(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase()
    .replace(/(?:[^\S\r\n]|\p{Pd}|\u00ad|\u200b|\u2060|\u2212)+/gu, "");
}

function normalizedTerminologyIndex(source) {
  const clusters = [];
  let sourceOffset = 0;
  for (const character of source) {
    const start = sourceOffset;
    sourceOffset += character.length;
    if (/^\p{M}+$/u.test(character) && clusters.length) {
      const previous = clusters[clusters.length - 1];
      previous.text += character;
      previous.end = sourceOffset;
    } else {
      clusters.push({ text: character, start, end: sourceOffset });
    }
  }
  let normalized = "";
  const offsets = [];
  for (const cluster of clusters) {
    const piece = cluster.text.normalize("NFKC").toLocaleLowerCase();
    for (const normalizedCharacter of piece) {
      if (/(?:[^\S\r\n]|\p{Pd}|\u00ad|\u200b|\u2060|\u2212)/u.test(normalizedCharacter)) continue;
      normalized += normalizedCharacter;
      for (let unit = 0; unit < normalizedCharacter.length; unit += 1) {
        offsets.push({ start: cluster.start, end: cluster.end });
      }
    }
  }
  return { normalized, offsets };
}

function terminologyRangesFromIndex(source, index, needle) {
  const ranges = [];
  const signatures = new Set();
  let offset = index.normalized.indexOf(needle);
  while (offset !== -1) {
    const first = index.offsets[offset];
    const last = index.offsets[offset + needle.length - 1];
    if (first && last) {
      const hasLatinNeedle = /\p{Script=Latin}/u.test(needle);
      const preceding = [...source.slice(0, first.start)].at(-1) || "";
      const following = [...source.slice(last.end)][0] || "";
      const touchesLatinToken = hasLatinNeedle
        && (/[\p{Script=Latin}\p{Number}_+#\p{M}]/u.test(preceding) || /[\p{Script=Latin}\p{Number}_+#\p{M}]/u.test(following));
      if (touchesLatinToken) {
        offset = index.normalized.indexOf(needle, offset + 1);
        continue;
      }
      const signature = `${first.start}:${last.end}`;
      if (!signatures.has(signature)) {
        signatures.add(signature);
        ranges.push({ start: first.start, end: last.end });
      }
    }
    offset = index.normalized.indexOf(needle, offset + 1);
  }
  return ranges;
}

const GENERATED_TERMINOLOGY_FIELDS = new Set([
  "assessment", "decision", "decisions", "evidence", "follow_ups", "key_points", "keywords",
  "name", "overview", "quote", "reason", "risks", "strengths", "summary", "task", "title",
]);

function normalizeGeneratedTerminology(value, mappings) {
  if (!mappings.length) return value;
  const visit = (item, normalizeStrings = false) => {
    if (typeof item === "string") return normalizeStrings ? normalizeTerminologyText(item, mappings) : item;
    if (Array.isArray(item)) return item.map((child) => visit(child, normalizeStrings));
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(Object.entries(item).map(([key, child]) => [
      key,
      visit(child, GENERATED_TERMINOLOGY_FIELDS.has(key)),
    ]));
  };
  return visit(value, typeof value === "string");
}

function acceptedTerminologyMappings(correctionLedger) {
  const mappings = new Map();
  const conflicts = new Set();
  for (const entry of Array.isArray(correctionLedger) ? correctionLedger : []) {
    if (entry?.status !== "accepted" || !ACCEPTED_CORRECTION_REASONS.has(entry.reason)) continue;
    const alias = typeof entry.from === "string" ? entry.from.trim() : "";
    const canonical = typeof entry.to === "string" ? entry.to.trim() : "";
    const aliasKey = correctionText(alias);
    if (!alias || !canonical || !aliasKey || conflicts.has(aliasKey)) continue;
    const existing = mappings.get(aliasKey);
    if (existing && existing.canonical.normalize("NFKC") !== canonical.normalize("NFKC")) {
      mappings.delete(aliasKey);
      conflicts.add(aliasKey);
      continue;
    }
    mappings.set(aliasKey, { alias, canonical });
  }
  resolveTerminologyMappingGraph(mappings, conflicts);
  for (const mapping of [...mappings.values()]) {
    const canonicalKey = correctionText(mapping.canonical);
    if (!canonicalKey || conflicts.has(canonicalKey) || mappings.has(canonicalKey)) continue;
    mappings.set(canonicalKey, { alias: mapping.canonical, canonical: mapping.canonical });
  }
  return [...mappings.values()].sort((left, right) => correctionText(right.alias).length - correctionText(left.alias).length);
}

function validatedTerminologyMappings(meeting) {
  const correctionLedger = Array.isArray(meeting?.corrections) ? meeting.corrections : [];
  const rawSegments = Array.isArray(meeting?.rawSegments) ? meeting.rawSegments : [];
  const displayedSegments = Array.isArray(meeting?.segments) ? meeting.segments : [];
  if (!correctionLedger.length || !rawSegments.length || !displayedSegments.length) return [];
  const sourceSegments = replayTranscriptReconciliations(
    rawSegments,
    Array.isArray(meeting?.asrReconciliations) ? meeting.asrReconciliations : [],
  );
  if (!sourceSegments) return [];
  const replayed = replayCorrectedTranscriptWithJoins(
    sourceSegments,
    displayedSegments,
    correctionLedger,
    meeting?.terminology,
  );
  return replayed ? acceptedTerminologyMappings(correctionLedger) : [];
}

function normalizeTerminologyText(value, mappings) {
  const source = String(value || "");
  const candidates = [];
  for (const mapping of mappings) {
    for (const range of normalizedMatchRanges(source, mapping.alias, mapping.canonical)) {
      if (source.slice(range.start, range.end) === mapping.canonical) continue;
      candidates.push({ ...range, to: mapping.canonical });
    }
  }
  candidates.sort((left, right) => left.start - right.start || (right.end - right.start) - (left.end - left.start));
  const accepted = [];
  for (const candidate of candidates) {
    if (accepted.some((range) => candidate.start < range.end && candidate.end > range.start)) continue;
    accepted.push(candidate);
  }
  let normalized = source;
  for (const range of accepted.sort((left, right) => right.start - left.start)) {
    normalized = `${normalized.slice(0, range.start)}${range.to}${normalized.slice(range.end)}`;
  }
  return criticalFingerprint(source) === criticalFingerprint(normalized) ? normalized : source;
}

function normalizeHighlights(value, segments = [], rawSegments = [], trustedTerms = [], correctionLedger, reconciliationLedger) {
  if (!Array.isArray(value) || !value.length) return [];
  const evidenceContext = prepareEvidenceContext(segments, rawSegments, trustedTerms, correctionLedger, reconciliationLedger);
  return uniqueItems(value.map((item) => {
    const evidence = verifiedEvidence(item?.start_seconds, item?.quote, segments, rawSegments, trustedTerms, correctionLedger, reconciliationLedger, item?.speaker, evidenceContext);
    if (!evidence) return null;
    return {
      start_seconds: evidence.start_seconds,
      speaker: evidence.speaker || stringOr(item?.speaker, "发言人"),
      quote: evidence.quote,
      reason: "",
    };
  }).filter(Boolean), (item) => `${item.start_seconds}:${comparableText(item.quote)}`).slice(0, 20);
}

function normalizeSpeakerSummaries(value) {
  return Array.isArray(value) ? value.map((item) => ({
    speaker: stringOr(item?.speaker, "发言人"),
    summary: stringOr(item?.summary, ""),
    key_points: stringArray(item?.key_points).slice(0, 12),
  })).filter((item) => item.summary || item.key_points.length).slice(0, 30) : [];
}

function normalizeVerifiedSpeakerSummaries(value, segments = [], rawSegments = [], trustedTerms = [], correctionLedger, reconciliationLedger) {
  if (!Array.isArray(value) || !value.length) return [];
  const evidenceContext = prepareEvidenceContext(segments, rawSegments, trustedTerms, correctionLedger, reconciliationLedger);
  const grouped = new Map();
  for (const item of value) {
    const requestedSpeaker = stringOr(item?.speaker, "发言人");
    const verified = uniqueItems((Array.isArray(item?.evidence) ? item.evidence : []).map((entry) => (
      verifiedEvidence(
        entry?.start_seconds,
        entry?.quote,
        segments,
        rawSegments,
        trustedTerms,
        correctionLedger,
        reconciliationLedger,
        requestedSpeaker,
        evidenceContext,
      )
    )).filter(Boolean), (entry) => `${entry.start_seconds}:${comparableText(entry.quote)}`);
    for (const entry of verified) {
      const key = comparableText(entry.speaker);
      if (!grouped.has(key)) grouped.set(key, { speaker: entry.speaker, evidence: [] });
      grouped.get(key).evidence.push(entry);
    }
  }
  return [...grouped.values()].map((group) => {
    const evidence = uniqueItems(group.evidence, (entry) => `${entry.start_seconds}:${comparableText(entry.quote)}`).slice(0, 12);
    const keyPoints = evidence.map((entry) => entry.quote);
    return {
      speaker: group.speaker,
      summary: truncateText(keyPoints.join("；"), 1_200),
      key_points: keyPoints,
      evidence,
    };
  }).filter((item) => item.evidence.length).slice(0, 30);
}

function normalizeDecisionRecords(value, segments = [], rawSegments = [], trustedTerms = [], correctionLedger, reconciliationLedger, agentCommitmentProofs = new Set()) {
  if (!Array.isArray(value) || !value.length) return [];
  const evidenceContext = prepareEvidenceContext(segments, rawSegments, trustedTerms, correctionLedger, reconciliationLedger);
  return uniqueItems(value.map((item) => {
    const agentReviewed = agentCommitmentProofs.has(meetingAnalysisCommitmentProof("decision", item));
    if (agentReviewed
      ? !meetingCommitmentPassesDefensiveFloor({ kind: "decision", evidence: item?.evidence })
      : !looksLikeDecisionEvidence(item?.evidence)) return null;
    const evidence = verifiedEvidence(item?.start_seconds, item?.evidence, segments, rawSegments, trustedTerms, correctionLedger, reconciliationLedger, "", evidenceContext);
    if (!evidence) return null;
    const verifiedAgentReview = agentCommitmentProofs.has(meetingAnalysisCommitmentProof("decision", {
      start_seconds: evidence.start_seconds,
      evidence: evidence.quote,
    }));
    if (verifiedAgentReview
      ? !meetingCommitmentPassesDefensiveFloor({ kind: "decision", evidence: evidence.quote })
      : !looksLikeDecisionEvidence(evidence.quote)) return null;
    const decision = stringOr(item?.decision, "");
    const normalizedDecision = comparableText(decision);
    if (normalizedDecision.length < 2) return null;
    return { decision: evidence.quote, start_seconds: evidence.start_seconds, evidence: evidence.quote };
  }).filter((item) => item?.decision), (item) => `${item.start_seconds}:${comparableText(item.evidence)}`).slice(0, 30);
}

function looksLikeDecisionEvidence(value) {
  const text = String(value || "");
  return looksLikeExplicitDecisionEvidence(text)
    && !decisionEvidenceIsUncertainOrUnresolved(text);
}

function looksLikeExplicitDecisionEvidence(value) {
  const text = String(value || "");
  return /决定|确认|同意|通过|批准|否决|安排|定于|采用|选择|必须|不得|取消|延期/u.test(text)
    || /(?:由|让|请|安排|指定)\s*[^，。；;,.!?！？\n]{1,40}?(?:负责|完成|跟进|处理|交付|执行|推进|承担|上线|发布)/u.test(text)
    || /[^，。；;,.!?！？\n]{1,24}\s*(?:负责|将|承诺)\s*(?:完成|跟进|处理|交付|执行|推进|承担|上线|发布)/u.test(text)
    || /\b(?:decid(?:e|ed)|agree(?:d)?|approv(?:e|ed)|reject(?:ed)?|will|must|shall|assign(?:ed)?|cancel(?:led)?|postpone(?:d)?)\b/iu.test(text);
}

function decisionEvidenceIsUncertainOrUnresolved(value) {
  const text = String(value || "");
  return /[?？]/u.test(text)
    || looksLikeDirectQuestionEvidence(text)
    || commitmentActWasNotMade(text)
    || /是否|能否|可否|要不要|该不该|还(?:需要|需)讨论|仍(?:需要|需)讨论|(?:没有|并没有|并未|还没|还未|尚未|暂未|未能|未曾|从未|尚无|暂无)\s*(?:(?:作出|做出)?\s*(?:决定|确认|敲定|批准|同意|通过|采用|选择)|承诺)|尚(?:未|待)|未(?:决定|确认|敲定|承诺)|待(?:讨论|确认|决定|评估)|有待|可能|也许|或许|不确定|如果|假如|若(?:是|果)?|听说|据说|传闻|(?:预计|预期|计划|打算|考虑|倾向于)\s*(?:将|会|要|采用|选择|上线|发布|提交|部署|执行|完成)/u.test(text)
    || /\b(?:if|unless|whether|maybe|might|may|could|should we|reportedly|heard|rumou?r|(?:did|does|do|has|have|had|was|were|is|are)\s+not\s+(?:yet\s+)?(?:decide(?:d)?|confirm(?:ed)?|commit(?:ted)?)|(?:didn't|doesn't|don't|hasn't|haven't|hadn't|wasn't|weren't|isn't|aren't)\s+(?:yet\s+)?(?:decide(?:d)?|confirm(?:ed)?|commit(?:ted)?)|not\s+(?:yet\s+)?(?:decided|confirmed|committed)|to be (?:discussed|decided|confirmed)|pending (?:discussion|decision|confirmation)|plan(?:s|ned)?\s+to|expect(?:s|ed)?\s+to|intend(?:s|ed)?\s+to)\b/iu.test(text);
}

function evidenceTime(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function emptySummary() {
  return { title: "", summary: "", keywords: [], highlights: [], speaker_summaries: [], decisions: [], decision_records: [], action_items: [] };
}

function interviewContextForPrompt(meeting) {
  const context = meeting.interviewContext || {};
  return [
    "面试上下文：",
    `候选人代称：${stringOr(context.candidateAlias, "候选人")}`,
    `目标岗位：${stringOr(context.role, "未提供")}`,
    `面试轮次：${stringOr(context.stage, "未提供")}`,
    `岗位能力项：${stringArray(context.competencies).join("、") || "未提供"}`,
    `职位描述（仅用于岗位相关判断）：\n${stringOr(context.jobDescription, "未提供")}`,
  ].join("\n");
}

function normalizeInterviewReport(value, requestedCompetencies = [], segments = [], rawSegments = [], trustedTerms = [], correctionLedger, reconciliationLedger) {
  const source = value && typeof value === "object" ? value : {};
  const evidenceContext = prepareEvidenceContext(segments, rawSegments, trustedTerms, correctionLedger, reconciliationLedger);
  const groupedCompetencies = new Map();
  for (const item of Array.isArray(source.competencies) ? source.competencies : []) {
    const name = stringOr(item?.name, "未命名能力项");
    const key = comparableText(name);
    if (!groupedCompetencies.has(key)) groupedCompetencies.set(key, { name, evidence: [] });
    if (Array.isArray(item?.evidence)) groupedCompetencies.get(key).evidence.push(...item.evidence);
  }
  const sourceCompetencies = [...groupedCompetencies.values()].map((item) => {
    const evidence = uniqueItems(item.evidence.map((entry) => (
      verifiedEvidence(entry?.start_seconds, entry?.quote, segments, rawSegments, trustedTerms, correctionLedger, reconciliationLedger, "", evidenceContext)
    )).filter(Boolean), (entry) => `${entry.start_seconds}:${comparableText(entry.quote)}`).slice(0, 6);
    return {
      name: item.name,
      rating: evidence.length ? "mixed" : "insufficient",
      assessment: evidence.length ? "仅展示可核验原话；是否支持该能力项需面试官人工判断。" : "没有通过逐字稿校验的证据，需人工复核。",
      evidence,
    };
  }).filter((item) => item.name).slice(0, 20);
  const requestedNames = [...new Set(stringArray(requestedCompetencies))];
  const competencies = (requestedNames.length
    ? requestedNames.map((name) => {
      const matched = sourceCompetencies.find((item) => comparableText(item.name) === comparableText(name));
      return matched ? { ...matched, name } : { name, rating: "insufficient", assessment: "证据不足", evidence: [] };
    })
    : sourceCompetencies).slice(0, 20);
  const usedEvidence = new Set();
  for (const competency of competencies) {
    competency.evidence = competency.evidence.filter((entry) => {
      const key = `${entry.start_seconds}:${comparableText(entry.quote)}`;
      if (usedEvidence.has(key)) return false;
      usedEvidence.add(key);
      return true;
    });
    if (!competency.evidence.length) {
      competency.rating = "insufficient";
      competency.assessment = "没有通过逐字稿校验的独立证据，需人工复核。";
    }
  }
  const required = requestedNames.length
    ? requestedNames.map((name) => competencies.find((item) => comparableText(item.name) === comparableText(name))).filter(Boolean)
    : competencies;
  const verifiedEvidenceCount = required.reduce((total, item) => total + item.evidence.length, 0);
  const noVerifiedEvidence = verifiedEvidenceCount === 0;
  const covered = required.filter((item) => item.evidence.length);
  const strengths = [];
  const risks = required
    .filter((item) => !item.evidence.length)
    .map((item) => `${item.name}：证据不足`)
    .slice(0, 12);
  if (noVerifiedEvidence) risks.unshift("没有通过逐字稿校验的能力证据");
  const overview = noVerifiedEvidence
    ? "没有通过逐字稿校验的能力证据，无法生成可靠辅助结论。"
    : `${covered.length}/${required.length || competencies.length} 个能力项包含可核验逐字稿证据；证据整理结果仅供面试官人工复核。`;
  return {
    recommendation: noVerifiedEvidence ? "insufficient" : "follow_up",
    confidence: noVerifiedEvidence ? "low" : "medium",
    overview,
    competencies,
    strengths,
    risks: risks.slice(0, 12),
    follow_ups: stringArray(source.follow_ups).slice(0, 12),
  };
}

function verifiedEvidence(value, quoteValue, segments, rawSegments = [], trustedTerms = [], correctionLedger, reconciliationLedger, speakerHintValue = "", preparedContext) {
  const time = evidenceTime(value);
  const quote = stringOr(quoteValue, "");
  const normalizedQuote = comparableText(quote);
  if (time == null || normalizedQuote.length < 2) return null;
  const candidates = (segments || []).map((candidate, index, all) => {
    const start = Math.max(0, Number(candidate?.start_seconds) || 0);
    const explicitEnd = Number(candidate?.end_seconds);
    const nextStart = Number(all[index + 1]?.start_seconds);
    const end = Number.isFinite(explicitEnd) && explicitEnd > start
      ? explicitEnd
      : (Number.isFinite(nextStart) && nextStart > start ? nextStart : start + 5);
    if (time < start - 0.5 || time > end + 0.5) return null;
    const atomicMatch = comparableText(candidate?.text).includes(normalizedQuote);
    const groupMatch = atomicMatch || comparableText(evidenceContextGroup(all, index).text).includes(normalizedQuote);
    if (!groupMatch) return null;
    return { index, start, distance: Math.abs(start - time), speaker: comparableText(candidate?.speaker || "发言人") };
  }).filter(Boolean);
  const speakerHint = comparableText(speakerHintValue);
  const speakerMatches = speakerHint ? candidates.filter((candidate) => candidate.speaker === speakerHint) : [];
  const ranked = (speakerMatches.length ? speakerMatches : candidates)
    .sort((left, right) => left.distance - right.distance || left.index - right.index);
  if (!ranked.length || (ranked[1] && Math.abs(ranked[0].distance - ranked[1].distance) < 1e-9)) return null;
  const segmentIndex = ranked[0].index;
  const segment = segments?.[segmentIndex];
  if (!segment) return null;
  const contextGroup = evidenceContextGroup(segments, segmentIndex);
  if (
    contextGroup.text.length > MAX_READABLE_SEGMENT_CHARACTERS
    || contextGroup.end_seconds - contextGroup.start_seconds > MAX_READABLE_SEGMENT_SECONDS
  ) return null;
  const contextualQuote = contextPreservingEvidenceQuote(contextGroup.text, quote);
  if (!contextualQuote) return null;
  const evidenceContext = preparedContext || prepareEvidenceContext(segments, rawSegments, trustedTerms, correctionLedger, reconciliationLedger);
  if (evidenceContext.invalid || evidenceContext.segmentValidity?.[segmentIndex] === false) return null;
  return {
    start_seconds: contextualQuote.normalize("NFKC").toLocaleLowerCase() === quote.normalize("NFKC").toLocaleLowerCase()
      ? Math.max(0, Number(segment.start_seconds) || 0)
      : contextGroup.start_seconds,
    speaker: stringOr(segment.speaker, "发言人"),
    quote: contextualQuote,
  };
}

function prepareEvidenceContext(segments, rawSegments, trustedTerms, correctionLedger, reconciliationLedger) {
  const displayed = segments || [];
  if (!rawSegments?.length) return { invalid: false, segmentValidity: null };
  if (
    Array.isArray(correctionLedger)
    && correctionLedger.length === 0
    && (!Array.isArray(reconciliationLedger) || reconciliationLedger.length === 0)
    && rawSegments.length === displayed.length
    && rawSegments.every((segment, index) => (
      sameTranscriptGeometry(segment, displayed[index])
      && String(segment?.text || "") === String(displayed[index]?.text || "")
    ))
  ) return { invalid: false, segmentValidity: displayed.map(() => true) };
  const derivedFromRaw = replayTranscriptReconciliations(rawSegments, Array.isArray(reconciliationLedger) ? reconciliationLedger : []);
  if (!derivedFromRaw) return { invalid: true, segmentValidity: [] };
  if (Array.isArray(correctionLedger)) {
    const replayed = replayCorrectedTranscriptWithJoins(derivedFromRaw, displayed, correctionLedger, trustedTerms);
    return replayed
      ? { invalid: false, segmentValidity: replayed.map(() => true) }
      : { invalid: true, segmentValidity: [] };
  }
  const segmentValidity = displayed.map((segment, index) => {
    const sourceSegment = derivedFromRaw[index];
    if (!sourceSegment || !sameTranscriptGeometry(sourceSegment, segment)) return false;
    const correction = safeCorrection(sourceSegment.text, segment.text, trustedTerms);
    return !correction.rejected && correction.text === segment.text;
  });
  return { invalid: false, segmentValidity };
}

function evidenceContextGroup(segments, segmentIndex) {
  const source = segments || [];
  const selected = source[segmentIndex] || {};
  let first = segmentIndex;
  let last = segmentIndex;
  let text = stringOr(selected.text, "");
  let start = Math.max(0, Number(selected.start_seconds) || 0);
  let end = Math.max(start, Number(selected.end_seconds) || start);

  while (first > 0) {
    const previous = source[first - 1];
    const current = source[first];
    const joined = joinTranscriptText(stringOr(previous?.text, ""), text);
    const joinedStart = Math.max(0, Number(previous?.start_seconds) || 0);
    if (
      previous?.join_next !== true
      || !canJoinTranscriptSegments(previous, current)
      || joined.length > MAX_READABLE_SEGMENT_CHARACTERS
      || end - joinedStart > MAX_READABLE_SEGMENT_SECONDS
    ) break;
    first -= 1;
    text = joined;
    start = joinedStart;
  }

  while (last < source.length - 1) {
    const current = source[last];
    const next = source[last + 1];
    const joined = joinTranscriptText(text, stringOr(next?.text, ""));
    const joinedEnd = Math.max(end, Number(next?.end_seconds) || Number(next?.start_seconds) || end);
    if (
      current?.join_next !== true
      || !canJoinTranscriptSegments(current, next)
      || joined.length > MAX_READABLE_SEGMENT_CHARACTERS
      || joinedEnd - start > MAX_READABLE_SEGMENT_SECONDS
    ) break;
    last += 1;
    text = joined;
    end = joinedEnd;
  }

  return { text, start_seconds: start, end_seconds: end };
}

function contextPreservingEvidenceQuote(segmentValue, quoteValue) {
  const segment = String(segmentValue || "").trim();
  const quote = String(quoteValue || "").trim();
  if (!segment || !quote) return null;
  const haystack = segment.toLocaleLowerCase();
  const needle = quote.toLocaleLowerCase();
  const start = haystack.indexOf(needle);
  if (start < 0) return comparableText(segment).includes(comparableText(quote)) ? segment : null;
  if (haystack.indexOf(needle, start + Math.max(1, needle.length)) >= 0) return null;
  return segment;
}

function replayCorrectedTranscriptWithJoins(sourceSegments, displayedSegments, correctionLedger, trustedTerms) {
  if (sourceSegments.length !== displayedSegments?.length) return null;
  const acceptedEntries = (Array.isArray(correctionLedger) ? correctionLedger : [])
    .filter((entry) => entry?.status === "accepted");
  if (acceptedEntries.some((entry) => (
    !Number.isInteger(entry?.segmentId)
    || entry.segmentId < 0
    || entry.segmentId >= sourceSegments.length
  ))) return null;
  const correctionsBySegment = acceptedCorrectionsBySegment(acceptedEntries);
  const corrected = [];
  for (let index = 0; index < sourceSegments.length; index += 1) {
    const source = sourceSegments[index];
    const displayed = displayedSegments[index];
    if (!sameTranscriptGeometry(source, displayed)) return null;
    const text = replayAcceptedCorrections(source, index, correctionsBySegment.get(index) || [], trustedTerms);
    if (text == null) return null;
    corrected.push({ ...source, text, join_next: displayed?.join_next === true });
  }
  const replayed = normalizeSemanticJoins(corrected, sourceSegments);
  const matches = replayed.every((segment, index) => (
    segment.text === String(displayedSegments[index]?.text || "")
    && (segment.join_next === true) === (displayedSegments[index]?.join_next === true)
  ));
  return matches ? replayed : null;
}

function sameTranscriptGeometry(left, right) {
  return comparableText(left?.speaker || "发言人") === comparableText(right?.speaker || "发言人")
    && Number(left?.start_seconds) === Number(right?.start_seconds)
    && Number(left?.end_seconds) === Number(right?.end_seconds);
}

function acceptedCorrectionsBySegment(correctionLedger) {
  const grouped = new Map();
  for (const entry of correctionLedger) {
    if (entry?.status !== "accepted" || !Number.isInteger(entry.segmentId)) continue;
    if (!grouped.has(entry.segmentId)) grouped.set(entry.segmentId, []);
    grouped.get(entry.segmentId).push(entry);
  }
  return grouped;
}

function replayAcceptedCorrections(segment, segmentId, entries, _trustedTerms) {
  if (!entries.length) return String(segment?.text || "");
  const source = String(segment?.text || "");
  const sourceHash = segmentSourceHash(segment, segmentId);
  const ranges = [];
  for (const entry of entries) {
    const start = Number(entry.start_offset);
    const end = Number(entry.end_offset);
    if (
      entry.source_hash !== sourceHash
      || !ACCEPTED_CORRECTION_REASONS.has(entry.reason)
      || !Number.isInteger(start)
      || !Number.isInteger(end)
      || start < 0
      || end <= start
      || end > source.length
      || typeof entry.from !== "string"
      || typeof entry.to !== "string"
      || !entry.to.trim()
      || source.slice(start, end) !== entry.from
      || ranges.some((range) => start < range.end && end > range.start)
    ) return null;
    ranges.push({ start, end, to: entry.to });
  }
  let text = source;
  for (const range of ranges.sort((left, right) => right.start - left.start)) {
    text = `${text.slice(0, range.start)}${range.to}${text.slice(range.end)}`;
  }
  return criticalFingerprint(source) === criticalFingerprint(text) ? text : null;
}

function mergeCorrectionPatches(modelPatches, reusablePatches) {
  const signatures = new Set();
  for (const patch of modelPatches) {
    const segmentId = correctionSegmentId(patch?.id);
    if (segmentId == null) continue;
    for (const replacement of Array.isArray(patch?.replacements) ? patch.replacements : []) {
      signatures.add(JSON.stringify([segmentId, replacement?.from, replacement?.to]));
    }
  }
  const reusable = reusablePatches.map((patch) => ({
    ...patch,
    replacements: patch.replacements.filter((replacement) => {
      const signature = JSON.stringify([Number(patch.id), replacement.from, replacement.to]);
      if (signatures.has(signature)) return false;
      signatures.add(signature);
      return true;
    }),
  })).filter((patch) => patch.replacements.length);
  return [...modelPatches, ...reusable];
}

function correctionSegmentId(value) {
  if (typeof value !== "number" && !(typeof value === "string" && value.trim())) return null;
  const segmentId = Number(value);
  return Number.isInteger(segmentId) ? segmentId : null;
}

function safeCorrection(sourceValue, correctedValue, trustedTerms = []) {
  const source = stringOr(sourceValue, "");
  const corrected = stringOr(correctedValue, source);
  if (!source || corrected === source) return { text: corrected, rejected: false };
  if (criticalFingerprint(source) !== criticalFingerprint(corrected)) return { text: source, rejected: true };
  const left = correctionText(source);
  const right = correctionText(corrected);
  if (!left || !right) return { text: source, rejected: true };
  if (left === right) return { text: corrected, rejected: false };
  const ratio = right.length / left.length;
  if (ratio < 0.6 || ratio > 1.5) return { text: source, rejected: true };
  const changedRange = changedRangeInReplacement(left, right);
  const trustedReplacement = trustedTerms.some((term) => {
    const normalizedTerm = correctionText(term);
    if (normalizedTerm.length < 2) return false;
    let offset = right.indexOf(normalizedTerm);
    while (offset !== -1) {
      if (offset <= changedRange.start && offset + normalizedTerm.length >= changedRange.end) return true;
      offset = right.indexOf(normalizedTerm, offset + 1);
    }
    return false;
  });
  if (!trustedReplacement) return { text: source, rejected: true };
  const limit = Math.max(8, Math.ceil(Math.max(left.length, right.length) * 0.4));
  const distance = editDistance(left, right, limit);
  return distance <= limit ? { text: corrected, rejected: false } : { text: source, rejected: true };
}

function changedRangeInReplacement(left, right) {
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start += 1;
  let leftEnd = left.length;
  let rightEnd = right.length;
  while (leftEnd > start && rightEnd > start && left[leftEnd - 1] === right[rightEnd - 1]) {
    leftEnd -= 1;
    rightEnd -= 1;
  }
  return { start, end: rightEnd };
}

function comparableText(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, "")
    .replace(/^[“”‘’"'「」『』《》〈〉，。！？、；：,.!?;:()（）…]+|[“”‘’"'「」『』《》〈〉，。！？、；：,.!?;:()（）…]+$/gu, "");
}

function correctionText(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase()
    .replace(/[\s\p{Pd}，。！？、；：“”‘’()（）,.!?;:'"…]+/gu, "");
}

function criticalFingerprint(value) {
  const text = String(value || "").normalize("NFKC").toLocaleLowerCase();
  const pattern = /[¥$€£]?[+-]?\d+(?:[.:/-]\d+)*(?:%|元|万|亿|年|月|日|点|时|分|秒)?|(?:高|低)(?:风险|成本|延迟|优先级|概率|置信度|价格|质量|性能)|(?:风险|成本|延迟|优先级|概率|置信度|价格|质量|性能)(?:很|较|更|极|偏)?[高低]|没有|不能|不会|不可|不要|切勿|勿|不|没|无|未|非|否|拒绝|反对|禁止|支持|同意|通过|驳回|接受|否决|录用|淘汰|成功|失败|增加|减少|上升|下降|\b(?:no|not|never|without|cannot|can't|won't|don't|doesn't|didn't|isn't|aren't|shouldn't|mustn't|support|oppose|accept|reject|approve|deny|hire|fail|increase|decrease|success|failure|high[ -]?risk|low[ -]?risk)\b/giu;
  return (text.match(pattern) || []).join("|");
}

function editDistance(left, right, limit) {
  if (Math.abs(left.length - right.length) > limit) return limit + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    let rowMinimum = row;
    for (let column = 1; column <= right.length; column += 1) {
      const value = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
      current.push(value);
      rowMinimum = Math.min(rowMinimum, value);
    }
    if (rowMinimum > limit) return limit + 1;
    previous = current;
  }
  return previous[right.length];
}

function enumOr(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

export function formatTimestamp(seconds, vtt = false) {
  const total = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const wholeSeconds = Math.floor(total % 60);
  if (vtt) {
    const milliseconds = Math.floor((total % 1) * 1000);
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
  }
  return hours ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}` : `${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}`;
}

export function toMarkdown(meeting) {
  meeting = publicMeeting(meeting);
  if (meeting.mode === "interview") return toInterviewMarkdown(meeting);
  const legacyNote = meeting.legacy_unverified_insights
    ? ["> 注意：旧版智能纪要缺少逐字稿证据，仅供人工复核。", ""]
    : [];
  const transcriptSegments = readableTranscriptSegments(meeting.segments);
  const actions = meeting.action_items?.length ? meeting.action_items.map((item) => `- [ ] ${item.task}${item.owner ? ` · ${item.owner}` : ""}${item.due ? ` · ${item.due}` : ""}`).join("\n") : "无";
  const highlights = meeting.highlights?.length ? meeting.highlights.flatMap((item) => [
    `### ${formatTimestamp(item.start_seconds)} · ${item.speaker || "发言人"}`,
    "",
    `> ${item.quote}`,
    "",
    item.reason || "",
    "",
  ]) : ["无", ""];
  const speakers = meeting.speaker_summaries?.length ? meeting.speaker_summaries.flatMap((item) => [
    `### ${item.speaker || "发言人"}`,
    "",
    item.summary || "无",
    "",
    ...(item.key_points?.length ? item.key_points.map((point) => `- ${point}`) : []),
    "",
  ]) : ["无", ""];
  const decisions = meeting.decision_records?.length ? meeting.decision_records.map((item) => {
    const time = item.start_seconds == null ? "" : ` [${formatTimestamp(item.start_seconds)}]`;
    return `-${time} ${item.decision}${item.evidence ? ` · “${item.evidence}”` : ""}`;
  }) : ["无"];
  return [
    `# ${meeting.title}`, "",
    `- 创建时间：${new Date(meeting.createdAt).toLocaleString("zh-CN")}`,
    `- 时长：${formatTimestamp(meeting.duration)}`, "", ...legacyNote,
    "## AI 摘要", "", meeting.summary || "无", "",
    "## 关键词", "", ...(meeting.keywords?.length ? meeting.keywords.map((item) => `- ${item}`) : ["无"]), "",
    "## 会议金句", "", ...highlights,
    "## 发言人总结", "", ...speakers,
    "## 关键决策", "", ...decisions, "",
    "## 行动项", "", actions, "",
    "## 逐字稿", "", ...transcriptSegments.flatMap((segment) => [`### ${formatTimestamp(segment.start_seconds)} · ${segment.speaker || "发言人"}`, "", segment.text, ""]),
  ].join("\n").trimEnd() + "\n";
}

function toInterviewMarkdown(meeting) {
  const context = meeting.interviewContext || {};
  const report = meeting.interviewReport || {};
  const transcriptSegments = readableTranscriptSegments(meeting.segments);
  const coverage = report.competencies?.filter((item) => item.evidence?.length).map((item) => (
    `- ${item.name}：${item.evidence.length} 条逐字稿原话，需核对说话人并人工判断`
  )) || [];
  const competencies = report.competencies?.length ? report.competencies.flatMap((item) => [
    `### ${item.name} · ${ratingLabel(item.rating)}`,
    "",
    item.assessment || "证据不足",
    "",
    ...(item.evidence?.length ? item.evidence.map((evidence) => `- [${formatTimestamp(evidence.start_seconds)}] ${evidence.speaker || "发言人"}：“${evidence.quote}”`) : ["- 无可核验证据"]),
    "",
  ]) : ["无能力项评估", ""];
  return [
    `# ${meeting.title}`, "",
    `- 候选人代称：${context.candidateAlias || "候选人"}`,
    `- 目标岗位：${context.role || "未提供"}`,
    `- 面试轮次：${context.stage || "未提供"}`,
    `- 创建时间：${new Date(meeting.createdAt).toLocaleString("zh-CN")}`,
    `- 时长：${formatTimestamp(meeting.duration)}`, "",
    "> 此报告只整理经时间、说话人与原文校验的逐字稿证据，不判断原话是否来自候选人或证明能力，不用于自动录用决定。请回听复核并忽略敏感个人属性。", "",
    "## 证据复核", "",
    report.overview || meeting.summary || "证据不足", "",
    "## 证据覆盖", "", ...(coverage.length ? coverage : ["无通过校验的逐字稿原话"]), "",
    "## 能力证据", "", ...competencies,
    "## 风险与待核实项", "", ...(report.risks?.length ? report.risks.map((item) => `- ${item}`) : ["无"]), "",
    "## 建议追问", "", ...(report.follow_ups?.length ? report.follow_ups.map((item) => `- ${item}`) : ["无"]), "",
    "## 逐字稿", "",
    ...transcriptSegments.flatMap((segment) => [`### ${formatTimestamp(segment.start_seconds)} · ${segment.speaker || "发言人"}`, "", segment.text, ""]),
  ].join("\n").trimEnd() + "\n";
}

export function toVtt(meeting) {
  const segments = meeting.segments || [];
  const blocks = segments.map((segment, index) => {
    const start = segment.start_seconds || 0;
    const next = segments[index + 1]?.start_seconds;
    const end = segment.end_seconds > start ? segment.end_seconds : (next > start ? next : start + 4);
    return `${index + 1}\n${formatTimestamp(start, true)} --> ${formatTimestamp(end, true)}\n${segment.speaker || "发言人"}：${segment.text}`;
  });
  return `WEBVTT\n\n${blocks.join("\n\n")}\n`;
}

export function publicMeeting(meeting) {
  const terminologyMappings = validatedTerminologyMappings(meeting);
  const insights = normalizeGeneratedTerminology({
    title: meeting.title,
    summary: meeting.summary,
    keywords: meeting.keywords,
    highlights: meeting.highlights,
    speaker_summaries: meeting.speaker_summaries,
    decision_records: meeting.decision_records,
    action_items: meeting.action_items,
    interviewReport: meeting.interviewReport,
  }, terminologyMappings);
  const agentCommitmentProofs = trustedMeetingCommitmentProofs(meeting);
  const decisionRecords = normalizeDecisionRecords(
    insights.decision_records,
    meeting.segments,
    meeting.rawSegments,
    meeting.terminology,
    meeting.corrections,
    meeting.asrReconciliations,
    agentCommitmentProofs,
  );
  const verifiedSpeakerSummaries = normalizeVerifiedSpeakerSummaries(insights.speaker_summaries, meeting.segments, meeting.rawSegments, meeting.terminology, meeting.corrections, meeting.asrReconciliations);
  const verifiedActions = normalizeVerifiedActionItems(
    insights.action_items,
    meeting.segments,
    meeting.rawSegments,
    meeting.terminology,
    meeting.corrections,
    meeting.asrReconciliations,
    agentCommitmentProofs,
  );
  const legacySpeakerSummaries = legacyUnverifiedSpeakerSummaries(insights.speaker_summaries, verifiedSpeakerSummaries);
  const legacyActions = legacyUnverifiedActionItems(insights.action_items, verifiedActions);
  const result = {
    schema: 4, title: insights.title, createdAt: meeting.createdAt, duration: meeting.duration,
    language: meeting.language || "", summary: insights.summary || "", keywords: insights.keywords || [],
    highlights: normalizeHighlights(insights.highlights, meeting.segments, meeting.rawSegments, meeting.terminology, meeting.corrections, meeting.asrReconciliations),
    speaker_summaries: [...verifiedSpeakerSummaries, ...legacySpeakerSummaries],
    decisions: decisionRecords.map((item) => item.decision), decision_records: decisionRecords,
    action_items: [...verifiedActions, ...legacyActions],
    segments: publicTranscriptSegments(meeting.segments || []),
  };
  const publishedCommitmentProofs = meetingAnalysisCommitmentProofs({
    decision_records: decisionRecords,
    action_items: verifiedActions,
  }).filter((proof) => agentCommitmentProofs.has(proof));
  if (publishedCommitmentProofs.length) {
    result.analysis_proof = {
      schema: 1,
      source_signature: meetingAnalysisSourceSignature(result.segments),
      commitment_proofs: publishedCommitmentProofs,
    };
  }
  if (legacySpeakerSummaries.length || legacyActions.length) {
    result.legacy_unverified_insights = {
      speaker_summaries: legacySpeakerSummaries.length,
      action_items: legacyActions.length,
    };
  }
  if (meeting.mode === "interview") {
    result.mode = "interview";
    result.interviewContext = {
      candidateAlias: meeting.interviewContext?.candidateAlias || "",
      role: meeting.interviewContext?.role || "",
      stage: meeting.interviewContext?.stage || "",
      competencies: stringArray(meeting.interviewContext?.competencies),
    };
    result.interviewReport = normalizeInterviewReport(insights.interviewReport, result.interviewContext.competencies, result.segments, meeting.rawSegments, meeting.terminology, meeting.corrections, meeting.asrReconciliations);
    if (!result.interviewReport.competencies.some((item) => item.evidence.length)) result.summary = result.interviewReport.overview;
  }
  return result;
}

function legacyUnverifiedSpeakerSummaries(value, verified) {
  const verifiedSpeakers = new Set((verified || []).map((item) => comparableText(item.speaker)));
  return normalizeSpeakerSummaries((Array.isArray(value) ? value : []).filter((item) => (
    !Array.isArray(item?.evidence) || item?.verification_status === "legacy_unverified"
  )))
    .filter((item) => !verifiedSpeakers.has(comparableText(item.speaker)))
    .map((item) => ({ ...item, evidence: [], verification_status: "legacy_unverified" }));
}

function legacyUnverifiedActionItems(value, verified) {
  const verifiedTasks = new Set((verified || []).map((item) => comparableText(item.task)));
  return normalizeActionItems((Array.isArray(value) ? value : []).filter((item) => !Object.hasOwn(item || {}, "evidence")))
    .filter((item) => !verifiedTasks.has(comparableText(item.task)))
    .map((item) => ({ ...item, verification_status: "legacy_unverified" }));
}

function publicTranscriptSegment(segment) {
  return {
    start_seconds: Math.max(0, Number(segment?.start_seconds) || 0),
    end_seconds: Math.max(0, Number(segment?.end_seconds) || 0),
    speaker: String(segment?.speaker || "发言人 1"),
    text: String(segment?.text || ""),
  };
}

export function buildShareHtml(meeting) {
  let html = buildShareHtmlDocument(meeting);
  html = html
    .replace(
      "const generic=m.mode!==\"interview\"?",
      "const legacy=m.legacy_unverified_insights?'<p class=\"notice\">旧版智能纪要缺少逐字稿证据，仅供人工复核。</p>':'';const generic=m.mode!==\"interview\"?",
    )
    .replace("</header>'+interview+generic+", "</header>'+legacy+interview+generic+");
  if (meeting.mode !== "interview") return html;
  return html
    .replace("AI 辅助评估仅供面试官复核，不用于自动录用决定；请忽略敏感个人属性并核对原始证据。", "程序只校验时间和原话，不判断是否证明能力；请回听复核，不用于自动录用决定，并忽略敏感个人属性。")
    .replace("<h2>辅助结论</h2>", "<h2>证据复核</h2>")
    .replace('cl={high:"高",medium:"中",low:"低"}', 'cl={high:"有证据",medium:"有证据",low:"证据不足"}')
    .replace(
      `(c.evidence||[]).map(v=>'<div class="evidence">['+t(v.start_seconds)+'] “'+e(v.quote)+'”</div>')`,
      `(c.evidence||[]).map(v=>'<div class="evidence">['+t(v.start_seconds)+'] '+e(v.speaker||"发言人")+' · “'+e(v.quote)+'”</div>')`,
    )
    .replace("置信度 ", "证据状态 ");
}

function buildShareHtmlDocument(meeting) {
  return paginateShareTranscriptDocument(buildShareHtmlDocumentBase(meeting));
}

function paginateShareTranscriptDocument(html) {
  const dataMarker = ",ds=m.display_segments||m.segments;const interview=";
  const transcriptMarker = "'<section><h2>逐字稿</h2>'+ds.map";
  const footerMarker = ".join(\"\")+'</section><footer>由言澜 Yanlan 生成</footer>'";
  if (!html.includes(dataMarker) || !html.includes(transcriptMarker) || !html.includes(footerMarker)) {
    throw new Error("离线逐字稿模板分页标记缺失");
  }

  const paginationCss = ".transcript-pages{display:flex;align-items:center;justify-content:center;gap:8px;margin-top:18px}.transcript-pages[hidden]{display:none}.transcript-pages button{display:grid;width:30px;height:30px;place-items:center;padding:0;color:#344054;background:#fff;border:1px solid #d0d5dd;border-radius:6px;cursor:pointer;font-size:18px;line-height:1}.transcript-pages button:hover:not(:disabled){color:#087e8b;border-color:#087e8b}.transcript-pages button:disabled{opacity:.4;cursor:default}.transcript-range{min-width:112px;text-align:center;color:#667085;font-size:12px}";
  const paginationMarkup = "</div><nav class=\"transcript-pages\" id=\"transcriptPages\" aria-label=\"逐字稿分页\"><button type=\"button\" data-page=\"first\" aria-label=\"第一页\" title=\"第一页\">«</button><button type=\"button\" data-page=\"previous\" aria-label=\"上一页\" title=\"上一页\">‹</button><span class=\"transcript-range\" id=\"transcriptRange\" aria-live=\"polite\"></span><button type=\"button\" data-page=\"next\" aria-label=\"下一页\" title=\"下一页\">›</button><button type=\"button\" data-page=\"last\" aria-label=\"最后一页\" title=\"最后一页\">»</button></nav>";
  const paginationScript = `const tr=document.querySelector("#transcriptRows"),pn=document.querySelector("#transcriptPages"),pr=document.querySelector("#transcriptRange");const br=()=>{document.querySelectorAll("[data-overlap]").forEach(b=>b.addEventListener("click",()=>{const s=ds[Number(b.dataset.overlap)],p=b.previousElementSibling,x=b.getAttribute("aria-expanded")==="true";b.setAttribute("aria-expanded",String(!x));b.setAttribute("aria-label",x?"展开重叠原文":"折叠重叠原文");b.title=x?"展开重叠原文":"折叠重叠原文";b.textContent=x?"+":"−";p.textContent=x?s.text:s.source_text;}));};const rr=n=>{const pc=Math.max(1,Math.ceil(all.length/ps));pg=Math.max(0,Math.min(pc-1,n));const st=pg*ps;ds=all.slice(st,st+ps);tr.innerHTML=ds.map((s,i)=>'<article><time>'+t(s.start_seconds)+'</time><div><div class="speaker">'+e(s.speaker||"发言人")+'</div><div class="copy"><p>'+e(s.text)+'</p>'+(s.collapsed_overlap?'<button class="overlap-toggle" type="button" data-overlap="'+i+'" aria-expanded="false" aria-label="展开重叠原文" title="展开重叠原文">+</button>':'')+'</div></div></article>').join("");pr.textContent=all.length?(st+1)+"–"+(st+ds.length)+" / "+all.length:"0 / 0";pn.hidden=all.length<=ps;pn.querySelector('[data-page="first"]').disabled=pg===0;pn.querySelector('[data-page="previous"]').disabled=pg===0;pn.querySelector('[data-page="next"]').disabled=pg===pc-1;pn.querySelector('[data-page="last"]').disabled=pg===pc-1;br();};pn.addEventListener("click",v=>{const c=v.target.closest("[data-page]");if(!c)return;const pc=Math.max(1,Math.ceil(all.length/ps));const nx={first:0,previous:pg-1,next:pg+1,last:pc-1}[c.dataset.page];rr(nx);document.querySelector("#transcriptSection").scrollIntoView({block:"start"});});rr(0);`;

  let result = html.replace("</style>", `${paginationCss}</style>`);
  result = replaceLastShareTemplateMarker(
    result,
    dataMarker,
    ",all=m.display_segments||m.segments,ps=200;let pg=0,ds=all.slice(0,ps);const interview=",
  );
  result = replaceLastShareTemplateMarker(
    result,
    transcriptMarker,
    "'<section id=\"transcriptSection\"><h2>逐字稿</h2><div id=\"transcriptRows\">'+ds.map",
  );
  result = replaceLastShareTemplateMarker(
    result,
    footerMarker,
    `.join("")+'${paginationMarkup}</section><footer>由言澜 Yanlan 生成</footer>'`,
  );
  return result.replace("</script></body>", `${paginationScript}</script></body>`);
}

function replaceLastShareTemplateMarker(source, marker, replacement) {
  const index = source.lastIndexOf(marker);
  if (index < 0) throw new Error("离线逐字稿模板分页标记缺失");
  return source.slice(0, index) + replacement + source.slice(index + marker.length);
}

function displayProjectionChangesTranscript(source, display) {
  if (source.length !== display.length) return true;
  return display.some((segment, index) => (
    Boolean(segment.collapsed_overlap)
    || segment.text !== source[index]?.text
    || segment.speaker !== source[index]?.speaker
    || segment.start_seconds !== source[index]?.start_seconds
    || segment.end_seconds !== source[index]?.end_seconds
  ));
}

function buildShareHtmlDocumentBase(meeting) {
  const publicData = publicMeeting(meeting);
  const displaySegments = transcriptDisplaySegments(publicData.segments);
  if (displayProjectionChangesTranscript(publicData.segments, displaySegments)) {
    publicData.display_segments = displaySegments;
  }
  publicData.segments = publicData.segments.map(({ join_next: _joinNext, ...segment }) => segment);
  const payload = JSON.stringify(publicData).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(publicData.title)} · 言澜</title><style>body{margin:0;color:#182230;background:#f7f8fa;font:14px/1.75 system-ui,-apple-system,"PingFang SC",sans-serif}main{width:min(820px,calc(100% - 32px));margin:auto;padding:40px 0 70px}header{padding-bottom:24px;border-bottom:1px solid #dfe3e8}h1{margin:0 0 6px;font-size:26px}h2{margin:28px 0 10px;font-size:17px}h3{margin:16px 0 4px;font-size:14px}.meta,time{color:#667085;font-size:12px}.summary{margin:26px 0;padding-left:16px;border-left:3px solid #087e8b}.notice{padding:12px 14px;color:#7a2e0e;background:#fff5eb;border:1px solid #fed7aa;border-radius:7px}.result{display:flex;gap:16px;align-items:center;margin:16px 0}.pill{padding:3px 8px;border-radius:999px;background:#eef4ff;color:#1849a9;font-weight:650}.competency,.insight-row{padding:14px 0;border-bottom:1px solid #e4e7ec}.competency strong{margin-right:8px}.evidence,.reason{margin:6px 0;color:#475467}.quote{margin:4px 0;font-size:16px}.points{margin:6px 0;padding-left:20px}.decision-time{margin-right:8px;color:#2864dc}article{display:grid;grid-template-columns:62px 1fr;padding:18px 0;border-bottom:1px solid #e4e7ec}article p{min-width:0;flex:1;margin:2px 0 0;overflow-wrap:anywhere;white-space:pre-line}.copy{display:flex;min-height:26px;align-items:flex-start;gap:8px}.overlap-toggle{display:grid;width:26px;height:26px;flex:0 0 26px;place-items:center;padding:0;color:#667085;background:#f2f4f7;border:1px solid #d0d5dd;border-radius:6px;cursor:pointer;font-size:18px;line-height:1}.overlap-toggle:hover,.overlap-toggle[aria-expanded=true]{color:#087e8b;background:#e8f8f5;border-color:#087e8b}.speaker{font-weight:650}footer{margin-top:32px;color:#98a2b3;font-size:11px}@media(max-width:560px){main{padding-top:24px}article{grid-template-columns:1fr;gap:5px}.result{align-items:flex-start;flex-direction:column;gap:5px}}</style></head><body><main id="app"></main><script>const m=${payload};const e=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));const t=n=>{n=Math.max(0,Number(n)||0);const h=Math.floor(n/3600),x=Math.floor(n%3600/60),s=Math.floor(n%60);return(h?String(h).padStart(2,"0")+":":"")+String(x).padStart(2,"0")+":"+String(s).padStart(2,"0")};const rl={advance:"建议推进",follow_up:"补充追问",hold:"暂不推进",insufficient:"证据不足"},cl={high:"高",medium:"中",low:"低"},gl={strong:"突出",adequate:"符合",mixed:"有待确认",weak:"不足",insufficient:"证据不足"},ds=m.display_segments||m.segments;const interview=m.mode==="interview"&&m.interviewReport?'<section><p class="notice">AI 辅助评估仅供面试官复核，不用于自动录用决定；请忽略敏感个人属性并核对原始证据。</p><h2>辅助结论</h2><div class="result"><span class="pill">'+e(rl[m.interviewReport.recommendation]||"证据不足")+'</span><span>置信度 '+e(cl[m.interviewReport.confidence]||"低")+'</span></div><p>'+e(m.interviewReport.overview||m.summary||"证据不足")+'</p><h2>能力证据</h2>'+(m.interviewReport.competencies||[]).map(c=>'<div class="competency"><strong>'+e(c.name)+'</strong><span>'+e(gl[c.rating]||"证据不足")+'</span><div>'+e(c.assessment)+'</div>'+(c.evidence||[]).map(v=>'<div class="evidence">['+t(v.start_seconds)+'] “'+e(v.quote)+'”</div>').join("")+'</div>').join("")+'</section>':'';const generic=m.mode!=="interview"?'<section class="summary"><strong>AI 摘要</strong><div>'+e(m.summary||"无")+'</div></section>'+((m.highlights||[]).length?'<section><h2>会议金句</h2>'+m.highlights.map(v=>'<div class="insight-row"><time>'+t(v.start_seconds)+'</time> · <strong>'+e(v.speaker)+'</strong><p class="quote">“'+e(v.quote)+'”</p>'+(v.reason?'<p class="reason">'+e(v.reason)+'</p>':'')+'</div>').join("")+'</section>':'')+((m.speaker_summaries||[]).length?'<section><h2>发言人总结</h2>'+m.speaker_summaries.map(v=>'<div class="insight-row"><h3>'+e(v.speaker)+'</h3><div>'+e(v.summary)+'</div>'+((v.key_points||[]).length?'<ul class="points">'+v.key_points.map(p=>'<li>'+e(p)+'</li>').join("")+'</ul>':'')+'</div>').join("")+'</section>':'')+(((m.decision_records||[]).length||(m.decisions||[]).length)?'<section><h2>关键决策</h2>'+((m.decision_records||[]).length?m.decision_records.map(v=>'<div class="insight-row">'+(v.start_seconds==null?'':'<span class="decision-time">['+t(v.start_seconds)+']</span>')+'<strong>'+e(v.decision)+'</strong>'+(v.evidence?'<p class="evidence">“'+e(v.evidence)+'”</p>':'')+'</div>').join(""):(m.decisions||[]).map(v=>'<div class="insight-row">'+e(v)+'</div>').join(""))+'</section>':''):'';document.querySelector("#app").innerHTML='<header><h1>'+e(m.title)+'</h1><div class="meta">'+e(new Date(m.createdAt).toLocaleString("zh-CN"))+' · '+t(m.duration)+'</div></header>'+interview+generic+'<section><h2>逐字稿</h2>'+ds.map((s,i)=>'<article><time>'+t(s.start_seconds)+'</time><div><div class="speaker">'+e(s.speaker||"发言人")+'</div><div class="copy"><p>'+e(s.text)+'</p>'+(s.collapsed_overlap?'<button class="overlap-toggle" type="button" data-overlap="'+i+'" aria-expanded="false" aria-label="展开重叠原文" title="展开重叠原文">+</button>':'')+'</div></div></article>').join("")+'</section><footer>由言澜 Yanlan 生成</footer>';document.querySelectorAll('[data-overlap]').forEach(b=>b.addEventListener('click',()=>{const s=ds[Number(b.dataset.overlap)],p=b.previousElementSibling,x=b.getAttribute('aria-expanded')==='true';b.setAttribute('aria-expanded',String(!x));b.setAttribute('aria-label',x?'展开重叠原文':'折叠重叠原文');b.title=x?'展开重叠原文':'折叠重叠原文';b.textContent=x?'+':'−';p.textContent=x?s.text:s.source_text;}));<\/script></body></html>`;
}

function ratingLabel(value) {
  return ({ strong: "突出", adequate: "符合", mixed: "有待确认", weak: "不足", insufficient: "证据不足" })[value] || "证据不足";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}
