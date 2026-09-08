const object = (properties) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const string = (minLength, maxLength) => ({ type: "string", minLength, maxLength });
const integer = (minimum, maximum) => ({ type: "integer", minimum, maximum });
const array = (items, minItems, maxItems) => ({ type: "array", items, minItems, maxItems });
import { locateAudioSpan } from "../../audio-span-locator.js";
export const evidenceTextKey = (value) => String(value || "").normalize("NFKC").toLowerCase().replace(/[\s\p{P}]/gu, "");

export function createTranscriptEvidenceTools({ source, alternatives = [], alignedSegments = [] }) {
  return [{
    name: "search_recording_terms", description: "Search exact terms across the whole original recording, returning occurrence counts, locations and local context. Use to test entity consistency instead of guessing familiar names.",
    strict: true, stateful: false, parameters: object({ terms: array(string(1, 120), 1, 12) }),
    execute({ terms }) {
      return { output: { results: terms.map((term) => {
        let count = 0;
        const occurrences = [];
        for (const segment of source) {
          let offset = segment.text.toLowerCase().indexOf(term.toLowerCase());
          while (offset >= 0) {
            count += 1;
            if (occurrences.length < 12) occurrences.push({ segment_id: segment.id, start_offset: offset, start_seconds: segment.start_seconds, context: segment.text.slice(Math.max(0, offset - 60), offset + term.length + 60) });
            offset = segment.text.toLowerCase().indexOf(term.toLowerCase(), offset + term.length);
          }
        }
        return { term, count, occurrences, omitted_occurrences: Math.max(0, count - occurrences.length) };
      }) } };
    },
  }, {
    name: "inspect_transcript_boundary", description: "Inspect exact adjacent source text and proposed boundary reconstruction. Reports duplicated prefix/suffix without rewriting anything or inventing timestamps.",
    strict: true, stateful: false, parameters: object({ segment_id: integer(0, 100_000) }),
    execute({ segment_id }) {
      const segment = source[segment_id];
      if (!segment) return { output: { ok: false, code: "unknown_segment" } };
      return { output: { segment_id, previous_tail: source[segment_id - 1]?.text.slice(-120) || "", current_head: segment.text.slice(0, 120), current_tail: segment.text.slice(-120), next_head: source[segment_id + 1]?.text.slice(0, 120) || "",
        left_join: (source[segment_id - 1]?.text.slice(-80) || "") + segment.text.slice(0, 80), right_join: segment.text.slice(-80) + (source[segment_id + 1]?.text.slice(0, 80) || "") } };
    },
  }, {
    name: "compare_audio_hypotheses", description: "Compare primary, expanded-window and independent ASR hypotheses for the target segment. Returns candidate occurrence support per view; agreement is not ground truth.",
    strict: true, stateful: false, parameters: object({ segment_id: integer(0, 100_000), candidates: array(string(1, 120), 1, 12) }),
    execute({ segment_id, candidates }, { state }) {
      const segment = source[segment_id];
      if (!segment) return { output: { ok: false, code: "unknown_segment" } };
      const views = evidenceViews(segment, state.audio, alternatives);
      return { output: { segment_id, source_text: segment.text, views: views.map((view) => ({ ...view, text: view.text.slice(0, 1800) })),
        candidates: candidates.map((candidate) => ({ candidate, supported_by: views.filter((view) => evidenceTextKey(view.text).includes(evidenceTextKey(candidate))).map((view) => view.id) })),
        limitations: "Matches may come from adjacent speech; inspect context and occurrence. Same-model windows are correlated evidence, not independent truth." } };
    },
  }, {
    name: "locate_suspect_audio", description: "Locate a short audio review window from timestamped ASR words using exact unchanged text on BOTH sides of a suspect. Returns an estimate or a clear ambiguity error, never invented word timing.",
    strict: true, stateful: false, parameters: object({ segment_id: integer(0, 100_000), before: string(1, 120), start_offset: integer(-1, 1_000_000) }),
    execute({ segment_id, before, start_offset }) {
      if (!source[segment_id]) return { output: { ok: false, code: "unknown_segment" } };
      return { output: locateAudioSpan(source[segment_id], before, start_offset, alignedSegments) };
    },
  }];
}

export function evidenceViews(segment, reviews = [], alternatives = []) {
  return [
    ...reviews.filter((review) => review.segment_id === segment.id && review.status === "completed").map((review) => ({ id: review.id, kind: review.variant === "expanded" ? "expanded_audio" : review.variant === "focused" ? "focused_audio" : "primary_audio", text: review.text, start_seconds: review.start_seconds, end_seconds: review.end_seconds,
      ...(review.target_start_offset != null ? { target_start_offset: review.target_start_offset, target_end_offset: review.target_end_offset } : {}) })),
    ...alternatives.filter((item) => item.start_seconds < segment.end_seconds && item.end_seconds > segment.start_seconds).map((item, index) => ({ id: `independent-${segment.id}-${index}`, kind: "independent_asr", text: item.text, start_seconds: item.start_seconds, end_seconds: item.end_seconds })),
  ];
}

export function corroboratingViews(segment, after, reviews, alternatives, selectedReviewId, patch) {
  const key = evidenceTextKey(after);
  if (!key) return [];
  const views = evidenceViews(segment, reviews, alternatives);
  const selected = views.find((view) => view.id === selectedReviewId);
  return views.filter((view) => view.id !== selectedReviewId && evidenceTextKey(view.text).includes(key)
    && (view.target_start_offset == null || (patch && patch.start_offset < view.target_end_offset && patch.end_offset > view.target_start_offset))
    && (view.kind === "independent_asr" || view.start_seconds !== selected?.start_seconds || view.end_seconds !== selected?.end_seconds));
}
