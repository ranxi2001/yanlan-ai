import test from "node:test";
import assert from "node:assert/strict";
import { correctTranscript, DEFAULT_CONFIG } from "../src/api.js";
import {
  createTerminologyAgentProfile,
  createTerminologyCanonicalReviewInventory,
  createTerminologySignalInventory,
} from "../src/agent/profiles/terminology.js";

const responsesConfig = {
  ...DEFAULT_CONFIG,
  chatBaseUrl: "https://gpt.example/v1",
  chatApiKey: "gpt-test-key",
  chatModel: "gpt-5.6-luna",
  chatProtocol: "responses",
  chatPath: "responses",
  contextHint: "terms: Descheduler",
  canonicalArbitration: false,
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
    toolResponse("scan", [toolCall("call_scan", "scan_alias_occurrences", { mappings })]),
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
  assert.deepEqual(run.agentRun.usage, { modelTurns: 6, toolCalls: 6 });
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
    "term.finalized",
    "run.completed",
  ]) assert.ok(traceTypes.includes(expected), `missing trace event ${expected}`);
  assert.equal(traceTypes.filter((type) => type === "term.alias_scanned").length, 3);
});

test("close ordinary English words remain distinct and unanchored phrases never become required mappings", async () => {
  const rawSegments = [
    { start_seconds: 0, end_seconds: 4, speaker: "A", text: "containerd runs the containers." },
    { start_seconds: 4, end_seconds: 8, speaker: "A", text: "restart containerd but preserve containers." },
  ];
  const inventory = createTerminologySignalInventory(rawSegments);
  assert.equal(inventory.some((signal) => signalTerms(signal).some((term) => /containerd (?:runs|but)/u.test(term))), false);
  const ordinaryGroup = inventory.find((signal) => (
    signal.kind === "surface_variant_group"
    && new Set(signal.terms.map((term) => term.text)).has("containerd")
    && new Set(signal.terms.map((term) => term.text)).has("containers")
  ));
  assert.ok(ordinaryGroup);
  assert.equal(ordinaryGroup.required_disposition, "review");

  let finalizedMappings;
  const profile = createTerminologyAgentProfile({
    segments: rawSegments,
    canonicalTerms: ["containerd"],
    scanOccurrences: () => [],
    finalizeMappings: ({ mappings }) => {
      finalizedMappings = mappings;
      return { segments: rawSegments, terminology: [], corrections: [], rejectedCorrections: 0, semanticJoins: 0 };
    },
  });
  const tools = new Map(profile.tools.map((tool) => [tool.name, tool]));
  const trace = { append() {} };
  let state = tools.get("read_transcript_window").execute({ start_segment: 0, max_segments: 2 }, { state: profile.initialState, trace }).state;
  const inspected = tools.get("inspect_terminology_signals").execute({}, { state, trace });
  state = inspected.state;
  const signal = inspected.output.signals.find((item) => item.id === ordinaryGroup.id);
  const resolved = tools.get("resolve_terminology_signals").execute({
    decisions: [{
      signal_id: signal.id,
      disposition: "distinct_terms",
      canonical: "",
      reason: "containerd is a runtime identifier while containers is an ordinary plural noun.",
    }],
  }, { state, trace });
  assert.equal(resolved.output.ok, true);
  const finalized = await tools.get("finalize_correction").execute({ mappings: [], join_after: [] }, { state: resolved.state, trace });
  assert.equal(finalized.output.ok, true);
  assert.deepEqual(finalizedMappings, []);
});

test("fused and spaced identifier variants still form a required mapping group", () => {
  const inventory = createTerminologySignalInventory([
    { start_seconds: 0, end_seconds: 3, speaker: "A", text: "disk scheduler starts." },
    { start_seconds: 3, end_seconds: 6, speaker: "A", text: "dis scheduler continues." },
    { start_seconds: 6, end_seconds: 9, speaker: "A", text: "DisScheduler reports status." },
  ]);
  const group = inventory.find((signal) => signal.kind === "surface_variant_group" && signal.terms.some((term) => term.text === "DisScheduler"));
  assert.ok(group);
  assert.equal(group.required_disposition, "mapped");
  assert.deepEqual(new Set(group.terms.map((term) => term.text)), new Set(["disk scheduler", "dis scheduler", "DisScheduler"]));
});

test("sentence casing and repeated ordinary predicates do not create phrase terminology signals", () => {
  const inventory = createTerminologySignalInventory([
    { start_seconds: 0, end_seconds: 3, speaker: "A", text: "Color palette is documented." },
    { start_seconds: 3, end_seconds: 6, speaker: "A", text: "color palette is approved." },
    { start_seconds: 6, end_seconds: 9, speaker: "A", text: "Car rental is available." },
    { start_seconds: 9, end_seconds: 12, speaker: "A", text: "car rental is closed." },
    { start_seconds: 12, end_seconds: 15, speaker: "A", text: "containerd reports status." },
    { start_seconds: 15, end_seconds: 18, speaker: "A", text: "ContainerD reports status." },
  ]);
  const phraseTerms = inventory.flatMap(signalTerms).filter((term) => /\s/u.test(term));
  assert.deepEqual(phraseTerms, []);
});

test("batched occurrence scans stay below the Harness output budget", () => {
  const profile = createTerminologyAgentProfile({
    segments: [],
    scanOccurrences: () => Array.from({ length: 500 }, (_, index) => ({
      segment_id: index,
      start_offset: index * 200,
      end_offset: index * 200 + 120,
      matched_text: "PRIVATE_TRANSCRIPT_SENTINEL".repeat(8),
    })),
    finalizeMappings: () => ({ corrections: [] }),
  });
  const scan = profile.tools.find((tool) => tool.name === "scan_alias_occurrences");
  const mappingsToScan = Array.from({ length: 20 }, (_, index) => ({
    alias: `A${String(index).padStart(2, "0")}${"x".repeat(117)}`,
    canonical: `B${String(index).padStart(2, "0")}${"y".repeat(117)}`,
  }));
  const result = scan.execute({ mappings: mappingsToScan }, { trace: { append() {} } });
  assert.ok(JSON.stringify(result.output).length < 60_000);
  assert.equal(result.output.results.length, 20);
  assert.equal(result.output.results.every((entry) => (
    entry.occurrence_count === 500
    && entry.truncated === true
    && entry.occurrences.length === 20
    && entry.occurrences.every((occurrence) => !Object.hasOwn(occurrence, "matched_text"))
  )), true);
  assert.doesNotMatch(JSON.stringify(result.output), /PRIVATE_TRANSCRIPT_SENTINEL/u);
});

test("a chat-shaped 200 response from a Responses endpoint uses the bounded correction workflow", async () => {
  const meeting = sourceMeeting([{
    start_seconds: 0,
    end_seconds: 4,
    speaker: "A",
    text: "今天讨论万福来项目。",
  }]);
  const workflowResult = JSON.stringify({ patches: [], join_after: [] });
  const responses = [
    { choices: [{ message: { content: workflowResult } }] },
    { choices: [{ message: { content: workflowResult } }] },
  ];

  const { requests, run } = await withResponsesFetch(responses, () => correctTranscript({
    config: {
      ...responsesConfig,
      contextHint: "术语：万福来 -> OneFly",
    },
    meeting,
  }));

  assert.equal(Array.isArray(requests[0].tools), true);
  assert.equal(requests[1].tools, undefined);
  assert.deepEqual(run.segments.map((segment) => segment.text), ["今天讨论OneFly项目。"]);
  assert.equal(run.agentRun.status, "unsupported");
  assert.deepEqual(run.agentRun.usage, { modelTurns: 1, toolCalls: 0 });
  assert.equal(run.agentRun.canonicalReview.status, "skipped");
});

