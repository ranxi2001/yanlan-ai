import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runAgent } from "../src/agent/harness.js";
import { createMeetingAnalysisAgentProfile } from "../src/agent/profiles/meeting-analysis.js";
import { createResponsesAdapter } from "../src/agent/responses-adapter.js";
import { DEFAULT_CONFIG, joinApiUrl, publicMeeting, summarizeTranscript } from "../src/api.js";
import { DEFAULT_TERMINOLOGY_SPEC, parseShareMeeting } from "./terminology-eval.mjs";

export async function runMeetingAgentEvaluation(specPath = DEFAULT_TERMINOLOGY_SPEC, env = process.env) {
  const resolvedSpecPath = resolve(specPath);
  const spec = JSON.parse(await readFile(resolvedSpecPath, "utf8"));
  const shareHtml = await readFile(resolve(dirname(resolvedSpecPath), spec.share_html.path), "utf8");
  const meeting = parseShareMeeting(shareHtml);
  const config = meetingAgentEvalConfig(env);
  const transcript = meeting.segments.map((segment) => String(segment.text || "")).join("\n");

  const startedAt = Date.now();
  const result = await summarizeTranscript({ config, meeting });
  const published = publicMeeting({ ...meeting, ...result });
  const trace = result.analysisRun?.trace || [];
  const toolCalls = trace.filter((event) => event.type === "tool.started").map((event) => event.data?.tool);
  const realGold = spec.meeting_agent?.real_fixture;

  assert.ok(result.summary, "Meeting Agent returned an empty grounded summary");
  assert.equal(result.analysisRun?.status, "completed", "Meeting Agent did not complete through the strict tool workflow");
  const commitmentCandidates = trace.find((event) => event.type === "meeting.commitments_reviewed")?.data?.candidates || 0;
  if (commitmentCandidates > 0) {
    assert.ok(toolCalls.includes("review_meeting_commitments"), "Meeting Agent did not classify every commitment candidate");
  }
  assert.ok(toolCalls.includes("finalize_meeting_analysis"), "Meeting Agent did not call finalize_meeting_analysis");
  assert.equal(published.schema, 4, "Meeting Agent output did not survive the public evidence validator");
  assert.equal(published.legacy_unverified_insights, undefined, "Meeting Agent emitted legacy evidence-free insights");
  assert.ok(published.highlights.every((item) => item.quote), "A published highlight is missing verified evidence");
  assert.ok(published.speaker_summaries.every((item) => item.evidence?.length), "A published speaker summary is missing verified evidence");
  assert.ok(published.decision_records.every((item) => item.evidence), "A published decision is missing verified evidence");
  assert.ok(published.action_items.every((item) => item.evidence), "A published action item is missing verified evidence");
  assert.ok(realGold && typeof realGold === "object", "Meeting Agent real-fixture gold is missing");
  assert.equal(published.decision_records.length, realGold.expected_decisions, "Real fixture decision count differs from gold");
  assert.equal(published.action_items.length, realGold.expected_action_items, "Real fixture action count differs from gold");
  assert.ok(
    verifiedEvidenceCount(published) >= realGold.minimum_verified_evidence_records,
    "Real fixture did not publish the minimum gold evidence coverage",
  );

  const semanticCanary = await runSemanticCanary(spec.meeting_agent?.semantic_canary, config);
  const elapsedMilliseconds = Date.now() - startedAt;

  return {
    schema: 1,
    ok: true,
    mode: "live_meeting_analysis",
    corpus: spec.id,
    elapsed_milliseconds: elapsedMilliseconds,
    input: {
      transcript_segments: meeting.segments.length,
      transcript_characters: transcript.length,
      transcript_sha256: sha256(transcript),
    },
    output: {
      title_characters: String(result.title || "").length,
      summary_characters: result.summary.length,
      keywords: result.keywords.length,
      highlights: published.highlights.length,
      speaker_summaries: published.speaker_summaries.length,
      decisions: published.decision_records.length,
      action_items: published.action_items.length,
      verified_evidence_records: verifiedEvidenceCount(published),
      commitment_candidates: commitmentCandidates,
    },
    agent: {
      model: config.chatModel,
      run_id: result.analysisRun.id,
      usage: result.analysisRun.usage,
      tool_calls: toolCalls,
    },
    semantic_canary: semanticCanary,
  };
}

