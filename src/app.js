import { createIcons, icons } from "lucide";
import "./styles.css";
import {
  DEFAULT_CONFIG,
  askTranscript,
  buildShareHtml,
  connectionTestErrorMessage,
  correctTranscript,
  formatTimestamp,
  normalizeMimoBaseUrl,
  publicMeeting,
  summarizeTranscript,
  testAsrConnection,
  testChatConnection,
  toMarkdown,
  toVtt,
  transcribeAudioWithRetry,
} from "./api.js";
import { MAX_MIMO_FALLBACK_BYTES, MAX_MIMO_UPLOAD_SECONDS, mimoUploadLimitMessage } from "./audio-limits.js";
import { createKeyBackup, parseKeyBackup } from "./key-backup.js";
import { deleteRecording, getRecording, getRecordingChunks, saveRecording, saveRecordingChunk } from "./storage.js";

const MEETINGS_KEY = "yanlan.meetings.v1";
const CONFIG_KEY = "yanlan.config.v1";
const LEGACY_ASR_SESSION_KEY = "yanlan.asr-key.v1";
const LEGACY_CHAT_SESSION_KEY = "yanlan.chat-key.v1";
const ACTIVE_RECORDING_SESSION_KEY = "yanlan.active-recording.v1";
const MAX_MEETINGS = 40;
const MAX_RECORDING_SECONDS = 4 * 60 * 60;
const RECORDING_HEARTBEAT_MS = 1_000;
const RECORDING_STALE_MS = 4_000;
const recoveringMeetingIds = new Set();
const connectionTestRuns = {
  asr: { token: 0, controller: null },
  chat: { token: 0, controller: null },
};

const $ = (selector) => document.querySelector(selector);
const elements = {
  sidebar: $("#sidebar"), sidebarOpen: $("#sidebarOpen"), sidebarClose: $("#sidebarClose"), sidebarScrim: $("#sidebarScrim"),
  historyList: $("#historyList"), historyCount: $("#historyCount"), newMeetingButton: $("#newMeetingButton"),
  meetingTitle: $("#meetingTitle"), meetingMeta: $("#meetingMeta"), copyButton: $("#copyButton"), shareButton: $("#shareButton"),
  exportButton: $("#exportButton"), exportMenu: $("#exportMenu"), settingsButton: $("#settingsButton"), insightsButton: $("#insightsButton"),
  insightsClose: $("#insightsClose"), insightsPane: $("#insightsPane"), configNotice: $("#configNotice"),
  configNoticeButton: $("#configNoticeButton"), configDot: $("#configDot"), configModel: $("#configModel"), configHost: $("#configHost"),
  openSettingsButton: $("#openSettingsButton"), sharedBanner: $("#sharedBanner"), searchBox: $("#searchBox"), searchInput: $("#searchInput"),
  emptyWorkspace: $("#emptyWorkspace"), recorderStage: $("#recorderStage"), processingStage: $("#processingStage"),
  recorderHeading: $("#recorderHeading"), interviewBrief: $("#interviewBrief"), interviewBriefTitle: $("#interviewBriefTitle"), interviewBriefMeta: $("#interviewBriefMeta"),
  processingTitle: $("#processingTitle"), processingFile: $("#processingFile"), errorStage: $("#errorStage"), errorMessage: $("#errorMessage"),
  transcriptList: $("#transcriptList"), insightContent: $("#insightContent"), recordButton: $("#recordButton"),
  startRecordButton: $("#startRecordButton"), stopRecordButton: $("#stopRecordButton"), liveRecorder: $("#liveRecorder"),
  liveStatus: $("#liveStatus"), recordingTime: $("#recordingTime"), waveform: $("#waveform"), uploadButton: $("#uploadButton"),
  replaceAudioButton: $("#replaceAudioButton"), fileInput: $("#fileInput"), languageSelect: $("#languageSelect"), retryButton: $("#retryButton"),
  recordingPlayer: $("#recordingPlayer"), audioPlayer: $("#audioPlayer"), settingsDialog: $("#settingsDialog"),
  settingsForm: $("#settingsForm"), asrBaseUrlInput: $("#asrBaseUrlInput"), asrApiKeyInput: $("#asrApiKeyInput"),
  testAsrButton: $("#testAsrButton"), asrConnectionResult: $("#asrConnectionResult"),
  asrModelInput: $("#asrModelInput"), chunkSecondsInput: $("#chunkSecondsInput"), mimoHelpButton: $("#mimoHelpButton"), mimoHelpDialog: $("#mimoHelpDialog"),
  chatBaseUrlInput: $("#chatBaseUrlInput"), chatApiKeyInput: $("#chatApiKeyInput"), chatModelInput: $("#chatModelInput"),
  testChatButton: $("#testChatButton"), chatConnectionResult: $("#chatConnectionResult"),
  chatProtocolInput: $("#chatProtocolInput"), chatPathInput: $("#chatPathInput"), contextHintInput: $("#contextHintInput"),
  transportModeInput: $("#transportModeInput"), relayPathInput: $("#relayPathInput"), transportHelp: $("#transportHelp"), shareDialog: $("#shareDialog"),
  clearKeysButton: $("#clearKeysButton"), importKeysButton: $("#importKeysButton"), exportKeysButton: $("#exportKeysButton"), importKeysInput: $("#importKeysInput"),
  shareUrlInput: $("#shareUrlInput"), shareHint: $("#shareHint"), copyShareButton: $("#copyShareButton"),
  copySharePrimaryButton: $("#copySharePrimaryButton"), downloadShareButton: $("#downloadShareButton"), toast: $("#toast"),
  interviewDialog: $("#interviewDialog"), interviewForm: $("#interviewForm"), interviewDialogClose: $("#interviewDialogClose"),
  interviewCancelButton: $("#interviewCancelButton"), interviewContinueButton: $("#interviewContinueButton"), candidateAliasInput: $("#candidateAliasInput"),
  interviewRoleInput: $("#interviewRoleInput"), interviewStageInput: $("#interviewStageInput"), interviewerInput: $("#interviewerInput"),
  competenciesInput: $("#competenciesInput"), jobDescriptionInput: $("#jobDescriptionInput"), interviewConsentInput: $("#interviewConsentInput"),
};

const state = {
  meetings: loadMeetings(),
  activeId: null,
  draftTitle: "新的会议记录",
  draftMode: "meeting",
  draftInterview: null,
  pendingSource: "",
  config: loadConfig(),
  insight: "summary",
  query: "",
  recorder: null,
  recording: false,
  sharedMode: false,
  playerUrl: "",
  playerLoadToken: 0,
  toastTimer: 0,
};
state.activeId = state.meetings[0]?.id || null;

bindEvents();
initialize();

async function initialize() {
  const shared = await readSharedMeeting().catch(() => null);
  if (shared) {
    shared.id = "shared";
    shared.status = "done";
    shared.readOnly = true;
    shared.hasRecording = false;
    shared.qa = [];
    state.meetings = [shared];
    state.activeId = shared.id;
    state.sharedMode = true;
  } else {
    await recoverInterruptedRecordings();
  }
  render();
}

function bindEvents() {
  elements.newMeetingButton.addEventListener("click", newMeeting);
  elements.recordButton.addEventListener("click", () => requestSource("record"));
  elements.startRecordButton.addEventListener("click", () => requestSource("record"));
  elements.stopRecordButton.addEventListener("click", stopRecording);
  elements.uploadButton.addEventListener("click", () => requestSource("upload"));
  elements.replaceAudioButton.addEventListener("click", prepareReplacement);
  elements.fileInput.addEventListener("change", handleFileSelection);
  document.querySelectorAll("[data-record-mode]").forEach((button) => button.addEventListener("click", () => selectRecordMode(button.dataset.recordMode)));
  elements.interviewBrief.addEventListener("click", () => openInterviewDialog(""));
  elements.interviewForm.addEventListener("submit", saveInterviewContext);
  elements.interviewDialogClose.addEventListener("click", closeInterviewDialog);
  elements.interviewCancelButton.addEventListener("click", closeInterviewDialog);
  elements.retryButton.addEventListener("click", retryActiveMeeting);
  elements.copyButton.addEventListener("click", copyTranscript);
  elements.shareButton.addEventListener("click", openShareDialog);
  elements.exportButton.addEventListener("click", toggleExportMenu);
  elements.exportMenu.addEventListener("click", handleExport);
  elements.settingsButton.addEventListener("click", openSettings);
  elements.openSettingsButton.addEventListener("click", openSettings);
  elements.configNoticeButton.addEventListener("click", openSettings);
  elements.settingsForm.addEventListener("submit", saveSettings);
  elements.settingsDialog.addEventListener("close", clearConnectionTests);
  elements.clearKeysButton.addEventListener("click", clearStoredKeys);
  elements.mimoHelpButton.addEventListener("click", () => elements.mimoHelpDialog.showModal());
  elements.importKeysButton.addEventListener("click", () => elements.importKeysInput.click());
  elements.importKeysInput.addEventListener("change", importKeys);
  elements.exportKeysButton.addEventListener("click", exportKeys);
  elements.testAsrButton.addEventListener("click", () => testSettingsConnection("asr"));
  elements.testChatButton.addEventListener("click", () => testSettingsConnection("chat"));
  elements.chatProtocolInput.addEventListener("change", () => {
    elements.chatPathInput.value = elements.chatProtocolInput.value === "responses" ? "responses" : "chat/completions";
    clearConnectionTest("chat");
  });
  elements.transportModeInput.addEventListener("change", () => { renderTransportHelp(); clearConnectionTests(); });
  elements.relayPathInput.addEventListener("input", clearConnectionTests);
  [elements.asrBaseUrlInput, elements.asrApiKeyInput, elements.asrModelInput]
    .forEach((input) => input.addEventListener("input", () => clearConnectionTest("asr")));
  [elements.chatBaseUrlInput, elements.chatApiKeyInput, elements.chatModelInput, elements.chatPathInput]
    .forEach((input) => input.addEventListener("input", () => clearConnectionTest("chat")));
  document.querySelectorAll(".toggle-key-button").forEach((button) => button.addEventListener("click", toggleSecret));
  elements.searchInput.addEventListener("input", (event) => { state.query = event.target.value.trim().toLocaleLowerCase(); renderTranscript(activeMeeting()); });
  elements.meetingTitle.addEventListener("input", updateMeetingTitle);
  elements.meetingTitle.addEventListener("blur", normalizeMeetingTitle);
  elements.historyList.addEventListener("click", handleHistoryClick);
  document.querySelectorAll("[data-insight]").forEach((button) => button.addEventListener("click", () => selectInsight(button.dataset.insight)));
  elements.insightContent.addEventListener("submit", handleQuestion);
  elements.insightContent.addEventListener("click", seekToSegment);
  elements.transcriptList.addEventListener("click", seekToSegment);
  elements.transcriptList.addEventListener("click", handleTranscriptAction);
  elements.sidebarOpen.addEventListener("click", openSidebar);
  elements.sidebarClose.addEventListener("click", closeSidebar);
  elements.sidebarScrim.addEventListener("click", closeSidebar);
  elements.insightsButton.addEventListener("click", () => elements.insightsPane.classList.add("open"));
  elements.insightsClose.addEventListener("click", () => elements.insightsPane.classList.remove("open"));
  elements.copyShareButton.addEventListener("click", copyShareUrl);
  elements.copySharePrimaryButton.addEventListener("click", copyShareUrl);
  elements.downloadShareButton.addEventListener("click", downloadShareHtml);
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".menu-wrap")) closeExportMenu();
  });
  window.addEventListener("beforeunload", handleBeforeUnload);
}