test("canonical spelling arbitration is isolated from transcript prose and constrains the terminology agent", async () => {
  const rawSegments = [
    { start_seconds: 0, end_seconds: 3, speaker: "A", text: "disk scheduler starts checking." },
    { start_seconds: 3, end_seconds: 6, speaker: "A", text: "dis scheduler continues checking." },
    { start_seconds: 6, end_seconds: 9, speaker: "B", text: "DisScheduler reports the result." },
    { start_seconds: 9, end_seconds: 12, speaker: "B", text: "The pod is unscheduleable." },
    { start_seconds: 12, end_seconds: 15, speaker: "B", text: "The pod remains unschedulible." },
  ];
  const canonicalMappings = [
    ...["disk scheduler", "dis scheduler", "DisScheduler"].map((alias) => ({ alias, canonical: "Descheduler" })),
    { alias: "unscheduleable", canonical: "unschedulable" },
    { alias: "unschedulible", canonical: "unschedulable" },
  ];
  const responses = [
    completedMessageResponse("canonical-review", JSON.stringify({
      reviews: [{
        signal_id: "surface-1",
        canonical: "Descheduler",
        confidence: "high",
        rationale: "Kubernetes uses Descheduler as the official project name.",
      }],
    })),
    completedMessageResponse("canonical-review-distractor", JSON.stringify({
      reviews: [{
        signal_id: "surface-1",
        canonical: "DAGScheduler",
        confidence: "high",
        rationale: "A false-friend expansion suggested a different scheduler name.",
      }],
    })),
    completedMessageResponse("canonical-review-confirmation", JSON.stringify({
      reviews: [{
        signal_id: "surface-1",
        canonical: "DisScheduler",
        confidence: "high",
        rationale: "Naming morphology incorrectly favored the noisy CamelCase surface.",
      }],
    })),
    completedMessageResponse("canonical-review-unschedulable", JSON.stringify({
      reviews: [{
        signal_id: "surface-2",
        canonical: "unschedulable",
        confidence: "high",
        rationale: "Kubernetes uses unschedulable as the established scheduling term.",
      }],
    })),
    completedMessageResponse("canonical-review-adjudication", JSON.stringify({
      reviews: [{
        signal_id: "surface-1",
        canonical: "Descheduler",
        confidence: "high",
        rationale: "The official Kubernetes project identifier is Descheduler.",
      }],
    })),
    toolResponse("read-reviewed", [toolCall("call_read_reviewed", "read_transcript_window", {
      start_segment: 0,
      max_segments: 5,
    })]),
    toolResponse("inspect-reviewed", [toolCall("call_inspect_reviewed", "inspect_terminology_signals", {})]),
    toolResponse("resolve-wrong", [toolCall("call_resolve_wrong", "resolve_terminology_signals", {
      decisions: [{
        signal_id: "surface-1",
        disposition: "mapped",
        canonical: "DisScheduler",
        reason: "Attempt to follow the most frequent ASR surface.",
      }, {
        signal_id: "surface-2",
        disposition: "mapped",
        canonical: "unschedulable",
        reason: "Use the established Kubernetes scheduling term.",
      }],
    })]),
    toolResponse("submit-reviewed", [toolCall("call_submit_reviewed", "submit_term_candidates", {
      candidates: canonicalMappings.map((mapping, index) => ({
        ...mapping,
        evidence_segment_ids: [index],
        confidence: "high",
      })),
    })]),
    toolResponse("resolve-reviewed", [toolCall("call_resolve_reviewed", "resolve_terminology_signals", {
      decisions: [{
        signal_id: "surface-1",
        disposition: "mapped",
        canonical: "Descheduler",
        reason: "The independent spelling review identifies the official Kubernetes project.",
      }],
    })]),
    toolResponse("finalize-reviewed", [toolCall("call_finalize_reviewed", "finalize_correction", {
      mappings: canonicalMappings,
      join_after: [],
    })]),
  ];

  const { requests, run } = await withResponsesFetch(responses, () => correctTranscript({
    config: {
      ...responsesConfig,
      canonicalArbitration: true,
      contextHint: "云原生 Kubernetes 调度与任务类型适配方案周会",
    },
    meeting: sourceMeeting(rawSegments),
  }));

  assert.equal(typeof requests[0].input, "string");
  assert.equal("tools" in requests[0], false);
  assert.equal("tools" in requests[1], false);
  assert.equal("tools" in requests[2], false);
  assert.equal("tools" in requests[3], false);
  assert.equal("tools" in requests[4], false);
  assert.deepEqual(requests.slice(0, 5).map((request) => request.max_output_tokens), [512, 512, 512, 512, 512]);
  assert.equal(JSON.parse(requests[0].input).surface_variant_group.signal_id, "surface-1");
  assert.equal(JSON.parse(requests[1].input).surface_variant_group.signal_id, "surface-1");
  assert.equal(JSON.parse(requests[2].input).surface_variant_group.signal_id, "surface-1");
  assert.equal(JSON.parse(requests[3].input).surface_variant_group.signal_id, "surface-2");
  assert.deepEqual(new Set([0, 1, 2].map((index) => JSON.parse(requests[index].input).independent_review_perspective)), new Set([
    "official_registry",
    "false_friend_critic",
    "naming_morphology",
  ]));
  assert.match(requests[0].input, /disk scheduler/u);
  const adjudicationInput = JSON.parse(requests[4].input);
  assert.equal(adjudicationInput.surface_variant_group.signal_id, "surface-1");
  assert.deepEqual(adjudicationInput.independent_reviews.map((review) => review.canonical), [
    "Descheduler",
    "DAGScheduler",
    "DisScheduler",
  ]);
  assert.doesNotMatch(requests.slice(0, 5).map((request) => request.input).join("\n"), /starts checking|continues checking|reports the result/u);
  const agentInput = JSON.parse(requests[5].input.find((item) => item?.role === "user").content);
  assert.equal(agentInput.canonical_spelling_reviews.find((review) => review.signal_id === "surface-2").confidence, "medium");
  const rejected = toolOutput(requests[8], "call_resolve_wrong");
  assert.deepEqual(rejected.rejected, [{
    signal_id: "surface-1",
    reason: "canonical_spelling_review_mismatch",
    reviewed_canonical: "Descheduler",
    canonical_source: "independent_review",
  }]);
  assert.deepEqual(run.segments.map((segment) => segment.text), [
    "Descheduler starts checking.",
    "Descheduler continues checking.",
    "Descheduler reports the result.",
    "The pod is unschedulable.",
    "The pod remains unschedulable.",
  ]);
  assert.deepEqual(transcriptGeometry(run.segments), transcriptGeometry(rawSegments));
  assertToolOutputsRoundTrip(requests.slice(5), responses.slice(5));
  assert.equal(run.agentRun.usage.canonicalReviewTurns, 5);
});

test("a pure CamelCase typo group receives three bounded independent spelling votes", async () => {
  const rawSegments = [
    { start_seconds: 0, end_seconds: 3, speaker: "A", text: "Descheduler starts." },
    { start_seconds: 3, end_seconds: 6, speaker: "A", text: "DisScheduler continues." },
  ];
  const mapping = { alias: "DisScheduler", canonical: "Descheduler" };
  const review = (id, perspective) => completedMessageResponse(id, JSON.stringify({
    reviews: [{
      signal_id: "surface-1",
      canonical: "Descheduler",
      confidence: "high",
      rationale: perspective,
    }],
  }));
  const responses = [
    review("pure-review-1", "Official identifier."),
    review("pure-review-2", "False-friend check."),
    review("pure-review-3", "Naming morphology."),
    toolResponse("pure-read", [toolCall("call_pure_read", "read_transcript_window", { start_segment: 0, max_segments: 2 })]),
    toolResponse("pure-inspect", [toolCall("call_pure_inspect", "inspect_terminology_signals", {})]),
    toolResponse("pure-submit", [toolCall("call_pure_submit", "submit_term_candidates", {
      candidates: [{ ...mapping, evidence_segment_ids: [1], confidence: "high" }],
    })]),
    toolResponse("pure-resolve", [toolCall("call_pure_resolve", "resolve_terminology_signals", {
      decisions: [{
        signal_id: "surface-1",
        disposition: "mapped",
        canonical: "Descheduler",
        reason: "Independent spelling votes reached a high-confidence majority.",
      }],
    })]),
    toolResponse("pure-finalize", [toolCall("call_pure_finalize", "finalize_correction", {
      mappings: [mapping],
      join_after: [],
    })]),
  ];

  const { requests, run } = await withResponsesFetch(responses, () => correctTranscript({
    config: {
      ...responsesConfig,
      canonicalArbitration: true,
      contextHint: "Kubernetes scheduling component meeting",
    },
    meeting: sourceMeeting(rawSegments),
  }));
  assert.deepEqual(requests.slice(0, 3).map((request) => request.max_output_tokens), [512, 512, 512]);
  assert.equal(Array.isArray(requests[3].tools), true);
  assert.deepEqual(run.segments.map((segment) => segment.text), ["Descheduler starts.", "Descheduler continues."]);
  assert.equal(run.agentRun.canonicalReview.highConfidenceGroups, 1);
  assert.equal(run.agentRun.usage.canonicalReviewTurns, 3);
});

