import test from "node:test";
import assert from "node:assert/strict";
import { correctTranscript, DEFAULT_CONFIG } from "../src/api.js";
import { createTerminologyAgentProfile } from "../src/agent/profiles/terminology.js";

const responsesConfig = {
  ...DEFAULT_CONFIG,
  chatBaseUrl: "https://gpt.example/v1",
  chatApiKey: "gpt-test-key",
  chatModel: "gpt-5.6-luna",
  chatProtocol: "responses",
  chatPath: "responses",
  contextHint: "terms: Descheduler",
};

const mappings = [
  { alias: "disk scheduler", canonical: "Descheduler" },
  { alias: "dis scheduler", canonical: "Descheduler" },
  { alias: "Y调度", canonical: "Descheduler" },
];

test("Responses terminology agent unifies aliases through tools and preserves transcript geometry", async () => {
  const rawSegments = [
    { start_seconds: 0, end_seconds: 4, speaker: "Speaker A", text: "disk scheduler starts checking." },
    { start_seconds: 4, end_seconds: 9, speaker: "Speaker B", text: "dis scheduler continues checking." },
    { start_seconds: 9, end_seconds: 13, speaker: "Speaker B", text: "继续适配 Y调度 的发现接口。" },
  ];
  const meeting = sourceMeeting(rawSegments);
  const geometry = transcriptGeometry(rawSegments);
  const reasoning = reasoningItem("read", "Inspect the complete recording before proposing mappings.");
  const responses = [
    toolResponse("read", [toolCall("call_read", "read_transcript_window", {
      start_segment: 0,
      max_segments: 3,
    })], reasoning),
    toolResponse("inspect", [toolCall("call_inspect", "inspect_terminology_signals", {})]),
    toolResponse("submit", [toolCall("call_submit", "submit_term_candidates", {
      candidates: [
        { ...mappings[0], evidence_segment_ids: [0], confidence: "high" },
        { ...mappings[1], evidence_segment_ids: [1], confidence: "high" },
        { ...mappings[2], evidence_segment_ids: [2], confidence: "high" },
      ],
    })]),
    toolResponse("scan", mappings.map((mapping, index) => (
      toolCall(`call_scan_${index}`, "scan_alias_occurrences", mapping)
    ))),
    toolResponse("resolve", [toolCall("call_resolve", "resolve_terminology_signals", {
      decisions: [
        {
          signal_id: "surface-1",
          disposition: "mapped",
          canonical: "Descheduler",
          reason: "The Latin spellings are repeated surface variants of one scheduler component.",
        },
        {
          signal_id: "context-1",
          disposition: "mapped",
          canonical: "Descheduler",
          reason: "The adjacent mixed-script mention refers to the same discovery interface.",
        },
      ],
    })]),
    toolResponse("validate", [toolCall("call_validate", "validate_mapping_group", { mappings })]),
    toolResponse("finalize", [toolCall("call_finalize", "finalize_correction", {
      mappings,
      join_after: [],
    })]),
  ];
  const { requests, run } = await withResponsesFetch(responses, () => correctTranscript({
    config: responsesConfig,
    meeting,
  }));

  assert.deepEqual(run.segments.map((segment) => segment.text), [
    "Descheduler starts checking.",
    "Descheduler continues checking.",
    "继续适配 Descheduler 的发现接口。",
  ]);
  assert.deepEqual(transcriptGeometry(run.segments), geometry);
  assert.deepEqual(transcriptGeometry(meeting.segments), geometry);
  assert.deepEqual(meeting.segments.map((segment) => segment.text), rawSegments.map((segment) => segment.text));
  assert.deepEqual(run.terminology, ["Descheduler"]);
  assert.equal(run.rejectedCorrections, 0);
  assert.equal(run.corrections.length, 3);
  assert.equal(run.corrections.every((entry) => (
    entry.status === "accepted"
    && entry.reason === "recording_consensus"
    && entry.to === "Descheduler"
  )), true);

  assert.equal(requests.length, responses.length);
  assertResponsesContract(requests);
  assert.deepEqual(
    requests[1].input.find((item) => item?.id === reasoning.id),
    reasoning,
  );
  assertToolOutputsRoundTrip(requests, responses);

  assert.ok(run.agentRun);
  assert.equal(run.agentRun.profile, "terminology-supervisor");
  assert.equal(run.agentRun.model, "gpt-5.6-luna");
  assert.deepEqual(run.agentRun.usage, { modelTurns: 7, toolCalls: 9 });
  assert.ok(run.agentRun.id);
  assert.ok(Array.isArray(run.agentRun.trace) && run.agentRun.trace.length > 0);
  const traceTypes = run.agentRun.trace.map((event) => event.type);
  for (const expected of [
    "run.started",
    "term.window_read",
    "term.signals_inspected",
    "term.candidates_submitted",
    "term.alias_scanned",
    "term.signals_resolved",
    "term.mapping_validated",
    "term.finalized",
    "run.completed",
  ]) assert.ok(traceTypes.includes(expected), `missing trace event ${expected}`);
  assert.equal(traceTypes.filter((type) => type === "term.alias_scanned").length, 3);
});

