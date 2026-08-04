const MAX_EVIDENCE_IDS = 200;
const MAX_EVIDENCE_RECORDS = 400;
const MAX_COMMITMENT_REVIEWS = 90;
const MAX_SPEAKER_GROUPS = 30;
const MAX_SPEAKER_EVIDENCE_IDS = 40;
const MAX_RETURNED_VIOLATIONS = 40;
const COMMITMENT_DISPOSITIONS = ["confirmed", "question", "unresolved", "negated", "other"];

export function createMeetingAnalysisAgentProfile({
  evidence = [],
  sourceSignature = "",
  reviewCommitments,
  finalizeAnalysis,
} = {}) {
  if (typeof finalizeAnalysis !== "function") throw new TypeError("Meeting analysis profile requires finalizeAnalysis");
  if (reviewCommitments != null && typeof reviewCommitments !== "function") {
    throw new TypeError("Meeting analysis profile reviewCommitments must be a function");
  }
  if (evidence.length > MAX_EVIDENCE_RECORDS) {
    const error = new RangeError(`Meeting evidence exceeds ${MAX_EVIDENCE_RECORDS} records`);
    error.code = "meeting_evidence_budget_exceeded";
    throw error;
  }
  const ledger = evidence.map((record) => Object.freeze({ ...record }));
  const commitmentCandidates = ledger.filter((record) => record.kind === "decision" || record.kind === "action");
  const initialState = {
    profile_version: 2,
    source_signature: String(sourceSignature || ""),
    commitment_review_attempts: 0,
    commitment_reviewed: commitmentCandidates.length === 0,
    commitment_reviews: [],
    finalize_attempts: 0,
    finalized: false,
    artifact: null,
  };
  const tools = [{
    name: "review_meeting_commitments",
    description: "Classify every decision and action candidate in the immutable evidence ledger before finalization. Coverage must be exact and complete.",
    strict: true,
    stateful: true,
    parameters: objectSchema({
      reviews: arraySchema(objectSchema({
        evidence_id: stringSchema(1, 80),
        disposition: enumStringSchema(COMMITMENT_DISPOSITIONS),
      }), 0, MAX_COMMITMENT_REVIEWS),
    }),
    async execute({ reviews }, { state, trace }) {
      if (state.finalized) return { output: { ok: false, error: "analysis_already_finalized" } };
      if (state.commitment_reviewed) return { output: { ok: false, error: "commitments_already_reviewed" } };
      const result = validateCommitmentReviews(reviews, ledger);
      if (!result.violations.length && reviewCommitments) {
        const runtimeReview = await reviewCommitments(result.reviews, {
          evidence: ledger,
          sourceSignature: state.source_signature,
        });
        if (Array.isArray(runtimeReview?.violations)) result.violations.push(...runtimeReview.violations);
      }
      if (result.violations.length) {
        trace.append("meeting.commitments_rejected", { violations: result.violations.length });
        return {
          state: { ...state, commitment_review_attempts: state.commitment_review_attempts + 1 },
          output: boundedViolationOutput(result.violations),
        };
      }
      const confirmed = confirmedCommitmentIds(result.reviews, ledger);
      trace.append("meeting.commitments_reviewed", {
        candidates: commitmentCandidates.length,
        confirmed_decisions: confirmed.decision_ids.length,
        confirmed_actions: confirmed.action_item_ids.length,
      });
      return {
        state: {
          ...state,
          commitment_review_attempts: state.commitment_review_attempts + 1,
          commitment_reviewed: true,
          commitment_reviews: result.reviews,
        },
        output: {
          ok: true,
          reviewed_candidates: result.reviews.length,
          confirmed_decisions: confirmed.decision_ids.length,
          confirmed_actions: confirmed.action_item_ids.length,
        },
      };
    },
  }, {
    name: "finalize_meeting_analysis",
    description: "Select evidence IDs from the immutable ledger and atomically commit the runtime-verified analysis after commitment classification is complete.",
    strict: true,
    stateful: true,
    parameters: objectSchema({
      summary_evidence_ids: evidenceIdsSchema(1, MAX_EVIDENCE_RECORDS),
      highlight_ids: evidenceIdsSchema(0),
      speaker_summaries: arraySchema(objectSchema({
        speaker: stringSchema(1, 120),
        evidence_ids: evidenceIdsSchema(1, MAX_SPEAKER_EVIDENCE_IDS),
      }), 0, MAX_SPEAKER_GROUPS),
    }),
    async execute(outline, { state, trace }) {
      if (state.finalized) return { output: { ok: false, error: "analysis_already_finalized" } };
      if (!state.commitment_reviewed) {
        const violations = [{ code: "meeting_commitment_review_required" }];
        trace.append("meeting.analysis_rejected", { violations: violations.length });
        return {
          state: { ...state, finalize_attempts: state.finalize_attempts + 1 },
          output: boundedViolationOutput(violations),
        };
      }
      const selectedCommitments = confirmedCommitmentIds(state.commitment_reviews, ledger);
      const committedOutline = { ...outline, ...selectedCommitments };
      const result = await finalizeAnalysis(committedOutline, { evidence: ledger, sourceSignature: state.source_signature });
      const violations = Array.isArray(result?.violations) ? result.violations : [];
      if (violations.length || !result?.artifact) {
        trace.append("meeting.analysis_rejected", { violations: violations.length });
        return {
          state: { ...state, finalize_attempts: state.finalize_attempts + 1 },
          output: boundedViolationOutput(violations),
        };
      }
      trace.append("meeting.analysis_finalized", {
        evidence_records: ledger.length,
        highlights: result.artifact.highlights?.length || 0,
        decisions: result.artifact.decision_records?.length || 0,
        action_items: result.artifact.action_items?.length || 0,
      });
      return {
        state: {
          ...state,
          finalize_attempts: state.finalize_attempts + 1,
          finalized: true,
          artifact: result.artifact,
        },
        output: {
          ok: true,
          source_signature: state.source_signature,
          selected_evidence: selectedEvidenceCount(committedOutline),
        },
      };
    },
  }];
  const input = JSON.stringify({
    task: "Build one evidence-backed meeting analysis from the immutable ledger.",
    source_signature: initialState.source_signature,
    transcript_batch_count: ledger.filter((record) => record.kind === "summary" && record.scope === "transcript_batch").length,
    commitment_candidate_count: commitmentCandidates.length,
    evidence: ledger.map(meetingEvidenceForModel),
  });

  return {
    name: "meeting-analysis",
    initialState,
    input,
    tools,
    instructions: `You are the Luna meeting analysis supervisor. The input contains an immutable evidence ledger produced from bounded transcript batches.

First classify every decision and action candidate, then finalize the analysis using only exact evidence IDs from the ledger. The runtime derives title, summary, and keywords from selected summary records; you cannot write those fields.

Rules:
1. When commitment_candidate_count is greater than zero, call review_meeting_commitments first. Include every decision/action candidate ID exactly once. Use confirmed only when the exact evidence states a completed decision or an assigned/obligatory action. Use question for a question, unresolved for discussion/intent/plans without commitment, negated when the commitment act did not happen, and other when it is not actually a decision/action.
2. Conditionals (if/unless/如果/若), uncertain modals (might/may/could/可能/也许), hearsay (reportedly/heard/据说/听说), expectations, intentions, and plans do not establish a commitment. Classify conditional, modal, planned, and intended outcomes as unresolved; classify hearsay as other unless the evidence independently states that the meeting itself confirmed it.
3. A negative outcome such as "we decided not to release" is a confirmed decision. "No decision was made" is negated. An obligation such as "Alex must approve" and an explicit assignment such as "Xiaoming is responsible for release" are confirmed actions. Do not confuse negative content with an absent commitment.
4. After review succeeds, the runtime derives decisions and action items directly from confirmed classifications; do not repeat or rewrite those IDs in finalization.
5. summary_evidence_ids must include every transcript_batch summary record. highlight_ids may reference only highlights. Each speaker summary must use evidence for that exact speaker.
6. Do not infer owners, deadlines, decisions, quotes, speakers, or timestamps. If a tool returns violations, correct them and retry. A successful finalization is terminal.

Do not emit a prose answer; only the finalization tool can create the artifact.`,
    isComplete: ({ state }) => state.finalized === true,
    isTerminalState: ({ state }) => state.finalized === true,
    completeOnTerminalState: true,
    allowEmptyFinal: true,
    result: ({ state }) => state.artifact,
    onIncomplete: ({ state }) => state.commitment_reviewed
      ? `Meeting analysis is not finalized. Correct the evidence selection and call finalize_meeting_analysis. Previous rejected attempts: ${state.finalize_attempts}.`
      : `Commitment classification is incomplete. Call review_meeting_commitments with every candidate exactly once. Previous rejected reviews: ${state.commitment_review_attempts}.`,
  };
}