test("a consensus spelling review with missing votes reports degraded", async () => {
  const rawSegments = [
    { start_seconds: 0, end_seconds: 3, speaker: "A", text: "Descheduler starts." },
    { start_seconds: 3, end_seconds: 6, speaker: "A", text: "DisScheduler continues." },
    { start_seconds: 6, end_seconds: 9, speaker: "A", text: "DeScheduler reports." },
  ];
  const partialMappings = [
    { alias: "DisScheduler", canonical: "Descheduler" },
    { alias: "DeScheduler", canonical: "Descheduler" },
  ];
  const responses = [
    completedMessageResponse("partial-review-1", JSON.stringify({
      reviews: [{
        signal_id: "surface-1",
        canonical: "Descheduler",
        confidence: "high",
        rationale: "Established public identifier spelling.",
      }],
    })),
    completedMessageResponse("partial-review-2", JSON.stringify({
      reviews: [{
        signal_id: "surface-1",
        canonical: "Descheduler",
        confidence: "high",
        rationale: "A second reviewer agrees on the established public spelling.",
      }],
    })),
    completedMessageResponse("partial-review-3", JSON.stringify({ reviews: [] })),
    toolResponse("partial-read", [toolCall("call_partial_read", "read_transcript_window", {
      start_segment: 0,
      max_segments: 3,
    })]),
    toolResponse("partial-inspect", [toolCall("call_partial_inspect", "inspect_terminology_signals", {})]),
    toolResponse("partial-submit", [toolCall("call_partial_submit", "submit_term_candidates", {
      candidates: partialMappings.map((mapping, index) => ({
        ...mapping,
        evidence_segment_ids: [index + 1],
        confidence: "high",
      })),
    })]),
    toolResponse("partial-resolve", [toolCall("call_partial_resolve", "resolve_terminology_signals", {
      decisions: [{
        signal_id: "surface-1",
        disposition: "mapped",
        canonical: "Descheduler",
        reason: "The transcript variants refer to one established component.",
      }],
    })]),
    toolResponse("partial-finalize", [toolCall("call_partial_finalize", "finalize_correction", {
      mappings: partialMappings,
      join_after: [],
    })]),
  ];

  const { requests, run } = await withResponsesFetch(responses, () => correctTranscript({
    config: {
      ...responsesConfig,
      canonicalArbitration: true,
      contextHint: "Kubernetes scheduling component meeting",
    },
    meeting: sourceMeeting(rawSegments),
  }));

  assert.equal(Array.isArray(requests[3].tools), true);
  assert.equal(run.agentRun.status, "degraded");
  assert.deepEqual(run.agentRun.canonicalReview, {
    status: "degraded",
    requestedGroups: 1,
    reviewedGroups: 1,
    highConfidenceGroups: 0,
    requestAttempted: true,
    incompleteReviewGroups: 1,
    reason: "incomplete_response",
  });
  assert.equal(run.agentRun.usage.canonicalReviewTurns, 3);
  assert.deepEqual(run.segments.map((segment) => segment.text), [
    "Descheduler starts.",
    "Descheduler continues.",
    "Descheduler reports.",
  ]);
});

test("a missing conflict adjudication cannot turn a partial majority into canonical authority", async () => {
  const rawSegments = [
    { start_seconds: 0, end_seconds: 3, speaker: "A", text: "Descheduler starts." },
    { start_seconds: 3, end_seconds: 6, speaker: "A", text: "DisScheduler continues." },
    { start_seconds: 6, end_seconds: 9, speaker: "A", text: "DeScheduler reports." },
  ];
  const finalMappings = [
    { alias: "DisScheduler", canonical: "Descheduler" },
    { alias: "DeScheduler", canonical: "Descheduler" },
  ];
  const responses = [
    completedMessageResponse("conflict-review-1", JSON.stringify({
      reviews: [{ signal_id: "surface-1", canonical: "Descheduler", confidence: "high", rationale: "Official identifier." }],
    })),
    completedMessageResponse("conflict-review-2", JSON.stringify({
      reviews: [{ signal_id: "surface-1", canonical: "DisScheduler", confidence: "high", rationale: "Noisy surface." }],
    })),
    completedMessageResponse("conflict-review-3", JSON.stringify({
      reviews: [{ signal_id: "surface-1", canonical: "DisScheduler", confidence: "high", rationale: "Noisy morphology." }],
    })),
    completedMessageResponse("conflict-adjudication-empty", JSON.stringify({ reviews: [] })),
    toolResponse("conflict-read", [toolCall("call_conflict_read", "read_transcript_window", {
      start_segment: 0,
      max_segments: 3,
    })]),
    toolResponse("conflict-inspect", [toolCall("call_conflict_inspect", "inspect_terminology_signals", {})]),
    toolResponse("conflict-submit", [toolCall("call_conflict_submit", "submit_term_candidates", {
      candidates: finalMappings.map((mapping, index) => ({
        ...mapping,
        evidence_segment_ids: [index + 1],
        confidence: "high",
      })),
    })]),
    toolResponse("conflict-resolve", [toolCall("call_conflict_resolve", "resolve_terminology_signals", {
      decisions: [{
        signal_id: "surface-1",
        disposition: "mapped",
        canonical: "Descheduler",
        reason: "Recording and domain evidence establish the official identifier.",
      }],
    })]),
    toolResponse("conflict-finalize", [toolCall("call_conflict_finalize", "finalize_correction", {
      mappings: finalMappings,
      join_after: [],
    })]),
  ];

  const { requests, run } = await withResponsesFetch(responses, () => correctTranscript({
    config: {
      ...responsesConfig,
      canonicalArbitration: true,
      contextHint: "Kubernetes scheduling component meeting",
    },
    meeting: sourceMeeting(rawSegments),
  }));

  const agentInput = JSON.parse(requests[4].input.find((item) => item?.role === "user").content);
  assert.equal(agentInput.canonical_spelling_reviews[0].confidence, "medium");
  assert.deepEqual(run.agentRun.canonicalReview, {
    status: "degraded",
    requestedGroups: 1,
    reviewedGroups: 1,
    highConfidenceGroups: 0,
    requestAttempted: true,
    incompleteReviewGroups: 1,
    reason: "incomplete_response",
  });
  assert.deepEqual(run.segments.map((segment) => segment.text), [
    "Descheduler starts.",
    "Descheduler continues.",
    "Descheduler reports.",
  ]);
});

test("canonical arbitration reports confirmation-budget degradation after four consensus groups", async () => {
  const variants = [
    ["Descheduler", "DisScheduler"],
    ["AgentCube", "AgentQube"],
    ["CloudController", "CloudControler"],
    ["NodeManager", "NodeManagr"],
    ["ResourceBinding", "ResourceBindng"],
  ];
  const rawSegments = variants.flatMap((pair, groupIndex) => pair.map((text, variantIndex) => ({
    start_seconds: (groupIndex * 6) + (variantIndex * 3),
    end_seconds: (groupIndex * 6) + (variantIndex * 3) + 3,
    speaker: "A",
    text: `${text} starts.`,
  })));
  const inventory = createTerminologyCanonicalReviewInventory({ segments: rawSegments });
  assert.equal(inventory.length, 5);
  const canonicalBySignal = new Map(inventory.map((signal, index) => [signal.id, variants[index][0]]));
  const reviewResponses = inventory.flatMap((signal, index) => {
    const voteCount = index < 4 ? 3 : 1;
    return Array.from({ length: voteCount }, (_, voteIndex) => completedMessageResponse(
      `budget-review-${index}-${voteIndex}`,
      JSON.stringify({
        reviews: [{
          signal_id: signal.id,
          canonical: canonicalBySignal.get(signal.id),
          confidence: "high",
          rationale: "Established public identifier spelling.",
        }],
      }),
    ));
  });
  const mappings = variants.slice(0, 4).map(([canonical, alias]) => ({ alias, canonical }));
  const responses = [
    ...reviewResponses,
    toolResponse("budget-read", [toolCall("call_budget_read", "read_transcript_window", {
      start_segment: 0,
      max_segments: rawSegments.length,
    })]),
    toolResponse("budget-inspect", [toolCall("call_budget_inspect", "inspect_terminology_signals", {})]),
    toolResponse("budget-submit", [toolCall("call_budget_submit", "submit_term_candidates", {
      candidates: mappings.map((mapping, index) => ({
        ...mapping,
        evidence_segment_ids: [(index * 2) + 1],
        confidence: "high",
      })),
    })]),
    toolResponse("budget-resolve", [toolCall("call_budget_resolve", "resolve_terminology_signals", {
      decisions: inventory.map((signal, index) => index < 4 ? ({
        signal_id: signal.id,
        disposition: "mapped",
        canonical: canonicalBySignal.get(signal.id),
        reason: "The independent reviews establish one public component spelling.",
      }) : ({
        signal_id: signal.id,
        disposition: "distinct_terms",
        canonical: "",
        reason: "A single review cannot authorize merging this final variant group.",
      })),
    })]),
    toolResponse("budget-finalize", [toolCall("call_budget_finalize", "finalize_correction", {
      mappings,
      join_after: [],
    })]),
  ];

  const { requests, run } = await withResponsesFetch(responses, () => correctTranscript({
    config: {
      ...responsesConfig,
      canonicalArbitration: true,
      contextHint: "Public cloud-native component naming review",
    },
    meeting: sourceMeeting(rawSegments),
  }));

  assert.equal(reviewResponses.length, 13);
  assert.equal(Array.isArray(requests[13].tools), true);
  assert.equal(run.agentRun.status, "degraded");
  assert.deepEqual(run.agentRun.canonicalReview, {
    status: "degraded",
    requestedGroups: 5,
    reviewedGroups: 5,
    highConfidenceGroups: 4,
    requestAttempted: true,
    budgetLimitedGroups: 1,
    reason: "confirmation_budget_exhausted",
  });
  assert.equal(run.agentRun.usage.canonicalReviewTurns, 13);
  const agentInput = JSON.parse(requests[13].input.find((item) => item?.role === "user").content);
  assert.equal(agentInput.canonical_spelling_reviews.find((review) => review.signal_id === inventory[4].id).confidence, "medium");
});

