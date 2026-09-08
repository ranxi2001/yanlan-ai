import { contentSourceSignature } from "./meeting-content.js";
import { UNKNOWN_SPEAKER } from "./transcript-speakers.js";

function finite(value) { return typeof value === "number" && Number.isFinite(value) && value >= 0; }

function normalized(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
}

// Acoustic workers annotate the current transcript; they cannot replace its words.
export function applyAcousticAnnotations(meeting, annotation) {
  const source = meeting.segments || [];
  if (annotation?.schema !== 1 || annotation.source_signature !== contentSourceSignature(source)) throw new Error("acoustic_source_changed");
  if (!finite(annotation.audio_duration) || annotation.audio_duration <= 0 || !Array.isArray(annotation.segments)
    || annotation.segments.length !== source.length || !Array.isArray(annotation.speaker_turns)
    || annotation.speaker_turns.length > 100_000) throw new Error("invalid_acoustic_annotation");
  const turns = annotation.speaker_turns;
  let previous = -1;
  for (const turn of turns) {
    if (!finite(turn.start_seconds) || !finite(turn.end_seconds) || turn.end_seconds <= turn.start_seconds
      || turn.end_seconds > annotation.audio_duration || turn.start_seconds < previous
      || typeof turn.speaker !== "string" || !turn.speaker.trim() || turn.speaker.length > 120) throw new Error("invalid_speaker_turn");
    previous = turn.start_seconds;
  }
  const byId = new Map();
  for (const item of annotation.segments) {
    if (!Number.isInteger(item.source_segment_id) || item.source_segment_id < 0 || item.source_segment_id >= source.length
      || byId.has(item.source_segment_id) || !Array.isArray(item.words) || item.words.length > 20_000) throw new Error("invalid_aligned_segment");
    byId.set(item.source_segment_id, item);
  }
  const output = [];
  const mappings = [];
  let aligned = 0;
  // A moving interval cursor avoids rescanning every turn for every word.
  let turnCursor = 0;
  let lastWordStart = -1;
  function identify(start, end) {
    if (start < lastWordStart) turnCursor = 0;
    lastWordStart = start;
    while (turnCursor < turns.length && turns[turnCursor].end_seconds <= start) turnCursor += 1;
    const candidates = new Map();
    for (let i = turnCursor; i < turns.length && turns[i].start_seconds < end; i += 1) {
      const turn = turns[i];
      const overlap = Math.max(0, Math.min(end, turn.end_seconds) - Math.max(start, turn.start_seconds));
      if (overlap) candidates.set(turn.speaker, (candidates.get(turn.speaker) || 0) + overlap);
    }
    const ranked = [...candidates].sort((a, b) => b[1] - a[1]);
    if (!ranked.length || ranked[0][1] / (end - start) < 0.5) return { speaker: UNKNOWN_SPEAKER, speaker_source: "unknown", speaker_scope: "unknown" };
    if (ranked[1] && ranked[1][1] / (end - start) >= 0.25) return { speaker: "重叠发言", speaker_source: "unknown", speaker_scope: "unknown", overlapping_speakers: ranked.map(([label]) => label) };
    return { speaker: ranked[0][0], speaker_source: "diarization", speaker_scope: "recording" };
  }
  source.forEach((segment, index) => {
    const words = byId.get(index).words;
    const text = String(segment.text || "");
    let endOffset = 0;
    let startTime = -1;
    for (const word of words) {
      if (!Number.isInteger(word.start_offset) || !Number.isInteger(word.end_offset) || word.start_offset !== endOffset
        || word.end_offset <= word.start_offset || word.end_offset > text.length
        || !finite(word.start_seconds) || !finite(word.end_seconds) || word.end_seconds <= word.start_seconds
        || word.start_seconds < startTime || word.end_seconds > annotation.audio_duration
        || normalized(text.slice(word.start_offset, word.end_offset)) !== normalized(word.text)) throw new Error("invalid_word_alignment");
      endOffset = word.end_offset;
      startTime = word.start_seconds;
    }
    if (!words.length) {
      output.push({ ...segment, speaker: UNKNOWN_SPEAKER, speaker_source: "unknown", speaker_scope: "unknown" });
      mappings.push({ source_segment_id: index, output_segment_id: output.length - 1, start_offset: 0, end_offset: text.length, timing_source: "unchanged" });
      return;
    }
    if (endOffset !== text.length) throw new Error("incomplete_word_alignment");
    aligned += 1;
    let group;
    for (const word of words) {
      const label = identify(word.start_seconds, word.end_seconds);
      if (!group || group.speaker !== label.speaker || group.text.length >= 160 || /[。！？!?]\s*$/u.test(group.text)) {
        group = { start_seconds: word.start_seconds, end_seconds: word.end_seconds, timing_source: "alignment", ...label, text: text.slice(word.start_offset, word.end_offset) };
        output.push(group);
        mappings.push({ source_segment_id: index, output_segment_id: output.length - 1, start_offset: word.start_offset, end_offset: word.end_offset, timing_source: "alignment" });
      } else {
        group.end_seconds = Math.max(group.end_seconds, word.end_seconds);
        group.text += text.slice(word.start_offset, word.end_offset);
        mappings.at(-1).end_offset = word.end_offset;
      }
    }
  });
  const result = { ...meeting, segments: output,
    acousticAnnotations: { schema: 1, source_signature: annotation.source_signature, source_segments: structuredClone(source), mappings,
      aligned_segments: aligned, total_segments: source.length, provider: String(annotation.provider || "external").slice(0, 120) },
  };
  // Preserve the previous revision explicitly; old quote offsets must not be replayed on new segments.
  result.acousticAnnotations.previous_revision = {
    rawSegments: meeting.rawSegments, corrections: meeting.corrections, asrReconciliations: meeting.asrReconciliations,
  };
  result.rawSegments = structuredClone(output);
  result.corrections = [];
  result.asrReconciliations = [];
  for (const key of ["summary", "keywords", "highlights", "speaker_summaries", "decisions", "decision_records", "action_items", "summary_content", "summary_kind", "analysisRun", "analysis_proof", "contentRun", "interviewReport"]) delete result[key];
  result.summaryError = "说话人或时间轴已更新，请重新生成纪要。";
  return result;
}
