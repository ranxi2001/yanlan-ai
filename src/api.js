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
  const requestUrl = requestUrlForConfig(url, config);
  let response;
  try {
    response = await fetch(requestUrl, options);
  } catch (error) {
    if (error instanceof TypeError) {
      if (config.transportMode === "relay") throw new Error("本地同源网关不可用，请使用 npm run local 启动言澜");
      throw new Error("浏览器无法访问 API，请检查 Base URL、网络或服务端 CORS；也可用 npm run local 切换本地网关");
    }
    throw error;
  }
  const body = await response.json().catch(async () => ({ message: await response.text().catch(() => "") }));
  if (!response.ok) {
    const message = body?.error?.message || body?.message || body?.detail || `API 请求失败（HTTP ${response.status}）`;
    throw new Error(`${message}（HTTP ${response.status}）`);
  }
  return body;
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
  const transcript = transcriptForPrompt(meeting);
  if (!transcript) return emptySummary();
  if (meeting.mode === "interview") return summarizeInterviewTranscript({ config, meeting, transcript, signal });
  const system = `你是严谨的会议纪要助手。请仅依据带时间和发言人的逐字稿输出纯 JSON，不要使用 Markdown 代码块。
字段必须为：
1. title（简短标题）、summary（完整摘要）、keywords（字符串数组）；
2. highlights（会议金句数组，每项含 start_seconds、speaker、quote、reason）；
3. speaker_summaries（发言人总结数组，每项含 speaker、summary、key_points 字符串数组）；
4. decisions（关键决策字符串数组）；
5. decision_records（关键决策证据数组，每项含 decision、start_seconds、evidence）；
6. action_items（行动项数组，每项含 task、owner、due，未知填空字符串）。
金句必须是逐字稿中的简短原话，speaker 和 start_seconds 必须对应原片段。关键决策的 evidence 必须是逐字稿中的简短原话并使用对应 start_seconds。只总结有实际发言的说话人。不得虚构逐字稿里没有的信息、时间或原话。`;
  const content = await chatCompletion({ config, system, user: `会议逐字稿：\n${transcript}`, signal });
  const parsed = parseJsonObject(content);
  return {
    title: stringOr(parsed.title, ""),
    summary: stringOr(parsed.summary, content),
    keywords: stringArray(parsed.keywords),
    highlights: normalizeHighlights(parsed.highlights),
    speaker_summaries: normalizeSpeakerSummaries(parsed.speaker_summaries),
    decisions: stringArray(parsed.decisions),
    decision_records: normalizeDecisionRecords(parsed.decision_records),
    action_items: Array.isArray(parsed.action_items) ? parsed.action_items.map((item) => ({
      task: stringOr(item?.task, ""), owner: stringOr(item?.owner, ""), due: stringOr(item?.due, ""),
    })).filter((item) => item.task) : [],
  };
}

