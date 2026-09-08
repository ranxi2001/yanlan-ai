const key = (value) => String(value || "").normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");

// Locate using unchanged text on BOTH sides, never by a guessed replacement.
// These are anchor estimates, not forced-alignment timestamps for the transcript.
export function locateAudioSpan(segment, before, startOffset, alignedSegments = []) {
  const text = String(segment?.text || "");
  let offset = startOffset;
  if (offset === -1) {
    offset = text.indexOf(before);
    if (offset < 0 || text.indexOf(before, offset + before.length) >= 0) return { ok: false, code: "source_span_not_unique" };
  }
  if (text.slice(offset, offset + before.length) !== before) return { ok: false, code: "source_span_mismatch" };
  const units = [];
  for (const record of alignedSegments) {
    if (record.end_seconds < segment.start_seconds - 2 || record.start_seconds > segment.end_seconds + 2) continue;
    for (const word of record.words || []) {
      if (!Number.isFinite(word.start_seconds) || word.start_seconds < 0 || !Number.isFinite(word.end_seconds) || word.end_seconds <= word.start_seconds) continue;
      for (const character of key(word.text).split("")) units.push({ character, start: word.start_seconds, end: word.end_seconds });
    }
  }
  const aligned = units.map((unit) => unit.character).join("");
  const left = key(text.slice(Math.max(0, offset - 40), offset));
  const right = key(text.slice(offset + before.length, offset + before.length + 40));
  if (left.length < 4 || right.length < 4 || !aligned) return { ok: false, code: "insufficient_alignment_anchors" };
  const find = (anchor, direction) => {
    for (let length = Math.min(16, anchor.length); length >= 4; length -= 1) {
      const part = direction === "left" ? anchor.slice(-length) : anchor.slice(0, length);
      const positions = [];
      let index = aligned.indexOf(part);
      while (index >= 0 && positions.length < 8) { positions.push(direction === "left" ? index + part.length : index); index = aligned.indexOf(part, index + 1); }
      if (positions.length) return { text: part, positions };
    }
    return null;
  };
  const a = find(left, "left"), b = find(right, "right");
  if (!a || !b) return { ok: false, code: "alignment_anchors_not_found" };
  const matches = [];
  for (const l of a.positions) for (const r of b.positions) {
    if (r < l || r - l > Math.max(24, key(before).length * 4)) continue;
    const start = Math.max(0, segment.start_seconds - 2, units[Math.max(0, l - 1)].start - 1.5);
    const end = Math.min(segment.end_seconds + 2, units[Math.min(units.length - 1, r)].end + 1.5);
    if (end > start && end - start <= 16) matches.push({ start_seconds: start, end_seconds: end });
  }
  if (matches.length !== 1) return { ok: false, code: matches.length ? "ambiguous_alignment_anchors" : "alignment_gap_too_large" };
  return { ok: true, ...matches[0], source_start_offset: offset, source_end_offset: offset + before.length,
    left_anchor: a.text, right_anchor: b.text, timing_source: "two_sided_anchor_estimate", warning: "Use for targeted audio review only, not as published word timestamps." };
}