function meetingEvidenceForModel(record) {
  const base = { id: record.id, kind: record.kind };
  if (record.kind === "summary") {
    return {
      ...base,
      scope: record.scope,
      batch_index: record.batch_index,
      keywords: (record.keywords || []).slice(0, 8),
      quote_previews: (record.quotes || []).slice(0, 2).map((item) => ({
        start_seconds: item.start_seconds,
        speaker: compactString(item.speaker, 80),
        quote: compactString(item.quote, 320),
      })),
    };
  }
  if (record.kind === "action") {
    return {
      ...base,
      start_seconds: record.start_seconds,
      speaker: compactString(record.speaker, 80),
      task: compactString(record.task, 360),
      owner: compactString(record.owner, 80),
      due: compactString(record.due, 80),
      evidence: compactString(record.evidence, 360),
    };
  }
  if (record.kind === "decision") {
    return {
      ...base,
      start_seconds: record.start_seconds,
      decision: compactString(record.decision, 360),
      evidence: compactString(record.evidence, 360),
    };
  }
  return {
    ...base,
    start_seconds: record.start_seconds,
    speaker: compactString(record.speaker, 80),
    quote: compactString(record.quote, 360),
  };
}

function compactString(value, limit) {
  return String(value || "").trim().slice(0, limit);
}