test("finalize before full transcript coverage is rejected and the Responses run continues", async () => {
  const rawSegments = [
    { start_seconds: 0, end_seconds: 3, speaker: "A", text: "Routine status update." },
    { start_seconds: 3, end_seconds: 6, speaker: "B", text: "No terminology changes." },
  ];
  const responses = [
    toolResponse("early-finalize", [toolCall("call_finalize_early", "finalize_correction", {
      mappings: [],
      join_after: [],
    })]),
    toolResponse("read-after-rejection", [toolCall("call_read_after_rejection", "read_transcript_window", {
      start_segment: 0,
      max_segments: 2,
    })]),
    toolResponse("inspect-after-read", [toolCall("call_inspect_after_read", "inspect_terminology_signals", {})]),
    toolResponse("validate-after-inspect", [toolCall("call_validate_after_inspect", "validate_mapping_group", {
      mappings: [],
    })]),
    toolResponse("finalize-after-read", [toolCall("call_finalize_after_read", "finalize_correction", {
      mappings: [],
      join_after: [],
    })]),
  ];
  const { requests, run } = await withResponsesFetch(responses, () => correctTranscript({
    config: { ...responsesConfig, contextHint: "" },
    meeting: sourceMeeting(rawSegments),
  }));

  assert.deepEqual(run.segments.map((segment) => segment.text), rawSegments.map((segment) => segment.text));
  assert.deepEqual(transcriptGeometry(run.segments), transcriptGeometry(rawSegments));
  assertToolOutputsRoundTrip(requests, responses);

  const earlyOutput = toolOutput(requests[1], "call_finalize_early");
  assert.equal(earlyOutput.ok, false);
  assert.ok(earlyOutput.violations.some((violation) => (
    violation.code === "recording_not_fully_inspected"
    && violation.remaining_count === 2
  )));
  assert.ok(earlyOutput.violations.some((violation) => (
    violation.code === "terminology_signal_inventory_not_inspected"
  )));
  const traceTypes = run.agentRun.trace.map((event) => event.type);
  assert.equal(traceTypes.filter((type) => type === "term.finalize_rejected").length, 1);
  assert.equal(traceTypes.filter((type) => type === "term.finalized").length, 1);
  assert.deepEqual(run.agentRun.usage, { modelTurns: 5, toolCalls: 5 });
});