function render() {
  const meeting = activeMeeting();
  renderHistory();
  renderHeader(meeting);
  renderMain(meeting);
  renderInsights(meeting);
  renderConfig();
  renderSharedMode();
  renderRecorderMode();
  refreshIcons();
}

function renderHistory() {
  elements.historyCount.textContent = String(state.meetings.length);
  if (!state.meetings.length) {
    elements.historyList.innerHTML = '<div class="history-empty">暂无记录</div>';
    return;
  }
  elements.historyList.innerHTML = state.meetings.map((meeting) => `
    <div class="history-item ${meeting.id === state.activeId ? "active" : ""}" data-meeting-id="${escapeHtml(meeting.id)}">
      <span class="history-icon ${meeting.mode === "interview" ? "interview" : ""}"><i data-lucide="${statusIcon(meeting.status, meeting.mode)}"></i></span>
      <span class="history-text"><span class="history-title">${escapeHtml(meeting.title)}</span><span class="history-date">${escapeHtml(formatHistoryDate(meeting.createdAt))}</span></span>
      ${meeting.readOnly ? "" : `<button class="history-delete" data-delete-id="${escapeHtml(meeting.id)}" title="删除记录" aria-label="删除记录"${state.recorder?.meeting.id === meeting.id ? " disabled" : ""}><i data-lucide="trash-2"></i></button>`}
    </div>`).join("");
}

function renderHeader(meeting) {
  elements.meetingTitle.value = meeting?.title || state.draftTitle;
  elements.meetingTitle.readOnly = Boolean(meeting?.readOnly);
  const hasTranscript = Boolean(meeting?.segments?.length && (meeting.readOnly || meeting.status === "done"));
  const hasAudio = Boolean(meeting?.hasRecording && !meeting?.readOnly);
  elements.copyButton.disabled = !hasTranscript;
  elements.shareButton.disabled = !hasTranscript;
  elements.exportButton.disabled = !hasTranscript && !hasAudio;
  elements.exportMenu.querySelectorAll("[data-export]").forEach((button) => {
    button.disabled = button.dataset.export === "audio" ? !hasAudio : !hasTranscript;
  });
  if (!meeting) {
    elements.meetingMeta.textContent = "尚未开始";
    return;
  }
  const parts = [formatFullDate(meeting.createdAt)];
  if (meeting.mode === "interview") parts.push(`${meeting.interviewContext?.stage || "面试"} · ${meeting.interviewContext?.role || "岗位待补充"}`);
  if (meeting.duration) parts.push(formatDurationLabel(meeting.duration));
  parts.push(statusLabel(meeting.status, meeting.mode));
  elements.meetingMeta.textContent = parts.filter(Boolean).join(" · ");
}

function renderMain(meeting) {
  const liveOrTranscript = Boolean(meeting && meeting.status !== "error" && (["recording", "recovering", "recorded"].includes(meeting.status) || meeting.segments?.length || meeting.status === "done"));
  elements.emptyWorkspace.classList.toggle("hidden", liveOrTranscript);
  elements.transcriptList.classList.toggle("hidden", !liveOrTranscript);
  elements.searchBox.classList.toggle("hidden", !meeting?.segments?.length || meeting.status === "error");
  elements.liveRecorder.classList.toggle("hidden", !state.recording);
  elements.recorderStage.classList.toggle("hidden", Boolean(meeting));
  const showProcessing = Boolean(meeting && !liveOrTranscript && ["transcribing", "correcting", "summarizing"].includes(meeting.status));
  elements.processingStage.classList.toggle("hidden", !showProcessing);
  elements.errorStage.classList.toggle("hidden", meeting?.status !== "error");
  if (showProcessing) {
    elements.processingTitle.textContent = statusLabel(meeting.status, meeting.mode);
    elements.processingFile.textContent = meeting.sourceName || "正在处理音频";
  }
  if (meeting?.status === "error") {
    elements.errorMessage.textContent = meeting.error || "处理失败，请稍后重试。";
    elements.retryButton.disabled = !meeting.hasRecording && !meeting.recoveryPending && state.recorder?.meeting.id !== meeting.id;
  }
  if (liveOrTranscript) renderTranscript(meeting);
  renderPlayer(meeting);
  if (state.recording) renderLiveStatus();
}

function renderTranscript(meeting) {
  if (!meeting) return;
  const segments = (meeting.segments || []).filter((segment) => !state.query || `${segment.speaker} ${segment.text}`.toLocaleLowerCase().includes(state.query));
  if (!segments.length) {
    if (meeting.status === "recorded") {
      elements.transcriptList.innerHTML = '<div class="recording-only-state"><i data-lucide="file-audio"></i><strong>录音已保存在本机</strong><span>现在可以播放或导出音频，配置模型后可继续生成逐字稿。</span><button class="secondary-button" type="button" data-transcribe-recording><i data-lucide="captions"></i><span>生成逐字稿</span></button></div>';
      refreshIcons();
      return;
    }
    elements.transcriptList.innerHTML = `<div class="no-results">${meeting.status === "recovering" ? '<span class="inline-loader"></span>正在恢复已增量保存的录音片段' : (state.recording ? (state.recorder?.transcriptionEnabled ? '<span class="inline-loader"></span>等待第一个实时转写片段' : "正在录音，音频仅保存在本机") : (state.query ? "没有匹配内容" : "模型未返回逐字稿"))}</div>`;
    return;
  }
  elements.transcriptList.innerHTML = segments.map((segment, index) => `
    <article class="transcript-segment">
      <button class="segment-time" data-seek="${Number(segment.start_seconds) || 0}" title="跳转到此时间">${formatTimestamp(segment.start_seconds)}</button>
      <div><div class="speaker-line"><span class="speaker-avatar">${escapeHtml(speakerInitial(segment.speaker, index))}</span><span class="speaker-name">${escapeHtml(segment.speaker || "发言人")}</span></div><p class="segment-text">${escapeHtml(segment.text)}</p></div>
    </article>`).join("");
  if (state.recording && !state.query) elements.transcriptList.scrollTop = elements.transcriptList.scrollHeight;
}

function renderInsights(meeting) {
  renderInsightTabs(meeting);
  if (!meeting?.segments?.length) {
    const message = meeting?.status === "recorded" ? "配置模型并生成逐字稿后可创建智能纪要" : `转写完成后${meeting?.mode === "interview" ? "整理面试证据" : "生成智能纪要"}`;
    elements.insightContent.innerHTML = `<div class="insight-empty"><i data-lucide="sparkles"></i><span>${message}</span></div>`;
    return;
  }
  if (meeting.mode === "interview" && state.insight === "actions") renderInterviewEvidence(meeting);
  else if (meeting.mode === "interview" && state.insight === "summary") renderInterviewAssessment(meeting);
  else if (state.insight === "highlights") renderHighlights(meeting);
  else if (state.insight === "speakers") renderSpeakerSummaries(meeting);
  else if (state.insight === "actions") renderActions(meeting);
  else if (state.insight === "qa") renderQa(meeting);
  else renderSummary(meeting);
}

function renderInterviewAssessment(meeting) {
  if (["recording", "correcting", "summarizing"].includes(meeting.status) && !meeting.interviewReport) {
    elements.insightContent.innerHTML = `<div class="insight-empty"><span class="inline-loader"></span><span>${meeting.status === "recording" ? "结束录音后校正并评估" : statusLabel(meeting.status, meeting.mode)}</span></div>`;
    return;
  }
  const report = meeting.interviewReport;
  if (!report) {
    elements.insightContent.innerHTML = `<div class="insight-empty"><i data-lucide="circle-alert"></i><span>${escapeHtml(meeting.summaryError || "面试证据尚未整理")}</span></div>`;
    return;
  }
  const correction = correctionNotice(meeting);
  const coverage = (report.competencies || []).filter((item) => item.evidence?.length).map((item) => (
    `<li>${escapeHtml(item.name)}：${item.evidence.length} 条候选原话，需人工判断</li>`
  )).join("") || "<li>没有通过校验的候选原话</li>";
  const risks = report.risks?.length ? report.risks.map((item) => `<li>${escapeHtml(item)}</li>`).join("") : "<li>没有识别到明确待核实项</li>";
  elements.insightContent.innerHTML = `${correction}<p class="interview-disclaimer"><i data-lucide="shield-check"></i><span>AI 只整理补充追问材料，不自动推进或淘汰候选人。程序只校验时间与原话，是否支持能力判断仍需面试官回听复核。</span></p><section class="insight-section"><h2 class="insight-label"><i data-lucide="scan-search"></i><span>证据复核</span></h2><p class="summary-text">${escapeHtml(report.overview || meeting.summary || "证据不足")}</p></section><div class="strength-risk-grid"><section><h2 class="insight-label"><i data-lucide="list-checks"></i><span>证据覆盖</span></h2><ul>${coverage}</ul></section><section><h2 class="insight-label"><i data-lucide="search-alert"></i><span>风险与待核实</span></h2><ul>${risks}</ul></section></div>`;
}

function renderInterviewEvidence(meeting) {
  const report = meeting.interviewReport;
  if (!report?.competencies?.length) {
    elements.insightContent.innerHTML = '<div class="insight-empty"><i data-lucide="scan-search"></i><span>没有可展示的能力证据</span></div>';
    return;
  }
  const competencies = report.competencies.map((item) => {
    const evidence = item.evidence?.length ? `<div class="evidence-list">${item.evidence.map((entry) => `<button class="evidence-item" type="button" data-seek="${Number(entry.start_seconds) || 0}"><time>${formatTimestamp(entry.start_seconds)}</time><span>“${escapeHtml(entry.quote)}”</span><i data-lucide="play"></i></button>`).join("")}</div>` : '<p class="evidence-empty">无可核验逐字稿证据</p>';
    return `<section class="competency-item"><div class="competency-head"><h2>${escapeHtml(item.name)}</h2><span class="rating-badge ${escapeHtml(item.rating)}">${escapeHtml(ratingLabel(item.rating))}</span></div><p>${escapeHtml(item.assessment || "证据不足")}</p>${evidence}</section>`;
  }).join("");
  const followUps = report.follow_ups?.length ? `<section class="follow-up-section"><h2 class="insight-label"><i data-lucide="message-circle-question"></i><span>下一轮建议追问</span></h2><ol>${report.follow_ups.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ol></section>` : "";
  elements.insightContent.innerHTML = `<div class="competency-list">${competencies}</div>${followUps}`;
}

