export const DEFAULT_CONFIG = Object.freeze({
  asrBaseUrl: "",
  asrApiKey: "",
  asrModel: "mimo-v2.5-asr",
  asrProtocol: "mimo-chat",
  asrPath: "chat/completions",
  chatBaseUrl: "",
  chatApiKey: "",
  chatModel: "gpt-4o-mini",
  chatPath: "chat/completions",
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

async function apiFetch(url, options) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error("浏览器无法访问 API，请检查 Base URL、网络连接以及服务端 CORS 设置");
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
    });
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
  });
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
  const system = `你是严谨的会议纪要助手。请仅依据逐字稿输出 JSON，不要使用 Markdown 代码块。字段必须为：title（简短标题）、summary（完整摘要）、keywords（字符串数组）、decisions（字符串数组）、action_items（对象数组，每项含 task、owner、due；未知填空字符串）。不得虚构逐字稿里没有的信息。`;
  const content = await chatCompletion({ config, system, user: `会议逐字稿：\n${transcript}`, signal });
  const parsed = parseJsonObject(content);
  return {
    title: stringOr(parsed.title, ""),
    summary: stringOr(parsed.summary, content),
    keywords: stringArray(parsed.keywords),
    decisions: stringArray(parsed.decisions),
    action_items: Array.isArray(parsed.action_items) ? parsed.action_items.map((item) => ({
      task: stringOr(item?.task, ""), owner: stringOr(item?.owner, ""), due: stringOr(item?.due, ""),
    })).filter((item) => item.task) : [],
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
    const system = `你是逐字稿校对员。根据会议背景和上下文，仅纠正明显的语音识别错误、专有名词、人名、同音词、标点和前后不一致。不得总结、改写、删减或添加事实。必须返回纯 JSON：{"segments":[{"id":数字,"speaker":"...","text":"..."}],"terminology":["统一后的术语"]}。segments 数量、顺序和 id 必须与输入完全一致。`;
    const user = `会议背景 / 术语表：\n${config.contextHint?.trim() || "未提供"}\n\n前序已统一术语：\n${terminology.join("、") || "无"}\n\n待校对片段：\n${JSON.stringify(input)}`;
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
  return chatCompletion({
    config,
    system: "你是会议记录问答助手。只能依据给定逐字稿回答；没有依据时明确说逐字稿中未提及。回答简洁，并尽量引用相关时间点。",
    user: `逐字稿：\n${transcript}\n\n问题：${question}`,
    signal,
  });
}

async function chatCompletion({ config, system, user, signal }) {
  if (!config.chatModel?.trim()) throw new Error("请先填写文本模型名称");
  const body = await apiFetch(joinApiUrl(config.chatBaseUrl, config.chatPath), {
    method: "POST",
    headers: authHeaders(config.chatApiKey),
    body: JSON.stringify({
      model: config.chatModel.trim(),
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      temperature: 0.2,
    }),
    signal,
  });
  const content = body?.choices?.[0]?.message?.content ?? body?.output_text ?? body?.text;
  if (typeof content !== "string" || !content.trim()) throw new Error("文本模型没有返回内容");
  return content.trim();
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

function emptySummary() {
  return { title: "", summary: "", keywords: [], decisions: [], action_items: [] };
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
  const actions = meeting.action_items?.length ? meeting.action_items.map((item) => `- [ ] ${item.task}${item.owner ? ` · ${item.owner}` : ""}${item.due ? ` · ${item.due}` : ""}`).join("\n") : "无";
  return [`# ${meeting.title}`, "", `- 创建时间：${new Date(meeting.createdAt).toLocaleString("zh-CN")}`, `- 时长：${formatTimestamp(meeting.duration)}`, "", "## AI 摘要", "", meeting.summary || "无", "", "## 会议决策", "", ...(meeting.decisions?.length ? meeting.decisions.map((item) => `- ${item}`) : ["无"]), "", "## 行动项", "", actions, "", "## 逐字稿", "", ...(meeting.segments || []).flatMap((segment) => [`### ${formatTimestamp(segment.start_seconds)} · ${segment.speaker || "发言人"}`, "", segment.text, ""])].join("\n").trimEnd() + "\n";
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
  return {
    schema: 1, title: meeting.title, createdAt: meeting.createdAt, duration: meeting.duration,
    language: meeting.language || "", summary: meeting.summary || "", keywords: meeting.keywords || [],
    decisions: meeting.decisions || [], action_items: meeting.action_items || [], segments: meeting.segments || [],
  };
}

export function buildShareHtml(meeting) {
  const payload = JSON.stringify(publicMeeting(meeting)).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(meeting.title)} · 言澜</title><style>body{margin:0;color:#182230;background:#f7f8fa;font:14px/1.75 system-ui,-apple-system,"PingFang SC",sans-serif}main{width:min(820px,calc(100% - 32px));margin:auto;padding:40px 0 70px}header{padding-bottom:24px;border-bottom:1px solid #dfe3e8}h1{margin:0 0 6px;font-size:26px}.meta,time{color:#667085;font-size:12px}.summary{margin:26px 0;padding-left:16px;border-left:3px solid #087e8b}article{display:grid;grid-template-columns:62px 1fr;padding:18px 0;border-bottom:1px solid #e4e7ec}article p{margin:2px 0 0;overflow-wrap:anywhere}.speaker{font-weight:650}footer{margin-top:32px;color:#98a2b3;font-size:11px}@media(max-width:560px){main{padding-top:24px}article{grid-template-columns:1fr;gap:5px}}</style></head><body><main id="app"></main><script>const m=${payload};const e=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));const t=n=>{n=Math.max(0,Number(n)||0);const h=Math.floor(n/3600),x=Math.floor(n%3600/60),s=Math.floor(n%60);return(h?String(h).padStart(2,"0")+":":"")+String(x).padStart(2,"0")+":"+String(s).padStart(2,"0")};document.querySelector("#app").innerHTML='<header><h1>'+e(m.title)+'</h1><div class="meta">'+e(new Date(m.createdAt).toLocaleString("zh-CN"))+' · '+t(m.duration)+'</div></header>'+(m.summary?'<section class="summary"><strong>AI 摘要</strong><div>'+e(m.summary)+'</div></section>':'')+'<section>'+m.segments.map(s=>'<article><time>'+t(s.start_seconds)+'</time><div><div class="speaker">'+e(s.speaker||"发言人")+'</div><p>'+e(s.text)+'</p></div></article>').join("")+'</section><footer>由言澜 Yanlan 生成</footer>';<\/script></body></html>`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}