test("full transcript coverage cannot bypass a detected terminology inventory with empty mappings", async () => {
  const rawSegments = [
    { start_seconds: 0, end_seconds: 3, speaker: "A", text: "disk scheduler starts." },
    { start_seconds: 3, end_seconds: 6, speaker: "A", text: "dis scheduler continues." },
    { start_seconds: 6, end_seconds: 9, speaker: "B", text: "Descheduler reports the result." },
  ];
  const anchoredMappings = mappings.slice(0, 2);
  const responses = [
    toolResponse("read-before-empty", [toolCall("call_read_before_empty", "read_transcript_window", {
      start_segment: 0,
      max_segments: 3,
    })]),
    toolResponse("empty-finalize", [toolCall("call_empty_finalize", "finalize_correction", {
      mappings: [],
      join_after: [],
    })]),
    toolResponse("inspect-after-empty", [toolCall("call_inspect_after_empty", "inspect_terminology_signals", {})]),
    toolResponse("dismiss-after-empty", [toolCall("call_dismiss_after_empty", "resolve_terminology_signals", {
      decisions: [{
        signal_id: "surface-1",
        disposition: "not_terminology",
        canonical: "",
        reason: "Attempt to skip the detected group.",
      }],
    })]),
    toolResponse("submit-after-empty", [toolCall("call_submit_after_empty", "submit_term_candidates", {
      candidates: [
        { ...anchoredMappings[0], evidence_segment_ids: [0], confidence: "high" },
        { ...anchoredMappings[1], evidence_segment_ids: [1], confidence: "high" },
      ],
    })]),
    toolResponse("resolve-after-empty", [toolCall("call_resolve_after_empty", "resolve_terminology_signals", {
      decisions: [{
        signal_id: "surface-1",
        disposition: "mapped",
        canonical: "Descheduler",
        reason: "All three spellings name the same repeated component.",
      }],
    })]),
    toolResponse("validate-after-empty", [toolCall("call_validate_after_empty", "validate_mapping_group", {
      mappings: anchoredMappings,
    })]),
    toolResponse("finalize-after-empty", [toolCall("call_finalize_after_empty", "finalize_correction", {
      mappings: anchoredMappings,
      join_after: [],
    })]),
  ];

  const { requests, run } = await withResponsesFetch(responses, () => correctTranscript({
    config: { ...responsesConfig, contextHint: "" },
    meeting: sourceMeeting(rawSegments),
  }));

  const rejected = toolOutput(requests[2], "call_empty_finalize");
  assert.equal(rejected.ok, false);
  assert.ok(rejected.violations.some((violation) => (
    violation.code === "terminology_signal_inventory_not_inspected"
  )));
  const dismissed = toolOutput(requests[4], "call_dismiss_after_empty");
  assert.equal(dismissed.ok, false);
  assert.deepEqual(dismissed.rejected, [{
    signal_id: "surface-1",
    reason: "high_confidence_surface_variants_require_mapping",
  }]);
  assert.deepEqual(run.segments.map((segment) => segment.text), [
    "Descheduler starts.",
    "Descheduler continues.",
    "Descheduler reports the result.",
  ]);
  assert.equal(run.corrections.length, 2);
  assert.equal(run.agentRun.trace.filter((event) => event.type === "term.finalize_rejected").length, 1);
});