async function runSemanticCanary(spec, config) {
  const evidence = Array.isArray(spec?.evidence) ? spec.evidence : [];
  const expected = spec?.expected_dispositions;
  assert.ok(evidence.length > 1 && expected && typeof expected === "object", "Meeting Agent semantic canary gold is missing");
  const candidates = evidence.filter((record) => record.kind === "decision" || record.kind === "action");
  assert.ok(
    candidates.every((record) => /^c\d{2}$/u.test(String(record.id || ""))),
    "Semantic canary candidate IDs must be opaque",
  );
  assert.deepEqual(
    [...new Set(candidates.map((record) => record.id))].sort(),
    Object.keys(expected).sort(),
    "Semantic canary gold does not cover every commitment candidate exactly once",
  );

  let committedOutline = null;
  const byId = new Map(evidence.map((record) => [record.id, record]));
  const summaryIds = evidence.filter((record) => record.kind === "summary").map((record) => record.id);
  const profile = createMeetingAnalysisAgentProfile({
    evidence,
    sourceSignature: `semantic-canary:${sha256(JSON.stringify(evidence))}`,
    finalizeAnalysis: async (outline) => {
      const selectedSummaryIds = [...new Set(outline.summary_evidence_ids || [])].sort();
      if (JSON.stringify(selectedSummaryIds) !== JSON.stringify([...summaryIds].sort())) {
        return { violations: [{ code: "semantic_canary_summary_coverage" }] };
      }
      committedOutline = outline;
      const decisions = (outline.decision_ids || []).map((id) => byId.get(id)).filter(Boolean);
      const actions = (outline.action_item_ids || []).map((id) => byId.get(id)).filter(Boolean);
      return {
        artifact: {
          title: "Semantic canary",
          summary: "Public synthetic evaluation fixture.",
          keywords: [],
          highlights: [],
          speaker_summaries: [],
          decisions: decisions.map((record) => record.decision),
          decision_records: decisions.map((record) => ({
            decision: record.decision,
            start_seconds: record.start_seconds,
            evidence: record.evidence,
          })),
          action_items: actions.map((record) => ({
            task: record.task,
            owner: record.owner || "",
            due: record.due || "",
            start_seconds: record.start_seconds,
            speaker: record.speaker || "Evaluator",
            evidence: record.evidence,
          })),
        },
        violations: [],
      };
    },
  });
  const adapter = createResponsesAdapter({
    model: config.chatModel,
    store: false,
    includeEncryptedReasoning: true,
    request: (body, options) => requestLiveResponses(config, body, options.signal),
  });
  const run = await runAgent({
    adapter,
    profile,
    input: profile.input,
    initialState: profile.initialState,
    policy: {
      maxModelTurns: 5,
      maxToolCalls: 5,
      maxIdleTurns: 1,
      maxToolOutputCharacters: 20_000,
      maxHistoryCharacters: 200_000,
    },
  });

  const actual = new Map((run.state.commitment_reviews || []).map((review) => [review.evidence_id, review.disposition]));
  assert.equal(actual.size, candidates.length, "Semantic canary review count differs from gold");
  for (const [id, disposition] of Object.entries(expected)) {
    assert.equal(actual.get(id), disposition, `Semantic canary disposition differs from gold for ${id}`);
  }
  const confirmed = candidates.filter((record) => expected[record.id] === "confirmed");
  assert.deepEqual(
    [...(committedOutline?.decision_ids || [])].sort(),
    confirmed.filter((record) => record.kind === "decision").map((record) => record.id).sort(),
    "Semantic canary committed decision set differs from gold",
  );
  assert.deepEqual(
    [...(committedOutline?.action_item_ids || [])].sort(),
    confirmed.filter((record) => record.kind === "action").map((record) => record.id).sort(),
    "Semantic canary committed action set differs from gold",
  );

  return {
    input_sha256: sha256(JSON.stringify(evidence)),
    candidates: candidates.length,
    matched_dispositions: actual.size,
    confirmed_decisions: confirmed.filter((record) => record.kind === "decision").length,
    confirmed_action_items: confirmed.filter((record) => record.kind === "action").length,
    usage: run.usage,
    tool_calls: run.trace.filter((event) => event.type === "tool.started").map((event) => event.data?.tool),
  };
}

