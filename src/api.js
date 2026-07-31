export const DEFAULT_CONFIG = Object.freeze({
  asrBaseUrl: "",
  asrApiKey: "",
  asrModel: "mimo-v2.5-asr",
  asrProtocol: "mimo-chat",
  asrPath: "chat/completions",
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
const MAX_TEXT_INPUT_CHARACTERS = 18_000;
const SUMMARY_MERGE_GROUP_SIZE = 4;
const SUMMARY_MERGE_ITEM_CHARACTERS = 3_500;
const MAX_CORRECTION_CONTEXT_CHARACTERS = 2_000;
const MAX_CORRECTION_BATCH_JSON_CHARACTERS = 10_000;

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
    if (error?.name === "TimeoutError") throw retryableError("API 请求超时，请稍后重试", error);
    if (error?.name === "AbortError") throw new Error("API 请求已取消", { cause: error });
    if (error instanceof TypeError) {
      if (config.transportMode === "relay") throw retryableError("本地同源网关不可用，请使用 npm run local 启动言澜", error);
      throw retryableError("无法访问 API，请检查 Base URL 与网络连接；浏览器直连时还需检查服务端 CORS", error);
    }
    throw error;
  }
  let raw;
  try {
    raw = await response.text();
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("API 请求已取消", { cause: error });
    throw retryableError("读取 API 响应时连接中断，请稍后重试", error);
  }
  let body;
  try { body = raw ? JSON.parse(raw) : {}; }
  catch { body = { message: raw }; }
  if (!response.ok) {
    const message = body?.error?.message || body?.message || body?.detail || `API 请求失败（HTTP ${response.status}）`;
    const error = new Error(`${message}（HTTP ${response.status}）`);
    error.status = response.status;
    error.retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
    throw error;
  }
  return body;
}

function requestSignal(signal) {
  return signal || AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS);
}

