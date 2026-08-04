const MAX_WINDOW_SEGMENTS = 60;
const MAX_CANDIDATES = 200;
const MAX_TERM_CHARACTERS = 120;
const MAX_AUDIO_REVIEWS = 4;
const MAX_AUDIO_REVIEW_SECONDS = 90;
const MAX_AUDIO_REVIEW_EVIDENCE_CHARACTERS = 1_200;
const MAX_TERMINOLOGY_SIGNALS = 60;
const MAX_SIGNAL_SURFACES = 300;
const MAX_SIGNAL_OCCURRENCES = 2_000;
const MAX_SIGNAL_TERMS_PER_GROUP = 12;
const MAX_SIGNAL_SEGMENTS_PER_TERM = 20;
const MAX_SCAN_MAPPINGS = 20;
const MAX_SCAN_OCCURRENCES_PER_MAPPING = 20;
const MAX_CANONICAL_REVIEW_RATIONALE_CHARACTERS = 240;
const TECHNICAL_PHRASE_SUFFIXES = new Set([
  "api", "broker", "cache", "client", "cluster", "controller", "daemon", "database", "datastore",
  "deployment", "endpoint", "engine", "framework", "gateway", "interface", "library", "mesh", "model",
  "operator", "pipeline", "protocol", "proxy", "queue", "runtime", "scheduler", "server", "service",
]);

export function createTerminologySignalInventory(segments = []) {
  return buildTerminologySignals(normalizeSignalSource(segments));
}

export function createTerminologyCanonicalReviewInventory({
  segments = [],
  canonicalTerms = [],
  explicitMappings = [],
} = {}) {
  const terminologySignals = createTerminologySignalInventory(segments);
  const trustedMappings = normalizeMappings(explicitMappings);
  const trustedTerms = [...new Set(canonicalTerms.map((term) => String(term || "").trim()).filter(Boolean))];
  return Object.freeze(terminologySignals.filter((signal) => (
    signal.kind === "surface_variant_group"
    && !authoritativeCanonicalSpelling(signal, trustedMappings, trustedTerms)
  )));
}