test("an unrelated semantic alias cannot inherit a distant canonical anchor and can be withdrawn", async () => {
  const rawSegments = [
    { start_seconds: 0, end_seconds: 3, speaker: "A", text: "disk scheduler starts." },
    { start_seconds: 3, end_seconds: 6, speaker: "A", text: "dis scheduler continues." },
    { start_seconds: 6, end_seconds: 9, speaker: "B", text: "neutral bridge one." },
    { start_seconds: 9, end_seconds: 12, speaker: "B", text: "neutral bridge two." },
    { start_seconds: 12, end_seconds: 15, speaker: "C", text: "weekly update remains unrelated." },
  ];
  const unrelated = { alias: "weekly update", canonical: "Descheduler" };
  const anchoredMappings = mappings.slice(0, 2);
  const allMappings = [...anchoredMappings, unrelated];
  const responses = [
    toolResponse("read-unrelated", [toolCall("call_read_unrelated", "read_transcript_window", {
      start_segment: 0,
      max_segments: 5,
    })]),
    toolResponse("inspect-unrelated", [toolCall("call_inspect_unrelated", "inspect_terminology_signals", {})]),
    toolResponse("submit-unrelated", [toolCall("call_submit_unrelated", "submit_term_candidates", {
      candidates: [
        { ...anchoredMappings[0], evidence_segment_ids: [0], confidence: "high" },
        { ...anchoredMappings[1], evidence_segment_ids: [1], confidence: "high" },
        { ...unrelated, evidence_segment_ids: [0, 4], confidence: "high" },
      ],
    })]),
    toolResponse("resolve-unrelated", [toolCall("call_resolve_unrelated", "resolve_terminology_signals", {
      decisions: [{
        signal_id: "surface-1",
        disposition: "mapped",
        canonical: "Descheduler",
        reason: "The two scheduler spellings are variants; the distant weekly update is not part of this signal.",
      }],
    })]),
    toolResponse("validate-unrelated", [toolCall("call_validate_unrelated", "validate_mapping_group", {
      mappings: allMappings,
    })]),
    toolResponse("finalize-unrelated", [toolCall("call_finalize_unrelated", "finalize_correction", {
      mappings: allMappings,
      join_after: [],
    })]),
    toolResponse("reject-unrelated", [toolCall("call_reject_unrelated", "reject_term_candidates", {
      candidates: [unrelated],
      reason: "The occurrence is distant from the canonical entity context.",
    })]),
    toolResponse("validate-anchored", [toolCall("call_validate_anchored", "validate_mapping_group", {
      mappings: anchoredMappings,
    })]),
    toolResponse("finalize-anchored", [toolCall("call_finalize_anchored", "finalize_correction", {
      mappings: anchoredMappings,
      join_after: [],
    })]),
  ];

  const { requests, run } = await withResponsesFetch(responses, () => correctTranscript({
    config: { ...responsesConfig, contextHint: "" },
    meeting: sourceMeeting(rawSegments),
  }));

  assert.deepEqual(run.segments.map((segment) => segment.text), [
    "Descheduler starts.",
    "Descheduler continues.",
    "neutral bridge one.",
    "neutral bridge two.",
    "weekly update remains unrelated.",
  ]);
  assert.equal(run.corrections.length, 2);
  assert.equal(run.rejectedCorrections, 0);
  const rejectedFinalize = toolOutput(requests[6], "call_finalize_unrelated");
  assert.equal(rejectedFinalize.ok, false);
  assert.ok(rejectedFinalize.violations.some((violation) => (
    violation.code === "runtime_mapping_rejected" && violation.alias === "weekly update"
  )));
  const rejectedCandidate = toolOutput(requests[7], "call_reject_unrelated");
  assert.equal(rejectedCandidate.ok, true);
  assert.deepEqual(rejectedCandidate.removed.map(({ alias, canonical }) => ({ alias, canonical })), [unrelated]);
  const traceTypes = run.agentRun.trace.map((event) => event.type);
  assert.equal(traceTypes.filter((type) => type === "term.finalize_rejected").length, 1);
  assert.equal(traceTypes.filter((type) => type === "term.candidates_rejected").length, 1);
  assert.equal(traceTypes.filter((type) => type === "term.finalized").length, 1);
});

test("persisted recording consensus is revisable while explicit user mappings remain authoritative", () => {
  const rawSegments = [
    { start_seconds: 0, end_seconds: 3, speaker: "A", text: "disk scheduler and d schedule." },
  ];
  const scanOccurrences = (alias) => rawSegments[0].text.includes(alias)
    ? [{ segment_id: 0, start_offset: rawSegments[0].text.indexOf(alias), end_offset: rawSegments[0].text.indexOf(alias) + alias.length }]
    : [];
  const profile = createTerminologyAgentProfile({
    segments: rawSegments,
    explicitMappings: [{ alias: "d schedule", canonical: "Descheduler" }],
    priorMappings: [{ alias: "disk scheduler", canonical: "DiskScheduler" }],
    scanOccurrences,
    finalizeMappings: () => ({ corrections: [] }),
  });
  const reject = profile.tools.find((tool) => tool.name === "reject_term_candidates");
  const result = reject.execute({
    candidates: [
      { alias: "disk scheduler", canonical: "DiskScheduler" },
      { alias: "d schedule", canonical: "Descheduler" },
    ],
    reason: "Current recording evidence supersedes the persisted model consensus.",
  }, {
    state: profile.initialState,
    trace: { append() {} },
  });

  assert.deepEqual(result.output.removed.map(({ alias, canonical }) => ({ alias, canonical })), [
    { alias: "disk scheduler", canonical: "DiskScheduler" },
  ]);
  assert.deepEqual(result.output.refused, [{
    alias: "d schedule",
    canonical: "Descheduler",
    reason: "explicit_context_mapping",
  }]);
  assert.deepEqual(result.state.candidates.map((candidate) => candidate.source), ["explicit_context"]);
});