function renderSummary(meeting) {
  if (["recording", "correcting", "summarizing"].includes(meeting.status) && !meeting.summary) {
    elements.insightContent.innerHTML = `<div class="insight-empty"><span class="inline-loader"></span><span>${meeting.status === "recording" ? "结束录音后校正并总结" : statusLabel(meeting.status)}</span></div>`;
    return;
  }
  const keywords = meeting.keywords?.length ? `<div class="keyword-list">${meeting.keywords.map((item) => `<span class="keyword">${escapeHtml(item)}</span>`).join("")}</div>` : '<p class="summary-text">无关键词</p>';
  const correction = correctionNotice(meeting);
  elements.insightContent.innerHTML = `${correction}<section class="insight-section"><h2 class="insight-label"><i data-lucide="align-left"></i><span>内容摘要</span></h2><p class="summary-text">${escapeHtml(meeting.summary || meeting.summaryError || "暂无摘要")}</p></section><section class="insight-section"><h2 class="insight-label"><i data-lucide="tags"></i><span>关键词</span></h2>${keywords}</section>`;
}

function renderHighlights(meeting) {
  if (!meeting.highlights?.length) {
    elements.insightContent.innerHTML = '<div class="insight-empty"><i data-lucide="quote"></i><span>没有识别到可核验的会议金句</span></div>';
    return;
  }
  elements.insightContent.innerHTML = `<div class="highlight-list">${meeting.highlights.map((item) => `<button class="highlight-item" type="button" data-seek="${Number(item.start_seconds) || 0}"><div class="highlight-meta"><time>${formatTimestamp(item.start_seconds)}</time><span>${escapeHtml(item.speaker || "发言人")}</span><i data-lucide="play"></i></div><blockquote>“${escapeHtml(item.quote)}”</blockquote>${item.reason ? `<p>${escapeHtml(item.reason)}</p>` : ""}</button>`).join("")}</div>`;
}

function renderSpeakerSummaries(meeting) {
  if (!meeting.speaker_summaries?.length) {
    elements.insightContent.innerHTML = '<div class="insight-empty"><i data-lucide="users"></i><span>没有足够发言内容生成发言人总结</span></div>';
    return;
  }
  elements.insightContent.innerHTML = `<div class="speaker-summary-list">${meeting.speaker_summaries.map((item, index) => `<section class="speaker-summary-item"><div class="speaker-summary-head"><span class="speaker-avatar">${escapeHtml(speakerInitial(item.speaker, index))}</span><h2>${escapeHtml(item.speaker || "发言人")}</h2></div><p>${escapeHtml(item.summary || "无")}</p>${item.key_points?.length ? `<ul>${item.key_points.map((point) => `<li>${escapeHtml(point)}</li>`).join("")}</ul>` : ""}</section>`).join("")}</div>`;
}

function renderActions(meeting) {
  const records = meeting.decision_records || [];
  if (!records.length && !meeting.action_items?.length) {
    elements.insightContent.innerHTML = '<div class="insight-empty"><i data-lucide="gavel"></i><span>没有识别到明确决策或行动项</span></div>';
    return;
  }
  const decisions = records.length ? `<section class="decision-section"><h2 class="insight-label"><i data-lucide="gavel"></i><span>关键决策</span></h2><div class="decision-record-list">${records.map((item) => `<button class="decision-record" type="button"${item.start_seconds == null ? "" : ` data-seek="${Number(item.start_seconds) || 0}"`}><div>${item.start_seconds == null ? "" : `<time>${formatTimestamp(item.start_seconds)}</time>`}<strong>${escapeHtml(item.decision)}</strong>${item.start_seconds == null ? "" : '<i data-lucide="play"></i>'}</div>${item.evidence ? `<p>“${escapeHtml(item.evidence)}”</p>` : ""}</button>`).join("")}</div></section>` : "";
  const actions = meeting.action_items?.length ? `<section class="action-section"><h2 class="insight-label"><i data-lucide="list-checks"></i><span>行动项</span></h2><ul class="action-list">${meeting.action_items.map((item) => `<li class="action-item"><i data-lucide="square-check-big"></i><div><p class="action-task">${escapeHtml(item.task)}</p><div class="action-meta">${item.owner ? `<span><i data-lucide="user"></i>${escapeHtml(item.owner)}</span>` : ""}${item.due ? `<span><i data-lucide="calendar-clock"></i>${escapeHtml(item.due)}</span>` : ""}${!item.owner && !item.due ? "待确认负责人和时间" : ""}</div></div></li>`).join("")}</ul></section>` : "";
  elements.insightContent.innerHTML = `${decisions}${actions}`;
}

function renderQa(meeting) {
  const messages = meeting.qa || [];
  const interview = meeting.mode === "interview";
  elements.insightContent.innerHTML = `<div class="qa-view"><div class="qa-messages">${messages.length ? messages.map((message) => `<div class="qa-message ${message.role}"><span>${message.role === "user" ? "你" : "AI"}</span><p>${escapeHtml(message.content)}</p></div>`).join("") : `<div class="qa-starter"><i data-lucide="message-circle-question"></i><span>${interview ? "只基于岗位信息和逐字稿证据追问" : "基于校正后的逐字稿提问"}</span></div>`}</div>${meeting.readOnly ? '<p class="share-hint">分享稿为只读模式，不能调用你的 API。</p>' : `<form class="qa-composer" id="qaForm"><textarea id="questionInput" rows="2" maxlength="1000" placeholder="${interview ? "例如：候选人对故障恢复给出了哪些具体证据？" : "例如：会议最终决定了什么？"}" required></textarea><button class="icon-button" aria-label="发送问题" title="发送问题" ${meeting.asking ? "disabled" : ""}><i data-lucide="${meeting.asking ? "loader-circle" : "send"}"></i></button></form>`}</div>`;
  requestAnimationFrame(() => { const list = elements.insightContent.querySelector(".qa-messages"); if (list) list.scrollTop = list.scrollHeight; });
}

