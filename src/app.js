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
  readableTranscriptSegments,
  summarizeTranscript,
  testAsrConnection,
  testChatConnection,
  toMarkdown,
  toVtt,
  transcribeAudioWithRetry,
} from "./api.js";
import { assessTranscriptionQuality } from "./asr-quality.js";
import { reconcileTranscriptSegments, transcriptionQualityError, transcribePcmAdaptively } from "./asr-pipeline.js";
import { createStreamingAudioDecoder, isStreamingAudioOpenError, mapAsyncIterableWithConcurrency } from "./audio-stream.js";
import {
  canUseMimoWholeFileFallback,
  MAX_MIMO_FALLBACK_BYTES,
  MAX_MIMO_FALLBACK_SECONDS,
  MAX_MIMO_UPLOAD_SECONDS,
  audioDurationOrNull,
  mimoUploadLimitMessage,
  storedAudioDuration,
} from "./audio-limits.js";
import { createKeyBackup, parseKeyBackup } from "./key-backup.js";
import { deleteRecording, getRecording, getRecordingChunks, saveRecording, saveRecordingChunk } from "./storage.js";

const MEETINGS_KEY = "yanlan.meetings.v1";
const MEETING_TOMBSTONE_PREFIX = "yanlan.meeting.deleted.v1.";
const CONFIG_KEY = "yanlan.config.v1";
const LEGACY_ASR_SESSION_KEY = "yanlan.asr-key.v1";
const LEGACY_CHAT_SESSION_KEY = "yanlan.chat-key.v1";
const ACTIVE_RECORDING_SESSION_KEY = "yanlan.active-recording.v1";
const SHARED_MEETING_LOCATION = new URLSearchParams(location.hash.slice(1)).has("share");
const MAX_MEETINGS = 40;
const MAX_RECORDING_SECONDS = 4 * 60 * 60;
const ASR_REQUEST_CONCURRENCY = 2;
const MAX_LIVE_ASR_BUFFERED_CHUNKS = 2;
const RECORDING_HEARTBEAT_MS = 1_000;
const RECORDING_STALE_MS = 4_000;
const ACTIVE_TASK_STATUSES = new Set(["recording", "recovering", "transcribing", "correcting", "summarizing"]);
const recordingRecoveryRuns = new Map();
const connectionTestRuns = {
  asr: { token: 0, controller: null },
  chat: { token: 0, controller: null },
};
const insightRetryRuns = new Map();
const meetingProcessingRuns = new Map();
const questionRuns = new Map();
const deletingMeetingIds = new Set();
const shareGenerationRuns = { token: 0, meetingId: null, ready: null };

const $ = (selector) => document.querySelector(selector);
const elements = {
  sidebar: $("#sidebar"), sidebarOpen: $("#sidebarOpen"), sidebarClose: $("#sidebarClose"), sidebarScrim: $("#sidebarScrim"),
  historyList: $("#historyList"), historyCount: $("#historyCount"), newMeetingButton: $("#newMeetingButton"),
  meetingTitle: $("#meetingTitle"), meetingMeta: $("#meetingMeta"), meetingTaskStatus: $("#meetingTaskStatus"),
  meetingTaskMark: $("#meetingTaskMark"), meetingTaskLabel: $("#meetingTaskLabel"), copyButton: $("#copyButton"), shareButton: $("#shareButton"),
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
    purgeTombstonedMeetingsFromStorage();
    await cleanupTombstonedMeetingAudio();
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
  elements.insightContent.addEventListener("click", handleInsightAction);
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
  window.addEventListener("storage", handleMeetingStorageChange);
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
  elements.historyList.innerHTML = state.meetings.map((meeting) => {
    const task = meetingTaskState(meeting);
    return `
    <div class="history-item ${meeting.id === state.activeId ? "active" : ""}" data-meeting-id="${escapeHtml(meeting.id)}">
      <span class="history-icon ${meeting.mode === "interview" ? "interview" : ""} is-${task.state}"><i data-lucide="${statusIcon(meeting.status, meeting.mode, task.state)}"></i></span>
      <span class="history-text"><span class="history-title">${escapeHtml(meeting.title)}</span><span class="history-date">${escapeHtml(formatHistoryDate(meeting.createdAt))}</span></span>
      ${meeting.readOnly ? "" : `<button class="history-delete" data-delete-id="${escapeHtml(meeting.id)}" title="删除记录" aria-label="删除记录"${state.recorder?.meeting.id === meeting.id || isRunningTask(meeting) ? " disabled" : ""}><i data-lucide="trash-2"></i></button>`}
    </div>`;
  }).join("");
}

function renderHeader(meeting) {
  elements.meetingTitle.value = meeting?.title || state.draftTitle;
  elements.meetingTitle.readOnly = Boolean(meeting?.readOnly || insightRetryInProgress(meeting) || isMeetingDeleting(meeting));
  const hasTranscript = Boolean(meeting?.segments?.length && (meeting.readOnly || meeting.status === "done"));
  const hasAudio = Boolean(meeting?.hasRecording && !meeting?.readOnly);
  const derivedContentLocked = insightRetryInProgress(meeting) || isMeetingDeleting(meeting);
  elements.copyButton.disabled = !hasTranscript || derivedContentLocked;
  elements.shareButton.disabled = !hasTranscript || derivedContentLocked;
  elements.exportButton.disabled = ((!hasTranscript || derivedContentLocked) && !hasAudio) || isMeetingDeleting(meeting);
  elements.copyShareButton.disabled = !hasTranscript || derivedContentLocked;
  elements.copySharePrimaryButton.disabled = !hasTranscript || derivedContentLocked;
  elements.downloadShareButton.disabled = !hasTranscript || derivedContentLocked;
  elements.exportMenu.querySelectorAll("[data-export]").forEach((button) => {
    button.disabled = isMeetingDeleting(meeting) || (button.dataset.export === "audio" ? !hasAudio : (!hasTranscript || derivedContentLocked));
  });
  if (!meeting) {
    elements.meetingMeta.textContent = "尚未开始";
    elements.meetingTaskStatus.classList.add("hidden");
    delete elements.meetingTaskStatus.dataset.signature;
    return;
  }
  const parts = [formatFullDate(meeting.createdAt)];
  if (meeting.mode === "interview") parts.push(`${meeting.interviewContext?.stage || "面试"} · ${meeting.interviewContext?.role || "岗位待补充"}`);
  if (meeting.duration) parts.push(formatDurationLabel(meeting.duration));
  elements.meetingMeta.textContent = parts.filter(Boolean).join(" · ");
  renderMeetingTaskStatus(meeting);
}

function renderMeetingTaskStatus(meeting) {
  const task = meetingTaskState(meeting);
  const signature = `${task.state}|${task.mark || ""}|${task.icon || ""}|${task.label}`;
  elements.meetingTaskStatus.classList.remove("hidden");
  elements.meetingTaskStatus.dataset.state = task.state;
  if (elements.meetingTaskStatus.dataset.signature === signature) return;
  elements.meetingTaskStatus.dataset.signature = signature;
  elements.meetingTaskMark.innerHTML = task.icon ? `<i data-lucide="${task.icon}"></i>` : escapeHtml(task.mark || "");
  elements.meetingTaskLabel.textContent = task.label;
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
    elements.processingFile.textContent = processingDisplayText(meeting);
  }
  if (meeting?.status === "error") {
    elements.errorMessage.textContent = meeting.error || "处理失败，请稍后重试。";
    elements.retryButton.disabled = isMeetingDeleting(meeting) || (!meeting.hasRecording && !meeting.recoveryPending && state.recorder?.meeting.id !== meeting.id);
  }
  if (liveOrTranscript) renderTranscript(meeting);
  renderPlayer(meeting);
  if (state.recording) renderLiveStatus();
}

function renderTranscript(meeting) {
  if (!meeting) return;
  const segments = readableTranscriptSegments(meeting.segments || []).filter((segment) => !state.query || `${segment.speaker} ${segment.text}`.toLocaleLowerCase().includes(state.query));
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
    elements.insightContent.innerHTML = `${correctionNotice(meeting)}${meeting.summaryError ? summaryRetryState(meeting) : '<div class="insight-empty"><i data-lucide="circle-alert"></i><span>面试证据尚未整理</span></div>'}`;
    return;
  }
  const correction = correctionNotice(meeting);
  const retry = meeting.summaryError ? summaryRetryNotice(meeting) : "";
  const coverage = (report.competencies || []).filter((item) => item.evidence?.length).map((item) => (
    `<li>${escapeHtml(item.name)}：${item.evidence.length} 条逐字稿原话，需核对说话人并人工判断</li>`
  )).join("") || "<li>没有通过校验的逐字稿原话</li>";
  const risks = report.risks?.length ? report.risks.map((item) => `<li>${escapeHtml(item)}</li>`).join("") : "<li>没有识别到明确待核实项</li>";
  elements.insightContent.innerHTML = `${correction}${retry}<p class="interview-disclaimer"><i data-lucide="shield-check"></i><span>AI 只整理补充追问材料，不自动推进或淘汰候选人。程序只校验时间与原话，是否支持能力判断仍需面试官回听复核。</span></p><section class="insight-section"><h2 class="insight-label"><i data-lucide="scan-search"></i><span>证据复核</span></h2><p class="summary-text">${escapeHtml(report.overview || meeting.summary || "证据不足")}</p></section><div class="strength-risk-grid"><section><h2 class="insight-label"><i data-lucide="list-checks"></i><span>证据覆盖</span></h2><ul>${coverage}</ul></section><section><h2 class="insight-label"><i data-lucide="search-alert"></i><span>风险与待核实</span></h2><ul>${risks}</ul></section></div>`;
}