export function createTerminologyAgentProfile({
  segments = [],
  contextHint = "",
  canonicalTerms = [],
  explicitMappings = [],
  priorMappings = [],
  canonicalReviews = [],
  scanOccurrences,
  finalizeMappings,
  transcribeAudioRange,
} = {}) {
  if (typeof scanOccurrences !== "function") throw new TypeError("Terminology profile requires scanOccurrences");
  if (typeof finalizeMappings !== "function") throw new TypeError("Terminology profile requires finalizeMappings");
  const source = normalizeSignalSource(segments);
  const terminologySignals = buildTerminologySignals(source);
  const readTurns = Math.ceil(source.length / MAX_WINDOW_SEGMENTS);
  const budgetHints = Object.freeze({
    readTurns,
    minimumModelTurns: readTurns + 2,
    recommendedModelTurns: readTurns + 12,
    sourceCharacters: JSON.stringify(source).length,
  });
  const trustedTerms = [...new Set(canonicalTerms.map((term) => String(term || "").trim()).filter(Boolean))];
  const trustedMappings = normalizeMappings(explicitMappings);
  const spellingReviews = normalizeCanonicalReviews(canonicalReviews, terminologySignals);
  const trustedMappingKeys = new Set(trustedMappings.map(mappingKey));
  const trustedAliasKeys = new Set(trustedMappings.map((mapping) => mappingAliasKey(mapping.alias)));
  const persistedMappings = normalizeMappings(priorMappings)
    .filter((mapping) => !trustedAliasKeys.has(mappingAliasKey(mapping.alias)));
  const persistedMappingKeys = new Set(persistedMappings.map(mappingKey));
  const initialCandidates = [...trustedMappings.map((mapping) => ({ ...mapping, source: "explicit_context" })),
    ...persistedMappings.map((mapping) => ({ ...mapping, source: "persisted_recording" }))].map((mapping) => ({
    ...mapping,
    evidence_segment_ids: occurrenceSegmentIds(scanOccurrences(mapping.alias, mapping.canonical)),
    confidence: "high",
  })).filter((candidate) => candidate.evidence_segment_ids.length > 0);
  const initialState = {
    profile_version: 1,
    covered_segment_ids: [],
    candidates: initialCandidates,
    candidate_revision: 0,
    rejected_candidates: [],
    signal_inventory_inspected: false,
    signal_resolutions: [],
    resolution_revision: 0,
    validations: [],
    audio_reviews: [],
    audio_revision: 0,
    finalized: false,
    artifact: null,
  };

  const tools = [
    {
      name: "read_transcript_window",
      description: "Read an ordered window of immutable transcript segments. Use it until every segment in the recording has been inspected.",
      strict: true,
      stateful: true,
      parameters: objectSchema({
        start_segment: integerSchema(0),
        max_segments: integerSchema(1, MAX_WINDOW_SEGMENTS),
      }),
      execute({ start_segment: start, max_segments: count }, { state, trace }) {
        const window = source.slice(start, start + count);
        const covered = new Set(state.covered_segment_ids);
        window.forEach((segment) => covered.add(segment.id));
        trace.append("term.window_read", { start_segment: start, returned_segments: window.length });
        return {
          state: { ...state, covered_segment_ids: [...covered].sort((left, right) => left - right) },
          output: {
            segments: window,
            total_segments: source.length,
            next_start_segment: start + window.length < source.length ? start + window.length : null,
          },
        };
      },
    },
    {
      name: "inspect_terminology_signals",
      description: "Inspect the runtime-generated recording-wide inventory of likely surface variants and nearby mixed-script technical terms. Every signal must be explicitly resolved before finalization.",
      strict: true,
      stateful: true,
      parameters: objectSchema({}),
      execute(_arguments, { state, trace }) {
        const uncovered = source.map((segment) => segment.id).filter((id) => !state.covered_segment_ids.includes(id));
        if (uncovered.length) {
          return {
            output: {
              ok: false,
              error: "recording_not_fully_inspected",
              remaining_segments: uncovered.slice(0, 100),
              remaining_count: uncovered.length,
            },
          };
        }
        trace.append("term.signals_inspected", { signal_count: terminologySignals.length });
        return {
          state: { ...state, signal_inventory_inspected: true },
          output: { ok: true, signals: terminologySignals },
        };
      },
    },
    {
      name: "submit_term_candidates",
      description: "Submit terminology aliases found in the recording with a single canonical spelling and concrete segment evidence. This proposes evidence; it does not edit the transcript.",
      strict: true,
      stateful: true,
      parameters: objectSchema({
        candidates: arraySchema(objectSchema({
          alias: stringSchema(1, MAX_TERM_CHARACTERS),
          canonical: stringSchema(1, MAX_TERM_CHARACTERS),
          evidence_segment_ids: arraySchema(integerSchema(0), 1, 100),
          confidence: enumSchema(["high", "medium", "low"]),
        }), 1, 50),
      }),
      execute({ candidates }, { state, trace }) {
        const accepted = new Map(state.candidates.map((candidate) => [mappingKey(candidate), candidate]));
        const rejected = [];
        let acceptedCount = 0;
        let superseded = 0;
        for (const candidate of candidates) {
          const alias = candidate.alias.trim();
          const canonical = candidate.canonical.trim();
          const occurrenceIds = new Set(occurrenceSegmentIds(scanOccurrences(alias, canonical)));
          const evidenceIds = [...new Set(candidate.evidence_segment_ids)].filter((id) => (
            id < source.length && occurrenceIds.has(id)
          ));
          if (!alias || !canonical || !evidenceIds.length) {
            rejected.push({ alias, canonical, reason: "missing_recording_evidence" });
            continue;
          }
          const explicitForAlias = state.candidates.find((existing) => (
            existing.source === "explicit_context"
            && mappingAliasKey(existing.alias) === mappingAliasKey(alias)
          ));
          if (explicitForAlias && mappingKey(explicitForAlias) !== mappingKey({ alias, canonical })) {
            rejected.push({ alias, canonical, reason: "conflicts_with_explicit_context" });
            continue;
          }
          const item = {
            alias,
            canonical,
            evidence_segment_ids: evidenceIds,
            confidence: candidate.confidence,
            source: trustedMappingKeys.has(mappingKey({ alias, canonical }))
              ? "explicit_context"
              : (persistedMappingKeys.has(mappingKey({ alias, canonical })) ? "persisted_recording" : "luna_proposal"),
          };
          if (item.source === "luna_proposal") {
            for (const [key, existing] of accepted) {
              if (
                existing.source === "luna_proposal"
                && mappingAliasKey(existing.alias) === mappingAliasKey(alias)
                && key !== mappingKey(item)
              ) {
                accepted.delete(key);
                superseded += 1;
              }
            }
          }
          accepted.set(mappingKey(item), item);
          acceptedCount += 1;
        }
        const nextCandidates = [...accepted.values()].slice(0, MAX_CANDIDATES);
        trace.append("term.candidates_submitted", { accepted: acceptedCount, superseded, rejected: rejected.length });
        return {
          state: { ...state, candidates: nextCandidates, candidate_revision: state.candidate_revision + 1 },
          output: { ok: rejected.length === 0, accepted_count: acceptedCount, superseded_count: superseded, total_candidates: nextCandidates.length, rejected },
        };
      },
    },
    {
      name: "reject_term_candidates",
      description: "Explicitly withdraw unsupported model-proposed candidates before retrying validation. Authoritative mappings from user context cannot be withdrawn.",
      strict: true,
      stateful: true,
      parameters: objectSchema({
        candidates: mappingArraySchema(),
        reason: stringSchema(1, 240),
      }),
      execute({ candidates, reason }, { state, trace }) {
        const requested = new Set(normalizeMappings(candidates).map(mappingKey));
        const removed = [];
        const refused = [];
        const retained = state.candidates.filter((candidate) => {
          if (!requested.has(mappingKey(candidate))) return true;
          if (candidate.source === "explicit_context") {
            refused.push({ alias: candidate.alias, canonical: candidate.canonical, reason: "explicit_context_mapping" });
            return true;
          }
          removed.push({ alias: candidate.alias, canonical: candidate.canonical, reason: reason.trim() });
          return false;
        });
        trace.append("term.candidates_rejected", { removed: removed.length, refused: refused.length });
        return {
          state: {
            ...state,
            candidates: retained,
            candidate_revision: removed.length ? state.candidate_revision + 1 : state.candidate_revision,
            rejected_candidates: [...state.rejected_candidates, ...removed].slice(-MAX_CANDIDATES),
          },
          output: { ok: refused.length === 0, removed, refused },
        };
      },
    },
    {
      name: "scan_alias_occurrences",
      description: "Batch-scan the entire recording for normalized occurrences of genuinely ambiguous proposed aliases. Finalization already scans every mapping, so do not call this tool for routine mappings.",
      strict: true,
      parameters: objectSchema({ mappings: mappingArraySchema(1, MAX_SCAN_MAPPINGS) }),
      execute({ mappings }, { trace }) {
        const results = normalizeMappings(mappings).map(({ alias, canonical }) => {
          const occurrences = scanOccurrences(alias, canonical);
          trace.append("term.alias_scanned", { occurrence_count: occurrences.length });
          return {
            alias,
            canonical,
            occurrence_count: occurrences.length,
            occurrences: occurrences.slice(0, MAX_SCAN_OCCURRENCES_PER_MAPPING).map((occurrence) => ({
              segment_id: Math.max(0, Number(occurrence?.segment_id) || 0),
              start_offset: Math.max(0, Number(occurrence?.start_offset) || 0),
              end_offset: Math.max(0, Number(occurrence?.end_offset) || 0),
            })),
            truncated: occurrences.length > MAX_SCAN_OCCURRENCES_PER_MAPPING,
          };
        });
        return { output: { results } };
      },
    },
    {
      name: "resolve_terminology_signals",
      description: "Resolve each inspected terminology signal as mapped to one canonical spelling, distinct terms, or not terminology. Give an evidence-based reason for every decision.",
      strict: true,
      stateful: true,
      parameters: objectSchema({
        decisions: arraySchema(objectSchema({
          signal_id: stringSchema(1, 80),
          disposition: enumSchema(["mapped", "distinct_terms", "not_terminology"]),
          canonical: stringSchema(0, MAX_TERM_CHARACTERS),
          reason: stringSchema(1, 240),
        }), 1, MAX_TERMINOLOGY_SIGNALS),
      }),
      execute({ decisions }, { state, trace }) {
        if (!state.signal_inventory_inspected) {
          return { output: { ok: false, error: "terminology_signal_inventory_not_inspected" } };
        }
        const known = new Map(terminologySignals.map((signal) => [signal.id, signal]));
        const resolutions = new Map(state.signal_resolutions.map((resolution) => [resolution.signal_id, resolution]));
        const rejected = [];
        let accepted = 0;
        for (const decision of decisions) {
          const signalId = decision.signal_id.trim();
          const canonical = decision.canonical.trim();
          if (!known.has(signalId)) {
            rejected.push({ signal_id: signalId, reason: "unknown_signal" });
            continue;
          }
          const signal = known.get(signalId);
          const counterevidenceReviews = completedAudioReviewsForSignal(state, signal, source);
          if (signal.required_disposition === "mapped" && decision.disposition !== "mapped") {
            rejected.push({ signal_id: signalId, reason: "high_confidence_surface_variants_require_mapping" });
            continue;
          }
          if (
            signal.dismissal_policy === "map_or_audio_review"
            && decision.disposition !== "mapped"
            && !counterevidenceReviews.length
          ) {
            rejected.push({ signal_id: signalId, reason: "contextual_signal_requires_mapping_or_audio_counterevidence" });
            continue;
          }
          if (decision.disposition === "mapped" && !canonical) {
            rejected.push({ signal_id: signalId, reason: "mapped_signal_requires_canonical" });
            continue;
          }
          const relatedCanonicals = relatedMappedCanonicals(state, signal);
          const canonicalReview = enforcedCanonicalReview(
            signal,
            spellingReviews,
            trustedMappings,
            trustedTerms,
          );
          if (
            decision.disposition === "mapped"
            && canonicalReview
            && !sameSpelling(canonicalReview.canonical, canonical)
          ) {
            rejected.push({
              signal_id: signalId,
              reason: canonicalSpellingMismatchCode(canonicalReview),
              reviewed_canonical: canonicalReview.canonical,
              canonical_source: canonicalReview.source,
            });
            continue;
          }
          if (
            decision.disposition === "mapped"
            && relatedCanonicals.length
            && canonicalReview?.source !== "explicit_context"
            && !relatedCanonicals.some((value) => sameSpelling(value, canonical))
          ) {
            rejected.push({ signal_id: signalId, reason: "contextual_signal_canonical_mismatch" });
            continue;
          }
          if (
            decision.disposition === "mapped"
            && signal.dismissal_policy === "text_evidence"
            && !contextualSignalMappingAuthorized(state, signal, canonical, source)
          ) {
            rejected.push({ signal_id: signalId, reason: "contextual_signal_mapping_requires_explicit_or_audio_evidence" });
            continue;
          }
          resolutions.set(signalId, {
            signal_id: signalId,
            disposition: decision.disposition,
            canonical: decision.disposition === "mapped" ? canonical : "",
            reason: decision.reason.trim(),
            audio_review_ids: decision.disposition === "mapped"
              ? []
              : counterevidenceReviews.map((review) => review.id),
          });
          accepted += 1;
        }
        trace.append("term.signals_resolved", { accepted, rejected: rejected.length });
        return {
          state: {
            ...state,
            signal_resolutions: [...resolutions.values()].slice(0, MAX_TERMINOLOGY_SIGNALS),
            resolution_revision: accepted ? state.resolution_revision + 1 : state.resolution_revision,
          },
          output: {
            ok: rejected.length === 0,
            accepted_count: accepted,
            unresolved_signal_ids: terminologySignals.map((signal) => signal.id).filter((id) => !resolutions.has(id)),
            rejected,
          },
        };
      },
    },
    ...(typeof transcribeAudioRange === "function" ? [{
      name: "transcribe_audio_range",
      description: "Ask MiMo-V2.5-ASR to re-transcribe one bounded, uncertain audio range and bind the result to the terminology signals it can verify. Use only when transcript context is insufficient.",
      strict: true,
      stateful: true,
      parameters: objectSchema({
        start_seconds: numberSchema(0),
        end_seconds: numberSchema(0),
        signal_ids: arraySchema(stringSchema(1, 80), 1, 8),
        segment_ids: arraySchema(integerSchema(0), 1, 20),
        reason: stringSchema(1, 240),
      }),
      async execute({ start_seconds: start, end_seconds: end, signal_ids: requestedSignalIds, segment_ids: requestedSegmentIds, reason }, { state, signal, trace }) {
        const duration = end - start;
        if (state.audio_reviews.length >= MAX_AUDIO_REVIEWS) {
          return { output: { ok: false, error: "audio_review_budget_exhausted" } };
        }
        if (!(duration > 0) || duration > MAX_AUDIO_REVIEW_SECONDS) {
          return { output: { ok: false, error: "audio_range_out_of_bounds", max_seconds: MAX_AUDIO_REVIEW_SECONDS } };
        }
        if (!state.signal_inventory_inspected) {
          return { output: { ok: false, error: "terminology_signal_inventory_not_inspected" } };
        }
        const knownSignals = new Map(terminologySignals.map((item) => [item.id, item]));
        const signalIds = [...new Set(requestedSignalIds.map((value) => value.trim()))];
        const segmentIds = [...new Set(requestedSegmentIds)];
        const unknownSignalIds = signalIds.filter((id) => !knownSignals.has(id));
        if (unknownSignalIds.length) {
          return { output: { ok: false, error: "unknown_terminology_signal", signal_ids: unknownSignalIds } };
        }
        const invalidSegmentIds = segmentIds.filter((id) => !source[id] || !audioRangeCoversSegment(start, end, source[id]));
        if (invalidSegmentIds.length) {
          return { output: { ok: false, error: "audio_range_does_not_cover_segments", segment_ids: invalidSegmentIds } };
        }
        const uncoveredSignalIds = signalIds.filter((id) => {
          const signalSegments = new Set(knownSignals.get(id).segment_ids);
          return !segmentIds.some((segmentId) => signalSegments.has(segmentId));
        });
        if (uncoveredSignalIds.length) {
          return { output: { ok: false, error: "audio_segments_do_not_belong_to_signal", signal_ids: uncoveredSignalIds } };
        }
        const allowedSegmentIds = new Set(signalIds.flatMap((id) => knownSignals.get(id).segment_ids));
        const unrelatedSegmentIds = segmentIds.filter((id) => !allowedSegmentIds.has(id));
        if (unrelatedSegmentIds.length) {
          return { output: { ok: false, error: "audio_segments_not_bound_to_requested_signals", segment_ids: unrelatedSegmentIds } };
        }
        const reviewId = `audio-${state.audio_revision + 1}`;
        const signalTerms = uniqueSignalTerms(signalIds.map((id) => knownSignals.get(id)));
        const record = {
          id: reviewId,
          signal_ids: signalIds,
          signal_terms: signalTerms,
          segment_ids: segmentIds,
          start_seconds: start,
          end_seconds: end,
          reason,
        };
        try {
          const review = await transcribeAudioRange({ start_seconds: start, end_seconds: end, signal_ids: signalIds, segment_ids: segmentIds, reason, signal });
          const evidenceText = audioReviewEvidenceText(review);
          const status = evidenceText ? "completed" : "inconclusive";
          trace.append("term.audio_retranscribed", {
            review_id: reviewId,
            signal_ids: signalIds,
            segment_ids: segmentIds,
            start_seconds: start,
            end_seconds: end,
            status,
            evidence_characters: evidenceText.length,
          });
          return {
            state: {
              ...state,
              audio_reviews: [...state.audio_reviews, { ...record, status, evidence_text: evidenceText }],
              audio_revision: state.audio_revision + 1,
            },
            output: { ...(review && typeof review === "object" ? review : {}), ok: Boolean(evidenceText), review_id: reviewId, signal_ids: signalIds, segment_ids: segmentIds, status },
          };
        } catch (error) {
          if (signal?.aborted || error?.name === "AbortError") throw error;
          const errorCode = audioReviewFailureCode(error);
          trace.append("term.audio_failed", { start_seconds: start, end_seconds: end, code: errorCode });
          return {
            state: {
              ...state,
              audio_reviews: [...state.audio_reviews, { ...record, status: "failed", evidence_text: "" }],
              audio_revision: state.audio_revision + 1,
            },
            output: { ok: false, error: { code: errorCode } },
          };
        }
      },
    }] : []),
    {
      name: "finalize_correction",
      description: "Atomically validate and commit the only allowed corrected-transcript artifact after full recording coverage. Static or runtime violations reject the call without committing. The runtime preserves speakers and timestamps and applies edits.",
      strict: true,
      stateful: true,
      parameters: objectSchema({
        mappings: mappingArraySchema(),
        join_after: arraySchema(integerSchema(0), 0, 200),
      }),
      async execute({ mappings, join_after: joinAfter }, { state, trace }) {
        if (state.finalized) return { output: { ok: false, error: "artifact_already_finalized" } };
        const validation = validateCompletionMappings(
          mappings,
          state,
          source,
          scanOccurrences,
          trustedMappingKeys,
          terminologySignals,
          spellingReviews,
          trustedMappings,
          trustedTerms,
        );
        const uncovered = source.map((segment) => segment.id).filter((id) => !state.covered_segment_ids.includes(id));
        if (uncovered.length) validation.violations.unshift({
          code: "recording_not_fully_inspected",
          remaining_segments: uncovered.slice(0, 100),
          remaining_count: uncovered.length,
        });
        if (validation.violations.length) {
          const record = mappingValidationRecord(mappings, state, validation.violations);
          trace.append("term.finalize_rejected", { violations: validation.violations.length });
          return {
            state: { ...state, validations: [...state.validations, record].slice(-10) },
            output: { ok: false, violations: validation.violations },
          };
        }
        const artifact = await finalizeMappings({
          mappings: normalizeMappings(mappings),
          joinAfter: [...new Set(joinAfter)],
          candidates: state.candidates,
          audioReviews: state.audio_reviews,
        });
        const runtimeViolations = Array.isArray(artifact?.agentViolations) ? artifact.agentViolations : [];
        if (runtimeViolations.length) {
          const record = mappingValidationRecord(mappings, state, runtimeViolations);
          trace.append("term.finalize_rejected", { violations: runtimeViolations.length, source: "runtime" });
          return {
            state: { ...state, validations: [...state.validations, record].slice(-10) },
            output: { ok: false, violations: runtimeViolations },
          };
        }
        trace.append("term.finalized", {
          mapping_count: mappings.length,
          correction_count: Array.isArray(artifact?.corrections) ? artifact.corrections.length : 0,
        });
        return {
          state: { ...state, finalized: true, artifact },
          output: {
            ok: true,
            mapping_count: mappings.length,
            accepted_corrections: Array.isArray(artifact?.corrections)
              ? artifact.corrections.filter((entry) => entry?.status === "accepted").length
              : 0,
            rejected_corrections: Number(artifact?.rejectedCorrections) || 0,
          },
        };
      },
    },
  ];

  const input = JSON.stringify({
    task: "Make terminology canonical across one recording without changing facts, speakers, or timestamps.",
    recording: {
      total_segments: source.length,
      duration_seconds: source.reduce((maximum, segment) => Math.max(maximum, segment.end_seconds), 0),
    },
    context_hint: String(contextHint || ""),
    trusted_canonical_terms: trustedTerms,
    explicit_mappings: trustedMappings,
    prior_validated_mappings: persistedMappings,
    canonical_spelling_reviews: spellingReviews,
  });

  return {
    name: "terminology-supervisor",
    budgetHints,
    initialState,
    input,
    tools,
    instructions: `You are the GPT Luna terminology supervisor for one meeting recording. Operate as an agent by choosing tools based on evidence; do not emit or rewrite a transcript yourself.

Required completion invariant:
1. Inspect every transcript segment with read_transcript_window. Use max_segments=60 for every full window and only reduce it for the final remainder. The runtime rejects finalization while any segment is unread.
2. Call inspect_terminology_signals after full coverage. It is a runtime-generated suspect inventory, not a gold answer.
3. Identify every repeated technical entity and all of its spelling, spacing, transliteration, and ASR variants. Resolve every inventory signal with resolve_terminology_signals. Only surface_variant_group signals marked required_disposition=mapped require a canonical mapping; groups marked review are heuristic suspects and must be marked distinct_terms when their surfaces are different entities or ordinary words. Contextual signals marked map_or_audio_review may be dismissed only after a completed, signal-bound MiMo review covering the occurrence. text_evidence signals may be dismissed from transcript context, but mapping one requires an explicit user mapping or positive signal-bound audio evidence. The same entity must have exactly one canonical spelling throughout this recording.
4. Choose canonical spelling by the established public technical identifier and domain semantics, not by majority vote, transcript frequency, or a surface that merely looks like CamelCase. ASR often turns an unfamiliar identifier into familiar words, separated syllables, or a plausible-but-wrong capitalization. Before submission, check the identifier's morphemes, official naming convention, and exact capitalization against your technical knowledge. canonical_spelling_reviews are independent focused reviews: when one is high confidence, use its exact canonical unless an explicit user mapping for that signal overrides it. If you cannot confidently justify a common phrase as the same named entity, do not attach it.
5. Treat explicit mappings as authoritative. A trusted canonical term fixes spelling only after evidence shows that a surface is the same entity; it never authorizes merging a similar common word. Prior validated mappings are revisable evidence, not user authority; reject them when current transcript or MiMo evidence disproves them. Never map an unrelated common phrase merely because it is similar.
6. Submit all supported candidates together with concrete segment evidence whenever possible. A later Luna proposal for the same alias replaces its earlier Luna proposal atomically; explicit mappings are never replaced. The runtime validation already scans every alias across the full recording. If a genuinely ambiguous occurrence question remains, call scan_alias_occurrences once with all mappings that need inspection; never scan routine mappings or call it once per final mapping.
7. If later evidence disproves one of your own candidates, call reject_term_candidates with a concrete reason before finalizing again. Explicit user mappings cannot be rejected.
8. When audio evidence is available, call transcribe_audio_range only for genuinely uncertain ranges and pass the exact signal_ids and complete segment_ids covered by that bounded range. Every occurrence of a dismissed map_or_audio_review signal needs completed review evidence. MiMo is evidence, not the final editor.
9. Resolve all currently known signals together whenever possible, then call finalize_correction once with the complete final mapping group. This tool atomically performs coverage, static, signal-resolution, and runtime validation before it commits. If it rejects an item, adjust only the rejected evidence and retry. Only successful finalization may commit an artifact; it preserves segment IDs, speakers, timestamps, and critical facts.

State-changing tools (window reads, inventory inspection, candidate submission/rejection, signal resolution, audio review, and finalization) must be called in separate model turns. scan_alias_occurrences is a single stateless batch call.

Do not stop after explaining progress. A successful finalize_correction call is terminal; the runtime returns its artifact without requiring another model turn.`,
    isComplete: ({ state }) => state.finalized === true,
    isTerminalState: ({ state }) => state.finalized === true,
    completeOnTerminalState: true,
    allowEmptyFinal: true,
    result: ({ state }) => state.artifact,
    onIncomplete: ({ state }) => {
      const remaining = Math.max(0, source.length - state.covered_segment_ids.length);
      const unresolved = terminologySignals.filter((signal) => (
        !state.signal_resolutions.some((resolution) => resolution.signal_id === signal.id)
      )).length;
      return `The terminology artifact is not finalized. Continue using tools; ${remaining} transcript segments remain unread and ${unresolved} terminology signals remain unresolved. Call finalize_correction after full coverage, inventory review, and signal resolution; it performs validation atomically.`;
    },
  };
}