function renderInsightTabs(meeting) {
  const interview = meeting?.mode === "interview";
  if (interview && !["summary", "actions", "qa"].includes(state.insight)) state.insight = "summary";
  const labels = interview
    ? { summary: "复核", actions: "证据", qa: "追问" }
    : { summary: "概览", highlights: "金句", speakers: "发言人", actions: "决策", qa: "提问" };
  document.querySelector(".segmented-control").classList.toggle("interview-tabs", interview);
  document.querySelectorAll("[data-insight]").forEach((button) => {
    const supported = Boolean(labels[button.dataset.insight]);
    button.classList.toggle("hidden", !supported);
    if (supported) button.textContent = labels[button.dataset.insight];
    const active = button.dataset.insight === state.insight;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
}

function renderConfig() {
  const asrReady = Boolean(state.config.asrBaseUrl && state.config.asrApiKey);
  const chatReady = Boolean(state.config.chatBaseUrl && state.config.chatApiKey);
  elements.configModel.textContent = asrReady && chatReady ? `${state.config.asrModel} + ${state.config.chatModel}` : "双模型未配置";
  elements.configHost.textContent = asrReady && chatReady ? `MiMo 转写 · ${state.config.transportMode === "relay" ? "本地网关" : "浏览器直连"}` : "点击配置 API";
  elements.configDot.className = `status-dot ${asrReady && chatReady ? "ready" : "error"}`;
  elements.configNotice.classList.toggle("hidden", (asrReady && chatReady) || state.sharedMode);
}

function renderSharedMode() {
  elements.sharedBanner.classList.toggle("hidden", !state.sharedMode);
  elements.newMeetingButton.disabled = state.sharedMode;
  elements.settingsButton.classList.toggle("hidden", state.sharedMode);
  elements.openSettingsButton.disabled = state.sharedMode;
}

function renderRecorderMode() {
  const interview = state.draftMode === "interview";
  document.querySelectorAll("[data-record-mode]").forEach((button) => {
    const active = button.dataset.recordMode === state.draftMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  elements.recorderHeading.textContent = interview ? "开始一场面试记录" : "开始一段新记录";
  elements.interviewBrief.classList.toggle("hidden", !interview);
  if (!interview) return;
  const context = state.draftInterview;
  elements.interviewBriefTitle.textContent = context?.role || "补充面试信息";
  elements.interviewBriefMeta.textContent = context ? `${context.candidateAlias || "候选人"} · ${context.stage} · ${context.competencies.length} 项能力` : "岗位、轮次、能力项与 JD";
}

function selectRecordMode(mode) {
  if (state.activeId || !["meeting", "interview"].includes(mode)) return;
  state.draftMode = mode;
  state.draftTitle = mode === "interview" ? "新的面试记录" : "新的会议记录";
  elements.meetingTitle.value = state.draftTitle;
  renderRecorderMode();
  refreshIcons();
}

function requestSource(source) {
  if (source === "upload" && !requireConfig()) return;
  if (state.draftMode === "interview" && !state.draftInterview) {
    openInterviewDialog(source);
    return;
  }
  if (source === "record") startRecording();
  else chooseAudio();
}

function openInterviewDialog(source = "") {
  if (state.sharedMode) return;
  state.pendingSource = source;
  const context = state.draftInterview || {};
  elements.candidateAliasInput.value = context.candidateAlias || "";
  elements.interviewRoleInput.value = context.role || "";
  elements.interviewStageInput.value = context.stage || "技术一面";
  elements.interviewerInput.value = context.interviewer || "";
  elements.competenciesInput.value = context.competencies?.join("、") || "专业能力、问题分析、协作沟通";
  elements.jobDescriptionInput.value = context.jobDescription || "";
  elements.interviewConsentInput.checked = Boolean(context.consentConfirmed);
  const action = source === "upload" ? "选择音频" : source === "record" ? "继续录音" : "保存信息";
  const icon = source === "upload" ? "upload" : source === "record" ? "mic" : "check";
  elements.interviewContinueButton.innerHTML = `<i data-lucide="${icon}"></i><span>${action}</span>`;
  elements.interviewDialog.showModal();
  refreshIcons();
}

function closeInterviewDialog() {
  state.pendingSource = "";
  elements.interviewDialog.close();
}

function saveInterviewContext(event) {
  event.preventDefault();
  const competencies = splitCompetencies(elements.competenciesInput.value);
  if (!competencies.length) {
    showToast("请至少填写一个岗位能力项", true);
    return;
  }
  state.draftInterview = {
    candidateAlias: elements.candidateAliasInput.value.trim() || "候选人",
    role: elements.interviewRoleInput.value.trim(),
    stage: elements.interviewStageInput.value,
    interviewer: elements.interviewerInput.value.trim(),
    competencies,
    jobDescription: elements.jobDescriptionInput.value.trim(),
    consentConfirmed: elements.interviewConsentInput.checked,
  };
  if (!state.draftTitle || ["新的会议记录", "新的面试记录", "未命名记录"].includes(state.draftTitle)) {
    state.draftTitle = `${state.draftInterview.candidateAlias} · ${state.draftInterview.role} ${state.draftInterview.stage}`.slice(0, 120);
    elements.meetingTitle.value = state.draftTitle;
  }
  const source = state.pendingSource;
  state.pendingSource = "";
  elements.interviewDialog.close();
  renderRecorderMode();
  if (source === "record") startRecording();
  else if (source === "upload") chooseAudio();
}

function prepareReplacement() {
  const meeting = activeMeeting();
  state.draftMode = meeting?.mode === "interview" ? "interview" : "meeting";
  state.draftInterview = null;
  if (meeting?.mode === "interview") {
    state.draftInterview = meeting.interviewContext ? { ...meeting.interviewContext, competencies: [...(meeting.interviewContext.competencies || [])] } : null;
    state.draftTitle = meeting.title;
  }
  chooseAudio();
}

function renderPlayer(meeting) {
  const visible = Boolean(meeting?.hasRecording && !state.recording && !meeting.readOnly);
  elements.recordingPlayer.classList.toggle("hidden", !visible);
  if (!visible) {
    cleanupPlayerUrl();
    elements.audioPlayer.removeAttribute("src");
    return;
  }
  if (elements.audioPlayer.dataset.meetingId === meeting.id && elements.audioPlayer.src) return;
  loadPlayer(meeting.id);
}

async function loadPlayer(meetingId) {
  const token = ++state.playerLoadToken;
  try {
    const record = await getRecording(meetingId);
    if (token !== state.playerLoadToken || !record?.blob) return;
    cleanupPlayerUrl();
    state.playerUrl = URL.createObjectURL(record.blob);
    elements.audioPlayer.src = state.playerUrl;
    elements.audioPlayer.dataset.meetingId = meetingId;
  } catch {
    elements.recordingPlayer.classList.add("hidden");
  }
}

function cleanupPlayerUrl() {
  state.playerLoadToken += 1;
  if (state.playerUrl) URL.revokeObjectURL(state.playerUrl);
  state.playerUrl = "";
}

function handleBeforeUnload(event) {
  cleanupPlayerUrl();
  if (!state.recorder) return;
  state.recorder.meeting.recordingHeartbeat = 0;
  saveMeetings();
  event.preventDefault();
  event.returnValue = "";
}

async function recoverInterruptedRecordings() {
  for (const meeting of state.meetings.filter((item) => item.status === "recording" || item.recoveryPending)) {
    await recoverInterruptedMeeting(meeting.id);
  }
}

async function recoverInterruptedMeeting(meetingId) {
  const meeting = state.meetings.find((item) => item.id === meetingId);
  if (!meeting || recoveringMeetingIds.has(meetingId)) return;
  const latest = storedMeeting(meetingId) || meeting;
  if (latest.status !== "recording" && !latest.recoveryPending) {
    Object.assign(meeting, latest);
    render();
    return;
  }
  const sessionMatches = sessionStorage.getItem(ACTIVE_RECORDING_SESSION_KEY) === latest.recordingSessionId;
  const heartbeat = Number(latest.recordingHeartbeat) || 0;
  const age = heartbeat ? Date.now() - heartbeat : Number.POSITIVE_INFINITY;
  if (!latest.recoveryPending && !(sessionMatches && heartbeat === 0) && age < RECORDING_STALE_MS) {
    meeting.status = "recovering";
    window.setTimeout(() => recoverInterruptedMeeting(meetingId), Math.max(250, RECORDING_STALE_MS - age + 100));
    return;
  }

  recoveringMeetingIds.add(meetingId);
  meeting.status = "recovering";
  render();
  try {
    const existing = await getRecording(meetingId);
    let blob = existing?.blob;
    if (!blob) {
      const chunks = await getRecordingChunks(meetingId);
      const expectedChunks = Number(latest.recordingChunkCount);
      if (!Number.isInteger(expectedChunks) || expectedChunks < 1 || chunks.length !== expectedChunks || chunks.some((chunk, index) => chunk.index !== index)) {
        const indexes = chunks.map((chunk) => chunk.index).join(", ") || "无";
        const error = new Error(`本地录音分片不完整（预期 ${Number.isInteger(expectedChunks) ? expectedChunks : "未知"} 个，找到 ${chunks.length} 个；现有序号：${indexes}），无法标记为完整录音`);
        error.recoveryTerminal = true;
        throw error;
      }
      blob = new Blob(chunks.map((chunk) => chunk.blob), { type: latest.sourceType || chunks[0]?.mimeType || "audio/webm" });
      await saveRecording(meetingId, blob, {
        fileName: latest.sourceName || chunks[0]?.fileName || `恢复录音.${extensionForMime(blob.type)}`,
        mimeType: blob.type,
      });
    }
    if (!blob?.size) throw new Error("恢复后的录音为空");
    let probedDuration;
    try {
      probedDuration = await probeDuration(blob);
    } catch (error) {
      throw new Error(`恢复后的录音无法被浏览器解码：${error.message}`);
    }
    const recoveredDuration = probedDuration || Number(latest.duration);
    const recoveryNote = latest.recordingStopped
      ? "录音已从停止时完整落盘的分片恢复。请重新生成逐字稿。"
      : "录音已从增量分片恢复；崩溃前最后约一秒可能尚未触发保存。请重新生成逐字稿。";
    Object.assign(meeting, latest, {
      duration: recoveredDuration || Number(latest.duration) || 0,
      hasRecording: true,
      status: "recorded",
      rawSegments: [],
      segments: [],
      error: "",
      recoveryPending: false,
      recoveryNote,
      recoveredAt: new Date().toISOString(),
    });
    delete meeting.recordingHeartbeat;
    delete meeting.recordingSessionId;
    delete meeting.recordingChunkCount;
    delete meeting.recordingStopped;
    if (sessionMatches) sessionStorage.removeItem(ACTIVE_RECORDING_SESSION_KEY);
    saveAndRender();
    showToast("已恢复崩溃前增量保存的录音，请重新生成逐字稿");
  } catch (error) {
    const saved = await getRecording(meetingId).catch(() => null);
    meeting.status = "error";
    meeting.hasRecording = Boolean(saved?.blob?.size);
    meeting.recoveryPending = !meeting.hasRecording && !error.recoveryTerminal;
    meeting.error = `录音恢复失败：${error.message}`;
    delete meeting.recordingHeartbeat;
    delete meeting.recordingSessionId;
    if (sessionMatches) sessionStorage.removeItem(ACTIVE_RECORDING_SESSION_KEY);
    saveAndRender();
  } finally {
    recoveringMeetingIds.delete(meetingId);
  }
}

function storedMeeting(meetingId) {
  try {
    const meetings = JSON.parse(localStorage.getItem(MEETINGS_KEY) || "[]");
    return Array.isArray(meetings) ? meetings.find((meeting) => meeting.id === meetingId) || null : null;
  } catch {
    return null;
  }
}

async function handleFileSelection(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  if (!file.type.startsWith("audio/") && !/\.(wav|mp3|m4a|webm|ogg|mp4)$/i.test(file.name)) {
    showToast("请选择常见格式的音频文件", true);
    return;
  }
  if (!requireConfig()) return;
  const duration = await probeDuration(file).catch(() => 0);
  const uploadError = mimoUploadLimitError(file, duration);
  if (uploadError) {
    showToast(uploadError.message, true);
    return;
  }
  const titleInput = elements.meetingTitle.value.trim();
  const autoTitle = state.draftMode !== "interview" && (!titleInput || ["新的会议记录", "未命名记录"].includes(titleInput));
  const meeting = createMeeting({
    title: autoTitle ? cleanFileTitle(file.name) || "新的会议记录" : (titleInput || normalizeDraftTitle("")),
    autoTitle,
    duration,
    sourceName: file.name,
    sourceType: file.type || "audio/mpeg",
    language: elements.languageSelect.value,
    status: "transcribing",
  });
  try {
    await saveRecording(meeting.id, file, { fileName: file.name, mimeType: file.type || "audio/mpeg" });
    meeting.hasRecording = true;
    saveMeetings();
    render();
    await processStoredAudio(meeting, file, file.name);
  } catch (error) {
    failMeeting(meeting, error);
  }
}

async function processStoredAudio(meeting, blob, fileName) {
  meeting.status = "transcribing";
  meeting.error = "";
  meeting.transcriptIncomplete = false;
  meeting.rawSegments = [];
  meeting.segments = [];
  saveAndRender();
  meeting.rawSegments = await transcribeStoredBlob(meeting, blob, fileName);
  meeting.segments = meeting.rawSegments.map((segment) => ({ ...segment }));
  if (!meeting.segments.length) throw new Error("MiMo 没有返回可用的逐字稿");
  await enrichMeeting(meeting);
}

async function transcribeStoredBlob(meeting, blob, fileName) {
  if (state.config.asrProtocol === "openai-transcriptions") {
    const result = await transcribeAudioWithRetry({ config: state.config, blob, fileName, language: meeting.language });
    return normalizeSegments(result.segments, meeting.duration);
  }
  const uploadError = mimoUploadLimitError(blob, meeting.duration);
  if (uploadError) throw uploadError;
  try {
    const decoded = await decodeAudio(blob);
    const chunkSamples = Math.max(15, Number(state.config.chunkSeconds) * 3) * decoded.sampleRate;
    const segments = [];
    for (let offset = 0, index = 0; offset < decoded.length; offset += chunkSamples, index += 1) {
      const end = Math.min(decoded.length, offset + chunkSamples);
      const pcm = mixAudioRange(decoded.buffer, offset, end);
      const start = offset / decoded.sampleRate;
      const duration = pcm.length / decoded.sampleRate;
      meeting.sourceName = `${fileName} · 转写 ${Math.min(100, Math.round((end / decoded.length) * 100))}%`;
      elements.processingFile.textContent = meeting.sourceName;
      const result = await transcribeAudioWithRetry({ config: state.config, blob: encodeWav(pcm, decoded.sampleRate), fileName: `part-${String(index).padStart(4, "0")}.wav`, language: meeting.language });
      segments.push(...normalizeSegments(result.segments, duration).map((segment) => ({
        ...segment,
        start_seconds: segment.start_seconds + start,
        end_seconds: segment.end_seconds > segment.start_seconds ? segment.end_seconds + start : start + duration,
      })));
    }
    meeting.sourceName = fileName;
    return segments;
  } catch (error) {
    meeting.sourceName = fileName;
    if (error.name !== "EncodingError" && !/decode|解码/i.test(error.message)) throw error;
    if (blob.size > MAX_MIMO_FALLBACK_BYTES) {
      throw new Error("浏览器无法分段解码该音频，且原文件超过 40 MiB，已停止整文件 data URL 上传；请切分文件或改用标准 Transcriptions 协议");
    }
    const result = await transcribeAudioWithRetry({ config: state.config, blob, fileName, language: meeting.language });
    return normalizeSegments(result.segments, meeting.duration);
  }
}

async function decodeAudio(blob) {
  const context = new AudioContext();
  try {
    const buffer = await context.decodeAudioData(await blob.arrayBuffer());
    if (buffer.duration > MAX_MIMO_UPLOAD_SECONDS) {
      const error = new Error("默认 MiMo 上传路径最多处理 30 分钟音频；请切分文件、使用实时录音，或改用标准 Transcriptions 协议");
      error.name = "AudioLimitError";
      throw error;
    }
    return { buffer, length: buffer.length, sampleRate: buffer.sampleRate };
  } catch (error) {
    if (error.name === "AudioLimitError") throw error;
    const wrapped = new Error(`浏览器无法解码该音频：${error.message}`);
    wrapped.name = "EncodingError";
    throw wrapped;
  } finally {
    await context.close().catch(() => {});
  }
}

function mixAudioRange(buffer, start, end) {
  const output = new Float32Array(Math.max(0, end - start));
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const input = buffer.getChannelData(channel);
    for (let index = start; index < end; index += 1) output[index - start] += input[index] / buffer.numberOfChannels;
  }
  return output;
}

function mimoUploadLimitError(blob, duration) {
  const message = mimoUploadLimitMessage({ protocol: state.config.asrProtocol, size: blob?.size, duration });
  return message ? new Error(message) : null;
}

async function enrichMeeting(meeting) {
  meeting.status = "correcting";
  meeting.correctionError = "";
  saveAndRender();
  try {
    const corrected = await correctTranscript({ config: state.config, meeting });
    meeting.segments = corrected.segments;
    meeting.terminology = corrected.terminology;
    meeting.rejectedCorrections = corrected.rejectedCorrections;
  } catch (error) {
    meeting.correctionError = error.message;
    meeting.segments = (meeting.rawSegments || meeting.segments).map((segment) => ({ ...segment }));
  }

  meeting.status = "summarizing";
  saveAndRender();
  try {
    const summary = await summarizeTranscript({ config: state.config, meeting });
    Object.assign(meeting, summary);
    if (meeting.autoTitle && summary.title) meeting.title = summary.title.slice(0, 120);
    meeting.summaryError = "";
  } catch (error) {
    meeting.summaryError = error.message;
  }
  meeting.status = "done";
  saveAndRender();
  showToast(meeting.correctionError || meeting.summaryError ? "转写已保存，部分 GPT 处理未完成" : (meeting.mode === "interview" ? "逐字稿已校正，面试证据已整理" : "逐字稿已校正，智能纪要已生成"));
}

async function retryActiveMeeting() {
  const meeting = activeMeeting();
  if (state.recorder?.meeting.id === meeting?.id && state.recorder.stopped) {
    await finishStoppedRecording(state.recorder);
    return;
  }
  if (meeting?.recoveryPending) {
    meeting.status = "recording";
    meeting.recordingHeartbeat = 0;
    meeting.recoveryPending = false;
    saveAndRender();
    await recoverInterruptedMeeting(meeting.id);
    return;
  }
  if (!meeting?.hasRecording || !requireConfig()) return;
  try {
    const record = await getRecording(meeting.id);
    if (!record?.blob) throw new Error("本机没有找到这段录音，请重新上传");
    await processStoredAudio(meeting, record.blob, record.fileName || meeting.sourceName || "audio.webm");
  } catch (error) {
    failMeeting(meeting, error);
  }
}

async function startRecording() {
  if (state.recording) return;
  if (state.recorder) {
    showToast("请先重试保存上一段录音", true);
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    showToast("当前浏览器不支持麦克风录音，请使用新版 Chromium 浏览器", true);
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(4096, Math.min(2, source.channelCount || 1), 1);
    const mimeType = preferredRecorderMime();
    const mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const meeting = createMeeting({
      title: normalizeDraftTitle(elements.meetingTitle.value), autoTitle: true, duration: 0,
      sourceName: `录音 ${formatFileDate(new Date())}.${extensionForMime(mediaRecorder.mimeType)}`,
      sourceType: mediaRecorder.mimeType || "audio/webm", language: elements.languageSelect.value,
      status: "recording", rawSegments: [], segments: [], recordingSessionId: crypto.randomUUID(), recordingHeartbeat: Date.now(), recordingChunkCount: 0, recordingStopped: false,
    });
    sessionStorage.setItem(ACTIVE_RECORDING_SESSION_KEY, meeting.recordingSessionId);
    const recorder = {
      meeting, stream, audioContext, source, processor, mediaRecorder, mediaChunkCount: 0,
      pendingPcm: [], pendingSamples: 0, processedSamples: 0, sampleRate: audioContext.sampleRate,
      startedAt: performance.now(), queue: Promise.resolve(), persistQueue: Promise.resolve(), pendingRequests: 0,
      errors: [], failedChunks: [], persistenceErrors: [], failedPersistence: [], silentChunks: 0, closing: false, stopped: false, finalizing: false, lastHeartbeatAt: 0,
      transcriptionEnabled: hasCompleteConfig(),
    };
    mediaRecorder.addEventListener("dataavailable", (event) => persistMediaChunk(recorder, event.data));
    processor.onaudioprocess = (event) => capturePcm(recorder, event.inputBuffer);
    source.connect(processor);
    processor.connect(audioContext.destination);
    mediaRecorder.start(1000);
    state.recorder = recorder;
    state.recording = true;
    recorder.timer = window.setInterval(updateRecordingClock, 250);
    renderWaveformBars();
    render();
    updateRecordingClock();
  } catch (error) {
    showToast(error.name === "NotAllowedError" ? "没有获得麦克风权限" : `无法开始录音：${error.message}`, true);
  }
}

function capturePcm(recorder, inputBuffer) {
  if (recorder.closing) return;
  const length = inputBuffer.length;
  const mono = new Float32Array(length);
  for (let channel = 0; channel < inputBuffer.numberOfChannels; channel += 1) {
    const input = inputBuffer.getChannelData(channel);
    for (let index = 0; index < length; index += 1) mono[index] += input[index] / inputBuffer.numberOfChannels;
  }
  updateWaveform(rms(mono));
  if (recorder.transcriptionEnabled) {
    recorder.pendingPcm.push(mono);
    recorder.pendingSamples += mono.length;
    if (recorder.pendingSamples >= Number(state.config.chunkSeconds) * recorder.sampleRate) flushLiveChunk(recorder);
  }
  if ((performance.now() - recorder.startedAt) / 1000 >= MAX_RECORDING_SECONDS) stopRecording();
}

function flushLiveChunk(recorder) {
  if (!recorder.transcriptionEnabled || !recorder.pendingSamples) return;
  const pcm = concatenatePcm(recorder.pendingPcm, recorder.pendingSamples);
  const start = recorder.processedSamples / recorder.sampleRate;
  recorder.processedSamples += recorder.pendingSamples;
  recorder.pendingPcm = [];
  recorder.pendingSamples = 0;
  const chunkNumber = Math.round(start / Math.max(1, Number(state.config.chunkSeconds)));
  const chunk = {
    chunkNumber,
    start,
    duration: pcm.length / recorder.sampleRate,
    wav: encodeWav(pcm, recorder.sampleRate),
  };
  recorder.queue = recorder.queue.then(async () => {
    recorder.pendingRequests += 1;
    renderLiveStatus();
    try {
      await transcribeLiveChunk(recorder, chunk);
    } catch (error) {
      recorder.errors.push(error.message);
      recorder.failedChunks.push(chunk);
    } finally {
      recorder.pendingRequests -= 1;
      renderLiveStatus();
    }
  });
}

function persistMediaChunk(recorder, blob) {
  if (!blob?.size) return;
  const chunk = { index: recorder.mediaChunkCount, blob };
  recorder.mediaChunkCount += 1;
  recorder.meeting.recordingChunkCount = recorder.mediaChunkCount;
  saveMeetings();
  recorder.persistQueue = recorder.persistQueue.then(async () => {
    try {
      await saveRecordingChunk(recorder.meeting.id, chunk.index, chunk.blob, {
        fileName: recorder.meeting.sourceName,
        mimeType: blob.type || recorder.meeting.sourceType,
      });
    } catch (error) {
      recorder.failedPersistence.push(chunk);
      recorder.persistenceErrors.push(error.message);
    }
  });
}

async function retryFailedPersistence(recorder) {
  const failed = [...recorder.failedPersistence];
  recorder.failedPersistence = [];
  recorder.persistenceErrors = [];
  for (const chunk of failed) {
    try {
      await saveRecordingChunk(recorder.meeting.id, chunk.index, chunk.blob, {
        fileName: recorder.meeting.sourceName,
        mimeType: chunk.blob.type || recorder.meeting.sourceType,
      });
    } catch (error) {
      recorder.failedPersistence.push(chunk);
      recorder.persistenceErrors.push(error.message);
    }
  }
}

async function transcribeLiveChunk(recorder, chunk) {
  const result = await transcribeAudioWithRetry({
    config: state.config,
    blob: chunk.wav,
    fileName: `live-${String(chunk.chunkNumber).padStart(4, "0")}.wav`,
    language: recorder.meeting.language,
  });
  const segments = normalizeSegments(result.segments, chunk.duration).map((segment) => ({
    ...segment,
    start_seconds: segment.start_seconds + chunk.start,
    end_seconds: segment.end_seconds ? segment.end_seconds + chunk.start : chunk.start + chunk.duration,
  }));
  if (!segments.length) {
    recorder.silentChunks += 1;
    return;
  }
  recorder.meeting.rawSegments.push(...segments);
  recorder.meeting.segments = recorder.meeting.rawSegments.slice().sort((left, right) => left.start_seconds - right.start_seconds).map((segment) => ({ ...segment }));
  saveMeetings();
  if (state.activeId === recorder.meeting.id) {
    renderTranscript(recorder.meeting);
    renderHeader(recorder.meeting);
  }
}

async function retryFailedLiveChunks(recorder) {
  const failed = [...recorder.failedChunks];
  recorder.failedChunks = [];
  recorder.errors = [];
  for (const chunk of failed) {
    try {
      await transcribeLiveChunk(recorder, chunk);
    } catch (error) {
      recorder.failedChunks.push(chunk);
      recorder.errors.push(error.message);
    }
  }
}

async function stopRecording() {
  const recorder = state.recorder;
  if (!recorder || recorder.closing) return;
  recorder.closing = true;
  if (recorder.transcriptionEnabled) flushLiveChunk(recorder);
  const duration = Math.max(0, (performance.now() - recorder.startedAt) / 1000);
  const mediaStopped = new Promise((resolve) => recorder.mediaRecorder.addEventListener("stop", resolve, { once: true }));
  clearInterval(recorder.timer);
  recorder.processor.onaudioprocess = null;
  recorder.processor.disconnect();
  recorder.source.disconnect();
  if (recorder.mediaRecorder.state !== "inactive") recorder.mediaRecorder.stop();
  recorder.stream.getTracks().forEach((track) => track.stop());
  await recorder.audioContext.close().catch(() => {});
  await mediaStopped;
  await recorder.persistQueue;
  state.recording = false;
  recorder.stopped = true;
  recorder.meeting.duration = duration;
  recorder.meeting.recordingStopped = true;
  saveMeetings();
  await finishStoppedRecording(recorder);
}

async function finishStoppedRecording(recorder) {
  if (recorder.finalizing) return;
  recorder.finalizing = true;
  const meeting = recorder.meeting;
  meeting.status = recorder.transcriptionEnabled ? "transcribing" : "recorded";
  try {
    await retryFailedPersistence(recorder);
    if (recorder.persistenceErrors.length) throw new Error(`有 ${recorder.persistenceErrors.length} 个录音分片未能保存到本机，请保持页面打开并点击重试`);
    const storedChunks = await getRecordingChunks(meeting.id);
    if (storedChunks.length !== recorder.mediaChunkCount || storedChunks.some((chunk, index) => chunk.index !== index)) {
      throw new Error("本地录音分片不完整，未生成可能缺段的录音文件");
    }
    const blob = new Blob(storedChunks.map((chunk) => chunk.blob), { type: recorder.mediaRecorder.mimeType || meeting.sourceType });
    if (!blob.size) throw new Error("浏览器没有生成录音数据");
    await saveRecording(meeting.id, blob, { fileName: meeting.sourceName, mimeType: blob.type });
    meeting.hasRecording = true;
    meeting.transcriptIncomplete = false;
    delete meeting.recordingHeartbeat;
    delete meeting.recordingSessionId;
    delete meeting.recordingChunkCount;
    delete meeting.recordingStopped;
    sessionStorage.removeItem(ACTIVE_RECORDING_SESSION_KEY);
    if (state.recorder === recorder) state.recorder = null;
    saveAndRender();
    if (!recorder.transcriptionEnabled) {
      showToast("录音已保存在本机，可直接播放或导出");
      return;
    }
    await recorder.queue;
    if (recorder.failedChunks.length) await retryFailedLiveChunks(recorder);
    if (recorder.failedChunks.length) {
      meeting.transcriptIncomplete = true;
      throw new Error(`仍有 ${recorder.failedChunks.length} 个实时转写片段失败。录音已完整保存，请点击重试后再生成纪要。`);
    }
    if (!meeting.rawSegments.length) {
      meeting.status = "recorded";
      meeting.noSpeechDetected = true;
      saveAndRender();
      showToast("录音已保存，未检测到可转写语音");
      return;
    }
    meeting.noSpeechDetected = false;
    meeting.rawSegments.sort((left, right) => left.start_seconds - right.start_seconds);
    meeting.segments = meeting.rawSegments.map((segment) => ({ ...segment }));
    await enrichMeeting(meeting);
  } catch (error) {
    if (!meeting.hasRecording) {
      meeting.recordingHeartbeat = 0;
      meeting.recoveryPending = true;
    } else {
      if (state.recorder === recorder) state.recorder = null;
      delete meeting.recordingHeartbeat;
      const recordingSessionId = meeting.recordingSessionId;
      delete meeting.recordingSessionId;
      if (sessionStorage.getItem(ACTIVE_RECORDING_SESSION_KEY) === recordingSessionId) {
        sessionStorage.removeItem(ACTIVE_RECORDING_SESSION_KEY);
      }
    }
    failMeeting(meeting, error);
  } finally {
    recorder.finalizing = false;
  }
}

function createMeeting(values) {
  const meeting = {
    id: crypto.randomUUID(), createdAt: new Date().toISOString(), qa: [], keywords: [], highlights: [], speaker_summaries: [], decisions: [], decision_records: [], action_items: [],
    mode: state.draftMode,
    ...(state.draftMode === "interview" && state.draftInterview ? { interviewContext: { ...state.draftInterview, competencies: [...state.draftInterview.competencies] } } : {}),
    ...values,
  };
  state.meetings.unshift(meeting);
  const removed = state.meetings.slice(MAX_MEETINGS);
  state.meetings = state.meetings.slice(0, MAX_MEETINGS);
  for (const item of removed) deleteRecording(item.id).catch(() => {});
  state.activeId = meeting.id;
  state.query = "";
  elements.searchInput.value = "";
  saveMeetings();
  render();
  return meeting;
}

function failMeeting(meeting, error) {
  meeting.status = "error";
  meeting.error = error?.message || String(error);
  saveAndRender();
  showToast(meeting.error, true);
}

function newMeeting() {
  if (state.recording || state.sharedMode) return;
  if (state.recorder) {
    showToast("请先重试保存上一段录音", true);
    return;
  }
  state.activeId = null;
  state.draftTitle = "新的会议记录";
  state.draftMode = "meeting";
  state.draftInterview = null;
  state.pendingSource = "";
  state.insight = "summary";
  state.query = "";
  elements.searchInput.value = "";
  elements.insightsPane.classList.remove("open");
  closeSidebar();
  render();
}

async function handleHistoryClick(event) {
  const deleteButton = event.target.closest("[data-delete-id]");
  if (deleteButton) {
    event.stopPropagation();
    await removeMeeting(deleteButton.dataset.deleteId);
    return;
  }
  const item = event.target.closest("[data-meeting-id]");
  if (!item) return;
  state.activeId = item.dataset.meetingId;
  state.query = "";
  elements.searchInput.value = "";
  closeSidebar();
  render();
}

async function removeMeeting(id) {
  const meeting = state.meetings.find((item) => item.id === id);
  if (state.recorder?.meeting.id === id) {
    showToast("请先结束当前录音，再删除这条记录", true);
    return;
  }
  if (!meeting || !window.confirm(`删除“${meeting.title}”及保存在本机的录音？此操作无法撤销。`)) return;
  try {
    await deleteRecording(id);
    state.meetings = state.meetings.filter((item) => item.id !== id);
    if (state.activeId === id) state.activeId = state.meetings[0]?.id || null;
    saveAndRender();
    showToast("记录和本地录音已删除");
  } catch (error) {
    showToast(`删除失败：${error.message}`, true);
  }
}

async function handleQuestion(event) {
  if (event.target.id !== "qaForm") return;
  event.preventDefault();
  const meeting = activeMeeting();
  const input = event.target.querySelector("#questionInput");
  const question = input.value.trim();
  if (!meeting || !question || meeting.asking || !requireConfig()) return;
  meeting.qa ||= [];
  meeting.qa.push({ role: "user", content: question });
  meeting.asking = true;
  saveAndRender();
  try {
    const answer = await askTranscript({ config: state.config, meeting, question });
    meeting.qa.push({ role: "assistant", content: answer });
  } catch (error) {
    meeting.qa.push({ role: "assistant", content: `回答失败：${error.message}` });
  } finally {
    meeting.asking = false;
    saveAndRender();
  }
}

function selectInsight(value) {
  state.insight = value;
  renderInsights(activeMeeting());
  refreshIcons();
}

function seekToSegment(event) {
  const target = event.target.closest("[data-seek]");
  if (!target || !elements.audioPlayer.src) return;
  elements.audioPlayer.currentTime = Number(target.dataset.seek) || 0;
  elements.audioPlayer.play().catch(() => {});
}

function handleTranscriptAction(event) {
  if (!event.target.closest("[data-transcribe-recording]")) return;
  retryActiveMeeting();
}

function updateMeetingTitle(event) {
  const title = event.target.value.slice(0, 120);
  const meeting = activeMeeting();
  if (meeting && !meeting.readOnly) {
    meeting.title = title || "未命名记录";
    meeting.autoTitle = false;
    saveMeetings();
    renderHistory();
    refreshIcons();
  } else if (!meeting) state.draftTitle = title;
}

function normalizeMeetingTitle() {
  if (elements.meetingTitle.value.trim()) return;
  elements.meetingTitle.value = "未命名记录";
  const meeting = activeMeeting();
  if (meeting && !meeting.readOnly) { meeting.title = "未命名记录"; saveMeetings(); renderHistory(); }
  else if (!meeting) state.draftTitle = "未命名记录";
}

function openSettings() {
  if (state.sharedMode) return;
  elements.asrBaseUrlInput.value = state.config.asrBaseUrl;
  elements.asrApiKeyInput.value = state.config.asrApiKey;
  elements.asrModelInput.value = state.config.asrModel;
  elements.chunkSecondsInput.value = String(state.config.chunkSeconds);
  elements.chatBaseUrlInput.value = state.config.chatBaseUrl;
  elements.chatApiKeyInput.value = state.config.chatApiKey;
  elements.chatModelInput.value = state.config.chatModel;
  elements.chatProtocolInput.value = state.config.chatProtocol;
  elements.chatPathInput.value = state.config.chatPath;
  elements.transportModeInput.value = state.config.transportMode;
  elements.relayPathInput.value = state.config.relayPath;
  elements.contextHintInput.value = state.config.contextHint;
  renderTransportHelp();
  clearConnectionTests();
  elements.settingsDialog.showModal();
  refreshIcons();
}

function saveSettings(event) {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault();
  const next = settingsConfigFromForm();
  if (!next.asrBaseUrl || !next.asrApiKey || !next.asrModel || !next.chatBaseUrl || !next.chatApiKey || !next.chatModel || !next.chatPath || !next.relayPath) {
    showToast("请完整填写 MiMo 和 GPT 两组配置", true);
    return;
  }
  state.config = { ...DEFAULT_CONFIG, ...next };
  localStorage.setItem(CONFIG_KEY, JSON.stringify(state.config));
  sessionStorage.removeItem(LEGACY_ASR_SESSION_KEY);
  sessionStorage.removeItem(LEGACY_CHAT_SESSION_KEY);
  elements.settingsDialog.close();
  renderConfig();
  showToast("双模型配置已保存在此浏览器");
}

function settingsConfigFromForm() {
  return {
    asrBaseUrl: normalizeMimoBaseUrl(elements.asrBaseUrlInput.value), asrApiKey: elements.asrApiKeyInput.value.trim(),
    asrModel: elements.asrModelInput.value.trim(), asrProtocol: DEFAULT_CONFIG.asrProtocol, asrPath: DEFAULT_CONFIG.asrPath, chunkSeconds: Number(elements.chunkSecondsInput.value),
    chatBaseUrl: elements.chatBaseUrlInput.value.trim(), chatApiKey: elements.chatApiKeyInput.value.trim(),
    chatModel: elements.chatModelInput.value.trim(), chatProtocol: elements.chatProtocolInput.value, chatPath: elements.chatPathInput.value.trim(),
    transportMode: elements.transportModeInput.value, relayPath: elements.relayPathInput.value.trim(), contextHint: elements.contextHintInput.value.trim(),
  };
}

async function testSettingsConnection(kind) {
  const isAsr = kind === "asr";
  const provider = isAsr ? "MiMo" : "GPT";
  const button = isAsr ? elements.testAsrButton : elements.testChatButton;
  const result = isAsr ? elements.asrConnectionResult : elements.chatConnectionResult;
  const testConnection = isAsr ? testAsrConnection : testChatConnection;
  if (button.getAttribute("aria-disabled") === "true") return;
  const run = connectionTestRuns[kind];
  run.controller?.abort();
  const token = ++run.token;
  run.controller = new AbortController();
  const controller = run.controller;
  const timeoutId = window.setTimeout(() => controller.abort(new DOMException("API 请求超时", "TimeoutError")), 30_000);
  setConnectionTestState(button, result, "testing", `正在测试 ${provider} 连接...`);
  try {
    await testConnection({ config: settingsConfigFromForm(), signal: controller.signal });
    if (token !== run.token) return;
    setConnectionTestState(button, result, "success", `${provider} 连接成功，Base URL、API Key 和模型均可用`);
  } catch (error) {
    if (token !== run.token) return;
    setConnectionTestState(button, result, "error", connectionTestErrorMessage(provider, error));
  } finally {
    window.clearTimeout(timeoutId);
    if (token === run.token) run.controller = null;
  }
}

function setConnectionTestState(button, result, status, message) {
  const testing = status === "testing";
  button.setAttribute("aria-disabled", String(testing));
  button.classList.toggle("is-testing", testing);
  button.setAttribute("aria-busy", String(testing));
  button.querySelector("span").textContent = testing ? "测试中" : "测试";
  result.dataset.state = status;
  result.textContent = message;
}

function clearConnectionTest(kind) {
  const run = connectionTestRuns[kind];
  run.token += 1;
  run.controller?.abort();
  run.controller = null;
  const button = kind === "asr" ? elements.testAsrButton : elements.testChatButton;
  const result = kind === "asr" ? elements.asrConnectionResult : elements.chatConnectionResult;
  button.setAttribute("aria-disabled", "false");
  button.classList.remove("is-testing");
  button.setAttribute("aria-busy", "false");
  button.querySelector("span").textContent = "测试";
  result.removeAttribute("data-state");
  result.textContent = "";
}

function clearConnectionTests() {
  clearConnectionTest("asr");
  clearConnectionTest("chat");
}

function clearStoredKeys() {
  if (!window.confirm("清除保存在此浏览器中的 MiMo 和 GPT API Key？")) return;
  state.config = { ...state.config, asrApiKey: "", chatApiKey: "" };
  localStorage.setItem(CONFIG_KEY, JSON.stringify(state.config));
  sessionStorage.removeItem(LEGACY_ASR_SESSION_KEY);
  sessionStorage.removeItem(LEGACY_CHAT_SESSION_KEY);
  elements.asrApiKeyInput.value = "";
  elements.chatApiKeyInput.value = "";
  clearConnectionTests();
  renderConfig();
  showToast("本机保存的 API Key 已清除");
}

function exportKeys() {
  const backup = createKeyBackup({
    mimo: elements.asrApiKeyInput.value,
    gpt: elements.chatApiKeyInput.value,
  });
  if (!backup.keys.mimo && !backup.keys.gpt) {
    showToast("没有可导出的 API Key", true);
    return;
  }
  if (!window.confirm("导出的 JSON 会以明文保存两组 API Key。请确认下载设备和保存位置安全。")) return;
  const blob = new Blob([`${JSON.stringify(backup, null, 2)}\n`], { type: "application/json;charset=utf-8" });
  downloadBlob(blob, `yanlan-api-keys-${formatFileDate(new Date())}.json`);
  showToast("API Key 备份已导出，请妥善保管");
}

async function importKeys() {
  const file = elements.importKeysInput.files?.[0];
  elements.importKeysInput.value = "";
  if (!file) return;
  if (file.size > 64 * 1024) {
    showToast("Key 备份文件不能超过 64 KiB", true);
    return;
  }
  try {
    const keys = parseKeyBackup(await file.text());
    elements.asrApiKeyInput.value = keys.mimo;
    elements.chatApiKeyInput.value = keys.gpt;
    clearConnectionTests();
    showToast("API Key 已填入，请检查后保存设置");
  } catch (error) {
    showToast(`导入失败：${error.message}`, true);
  }
}

function renderTransportHelp() {
  const relay = elements.transportModeInput.value === "relay";
  elements.relayPathInput.disabled = !relay;
  elements.transportHelp.textContent = relay
    ? "本地网关支持任意用户 Base URL。请通过 npm run local 打开本机页面。"
    : "直连要求模型服务允许当前网页域名发起 CORS 请求。";
}

function loadConfig() {
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem(CONFIG_KEY) || "{}"); } catch {}
  const chatProtocol = stored.chatProtocol || (stored.chatPath ? (/\bresponses\/?$/i.test(stored.chatPath) ? "responses" : "chat-completions") : DEFAULT_CONFIG.chatProtocol);
  const asrBaseUrl = normalizeMimoBaseUrl(stored.asrBaseUrl || DEFAULT_CONFIG.asrBaseUrl);
  const config = {
    ...DEFAULT_CONFIG,
    ...stored,
    chatProtocol,
    asrBaseUrl,
    asrProtocol: DEFAULT_CONFIG.asrProtocol,
    asrPath: DEFAULT_CONFIG.asrPath,
    asrApiKey: stored.asrApiKey || sessionStorage.getItem(LEGACY_ASR_SESSION_KEY) || "",
    chatApiKey: stored.chatApiKey || sessionStorage.getItem(LEGACY_CHAT_SESSION_KEY) || "",
  };
  const migrated = stored.asrBaseUrl !== config.asrBaseUrl || stored.asrProtocol !== config.asrProtocol || stored.asrPath !== config.asrPath;
  if (migrated || (!stored.asrApiKey && config.asrApiKey) || (!stored.chatApiKey && config.chatApiKey)) {
    try { localStorage.setItem(CONFIG_KEY, JSON.stringify(config)); } catch {}
  }
  sessionStorage.removeItem(LEGACY_ASR_SESSION_KEY);
  sessionStorage.removeItem(LEGACY_CHAT_SESSION_KEY);
  return config;
}

function requireConfig() {
  if (hasCompleteConfig()) return true;
  openSettings();
  showToast("请先配置 MiMo ASR 和 GPT 两组 API", true);
  return false;
}

function hasCompleteConfig() {
  return Boolean(state.config.asrBaseUrl && state.config.asrApiKey && state.config.chatBaseUrl && state.config.chatApiKey);
}

function toggleSecret(event) {
  const input = document.getElementById(event.currentTarget.dataset.keyInput);
  input.type = input.type === "password" ? "text" : "password";
  event.currentTarget.innerHTML = `<i data-lucide="${input.type === "password" ? "eye" : "eye-off"}"></i>`;
  refreshIcons();
}

async function openShareDialog() {
  const meeting = activeMeeting();
  if (!meeting?.segments?.length) return;
  elements.shareUrlInput.value = "正在生成…";
  elements.shareHint.textContent = "";
  elements.shareDialog.showModal();
  try {
    const url = await buildShareUrl(meeting);
    elements.shareUrlInput.value = url;
    elements.shareHint.textContent = url.length > 60000 ? "逐字稿较长，部分聊天软件或浏览器可能截断链接；建议改用离线网页。" : "任何拿到链接的人都能查看这份逐字稿。";
  } catch (error) {
    elements.shareUrlInput.value = "";
    elements.shareHint.textContent = error.message;
  }
  refreshIcons();
}

async function buildShareUrl(meeting) {
  const bytes = new TextEncoder().encode(JSON.stringify(publicMeeting(meeting)));
  let prefix = "j.";
  let output = bytes;
  if (typeof CompressionStream !== "undefined") {
    output = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
    prefix = "g.";
  }
  const base = `${location.origin}${location.pathname}${location.search}`;
  return `${base}#share=${prefix}${bytesToBase64Url(output)}`;
}

async function readSharedMeeting() {
  const encoded = new URLSearchParams(location.hash.slice(1)).get("share");
  if (!encoded) return null;
  const prefix = encoded.slice(0, 2);
  let bytes = base64UrlToBytes(encoded.slice(2));
  if (prefix === "g.") {
    if (typeof DecompressionStream === "undefined") throw new Error("当前浏览器不支持打开压缩分享稿");
    bytes = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
  } else if (prefix !== "j.") throw new Error("分享稿格式不受支持");
  const parsed = JSON.parse(new TextDecoder().decode(bytes));
  if (!Array.isArray(parsed.segments)) throw new Error("分享稿数据不完整");
  return parsed;
}

async function copyShareUrl() {
  if (!elements.shareUrlInput.value || elements.shareUrlInput.value === "正在生成…") return;
  try { await navigator.clipboard.writeText(elements.shareUrlInput.value); showToast("分享链接已复制"); }
  catch { showToast("浏览器未允许复制，请手动选择链接", true); }
}

function downloadShareHtml() {
  const meeting = activeMeeting();
  if (!meeting) return;
  downloadBlob(new Blob([buildShareHtml(meeting)], { type: "text/html;charset=utf-8" }), `${safeFilename(meeting.title)}-分享稿.html`);
  showToast("离线分享网页已下载");
}

async function copyTranscript() {
  const meeting = activeMeeting();
  if (!meeting?.segments?.length) return;
  try { await navigator.clipboard.writeText(toMarkdown(meeting)); showToast("逐字稿已复制"); }
  catch { showToast("浏览器未允许复制", true); }
}

function toggleExportMenu() {
  const open = elements.exportMenu.classList.toggle("hidden");
  elements.exportButton.setAttribute("aria-expanded", String(!open));
}

function closeExportMenu() {
  elements.exportMenu.classList.add("hidden");
  elements.exportButton.setAttribute("aria-expanded", "false");
}

async function handleExport(event) {
  const button = event.target.closest("[data-export]");
  if (!button) return;
  closeExportMenu();
  const meeting = activeMeeting();
  if (!meeting) return;
  const name = safeFilename(meeting.title);
  if (button.dataset.export === "audio") {
    const record = await getRecording(meeting.id).catch(() => null);
    if (!record?.blob) { showToast("分享稿不包含原始录音", true); return; }
    downloadBlob(record.blob, record.fileName || `${name}.${extensionForMime(record.mimeType)}`);
  } else if (button.dataset.export === "markdown") downloadBlob(new Blob([toMarkdown(meeting)], { type: "text/markdown;charset=utf-8" }), `${name}.md`);
  else if (button.dataset.export === "vtt") downloadBlob(new Blob([toVtt(meeting)], { type: "text/vtt;charset=utf-8" }), `${name}.vtt`);
  else if (button.dataset.export === "json") downloadBlob(new Blob([JSON.stringify(publicMeeting(meeting), null, 2)], { type: "application/json;charset=utf-8" }), `${name}.json`);
  else if (button.dataset.export === "html") downloadShareHtml();
  showToast("导出已开始");
}

function renderWaveformBars() {
  if (!elements.waveform.childElementCount) elements.waveform.innerHTML = Array.from({ length: 24 }, () => '<span class="waveform-bar"></span>').join("");
}

function updateRecordingClock() {
  if (!state.recorder) return;
  const seconds = (performance.now() - state.recorder.startedAt) / 1000;
  elements.recordingTime.textContent = formatTimestamp(seconds);
  state.recorder.meeting.duration = seconds;
  const now = Date.now();
  if (now - state.recorder.lastHeartbeatAt >= RECORDING_HEARTBEAT_MS) {
    state.recorder.lastHeartbeatAt = now;
    state.recorder.meeting.recordingHeartbeat = now;
    saveMeetings();
  }
  renderHeader(state.recorder.meeting);
}

function renderLiveStatus() {
  const recorder = state.recorder;
  if (!recorder) return;
  if (recorder.persistenceErrors.length) elements.liveStatus.textContent = "本地保存失败，结束时将重试";
  else if (!recorder.transcriptionEnabled) elements.liveStatus.textContent = "音频正在增量保存在本机";
  else if (recorder.pendingRequests) elements.liveStatus.textContent = "正在转写当前片段";
  else if (recorder.errors.length) elements.liveStatus.textContent = "部分片段等待结束后重试";
  else elements.liveStatus.textContent = recorder.meeting.segments.length ? "逐字稿实时更新中" : "正在监听";
}

function updateWaveform(level) {
  const bars = elements.waveform.children;
  const energy = Math.min(1, level * 14);
  for (let index = 0; index < bars.length; index += 1) {
    const contour = 0.3 + 0.7 * Math.abs(Math.sin(index * 0.8 + performance.now() / 180));
    bars[index].style.height = `${Math.max(5, 5 + energy * contour * 24)}px`;
  }
}

function encodeWav(pcm, sourceRate) {
  const samples = resample(pcm, sourceRate, 16000);
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true); writeAscii(view, 8, "WAVE"); writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); writeAscii(view, 36, "data"); view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (const sample of samples) { const clipped = Math.max(-1, Math.min(1, sample)); view.setInt16(offset, clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff, true); offset += 2; }
  return new Blob([buffer], { type: "audio/wav" });
}