test("the terminology Agent budget covers a four-hour recording at default chunk cadence", async () => {
  const rawSegments = Array.from({ length: 1_440 }, (_, index) => ({
    start_seconds: index * 10,
    end_seconds: (index + 1) * 10,
    speaker: "A",
    text: "今天同步常规进度。",
  }));
  const profile = createTerminologyAgentProfile({
    segments: rawSegments,
    scanOccurrences: () => [],
    finalizeMappings: () => ({ segments: rawSegments, corrections: [] }),
  });
  assert.deepEqual({
    readTurns: profile.budgetHints.readTurns,
    minimumModelTurns: profile.budgetHints.minimumModelTurns,
    recommendedModelTurns: profile.budgetHints.recommendedModelTurns,
  }, {
    readTurns: 24,
    minimumModelTurns: 26,
    recommendedModelTurns: 36,
  });

  const responses = [
    ...Array.from({ length: 24 }, (_, index) => toolResponse(
      `long-read-${index}`,
      [toolCall(`call_long_read_${index}`, "read_transcript_window", {
        start_segment: index * 60,
        max_segments: 60,
      })],
    )),
    toolResponse("long-inspect", [toolCall("call_long_inspect", "inspect_terminology_signals", {})]),
    toolResponse("long-finalize", [toolCall("call_long_finalize", "finalize_correction", {
      mappings: [],
      join_after: [],
    })]),
  ];
  const { run } = await withResponsesFetch(responses, () => correctTranscript({
    config: responsesConfig,
    meeting: sourceMeeting(rawSegments),
  }));

  assert.equal(run.agentRun.status, "completed");
  assert.equal(run.agentRun.usage.modelTurns, 26);
  assert.equal(run.agentRun.usage.toolCalls, 26);
  assert.equal(run.segments.length, 1_440);
});

test("authoritative user mappings skip canonical arbitration requests", async () => {
  const rawSegments = [
    { start_seconds: 0, end_seconds: 3, speaker: "A", text: "disk scheduler starts." },
    { start_seconds: 3, end_seconds: 6, speaker: "A", text: "dis scheduler continues." },
  ];
  const finalMappings = mappings.slice(0, 2);
  const responses = [
    toolResponse("read-explicit", [toolCall("call_read_explicit", "read_transcript_window", {
      start_segment: 0,
      max_segments: 2,
    })]),
    toolResponse("inspect-explicit", [toolCall("call_inspect_explicit", "inspect_terminology_signals", {})]),
    toolResponse("submit-explicit", [toolCall("call_submit_explicit", "submit_term_candidates", {
      candidates: [{ ...finalMappings[1], evidence_segment_ids: [1], confidence: "high" }],
    })]),
    toolResponse("resolve-explicit", [toolCall("call_resolve_explicit", "resolve_terminology_signals", {
      decisions: [{
        signal_id: "surface-1",
        disposition: "mapped",
        canonical: "Descheduler",
        reason: "Follow the user's authoritative mapping for this variant group.",
      }],
    })]),
    toolResponse("finalize-explicit", [toolCall("call_finalize_explicit", "finalize_correction", {
      mappings: finalMappings,
      join_after: [],
    })]),
  ];

  const { requests, run } = await withResponsesFetch(responses, () => correctTranscript({
    config: {
      ...responsesConfig,
      canonicalArbitration: true,
      contextHint: "术语：disk scheduler -> Descheduler，dis scheduler -> Descheduler",
    },
    meeting: sourceMeeting(rawSegments),
  }));

  assert.equal(Array.isArray(requests[0].tools), true, "an unnecessary arbitration request ran before the Agent");
  assert.deepEqual(run.segments.map((segment) => segment.text), ["Descheduler starts.", "Descheduler continues."]);
  assert.deepEqual(run.agentRun.canonicalReview, {
    status: "skipped",
    requestedGroups: 0,
    reviewedGroups: 0,
    highConfidenceGroups: 0,
    requestAttempted: false,
  });
});

test("an incomplete canonical arbitration response is observable as a degraded Agent run", async () => {
  const rawSegments = [
    { start_seconds: 0, end_seconds: 3, speaker: "A", text: "disk scheduler starts." },
    { start_seconds: 3, end_seconds: 6, speaker: "A", text: "dis scheduler continues." },
  ];
  const finalMappings = mappings.slice(0, 2);
  const responses = [
    completedMessageResponse("incomplete-review", JSON.stringify({ reviews: [] })),
    toolResponse("read-degraded", [toolCall("call_read_degraded", "read_transcript_window", {
      start_segment: 0,
      max_segments: 2,
    })]),
    toolResponse("inspect-degraded", [toolCall("call_inspect_degraded", "inspect_terminology_signals", {})]),
    toolResponse("submit-degraded", [toolCall("call_submit_degraded", "submit_term_candidates", {
      candidates: finalMappings.map((mapping, index) => ({
        ...mapping,
        evidence_segment_ids: [index],
        confidence: "high",
      })),
    })]),
    toolResponse("resolve-degraded", [toolCall("call_resolve_degraded", "resolve_terminology_signals", {
      decisions: [{
        signal_id: "surface-1",
        disposition: "mapped",
        canonical: "Descheduler",
        reason: "Resolve from recording and domain evidence after the specialist response was incomplete.",
      }],
    })]),
    toolResponse("finalize-degraded", [toolCall("call_finalize_degraded", "finalize_correction", {
      mappings: finalMappings,
      join_after: [],
    })]),
  ];

  const { run } = await withResponsesFetch(responses, () => correctTranscript({
    config: {
      ...responsesConfig,
      canonicalArbitration: true,
      contextHint: "云原生 Kubernetes 调度周会",
    },
    meeting: sourceMeeting(rawSegments),
  }));

  assert.equal(run.agentRun.status, "degraded");
  assert.deepEqual(run.agentRun.canonicalReview, {
    status: "degraded",
    requestedGroups: 1,
    reviewedGroups: 0,
    highConfidenceGroups: 0,
    requestAttempted: true,
    incompleteReviewGroups: 1,
    reason: "incomplete_response",
  });
  assert.equal(run.agentRun.usage.canonicalReviewTurns, 1);
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
  assert.deepEqual(run.agentRun.usage, { modelTurns: 4, toolCalls: 4 });
});