function validateCompletionMappings(
  mappings,
  state,
  source,
  scanOccurrences,
  trustedMappingKeys,
  terminologySignals,
  spellingReviews,
  trustedMappings,
  trustedTerms,
) {
  const validation = validateMappings(mappings, state, source.length, scanOccurrences, trustedMappingKeys);
  validation.violations.push(...validateSignalResolutions(
    mappings,
    state,
    terminologySignals,
    source,
    spellingReviews,
    trustedMappings,
    trustedTerms,
  ));
  validation.violations = uniqueViolations(validation.violations);
  return validation;
}

function validateSignalResolutions(
  mappings,
  state,
  terminologySignals,
  source,
  spellingReviews,
  trustedMappings,
  trustedTerms,
) {
  if (!state.signal_inventory_inspected) {
    return [{ code: "terminology_signal_inventory_not_inspected", signal_count: terminologySignals.length }];
  }
  const normalized = normalizeMappings(mappings);
  const resolutions = new Map(state.signal_resolutions.map((resolution) => [resolution.signal_id, resolution]));
  const violations = [];
  for (const signal of terminologySignals) {
    const resolution = resolutions.get(signal.id);
    if (!resolution) {
      violations.push({ code: "terminology_signal_unresolved", signal_id: signal.id });
      continue;
    }
    if (resolution.disposition !== "mapped") {
      const dismissedTerms = signal.kind === "surface_variant_group"
        ? signal.terms.map((term) => term.text)
        : [signal.term];
      for (const term of dismissedTerms) {
        const retained = normalized.find((mapping) => termKey(mapping.alias) === termKey(term));
        if (retained) {
          violations.push({
            code: "dismissed_signal_present_in_mapping_group",
            signal_id: signal.id,
            term,
            canonical: retained.canonical,
          });
        }
      }
      if (
        signal.dismissal_policy === "map_or_audio_review"
        && !completedAudioReviewsForSignal(state, signal, source, resolution.audio_review_ids).length
      ) {
        violations.push({
          code: "contextual_signal_audio_counterevidence_required",
          signal_id: signal.id,
        });
      }
      continue;
    }
    const canonicalReview = enforcedCanonicalReview(
      signal,
      spellingReviews,
      trustedMappings,
      trustedTerms,
    );
    if (canonicalReview && !sameSpelling(canonicalReview.canonical, resolution.canonical)) {
      violations.push({
        code: canonicalSpellingMismatchCode(canonicalReview),
        signal_id: signal.id,
        canonical: resolution.canonical,
        reviewed_canonical: canonicalReview.canonical,
        canonical_source: canonicalReview.source,
      });
      continue;
    }
    const relatedCanonicals = relatedMappedCanonicals(state, signal);
    if (
      relatedCanonicals.length
      && canonicalReview?.source !== "explicit_context"
      && !relatedCanonicals.some((value) => sameSpelling(value, resolution.canonical))
    ) {
      violations.push({
        code: "contextual_signal_canonical_mismatch",
        signal_id: signal.id,
        canonical: resolution.canonical,
        related_canonicals: relatedCanonicals,
      });
      continue;
    }
    if (
      signal.dismissal_policy === "text_evidence"
      && !contextualSignalMappingAuthorized(state, signal, resolution.canonical, source)
    ) {
      violations.push({
        code: "contextual_signal_mapping_requires_explicit_or_audio_evidence",
        signal_id: signal.id,
      });
      continue;
    }
    const requiredTerms = signal.kind === "surface_variant_group"
      ? signal.terms.map((term) => term.text)
      : [signal.term];
    for (const term of requiredTerms) {
      if (sameSpelling(term, resolution.canonical)) continue;
      const covered = normalized.some((mapping) => (
        termKey(mapping.alias) === termKey(term)
        && sameSpelling(mapping.canonical, resolution.canonical)
      ));
      if (!covered) {
        violations.push({
          code: "mapped_signal_term_missing_from_mapping_group",
          signal_id: signal.id,
          term,
          canonical: resolution.canonical,
        });
      }
    }
  }
  return violations;
}

