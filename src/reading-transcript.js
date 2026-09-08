// Readability is a projection. Never apply these edits to the ASR/correction ledger.
export function cleanReadingText(value) {
  const source = String(value || "");
  const edits = [];
  // Quoted examples and short acknowledgements may be meaningful speech.
  const quoted = [...source.matchAll(/[“「『"][\s\S]*?[”」』"]/gu)].map((match) => [match.index, match.index + match[0].length]);
  const pattern = /(^|[，。！？；：、]\s*)((?:呃+|嗯+)[，、]\s*)/gu;
  for (const match of source.matchAll(pattern)) {
    const start = match.index + match[1].length;
    const end = start + match[2].length;
    if (quoted.some(([left, right]) => start >= left && start < right)) continue;
    const restOfSentence = source.slice(end).split(/[。！？；\n]/u)[0];
    if (restOfSentence.replace(/[\s，、]/gu, "").length < 4) continue;
    edits.push({ start, end, from: source.slice(start, end), to: "", reason: "isolated_filler" });
  }
  let output = source;
  for (const edit of [...edits].reverse()) output = output.slice(0, edit.start) + edit.to + output.slice(edit.end);
  return { text: output, edits };
}

export function cleanReadingSegments(segments = []) {
  return segments.map((segment) => {
    const result = cleanReadingText(segment.text);
    return result.edits.length ? { ...segment, text: result.text, reading_source_text: segment.text, reading_edits: result.edits } : segment;
  });
}

export function replayReadingEdits(source, edits) {
  let end = 0;
  for (const edit of edits || []) {
    if (!Number.isInteger(edit.start) || !Number.isInteger(edit.end) || edit.start < end || edit.end <= edit.start
      || source.slice(edit.start, edit.end) !== edit.from || edit.to !== "" || edit.reason !== "isolated_filler") return null;
    end = edit.end;
  }
  const expected = cleanReadingText(source);
  return JSON.stringify(expected.edits) === JSON.stringify(edits) ? expected.text : null;
}