function retryableError(message, cause) {
  const error = new Error(message, { cause });
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

export function parseTranscriptionResponse(body) {
  const choiceContent = body?.choices?.[0]?.message?.content;
  const text = String(body?.text ?? body?.transcript ?? (typeof choiceContent === "string" ? choiceContent : "")).trim();
  const sourceSegments = Array.isArray(body?.segments) ? body.segments : [];
  const segments = sourceSegments.map((segment, index) => ({
    start_seconds: numericTime(segment.start_seconds ?? segment.start ?? segment.begin_time ?? 0),
    end_seconds: numericTime(segment.end_seconds ?? segment.end ?? segment.end_time ?? 0),
    speaker: String(segment.speaker ?? segment.speaker_id ?? `发言人 ${index + 1}`),
    text: String(segment.text ?? segment.transcript ?? "").trim(),
  })).filter((segment) => segment.text);
  if (!segments.length && text) segments.push({ start_seconds: 0, end_seconds: 0, speaker: "发言人 1", text });
  return { text: text || segments.map((segment) => segment.text).join(" "), segments, raw: body };
}

function numericTime(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return number > 10000 ? number / 1000 : number;
}

export async function summarizeTranscript({ config, meeting, signal }) {
  const segments = meeting.segments || [];
  if (!segments.some((segment) => String(segment?.text || "").trim())) return emptySummary();
  if (meeting.mode === "interview") return summarizeInterviewTranscript({ config, meeting, signal });
  const system = `你是严谨的会议纪要助手。请仅依据带时间和发言人的逐字稿输出纯 JSON，不要使用 Markdown 代码块。
字段必须为：
1. title（简短标题）、summary（完整摘要）、keywords（字符串数组）；
2. highlights（会议金句数组，每项含 start_seconds、speaker、quote、reason）；
3. speaker_summaries（发言人总结数组，每项含 speaker、summary、key_points 字符串数组）；
4. decisions（关键决策字符串数组）；
5. decision_records（关键决策证据数组，每项含 decision、start_seconds、evidence）；
6. action_items（行动项数组，每项含 task、owner、due，未知填空字符串）。
金句必须是逐字稿中的简短原话，speaker 和 start_seconds 必须对应原片段。关键决策的 evidence 必须是逐字稿中的简短原话并使用对应 start_seconds。只总结有实际发言的说话人。不得虚构逐字稿里没有的信息、时间或原话。`;
  const transcriptBatches = splitTranscriptPromptBatches(segments, MAX_TEXT_INPUT_CHARACTERS - 300);
  const partials = [];
  for (let index = 0; index < transcriptBatches.length; index += 1) {
    const batchLabel = transcriptBatches.length > 1 ? `（第 ${index + 1}/${transcriptBatches.length} 段，仅总结本段）` : "";
    const content = await chatCompletion({
      config,
      system,
      user: `会议逐字稿${batchLabel}：\n${transcriptBatches[index]}`,
      signal,
    });
    partials.push(parseJsonObject(content));
  }
  const merged = partials.length === 1
    ? partials[0]
    : await mergeMeetingSummaryTree({ config, summaries: partials, signal });
  const decisionRecords = normalizeDecisionRecords(
    uniqueItems(partials.flatMap((item) => Array.isArray(item?.decision_records) ? item.decision_records : []), decisionRecordKey),
    meeting.segments,
    meeting.rawSegments,
    meeting.terminology,
  );
  return {
    title: stringOr(merged.title, partials.map((item) => stringOr(item?.title, "")).find(Boolean) || ""),
    summary: stringOr(merged.summary, partials.map((item) => stringOr(item?.summary, "")).filter(Boolean).join("\n")),
    keywords: uniqueStrings([merged, ...partials].flatMap((item) => stringArray(item?.keywords))).slice(0, 60),
    highlights: normalizeHighlights(
      uniqueItems(partials.flatMap((item) => Array.isArray(item?.highlights) ? item.highlights : []), highlightKey),
      meeting.segments,
      meeting.rawSegments,
      meeting.terminology,
    ),
    speaker_summaries: mergeSpeakerSummaries([merged, ...partials].flatMap((item) => Array.isArray(item?.speaker_summaries) ? item.speaker_summaries : [])),
    decisions: decisionRecords.map((item) => item.decision),
    decision_records: decisionRecords,
    action_items: normalizeActionItems([merged, ...partials].flatMap((item) => Array.isArray(item?.action_items) ? item.action_items : [])),
  };
}

async function mergeMeetingSummaryTree({ config, summaries, signal }) {
  const system = `你是会议分段摘要合并助手。输入是按时间相邻的分段摘要，不是原始逐字稿。请合并为纯 JSON，只输出 title、summary、keywords、speaker_summaries、action_items。保留各段的重要事实、决策含义、人员和行动项，不得添加输入中没有的信息。`;
  let level = summaries.map(compactMeetingSummaryForMerge);
  while (level.length > 1) {
    const next = [];
    for (let index = 0; index < level.length; index += SUMMARY_MERGE_GROUP_SIZE) {
      const group = level.slice(index, index + SUMMARY_MERGE_GROUP_SIZE);
      if (group.length === 1) {
        next.push(group[0]);
        continue;
      }
      const content = await chatCompletion({
        config,
        system,
        user: `请按时间顺序合并以下 ${group.length} 份相邻分段摘要：\n${JSON.stringify(group)}`,
        signal,
      });
      next.push(compactMeetingSummaryForMerge(parseJsonObject(content)));
    }
    level = next;
  }
  return level[0] || {};
}

async function summarizeInterviewTranscript({ config, meeting, signal }) {
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
  const partials = [];
  for (let index = 0; index < transcriptBatches.length; index += 1) {
    const batchLabel = transcriptBatches.length > 1 ? `（第 ${index + 1}/${transcriptBatches.length} 段，仅提取本段证据）` : "";
    const content = await chatCompletion({
      config,
      system,
      user: `${context}\n\n面试逐字稿${batchLabel}：\n${transcriptBatches[index]}`,
      signal,
    });
    partials.push(parseJsonObject(content));
  }
  const mergedReport = mergeInterviewReportParts(partials.map((item) => item?.interview_report));
  const report = normalizeInterviewReport(mergedReport, meeting.interviewContext?.competencies, meeting.segments, meeting.rawSegments, meeting.terminology);
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

export async function correctTranscript({ config, meeting, signal }) {
  const original = meeting.rawSegments?.length ? meeting.rawSegments : meeting.segments || [];
  if (!original.length) return { segments: [], terminology: [], rejectedCorrections: 0 };
  const batches = splitSegmentBatches(original, 8_000);
  const corrected = [];
  const terminology = [];
  const sharedContext = truncateText(config.contextHint, MAX_CORRECTION_CONTEXT_CHARACTERS);
  const trustedTermsFromUser = explicitTermsFromContext(sharedContext);
  if (meeting.mode === "interview") {
    trustedTermsFromUser.push(meeting.interviewContext?.role || "", ...stringArray(meeting.interviewContext?.competencies));
  }
  let rejectedCorrections = 0;
  for (const batch of batches) {
    const input = batch.map((segment, localIndex) => ({
      id: corrected.length + localIndex,
      speaker: segment.speaker || "发言人",
      text: segment.text,
    }));
    const serializedInput = JSON.stringify(input);
    if (serializedInput.length > MAX_CORRECTION_BATCH_JSON_CHARACTERS) {
      corrected.push(...batch.map((segment) => ({ ...segment, speaker: stringOr(segment.speaker, "发言人") })));
      rejectedCorrections += batch.length;
      continue;
    }
    const interviewRules = meeting.mode === "interview" ? "这是面试逐字稿。不得依据声音、口音、姓名或敏感个人属性推断角色。" : "";
    const system = `你是逐字稿校对员。根据背景和上下文，仅纠正明显的语音识别错误、专有名词、人名、同音词、标点和前后不一致。不得总结、改写、删减或添加事实，speaker 必须原样返回。${interviewRules}必须返回纯 JSON：{"segments":[{"id":数字,"speaker":"...","text":"..."}],"terminology":["统一后的术语"]}。segments 数量、顺序和 id 必须与输入完全一致。`;
    const context = meeting.mode === "interview"
      ? `${truncateText(interviewContextForPrompt(meeting), 3_000)}\n\n通用背景 / 专有名词：\n${sharedContext || "未提供"}`
      : `会议背景 / 术语表：\n${sharedContext || "未提供"}`;
    const user = `${context}\n\n前序已统一术语：\n${terminology.join("、") || "无"}\n\n待校对片段：\n${serializedInput}`;
    const content = await chatCompletion({ config, system, user, signal });
    const parsed = parseJsonObject(content);
    const batchTerms = stringArray(parsed.terminology);
    const trustedTerms = batchTerms.filter((term) => (
      correctionText(term).length >= 2
      && trustedTermsFromUser.some((trustedTerm) => comparableText(trustedTerm) === comparableText(term))
    ));
    const acceptedTerms = new Set();
    const byId = new Map((Array.isArray(parsed.segments) ? parsed.segments : []).map((item) => [Number(item?.id), item]));
    input.forEach((item, localIndex) => {
      const source = batch[localIndex];
      const result = byId.get(item.id);
      const correction = safeCorrection(source.text, result?.text, trustedTerms);
      if (correction.rejected) rejectedCorrections += 1;
      else {
        for (const term of trustedTerms) {
          const normalizedTerm = correctionText(term);
          if (normalizedTerm && occurrenceCount(correctionText(correction.text), normalizedTerm) > occurrenceCount(correctionText(source.text), normalizedTerm)) acceptedTerms.add(term);
        }
      }
      corrected.push({
        ...source,
        // Speaker attribution cannot be proven from a text-only correction response.
        speaker: stringOr(source.speaker, "发言人"),
        text: correction.text,
      });
    });
    for (const term of acceptedTerms) if (!terminology.includes(term)) terminology.push(term);
  }
  return { segments: corrected, terminology: terminology.slice(0, 60), rejectedCorrections };
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
  return chatCompletion({
    config,
    system: interview
      ? `你是面试证据问答助手。只能依据岗位信息与给定逐字稿${fullFits ? "" : "选取片段"}回答，优先给出时间点和原话；没有依据时明确说证据不足。只讨论岗位相关信息，忽略且不得推断敏感个人属性，不得根据声音、口音或表达风格推断能力，不替代人工录用决定。${fullFits ? "" : "给定内容只是从超长逐字稿中按问题选取的片段，不代表完整逐字稿。"}`
      : `你是会议记录问答助手。只能依据给定逐字稿${fullFits ? "" : "选取片段"}回答；没有依据时明确说逐字稿中未提及。回答简洁，并尽量引用相关时间点。${fullFits ? "" : "给定内容只是从超长逐字稿中按问题选取的片段，不代表完整逐字稿。"}`,
    user: `${prefix}${transcript}${questionSuffix}`,
    signal,
  });
}

async function chatCompletion({ config, system, user, signal }) {
  if (!config.chatModel?.trim()) throw new Error("请先填写文本模型名称");
  const protocol = config.chatProtocol || (/\bresponses\/?$/i.test(config.chatPath || "") ? "responses" : "chat-completions");
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
  const body = await apiFetch(joinApiUrl(config.chatBaseUrl, config.chatPath), {
    method: "POST",
    headers: authHeaders(config.chatApiKey),
    body: JSON.stringify(requestBody),
    signal,
  }, config);
  const content = responseText(body);
  if (!content) throw new Error("文本模型没有返回内容");
  return content;
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
  const fragments = transcriptPromptFragments(segments, Math.min(2_000, maxCharacters));
  const batches = [];
  let lines = [];
  let size = 0;
  for (const fragment of fragments) {
    const separatorSize = lines.length ? 1 : 0;
    if (lines.length && size + separatorSize + fragment.line.length > maxCharacters) {
      batches.push(lines.join("\n"));
      lines = [];
      size = 0;
    }
    lines.push(fragment.line);
    size += (lines.length > 1 ? 1 : 0) + fragment.line.length;
  }
  if (lines.length) batches.push(lines.join("\n"));
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

function compactMeetingSummaryForMerge(value) {
  const compact = {
    title: truncateText(value?.title, 120),
    summary: truncateText(value?.summary, 1_200),
    keywords: uniqueStrings(stringArray(value?.keywords)).slice(0, 8).map((item) => truncateText(item, 50)),
    decisions: uniqueStrings([
      ...stringArray(value?.decisions),
      ...(Array.isArray(value?.decision_records) ? value.decision_records.map((item) => item?.decision) : []),
    ]).slice(0, 8).map((item) => truncateText(item, 140)),
    speaker_summaries: normalizeSpeakerSummaries(value?.speaker_summaries).slice(0, 4).map((item) => ({
      speaker: truncateText(item.speaker, 50),
      summary: truncateText(item.summary, 240),
      key_points: item.key_points.slice(0, 3).map((point) => truncateText(point, 90)),
    })),
    action_items: normalizeActionItems(value?.action_items).slice(0, 5).map((item) => ({
      task: truncateText(item.task, 160), owner: truncateText(item.owner, 50), due: truncateText(item.due, 50),
    })),
  };
  while (JSON.stringify(compact).length > SUMMARY_MERGE_ITEM_CHARACTERS) {
    if (compact.speaker_summaries.length > 2) compact.speaker_summaries.pop();
    else if (compact.action_items.length > 2) compact.action_items.pop();
    else if (compact.decisions.length > 4) compact.decisions.pop();
    else if (compact.keywords.length > 4) compact.keywords.pop();
    else if (compact.summary.length > 400) compact.summary = truncateText(compact.summary, Math.max(400, compact.summary.length - 200));
    else if (compact.speaker_summaries.length) compact.speaker_summaries.pop();
    else if (compact.action_items.length) compact.action_items.pop();
    else if (compact.decisions.length) compact.decisions.pop();
    else break;
  }
  return compact;
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

function explicitTermsFromContext(value) {
  const labels = /^(?:术语|专有名词|项目名|产品名|公司名|组织名|人名|姓名|负责人|参会人|人员|terms?|project|product|company|organization|names?)\s*[:：=]?\s*(.+)$/i;
  const terms = [];
  for (const clause of String(value || "").split(/[；;\n]+/u)) {
    const match = clause.trim().match(labels);
    if (!match) continue;
    terms.push(...match[1].split(/[、,，|/]+/u).map((term) => term.trim()).filter(Boolean));
  }
  return [...new Set(terms)];
}

function normalizeHighlights(value, segments = [], rawSegments = [], trustedTerms = []) {
  return Array.isArray(value) ? value.map((item) => {
    const evidence = verifiedEvidence(item?.start_seconds, item?.quote, segments, rawSegments, trustedTerms);
    if (!evidence) return null;
    return {
      start_seconds: evidence.start_seconds,
      speaker: evidence.speaker || stringOr(item?.speaker, "发言人"),
      quote: evidence.quote,
      reason: stringOr(item?.reason, ""),
    };
  }).filter(Boolean).slice(0, 20) : [];
}

function normalizeSpeakerSummaries(value) {
  return Array.isArray(value) ? value.map((item) => ({
    speaker: stringOr(item?.speaker, "发言人"),
    summary: stringOr(item?.summary, ""),
    key_points: stringArray(item?.key_points).slice(0, 12),
  })).filter((item) => item.summary || item.key_points.length).slice(0, 30) : [];
}

function normalizeDecisionRecords(value, segments = [], rawSegments = [], trustedTerms = []) {
  return Array.isArray(value) ? value.map((item) => {
    const evidence = verifiedEvidence(item?.start_seconds, item?.evidence, segments, rawSegments, trustedTerms);
    if (!evidence || !looksLikeDecisionEvidence(evidence.quote)) return null;
    const decision = stringOr(item?.decision, "");
    const normalizedDecision = comparableText(decision);
    if (normalizedDecision.length < 2) return null;
    const safeDecision = comparableText(evidence.quote).includes(normalizedDecision) ? decision : evidence.quote;
    return { decision: safeDecision, start_seconds: evidence.start_seconds, evidence: evidence.quote };
  }).filter((item) => item?.decision).slice(0, 30) : [];
}

function looksLikeDecisionEvidence(value) {
  return /决定|确认|同意|通过|批准|否决|安排|定于|负责|完成|上线|发布|交付|采用|选择|必须|需要|不得|取消|延期|\b(?:decid(?:e|ed)|agree(?:d)?|approv(?:e|ed)|reject(?:ed)?|will|must|shall|assign(?:ed)?|ship|launch|publish|deliver|complete|cancel(?:led)?|postpone(?:d)?)\b/iu.test(String(value || ""));
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

function normalizeInterviewReport(value, requestedCompetencies = [], segments = [], rawSegments = [], trustedTerms = []) {
  const source = value && typeof value === "object" ? value : {};
  const groupedCompetencies = new Map();
  for (const item of Array.isArray(source.competencies) ? source.competencies : []) {
    const name = stringOr(item?.name, "未命名能力项");
    const key = comparableText(name);
    if (!groupedCompetencies.has(key)) groupedCompetencies.set(key, { name, evidence: [] });
    if (Array.isArray(item?.evidence)) groupedCompetencies.get(key).evidence.push(...item.evidence);
  }
  const sourceCompetencies = [...groupedCompetencies.values()].map((item) => {
    const evidence = uniqueItems(item.evidence.map((entry) => (
      verifiedEvidence(entry?.start_seconds, entry?.quote, segments, rawSegments, trustedTerms)
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
    ? requestedNames.map((name) => sourceCompetencies.find((item) => comparableText(item.name) === comparableText(name)) || { name, rating: "insufficient", assessment: "证据不足", evidence: [] })
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
    ? requestedNames.map((name) => competencies.find((item) => item.name === name)).filter(Boolean)
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

function verifiedEvidence(value, quoteValue, segments, rawSegments = [], trustedTerms = []) {
  const time = evidenceTime(value);
  const quote = stringOr(quoteValue, "");
  const normalizedQuote = comparableText(quote);
  if (time == null || normalizedQuote.length < 2) return null;
  const segmentIndex = (segments || []).findIndex((candidate, index, all) => {
    const start = Math.max(0, Number(candidate?.start_seconds) || 0);
    const explicitEnd = Number(candidate?.end_seconds);
    const nextStart = Number(all[index + 1]?.start_seconds);
    const end = Number.isFinite(explicitEnd) && explicitEnd > start
      ? explicitEnd
      : (Number.isFinite(nextStart) && nextStart > start ? nextStart : start + 5);
    return time >= start - 0.5 && time <= end + 0.5 && comparableText(candidate?.text).includes(normalizedQuote);
  });
  const segment = segments?.[segmentIndex];
  if (!segment) return null;
  if (rawSegments.length) {
    const rawSegment = rawSegments[segmentIndex] || rawSegments.find((candidate) => (
      Math.abs((Number(candidate?.start_seconds) || 0) - (Number(segment.start_seconds) || 0)) <= 0.5
    ));
    if (!rawSegment) return null;
    if (comparableText(rawSegment.speaker || "发言人") !== comparableText(segment.speaker || "发言人")) return null;
    const correction = safeCorrection(rawSegment.text, segment.text, trustedTerms);
    if (correction.rejected || correction.text !== segment.text) return null;
  }
  return {
    start_seconds: Math.max(0, Number(segment.start_seconds) || 0),
    speaker: stringOr(segment.speaker, "发言人"),
    quote,
  };
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

function occurrenceCount(value, search) {
  if (!search) return 0;
  let count = 0;
  let offset = value.indexOf(search);
  while (offset !== -1) {
    count += 1;
    offset = value.indexOf(search, offset + search.length);
  }
  return count;
}

function comparableText(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, "")
    .replace(/^[“”‘’"'「」『』《》〈〉，。！？、；：,.!?;:()（）…]+|[“”‘’"'「」『』《》〈〉，。！？、；：,.!?;:()（）…]+$/gu, "");
}

function correctionText(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase()
    .replace(/[\s，。！？、；：“”‘’()（）,.!?;:'"…]+/gu, "");
}

function criticalFingerprint(value) {
  const text = String(value || "").normalize("NFKC").toLocaleLowerCase();
  const pattern = /[¥$€£]?[+-]?\d+(?:[.:/-]\d+)*(?:%|元|万|亿|年|月|日|点|时|分|秒)?|(?:高|低)(?:风险|成本|延迟|优先级|概率|置信度|价格|质量|性能)|(?:风险|成本|延迟|优先级|概率|置信度|价格|质量|性能)(?:很|较|更|极|偏)?[高低]|没有|不能|不会|不可|不要|不|没|无|未|非|否|拒绝|反对|禁止|支持|同意|通过|驳回|接受|否决|录用|淘汰|成功|失败|增加|减少|上升|下降|\b(?:no|not|never|without|cannot|can't|won't|don't|doesn't|didn't|isn't|aren't|support|oppose|accept|reject|approve|deny|hire|fail|increase|decrease|success|failure|high[ -]?risk|low[ -]?risk)\b/giu;
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
    `- 时长：${formatTimestamp(meeting.duration)}`, "",
    "## AI 摘要", "", meeting.summary || "无", "",
    "## 关键词", "", ...(meeting.keywords?.length ? meeting.keywords.map((item) => `- ${item}`) : ["无"]), "",
    "## 会议金句", "", ...highlights,
    "## 发言人总结", "", ...speakers,
    "## 关键决策", "", ...decisions, "",
    "## 行动项", "", actions, "",
    "## 逐字稿", "", ...(meeting.segments || []).flatMap((segment) => [`### ${formatTimestamp(segment.start_seconds)} · ${segment.speaker || "发言人"}`, "", segment.text, ""]),
  ].join("\n").trimEnd() + "\n";
}

function toInterviewMarkdown(meeting) {
  const context = meeting.interviewContext || {};
  const report = meeting.interviewReport || {};
  const coverage = report.competencies?.filter((item) => item.evidence?.length).map((item) => (
    `- ${item.name}：${item.evidence.length} 条候选原话，需人工判断`
  )) || [];
  const competencies = report.competencies?.length ? report.competencies.flatMap((item) => [
    `### ${item.name} · ${ratingLabel(item.rating)}`,
    "",
    item.assessment || "证据不足",
    "",
    ...(item.evidence?.length ? item.evidence.map((evidence) => `- [${formatTimestamp(evidence.start_seconds)}] “${evidence.quote}”`) : ["- 无可核验证据"]),
    "",
  ]) : ["无能力项评估", ""];
  return [
    `# ${meeting.title}`, "",
    `- 候选人代称：${context.candidateAlias || "候选人"}`,
    `- 目标岗位：${context.role || "未提供"}`,
    `- 面试轮次：${context.stage || "未提供"}`,
    `- 创建时间：${new Date(meeting.createdAt).toLocaleString("zh-CN")}`,
    `- 时长：${formatTimestamp(meeting.duration)}`, "",
    "> 此报告只整理经时间和原文校验的候选证据，不判断原话是否证明能力，不用于自动录用决定。请回听复核并忽略敏感个人属性。", "",
    "## 证据复核", "",
    report.overview || meeting.summary || "证据不足", "",
    "## 证据覆盖", "", ...(coverage.length ? coverage : ["无通过校验的候选原话"]), "",
    "## 能力证据", "", ...competencies,
    "## 风险与待核实项", "", ...(report.risks?.length ? report.risks.map((item) => `- ${item}`) : ["无"]), "",
    "## 建议追问", "", ...(report.follow_ups?.length ? report.follow_ups.map((item) => `- ${item}`) : ["无"]), "",
    "## 逐字稿", "",
    ...(meeting.segments || []).flatMap((segment) => [`### ${formatTimestamp(segment.start_seconds)} · ${segment.speaker || "发言人"}`, "", segment.text, ""]),
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
  const decisionRecords = normalizeDecisionRecords(meeting.decision_records, meeting.segments, meeting.rawSegments, meeting.terminology);
  const result = {
    schema: 3, title: meeting.title, createdAt: meeting.createdAt, duration: meeting.duration,
    language: meeting.language || "", summary: meeting.summary || "", keywords: meeting.keywords || [],
    highlights: normalizeHighlights(meeting.highlights, meeting.segments, meeting.rawSegments, meeting.terminology), speaker_summaries: normalizeSpeakerSummaries(meeting.speaker_summaries),
    decisions: decisionRecords.map((item) => item.decision), decision_records: decisionRecords,
    action_items: meeting.action_items || [], segments: meeting.segments || [],
  };
  if (meeting.mode === "interview") {
    result.mode = "interview";
    result.interviewContext = {
      candidateAlias: meeting.interviewContext?.candidateAlias || "",
      role: meeting.interviewContext?.role || "",
      stage: meeting.interviewContext?.stage || "",
      competencies: stringArray(meeting.interviewContext?.competencies),
    };
    result.interviewReport = normalizeInterviewReport(meeting.interviewReport, result.interviewContext.competencies, result.segments, meeting.rawSegments, meeting.terminology);
    if (!result.interviewReport.competencies.some((item) => item.evidence.length)) result.summary = result.interviewReport.overview;
  }
  return result;
}

export function buildShareHtml(meeting) {
  const html = buildShareHtmlDocument(meeting);
  if (meeting.mode !== "interview") return html;
  return html
    .replace("AI 辅助评估仅供面试官复核，不用于自动录用决定；请忽略敏感个人属性并核对原始证据。", "程序只校验时间和原话，不判断是否证明能力；请回听复核，不用于自动录用决定，并忽略敏感个人属性。")
    .replace("<h2>辅助结论</h2>", "<h2>证据复核</h2>")
    .replace('cl={high:"高",medium:"中",low:"低"}', 'cl={high:"有证据",medium:"有证据",low:"证据不足"}')
    .replace("置信度 ", "证据状态 ");
}

function buildShareHtmlDocument(meeting) {
  const payload = JSON.stringify(publicMeeting(meeting)).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(meeting.title)} · 言澜</title><style>body{margin:0;color:#182230;background:#f7f8fa;font:14px/1.75 system-ui,-apple-system,"PingFang SC",sans-serif}main{width:min(820px,calc(100% - 32px));margin:auto;padding:40px 0 70px}header{padding-bottom:24px;border-bottom:1px solid #dfe3e8}h1{margin:0 0 6px;font-size:26px}h2{margin:28px 0 10px;font-size:17px}h3{margin:16px 0 4px;font-size:14px}.meta,time{color:#667085;font-size:12px}.summary{margin:26px 0;padding-left:16px;border-left:3px solid #087e8b}.notice{padding:12px 14px;color:#7a2e0e;background:#fff5eb;border:1px solid #fed7aa;border-radius:7px}.result{display:flex;gap:16px;align-items:center;margin:16px 0}.pill{padding:3px 8px;border-radius:999px;background:#eef4ff;color:#1849a9;font-weight:650}.competency,.insight-row{padding:14px 0;border-bottom:1px solid #e4e7ec}.competency strong{margin-right:8px}.evidence,.reason{margin:6px 0;color:#475467}.quote{margin:4px 0;font-size:16px}.points{margin:6px 0;padding-left:20px}.decision-time{margin-right:8px;color:#2864dc}article{display:grid;grid-template-columns:62px 1fr;padding:18px 0;border-bottom:1px solid #e4e7ec}article p{margin:2px 0 0;overflow-wrap:anywhere}.speaker{font-weight:650}footer{margin-top:32px;color:#98a2b3;font-size:11px}@media(max-width:560px){main{padding-top:24px}article{grid-template-columns:1fr;gap:5px}.result{align-items:flex-start;flex-direction:column;gap:5px}}</style></head><body><main id="app"></main><script>const m=${payload};const e=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));const t=n=>{n=Math.max(0,Number(n)||0);const h=Math.floor(n/3600),x=Math.floor(n%3600/60),s=Math.floor(n%60);return(h?String(h).padStart(2,"0")+":":"")+String(x).padStart(2,"0")+":"+String(s).padStart(2,"0")};const rl={advance:"建议推进",follow_up:"补充追问",hold:"暂不推进",insufficient:"证据不足"},cl={high:"高",medium:"中",low:"低"},gl={strong:"突出",adequate:"符合",mixed:"有待确认",weak:"不足",insufficient:"证据不足"};const interview=m.mode==="interview"&&m.interviewReport?'<section><p class="notice">AI 辅助评估仅供面试官复核，不用于自动录用决定；请忽略敏感个人属性并核对原始证据。</p><h2>辅助结论</h2><div class="result"><span class="pill">'+e(rl[m.interviewReport.recommendation]||"证据不足")+'</span><span>置信度 '+e(cl[m.interviewReport.confidence]||"低")+'</span></div><p>'+e(m.interviewReport.overview||m.summary||"证据不足")+'</p><h2>能力证据</h2>'+(m.interviewReport.competencies||[]).map(c=>'<div class="competency"><strong>'+e(c.name)+'</strong><span>'+e(gl[c.rating]||"证据不足")+'</span><div>'+e(c.assessment)+'</div>'+(c.evidence||[]).map(v=>'<div class="evidence">['+t(v.start_seconds)+'] “'+e(v.quote)+'”</div>').join("")+'</div>').join("")+'</section>':'';const generic=m.mode!=="interview"?'<section class="summary"><strong>AI 摘要</strong><div>'+e(m.summary||"无")+'</div></section>'+((m.highlights||[]).length?'<section><h2>会议金句</h2>'+m.highlights.map(v=>'<div class="insight-row"><time>'+t(v.start_seconds)+'</time> · <strong>'+e(v.speaker)+'</strong><p class="quote">“'+e(v.quote)+'”</p>'+(v.reason?'<p class="reason">'+e(v.reason)+'</p>':'')+'</div>').join("")+'</section>':'')+((m.speaker_summaries||[]).length?'<section><h2>发言人总结</h2>'+m.speaker_summaries.map(v=>'<div class="insight-row"><h3>'+e(v.speaker)+'</h3><div>'+e(v.summary)+'</div>'+((v.key_points||[]).length?'<ul class="points">'+v.key_points.map(p=>'<li>'+e(p)+'</li>').join("")+'</ul>':'')+'</div>').join("")+'</section>':'')+(((m.decision_records||[]).length||(m.decisions||[]).length)?'<section><h2>关键决策</h2>'+((m.decision_records||[]).length?m.decision_records.map(v=>'<div class="insight-row">'+(v.start_seconds==null?'':'<span class="decision-time">['+t(v.start_seconds)+']</span>')+'<strong>'+e(v.decision)+'</strong>'+(v.evidence?'<p class="evidence">“'+e(v.evidence)+'”</p>':'')+'</div>').join(""):(m.decisions||[]).map(v=>'<div class="insight-row">'+e(v)+'</div>').join(""))+'</section>':''):'';document.querySelector("#app").innerHTML='<header><h1>'+e(m.title)+'</h1><div class="meta">'+e(new Date(m.createdAt).toLocaleString("zh-CN"))+' · '+t(m.duration)+'</div></header>'+interview+generic+'<section><h2>逐字稿</h2>'+m.segments.map(s=>'<article><time>'+t(s.start_seconds)+'</time><div><div class="speaker">'+e(s.speaker||"发言人")+'</div><p>'+e(s.text)+'</p></div></article>').join("")+'</section><footer>由言澜 Yanlan 生成</footer>';<\/script></body></html>`;
}

function ratingLabel(value) {
  return ({ strong: "突出", adequate: "符合", mixed: "有待确认", weak: "不足", insufficient: "证据不足" })[value] || "证据不足";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}
