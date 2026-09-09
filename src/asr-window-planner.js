function positive(value, name) {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${name} must be positive`);
  return value;
}

export function planAsrWindows({ duration, speech = [], targetSeconds = 30, minSeconds = 20, maxSeconds = 40, contextSeconds = 0, mode = "vad" }) {
  positive(duration, "duration"); positive(targetSeconds, "targetSeconds"); positive(minSeconds, "minSeconds"); positive(maxSeconds, "maxSeconds");
  if (minSeconds > targetSeconds || targetSeconds > maxSeconds || !Number.isFinite(contextSeconds) || contextSeconds < 0 || contextSeconds > 5 || !["fixed", "vad"].includes(mode)) throw new TypeError("Invalid ASR window configuration");
  const intervals = speech.map((item) => ({ start: item.start, end: item.end })).sort((a, b) => a.start - b.start);
  const merged = [];
  for (const interval of intervals) {
    if (!Number.isFinite(interval.start) || !Number.isFinite(interval.end) || interval.start < 0 || interval.end <= interval.start || interval.end > duration + 0.001) throw new TypeError("Invalid speech interval");
    const previous = merged.at(-1);
    if (previous && interval.start <= previous.end) previous.end = Math.max(previous.end, interval.end);
    else merged.push(interval);
  }
  const pauses = merged.slice(1).flatMap((interval, index) => {
    const previous = merged[index];
    return interval.start - previous.end >= 0.3 ? [(previous.end + interval.start) / 2] : [];
  });
  const windows = [];
  let start = 0, cursor = 0;
  while (start < duration - 0.000001) {
    let end = Math.min(duration, start + targetSeconds), reason = "fixed";
    if (mode === "vad") {
      reason = "maximum_duration";
      if (duration - start <= maxSeconds) { end = duration; reason = "recording_end"; }
      else {
        while (cursor < pauses.length && pauses[cursor] < start + minSeconds) cursor += 1;
        let best = null;
        for (let i = cursor; i < pauses.length && pauses[i] <= start + maxSeconds; i += 1) {
          if (best === null || Math.abs(pauses[i] - (start + targetSeconds)) < Math.abs(best - (start + targetSeconds))) best = pauses[i];
        }
        if (best !== null) { end = best; reason = "silence_midpoint"; }
        else end = Math.min(duration, start + maxSeconds);
      }
    }
    windows.push({ id: windows.length, core_start: start, core_end: end, audio_start: Math.max(0, start - contextSeconds), audio_end: Math.min(duration, end + contextSeconds), boundary_reason: reason });
    start = end;
  }
  return windows;
}

function units(text) {
  const result = [];
  let offset = 0;
  for (const character of String(text || "")) {
    const end = offset + character.length;
    const key = character.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
    for (const unit of key) result.push({ key: unit, start: offset, end });
    offset = end;
  }
  return result;
}

export function compareGrowingHypotheses(previous, next) {
  if (!previous?.audio_sha256 || previous.audio_sha256 !== next?.audio_sha256
    || previous.audio_start !== next.audio_start || !Number.isFinite(previous.audio_end)
    || !Number.isFinite(next.audio_end) || next.audio_end <= previous.audio_end) throw new TypeError("Growing hypotheses must share an audio source/start and add future audio");
  const a = units(previous.text), b = units(next.text);
  let common = 0;
  while (common < a.length && common < b.length && a[common].key === b[common].key) common += 1;
  const end = common ? b[common - 1].end : 0;
  return { stable_prefix: String(next.text || "").slice(0, end), pending_tail: String(next.text || "").slice(end),
    stable_units: common, previous_units: a.length, next_units: b.length,
    pending_previous_tail: common < a.length ? String(previous.text || "").slice(a[common].start) : "",
    warning: "Text stability is not acoustic correctness; this comparison does not assign word timestamps." };
}

// Experimental projection only: retain raw hypotheses and explicitly disclose unresolved seams.
export function stitchAsrWindows(records) {
  const segments = [];
  const boundaries = [];
  for (const [index, record] of records.entries()) {
    let text = String(record.text || "");
    if (index) {
      const previous = records[index - 1];
      const overlapSeconds = Math.max(0, previous.window.audio_end - record.window.audio_start);
      if (overlapSeconds > 0) {
        const a = units(previous.text), b = units(text);
        const limit = Math.min(a.length, b.length, Math.ceil(overlapSeconds * 24));
        let matched = 0;
        for (let length = limit; length >= 8; length -= 1) {
          if (a.slice(-length).map((x) => x.key).join("") === b.slice(0, length).map((x) => x.key).join("")) { matched = length; break; }
        }
        let removed = "";
        if (matched) {
          let end = b[matched - 1].end;
          while (end < text.length && /[\s\p{P}]/u.test(text[end])) end += 1;
          removed = text.slice(0, end); text = text.slice(end);
        }
        boundaries.push({ previous: index - 1, current: index, overlap_seconds: overlapSeconds, matched_units: matched, removed_prefix: removed, status: matched ? "exact_overlap_projected" : "unresolved_overlap" });
      }
    }
    if (text) segments.push({ start_seconds: record.window.core_start, end_seconds: record.window.core_end, text, timing_source: "inferred", speaker: "未区分说话人", speaker_source: "unknown" });
  }
  return { segments, boundaries };
}