function mappingValidationRecord(mappings, state, violations) {
  return {
    mapping_count: normalizeMappings(mappings).length,
    mapping_keys: normalizeMappings(mappings).map(mappingKey).sort(),
    candidate_revision: state.candidate_revision,
    resolution_revision: state.resolution_revision,
    audio_revision: state.audio_revision,
    violations: uniqueViolations(violations),
  };
}

function normalizeSignalSource(segments) {
  return (Array.isArray(segments) ? segments : []).map((segment, id) => Object.freeze({
    id,
    start_seconds: Math.max(0, Number(segment?.start_seconds) || 0),
    end_seconds: Math.max(0, Number(segment?.end_seconds) || 0),
    speaker: String(segment?.speaker || "发言人"),
    text: String(segment?.text || ""),
  }));
}

function normalizeCanonicalReviews(value, terminologySignals) {
  const known = new Map(terminologySignals
    .filter((signal) => signal.kind === "surface_variant_group")
    .map((signal) => [signal.id, signal]));
  const reviews = new Map();
  for (const item of Array.isArray(value) ? value : []) {
    const signalId = String(item?.signal_id || "").trim();
    const canonical = String(item?.canonical || "").trim();
    const confidence = String(item?.confidence || "").trim().toLocaleLowerCase("en-US");
    if (!known.has(signalId) || !canonical || canonical.length > MAX_TERM_CHARACTERS) continue;
    if (!["high", "medium", "low"].includes(confidence)) continue;
    reviews.set(signalId, Object.freeze({
      signal_id: signalId,
      canonical,
      confidence,
      rationale: String(item?.rationale || "").trim().slice(0, MAX_CANONICAL_REVIEW_RATIONALE_CHARACTERS),
    }));
  }
  return Object.freeze([...reviews.values()].slice(0, MAX_TERMINOLOGY_SIGNALS));
}