function sourceMeeting(rawSegments) {
  return {
    id: "weekly-terminology-agent",
    rawSegments: rawSegments.map((segment) => ({ ...segment })),
    segments: rawSegments.map((segment) => ({ ...segment })),
    asrReconciliations: [],
  };
}

function transcriptGeometry(segments) {
  return segments.map(({ start_seconds, end_seconds, speaker }) => ({ start_seconds, end_seconds, speaker }));
}

function reasoningItem(id, text) {
  return {
    id: `reasoning_${id}`,
    type: "reasoning",
    summary: [{ type: "summary_text", text }],
    encrypted_content: `opaque-${id}`,
  };
}

function toolCall(callId, name, args) {
  return {
    id: `function_${callId}`,
    type: "function_call",
    status: "completed",
    call_id: callId,
    name,
    arguments: JSON.stringify(args),
  };
}

function toolResponse(id, calls, reasoning = reasoningItem(id, `Use ${calls.map((call) => call.name).join(", ")}.`)) {
  return {
    id: `response_${id}`,
    status: "completed",
    output: [reasoning, ...calls],
  };
}

function completedMessageResponse(id, text) {
  return {
    id: `response_${id}`,
    status: "completed",
    output: [{
      id: `message_${id}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text }],
    }],
  };
}

async function withResponsesFetch(responses, operation) {
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), "https://gpt.example/v1/responses");
    assert.equal(options?.method, "POST");
    const body = JSON.parse(options?.body || "{}");
    requests.push(body);
    const response = responses[requests.length - 1];
    assert.ok(response, `unexpected Responses request ${requests.length}`);
    return new Response(JSON.stringify(response), { headers: { "content-type": "application/json" } });
  };
  try {
    const run = await operation();
    assert.equal(requests.length, responses.length, "not every scripted Responses turn was consumed");
    return { requests, run };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function assertResponsesContract(requests) {
  const expectedTools = [
    "read_transcript_window",
    "inspect_terminology_signals",
    "submit_term_candidates",
    "reject_term_candidates",
    "scan_alias_occurrences",
    "resolve_terminology_signals",
    "validate_mapping_group",
    "finalize_correction",
  ];
  for (const request of requests) {
    assert.equal(request.model, "gpt-5.6-luna");
    assert.equal(request.max_output_tokens, 4_096);
    assert.equal(request.store, false);
    assert.deepEqual(request.include, ["reasoning.encrypted_content"]);
    assert.deepEqual(request.tools.map((tool) => tool.name), expectedTools);
    assert.equal(request.tools.every((tool) => (
      tool.type === "function"
      && tool.strict === true
      && tool.parameters?.additionalProperties === false
    )), true);
    assert.equal(Array.isArray(request.input), true);
  }
}

function assertToolOutputsRoundTrip(requests, responses) {
  for (let responseIndex = 0; responseIndex < responses.length - 1; responseIndex += 1) {
    const calls = responses[responseIndex].output.filter((item) => item.type === "function_call");
    if (!calls.length) continue;
    const nextInput = requests[responseIndex + 1].input;
    for (const call of calls) {
      const matches = nextInput.filter((item) => (
        item?.type === "function_call_output" && item.call_id === call.call_id
      ));
      assert.equal(matches.length, 1, `tool output did not round-trip call_id ${call.call_id}`);
      assert.equal(typeof matches[0].output, "string");
      assert.doesNotThrow(() => JSON.parse(matches[0].output));
    }
  }
}

function toolOutput(request, callId) {
  const item = request.input.find((entry) => (
    entry?.type === "function_call_output" && entry.call_id === callId
  ));
  assert.ok(item, `missing tool output ${callId}`);
  return JSON.parse(item.output);
}
