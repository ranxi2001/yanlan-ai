export const UNKNOWN_SPEAKER = "未区分说话人";

export function speakerAttributionAvailable(segment) {
  const label = String(segment?.speaker || "").trim();
  if (!label || label === UNKNOWN_SPEAKER || segment?.speaker_source === "unknown" || segment?.speaker_scope === "request") return false;
  // A historical default label does not establish that the recording had one speaker.
  if (!segment?.speaker_source && /^发言人\s*1$/u.test(label)) return false;
  return true;
}

export function speakerProvenance(segment) {
  const source = ["provider", "diarization", "manual", "unknown"].includes(segment?.speaker_source) ? segment.speaker_source : null;
  const scope = ["recording", "request", "unknown"].includes(segment?.speaker_scope) ? segment.speaker_scope : null;
  return { ...(source ? { speaker_source: source } : {}), ...(scope ? { speaker_scope: scope } : {}) };
}

export function speakerCoverage(segments = []) {
  let total = 0;
  let attributed = 0;
  const speakers = new Set();
  for (const segment of segments) {
    const duration = Math.max(0, Number(segment.end_seconds) - Number(segment.start_seconds)) || 1;
    total += duration;
    if (speakerAttributionAvailable(segment)) {
      attributed += duration;
      speakers.add(segment.speaker);
    }
  }
  return { available: speakers.size > 0, speakers: speakers.size, attributed_fraction: total ? attributed / total : 0 };
}
