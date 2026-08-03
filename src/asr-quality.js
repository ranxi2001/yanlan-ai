const QUALITY_REASON = Object.freeze({
  OK: "ok",
  EMPTY: "empty_transcript",
  REPETITIVE: "repetitive_generation",
  CHARACTER_DENSITY: "excessive_character_density",
  TOKEN_DENSITY: "excessive_completion_token_density",
});

const BOUNDARY_REASON = Object.freeze({
  NONE: "none",
  FILLER: "chinese_filler_overlap",
});

const REPETITION_NGRAM_SIZE = 6;
const MIN_REPETITION_CHARACTERS = 120;
const MIN_CHARACTER_DENSITY_SAMPLE = 240;
const MAX_CHARACTERS_PER_SECOND = 24;
const MIN_TOKEN_DENSITY_SAMPLE = 120;
const MAX_COMPLETION_TOKENS_PER_SECOND = 12;

export function assessTranscriptionQuality(result, durationSeconds) {
  const text = transcriptionText(result);
  const characterCount = codePointLength(text.replace(/\s+/gu, ""));
  const duration = positiveNumber(durationSeconds);
  const completionTokens = completionTokenCount(result);
  const repetition = repetitionMetrics(text);
  const charactersPerSecond = duration ? characterCount / duration : null;
  const completionTokensPerSecond = duration && completionTokens != null ? completionTokens / duration : null;
  const reasonCodes = [];

  if (!characterCount) reasonCodes.push(QUALITY_REASON.EMPTY);
  if (
    repetition.analyzedCharacterCount >= MIN_REPETITION_CHARACTERS
    && repetition.repeatedNgramRatio >= 0.45
    && repetition.maxNgramOccurrences >= 8
  ) reasonCodes.push(QUALITY_REASON.REPETITIVE);
  if (
    characterCount >= MIN_CHARACTER_DENSITY_SAMPLE
    && charactersPerSecond != null
    && charactersPerSecond > MAX_CHARACTERS_PER_SECOND
  ) reasonCodes.push(QUALITY_REASON.CHARACTER_DENSITY);
  if (
    completionTokens != null
    && completionTokens >= MIN_TOKEN_DENSITY_SAMPLE
    && completionTokensPerSecond != null
    && completionTokensPerSecond > MAX_COMPLETION_TOKENS_PER_SECOND
  ) reasonCodes.push(QUALITY_REASON.TOKEN_DENSITY);

  const prioritized = reasonCodes.sort((left, right) => reasonPriority(left) - reasonPriority(right));
  return {
    ok: prioritized.length === 0,
    reasonCode: prioritized[0] || QUALITY_REASON.OK,
    reasonCodes: prioritized,
    metrics: {
      durationSeconds: duration == null ? null : roundMetric(duration),
      characterCount,
      charactersPerSecond: charactersPerSecond == null ? null : roundMetric(charactersPerSecond),
      completionTokens,
      completionTokensPerSecond: completionTokensPerSecond == null ? null : roundMetric(completionTokensPerSecond),
      repetitionNgramSize: REPETITION_NGRAM_SIZE,
      analyzedCharacterCount: repetition.analyzedCharacterCount,
      analyzedNgramCount: repetition.analyzedNgramCount,
      repeatedNgramRatio: roundMetric(repetition.repeatedNgramRatio),
      maxNgramOccurrences: repetition.maxNgramOccurrences,
    },
  };
}

export function reconcileTranscriptBoundary(previousText, nextText) {
  const previous = String(previousText ?? "");
  const next = String(nextText ?? "");
  const filler = repeatedChineseFiller(previous, next);
  if (filler) {
    return boundaryResult(previous, filler.nextText, BOUNDARY_REASON.FILLER, filler.removedCharacters, "next");
  }

  return boundaryResult(previous, next, BOUNDARY_REASON.NONE, 0, null);
}

function transcriptionText(result) {
  if (typeof result === "string") return result;
  if (Array.isArray(result?.segments)) {
    return result.segments.map((segment) => String(segment?.text || "").trim()).filter(Boolean).join("\n");
  }
  return typeof result?.text === "string" ? result.text : "";
}

function completionTokenCount(result) {
  const usages = [result?.usage, result?.raw?.usage, result?.response?.usage];
  for (const usage of usages) {
    const value = usage?.completion_tokens ?? usage?.output_tokens;
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return null;
}

function repetitionMetrics(value) {
  const normalized = [...String(value || "").normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "")];
  const analyzedNgramCount = Math.max(0, normalized.length - REPETITION_NGRAM_SIZE + 1);
  if (!analyzedNgramCount) {
    return { analyzedCharacterCount: normalized.length, analyzedNgramCount: 0, repeatedNgramRatio: 0, maxNgramOccurrences: 0 };
  }
  const counts = new Map();
  for (let index = 0; index < analyzedNgramCount; index += 1) {
    const ngram = normalized.slice(index, index + REPETITION_NGRAM_SIZE).join("");
    counts.set(ngram, (counts.get(ngram) || 0) + 1);
  }
  let repeatedNgrams = 0;
  let maxNgramOccurrences = 0;
  for (const count of counts.values()) {
    if (count >= 3) repeatedNgrams += count;
    maxNgramOccurrences = Math.max(maxNgramOccurrences, count);
  }
  return {
    analyzedCharacterCount: normalized.length,
    analyzedNgramCount,
    repeatedNgramRatio: repeatedNgrams / analyzedNgramCount,
    maxNgramOccurrences,
  };
}

function repeatedChineseFiller(previous, next) {
  const previousMatch = /([嗯呃啊哦])[\s，,。！？!?、]*$/u.exec(previous);
  const nextMatch = /^[\s，,。！？!?、]*([嗯呃啊哦])(?=$|[\s，,。！？!?、])/u.exec(next);
  if (!previousMatch || !nextMatch || previousMatch[1] !== nextMatch[1]) return null;
  const remainder = next.slice(nextMatch[0].length).replace(/^[\s，,。！？!?、]+/u, "");
  return {
    nextText: remainder,
    removedCharacters: codePointLength(next) - codePointLength(remainder),
  };
}

function boundaryResult(previousText, nextText, reasonCode, removedCharacters, removedFrom) {
  return {
    previousText,
    nextText,
    changed: reasonCode !== BOUNDARY_REASON.NONE,
    reasonCode,
    removedCharacters,
    removedFrom,
  };
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function codePointLength(value) {
  return [...String(value || "")].length;
}

function roundMetric(value) {
  return Math.round(value * 1_000) / 1_000;
}

function reasonPriority(value) {
  return ({
    [QUALITY_REASON.EMPTY]: 0,
    [QUALITY_REASON.REPETITIVE]: 1,
    [QUALITY_REASON.CHARACTER_DENSITY]: 2,
    [QUALITY_REASON.TOKEN_DENSITY]: 3,
  })[value] ?? 99;
}