function enforcedCanonicalReview(signal, reviews, trustedMappings, trustedTerms) {
  const authority = authoritativeCanonicalSpelling(signal, trustedMappings, trustedTerms);
  if (authority) return authority;
  const review = (Array.isArray(reviews) ? reviews : []).find((item) => (
    item.signal_id === signal?.id && item.confidence === "high"
  ));
  return review ? { ...review, source: "independent_review" } : null;
}

function authoritativeCanonicalSpelling(signal, trustedMappings, trustedTerms) {
  const relevantAliasKeys = new Set(signalTerms(signal).map(mappingAliasKey).filter(Boolean));
  const explicitCanonicals = uniqueExactSpellings((Array.isArray(trustedMappings) ? trustedMappings : [])
    .filter((mapping) => relevantAliasKeys.has(mappingAliasKey(mapping.alias)))
    .map((mapping) => mapping.canonical));
  if (explicitCanonicals.length === 1) {
    return { canonical: explicitCanonicals[0], source: "explicit_context" };
  }

  const surfaces = signalTerms(signal).map((text) => ({ text, key: termKey(text) }));
  const relatedTrustedTerms = uniqueExactSpellings((Array.isArray(trustedTerms) ? trustedTerms : []).filter((term) => {
    const trustedSurface = { text: term, key: termKey(term) };
    return surfaces.some((surface) => surface.key === trustedSurface.key);
  }));
  return relatedTrustedTerms.length === 1
    ? { canonical: relatedTrustedTerms[0], source: "trusted_canonical_term" }
    : null;
}