function resample(input, sourceRate, targetRate) {
  if (sourceRate === targetRate) return input;
  const ratio = sourceRate / targetRate;
  const output = new Float32Array(Math.round(input.length / ratio));
  for (let index = 0; index < output.length; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(input.length - 1, left + 1);
    const weight = position - left;
    output[index] = input[left] * (1 - weight) + input[right] * weight;
  }
  return output;
}

function concatenatePcm(chunks, length) {
  const output = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return output;
}

function rms(samples) {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / Math.max(1, samples.length));
}

function writeAscii(view, offset, text) {
  for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
}

function normalizeSegments(segments, duration) {
  return (segments || []).map((segment, index) => ({
    start_seconds: Math.max(0, Number(segment.start_seconds) || 0),
    end_seconds: Math.max(0, Number(segment.end_seconds) || (index === segments.length - 1 ? duration : 0)),
    speaker: String(segment.speaker || "发言人 1"), text: String(segment.text || "").trim(),
  })).filter((segment) => segment.text);
}

function activeMeeting() { return state.meetings.find((meeting) => meeting.id === state.activeId) || null; }

function saveAndRender() { saveMeetings(); render(); }

function loadMeetings() {
  try {
    const parsed = JSON.parse(localStorage.getItem(MEETINGS_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, MAX_MEETINGS).map((meeting) => ["transcribing", "correcting", "summarizing"].includes(meeting.status)
      ? { ...meeting, status: "error", error: "上次处理被页面关闭中断，可从本地录音重新转写。" }
      : meeting);
  } catch { return []; }
}

function saveMeetings() {
  if (state.sharedMode) return;
  try {
    localStorage.setItem(MEETINGS_KEY, JSON.stringify(state.meetings.slice(0, MAX_MEETINGS).map(({ asking, ...meeting }) => meeting)));
  } catch { showToast("本地逐字稿存储空间已满，请先导出并删除旧记录", true); }
}

function probeDuration(file) {
  return new Promise((resolve, reject) => {
    const audio = document.createElement("audio");
    const url = URL.createObjectURL(file);
    const finish = (callback, value) => {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      audio.removeAttribute("src");
      callback(value);
    };
    const timer = window.setTimeout(() => finish(reject, new Error("读取音频时长超时")), 5000);
    audio.preload = "metadata";
    audio.onloadedmetadata = () => finish(resolve, Number.isFinite(audio.duration) ? audio.duration : 0);
    audio.onerror = () => finish(reject, new Error("无法读取音频时长"));
    audio.src = url;
  });
}

function chooseAudio() { if (requireConfig()) elements.fileInput.click(); }
function openSidebar() { elements.sidebar.classList.add("open"); elements.sidebarScrim.classList.add("visible"); }
function closeSidebar() { elements.sidebar.classList.remove("open"); elements.sidebarScrim.classList.remove("visible"); }
function refreshIcons() { createIcons({ icons, attrs: { "stroke-width": 1.8 } }); }

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = filename; document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

function preferredRecorderMime() {
  return ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm", "audio/mp4"].find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function extensionForMime(type = "") {
  if (type.includes("ogg")) return "ogg";
  if (type.includes("mp4") || type.includes("m4a")) return "m4a";
  if (type.includes("mpeg")) return "mp3";
  if (type.includes("wav")) return "wav";
  return "webm";
}

function cleanFileTitle(name = "") { return name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim().slice(0, 120); }
function normalizeDraftTitle(value) {
  const title = String(value || "").trim();
  if (state.draftMode === "interview") {
    if (state.draftInterview) return `${state.draftInterview.candidateAlias || "候选人"} · ${state.draftInterview.role} ${state.draftInterview.stage}`.slice(0, 120);
    return `面试记录 ${formatFileDate(new Date())}`;
  }
  return !title || ["新的会议记录", "未命名记录"].includes(title) ? `会议记录 ${formatFileDate(new Date())}` : title.slice(0, 120);
}
function safeFilename(value) { return String(value || "会议记录").replace(/[\\/:*?"<>|]/g, "-").trim().slice(0, 100) || "会议记录"; }
function speakerInitial(speaker, index) { return String(speaker || "").match(/\d+/)?.[0] || String(speaker || "S").trim().charAt(0).toUpperCase() || String(index + 1); }
function splitCompetencies(value) { return [...new Set(String(value || "").split(/[、,，;；\n]+/).map((item) => item.trim()).filter(Boolean))].slice(0, 20); }
function correctionNotice(meeting) {
  if (meeting.correctionError) return `<p class="inline-warning">术语校正未完成：${escapeHtml(meeting.correctionError)}</p>`;
  const accepted = meeting.terminology?.length ? `<p class="correction-note"><i data-lucide="spell-check-2"></i>已统一 ${meeting.terminology.length} 个术语</p>` : "";
  const rejected = meeting.rejectedCorrections ? `<p class="inline-warning">已保留原始文本：${meeting.rejectedCorrections} 个片段未应用模型校正（未通过安全边界）</p>` : "";
  return `${accepted}${rejected}`;
}
function ratingLabel(value) { return ({ strong: "突出", adequate: "符合", mixed: "有待确认", weak: "不足", insufficient: "证据不足" })[value] || "证据不足"; }
function statusIcon(status, mode) { return ["recording", "recovering", "transcribing", "correcting", "summarizing"].includes(status) ? "loader-circle" : status === "error" ? "circle-alert" : mode === "interview" ? "briefcase-business" : "file-audio"; }
function statusLabel(status, mode) { return ({ recording: state.recorder?.transcriptionEnabled ? "实时转写中" : "录音中", recovering: "正在恢复录音", recorded: "仅录音", transcribing: "正在转写", correcting: "GPT 正在校正术语", summarizing: mode === "interview" ? "GPT 正在整理面试证据" : "GPT 正在生成纪要", done: "已完成", error: "处理失败" })[status] || ""; }

function formatHistoryDate(value) {
  const date = new Date(value); if (Number.isNaN(date.getTime())) return "刚刚";
  return new Intl.DateTimeFormat("zh-CN", date.toDateString() === new Date().toDateString() ? { hour: "2-digit", minute: "2-digit", hour12: false } : { month: "numeric", day: "numeric" }).format(date);
}

function formatFullDate(value) {
  const date = new Date(value); if (Number.isNaN(date.getTime())) return "刚刚";
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function formatFileDate(date) {
  const parts = new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.month}-${values.day}_${values.hour}-${values.minute}`;
}

function formatDurationLabel(seconds) {
  const value = Math.max(0, Math.round(seconds)); const hours = Math.floor(value / 3600); const minutes = Math.floor((value % 3600) / 60); const rest = value % 60;
  return `${hours ? `${hours} 小时 ` : ""}${minutes ? `${minutes} 分 ` : ""}${rest} 秒`.trim();
}

function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]); }

function showToast(message, error = false) {
  clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.className = `toast visible${error ? " error" : ""}`;
  state.toastTimer = setTimeout(() => { elements.toast.className = "toast"; }, 3600);
}
