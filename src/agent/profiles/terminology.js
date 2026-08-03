const MAX_WINDOW_SEGMENTS = 60;
const MAX_CANDIDATES = 200;
const MAX_TERM_CHARACTERS = 120;
const MAX_AUDIO_REVIEWS = 4;
const MAX_AUDIO_REVIEW_SECONDS = 30;
const MAX_TERMINOLOGY_SIGNALS = 60;
const MAX_SIGNAL_SURFACES = 300;
const MAX_SIGNAL_OCCURRENCES = 2_000;
const MAX_SIGNAL_TERMS_PER_GROUP = 12;
const MAX_SIGNAL_SEGMENTS_PER_TERM = 20;

export function createTerminologyAgentProfile({
  segments = [],
  contextHint = "",
  canonicalTerms = [],
  explicitMappings = [],
  priorMappings = [],
  scanOccurrences,
  finalizeMappings,
  transcribeAudioRange,
} = {}) {
  if (typeof scanOccurrences !== "function") throw new TypeError("Terminology profile requires scanOccurrences");
  if (typeof finalizeMappings !== "function") throw new TypeError("Terminology profile requires finalizeMappings");
  const source = segments.map((segment, id) => Object.freeze({
    id,
    start_seconds: Math.max(0, Number(segment?.start_seconds) || 0),
    end_seconds: Math.max(0, Number(segment?.end_seconds) || 0),
    speaker: String(segment?.speaker || "发言人"),
    text: String(segment?.text || ""),
  }));
  const terminologySignals = buildTerminologySignals(source);
  const trustedMappings = normalizeMappings(explicitMappings);
  const trustedMappingKeys = new Set(trustedMappings.map(mappingKey));
  const trustedAliasKeys = new Set(trustedMappings.map((mapping) => termKey(mapping.alias)));
  const persistedMappings = normalizeMappings(priorMappings)
    .filter((mapping) => !trustedAliasKeys.has(termKey(mapping.alias)));
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
          const item = {
            alias,
            canonical,
            evidence_segment_ids: evidenceIds,
            confidence: candidate.confidence,
            source: trustedMappingKeys.has(mappingKey({ alias, canonical }))
              ? "explicit_context"
              : (persistedMappingKeys.has(mappingKey({ alias, canonical })) ? "persisted_recording" : "luna_proposal"),
          };
          accepted.set(mappingKey(item), item);
        }
        const nextCandidates = [...accepted.values()].slice(0, MAX_CANDIDATES);
        trace.append("term.candidates_submitted", { accepted: nextCandidates.length - state.candidates.length, rejected: rejected.length });
        return {
          state: { ...state, candidates: nextCandidates, candidate_revision: state.candidate_revision + 1 },
          output: { ok: rejected.length === 0, accepted_count: nextCandidates.length, rejected },
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
      description: "Deterministically scan the entire recording for every normalized occurrence of one proposed alias. Use it to verify cross-window consistency before finalization.",
      strict: true,
      parameters: objectSchema({
        alias: stringSchema(1, MAX_TERM_CHARACTERS),
        canonical: stringSchema(1, MAX_TERM_CHARACTERS),
      }),
      execute({ alias, canonical }, { trace }) {
        const occurrences = scanOccurrences(alias.trim(), canonical.trim());
        trace.append("term.alias_scanned", { alias: alias.trim(), occurrence_count: occurrences.length });
        return { output: { alias: alias.trim(), canonical: canonical.trim(), occurrences } };
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
          if (signal.required_disposition === "mapped" && decision.disposition !== "mapped") {
            rejected.push({ signal_id: signalId, reason: "high_confidence_surface_variants_require_mapping" });
            continue;
          }
          if (decision.disposition === "mapped" && !canonical) {
            rejected.push({ signal_id: signalId, reason: "mapped_signal_requires_canonical" });
            continue;
          }
          resolutions.set(signalId, {
            signal_id: signalId,
            disposition: decision.disposition,
            canonical: decision.disposition === "mapped" ? canonical : "",
            reason: decision.reason.trim(),
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
    {
      name: "validate_mapping_group",
      description: "Validate a complete alias-to-canonical mapping group against submitted evidence and detect conflicts before attempting to finalize.",
      strict: true,
      stateful: true,
      parameters: mappingListSchema(),
      execute({ mappings }, { state, trace }) {
        const validation = validateCompletionMappings(
          mappings,
          state,
          source.length,
          scanOccurrences,
          trustedMappingKeys,
          terminologySignals,
        );
        const record = mappingValidationRecord(mappings, state, validation.violations);
        trace.append("term.mapping_validated", { mapping_count: mappings.length, violations: validation.violations.length });
        return {
          state: { ...state, validations: [...state.validations, record].slice(-10) },
          output: { ok: validation.violations.length === 0, ...record },
        };
      },
    },
    ...(typeof transcribeAudioRange === "function" ? [{
      name: "transcribe_audio_range",
      description: "Ask MiMo-V2.5-ASR to re-transcribe one short, uncertain audio range. Use only when transcript context is insufficient to resolve a technical term.",
      strict: true,
      stateful: true,
      parameters: objectSchema({
        start_seconds: numberSchema(0),
        end_seconds: numberSchema(0),
        reason: stringSchema(1, 240),
      }),
      async execute({ start_seconds: start, end_seconds: end, reason }, { state, signal, trace }) {
        const duration = end - start;
        if (state.audio_reviews.length >= MAX_AUDIO_REVIEWS) {
          return { output: { ok: false, error: "audio_review_budget_exhausted" } };
        }
        if (!(duration > 0) || duration > MAX_AUDIO_REVIEW_SECONDS) {
          return { output: { ok: false, error: "audio_range_must_be_between_0_and_30_seconds" } };
        }
        const record = { start_seconds: start, end_seconds: end, reason };
        try {
          const review = await transcribeAudioRange({ start_seconds: start, end_seconds: end, reason, signal });
          trace.append("term.audio_retranscribed", { start_seconds: start, end_seconds: end });
          return {
            state: {
              ...state,
              audio_reviews: [...state.audio_reviews, { ...record, status: "completed" }],
              audio_revision: state.audio_revision + 1,
            },
            output: { ok: true, ...review },
          };
        } catch (error) {
          if (signal?.aborted || error?.name === "AbortError") throw error;
          trace.append("term.audio_failed", { start_seconds: start, end_seconds: end, code: String(error?.code || "audio_review_failed") });
          return {
            state: {
              ...state,
              audio_reviews: [...state.audio_reviews, { ...record, status: "failed" }],
              audio_revision: state.audio_revision + 1,
            },
            output: { ok: false, error: { code: String(error?.code || "audio_review_failed"), message: String(error?.message || error) } },
          };
        }
      },
    }] : []),
    {
      name: "finalize_correction",
      description: "Commit the only allowed corrected-transcript artifact after full recording coverage and mapping validation. The runtime, not the model, preserves speakers and timestamps and applies edits.",
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
          source.length,
          scanOccurrences,
          trustedMappingKeys,
          terminologySignals,
        );
        const uncovered = source.map((segment) => segment.id).filter((id) => !state.covered_segment_ids.includes(id));
        if (uncovered.length) validation.violations.unshift({
          code: "recording_not_fully_inspected",
          remaining_segments: uncovered.slice(0, 100),
          remaining_count: uncovered.length,
        });
        if (!validation.violations.length && !hasCurrentSuccessfulValidation(mappings, state)) {
          validation.violations.push({ code: "mapping_group_not_validated" });
        }
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

  const trustedTerms = [...new Set(canonicalTerms.map((term) => String(term || "").trim()).filter(Boolean))];
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
  });

  return {
    name: "terminology-supervisor",
    initialState,
    input,
    tools,
    instructions: `You are the GPT Luna terminology supervisor for one meeting recording. Operate as an agent by choosing tools based on evidence; do not emit or rewrite a transcript yourself.

Required completion invariant:
1. Inspect every transcript segment with read_transcript_window. The runtime rejects finalization while any segment is unread.
2. Call inspect_terminology_signals after full coverage. It is a runtime-generated suspect inventory, not a gold answer.
3. Identify every repeated technical entity and all of its spelling, spacing, transliteration, and ASR variants. Resolve every inventory signal with resolve_terminology_signals; high-confidence surface_variant_group signals require a canonical mapping, while contextual signals may be dismissed with evidence. The same entity must have exactly one canonical spelling throughout this recording.
4. Treat explicit mappings and trusted canonical terms as authoritative. Prior validated mappings are revisable evidence, not user authority; reject them when current transcript or MiMo evidence disproves them. Never map an unrelated common phrase merely because it is similar; only contextual false-positive signals may be marked distinct_terms or not_terminology with evidence.
5. Submit candidates with concrete segment evidence, scan their recording-wide occurrences, and validate the complete mapping group after the latest candidate and signal decisions.
6. If later evidence disproves one of your own candidates, call reject_term_candidates with a concrete reason before validating again. Explicit user mappings cannot be rejected.
7. When audio evidence is available, call transcribe_audio_range only for genuinely uncertain ranges. MiMo is evidence, not the final editor.
8. Call finalize_correction exactly once with the exact mapping set from the latest successful validation. Only that tool may commit an artifact. It preserves segment IDs, speakers, timestamps, and critical facts.

State-changing tools (window reads, inventory inspection, candidate submission/rejection, signal resolution, validation, audio review, and finalization) must be called in separate model turns. Multiple scan_alias_occurrences calls may be issued together.

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
      return `The terminology artifact is not finalized. Continue using tools; ${remaining} transcript segments remain unread and ${unresolved} terminology signals remain unresolved. Call finalize_correction only after inventory review and current mapping validation pass.`;
    },
  };
}

function validateCompletionMappings(mappings, state, segmentCount, scanOccurrences, trustedMappingKeys, terminologySignals) {
  const validation = validateMappings(mappings, state, segmentCount, scanOccurrences, trustedMappingKeys);
  validation.violations.push(...validateSignalResolutions(mappings, state, terminologySignals));
  validation.violations = uniqueViolations(validation.violations);
  return validation;
}

function validateSignalResolutions(mappings, state, terminologySignals) {
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
    if (resolution.disposition !== "mapped") continue;
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

function hasCurrentSuccessfulValidation(mappings, state) {
  const expected = mappingValidationRecord(mappings, state, []);
  return state.validations.some((record) => (
    record.candidate_revision === expected.candidate_revision
    && record.resolution_revision === expected.resolution_revision
    && record.audio_revision === expected.audio_revision
    && JSON.stringify(record.mapping_keys || []) === JSON.stringify(expected.mapping_keys)
    && Array.isArray(record.violations)
    && record.violations.length === 0
  ));
}

function buildTerminologySignals(source) {
  const latinOccurrences = [];
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
      if (latinOccurrences.length < MAX_SIGNAL_OCCURRENCES) {
        latinOccurrences.push({ text: phrase, key: termKey(phrase), segment_id: segment.id, start_offset: left.start });
      }
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
    return { kind: "surface_variant_group", required_disposition: "mapped", terms, segment_ids: segmentIds };
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
      };
    }).filter(Boolean).sort((left, right) => left.segment_ids[0] - right.segment_ids[0] || left.term.localeCompare(right.term, "en"));
  contextual.forEach((signal, index) => { signal.id = `context-${index + 1}`; });
  return [...surfaceGroups, ...contextual].slice(0, MAX_TERMINOLOGY_SIGNALS).map((signal) => deepSignalFreeze(signal));
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

function validateMappings(mappings, state, segmentCount, scanOccurrences, trustedMappingKeys) {
  const normalized = normalizeMappings(mappings);
  const violations = [];
  const byAlias = new Map();
  for (const mapping of normalized) {
    const aliasKey = termKey(mapping.alias);
    const existing = byAlias.get(aliasKey);
    if (existing && termKey(existing) !== termKey(mapping.canonical)) {
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
  return `${termKey(mapping?.alias)}=>${termKey(mapping?.canonical)}`;
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

function mappingListSchema() {
  return objectSchema({ mappings: mappingArraySchema() });
}

function mappingArraySchema() {
  return arraySchema(objectSchema({
    alias: stringSchema(1, MAX_TERM_CHARACTERS),
    canonical: stringSchema(1, MAX_TERM_CHARACTERS),
  }), 0, MAX_CANDIDATES);
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