async function requestLiveResponses(config, body, signal) {
  const response = await fetch(joinApiUrl(config.chatBaseUrl, config.chatPath), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.chatApiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const error = new Error(`Meeting Agent semantic canary request failed (HTTP ${response.status})`);
    error.code = "http";
    error.status = response.status;
    throw error;
  }
  try {
    return await response.json();
  } catch {
    const error = new Error("Meeting Agent semantic canary returned invalid JSON");
    error.code = "invalid-response";
    throw error;
  }
}

function meetingAgentEvalConfig(env) {
  const chatBaseUrl = firstValue(env.YANLAN_LUNA_BASE_URL, env.OPENAI_BASE_URL);
  const chatApiKey = firstValue(env.YANLAN_LUNA_API_KEY, env.OPENAI_API_KEY);
  if (!chatBaseUrl || !chatApiKey) {
    throw new Error("Live meeting Agent eval requires YANLAN_LUNA_BASE_URL and YANLAN_LUNA_API_KEY (or OPENAI_BASE_URL and OPENAI_API_KEY)");
  }
  return {
    ...DEFAULT_CONFIG,
    chatBaseUrl,
    chatApiKey,
    chatModel: firstValue(env.YANLAN_LUNA_MODEL, "gpt-5.6-luna"),
    chatProtocol: "responses",
    chatPath: firstValue(env.YANLAN_LUNA_RESPONSES_PATH, "responses"),
  };
}

function verifiedEvidenceCount(meeting) {
  return meeting.highlights.length
    + meeting.speaker_summaries.reduce((total, item) => total + item.evidence.length, 0)
    + meeting.decision_records.length
    + meeting.action_items.length;
}

function firstValue(...values) {
  return values.map((value) => String(value || "").trim()).find(Boolean) || "";
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function meetingAgentFailureReport(error) {
  return {
    schema: 1,
    ok: false,
    error: {
      name: safeErrorName(error),
      code: safeErrorCode(error, "meeting_agent_eval_failed"),
      message: "Meeting Agent evaluation failed; inspect local diagnostics without publishing provider output",
    },
  };
}

function safeErrorName(error) {
  const name = String(error?.name || "Error");
  return new Set(["Error", "AbortError", "TimeoutError", "AgentProtocolError", "RunBudgetExceeded", "AssertionError"]).has(name) ? name : "Error";
}

function safeErrorCode(error, fallback) {
  const code = String(error?.code || "");
  return /^(?:http|timeout|aborted|relay-unavailable|network-or-cors|response-interrupted|invalid-response|agent_[a-z0-9_]+|response_[a-z0-9_]+|tool_[a-z0-9_]+)$/u.test(code) ? code : fallback;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  runMeetingAgentEvaluation(process.argv[2] || DEFAULT_TERMINOLOGY_SPEC)
    .then((report) => console.log(JSON.stringify(report, null, 2)))
    .catch((error) => {
      console.error(JSON.stringify(meetingAgentFailureReport(error), null, 2));
      process.exitCode = 1;
    });
}