function uniqueExactSpellings(values) {
  return [...new Map(values
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .map((value) => [canonicalSpellingKey(value), value])).values()];
}

function canonicalSpellingMismatchCode(authority) {
  return authority?.source === "independent_review"
    ? "canonical_spelling_review_mismatch"
    : "trusted_canonical_spelling_mismatch";
}

function signalTerms(signal) {
  return signal?.kind === "surface_variant_group"
    ? (Array.isArray(signal.terms) ? signal.terms : []).map((term) => String(term?.text || "").trim()).filter(Boolean)
    : [String(signal?.term || "").trim()].filter(Boolean);
}

function buildTerminologySignals(source) {
  const latinOccurrences = [];
  const latinPhraseCandidates = [];
  const mixedOccurrences = [];
  const technicalHanSuffixes = ["调度", "绑定", "接口", "任务", "节点", "副本", "状态", "类型", "策略", "服务"];
  for (const segment of source) {
    const text = String(segment.text || "");
    const tokens = [...text.matchAll(/[A-Za-z][A-Za-z0-9+#]*/gu)].map((match) => ({
      text: match[0],
      start: match.index,
      end: match.index + match[0].length,
    }));
    for (const token of tokens) {
      if (termKey(token.text).length >= 7 && latinOccurrences.length < MAX_SIGNAL_OCCURRENCES) {
        latinOccurrences.push({ text: token.text, key: termKey(token.text), segment_id: segment.id, start_offset: token.start });
      }
    }
    for (let index = 0; index < tokens.length - 1; index += 1) {
      const left = tokens[index];
      const right = tokens[index + 1];
      const separator = text.slice(left.end, right.start);
      if (!/^[\s_-]+$/u.test(separator)) continue;
      const phrase = text.slice(left.start, right.end);
      if (termKey(phrase).length < 7) continue;
      latinPhraseCandidates.push({
        text: phrase,
        key: termKey(phrase),
        left_text: left.text,
        right_text: right.text,
        segment_id: segment.id,
        start_offset: left.start,
      });
    }
    for (const match of text.matchAll(/(?<![A-Za-z0-9+#])([A-Za-z][A-Za-z0-9+#]{0,11})([\p{Script=Han}]{1,8})/gu)) {
      const suffix = technicalHanSuffixes.find((candidate) => match[2].startsWith(candidate));
      if (!suffix) continue;
      if (mixedOccurrences.length >= MAX_SIGNAL_OCCURRENCES) break;
      mixedOccurrences.push({
        text: `${match[1]}${suffix}`,
        key: termKey(`${match[1]}${suffix}`),
        segment_id: segment.id,
        start_offset: match.index,
      });
    }
  }

  const tokenSurfaces = [...new Map(latinOccurrences.map((occurrence) => (
    [`${occurrence.key}\u0000${occurrence.text.normalize("NFKC")}`, occurrence]
  ))).values()];
  for (const phrase of latinPhraseCandidates) {
    if (latinOccurrences.length >= MAX_SIGNAL_OCCURRENCES) break;
    if (!phraseHasTechnicalAnchor(phrase, tokenSurfaces, latinPhraseCandidates)) continue;
    latinOccurrences.push(phrase);
  }

  const surfaces = [...new Map(latinOccurrences.map((occurrence) => (
    [`${occurrence.key}\u0000${occurrence.text.normalize("NFKC")}`, occurrence]
  ))).values()].slice(0, MAX_SIGNAL_SURFACES);
  const parent = surfaces.map((_, index) => index);
  const find = (index) => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  const union = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };
  for (let left = 0; left < surfaces.length; left += 1) {
    for (let right = left + 1; right < surfaces.length; right += 1) {
      if (likelySurfaceVariants(surfaces[left], surfaces[right])) union(left, right);
    }
  }

  const grouped = new Map();
  surfaces.forEach((surface, index) => {
    const root = find(index);
    if (!grouped.has(root)) grouped.set(root, []);
    grouped.get(root).push(surface);
  });
  const surfaceGroups = [...grouped.values()].filter((group) => group.length > 1).map((group) => {
    const keys = new Set(group.map((surface) => surface.key));
    const spellings = new Set(group.map((surface) => surface.text.normalize("NFKC")));
    if (keys.size < 2 && spellings.size < 2) return null;
    const terms = group.slice(0, MAX_SIGNAL_TERMS_PER_GROUP).map((surface) => {
      const occurrences = latinOccurrences.filter((item) => (
        item.key === surface.key && item.text.normalize("NFKC") === surface.text.normalize("NFKC")
      ));
      return {
        text: surface.text,
        occurrence_count: occurrences.length,
        segment_ids: [...new Set(occurrences.map((item) => item.segment_id))].slice(0, MAX_SIGNAL_SEGMENTS_PER_TERM),
      };
    }).sort((left, right) => left.segment_ids[0] - right.segment_ids[0] || left.text.localeCompare(right.text, "en"));
    const segmentIds = [...new Set(terms.flatMap((term) => term.segment_ids))].sort((left, right) => left - right);
    return {
      kind: "surface_variant_group",
      required_disposition: highConfidenceSurfaceVariantGroup(group) ? "mapped" : "review",
      terms,
      segment_ids: segmentIds,
    };
  }).filter(Boolean).sort((left, right) => left.segment_ids[0] - right.segment_ids[0]);

  surfaceGroups.forEach((signal, index) => { signal.id = `surface-${index + 1}`; });
  const contextual = [...new Map(mixedOccurrences.map((occurrence) => [occurrence.key, occurrence])).values()]
    .map((surface) => {
      const occurrences = mixedOccurrences.filter((item) => item.key === surface.key);
      const segmentIds = [...new Set(occurrences.map((item) => item.segment_id))].sort((left, right) => left - right);
      const related = surfaceGroups.filter((group) => (
        segmentIds.some((id) => group.segment_ids.some((anchorId) => Math.abs(anchorId - id) <= 1))
      )).map((group) => group.id);
      if (!related.length) return null;
      return {
        kind: "contextual_mixed_script",
        term: surface.text,
        occurrence_count: occurrences.length,
        segment_ids: segmentIds,
        related_signal_ids: related,
        dismissal_policy: singleLetterMixedScriptTerm(surface.text) ? "map_or_audio_review" : "text_evidence",
      };
    }).filter(Boolean).sort((left, right) => left.segment_ids[0] - right.segment_ids[0] || left.term.localeCompare(right.term, "en"));
  contextual.forEach((signal, index) => { signal.id = `context-${index + 1}`; });
  return [...surfaceGroups, ...contextual].slice(0, MAX_TERMINOLOGY_SIGNALS).map((signal) => deepSignalFreeze(signal));
}

function phraseHasTechnicalAnchor(phrase, tokenSurfaces, phraseCandidates) {
  if (tokenSurfaces.some((surface) => (
    surface.key === phrase.key || likelySurfaceVariants(surface, phrase)
  ))) return true;
  const leftSurface = { text: phrase.left_text, key: termKey(phrase.left_text) };
  const rightSurface = { text: phrase.right_text, key: termKey(phrase.right_text) };
  if (!TECHNICAL_PHRASE_SUFFIXES.has(rightSurface.key)) return false;
  return phraseCandidates.some((candidate) => {
    if (candidate === phrase) return false;
    const candidateLeft = { text: candidate.left_text, key: termKey(candidate.left_text) };
    const candidateRight = { text: candidate.right_text, key: termKey(candidate.right_text) };
    return candidateLeft.key !== leftSurface.key
      && candidateRight.key === rightSurface.key
      && shortPhrasePrefixVariants(leftSurface, candidateLeft);
  });
}

function shortPhrasePrefixVariants(leftSurface, rightSurface) {
  const left = leftSurface.key;
  const right = rightSurface.key;
  if (!left || !right || left[0] !== right[0]) return false;
  if (Math.max(left.length, right.length) > 6 || Math.abs(left.length - right.length) > 2) return false;
  return editDistanceWithin(left, right, 2);
}

function highConfidenceSurfaceVariantGroup(group) {
  const spellingCountsByKey = new Map();
  for (const surface of group) {
    if (!spellingCountsByKey.has(surface.key)) spellingCountsByKey.set(surface.key, new Set());
    spellingCountsByKey.get(surface.key).add(surface.text.normalize("NFKC"));
  }
  const hasEquivalentSpellings = [...spellingCountsByKey.values()].some((spellings) => spellings.size >= 2);
  return hasEquivalentSpellings && group.some((surface) => identifierLikeSurface(surface.text));
}

function identifierLikeSurface(value) {
  const text = String(value || "").normalize("NFKC");
  return /[_-]/u.test(text)
    || /[a-z][A-Z]/u.test(text)
    || /[A-Z]{2,}|[0-9+#]/u.test(text);
}

function likelySurfaceVariants(leftSurface, rightSurface) {
  const left = leftSurface.key;
  const right = rightSurface.key;
  if (!left || !right) return false;
  if (left === right) return true;
  if (left[0] !== right[0]) return false;
  if (left.includes(right) || right.includes(left)) return false;
  if (
    Math.abs(left.length - right.length) >= 3
    && !hasSingleLetterToken(leftSurface.text)
    && !hasSingleLetterToken(rightSurface.text)
  ) return false;
  const maximum = Math.max(left.length, right.length);
  const limit = Math.max(1, Math.floor(maximum * 0.25));
  return editDistanceWithin(left, right, limit);
}

function hasSingleLetterToken(value) {
  return String(value || "").split(/[\s_-]+/u).some((token) => /^[A-Za-z]$/u.test(token));
}

function editDistanceWithin(left, right, limit) {
  if (Math.abs(left.length - right.length) > limit) return false;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    let rowMinimum = current[0];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + cost,
      );
      rowMinimum = Math.min(rowMinimum, current[rightIndex]);
    }
    if (rowMinimum > limit) return false;
    previous = current;
  }
  return previous[right.length] <= limit;
}