test("full transcript coverage cannot bypass inventory inspection even when a review-only group is dismissed", async () => {
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
  const inspection = toolOutput(requests[3], "call_inspect_after_empty");
  assert.equal(inspection.signals.find((signal) => signal.id === "surface-1").required_disposition, "review");
  const dismissed = toolOutput(requests[4], "call_dismiss_after_empty");
  assert.equal(dismissed.ok, true);
  assert.deepEqual(dismissed.rejected, []);
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
    toolResponse("finalize-unrelated", [toolCall("call_finalize_unrelated", "finalize_correction", {
      mappings: allMappings,
      join_after: [],
    })]),
    toolResponse("reject-unrelated", [toolCall("call_reject_unrelated", "reject_term_candidates", {
      candidates: [unrelated],
      reason: "The occurrence is distant from the canonical entity context.",
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
  const rejectedFinalize = toolOutput(requests[5], "call_finalize_unrelated");
  assert.equal(rejectedFinalize.ok, false);
  assert.ok(rejectedFinalize.violations.some((violation) => (
    violation.code === "runtime_mapping_rejected" && violation.alias === "weekly update"
  )));
  const rejectedCandidate = toolOutput(requests[6], "call_reject_unrelated");
  assert.equal(rejectedCandidate.ok, true);
  assert.deepEqual(rejectedCandidate.removed.map(({ alias, canonical }) => ({ alias, canonical })), [unrelated]);
  const traceTypes = run.agentRun.trace.map((event) => event.type);
  assert.equal(traceTypes.filter((type) => type === "term.finalize_rejected").length, 1);
  assert.equal(traceTypes.filter((type) => type === "term.candidates_rejected").length, 1);
  assert.equal(traceTypes.filter((type) => type === "term.finalized").length, 1);
});

test("a signal-bound MiMo review cannot authorize a different low-confidence alias in the same segment", async () => {
  const rawSegments = [
    { start_seconds: 0, end_seconds: 3, speaker: "A", text: "disk scheduler starts." },
    { start_seconds: 3, end_seconds: 6, speaker: "A", text: "dis scheduler keeps weekly update beside Y调度。" },
  ];
  const anchoredMappings = mappings.slice(0, 2);
  const unrelated = { alias: "weekly update", canonical: "Descheduler" };
  const proposedMappings = [...anchoredMappings, unrelated];
  let audioCalls = 0;
  const responses = [
    toolResponse("read-audio-borrow", [toolCall("call_read_audio_borrow", "read_transcript_window", {
      start_segment: 0,
      max_segments: 2,
    })]),
    toolResponse("inspect-audio-borrow", [toolCall("call_inspect_audio_borrow", "inspect_terminology_signals", {})]),
    toolResponse("submit-audio-borrow", [toolCall("call_submit_audio_borrow", "submit_term_candidates", {
      candidates: [
        { ...anchoredMappings[0], evidence_segment_ids: [0], confidence: "high" },
        { ...anchoredMappings[1], evidence_segment_ids: [1], confidence: "high" },
        { ...unrelated, evidence_segment_ids: [1], confidence: "low" },
      ],
    })]),
    toolResponse("resolve-surface-borrow", [toolCall("call_resolve_surface_borrow", "resolve_terminology_signals", {
      decisions: [{
        signal_id: "surface-1",
        disposition: "mapped",
        canonical: "Descheduler",
        reason: "The two repeated spellings identify one scheduler component.",
      }],
    })]),
    toolResponse("review-y-only", [toolCall("call_review_y_only", "transcribe_audio_range", {
      start_seconds: 3,
      end_seconds: 6,
      signal_ids: ["context-1"],
      segment_ids: [1],
      reason: "Resolve only the Y scheduling signal.",
    })]),
    toolResponse("dismiss-y-only", [toolCall("call_dismiss_y_only", "resolve_terminology_signals", {
      decisions: [{
        signal_id: "context-1",
        disposition: "not_terminology",
        canonical: "",
        reason: "MiMo hears a different phrase for the Y scheduling signal.",
      }],
    })]),
    toolResponse("finalize-audio-borrow", [toolCall("call_finalize_audio_borrow", "finalize_correction", {
      mappings: proposedMappings,
      join_after: [],
    })]),
    toolResponse("reject-audio-borrow", [toolCall("call_reject_audio_borrow", "reject_term_candidates", {
      candidates: [unrelated],
      reason: "The Y signal review is not evidence for weekly update.",
    })]),
    toolResponse("finalize-after-audio-borrow", [toolCall("call_finalize_after_audio_borrow", "finalize_correction", {
      mappings: anchoredMappings,
      join_after: [],
    })]),
  ];

  const { requests, run } = await withResponsesFetch(responses, () => correctTranscript({
    config: { ...responsesConfig, contextHint: "" },
    meeting: sourceMeeting(rawSegments),
    transcribeAudioRange: async () => {
      audioCalls += 1;
      return { text: "dis scheduler keeps weekly update beside 外部调度。", segments: [] };
    },
  }));

  assert.equal(audioCalls, 1);
  const rejectedFinalize = toolOutput(requests[7], "call_finalize_audio_borrow");
  assert.equal(rejectedFinalize.ok, false);
  assert.ok(rejectedFinalize.violations.some((violation) => (
    violation.code === "runtime_mapping_rejected"
    && violation.alias === "weekly update"
  )));
  assert.deepEqual(run.segments.map((segment) => segment.text), [
    "Descheduler starts.",
    "Descheduler keeps weekly update beside Y调度。",
  ]);
  assert.equal(run.corrections.length, 2);
  assert.equal(run.rejectedCorrections, 0);
});

test("a dismissed contextual signal cannot be smuggled into the final mapping group", async () => {
  const rawSegments = [
    { start_seconds: 0, end_seconds: 3, speaker: "A", text: "disk scheduler starts." },
    { start_seconds: 3, end_seconds: 6, speaker: "A", text: "result绑定 follows dis scheduler." },
  ];
  const anchoredMappings = mappings.slice(0, 2);
  const smuggled = { alias: "result绑定", canonical: "Descheduler" };
  const proposedMappings = [...anchoredMappings, smuggled];
  const responses = [
    toolResponse("read-smuggled", [toolCall("call_read_smuggled", "read_transcript_window", {
      start_segment: 0,
      max_segments: 2,
    })]),
    toolResponse("inspect-smuggled", [toolCall("call_inspect_smuggled", "inspect_terminology_signals", {})]),
    toolResponse("submit-smuggled", [toolCall("call_submit_smuggled", "submit_term_candidates", {
      candidates: [
        { ...anchoredMappings[0], evidence_segment_ids: [0], confidence: "high" },
        { ...anchoredMappings[1], evidence_segment_ids: [1], confidence: "high" },
        { ...smuggled, evidence_segment_ids: [1], confidence: "high" },
      ],
    })]),
    toolResponse("resolve-smuggled", [toolCall("call_resolve_smuggled", "resolve_terminology_signals", {
      decisions: [
        {
          signal_id: "surface-1",
          disposition: "mapped",
          canonical: "Descheduler",
          reason: "The two scheduler spellings identify one component.",
        },
        {
          signal_id: "context-1",
          disposition: "not_terminology",
          canonical: "",
          reason: "Result binding is an operation, not the scheduler name.",
        },
      ],
    })]),
    toolResponse("finalize-smuggled", [toolCall("call_finalize_smuggled", "finalize_correction", {
      mappings: proposedMappings,
      join_after: [],
    })]),
    toolResponse("reject-smuggled-candidate", [toolCall("call_reject_smuggled_candidate", "reject_term_candidates", {
      candidates: [smuggled],
      reason: "The dismissed operation must not remain a terminology candidate.",
    })]),
    toolResponse("finalize-without-smuggled", [toolCall("call_finalize_without_smuggled", "finalize_correction", {
      mappings: anchoredMappings,
      join_after: [],
    })]),
  ];

  const { requests, run } = await withResponsesFetch(responses, () => correctTranscript({
    config: { ...responsesConfig, contextHint: "" },
    meeting: sourceMeeting(rawSegments),
  }));

  const finalize = toolOutput(requests[5], "call_finalize_smuggled");
  assert.equal(finalize.ok, false);
  assert.ok(finalize.violations.some((violation) => (
    violation.code === "dismissed_signal_present_in_mapping_group"
    && violation.signal_id === "context-1"
    && violation.term === "result绑定"
  )));
  assert.deepEqual(run.segments.map((segment) => segment.text), [
    "Descheduler starts.",
    "result绑定 follows Descheduler.",
  ]);
  assert.equal(run.corrections.length, 2);
});

test("single-letter mixed-script signals cannot be dismissed without bound audio counterevidence", async () => {
  const rawSegments = [
    { start_seconds: 0, end_seconds: 3, speaker: "A", text: "disk scheduler starts." },
    { start_seconds: 3, end_seconds: 6, speaker: "A", text: "result绑定 follows dis scheduler." },
    { start_seconds: 6, end_seconds: 9, speaker: "B", text: "继续适配 Y调度 的发现接口。" },
  ];
  const anchoredMappings = mappings.slice(0, 2);
  const allMappings = [...anchoredMappings, mappings[2]];
  const responses = [
    toolResponse("read-contextual", [toolCall("call_read_contextual", "read_transcript_window", {
      start_segment: 0,
      max_segments: 3,
    })]),
    toolResponse("inspect-contextual", [toolCall("call_inspect_contextual", "inspect_terminology_signals", {})]),
    toolResponse("submit-anchors", [toolCall("call_submit_anchors", "submit_term_candidates", {
      candidates: [
        { ...anchoredMappings[0], evidence_segment_ids: [0], confidence: "high" },
        { ...anchoredMappings[1], evidence_segment_ids: [1], confidence: "high" },
      ],
    })]),
    toolResponse("attempt-dismissal", [toolCall("call_attempt_dismissal", "resolve_terminology_signals", {
      decisions: [
        {
          signal_id: "surface-1",
          disposition: "mapped",
          canonical: "Descheduler",
          reason: "The repeated spellings identify one scheduler component.",
        },
        {
          signal_id: "context-1",
          disposition: "not_terminology",
          canonical: "",
          reason: "result binding is a separate operation in this sentence.",
        },
        {
          signal_id: "context-2",
          disposition: "not_terminology",
          canonical: "",
          reason: "Attempt to dismiss Y scheduling from text alone.",
        },
      ],
    })]),
    toolResponse("finalize-six-of-seven", [toolCall("call_finalize_six_of_seven", "finalize_correction", {
      mappings: anchoredMappings,
      join_after: [],
    })]),
    toolResponse("submit-y", [toolCall("call_submit_y", "submit_term_candidates", {
      candidates: [{ ...mappings[2], evidence_segment_ids: [2], confidence: "high" }],
    })]),
    toolResponse("resolve-y", [toolCall("call_resolve_y", "resolve_terminology_signals", {
      decisions: [{
        signal_id: "context-2",
        disposition: "mapped",
        canonical: "Descheduler",
        reason: "The adjacent discovery-interface context identifies the same scheduler component.",
      }],
    })]),
    toolResponse("finalize-all", [toolCall("call_finalize_all", "finalize_correction", {
      mappings: allMappings,
      join_after: [],
    })]),
  ];

  const { requests, run } = await withResponsesFetch(responses, () => correctTranscript({
    config: { ...responsesConfig, contextHint: "" },
    meeting: sourceMeeting(rawSegments),
  }));

  const inspected = toolOutput(requests[2], "call_inspect_contextual");
  assert.equal(inspected.signals.find((signal) => signal.term === "result绑定")?.dismissal_policy, "text_evidence");
  assert.equal(inspected.signals.find((signal) => signal.term === "Y调度")?.dismissal_policy, "map_or_audio_review");
  const dismissal = toolOutput(requests[4], "call_attempt_dismissal");
  assert.deepEqual(dismissal.rejected, [{
    signal_id: "context-2",
    reason: "contextual_signal_requires_mapping_or_audio_counterevidence",
  }]);
  assert.deepEqual(dismissal.unresolved_signal_ids, ["context-2"]);
  const rejectedFinalize = toolOutput(requests[5], "call_finalize_six_of_seven");
  assert.equal(rejectedFinalize.ok, false);
  assert.ok(rejectedFinalize.violations.some((violation) => (
    violation.code === "terminology_signal_unresolved" && violation.signal_id === "context-2"
  )));
  assert.deepEqual(run.segments.map((segment) => segment.text), [
    "Descheduler starts.",
    "result绑定 follows Descheduler.",
    "继续适配 Descheduler 的发现接口。",
  ]);
  assert.deepEqual(transcriptGeometry(run.segments), transcriptGeometry(rawSegments));
  assert.equal(run.rejectedCorrections, 0);
  assert.equal(run.corrections.length, 3);
});

test("MiMo counterevidence must contradict, cover, and bind every occurrence of a dismissible contextual signal", async () => {
  const rawSegments = [
    { start_seconds: 0, end_seconds: 3, speaker: "A", text: "disk scheduler starts." },
    { start_seconds: 3, end_seconds: 6, speaker: "A", text: "dis scheduler continues." },
    { start_seconds: 6, end_seconds: 9, speaker: "B", text: "A接口继续适配 Y调度 的发现接口。" },
    { start_seconds: 9, end_seconds: 12, speaker: "B", text: "Y调度 仍在这个适配路径中。" },
  ];
  let audioCalls = 0;
  const traceEvents = [];
  const profile = createTerminologyAgentProfile({
    segments: rawSegments,
    scanOccurrences: (alias) => rawSegments.flatMap((segment, segmentId) => {
      const start = segment.text.indexOf(alias);
      return start < 0 ? [] : [{ segment_id: segmentId, start_offset: start, end_offset: start + alias.length }];
    }),
    transcribeAudioRange: async () => {
      audioCalls += 1;
      return {
        text: [
          "嗯",
          "继续适配 Y调度 的发现接口",
          "A接口继续适配外部调度的发现接口",
          "外部调度仍在这个适配路径中",
        ][audioCalls - 1],
        segments: [],
      };
    },
    finalizeMappings: () => ({ corrections: [] }),
  });
  const tools = new Map(profile.tools.map((tool) => [tool.name, tool]));
  const trace = { append(type, data) { traceEvents.push({ type, data }); } };
  let state = profile.initialState;
  state = tools.get("read_transcript_window").execute({ start_segment: 0, max_segments: 4 }, { state, trace }).state;
  const inspected = tools.get("inspect_terminology_signals").execute({}, { state, trace });
  state = inspected.state;
  const contextual = inspected.output.signals.find((signal) => signal.term === "Y调度");
  const surface = inspected.output.signals.find((signal) => signal.kind === "surface_variant_group");
  assert.equal(contextual.dismissal_policy, "map_or_audio_review");
  assert.equal(inspected.output.signals.find((signal) => signal.term === "A接口")?.dismissal_policy, "text_evidence");
  const surfaceResolution = tools.get("resolve_terminology_signals").execute({
    decisions: [{
      signal_id: surface.id,
      disposition: "mapped",
      canonical: "Descheduler",
      reason: "Both spellings identify one scheduler component.",
    }],
  }, { state, trace });
  assert.equal(surfaceResolution.output.ok, true);
  state = surfaceResolution.state;
  const mismatchedCanonical = tools.get("resolve_terminology_signals").execute({
    decisions: [{
      signal_id: contextual.id,
      disposition: "mapped",
      canonical: "OtherScheduler",
      reason: "Attempt to detach the contextual signal from its related surface group.",
    }],
  }, { state, trace });
  assert.deepEqual(mismatchedCanonical.output.rejected, [{
    signal_id: contextual.id,
    reason: "contextual_signal_canonical_mismatch",
  }]);

  const partial = await tools.get("transcribe_audio_range").execute({
    start_seconds: 6,
    end_seconds: 6.1,
    signal_ids: [contextual.id],
    segment_ids: [2],
    reason: "Check the suspected scheduler name.",
  }, { state, trace, signal: new AbortController().signal });
  assert.equal(partial.output.error, "audio_range_does_not_cover_segments");
  assert.equal(audioCalls, 0);

  const shortReview = await tools.get("transcribe_audio_range").execute({
    start_seconds: 6,
    end_seconds: 9,
    signal_ids: [contextual.id],
    segment_ids: [2],
    reason: "Check whether a short non-empty response is sufficient.",
  }, { state, trace, signal: new AbortController().signal });
  assert.equal(shortReview.output.ok, true);
  assert.equal(shortReview.output.review_id, "audio-1");
  assert.equal(audioCalls, 1);
  state = shortReview.state;

  const dismissedFromShortResponse = tools.get("resolve_terminology_signals").execute({
    decisions: [{
      signal_id: contextual.id,
      disposition: "not_terminology",
      canonical: "",
      reason: "Attempt to treat a one-character MiMo response as counterevidence.",
    }],
  }, { state, trace });
  assert.equal(dismissedFromShortResponse.output.ok, false);

  const confirmingReview = await tools.get("transcribe_audio_range").execute({
    start_seconds: 6,
    end_seconds: 9,
    signal_ids: [contextual.id],
    segment_ids: [2],
    reason: "Check the complete signal-bearing segment.",
  }, { state, trace, signal: new AbortController().signal });
  assert.equal(confirmingReview.output.ok, true);
  assert.equal(confirmingReview.output.review_id, "audio-2");
  assert.equal(audioCalls, 2);
  state = confirmingReview.state;

  const contradictedByTranscript = tools.get("resolve_terminology_signals").execute({
    decisions: [{
      signal_id: contextual.id,
      disposition: "not_terminology",
      canonical: "",
      reason: "Attempt to dismiss even though MiMo heard the same term.",
    }],
  }, { state, trace });
  assert.equal(contradictedByTranscript.output.ok, false);
  assert.deepEqual(contradictedByTranscript.output.rejected, [{
    signal_id: contextual.id,
    reason: "contextual_signal_requires_mapping_or_audio_counterevidence",
  }]);

  const reviewed = await tools.get("transcribe_audio_range").execute({
    start_seconds: 6,
    end_seconds: 9,
    signal_ids: [contextual.id],
    segment_ids: [2],
    reason: "Recheck the complete signal-bearing segment.",
  }, { state, trace, signal: new AbortController().signal });
  assert.equal(reviewed.output.ok, true);
  assert.equal(reviewed.output.review_id, "audio-3");
  assert.equal(audioCalls, 3);
  state = reviewed.state;

  const partiallyReviewed = tools.get("resolve_terminology_signals").execute({
    decisions: [{
      signal_id: contextual.id,
      disposition: "not_terminology",
      canonical: "",
      reason: "Only the first occurrence has contradictory MiMo evidence.",
    }],
  }, { state, trace });
  assert.equal(partiallyReviewed.output.ok, false);
  assert.deepEqual(partiallyReviewed.output.rejected, [{
    signal_id: contextual.id,
    reason: "contextual_signal_requires_mapping_or_audio_counterevidence",
  }]);

  const secondOccurrence = await tools.get("transcribe_audio_range").execute({
    start_seconds: 9,
    end_seconds: 12,
    signal_ids: [contextual.id],
    segment_ids: [3],
    reason: "Check the second complete signal-bearing segment.",
  }, { state, trace, signal: new AbortController().signal });
  assert.equal(secondOccurrence.output.ok, true);
  assert.equal(secondOccurrence.output.review_id, "audio-4");
  assert.equal(audioCalls, 4);
  state = secondOccurrence.state;

  const dismissed = tools.get("resolve_terminology_signals").execute({
    decisions: [{
      signal_id: contextual.id,
      disposition: "not_terminology",
      canonical: "",
      reason: "The signal-bound MiMo review hears a different phrase.",
    }],
  }, { state, trace });
  assert.equal(dismissed.output.ok, true);
  assert.deepEqual(
    dismissed.state.signal_resolutions.find((resolution) => resolution.signal_id === contextual.id)?.audio_review_ids,
    ["audio-3", "audio-4"],
  );
  assert.ok(traceEvents.some((event) => (
    event.type === "term.audio_retranscribed"
    && event.data.review_id === "audio-4"
    && event.data.signal_ids.includes(contextual.id)
    && event.data.segment_ids.includes(3)
  )));
});

test("MiMo review failures cannot leak provider prose or opaque codes through tool output or trace", async () => {
  const rawSegments = [
    { start_seconds: 0, end_seconds: 3, speaker: "A", text: "disk scheduler starts." },
    { start_seconds: 3, end_seconds: 6, speaker: "A", text: "dis scheduler continues." },
    { start_seconds: 6, end_seconds: 9, speaker: "B", text: "继续适配 Y调度 的发现接口。" },
  ];
  const sentinel = "PRIVATE_TRANSCRIPT_SENTINEL sk-provider-secret";
  const profile = createTerminologyAgentProfile({
    segments: rawSegments,
    scanOccurrences: () => [],
    transcribeAudioRange: async () => {
      const error = new Error(`provider echoed ${sentinel}`);
      error.code = sentinel;
      throw error;
    },
    finalizeMappings: () => ({ corrections: [] }),
  });
  const tools = new Map(profile.tools.map((tool) => [tool.name, tool]));
  const traceEvents = [];
  const trace = { append(type, data) { traceEvents.push({ type, data }); } };
  let state = profile.initialState;
  state = tools.get("read_transcript_window").execute({ start_segment: 0, max_segments: 3 }, { state, trace }).state;
  const inspected = tools.get("inspect_terminology_signals").execute({}, { state, trace });
  state = inspected.state;
  const contextual = inspected.output.signals.find((signal) => signal.term === "Y调度");
  const failed = await tools.get("transcribe_audio_range").execute({
    start_seconds: 6,
    end_seconds: 9,
    signal_ids: [contextual.id],
    segment_ids: [2],
    reason: "Review one uncertain signal.",
  }, { state, trace, signal: new AbortController().signal });

  assert.deepEqual(failed.output, { ok: false, error: { code: "audio_review_failed" } });
  assert.doesNotMatch(JSON.stringify({ output: failed.output, trace: traceEvents }), /PRIVATE_TRANSCRIPT_SENTINEL|sk-provider-secret/u);
});

test("a long source segment remains reachable by one bounded audio review", async () => {
  const rawSegments = [
    { start_seconds: 0, end_seconds: 3, speaker: "A", text: "disk scheduler starts." },
    { start_seconds: 3, end_seconds: 6, speaker: "A", text: "dis scheduler continues." },
    {
      start_seconds: 6,
      end_seconds: 51,
      speaker: "A",
      text: "A接口继续适配 Y调度 的发现接口。",
    },
  ];
  let calls = 0;
  const profile = createTerminologyAgentProfile({
    segments: rawSegments,
    scanOccurrences: (alias) => rawSegments.flatMap((segment, segmentId) => {
      const start = segment.text.indexOf(alias);
      return start < 0 ? [] : [{ segment_id: segmentId, start_offset: start, end_offset: start + alias.length }];
    }),
    transcribeAudioRange: async () => {
      calls += 1;
      return { text: "A接口继续适配外部调度的发现接口", segments: [] };
    },
    finalizeMappings: () => ({ corrections: [] }),
  });
  const tools = new Map(profile.tools.map((tool) => [tool.name, tool]));
  const trace = { append() {} };
  let state = tools.get("read_transcript_window").execute({ start_segment: 0, max_segments: 3 }, { state: profile.initialState, trace }).state;
  const inspected = tools.get("inspect_terminology_signals").execute({}, { state, trace });
  state = inspected.state;
  const contextual = inspected.output.signals.find((signal) => signal.term === "Y调度");
  assert.ok(contextual);
  const reviewed = await tools.get("transcribe_audio_range").execute({
    start_seconds: 6,
    end_seconds: 51,
    signal_ids: [contextual.id],
    segment_ids: [2],
    reason: "Review the complete long source segment.",
  }, { state, trace, signal: new AbortController().signal });
  assert.equal(reviewed.output.ok, true);
  assert.equal(calls, 1);
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

test("a revised Luna canonical atomically supersedes its earlier alias proposal", () => {
  const rawSegments = [{ start_seconds: 0, end_seconds: 3, speaker: "A", text: "disk scheduler and d schedule." }];
  const scanOccurrences = (alias) => rawSegments[0].text.includes(alias)
    ? [{ segment_id: 0, start_offset: rawSegments[0].text.indexOf(alias), end_offset: rawSegments[0].text.indexOf(alias) + alias.length }]
    : [];
  const profile = createTerminologyAgentProfile({
    segments: rawSegments,
    explicitMappings: [{ alias: "d schedule", canonical: "Descheduler" }],
    scanOccurrences,
    finalizeMappings: () => ({ corrections: [] }),
  });
  const submit = profile.tools.find((tool) => tool.name === "submit_term_candidates");
  const trace = { append() {} };
  const first = submit.execute({
    candidates: [{ alias: "disk scheduler", canonical: "DiskScheduler", evidence_segment_ids: [0], confidence: "medium" }],
  }, { state: profile.initialState, trace });
  const revised = submit.execute({
    candidates: [{ alias: "disk scheduler", canonical: "Descheduler", evidence_segment_ids: [0], confidence: "high" }],
  }, { state: first.state, trace });
  assert.equal(revised.output.superseded_count, 1);
  assert.deepEqual(revised.state.candidates.map(({ alias, canonical, source }) => ({ alias, canonical, source })), [
    { alias: "d schedule", canonical: "Descheduler", source: "explicit_context" },
    { alias: "disk scheduler", canonical: "Descheduler", source: "luna_proposal" },
  ]);

  const conflicting = submit.execute({
    candidates: [{ alias: "d schedule", canonical: "DiskScheduler", evidence_segment_ids: [0], confidence: "high" }],
  }, { state: revised.state, trace });
  assert.equal(conflicting.output.ok, false);
  assert.deepEqual(conflicting.output.rejected, [{
    alias: "d schedule",
    canonical: "DiskScheduler",
    reason: "conflicts_with_explicit_context",
  }]);
  assert.deepEqual(conflicting.state.candidates, revised.state.candidates);
});

test("model proposals cannot alter the exact spelling of an explicit canonical", () => {
  const rawSegments = [{ start_seconds: 0, end_seconds: 3, speaker: "A", text: "disk scheduler and C++ are discussed." }];
  const scanOccurrences = (alias) => rawSegments[0].text.includes(alias)
    ? [{ segment_id: 0, start_offset: rawSegments[0].text.indexOf(alias), end_offset: rawSegments[0].text.indexOf(alias) + alias.length }]
    : [];
  const profile = createTerminologyAgentProfile({
    segments: rawSegments,
    explicitMappings: [
      { alias: "disk scheduler", canonical: "Descheduler" },
      { alias: "C++", canonical: "C++" },
    ],
    scanOccurrences,
    finalizeMappings: () => ({ corrections: [] }),
  });
  const submit = profile.tools.find((tool) => tool.name === "submit_term_candidates");
  const result = submit.execute({
    candidates: [
      { alias: "disk scheduler", canonical: "descheduler", evidence_segment_ids: [0], confidence: "high" },
      { alias: "C", canonical: "C", evidence_segment_ids: [0], confidence: "high" },
    ],
  }, { state: profile.initialState, trace: { append() {} } });

  assert.deepEqual(result.output.rejected, [{
    alias: "disk scheduler",
    canonical: "descheduler",
    reason: "conflicts_with_explicit_context",
  }]);
  assert.deepEqual(result.state.candidates.map(({ alias, canonical, source }) => ({ alias, canonical, source })), [
    { alias: "disk scheduler", canonical: "Descheduler", source: "explicit_context" },
    { alias: "C++", canonical: "C++", source: "explicit_context" },
    { alias: "C", canonical: "C", source: "luna_proposal" },
  ]);
});

test("a related user canonical term is enforced with its exact spelling", () => {
  const rawSegments = [
    { start_seconds: 0, end_seconds: 3, speaker: "A", text: "disk scheduler starts." },
    { start_seconds: 3, end_seconds: 6, speaker: "A", text: "dis scheduler continues." },
    { start_seconds: 6, end_seconds: 9, speaker: "A", text: "Descheduler reports status." },
  ];
  const profile = createTerminologyAgentProfile({
    segments: rawSegments,
    canonicalTerms: ["Descheduler"],
    canonicalReviews: [{
      signal_id: "surface-1",
      canonical: "Descheduler",
      confidence: "high",
      rationale: "Independent confirmation.",
    }],
    scanOccurrences: () => [],
    finalizeMappings: () => ({ corrections: [] }),
  });
  const tools = new Map(profile.tools.map((tool) => [tool.name, tool]));
  const trace = { append() {} };
  let state = tools.get("read_transcript_window").execute({
    start_segment: 0,
    max_segments: 3,
  }, { state: profile.initialState, trace }).state;
  state = tools.get("inspect_terminology_signals").execute({}, { state, trace }).state;
  const wrong = tools.get("resolve_terminology_signals").execute({
    decisions: [{
      signal_id: "surface-1",
      disposition: "mapped",
      canonical: "DisScheduler",
      reason: "Attempt to use a transcript surface instead of the user's canonical.",
    }],
  }, { state, trace });
  assert.deepEqual(wrong.output.rejected, [{
    signal_id: "surface-1",
    reason: "trusted_canonical_spelling_mismatch",
    reviewed_canonical: "Descheduler",
    canonical_source: "trusted_canonical_term",
  }]);

  const correct = tools.get("resolve_terminology_signals").execute({
    decisions: [{
      signal_id: "surface-1",
      disposition: "mapped",
      canonical: "Descheduler",
      reason: "Use the user's exact canonical spelling.",
    }],
  }, { state, trace });
  assert.equal(correct.output.ok, true);
});

test("a fuzzy trusted canonical cannot override or skip review of transcript spellings", () => {
  const rawSegments = [
    { start_seconds: 0, end_seconds: 3, speaker: "A", text: "Descheduler starts." },
    { start_seconds: 3, end_seconds: 6, speaker: "A", text: "DisScheduler continues." },
  ];
  const reviewInventory = createTerminologyCanonicalReviewInventory({
    segments: rawSegments,
    canonicalTerms: ["DAGScheduler"],
  });
  assert.equal(reviewInventory.length, 1);
  assert.deepEqual(new Set(reviewInventory[0].terms.map((term) => term.text)), new Set(["Descheduler", "DisScheduler"]));

  const profile = createTerminologyAgentProfile({
    segments: rawSegments,
    canonicalTerms: ["DAGScheduler"],
    canonicalReviews: [{
      signal_id: reviewInventory[0].id,
      canonical: "Descheduler",
      confidence: "high",
      rationale: "Independent spelling majority.",
    }],
    scanOccurrences: () => [],
    finalizeMappings: () => ({ corrections: [] }),
  });
  const tools = new Map(profile.tools.map((tool) => [tool.name, tool]));
  const trace = { append() {} };
  let state = tools.get("read_transcript_window").execute({
    start_segment: 0,
    max_segments: 2,
  }, { state: profile.initialState, trace }).state;
  state = tools.get("inspect_terminology_signals").execute({}, { state, trace }).state;
  const resolution = tools.get("resolve_terminology_signals").execute({
    decisions: [{
      signal_id: reviewInventory[0].id,
      disposition: "mapped",
      canonical: "Descheduler",
      reason: "Use the independently reviewed spelling, not a fuzzy context neighbor.",
    }],
  }, { state, trace });
  assert.equal(resolution.output.ok, true);
});

test("atomic finalization rechecks canonical spelling reviews instead of trusting mutable agent state", async () => {
  const rawSegments = [
    { start_seconds: 0, end_seconds: 3, speaker: "A", text: "disk scheduler starts." },
    { start_seconds: 3, end_seconds: 6, speaker: "A", text: "dis scheduler continues." },
  ];
  let finalizeCalls = 0;
  const profile = createTerminologyAgentProfile({
    segments: rawSegments,
    canonicalReviews: [{
      signal_id: "surface-1",
      canonical: "Descheduler",
      confidence: "high",
      rationale: "Official Kubernetes project spelling.",
    }],
    scanOccurrences: () => [],
    finalizeMappings: () => {
      finalizeCalls += 1;
      return { corrections: [] };
    },
  });
  const tools = new Map(profile.tools.map((tool) => [tool.name, tool]));
  const trace = { append() {} };
  let state = tools.get("read_transcript_window").execute({
    start_segment: 0,
    max_segments: 2,
  }, { state: profile.initialState, trace }).state;
  state = tools.get("inspect_terminology_signals").execute({}, { state, trace }).state;
  state = {
    ...state,
    signal_resolutions: [{
      signal_id: "surface-1",
      disposition: "mapped",
      canonical: "DisScheduler",
      reason: "Injected stale state.",
      audio_review_ids: [],
    }],
    resolution_revision: state.resolution_revision + 1,
  };
  const finalization = await tools.get("finalize_correction").execute({ mappings: [], join_after: [] }, { state, trace });
  assert.equal(finalization.state.finalized, false);
  assert.ok(finalization.output.violations.some((violation) => (
    violation.code === "canonical_spelling_review_mismatch"
    && violation.signal_id === "surface-1"
    && violation.reviewed_canonical === "Descheduler"
  )));
  assert.equal(finalizeCalls, 0);
});

test("an explicit user mapping overrides an independent canonical spelling review", () => {
  const rawSegments = [
    { start_seconds: 0, end_seconds: 3, speaker: "A", text: "disk scheduler starts." },
    { start_seconds: 3, end_seconds: 6, speaker: "A", text: "dis scheduler continues." },
  ];
  const profile = createTerminologyAgentProfile({
    segments: rawSegments,
    explicitMappings: [{ alias: "disk scheduler", canonical: "DisScheduler" }],
    canonicalReviews: [{
      signal_id: "surface-1",
      canonical: "Descheduler",
      confidence: "high",
      rationale: "Independent model suggestion.",
    }],
    scanOccurrences: (alias) => rawSegments.flatMap((segment, segmentId) => {
      const start = segment.text.indexOf(alias);
      return start < 0 ? [] : [{ segment_id: segmentId, start_offset: start, end_offset: start + alias.length }];
    }),
    finalizeMappings: () => ({ corrections: [] }),
  });
  const tools = new Map(profile.tools.map((tool) => [tool.name, tool]));
  const trace = { append() {} };
  let state = tools.get("read_transcript_window").execute({
    start_segment: 0,
    max_segments: 2,
  }, { state: profile.initialState, trace }).state;
  state = tools.get("inspect_terminology_signals").execute({}, { state, trace }).state;
  const resolution = tools.get("resolve_terminology_signals").execute({
    decisions: [{
      signal_id: "surface-1",
      disposition: "mapped",
      canonical: "DisScheduler",
      reason: "Follow the user's explicit mapping.",
    }],
  }, { state, trace });
  assert.equal(resolution.output.ok, true);
  assert.deepEqual(resolution.output.rejected, []);
});

test("an adjacent contextual mapping cannot become canonical authority for another surface group", async () => {
  const rawSegments = [
    { start_seconds: 0, end_seconds: 3, speaker: "A", text: "Descheduler starts." },
    { start_seconds: 3, end_seconds: 6, speaker: "A", text: "DisScheduler continues." },
    { start_seconds: 6, end_seconds: 9, speaker: "A", text: "P调度 follows another path." },
  ];
  const explicitMappings = [{ alias: "P调度", canonical: "PodScheduler" }];
  const reviewInventory = createTerminologyCanonicalReviewInventory({
    segments: rawSegments,
    explicitMappings,
  });
  assert.deepEqual(reviewInventory.map((signal) => signal.id), ["surface-1"]);

  const scanOccurrences = (alias) => rawSegments.flatMap((segment, segmentId) => {
    const start = segment.text.indexOf(alias);
    return start < 0 ? [] : [{ segment_id: segmentId, start_offset: start, end_offset: start + alias.length }];
  });
  let finalizeCalls = 0;
  const profile = createTerminologyAgentProfile({
    segments: rawSegments,
    explicitMappings,
    scanOccurrences,
    finalizeMappings: () => {
      finalizeCalls += 1;
      return { corrections: [] };
    },
  });
  const tools = new Map(profile.tools.map((tool) => [tool.name, tool]));
  const trace = { append() {} };
  let state = tools.get("read_transcript_window").execute({
    start_segment: 0,
    max_segments: rawSegments.length,
  }, { state: profile.initialState, trace }).state;
  state = tools.get("inspect_terminology_signals").execute({}, { state, trace }).state;
  state = tools.get("submit_term_candidates").execute({
    candidates: [{
      alias: "DisScheduler",
      canonical: "Descheduler",
      evidence_segment_ids: [1],
      confidence: "high",
    }],
  }, { state, trace }).state;

  const surface = tools.get("resolve_terminology_signals").execute({
    decisions: [{
      signal_id: "surface-1",
      disposition: "mapped",
      canonical: "Descheduler",
      reason: "These are spelling variants of Descheduler.",
    }],
  }, { state, trace });
  assert.equal(surface.output.ok, true);
  assert.deepEqual(surface.output.rejected, []);
  state = surface.state;

  const contextual = tools.get("resolve_terminology_signals").execute({
    decisions: [{
      signal_id: "context-1",
      disposition: "mapped",
      canonical: "PodScheduler",
      reason: "Use the direct user mapping for this distinct contextual alias.",
    }],
  }, { state, trace });
  assert.equal(contextual.output.ok, true);
  assert.deepEqual(contextual.output.rejected, []);
  state = contextual.state;

  const finalization = await tools.get("finalize_correction").execute({
    mappings: [
      { alias: "DisScheduler", canonical: "Descheduler" },
      { alias: "P调度", canonical: "PodScheduler" },
    ],
    join_after: [],
  }, { state, trace });
  assert.equal(finalization.output.ok, true);
  assert.equal(finalization.state.finalized, true);
  assert.equal(finalizeCalls, 1);
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

function signalTerms(signal) {
  return signal.kind === "surface_variant_group"
    ? signal.terms.map((term) => term.text)
    : [signal.term];
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
    const step = responses[requests.length - 1];
    const response = typeof step === "function" ? step(body) : step;
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
    "finalize_correction",
  ];
  for (const request of requests) {
    assert.equal(request.model, "gpt-5.6-luna");
    assert.equal(request.max_output_tokens, 4_096);
    assert.equal(request.store, false);
    assert.equal(request.parallel_tool_calls, false);
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