function selectedEvidenceCount(outline) {
  return new Set([
    ...(outline.summary_evidence_ids || []),
    ...(outline.highlight_ids || []),
    ...(outline.decision_ids || []),
    ...(outline.action_item_ids || []),
    ...(outline.speaker_summaries || []).flatMap((item) => item.evidence_ids || []),
  ]).size;
}

function validateCommitmentReviews(reviews, ledger) {
  const byId = new Map(ledger.map((record) => [record.id, record]));
  const candidateIds = ledger
    .filter((record) => record.kind === "decision" || record.kind === "action")
    .map((record) => record.id);
  const seen = new Set();
  const normalized = [];
  const violations = [];
  for (const review of reviews || []) {
    const id = String(review.evidence_id || "");
    if (seen.has(id)) {
      violations.push({ code: "duplicate_commitment_review", evidence_id: id });
      continue;
    }
    seen.add(id);
    const record = byId.get(id);
    if (!record) {
      violations.push({ code: "unknown_meeting_evidence", field: "reviews", evidence_id: id });
      continue;
    }
    if (record.kind !== "decision" && record.kind !== "action") {
      violations.push({ code: "meeting_commitment_kind_mismatch", evidence_id: id, kind: record.kind });
      continue;
    }
    normalized.push({ evidence_id: id, disposition: review.disposition });
  }
  const missing = candidateIds.filter((id) => !seen.has(id));
  if (missing.length) {
    violations.push({
      code: "meeting_commitment_review_incomplete",
      missing_count: missing.length,
      missing_evidence_ids: missing.slice(0, MAX_RETURNED_VIOLATIONS),
    });
  }
  return { reviews: normalized, violations };
}

function confirmedCommitmentIds(reviews, ledger) {
  const kindById = new Map(ledger.map((record) => [record.id, record.kind]));
  const confirmed = (reviews || []).filter((review) => review.disposition === "confirmed");
  return {
    decision_ids: confirmed.filter((review) => kindById.get(review.evidence_id) === "decision").map((review) => review.evidence_id),
    action_item_ids: confirmed.filter((review) => kindById.get(review.evidence_id) === "action").map((review) => review.evidence_id),
  };
}

function boundedViolationOutput(violations) {
  const visibleViolations = violations.slice(0, MAX_RETURNED_VIOLATIONS);
  return {
    ok: false,
    violations: visibleViolations,
    omitted_violation_count: Math.max(0, violations.length - visibleViolations.length),
  };
}

function evidenceIdsSchema(minItems, maxItems = MAX_EVIDENCE_IDS) {
  return arraySchema(stringSchema(1, 80), minItems, maxItems);
}

function objectSchema(properties) {
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}

function arraySchema(items, minItems, maxItems) {
  return { type: "array", items, minItems, maxItems };
}

function stringSchema(minLength, maxLength) {
  return { type: "string", minLength, maxLength };
}

function enumStringSchema(values) {
  return { type: "string", enum: [...values] };
}