function deepSignalFreeze(signal) {
  if (Array.isArray(signal.terms)) signal.terms.forEach((term) => Object.freeze(term.segment_ids) && Object.freeze(term));
  if (Array.isArray(signal.segment_ids)) Object.freeze(signal.segment_ids);
  if (Array.isArray(signal.related_signal_ids)) Object.freeze(signal.related_signal_ids);
  return Object.freeze(signal);
}

function sameSpelling(left, right) {
  return String(left || "").normalize("NFKC") === String(right || "").normalize("NFKC");
}

function singleLetterMixedScriptTerm(value) {
  return /^[A-Za-z]调度$/u.test(String(value || "").normalize("NFKC").trim());
}

function audioRangeCoversSegment(start, end, segment) {
  const segmentStart = Math.max(0, Number(segment?.start_seconds) || 0);
  const segmentEnd = Math.max(segmentStart, Number(segment?.end_seconds) || segmentStart);
  const tolerance = 0.05;
  return start <= segmentStart + tolerance && end >= segmentEnd - tolerance;
}

function audioReviewFailureCode(error) {
  const status = Number(error?.status);
  if (Number.isInteger(status) && status >= 400 && status <= 599) return `http_${status}`;
  const code = String(error?.code || "").trim();
  return new Set([
    "timeout",
    "aborted",
    "relay-unavailable",
    "network-or-cors",
    "response-interrupted",
    "invalid-response",
  ]).has(code) ? code : "audio_review_failed";
}

function completedAudioReviewsForSignal(state, signal, source, allowedReviewIds) {
  const allowed = Array.isArray(allowedReviewIds) ? new Set(allowedReviewIds) : null;
  const reviews = (Array.isArray(state?.audio_reviews) ? state.audio_reviews : []).filter((review) => (
    review?.status === "completed"
    && (!allowed || allowed.has(review.id))
    && String(review.evidence_text || "").trim()
    && audioReviewSupportsDismissal(review.evidence_text, state, signal, source, review)
    && Array.isArray(review.signal_ids)
    && review.signal_ids.includes(signal.id)
    && Array.isArray(review.segment_ids)
    && review.segment_ids.some((id) => signal.segment_ids.includes(id))
    && review.segment_ids.every((id) => source[id] && audioRangeCoversSegment(Number(review.start_seconds), Number(review.end_seconds), source[id]))
  ));
  const reviewedSegmentIds = new Set(reviews.flatMap((review) => review.segment_ids));
  return signal.segment_ids.every((id) => reviewedSegmentIds.has(id)) ? reviews : [];
}

function audioReviewSupportsDismissal(evidenceText, state, signal, source, review) {
  const evidenceKey = termKey(evidenceText);
  const signalKey = termKey(signal?.term);
  if (evidenceKey.length < 4 || (signalKey && evidenceKey.includes(signalKey))) return false;
  const relatedSignalIds = new Set(Array.isArray(signal?.related_signal_ids) ? signal.related_signal_ids : []);
  const relatedCanonicals = (Array.isArray(state?.signal_resolutions) ? state.signal_resolutions : [])
    .filter((resolution) => relatedSignalIds.has(resolution.signal_id) && resolution.disposition === "mapped")
    .map((resolution) => termKey(resolution.canonical))
    .filter(Boolean);
  if (relatedCanonicals.some((canonical) => evidenceKey.includes(canonical))) return false;
  const sourceContext = (Array.isArray(review?.segment_ids) ? review.segment_ids : [])
    .map((id) => String(source[id]?.text || "").replaceAll(String(signal?.term || ""), " "))
    .join(" ");
  return audioEvidenceMatchesSourceContext(evidenceText, sourceContext);
}

function contextualSignalMappingAuthorized(state, signal, canonical, source) {
  const explicit = (Array.isArray(state?.candidates) ? state.candidates : []).some((candidate) => (
    candidate.source === "explicit_context"
    && termKey(candidate.alias) === termKey(signal.term)
    && sameSpelling(candidate.canonical, canonical)
  ));
  return explicit || completedAudioReviewsSupportingMapping(state, signal, canonical, source).length > 0;
}