async function summarizeInterviewTranscript({ config, meeting, transcript, signal }) {
  const system = `你是谨慎的面试评估助手，只能依据岗位信息和逐字稿中的可核验证据提供面试官复核材料，不能替代人工录用决定。
必须遵守：
1. 只评估与岗位职责、用户提供的能力项直接相关的内容；证据不足必须写“证据不足”。
2. 忽略并不得推断或评价性别、年龄、民族、国籍、籍贯、宗教、婚育、家庭、健康、残障等敏感个人属性。
3. 不得根据声音、口音、语速、语言风格、姓名或外貌推断能力、性格和背景。
4. 每条能力证据必须来自逐字稿，包含 start_seconds（数字）和简短原话 quote；不得编造时间或原话。
5. recommendation 只能是 advance、follow_up、hold、insufficient；rating 只能是 strong、adequate、mixed、weak、insufficient；confidence 只能是 high、medium、low。
返回纯 JSON，不要 Markdown 代码块，结构必须为：{"title":"","summary":"","keywords":[],"interview_report":{"recommendation":"","confidence":"","overview":"","competencies":[{"name":"","rating":"","assessment":"","evidence":[{"start_seconds":0,"quote":""}]}],"strengths":[],"risks":[],"follow_ups":[]}}。follow_ups 只写下一轮可验证的岗位相关追问。`;
  const user = `${interviewContextForPrompt(meeting)}\n\n面试逐字稿：\n${transcript}`;
  const content = await chatCompletion({ config, system, user, signal });
  const parsed = parseJsonObject(content);
  const report = normalizeInterviewReport(parsed.interview_report, meeting.interviewContext?.competencies);
  return {
    title: stringOr(parsed.title, ""),
    summary: stringOr(parsed.summary, report.overview || content),
    keywords: stringArray(parsed.keywords),
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
  if (!original.length) return { segments: [], terminology: [] };
  const batches = splitSegmentBatches(original, 18000);
  const corrected = [];
  const terminology = [];
  for (const batch of batches) {
    const input = batch.map((segment, localIndex) => ({
      id: corrected.length + localIndex,
      speaker: segment.speaker || "发言人",
      text: segment.text,
    }));
    const interviewRules = meeting.mode === "interview" ? `这是面试逐字稿。仅在上下文有充分证据时把 speaker 统一为“面试官”或“候选人”；无法确定、同一片段包含多人或证据冲突时保留原 speaker，绝不能猜测。不得依据声音、口音、姓名或敏感个人属性推断角色。` : "";
    const system = `你是逐字稿校对员。根据背景和上下文，仅纠正明显的语音识别错误、专有名词、人名、同音词、标点和前后不一致。不得总结、改写、删减或添加事实。${interviewRules}必须返回纯 JSON：{"segments":[{"id":数字,"speaker":"...","text":"..."}],"terminology":["统一后的术语"]}。segments 数量、顺序和 id 必须与输入完全一致。`;
    const context = meeting.mode === "interview" ? interviewContextForPrompt(meeting) : `会议背景 / 术语表：\n${config.contextHint?.trim() || "未提供"}`;
    const user = `${context}\n\n通用背景 / 专有名词：\n${config.contextHint?.trim() || "未提供"}\n\n前序已统一术语：\n${terminology.join("、") || "无"}\n\n待校对片段：\n${JSON.stringify(input)}`;
    const content = await chatCompletion({ config, system, user, signal });
    const parsed = parseJsonObject(content);
    const byId = new Map((Array.isArray(parsed.segments) ? parsed.segments : []).map((item) => [Number(item?.id), item]));
    input.forEach((item, localIndex) => {
      const source = batch[localIndex];
      const result = byId.get(item.id);
      corrected.push({
        ...source,
        speaker: stringOr(result?.speaker, source.speaker || "发言人"),
        text: stringOr(result?.text, source.text),
      });
    });
    for (const term of stringArray(parsed.terminology)) if (!terminology.includes(term)) terminology.push(term);
  }
  return { segments: corrected, terminology: terminology.slice(0, 60) };
}

export async function askTranscript({ config, meeting, question, signal }) {
  const transcript = transcriptForPrompt(meeting);
  if (!transcript) throw new Error("当前记录还没有逐字稿");
  const interview = meeting.mode === "interview";
  return chatCompletion({
    config,
    system: interview
      ? "你是面试证据问答助手。只能依据岗位信息与逐字稿回答，优先给出时间点和原话；没有依据时明确说证据不足。只讨论岗位相关信息，忽略且不得推断敏感个人属性，不得根据声音、口音或表达风格推断能力，不替代人工录用决定。"
      : "你是会议记录问答助手。只能依据给定逐字稿回答；没有依据时明确说逐字稿中未提及。回答简洁，并尽量引用相关时间点。",
    user: interview ? `${interviewContextForPrompt(meeting)}\n\n逐字稿：\n${transcript}\n\n问题：${question}` : `逐字稿：\n${transcript}\n\n问题：${question}`,
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

function transcriptForPrompt(meeting) {
  return (meeting.segments || []).map((segment) => `[${formatTimestamp(segment.start_seconds)}] ${segment.speaker || "发言人"}：${segment.text}`).join("\n");
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

function normalizeHighlights(value) {
  return Array.isArray(value) ? value.map((item) => ({
    start_seconds: evidenceTime(item?.start_seconds),
    speaker: stringOr(item?.speaker, "发言人"),
    quote: stringOr(item?.quote, ""),
    reason: stringOr(item?.reason, ""),
  })).filter((item) => item.quote && item.start_seconds != null).slice(0, 20) : [];
}

function normalizeSpeakerSummaries(value) {
  return Array.isArray(value) ? value.map((item) => ({
    speaker: stringOr(item?.speaker, "发言人"),
    summary: stringOr(item?.summary, ""),
    key_points: stringArray(item?.key_points).slice(0, 12),
  })).filter((item) => item.summary || item.key_points.length).slice(0, 30) : [];
}

function normalizeDecisionRecords(value) {
  return Array.isArray(value) ? value.map((item) => ({
    decision: stringOr(item?.decision, ""),
    start_seconds: evidenceTime(item?.start_seconds),
    evidence: stringOr(item?.evidence, ""),
  })).filter((item) => item.decision && item.evidence && item.start_seconds != null).slice(0, 30) : [];
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

function normalizeInterviewReport(value, requestedCompetencies = []) {
  const source = value && typeof value === "object" ? value : {};
  const recommendation = enumOr(source.recommendation, ["advance", "follow_up", "hold", "insufficient"], "insufficient");
  const confidence = enumOr(source.confidence, ["high", "medium", "low"], "low");
  const competencies = Array.isArray(source.competencies) ? source.competencies.map((item) => ({
    name: stringOr(item?.name, "未命名能力项"),
    rating: enumOr(item?.rating, ["strong", "adequate", "mixed", "weak", "insufficient"], "insufficient"),
    assessment: stringOr(item?.assessment, "证据不足"),
    evidence: Array.isArray(item?.evidence) ? item.evidence.map((evidence) => ({
      start_seconds: Math.max(0, Number(evidence?.start_seconds) || 0),
      quote: stringOr(evidence?.quote, ""),
    })).filter((evidence) => evidence.quote).slice(0, 6) : [],
  })).filter((item) => item.name).slice(0, 20) : [];
  for (const name of stringArray(requestedCompetencies)) {
    if (!competencies.some((item) => item.name === name)) competencies.push({ name, rating: "insufficient", assessment: "证据不足", evidence: [] });
  }
  return {
    recommendation,
    confidence,
    overview: stringOr(source.overview, "证据不足，建议面试官复核逐字稿。"),
    competencies,
    strengths: stringArray(source.strengths).slice(0, 12),
    risks: stringArray(source.risks).slice(0, 12),
    follow_ups: stringArray(source.follow_ups).slice(0, 12),
  };
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
  }) : (meeting.decisions?.length ? meeting.decisions.map((item) => `- ${item}`) : ["无"]);
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
    "> 此报告由 AI 基于逐字稿生成，仅供面试官复核，不用于自动录用决定。请忽略敏感个人属性，并核对原始证据。", "",
    "## 辅助结论", "",
    `- 建议：${recommendationLabel(report.recommendation)}`,
    `- 置信度：${confidenceLabel(report.confidence)}`, "",
    report.overview || meeting.summary || "证据不足", "",
    "## 能力证据", "", ...competencies,
    "## 优势", "", ...(report.strengths?.length ? report.strengths.map((item) => `- ${item}`) : ["无"]), "",
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
  const result = {
    schema: 3, title: meeting.title, createdAt: meeting.createdAt, duration: meeting.duration,
    language: meeting.language || "", summary: meeting.summary || "", keywords: meeting.keywords || [],
    highlights: normalizeHighlights(meeting.highlights), speaker_summaries: normalizeSpeakerSummaries(meeting.speaker_summaries),
    decisions: meeting.decisions || [], decision_records: normalizeDecisionRecords(meeting.decision_records),
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
    result.interviewReport = normalizeInterviewReport(meeting.interviewReport, result.interviewContext.competencies);
  }
  return result;
}

export function buildShareHtml(meeting) {
  const payload = JSON.stringify(publicMeeting(meeting)).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(meeting.title)} · 言澜</title><style>body{margin:0;color:#182230;background:#f7f8fa;font:14px/1.75 system-ui,-apple-system,"PingFang SC",sans-serif}main{width:min(820px,calc(100% - 32px));margin:auto;padding:40px 0 70px}header{padding-bottom:24px;border-bottom:1px solid #dfe3e8}h1{margin:0 0 6px;font-size:26px}h2{margin:28px 0 10px;font-size:17px}h3{margin:16px 0 4px;font-size:14px}.meta,time{color:#667085;font-size:12px}.summary{margin:26px 0;padding-left:16px;border-left:3px solid #087e8b}.notice{padding:12px 14px;color:#7a2e0e;background:#fff5eb;border:1px solid #fed7aa;border-radius:7px}.result{display:flex;gap:16px;align-items:center;margin:16px 0}.pill{padding:3px 8px;border-radius:999px;background:#eef4ff;color:#1849a9;font-weight:650}.competency,.insight-row{padding:14px 0;border-bottom:1px solid #e4e7ec}.competency strong{margin-right:8px}.evidence,.reason{margin:6px 0;color:#475467}.quote{margin:4px 0;font-size:16px}.points{margin:6px 0;padding-left:20px}.decision-time{margin-right:8px;color:#2864dc}article{display:grid;grid-template-columns:62px 1fr;padding:18px 0;border-bottom:1px solid #e4e7ec}article p{margin:2px 0 0;overflow-wrap:anywhere}.speaker{font-weight:650}footer{margin-top:32px;color:#98a2b3;font-size:11px}@media(max-width:560px){main{padding-top:24px}article{grid-template-columns:1fr;gap:5px}.result{align-items:flex-start;flex-direction:column;gap:5px}}</style></head><body><main id="app"></main><script>const m=${payload};const e=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));const t=n=>{n=Math.max(0,Number(n)||0);const h=Math.floor(n/3600),x=Math.floor(n%3600/60),s=Math.floor(n%60);return(h?String(h).padStart(2,"0")+":":"")+String(x).padStart(2,"0")+":"+String(s).padStart(2,"0")};const rl={advance:"建议推进",follow_up:"补充追问",hold:"暂不推进",insufficient:"证据不足"},cl={high:"高",medium:"中",low:"低"},gl={strong:"突出",adequate:"符合",mixed:"有待确认",weak:"不足",insufficient:"证据不足"};const interview=m.mode==="interview"&&m.interviewReport?'<section><p class="notice">AI 辅助评估仅供面试官复核，不用于自动录用决定；请忽略敏感个人属性并核对原始证据。</p><h2>辅助结论</h2><div class="result"><span class="pill">'+e(rl[m.interviewReport.recommendation]||"证据不足")+'</span><span>置信度 '+e(cl[m.interviewReport.confidence]||"低")+'</span></div><p>'+e(m.interviewReport.overview||m.summary||"证据不足")+'</p><h2>能力证据</h2>'+(m.interviewReport.competencies||[]).map(c=>'<div class="competency"><strong>'+e(c.name)+'</strong><span>'+e(gl[c.rating]||"证据不足")+'</span><div>'+e(c.assessment)+'</div>'+(c.evidence||[]).map(v=>'<div class="evidence">['+t(v.start_seconds)+'] “'+e(v.quote)+'”</div>').join("")+'</div>').join("")+'</section>':'';const generic=m.mode!=="interview"?'<section class="summary"><strong>AI 摘要</strong><div>'+e(m.summary||"无")+'</div></section>'+((m.highlights||[]).length?'<section><h2>会议金句</h2>'+m.highlights.map(v=>'<div class="insight-row"><time>'+t(v.start_seconds)+'</time> · <strong>'+e(v.speaker)+'</strong><p class="quote">“'+e(v.quote)+'”</p>'+(v.reason?'<p class="reason">'+e(v.reason)+'</p>':'')+'</div>').join("")+'</section>':'')+((m.speaker_summaries||[]).length?'<section><h2>发言人总结</h2>'+m.speaker_summaries.map(v=>'<div class="insight-row"><h3>'+e(v.speaker)+'</h3><div>'+e(v.summary)+'</div>'+((v.key_points||[]).length?'<ul class="points">'+v.key_points.map(p=>'<li>'+e(p)+'</li>').join("")+'</ul>':'')+'</div>').join("")+'</section>':'')+(((m.decision_records||[]).length||(m.decisions||[]).length)?'<section><h2>关键决策</h2>'+((m.decision_records||[]).length?m.decision_records.map(v=>'<div class="insight-row">'+(v.start_seconds==null?'':'<span class="decision-time">['+t(v.start_seconds)+']</span>')+'<strong>'+e(v.decision)+'</strong>'+(v.evidence?'<p class="evidence">“'+e(v.evidence)+'”</p>':'')+'</div>').join(""):(m.decisions||[]).map(v=>'<div class="insight-row">'+e(v)+'</div>').join(""))+'</section>':''):'';document.querySelector("#app").innerHTML='<header><h1>'+e(m.title)+'</h1><div class="meta">'+e(new Date(m.createdAt).toLocaleString("zh-CN"))+' · '+t(m.duration)+'</div></header>'+interview+generic+'<section><h2>逐字稿</h2>'+m.segments.map(s=>'<article><time>'+t(s.start_seconds)+'</time><div><div class="speaker">'+e(s.speaker||"发言人")+'</div><p>'+e(s.text)+'</p></div></article>').join("")+'</section><footer>由言澜 Yanlan 生成</footer>';<\/script></body></html>`;
}

function recommendationLabel(value) {
  return ({ advance: "建议推进", follow_up: "补充追问", hold: "暂不推进", insufficient: "证据不足" })[value] || "证据不足";
}

function confidenceLabel(value) {
  return ({ high: "高", medium: "中", low: "低" })[value] || "低";
}

function ratingLabel(value) {
  return ({ strong: "突出", adequate: "符合", mixed: "有待确认", weak: "不足", insufficient: "证据不足" })[value] || "证据不足";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}