function renderInterviewEvidence(meeting) {
  if (meeting.summaryError) {
    elements.insightContent.innerHTML = summaryRetryState(meeting);
    return;
  }
  const report = meeting.interviewReport;
  if (!report?.competencies?.length) {
    elements.insightContent.innerHTML = '<div class="insight-empty"><i data-lucide="scan-search"></i><span>没有可展示的能力证据</span></div>';
    return;
  }
  const competencies = report.competencies.map((item) => {
    const evidence = item.evidence?.length ? `<div class="evidence-list">${item.evidence.map((entry) => `<button class="evidence-item" type="button" data-seek="${Number(entry.start_seconds) || 0}"><time>${formatTimestamp(entry.start_seconds)}</time><span>${escapeHtml(entry.speaker || "发言人")} · “${escapeHtml(entry.quote)}”</span><i data-lucide="play"></i></button>`).join("")}</div>` : '<p class="evidence-empty">无可核验逐字稿证据</p>';
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
  const keywords = meeting.summaryError
    ? '<p class="summary-text">本次未生成关键词；摘要与关键词将随智能纪要一并重新生成</p>'
    : meeting.keywords?.length
    ? `<div class="keyword-list">${meeting.keywords.map((item) => `<span class="keyword">${escapeHtml(item)}</span>`).join("")}</div>`
    : '<p class="summary-text">无关键词</p>';
  const correction = correctionNotice(meeting);
  const summary = meeting.summaryError
    ? summaryRetryNotice(meeting)
    : `<p class="summary-text">${escapeHtml(meeting.summary || "暂无摘要")}</p>`;
  elements.insightContent.innerHTML = `${correction}${analysisRunNotice(meeting)}<section class="insight-section"><h2 class="insight-label"><i data-lucide="align-left"></i><span>内容摘要</span></h2>${summary}</section><section class="insight-section"><h2 class="insight-label"><i data-lucide="tags"></i><span>关键词</span></h2>${keywords}</section>`;
}

function renderHighlights(meeting) {
  if (meeting.summaryError) {
    elements.insightContent.innerHTML = summaryRetryState(meeting);
    return;
  }
  if (!meeting.highlights?.length) {
    elements.insightContent.innerHTML = '<div class="insight-empty"><i data-lucide="quote"></i><span>没有识别到可核验的会议金句</span></div>';
    return;
  }
  elements.insightContent.innerHTML = `<div class="highlight-list">${meeting.highlights.map((item) => `<button class="highlight-item" type="button" data-seek="${Number(item.start_seconds) || 0}"><div class="highlight-meta"><time>${formatTimestamp(item.start_seconds)}</time><span>${escapeHtml(item.speaker || "发言人")}</span><i data-lucide="play"></i></div><blockquote>“${escapeHtml(item.quote)}”</blockquote>${item.reason ? `<p>${escapeHtml(item.reason)}</p>` : ""}</button>`).join("")}</div>`;
}

function renderSpeakerSummaries(meeting) {
  if (meeting.summaryError) {
    elements.insightContent.innerHTML = summaryRetryState(meeting);
    return;
  }
  if (!meeting.speaker_summaries?.length) {
    elements.insightContent.innerHTML = '<div class="insight-empty"><i data-lucide="users"></i><span>没有足够发言内容生成发言人总结</span></div>';
    return;
  }
  elements.insightContent.innerHTML = `${legacyUnverifiedInsightsNotice(meeting)}<div class="speaker-summary-list">${meeting.speaker_summaries.map((item, index) => `<section class="speaker-summary-item"><div class="speaker-summary-head"><span class="speaker-avatar">${escapeHtml(speakerInitial(item.speaker, index))}</span><h2>${escapeHtml(item.speaker || "发言人")}</h2></div><p>${escapeHtml(item.summary || "无")}</p>${item.key_points?.length ? `<ul>${item.key_points.map((point) => `<li>${escapeHtml(point)}</li>`).join("")}</ul>` : ""}</section>`).join("")}</div>`;
}

function renderActions(meeting) {
  if (meeting.summaryError) {
    elements.insightContent.innerHTML = summaryRetryState(meeting);
    return;
  }
  const records = meeting.decision_records || [];
  if (!records.length && !meeting.action_items?.length) {
    elements.insightContent.innerHTML = '<div class="insight-empty"><i data-lucide="gavel"></i><span>没有识别到明确决策或行动项</span></div>';
    return;
  }
  const decisions = records.length ? `<section class="decision-section"><h2 class="insight-label"><i data-lucide="gavel"></i><span>关键决策</span></h2><div class="decision-record-list">${records.map((item) => `<button class="decision-record" type="button"${item.start_seconds == null ? "" : ` data-seek="${Number(item.start_seconds) || 0}"`}><div>${item.start_seconds == null ? "" : `<time>${formatTimestamp(item.start_seconds)}</time>`}<strong>${escapeHtml(item.decision)}</strong>${item.start_seconds == null ? "" : '<i data-lucide="play"></i>'}</div>${item.evidence ? `<p>“${escapeHtml(item.evidence)}”</p>` : ""}</button>`).join("")}</div></section>` : "";
  const actions = meeting.action_items?.length ? `<section class="action-section"><h2 class="insight-label"><i data-lucide="list-checks"></i><span>行动项</span></h2><ul class="action-list">${meeting.action_items.map((item) => `<li class="action-item"><i data-lucide="square-check-big"></i><div><p class="action-task">${escapeHtml(item.task)}</p><div class="action-meta">${item.owner ? `<span><i data-lucide="user"></i>${escapeHtml(item.owner)}</span>` : ""}${item.due ? `<span><i data-lucide="calendar-clock"></i>${escapeHtml(item.due)}</span>` : ""}${!item.owner && !item.due ? "待确认负责人和时间" : ""}</div></div></li>`).join("")}</ul></section>` : "";
  elements.insightContent.innerHTML = `${legacyUnverifiedInsightsNotice(meeting)}${decisions}${actions}`;
}

function renderQa(meeting) {
  const messages = meeting.qa || [];
  const interview = meeting.mode === "interview";
  const blocked = meeting.asking || isRunningTask(meeting);
  elements.insightContent.innerHTML = `<div class="qa-view"><div class="qa-messages">${messages.length ? messages.map((message) => `<div class="qa-message ${message.role}"><span>${message.role === "user" ? "你" : "AI"}</span><p>${escapeHtml(message.content)}</p></div>`).join("") : `<div class="qa-starter"><i data-lucide="message-circle-question"></i><span>${interview ? "只基于岗位信息和逐字稿证据追问" : "基于校正后的逐字稿提问"}</span></div>`}</div>${meeting.readOnly ? '<p class="share-hint">分享稿为只读模式，不能调用你的 API。</p>' : `<form class="qa-composer" id="qaForm"><textarea id="questionInput" rows="2" maxlength="1000" placeholder="${interview ? "例如：候选人对故障恢复给出了哪些具体证据？" : "例如：会议最终决定了什么？"}" ${blocked ? "disabled" : ""} required></textarea><button class="icon-button" aria-label="发送问题" title="发送问题" ${blocked ? "disabled" : ""}><i data-lucide="${meeting.asking ? "loader-circle" : "send"}"></i></button></form>`}</div>`;
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
  const taskRunning = hasRunningTask();
  elements.newMeetingButton.disabled = state.sharedMode || taskRunning;
  elements.newMeetingButton.dataset.taskRunning = String(taskRunning);
  elements.newMeetingButton.title = taskRunning ? "当前任务处理完成后可新建记录" : "新建记录";
  elements.newMeetingButton.setAttribute("aria-label", taskRunning ? "当前任务处理中，暂不可新建记录" : "新建记录");
  elements.newMeetingButton.innerHTML = taskRunning
    ? '<i data-lucide="loader-circle"></i><span>当前任务处理中</span>'
    : '<i data-lucide="plus"></i><span>新建记录</span>';
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
  if (isMeetingDeleting(meeting)) return;
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
    delete elements.audioPlayer.dataset.meetingId;
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
  if (!hasRunningTask()) return;
  if (state.recorder) {
    state.recorder.meeting.recordingHeartbeat = 0;
    saveMeetings();
  }
  event.preventDefault();
  event.returnValue = "";
}

async function recoverInterruptedRecordings() {
  for (const meeting of state.meetings.filter((item) => item.status === "recording" || item.recoveryPending)) {
    await recoverInterruptedMeeting(meeting.id);
  }
}

async function recoverInterruptedMeeting(meetingId) {
  if (meetingDeletionWasRecorded(meetingId)) {
    await cleanupDeletedMeetingAudio(meetingId);
    return;
  }
  const meeting = state.meetings.find((item) => item.id === meetingId);
  if (!meeting || recordingRecoveryRuns.has(meetingId)) return;
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

  const controller = new AbortController();
  recordingRecoveryRuns.set(meetingId, controller);
  meeting.status = "recovering";
  render();
  try {
    const existing = await getRecording(meetingId);
    assertMeetingRunCurrent(meeting, controller, recordingRecoveryRuns, "Recording recovery was superseded");
    let blob = existing?.blob;
    if (!blob) {
      const chunks = await getRecordingChunks(meetingId);
      assertMeetingRunCurrent(meeting, controller, recordingRecoveryRuns, "Recording recovery was superseded");
      const committedChunks = Number(latest.recordingChunkCount);
      const observedChunks = Number(latest.recordingObservedChunkCount);
      const stoppedExpectedChunks = Number.isInteger(observedChunks) ? observedChunks : committedChunks;
      const persistenceFailed = latest.recordingPersistenceFailed === true;
      const invalidManifest = !Number.isInteger(committedChunks) || committedChunks < 0;
      const missingCommittedChunk = !invalidManifest && chunks.length < committedChunks;
      const stoppedIncomplete = latest.recordingStopped === true
        && (!Number.isInteger(stoppedExpectedChunks) || stoppedExpectedChunks < 1 || chunks.length !== stoppedExpectedChunks);
      const nonContiguous = chunks.some((chunk, index) => chunk.index !== index);
      if (persistenceFailed || invalidManifest || !chunks.length || missingCommittedChunk || stoppedIncomplete || nonContiguous) {
        const indexes = chunks.map((chunk) => chunk.index).join(", ") || "无";
        const expected = latest.recordingStopped === true ? stoppedExpectedChunks : committedChunks;
        const failureNote = persistenceFailed ? "；浏览器已报告分片写入失败" : "";
        const error = new Error(`本地录音分片不完整（至少预期 ${Number.isInteger(expected) ? expected : "未知"} 个，找到 ${chunks.length} 个；现有序号：${indexes}${failureNote}），无法标记为完整录音`);
        error.recoveryTerminal = true;
        throw error;
      }
      blob = new Blob(chunks.map((chunk) => chunk.blob), { type: latest.sourceType || chunks[0]?.mimeType || "audio/webm" });
      assertMeetingRunCurrent(meeting, controller, recordingRecoveryRuns, "Recording recovery was superseded");
      await saveRecording(meetingId, blob, {
        fileName: latest.sourceName || chunks[0]?.fileName || `恢复录音.${extensionForMime(blob.type)}`,
        mimeType: blob.type,
      });
      if (meetingDeletionWasRecorded(meetingId)) await cleanupDeletedMeetingAudio(meetingId);
      assertMeetingRunCurrent(meeting, controller, recordingRecoveryRuns, "Recording recovery was superseded");
    }
    if (!blob?.size) throw new Error("恢复后的录音为空");
    const probedDuration = await probeDuration(blob).catch(() => null);
    assertMeetingRunCurrent(meeting, controller, recordingRecoveryRuns, "Recording recovery was superseded");
    const recoveredDuration = audioDurationOrNull(probedDuration) ?? storedAudioDuration(latest.duration);
    const recoveryNote = latest.recordingStopped
      ? "录音已从停止时完整落盘的分片恢复。请重新生成逐字稿。"
      : "录音已从增量分片恢复；崩溃前最后约一秒可能尚未触发保存。请重新生成逐字稿。";
    Object.assign(meeting, latest, {
      duration: storedAudioDuration(recoveredDuration),
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
    delete meeting.recordingObservedChunkCount;
    delete meeting.recordingPersistenceFailed;
    delete meeting.recordingStopped;
    if (sessionMatches) sessionStorage.removeItem(ACTIVE_RECORDING_SESSION_KEY);
    saveAndRender();
    showToast("已恢复崩溃前增量保存的录音，请重新生成逐字稿");
  } catch (error) {
    if (controller.signal.aborted || meetingDeletionWasRecorded(meetingId) || !state.meetings.includes(meeting)) {
      await cleanupDeletedMeetingAudio(meetingId);
      return;
    }
    const saved = await getRecording(meetingId).catch(() => null);
    if (controller.signal.aborted || meetingDeletionWasRecorded(meetingId) || !state.meetings.includes(meeting)) {
      await cleanupDeletedMeetingAudio(meetingId);
      return;
    }
    meeting.status = "error";
    meeting.hasRecording = Boolean(saved?.blob?.size);
    meeting.recoveryPending = !meeting.hasRecording && !error.recoveryTerminal;
    meeting.error = `录音恢复失败：${error.message}`;
    delete meeting.recordingHeartbeat;
    delete meeting.recordingSessionId;
    if (sessionMatches) sessionStorage.removeItem(ACTIVE_RECORDING_SESSION_KEY);
    saveAndRender();
  } finally {
    if (recordingRecoveryRuns.get(meetingId) === controller) recordingRecoveryRuns.delete(meetingId);
  }
}

function storedMeeting(meetingId) {
  if (meetingDeletionWasRecorded(meetingId)) return null;
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
  if (!file.type.startsWith("audio/") && !/\.(wav|mp3|m4a|webm|ogg|mp4|aac|flac|mka|mkv)$/i.test(file.name)) {
    showToast("请选择常见格式的音频文件", true);
    return;
  }
  if (!requireConfig()) return;
  const duration = await probeDuration(file).catch(() => null);
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
    duration: storedAudioDuration(duration),
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
    await processStoredAudio(meeting, file, file.name, duration);
  } catch (error) {
    if (meetingDeletionWasRecorded(meeting.id) || !state.meetings.includes(meeting)) {
      await cleanupDeletedMeetingAudio(meeting.id);
      return;
    }
    failMeeting(meeting, error);
  }
}

async function processStoredAudio(
  meeting,
  blob,
  fileName,
  probedDuration = audioDurationOrNull(meeting.duration),
  processingConfig = { ...state.config },
  existingController = null,
) {
  const controller = existingController || new AbortController();
  if (!existingController) {
    meetingProcessingRuns.get(meeting.id)?.abort(new DOMException("Meeting processing superseded", "AbortError"));
    meetingProcessingRuns.set(meeting.id, controller);
  }
  try {
    assertMeetingRunCurrent(meeting, controller, meetingProcessingRuns, "Meeting processing was superseded");
    const uploadError = mimoUploadLimitError(blob, probedDuration, processingConfig);
    if (uploadError) throw uploadError;
    questionRuns.get(meeting.id)?.abort(new DOMException("Transcript processing started", "AbortError"));
    meeting.status = "transcribing";
    meeting.processingDetail = "正在准备音频";
    meeting.error = "";
    meeting.transcriptIncomplete = false;
    resetCorrectionResult(meeting);
    resetSummaryResult(meeting);
    meeting.qa = [];
    meeting.rawSegments = [];
    meeting.segments = [];
    meeting.asrQualityEvents = [];
    meeting.asrReconciliations = [];
    meeting.terminology = [];
    meeting.corrections = [];
    meeting.rejectedCorrections = 0;
    saveAndRender();
    assertMeetingRunCurrent(meeting, controller, meetingProcessingRuns, "Meeting processing was superseded");
    const transcription = await transcribeStoredBlob(
      meeting,
      blob,
      fileName,
      probedDuration,
      processingConfig,
      controller.signal,
    );
    assertMeetingRunCurrent(meeting, controller, meetingProcessingRuns, "Meeting processing was superseded");
    meeting.rawSegments = transcription.rawSegments;
    meeting.segments = transcription.segments;
    if (!meeting.segments.length) throw new Error("MiMo 没有返回可用的逐字稿");
    await enrichMeeting(meeting, processingConfig, controller);
  } finally {
    if (meetingProcessingRuns.get(meeting.id) === controller) meetingProcessingRuns.delete(meeting.id);
  }
}

async function transcribeStoredBlob(meeting, blob, fileName, probedDuration = audioDurationOrNull(meeting.duration), processingConfig = { ...state.config }, signal) {
  throwIfSignalAborted(signal);
  if (processingConfig.asrProtocol === "openai-transcriptions") {
    updateMeetingTaskProgress(meeting, "正在上传并转写音频");
    const result = await transcribeAudioWithRetry({ config: processingConfig, blob, fileName, language: meeting.language, signal });
    throwIfSignalAborted(signal);
    const rawSegments = normalizeSegments(result.segments, meeting.duration);
    const reconciled = reconcileTranscriptSegments(rawSegments);
    meeting.asrReconciliations = reconciled.reconciliations;
    return { rawSegments, segments: reconciled.segments };
  }
  const uploadError = mimoUploadLimitError(blob, probedDuration, processingConfig);
  if (uploadError) throw uploadError;
  try {
    return await transcribeStreamingBlob(meeting, blob, probedDuration, processingConfig, signal);
  } catch (error) {
    if (error.name === "AbortError" || error.name === "AudioLimitError" || !isStreamingAudioOpenError(error)) throw error;
    if (!canUseMimoWholeFileFallback({ size: blob.size, duration: probedDuration })) {
      throw new Error(`当前浏览器无法流式解码这段音频（${error.message}）。整文件兼容方式仅用于时长已知、不超过 ${Math.round(MAX_MIMO_FALLBACK_SECONDS / 60)} 分钟且不超过 ${Math.round(MAX_MIMO_FALLBACK_BYTES / 1024 / 1024)} MiB 的文件；请使用最新版 Chrome 或 Edge，或改用标准 Transcriptions 协议`);
    }
    updateMeetingTaskProgress(meeting, "正在使用兼容方式转写音频");
    const result = await transcribeAudioWithRetry({ config: processingConfig, blob, fileName, language: meeting.language, signal });
    throwIfSignalAborted(signal);
    requireTranscriptionQuality(result, meeting.duration, meeting);
    const rawSegments = normalizeSegments(result.segments, meeting.duration);
    const reconciled = reconcileTranscriptSegments(rawSegments);
    meeting.asrReconciliations = reconciled.reconciliations;
    return { rawSegments, segments: reconciled.segments };
  }
}

async function transcribeStreamingBlob(meeting, blob, probedDuration, processingConfig, signal) {
  throwIfSignalAborted(signal);
  const chunkSeconds = Math.max(15, Number(processingConfig.chunkSeconds) * 3);
  const decoder = await createStreamingAudioDecoder(blob, {
    chunkSeconds,
    maxDurationSeconds: MAX_MIMO_UPLOAD_SECONDS,
    signal,
  });
  const expectedDuration = audioDurationOrNull(decoder.durationSeconds) ?? audioDurationOrNull(probedDuration);
  if (expectedDuration !== null) meeting.duration = storedAudioDuration(expectedDuration);
  let completedSeconds = 0;
  try {
    const results = await mapAsyncIterableWithConcurrency(decoder, ASR_REQUEST_CONCURRENCY, async ({ pcm, startSeconds, durationSeconds }, index) => {
      throwIfSignalAborted(signal);
      let recovered;
      try {
        recovered = await transcribePcmAdaptively({
          pcm,
          sampleRate: decoder.sampleRate,
          startSeconds,
          transcribe: async ({ pcm: part, startSeconds, depth }) => {
            throwIfSignalAborted(signal);
            if (depth > 0) {
              updateMeetingTaskProgress(meeting, `异常片段细分复核 · ${formatTimestamp(startSeconds)}`);
            }
            return transcribeAudioWithRetry({
              config: processingConfig,
              blob: encodeWav(part, decoder.sampleRate),
              fileName: `part-${String(index).padStart(4, "0")}-${Math.round(startSeconds * 1_000)}.wav`,
              language: meeting.language,
              signal,
            });
          },
        });
      } catch (error) {
        meeting.asrQualityEvents.push(...(error.qualityEvents || []));
        throw error;
      }
      throwIfSignalAborted(signal);
      completedSeconds += durationSeconds;
      const progress = expectedDuration !== null
        ? `${Math.min(99, Math.round((completedSeconds / expectedDuration) * 100))}%`
        : `已完成 ${formatTimestamp(completedSeconds)}`;
      updateMeetingTaskProgress(meeting, `正在流式转写音频 · ${progress}`);
      return recovered;
    });
    throwIfSignalAborted(signal);
    meeting.duration = storedAudioDuration(
      audioDurationOrNull(decoder.durationSeconds)
      ?? audioDurationOrNull(decoder.processedEndSeconds)
      ?? expectedDuration,
    );
    const rawSegments = results.flatMap((result) => result?.rawSegments || []);
    meeting.asrQualityEvents.push(...results.flatMap((result) => result?.qualityEvents || []));
    const reconciled = reconcileTranscriptSegments(rawSegments);
    meeting.asrReconciliations = reconciled.reconciliations;
    return { rawSegments, segments: reconciled.segments };
  } finally {
    decoder.dispose();
  }
}

function requireTranscriptionQuality(result, duration, meeting) {
  const assessment = assessTranscriptionQuality(result, duration);
  if (assessment.ok || assessment.reasonCode === "empty_transcript") return;
  meeting.asrQualityEvents.push({
    start_seconds: 0,
    duration_seconds: storedAudioDuration(duration),
    reason_codes: assessment.reasonCodes,
    action: "rejected",
    metrics: assessment.metrics,
  });
  throw transcriptionQualityError(assessment, 0, duration);
}

function createMeetingAudioRangeTranscriber(meeting, processingConfig = state.config) {
  const asrConfig = { ...processingConfig };
  let previous = Promise.resolve();
  return (request) => {
    const task = previous.then(() => transcribeMeetingAudioRange(meeting, asrConfig, request));
    previous = task.catch(() => {});
    return task;
  };
}

async function transcribeMeetingAudioRange(meeting, asrConfig, { start_seconds: requestedStart, end_seconds: requestedEnd, signal }) {
  const start = Math.max(0, Number(requestedStart) || 0);
  const requestedEndSeconds = Math.max(0, Number(requestedEnd) || 0);
  const knownDuration = Number(meeting.duration) || 0;
  const end = knownDuration > 0 ? Math.min(knownDuration, requestedEndSeconds) : requestedEndSeconds;
  if (!(end > start) || end - start > 90) throw new Error("MiMo 复核音频范围必须大于 0 秒且不超过 90 秒");
  const record = await getRecording(meeting.id);
  if (!record?.blob) throw new Error("本机没有找到可供 MiMo 复核的录音");
  const decoder = await createStreamingAudioDecoder(record.blob, {
    chunkSeconds: Math.min(30, end - start),
    startSeconds: start,
    endSeconds: end,
    maxDurationSeconds: MAX_MIMO_UPLOAD_SECONDS,
    signal,
  });
  try {
    const results = await mapAsyncIterableWithConcurrency(decoder, 1, async ({ pcm, startSeconds }, index) => {
      const result = await transcribeAudioWithRetry({
        config: asrConfig,
        blob: encodeWav(pcm, decoder.sampleRate),
        fileName: `agent-review-${Math.round(startSeconds * 1_000)}-${String(index).padStart(2, "0")}.wav`,
        language: meeting.language,
        signal,
      });
      return {
        text: String(result.text || "").trim(),
        segments: (result.segments || []).map((segment) => ({
          start_seconds: startSeconds + Math.max(0, Number(segment.start_seconds) || 0),
          end_seconds: startSeconds + Math.max(0, Number(segment.end_seconds) || 0),
          text: String(segment.text || ""),
        })),
      };
    });
    const segments = results.flatMap((result) => result.segments).sort((left, right) => left.start_seconds - right.start_seconds);
    return { text: results.map((result) => result.text).filter(Boolean).join(" "), segments };
  } finally {
    decoder.dispose();
  }
}

function mimoUploadLimitError(blob, duration, processingConfig = state.config) {
  const message = mimoUploadLimitMessage({ protocol: processingConfig.asrProtocol, size: blob?.size, duration });
  return message ? new Error(message) : null;
}

async function enrichMeeting(meeting, processingConfig = { ...state.config }, existingController = null) {
  const controller = existingController || new AbortController();
  if (existingController) {
    assertMeetingRunCurrent(meeting, controller, meetingProcessingRuns, "Meeting enrichment was superseded");
  } else {
    meetingProcessingRuns.get(meeting.id)?.abort(new DOMException("Meeting processing superseded", "AbortError"));
    meetingProcessingRuns.set(meeting.id, controller);
  }
  try {
    await enrichMeetingRun(meeting, { ...processingConfig }, controller.signal);
  } finally {
    if (!existingController && meetingProcessingRuns.get(meeting.id) === controller) meetingProcessingRuns.delete(meeting.id);
  }
}

async function enrichMeetingRun(meeting, processingConfig, signal) {
  meeting.status = "correcting";
  delete meeting.processingDetail;
  resetCorrectionResult(meeting);
  saveAndRender();
  try {
    const corrected = await correctTranscript({
      config: processingConfig,
      meeting,
      signal,
      transcribeAudioRange: createMeetingAudioRangeTranscriber(meeting, processingConfig),
    });
    meeting.segments = corrected.segments;
    meeting.terminology = corrected.terminology;
    meeting.rejectedCorrections = corrected.rejectedCorrections;
    meeting.semanticJoins = corrected.semanticJoins;
    meeting.corrections = corrected.corrections;
    if (corrected.agentRun) meeting.agentRun = corrected.agentRun;
  } catch (error) {
    if (signal.aborted) return;
    meeting.correctionError = error.message;
    if (Array.isArray(error.agentTrace)) {
      meeting.agentRun = {
        id: error.agentTrace[0]?.run_id || "",
        profile: "terminology-supervisor",
        model: processingConfig.chatModel,
        status: "failed",
        usage: error.agentUsage || {},
        trace: error.agentTrace,
      };
    }
    const reconciled = reconcileTranscriptSegments(meeting.rawSegments || []);
    meeting.segments = reconciled.segments;
    meeting.asrReconciliations = reconciled.reconciliations;
    meeting.terminology = [];
    meeting.corrections = [];
    meeting.rejectedCorrections = 0;
    meeting.semanticJoins = 0;
  }

  if (signal.aborted || !state.meetings.some((item) => item.id === meeting.id)) return;

  meeting.status = "summarizing";
  resetSummaryResult(meeting);
  saveAndRender();
  try {
    const summary = await summarizeTranscript({ config: processingConfig, meeting, signal });
    applySummaryResult(meeting, summary);
  } catch (error) {
    if (signal.aborted) return;
    meeting.summaryError = error.message;
    recordFailedAnalysisRun(meeting, error, processingConfig);
  }
  if (signal.aborted || !state.meetings.some((item) => item.id === meeting.id)) return;
  meeting.status = "done";
  delete meeting.processingDetail;
  saveAndRender();
  showToast(meeting.correctionError || meeting.summaryError ? "转写已保存，部分 GPT 处理未完成" : (meeting.mode === "interview" ? "逐字稿已校正，面试证据已整理" : "逐字稿已校正，智能纪要已生成"));
}

function handleInsightAction(event) {
  const button = event.target.closest("[data-retry-insight]");
  if (!button || button.getAttribute("aria-disabled") === "true") return;
  retryInsightProcessing(button.dataset.retryInsight);
}

async function retryInsightProcessing(step) {
  const meeting = activeMeeting();
  if (!meeting || meeting.readOnly || !["correction", "summary"].includes(step) || isRunningTask(meeting)) return;
  if (!requireChatConfig()) return;
  const retryConfig = { ...state.config };
  questionRuns.get(meeting.id)?.abort(new DOMException("Meeting retry superseded question", "AbortError"));
  meetingProcessingRuns.get(meeting.id)?.abort(new DOMException("Meeting retry superseded", "AbortError"));
  const controller = new AbortController();
  meetingProcessingRuns.set(meeting.id, controller);
  insightRetryRuns.set(meeting.id, step);
  render();
  focusInsightRetryButton(meeting.id, step);
  let succeeded = false;
  let downstreamError = null;
  let requestError = null;
  try {
    if (step === "correction") {
      const previousTranscript = transcriptContentSignature(meeting.segments);
      const corrected = await correctTranscript({
        config: retryConfig,
        meeting,
        signal: controller.signal,
        transcribeAudioRange: createMeetingAudioRangeTranscriber(meeting, retryConfig),
      });
      const stagedMeeting = {
        ...meetingRetrySnapshot(meeting),
        segments: corrected.segments,
        terminology: corrected.terminology,
        rejectedCorrections: corrected.rejectedCorrections,
        semanticJoins: corrected.semanticJoins,
        corrections: corrected.corrections,
        correctionError: "",
      };
      if (corrected.agentRun) stagedMeeting.agentRun = corrected.agentRun;
      else delete stagedMeeting.agentRun;
      if (transcriptContentSignature(corrected.segments) !== previousTranscript) {
        stagedMeeting.qa = [];
        resetSummaryResult(stagedMeeting);
        try {
          const summary = await summarizeTranscript({ config: retryConfig, meeting: stagedMeeting, signal: controller.signal });
          applySummaryResult(stagedMeeting, summary);
        } catch (error) {
          if (controller.signal.aborted) throw error;
          stagedMeeting.summaryError = error.message;
          recordFailedAnalysisRun(stagedMeeting, error, retryConfig);
          downstreamError = error;
        }
      }
      commitMeetingSnapshot(meeting, stagedMeeting);
    } else {
      const stagedMeeting = meetingRetrySnapshot(meeting);
      resetSummaryResult(stagedMeeting);
      const summary = await summarizeTranscript({ config: retryConfig, meeting: stagedMeeting, signal: controller.signal });
      if (controller.signal.aborted || meetingProcessingRuns.get(meeting.id) !== controller) {
        throw controller.signal.reason || new DOMException("Meeting retry superseded", "AbortError");
      }
      applySummaryResult(stagedMeeting, summary);
      commitMeetingSnapshot(meeting, stagedMeeting);
    }
    succeeded = true;
  } catch (error) {
    if (controller.signal.aborted) return;
    if (step === "correction") {
      meeting.correctionError = error.message;
      if (Array.isArray(error.agentTrace)) {
        meeting.agentRun = {
          id: error.agentTrace[0]?.run_id || "",
          profile: "terminology-supervisor",
          model: retryConfig.chatModel,
          status: "failed",
          usage: error.agentUsage || {},
          trace: error.agentTrace,
        };
      }
    }
    else meeting.summaryError = error.message;
    if (step === "summary") recordFailedAnalysisRun(meeting, error, retryConfig);
    requestError = error;
  } finally {
    if (meetingProcessingRuns.get(meeting.id) === controller) meetingProcessingRuns.delete(meeting.id);
    saveMeetings();
    insightRetryRuns.delete(meeting.id);
    render();
  }
  if (requestError) {
    focusInsightRetryButton(meeting.id, step);
    showToast(`${step === "correction" ? "逐字稿校正" : (meeting.mode === "interview" ? "面试证据整理" : "智能纪要生成")}仍未完成：${requestError.message}`, true);
  } else if (downstreamError) {
    focusInsightRetryButton(meeting.id, "summary");
    showToast(`逐字稿校正已完成，但智能纪要刷新失败：${downstreamError.message}`, true);
  } else if (succeeded) {
    showToast(step === "correction" ? "逐字稿校正及相关纪要已更新" : (meeting.mode === "interview" ? "面试证据已重新整理" : "智能纪要已重新生成"));
  }
}

function applySummaryResult(meeting, summary) {
  for (const field of ["summary", "keywords", "highlights", "speaker_summaries", "decisions", "decision_records", "action_items"]) {
    if (Object.hasOwn(summary, field)) meeting[field] = summary[field];
  }
  if (meeting.autoTitle && summary.title) meeting.title = summary.title.slice(0, 120);
  if (summary.interviewReport) meeting.interviewReport = summary.interviewReport;
  else delete meeting.interviewReport;
  if (summary.analysisRun) meeting.analysisRun = summary.analysisRun;
  else delete meeting.analysisRun;
  meeting.summaryError = "";
}

function recordFailedAnalysisRun(meeting, error, config) {
  if (!Array.isArray(error?.agentTrace)) return;
  meeting.analysisRun = {
    id: error.agentTrace[0]?.run_id || "",
    profile: "meeting-analysis",
    model: config.chatModel,
    status: "failed",
    usage: error.agentUsage || {},
    trace: error.agentTrace,
  };
}

function resetCorrectionResult(meeting) {
  meeting.correctionError = "";
  meeting.terminology = [];
  meeting.rejectedCorrections = 0;
  meeting.semanticJoins = 0;
  meeting.corrections = [];
  delete meeting.agentRun;
}

function resetSummaryResult(meeting) {
  meeting.summary = "";
  meeting.keywords = [];
  meeting.highlights = [];
  meeting.speaker_summaries = [];
  meeting.decisions = [];
  meeting.decision_records = [];
  meeting.action_items = [];
  meeting.summaryError = "";
  delete meeting.interviewReport;
  delete meeting.analysisRun;
}

function transcriptContentSignature(segments) {
  return JSON.stringify((segments || []).map((segment) => [segment.start_seconds, segment.end_seconds, segment.speaker, segment.text, segment.join_next === true]));
}

function meetingRetrySnapshot({ asking: _asking, ...meeting }) {
  return {
    ...meeting,
    qa: Array.isArray(meeting.qa)
      ? meeting.qa.filter((entry) => entry?.pending !== true).map((entry) => ({ ...entry }))
      : [],
  };
}

function commitMeetingSnapshot(meeting, snapshot) {
  for (const key of Object.keys(meeting)) {
    if (!Object.hasOwn(snapshot, key)) delete meeting[key];
  }
  Object.assign(meeting, snapshot);
}

function focusInsightRetryButton(meetingId, step) {
  if (activeMeeting()?.id !== meetingId) return;
  elements.insightContent.querySelector(`[data-retry-insight="${step}"]`)?.focus();
}

async function retryActiveMeeting() {
  const meeting = activeMeeting();
  if (isMeetingDeleting(meeting)) return;
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
  const processingConfig = { ...state.config };
  meetingProcessingRuns.get(meeting.id)?.abort(new DOMException("Meeting retry superseded", "AbortError"));
  const controller = new AbortController();
  meetingProcessingRuns.set(meeting.id, controller);
  meeting.status = "transcribing";
  meeting.processingDetail = "正在读取本机录音";
  meeting.error = "";
  saveAndRender();
  try {
    const record = await getRecording(meeting.id);
    assertMeetingRunCurrent(meeting, controller, meetingProcessingRuns, "Meeting retry was superseded");
    if (!record?.blob) throw new Error("本机没有找到这段录音，请重新上传");
    const probedDuration = await probeDuration(record.blob).catch(() => null);
    assertMeetingRunCurrent(meeting, controller, meetingProcessingRuns, "Meeting retry was superseded");
    const previousDuration = audioDurationOrNull(meeting.duration);
    const knownDuration = audioDurationOrNull(probedDuration) ?? (previousDuration > 0 ? previousDuration : null);
    meeting.duration = storedAudioDuration(knownDuration);
    await processStoredAudio(
      meeting,
      record.blob,
      record.fileName || meeting.sourceName || "audio.webm",
      knownDuration,
      processingConfig,
      controller,
    );
  } catch (error) {
    if (controller.signal.aborted || meetingDeletionWasRecorded(meeting.id) || !state.meetings.includes(meeting)) {
      await cleanupDeletedMeetingAudio(meeting.id);
      return;
    }
    failMeeting(meeting, error);
  } finally {
    if (meetingProcessingRuns.get(meeting.id) === controller) meetingProcessingRuns.delete(meeting.id);
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
      status: "recording", rawSegments: [], segments: [], recordingSessionId: crypto.randomUUID(), recordingHeartbeat: Date.now(), recordingChunkCount: 0, recordingObservedChunkCount: 0, recordingStopped: false,
    });
    sessionStorage.setItem(ACTIVE_RECORDING_SESSION_KEY, meeting.recordingSessionId);
    const recorder = {
      meeting, stream, audioContext, source, processor, mediaRecorder, mediaChunkCount: 0, persistedMediaChunkCount: 0, persistedChunkIndexes: new Set(),
      config: { ...state.config },
      pendingPcm: [], pendingSamples: 0, processedSamples: 0, sampleRate: audioContext.sampleRate,
      startedAt: performance.now(), queue: Promise.resolve(), persistQueue: Promise.resolve(), pendingRequests: 0, queuedLiveChunks: 0,
      errors: [], liveReplayRequired: false, persistenceErrors: [], failedPersistence: [], silentChunks: 0, closing: false, stopped: false, finalizing: false, lastHeartbeatAt: 0,
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
  if (recorder.transcriptionEnabled && !recorder.liveReplayRequired) {
    recorder.pendingPcm.push(mono);
    recorder.pendingSamples += mono.length;
    if (recorder.pendingSamples >= Number(recorder.config.chunkSeconds) * recorder.sampleRate) flushLiveChunk(recorder);
  }
  if ((performance.now() - recorder.startedAt) / 1000 >= MAX_RECORDING_SECONDS) stopRecording();
}

function flushLiveChunk(recorder) {
  if (!recorder.transcriptionEnabled || !recorder.pendingSamples) return;
  if (recorder.liveReplayRequired) {
    recorder.processedSamples += recorder.pendingSamples;
    recorder.pendingPcm = [];
    recorder.pendingSamples = 0;
    return;
  }
  if (recorder.queuedLiveChunks >= MAX_LIVE_ASR_BUFFERED_CHUNKS) {
    recorder.processedSamples += recorder.pendingSamples;
    recorder.pendingPcm = [];
    recorder.pendingSamples = 0;
    recorder.liveReplayRequired = true;
    recorder.errors.push("实时转写速度落后，结束后将从本机录音补全");
    renderLiveStatus();
    return;
  }
  const pcm = concatenatePcm(recorder.pendingPcm, recorder.pendingSamples);
  const start = recorder.processedSamples / recorder.sampleRate;
  recorder.processedSamples += recorder.pendingSamples;
  recorder.pendingPcm = [];
  recorder.pendingSamples = 0;
  const chunkNumber = Math.round(start / Math.max(1, Number(recorder.config.chunkSeconds)));
  const chunk = {
    chunkNumber,
    start,
    duration: pcm.length / recorder.sampleRate,
    sampleRate: 16000,
    pcm: resample(pcm, recorder.sampleRate, 16000),
  };
  recorder.queuedLiveChunks += 1;
  recorder.queue = recorder.queue.then(async () => {
    recorder.pendingRequests += 1;
    renderLiveStatus();
    try {
      await transcribeLiveChunk(recorder, chunk);
    } catch (error) {
      recorder.errors.push(error.message);
      recorder.liveReplayRequired = true;
    } finally {
      recorder.pendingRequests -= 1;
      recorder.queuedLiveChunks -= 1;
      renderLiveStatus();
    }
  });
}

function persistMediaChunk(recorder, blob) {
  if (!blob?.size) return;
  const chunk = { index: recorder.mediaChunkCount, blob };
  recorder.mediaChunkCount += 1;
  recorder.meeting.recordingObservedChunkCount = recorder.mediaChunkCount;
  saveMeetings();
  recorder.persistQueue = recorder.persistQueue.then(async () => {
    try {
      await saveRecordingChunk(recorder.meeting.id, chunk.index, chunk.blob, {
        fileName: recorder.meeting.sourceName,
        mimeType: blob.type || recorder.meeting.sourceType,
      });
      markMediaChunkPersisted(recorder, chunk.index);
    } catch (error) {
      recorder.failedPersistence.push(chunk);
      recorder.persistenceErrors.push(error.message);
      recorder.meeting.recordingPersistenceFailed = true;
      saveMeetings();
    }
  });
}

function markMediaChunkPersisted(recorder, chunkIndex) {
  recorder.persistedChunkIndexes.add(chunkIndex);
  while (recorder.persistedChunkIndexes.has(recorder.persistedMediaChunkCount)) {
    recorder.persistedMediaChunkCount += 1;
  }
  recorder.meeting.recordingChunkCount = recorder.persistedMediaChunkCount;
  saveMeetings();
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
      markMediaChunkPersisted(recorder, chunk.index);
    } catch (error) {
      recorder.failedPersistence.push(chunk);
      recorder.persistenceErrors.push(error.message);
    }
  }
  recorder.meeting.recordingPersistenceFailed = recorder.failedPersistence.length > 0;
  saveMeetings();
}

async function transcribeLiveChunk(recorder, chunk) {
  recorder.meeting.asrQualityEvents ||= [];
  recorder.meeting.asrReconciliations ||= [];
  let result;
  try {
    result = await transcribePcmAdaptively({
      pcm: chunk.pcm,
      sampleRate: chunk.sampleRate,
      startSeconds: chunk.start,
      transcribe: ({ pcm, startSeconds }) => transcribeAudioWithRetry({
        config: recorder.config,
        blob: encodeWav(pcm, chunk.sampleRate),
        fileName: `live-${String(chunk.chunkNumber).padStart(4, "0")}-${Math.round(startSeconds * 1_000)}.wav`,
        language: recorder.meeting.language,
      }),
    });
  } catch (error) {
    recorder.meeting.asrQualityEvents.push(...(error.qualityEvents || []));
    throw error;
  }
  recorder.meeting.asrQualityEvents.push(...result.qualityEvents);
  if (!result.rawSegments.length) {
    recorder.silentChunks += 1;
    return;
  }
  recorder.meeting.rawSegments = [
    ...recorder.meeting.rawSegments,
    ...result.rawSegments,
  ].sort((left, right) => left.start_seconds - right.start_seconds);
  const combined = reconcileTranscriptSegments([
    ...recorder.meeting.rawSegments,
  ]);
  recorder.meeting.segments = combined.segments.map((segment) => ({ ...segment }));
  recorder.meeting.asrReconciliations = combined.reconciliations;
  saveMeetings();
  if (state.activeId === recorder.meeting.id) {
    renderTranscript(recorder.meeting);
    renderHeader(recorder.meeting);
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
  const finalizationController = recorder.transcriptionEnabled ? new AbortController() : null;
  if (finalizationController) {
    meetingProcessingRuns.get(meeting.id)?.abort(new DOMException("Meeting processing superseded", "AbortError"));
    meetingProcessingRuns.set(meeting.id, finalizationController);
  }
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
    delete meeting.recordingObservedChunkCount;
    delete meeting.recordingPersistenceFailed;
    delete meeting.recordingStopped;
    sessionStorage.removeItem(ACTIVE_RECORDING_SESSION_KEY);
    if (state.recorder === recorder) state.recorder = null;
    saveAndRender();
    if (!recorder.transcriptionEnabled) {
      showToast("录音已保存在本机，可直接播放或导出");
      return;
    }
    await recorder.queue;
    if (finalizationController) {
      assertMeetingRunCurrent(meeting, finalizationController, meetingProcessingRuns, "Recording finalization was superseded");
    }
    if (recorder.liveReplayRequired) {
      meeting.processingDetail = "正在从本机录音补全逐字稿";
      meeting.rawSegments = [];
      meeting.segments = [];
      meeting.asrQualityEvents = [];
      meeting.asrReconciliations = [];
      saveAndRender();
      assertMeetingRunCurrent(meeting, finalizationController, meetingProcessingRuns, "Recording replay was superseded");
      const transcription = await transcribeStoredBlob(
        meeting,
        blob,
        meeting.sourceName,
        audioDurationOrNull(meeting.duration),
        recorder.config,
        finalizationController.signal,
      );
      assertMeetingRunCurrent(meeting, finalizationController, meetingProcessingRuns, "Recording replay was superseded");
      meeting.rawSegments = transcription.rawSegments;
      meeting.segments = transcription.segments;
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
    const reconciled = reconcileTranscriptSegments(meeting.rawSegments);
    meeting.segments = reconciled.segments;
    meeting.asrReconciliations = reconciled.reconciliations;
    await enrichMeeting(meeting, recorder.config, finalizationController);
    if (finalizationController) {
      assertMeetingRunCurrent(meeting, finalizationController, meetingProcessingRuns, "Recording finalization was superseded");
    }
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
    if (finalizationController && meetingProcessingRuns.get(meeting.id) === finalizationController) meetingProcessingRuns.delete(meeting.id);
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
  meeting.duration = storedAudioDuration(meeting.duration);
  state.meetings.unshift(meeting);
  const removed = state.meetings.slice(MAX_MEETINGS);
  state.meetings = state.meetings.slice(0, MAX_MEETINGS);
  for (const item of removed) {
    try {
      rememberMeetingDeletion(item.id);
      purgeTombstonedMeetingsFromStorage();
      deleteRecording(item.id).then(() => markMeetingDeletionComplete(item.id)).catch(() => {});
    } catch {
      showToast("旧记录的安全清理状态未能保存，请先导出并删除不再需要的记录", true);
    }
  }
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
  delete meeting.processingDetail;
  saveAndRender();
  showToast(meeting.error, true);
}

function newMeeting() {
  if (state.recording || state.sharedMode) return;
  const runningMeeting = state.meetings.find((meeting) => isRunningTask(meeting));
  if (runningMeeting) {
    state.activeId = runningMeeting.id;
    render();
    showToast("当前任务仍在处理，请等待完成后再新建记录", true);
    return;
  }
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
  if (!meeting || deletingMeetingIds.has(id)) return;
  if (isRunningTask(meeting)) {
    showToast("当前任务仍在处理，完成后再删除", true);
    return;
  }
  const latestStoredMeeting = storedMeeting(id);
  if (latestStoredMeeting && ACTIVE_TASK_STATUSES.has(latestStoredMeeting.status)) {
    showToast("另一个标签页仍在处理这条记录，完成后再删除", true);
    synchronizeMeetingsFromStorage();
    return;
  }
  if (!window.confirm(`删除“${meeting.title}”及保存在本机的录音？此操作无法撤销。`)) return;
  deletingMeetingIds.add(id);
  invalidateShareGenerationForMeeting(id);
  meetingProcessingRuns.get(id)?.abort(new DOMException("Meeting deleted", "AbortError"));
  recordingRecoveryRuns.get(id)?.abort(new DOMException("Meeting deleted", "AbortError"));
  questionRuns.get(id)?.abort(new DOMException("Meeting deleted", "AbortError"));
  render();
  let tombstoneAdded = false;
  try {
    tombstoneAdded = rememberMeetingDeletion(id);
    if (!purgeTombstonedMeetingsFromStorage()) throw new Error("无法从浏览器本地存储删除逐字稿，请释放空间后重试");
    await deleteRecording(id);
    markMeetingDeletionComplete(id);
    state.meetings = state.meetings.filter((item) => item.id !== id);
    if (state.activeId === id) state.activeId = state.meetings[0]?.id || null;
    saveMeetings();
    showToast("记录和本地录音已删除");
  } catch (error) {
    if (tombstoneAdded) forgetMeetingDeletion(id);
    saveMeetings();
    showToast(`删除失败：${error.message}`, true);
  } finally {
    deletingMeetingIds.delete(id);
    applyMeetingTombstonesToState();
    render();
  }
}

async function handleQuestion(event) {
  if (event.target.id !== "qaForm") return;
  event.preventDefault();
  const meeting = activeMeeting();
  const input = event.target.querySelector("#questionInput");
  const question = input.value.trim();
  if (!meeting || !question || meeting.asking || isRunningTask(meeting) || !requireConfig()) return;
  const meetingId = meeting.id;
  const sourceSignature = transcriptContentSignature(meeting.segments);
  const controller = new AbortController();
  questionRuns.get(meetingId)?.abort(new DOMException("Question superseded", "AbortError"));
  questionRuns.set(meetingId, controller);
  const meetingSnapshot = {
    ...meeting,
    segments: (meeting.segments || []).map((segment) => ({ ...segment })),
  };
  const questionConfig = { ...state.config };
  const pendingQuestion = { role: "user", content: question, pending: true };
  let settled = false;
  meeting.qa ||= [];
  meeting.qa.push(pendingQuestion);
  meeting.asking = true;
  saveAndRender();
  try {
    const answer = await askTranscript({ config: questionConfig, meeting: meetingSnapshot, question, signal: controller.signal });
    const current = state.meetings.find((item) => item.id === meetingId);
    if (
      questionRuns.get(meetingId) !== controller
      || !current
      || transcriptContentSignature(current.segments) !== sourceSignature
      || isRunningTask(current)
    ) return;
    current.qa ||= [];
    delete pendingQuestion.pending;
    current.qa.push({ role: "assistant", content: answer });
    settled = true;
  } catch (error) {
    if (controller.signal.aborted) return;
    const current = state.meetings.find((item) => item.id === meetingId);
    if (!current || transcriptContentSignature(current.segments) !== sourceSignature || isRunningTask(current)) return;
    current.qa ||= [];
    delete pendingQuestion.pending;
    current.qa.push({ role: "assistant", content: `回答失败：${error.message}` });
    settled = true;
  } finally {
    const ownsRun = questionRuns.get(meetingId) === controller;
    if (ownsRun) questionRuns.delete(meetingId);
    const current = state.meetings.find((item) => item.id === meetingId);
    const retryStep = insightRetryRuns.get(meetingId);
    if (current && ownsRun) {
      current.asking = false;
      if (!settled && Array.isArray(current.qa)) current.qa = current.qa.filter((entry) => entry !== pendingQuestion);
    }
    saveAndRender();
    if (retryStep) focusInsightRetryButton(meetingId, retryStep);
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
  if (meeting && !meeting.readOnly && !insightRetryInProgress(meeting) && !isMeetingDeleting(meeting)) {
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
  if (meeting && !meeting.readOnly && !insightRetryInProgress(meeting) && !isMeetingDeleting(meeting)) { meeting.title = "未命名记录"; saveMeetings(); renderHistory(); }
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

function requireChatConfig() {
  if (state.config.chatBaseUrl && state.config.chatApiKey) return true;
  openSettings();
  showToast("请先配置 GPT API", true);
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
  if (blockDerivedContentAction(meeting, "生成分享链接")) return;
  const snapshot = createShareGenerationSnapshot(meeting);
  shareGenerationRuns.ready = null;
  elements.shareUrlInput.value = "正在生成…";
  elements.shareHint.textContent = "";
  if (!elements.shareDialog.open) elements.shareDialog.showModal();
  try {
    const url = await buildShareUrl(meeting, snapshot);
    if (!shareGenerationMatchesActiveMeeting(snapshot)) return;
    shareGenerationRuns.ready = shareGenerationIdentity(snapshot);
    elements.shareUrlInput.value = url;
    elements.shareHint.textContent = url.length > 60000 ? "逐字稿较长，部分聊天软件或浏览器可能截断链接；建议改用离线网页。" : "任何拿到链接的人都能查看这份逐字稿。";
  } catch (error) {
    if (error?.code === "stale_share_generation") {
      if (shareGenerationRuns.token === snapshot.token && activeMeeting()?.id === snapshot.meetingId) {
        elements.shareUrlInput.value = "";
        elements.shareHint.textContent = "逐字稿或纪要已更新，请重新生成分享链接。";
      }
      return;
    }
    if (!shareGenerationMatchesActiveMeeting(snapshot)) return;
    elements.shareUrlInput.value = "";
    elements.shareHint.textContent = error.message;
  }
  refreshIcons();
}

async function buildShareUrl(meeting, snapshot) {
  if (!shareGenerationMatchesMeeting(snapshot, meeting)) throw staleShareGenerationError();
  const bytes = new TextEncoder().encode(snapshot.sourceSignature);
  let prefix = "j.";
  let output = bytes;
  if (typeof CompressionStream !== "undefined") {
    output = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
    prefix = "g.";
  }
  if (!shareGenerationMatchesActiveMeeting(snapshot)) throw staleShareGenerationError();
  const base = `${location.origin}${location.pathname}${location.search}`;
  return `${base}#share=${prefix}${bytesToBase64Url(output)}`;
}

function createShareGenerationSnapshot(meeting) {
  shareGenerationRuns.meetingId = meeting.id;
  return {
    token: ++shareGenerationRuns.token,
    meetingId: meeting.id,
    transcriptSignature: transcriptContentSignature(meeting.segments),
    sourceSignature: JSON.stringify(publicMeeting(meeting)),
  };
}

function invalidateShareGenerationForMeeting(meetingId) {
  if (shareGenerationRuns.meetingId !== meetingId) return;
  shareGenerationRuns.token += 1;
  shareGenerationRuns.meetingId = null;
  shareGenerationRuns.ready = null;
  elements.shareUrlInput.value = "";
  elements.shareHint.textContent = "";
  if (elements.shareDialog.open) elements.shareDialog.close();
}

function shareGenerationIdentity(snapshot) {
  return {
    token: snapshot.token,
    meetingId: snapshot.meetingId,
    transcriptSignature: snapshot.transcriptSignature,
    sourceSignature: snapshot.sourceSignature,
  };
}

function shareGenerationMatchesMeeting(snapshot, meeting) {
  return Boolean(
    snapshot
    && meeting?.id === snapshot.meetingId
    && transcriptContentSignature(meeting.segments) === snapshot.transcriptSignature
    && JSON.stringify(publicMeeting(meeting)) === snapshot.sourceSignature
    && !insightRetryInProgress(meeting)
    && !isMeetingDeleting(meeting)
  );
}

function shareGenerationMatchesActiveMeeting(snapshot) {
  return shareGenerationRuns.token === snapshot?.token
    && shareGenerationMatchesMeeting(snapshot, activeMeeting());
}

function staleShareGenerationError() {
  const error = new Error("分享内容已变化");
  error.code = "stale_share_generation";
  return error;
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
  const meeting = activeMeeting();
  if (blockDerivedContentAction(meeting, "复制分享链接")) return;
  if (!elements.shareUrlInput.value || elements.shareUrlInput.value === "正在生成…") return;
  if (!shareGenerationMatchesActiveMeeting(shareGenerationRuns.ready)) {
    elements.shareUrlInput.value = "";
    elements.shareHint.textContent = "逐字稿或纪要已更新，请重新生成分享链接。";
    showToast("分享内容已更新，请重新生成链接", true);
    return;
  }
  try { await navigator.clipboard.writeText(elements.shareUrlInput.value); showToast("分享链接已复制"); }
  catch { showToast("浏览器未允许复制，请手动选择链接", true); }
}

function downloadShareHtml() {
  const meeting = activeMeeting();
  if (!meeting || blockDerivedContentAction(meeting, "导出分享网页")) return false;
  downloadBlob(new Blob([buildShareHtml(meeting)], { type: "text/html;charset=utf-8" }), `${safeFilename(meeting.title)}-分享稿.html`);
  showToast("离线分享网页已下载");
  return true;
}

async function copyTranscript() {
  const meeting = activeMeeting();
  if (!meeting?.segments?.length) return;
  if (blockDerivedContentAction(meeting, "复制逐字稿")) return;
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
  if (button.dataset.export !== "audio" && blockDerivedContentAction(meeting, "导出逐字稿或纪要")) return;
  if (button.dataset.export === "audio") {
    const record = await getRecording(meeting.id).catch(() => null);
    if (!record?.blob) { showToast("分享稿不包含原始录音", true); return; }
    downloadBlob(record.blob, record.fileName || `${name}.${extensionForMime(record.mimeType)}`);
  } else if (button.dataset.export === "markdown") downloadBlob(new Blob([toMarkdown(meeting)], { type: "text/markdown;charset=utf-8" }), `${name}.md`);
  else if (button.dataset.export === "vtt") downloadBlob(new Blob([toVtt(meeting)], { type: "text/vtt;charset=utf-8" }), `${name}.vtt`);
  else if (button.dataset.export === "json") downloadBlob(new Blob([JSON.stringify(publicMeeting(meeting), null, 2)], { type: "application/json;charset=utf-8" }), `${name}.json`);
  else if (button.dataset.export === "html") { downloadShareHtml(); return; }
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
  else if (recorder.liveReplayRequired) elements.liveStatus.textContent = "实时转写已暂停，结束后将从本机录音补全";
  else if (recorder.pendingRequests) elements.liveStatus.textContent = "正在转写当前片段";
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
  return (segments || []).map((segment, index) => {
    const start = Math.max(0, Number(segment.start_seconds) || 0);
    const explicitEnd = Number(segment.end_seconds);
    const hasExplicitTiming = segment.timing_source === "provider"
      || (segment.timing_source == null && Number.isFinite(explicitEnd) && explicitEnd > start);
    return {
      ...segment,
      start_seconds: start,
      end_seconds: Math.max(0, explicitEnd || (index === segments.length - 1 ? duration : 0)),
      timing_source: hasExplicitTiming ? "provider" : "inferred",
      speaker: String(segment.speaker || "发言人 1"),
      text: String(segment.text || "").trim(),
    };
  }).filter((segment) => segment.text);
}

function activeMeeting() { return state.meetings.find((meeting) => meeting.id === state.activeId) || null; }

function saveAndRender() { saveMeetings(); render(); }

function updateMeetingTaskProgress(meeting, detail) {
  meeting.processingDetail = detail;
  saveMeetings();
  if (activeMeeting()?.id !== meeting.id) return;
  renderHeader(meeting);
  if (!elements.processingStage.classList.contains("hidden")) elements.processingFile.textContent = processingDisplayText(meeting);
}

function processingDisplayText(meeting) {
  return [meeting?.sourceName, meeting?.processingDetail].filter(Boolean).join(" · ") || "正在处理音频";
}

function isRunningTask(meeting) {
  return Boolean(meeting && (ACTIVE_TASK_STATUSES.has(meeting.status) || insightRetryRuns.has(meeting.id) || deletingMeetingIds.has(meeting.id)));
}

function assertMeetingRunCurrent(meeting, controller, registry, message) {
  if (
    controller.signal.aborted
    || meetingDeletionWasRecorded(meeting.id)
    || !state.meetings.includes(meeting)
    || registry.get(meeting.id) !== controller
  ) {
    throw controller.signal.reason || new DOMException(message, "AbortError");
  }
}

function throwIfSignalAborted(signal) {
  if (signal?.aborted) throw signal.reason || new DOMException("Operation aborted", "AbortError");
}

function isMeetingDeleting(meeting) {
  return Boolean(meeting?.id && deletingMeetingIds.has(meeting.id));
}

function insightRetryInProgress(meeting) {
  return Boolean(meeting?.id && insightRetryRuns.has(meeting.id));
}

function blockDerivedContentAction(meeting, action) {
  if (isMeetingDeleting(meeting)) {
    showToast(`正在删除记录，无法${action}`, true);
    return true;
  }
  if (!insightRetryInProgress(meeting)) return false;
  showToast(`Agent 正在更新内容，完成后再${action}`, true);
  return true;
}

function hasRunningTask() {
  return Boolean(state.recorder) || state.meetings.some((meeting) => isRunningTask(meeting));
}

function loadMeetings() {
  try {
    const parsed = JSON.parse(localStorage.getItem(MEETINGS_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((meeting) => !meetingDeletionWasRecorded(meeting?.id)).slice(0, MAX_MEETINGS).map((meeting) => {
      const normalized = {
        ...meeting,
        qa: Array.isArray(meeting.qa) ? meeting.qa.filter((entry) => entry?.pending !== true) : [],
        duration: storedAudioDuration(meeting.duration),
      };
      return ["transcribing", "correcting", "summarizing"].includes(meeting.status)
        ? { ...normalized, status: "error", error: "上次处理被页面关闭中断，可从本地录音重新转写。" }
        : normalized;
    });
  } catch { return []; }
}

function saveMeetings() {
  if (state.sharedMode) return;
  const removedTombstonedMeeting = applyMeetingTombstonesToState();
  try {
    const meetings = state.meetings
      .filter((meeting) => !meetingDeletionWasRecorded(meeting.id))
      .slice(0, MAX_MEETINGS)
      .map(persistableMeeting);
    localStorage.setItem(MEETINGS_KEY, JSON.stringify(meetings));
    purgeTombstonedMeetingsFromStorage();
  } catch { showToast("本地逐字稿存储空间已满，请先导出并删除旧记录", true); }
  if (removedTombstonedMeeting) render();
}

function meetingTombstoneKey(id) {
  return `${MEETING_TOMBSTONE_PREFIX}${String(id || "")}`;
}

function meetingDeletionWasRecorded(id) {
  try { return Boolean(id && localStorage.getItem(meetingTombstoneKey(id)) !== null); }
  catch { return false; }
}

function rememberMeetingDeletion(id) {
  const key = meetingTombstoneKey(id);
  if (localStorage.getItem(key) !== null) return false;
  try {
    localStorage.setItem(key, "pending");
    return true;
  } catch {
    throw new Error("无法记录跨标签页删除状态，请释放浏览器本地存储空间后重试");
  }
}

function markMeetingDeletionComplete(id) {
  try {
    const key = meetingTombstoneKey(id);
    if (localStorage.getItem(key) !== null) localStorage.setItem(key, "deleted");
  } catch { /* pending tombstones are retried on startup */ }
}

function forgetMeetingDeletion(id) {
  try {
    const key = meetingTombstoneKey(id);
    if (localStorage.getItem(key) === "pending") localStorage.removeItem(key);
  } catch { /* localStorage removal is best effort */ }
}

function tombstonedMeetingIds({ pendingOnly = false } = {}) {
  const ids = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key?.startsWith(MEETING_TOMBSTONE_PREFIX)) continue;
    if (pendingOnly && localStorage.getItem(key) !== "pending") continue;
    const id = key.slice(MEETING_TOMBSTONE_PREFIX.length);
    if (id) ids.push(id);
  }
  return ids;
}

function applyMeetingTombstonesToState() {
  const removedIds = state.meetings
    .filter((meeting) => meetingDeletionWasRecorded(meeting.id) && !deletingMeetingIds.has(meeting.id))
    .map((meeting) => meeting.id);
  if (!removedIds.length) return false;
  const removed = new Set(removedIds);
  for (const id of removed) discardDeletedMeetingRuntime(id);
  state.meetings = state.meetings.filter((meeting) => !removed.has(meeting.id));
  if (removed.has(state.activeId)) state.activeId = state.meetings[0]?.id || null;
  return true;
}

function purgeTombstonedMeetingsFromStorage() {
  let parsed;
  try { parsed = JSON.parse(localStorage.getItem(MEETINGS_KEY) || "[]"); }
  catch { return false; }
  if (!Array.isArray(parsed)) return false;
  const filtered = parsed.filter((meeting) => !meetingDeletionWasRecorded(meeting?.id));
  if (filtered.length === parsed.length) return true;
  try {
    localStorage.setItem(MEETINGS_KEY, JSON.stringify(filtered.slice(0, MAX_MEETINGS).map(persistableMeeting)));
    return true;
  } catch {
    return false;
  }
}

async function cleanupTombstonedMeetingAudio() {
  for (const id of tombstonedMeetingIds()) {
    try {
      await deleteRecording(id);
      markMeetingDeletionComplete(id);
    } catch { /* every tombstone remains authoritative and is retried on next startup */ }
  }
}

function handleMeetingStorageChange(event) {
  if (SHARED_MEETING_LOCATION || state.sharedMode || (event.storageArea && event.storageArea !== localStorage)) return;
  if (event.key?.startsWith(MEETING_TOMBSTONE_PREFIX)) {
    if (event.newValue !== null) {
      const removed = applyMeetingTombstonesToState();
      purgeTombstonedMeetingsFromStorage();
      if (removed) render();
    } else {
      synchronizeMeetingsFromStorage();
    }
    return;
  }
  if (event.key === MEETINGS_KEY) {
    purgeTombstonedMeetingsFromStorage();
    synchronizeMeetingsFromStorage();
  }
}

function synchronizeMeetingsFromStorage() {
  if (SHARED_MEETING_LOCATION || state.sharedMode) return;
  if (state.recorder || recordingRecoveryRuns.size || meetingProcessingRuns.size || insightRetryRuns.size || questionRuns.size || deletingMeetingIds.size) return;
  state.meetings = loadMeetings();
  if (!state.meetings.some((meeting) => meeting.id === state.activeId)) state.activeId = state.meetings[0]?.id || null;
  render();
}

function discardDeletedMeetingRuntime(id) {
  meetingProcessingRuns.get(id)?.abort(new DOMException("Meeting deleted in another tab", "AbortError"));
  recordingRecoveryRuns.get(id)?.abort(new DOMException("Meeting deleted in another tab", "AbortError"));
  questionRuns.get(id)?.abort(new DOMException("Meeting deleted in another tab", "AbortError"));
  insightRetryRuns.delete(id);
  invalidateShareGenerationForMeeting(id);
  if (state.recorder?.meeting.id === id) discardRecorderDeletedInAnotherTab(state.recorder);
}

async function discardRecorderDeletedInAnotherTab(recorder) {
  if (!recorder || recorder.closing) return;
  recorder.closing = true;
  clearInterval(recorder.timer);
  recorder.processor.onaudioprocess = null;
  recorder.processor.disconnect();
  recorder.source.disconnect();
  const stopped = recorder.mediaRecorder.state === "inactive"
    ? Promise.resolve()
    : new Promise((resolve) => recorder.mediaRecorder.addEventListener("stop", resolve, { once: true }));
  if (recorder.mediaRecorder.state !== "inactive") recorder.mediaRecorder.stop();
  recorder.stream.getTracks().forEach((track) => track.stop());
  await recorder.audioContext.close().catch(() => {});
  await stopped;
  await recorder.persistQueue.catch(() => {});
  if (state.recorder === recorder) state.recorder = null;
  state.recording = false;
  if (sessionStorage.getItem(ACTIVE_RECORDING_SESSION_KEY) === recorder.meeting.recordingSessionId) {
    sessionStorage.removeItem(ACTIVE_RECORDING_SESSION_KEY);
  }
  await cleanupDeletedMeetingAudio(recorder.meeting.id);
  render();
}

async function cleanupDeletedMeetingAudio(id) {
  if (!meetingDeletionWasRecorded(id)) return;
  try {
    await deleteRecording(id);
    markMeetingDeletionComplete(id);
  } catch { /* the pending tombstone keeps deletion authoritative until retry */ }
}

function persistableMeeting({ asking: _asking, ...meeting }) {
  return {
    ...meeting,
    qa: Array.isArray(meeting.qa) ? meeting.qa.filter((entry) => entry?.pending !== true) : [],
    duration: storedAudioDuration(meeting.duration),
  };
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
    audio.onloadedmetadata = () => finish(resolve, audioDurationOrNull(audio.duration));
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
function insightRetryButton(meeting, step) {
  if (meeting.readOnly) return "";
  const runningStep = insightRetryRuns.get(meeting.id);
  const retrying = runningStep === step;
  const busy = Boolean(runningStep) || isMeetingDeleting(meeting);
  const interview = meeting.mode === "interview";
  const label = step === "correction" ? (retrying ? "正在处理" : "重试校正") : (retrying ? "正在生成" : (interview ? "重试整理" : "重试生成"));
  const ariaLabel = step === "correction" ? "重试逐字稿校正" : (interview ? "重试整理面试证据" : "重试生成智能纪要");
  return `<button class="insight-retry-button${retrying ? " is-retrying" : ""}" type="button" data-retry-insight="${step}" aria-label="${ariaLabel}" aria-disabled="${busy}" aria-busy="${retrying}"><i data-lucide="${retrying ? "loader-circle" : "refresh-cw"}"></i><span>${label}</span></button>`;
}
function summaryRetryNotice(meeting) {
  return `<div class="inline-warning insight-retry-notice" role="status" aria-live="polite" aria-atomic="true"><span>${escapeHtml(meeting.summaryError)}</span>${insightRetryButton(meeting, "summary")}</div>`;
}
function summaryRetryState(meeting) {
  const label = meeting.mode === "interview" ? "面试证据整理未完成" : "智能纪要生成未完成";
  return `<div class="insight-empty insight-error-state" role="status" aria-live="polite" aria-atomic="true"><i data-lucide="circle-alert"></i><span><strong>${label}</strong><br>${escapeHtml(meeting.summaryError)}</span>${insightRetryButton(meeting, "summary")}</div>`;
}
function correctionNotice(meeting) {
  const recovered = meeting.asrQualityEvents?.filter((item) => item.action === "split").length || 0;
  const quality = recovered ? `<p class="correction-note"><i data-lucide="scan-search"></i>已细分复核 ${recovered} 个异常转写片段</p>` : "";
  const runUsage = meeting.agentRun?.usage || {};
  const agent = meeting.agentRun?.profile && Number(runUsage.modelTurns) > 0
    ? `<p class="correction-note"><i data-lucide="route"></i>Luna Agent · ${Number(runUsage.modelTurns)} 轮 · ${Number(runUsage.toolCalls) || 0} 次工具调用</p>`
    : "";
  const canonicalReviewWarning = meeting.agentRun?.canonicalReview?.status === "degraded"
    ? '<p class="inline-warning" role="status"><i data-lucide="triangle-alert"></i>术语规范拼写仲裁未完整完成，请重点复核专有名词。</p>'
    : "";
  const unsupportedAgentWarning = meeting.agentRun?.status === "unsupported"
    ? '<p class="inline-warning" role="status"><i data-lucide="triangle-alert"></i>当前模型端点不支持术语 Agent 工具调用，本次已使用有边界的校正流程。</p>'
    : "";
  if (meeting.correctionError) return `${quality}${agent}${canonicalReviewWarning}${unsupportedAgentWarning}<div class="inline-warning insight-retry-notice" role="status" aria-live="polite" aria-atomic="true"><span>逐字稿校正未完成：${escapeHtml(meeting.correctionError)}</span>${insightRetryButton(meeting, "correction")}</div>`;
  const correctionDetails = [
    meeting.terminology?.length ? `已统一 ${meeting.terminology.length} 个术语` : "",
    meeting.semanticJoins ? `优化 ${meeting.semanticJoins} 处断句` : "",
  ].filter(Boolean).join(" · ");
  const accepted = correctionDetails ? `<p class="correction-note"><i data-lucide="spell-check-2"></i>${correctionDetails}</p>` : "";
  const rejected = meeting.rejectedCorrections ? `<p class="inline-warning">已保留原始文本：${meeting.rejectedCorrections} 个校正建议未通过安全校验</p>` : "";
  return `${quality}${agent}${canonicalReviewWarning}${unsupportedAgentWarning}${accepted}${rejected}`;
}
function analysisRunNotice(meeting) {
  const notices = [];
  const usage = meeting.analysisRun?.usage || {};
  if (meeting.analysisRun?.status === "unsupported") {
    notices.push('<p class="inline-warning" role="status"><i data-lucide="triangle-alert"></i>当前模型端点不支持 Agent 工具调用，本次已使用有边界的证据校验流程生成纪要。</p>');
  } else if (meeting.analysisRun?.status === "bounded_fallback") {
    notices.push('<p class="inline-warning" role="status"><i data-lucide="triangle-alert"></i>会议证据超过 Agent 单次输入预算，本次已使用完整分块证据流程生成纪要。</p>');
  } else if (meeting.analysisRun?.profile && Number(usage.modelTurns) > 0) {
    notices.push(`<p class="correction-note"><i data-lucide="scan-search"></i>会议解析 Agent · ${Number(usage.modelTurns)} 轮 · ${Number(usage.toolCalls) || 0} 次工具调用</p>`);
  }
  notices.push(legacyUnverifiedInsightsNotice(meeting));
  return notices.join("");
}

function legacyUnverifiedInsightsNotice(meeting) {
  if (!hasLegacyUnverifiedInsights(meeting)) return "";
  return '<p class="inline-warning" role="status"><i data-lucide="triangle-alert"></i>旧版未校验证据，仅供复核。</p>';
}

function hasLegacyUnverifiedInsights(meeting) {
  const marker = meeting?.legacy_unverified_insights;
  const marked = marker === true
    || (typeof marker === "string" && Boolean(marker.trim()))
    || (Array.isArray(marker) && marker.length > 0)
    || (marker && typeof marker === "object" && Object.values(marker).some(Boolean));
  if (marked) return true;
  const speakerSummaryWithoutEvidence = (meeting?.speaker_summaries || []).some((item) => (
    !Array.isArray(item?.evidence) || !item.evidence.some((entry) => String(entry?.quote || "").trim())
  ));
  const actionWithoutEvidence = (meeting?.action_items || []).some((item) => !String(item?.evidence || "").trim());
  return speakerSummaryWithoutEvidence || actionWithoutEvidence;
}
function ratingLabel(value) { return ({ strong: "突出", adequate: "符合", mixed: "有待确认", weak: "不足", insufficient: "证据不足" })[value] || "证据不足"; }

function meetingTaskState(meeting) {
  if (!meeting) return { state: "idle", icon: "clock-3", label: "等待开始" };
  if (meeting.readOnly) return { state: "readonly", icon: "lock-keyhole", label: "只读分享稿" };
  if (isMeetingDeleting(meeting)) return { state: "working", mark: "ING", label: "正在删除记录" };
  const retryStep = insightRetryRuns.get(meeting.id);
  if (retryStep === "correction") return { state: "working", mark: "ING", label: "Agent 正在重新校正逐字稿" };
  if (retryStep === "summary") return { state: "working", mark: "ING", label: meeting.mode === "interview" ? "Agent 正在重新整理面试证据" : "Agent 正在重新生成智能纪要" };
  if (meeting.status === "recording") {
    const realtime = state.recorder?.meeting.id === meeting.id && state.recorder.transcriptionEnabled;
    return { state: "recording", mark: "REC", label: realtime ? "正在录音并实时转写" : "正在录音并保存" };
  }
  if (meeting.status === "recovering") return { state: "working", mark: "ING", label: "正在恢复本地录音" };
  if (meeting.status === "transcribing") return { state: "working", mark: "ING", label: meeting.processingDetail || "正在转写音频" };
  if (meeting.status === "correcting") return { state: "working", mark: "ING", label: "Agent 正在校正逐字稿与断句" };
  if (meeting.status === "summarizing") return { state: "working", mark: "ING", label: meeting.mode === "interview" ? "Agent 正在分析并整理面试证据" : "Agent 正在分析并生成智能纪要" };
  if (meeting.status === "recorded") return { state: "saved", icon: "file-audio", label: "录音已保存" };
  if (meeting.status === "error") return { state: "error", icon: "circle-alert", label: "处理失败" };
  if (meeting.status === "done" && (meeting.correctionError || meeting.summaryError)) return { state: "warning", icon: "triangle-alert", label: "部分 Agent 任务待重试" };
  if (meeting.status === "done") return { state: "done", icon: "circle-check", label: "已完成" };
  return { state: "idle", icon: "clock-3", label: "等待处理" };
}

function statusIcon(status, mode, taskState) {
  if (taskState === "working") return "loader-circle";
  if (status === "recording") return "mic";
  if (status === "error") return "circle-alert";
  if (status === "done") return taskState === "warning" ? "triangle-alert" : "circle-check";
  return mode === "interview" ? "briefcase-business" : "file-audio";
}

function statusLabel(status, mode) {
  return ({
    recording: state.recorder?.transcriptionEnabled ? "正在录音并实时转写" : "正在录音并保存",
    recovering: "正在恢复本地录音",
    recorded: "录音已保存",
    transcribing: "正在转写音频",
    correcting: "Agent 正在校正逐字稿与断句",
    summarizing: mode === "interview" ? "Agent 正在分析并整理面试证据" : "Agent 正在分析并生成智能纪要",
    done: "已完成",
    error: "处理失败",
  })[status] || "";
}

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