function completedAudioReviewsSupportingMapping(state, signal, canonical, source) {
  const aliasKey = termKey(signal?.term);
  const canonicalKey = termKey(canonical);
  const reviews = (Array.isArray(state?.audio_reviews) ? state.audio_reviews : []).filter((review) => {
    const evidenceKey = termKey(review?.evidence_text);
    return review?.status === "completed"
      && evidenceKey
      && ((aliasKey && evidenceKey.includes(aliasKey)) || (canonicalKey && evidenceKey.includes(canonicalKey)))
      && Array.isArray(review.signal_ids)
      && review.signal_ids.includes(signal.id)
      && Array.isArray(review.segment_ids)
      && review.segment_ids.some((id) => signal.segment_ids.includes(id))
      && review.segment_ids.every((id) => source[id] && audioRangeCoversSegment(Number(review.start_seconds), Number(review.end_seconds), source[id]));
  });
  const reviewedSegmentIds = new Set(reviews.flatMap((review) => review.segment_ids));
  return signal.segment_ids.every((id) => reviewedSegmentIds.has(id)) ? reviews : [];
}

function audioEvidenceMatchesSourceContext(evidenceText, sourceContext) {
  const evidence = String(evidenceText || "").normalize("NFKC").toLocaleLowerCase();
  const context = String(sourceContext || "").normalize("NFKC").toLocaleLowerCase();
  const latinTokens = [...new Set(context.match(/[a-z0-9+#]{3,}/gu) || [])];
  const latinMatches = latinTokens.filter((token) => evidence.includes(token)).length;
  const hanBigrams = new Set();
  for (const match of context.matchAll(/[\p{Script=Han}]{2,}/gu)) {
    const characters = [...match[0]];
    for (let index = 0; index < characters.length - 1; index += 1) {
      hanBigrams.add(`${characters[index]}${characters[index + 1]}`);
    }
  }
  const hanMatches = [...hanBigrams].filter((token) => evidence.includes(token)).length;
  return hanMatches >= 2 || (latinMatches >= 1 && hanMatches >= 1) || latinMatches >= 2;
}

function relatedMappedCanonicals(state, signal) {
  const related = new Set(Array.isArray(signal?.related_signal_ids) ? signal.related_signal_ids : []);
  return [...new Set((Array.isArray(state?.signal_resolutions) ? state.signal_resolutions : [])
    .filter((resolution) => related.has(resolution.signal_id) && resolution.disposition === "mapped")
    .map((resolution) => String(resolution.canonical || "").trim())
    .filter(Boolean))];
}

function audioReviewEvidenceText(review) {
  const direct = String(review?.text || "").trim();
  const segmentText = Array.isArray(review?.segments)
    ? review.segments.map((segment) => String(segment?.text || "").trim()).filter(Boolean).join(" ")
    : "";
  return String(direct || segmentText).slice(0, MAX_AUDIO_REVIEW_EVIDENCE_CHARACTERS);
}

function uniqueSignalTerms(signals) {
  const terms = signals.flatMap((signal) => (
    signal?.kind === "surface_variant_group"
      ? signal.terms.map((term) => term.text)
      : [signal?.term]
  )).map((term) => String(term || "").trim()).filter(Boolean);
  return [...new Map(terms.map((term) => [termKey(term), term])).values()];
}

function validateMappings(mappings, state, segmentCount, scanOccurrences, trustedMappingKeys) {
  const normalized = normalizeMappings(mappings);
  const violations = [];
  const byAlias = new Map();
  for (const mapping of normalized) {
    const aliasKey = mappingAliasKey(mapping.alias);
    const existing = byAlias.get(aliasKey);
    if (existing && !sameSpelling(existing, mapping.canonical)) {
      violations.push({ code: "alias_has_conflicting_canonicals", alias: mapping.alias });
      continue;
    }
    byAlias.set(aliasKey, mapping.canonical);
    const occurrences = scanOccurrences(mapping.alias, mapping.canonical);
    if (!occurrences.length) violations.push({ code: "alias_not_found", alias: mapping.alias });
    const wasSubmitted = state.candidates.some((candidate) => mappingKey(candidate) === mappingKey(mapping));
    if (!wasSubmitted && !trustedMappingKeys.has(mappingKey(mapping))) {
      violations.push({ code: "mapping_missing_submitted_evidence", alias: mapping.alias, canonical: mapping.canonical });
    }
  }
  for (const candidate of state.candidates) {
    if (!normalized.some((mapping) => mappingKey(mapping) === mappingKey(candidate))) {
      violations.push({ code: "submitted_candidate_missing_from_final_mapping", alias: candidate.alias, canonical: candidate.canonical });
    }
  }
  for (const candidate of state.candidates) {
    const invalidEvidence = candidate.evidence_segment_ids.some((id) => !Number.isInteger(id) || id < 0 || id >= segmentCount);
    if (invalidEvidence) violations.push({ code: "candidate_has_invalid_evidence", alias: candidate.alias });
  }
  return { mappings: normalized, violations: uniqueViolations(violations) };
}

function normalizeMappings(value) {
  const mappings = [];
  const seen = new Set();
  for (const item of Array.isArray(value) ? value : []) {
    const alias = String(item?.alias || "").trim();
    const canonical = String(item?.canonical || "").trim();
    if (!alias || !canonical || alias.length > MAX_TERM_CHARACTERS || canonical.length > MAX_TERM_CHARACTERS) continue;
    const key = mappingKey({ alias, canonical });
    if (seen.has(key)) continue;
    seen.add(key);
    mappings.push({ alias, canonical });
  }
  return mappings.slice(0, MAX_CANDIDATES);
}

function occurrenceSegmentIds(occurrences) {
  return [...new Set((Array.isArray(occurrences) ? occurrences : [])
    .map((item) => Number(item?.segment_id))
    .filter(Number.isInteger))];
}

function mappingKey(mapping) {
  return `${mappingAliasKey(mapping?.alias)}=>${canonicalSpellingKey(mapping?.canonical)}`;
}

function mappingAliasKey(value) {
  return String(value || "").normalize("NFKC").trim().toLocaleLowerCase("en-US").replace(/[\s\p{Pd}_]+/gu, "");
}

function canonicalSpellingKey(value) {
  return String(value || "").normalize("NFKC").trim();
}

function termKey(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase("en-US").replace(/[\s\p{P}\p{S}]+/gu, "");
}

function uniqueViolations(violations) {
  const seen = new Set();
  return violations.filter((violation) => {
    const key = JSON.stringify(violation);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mappingArraySchema(minItems = 0, maxItems = MAX_CANDIDATES) {
  return arraySchema(objectSchema({
    alias: stringSchema(1, MAX_TERM_CHARACTERS),
    canonical: stringSchema(1, MAX_TERM_CHARACTERS),
  }), minItems, maxItems);
}

function objectSchema(properties) {
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}

function arraySchema(items, minItems = 0, maxItems = MAX_CANDIDATES) {
  return { type: "array", items, minItems, maxItems };
}

function stringSchema(minLength, maxLength) {
  return { type: "string", minLength, maxLength };
}

function enumSchema(values) {
  return { type: "string", enum: values };
}

function integerSchema(minimum, maximum = Number.MAX_SAFE_INTEGER) {
  return { type: "integer", minimum, maximum };
}

function numberSchema(minimum, maximum = Number.MAX_SAFE_INTEGER) {
  return { type: "number", minimum, maximum };
}
