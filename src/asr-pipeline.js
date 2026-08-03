import { assessTranscriptionQuality, reconcileTranscriptBoundary } from "./asr-quality.js";

const DEFAULT_FALLBACK_CHUNK_SECONDS = 10;
const DEFAULT_MINIMUM_CHUNK_SECONDS = 5;
const RECONCILIATION_ALGORITHM_VERSION = "boundary-v1";

export async function transcribePcmAdaptively({
  pcm,
  sampleRate,
  startSeconds = 0,
  transcribe,
  fallbackChunkSeconds = DEFAULT_FALLBACK_CHUNK_SECONDS,
  minimumChunkSeconds = DEFAULT_MINIMUM_CHUNK_SECONDS,
}) {
  if (!(pcm instanceof Float32Array) || !pcm.length) return { rawSegments: [], segments: [], qualityEvents: [], reconciliations: [] };
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new TypeError("sampleRate must be a positive number");
  if (typeof transcribe !== "function") throw new TypeError("transcribe must be a function");

  const qualityEvents = [];
  const reconciliations = [];
  try {
    const rawSegments = await transcribeRange(pcm, Number(startSeconds) || 0, 0);
    const reconciled = reconcileTranscriptSegments(rawSegments);
    reconciliations.push(...reconciled.reconciliations);
    return { rawSegments, segments: reconciled.segments, qualityEvents, reconciliations };
  } catch (error) {
    error.qualityEvents = [...qualityEvents];
    error.reconciliations = [...reconciliations];
    throw error;
  }

  async function transcribeRange(samples, absoluteStart, depth) {
    const durationSeconds = samples.length / sampleRate;
    const result = await transcribe({ pcm: samples, startSeconds: absoluteStart, durationSeconds, depth });
    const resultSegments = transcriptionSegments(result);
    const assessment = assessTranscriptionQuality(qualityEnvelope(result, resultSegments), durationSeconds);
    if (assessment.ok) return offsetSegments(resultSegments, durationSeconds, absoluteStart);

    const energy = assessment.reasonCode === "empty_transcript" ? pcmEnergy(samples) : null;
    if (energy?.silence) {
      qualityEvents.push(qualityEvent(assessment, absoluteStart, durationSeconds, "accepted_silence", energy));
      return [];
    }

    const pieces = splitSuspectPcm(samples, sampleRate, fallbackChunkSeconds, minimumChunkSeconds);
    if (!pieces.length) {
      qualityEvents.push(qualityEvent(assessment, absoluteStart, durationSeconds, "rejected", energy));
      throw transcriptionQualityError(assessment, absoluteStart, durationSeconds);
    }
    qualityEvents.push(qualityEvent(assessment, absoluteStart, durationSeconds, "split", energy));

    const recovered = [];
    let sampleOffset = 0;
    for (const piece of pieces) {
      recovered.push(...await transcribeRange(piece, absoluteStart + (sampleOffset / sampleRate), depth + 1));
      sampleOffset += piece.length;
    }
    return recovered;
  }
}

export function reconcileTranscriptSegments(values) {
  const sources = normalizedTranscriptSegments(values);
  const segments = sources.map((segment) => ({ ...segment }));
  const reconciliations = [];

  for (let index = 1; index < segments.length; index += 1) {
    const previous = segments[index - 1];
    const current = segments[index];
    if (comparableSpeaker(previous.speaker) !== comparableSpeaker(current.speaker)) continue;
    if (!hasTemporalOverlap(previous, current)) continue;
    const result = reconcileTranscriptBoundary(previous.text, current.text);
    if (!result.changed) continue;
    if (!result.previousText.trim() || !result.nextText.trim()) continue;
    const targetSegmentId = result.removedFrom === "previous" ? index - 1 : index;
    const before = segments[targetSegmentId].text;
    const after = result.removedFrom === "previous" ? result.previousText : result.nextText;
    const replacement = replacementDiff(before, after);
    if (!replacement) continue;
    previous.text = result.previousText;
    current.text = result.nextText;
    reconciliations.push({
      algorithm_version: RECONCILIATION_ALGORITHM_VERSION,
      segmentId: targetSegmentId,
      source_hash: segmentSourceHash(sources[targetSegmentId], targetSegmentId),
      start_offset: replacement.start,
      end_offset: replacement.end,
      from: replacement.from,
      to: replacement.to,
      at_seconds: roundSeconds(current.start_seconds),
      reason: result.reasonCode,
      removed_characters: codePointLength(replacement.from),
      removed_from: result.removedFrom,
    });
  }

  return {
    segments: segments.filter((segment) => segment.text),
    reconciliations,
  };
}

export function replayTranscriptReconciliations(values, reconciliationLedger) {
  if (!Array.isArray(reconciliationLedger)) return null;
  const sources = normalizedTranscriptSegments(values);
  const segments = sources.map((segment) => ({ ...segment }));
  for (const entry of reconciliationLedger) {
    const segmentId = Number(entry?.segmentId);
    const source = sources[segmentId];
    const expected = expectedBoundaryReconciliation(segments, entry);
    if (
      entry?.algorithm_version !== RECONCILIATION_ALGORITHM_VERSION
      || !Number.isInteger(segmentId)
      || !source
      || entry.source_hash !== segmentSourceHash(source, segmentId)
      || !expected
      || Number(entry.start_offset) !== expected.start_offset
      || Number(entry.end_offset) !== expected.end_offset
      || entry.from !== expected.from
      || entry.to !== ""
      || Number(entry.at_seconds) !== expected.at_seconds
      || entry.reason !== expected.reason
      || Number(entry.removed_characters) !== expected.removed_characters
      || entry.removed_from !== expected.removed_from
    ) return null;
    segments[segmentId].text = expected.text;
  }
  return segments;
}

function expectedBoundaryReconciliation(segments, entry) {
  const segmentId = Number(entry?.segmentId);
  if (!Number.isInteger(segmentId)) return null;
  const boundaryIndex = entry?.removed_from === "next"
    ? segmentId
    : (entry?.removed_from === "previous" ? segmentId + 1 : -1);
  if (boundaryIndex <= 0 || boundaryIndex >= segments.length) return null;
  const previous = segments[boundaryIndex - 1];
  const current = segments[boundaryIndex];
  if (comparableSpeaker(previous.speaker) !== comparableSpeaker(current.speaker)) return null;
  if (!hasTemporalOverlap(previous, current)) return null;
  const result = reconcileTranscriptBoundary(previous.text, current.text);
  if (!result.changed || result.removedFrom !== entry.removed_from) return null;
  const targetSegmentId = result.removedFrom === "previous" ? boundaryIndex - 1 : boundaryIndex;
  if (targetSegmentId !== segmentId) return null;
  const before = segments[targetSegmentId].text;
  const after = result.removedFrom === "previous" ? result.previousText : result.nextText;
  const replacement = replacementDiff(before, after);
  if (!replacement || replacement.to !== "" || !after.trim()) return null;
  return {
    start_offset: replacement.start,
    end_offset: replacement.end,
    from: replacement.from,
    text: after,
    at_seconds: roundSeconds(current.start_seconds),
    reason: result.reasonCode,
    removed_characters: codePointLength(replacement.from),
    removed_from: result.removedFrom,
  };
}

function codePointLength(value) {
  return [...String(value || "")].length;
}

export function segmentSourceHash(segment, segmentId) {
  const value = JSON.stringify([
    Number.isInteger(segmentId) ? segmentId : null,
    Number(segment?.start_seconds) || 0,
    Number(segment?.end_seconds) || 0,
    String(segment?.speaker || ""),
    String(segment?.text || ""),
  ]);
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function transcriptionQualityError(assessment, startSeconds, durationSeconds) {
  const reasons = Array.isArray(assessment?.reasonCodes) ? assessment.reasonCodes.join(", ") : "unknown";
  const error = new Error(`ASR 输出质量异常（${reasons}），已停止写入逐字稿`);
  error.name = "TranscriptionQualityError";
  error.quality = assessment;
  error.startSeconds = Number(startSeconds) || 0;
  error.durationSeconds = Number(durationSeconds) || 0;
  return error;
}

function splitSuspectPcm(samples, sampleRate, fallbackSeconds, minimumSeconds) {
  const minimumSamples = Math.max(1, Math.ceil(Math.max(1, Number(minimumSeconds) || DEFAULT_MINIMUM_CHUNK_SECONDS) * sampleRate));
  if (samples.length < minimumSamples * 2) return [];
  const fallbackSamples = Math.max(minimumSamples, Math.floor(Math.max(1, Number(fallbackSeconds) || DEFAULT_FALLBACK_CHUNK_SECONDS) * sampleRate));
  const pieceCount = Math.max(2, Math.ceil(samples.length / fallbackSamples));
  if (Math.floor(samples.length / pieceCount) < minimumSamples) return [];
  const pieces = [];
  let offset = 0;
  for (let index = 0; index < pieceCount; index += 1) {
    const remainingPieces = pieceCount - index;
    const size = Math.ceil((samples.length - offset) / remainingPieces);
    pieces.push(samples.subarray(offset, offset + size));
    offset += size;
  }
  return pieces;
}

function offsetSegments(values, durationSeconds, offsetSeconds) {
  const duration = Math.max(0, Number(durationSeconds) || 0);
  const source = (values || []).map((segment, sourceIndex) => ({
    segment,
    sourceIndex,
    start: Math.min(duration, Math.max(0, Number(segment?.start_seconds) || 0)),
    explicitEnd: Number(segment?.end_seconds),
    timingSource: timingSource(segment),
  })).sort((left, right) => left.start - right.start || left.sourceIndex - right.sourceIndex);
  return source.map(({ segment, start, explicitEnd, timingSource }, index, all) => {
    const nextStart = all[index + 1]?.start;
    const fallbackEnd = Number.isFinite(nextStart) && nextStart > start ? nextStart : durationSeconds;
    const boundedEnd = Number.isFinite(explicitEnd) ? Math.min(duration, Math.max(0, explicitEnd)) : null;
    const end = boundedEnd != null && boundedEnd > start ? boundedEnd : fallbackEnd;
    return {
      ...segment,
      start_seconds: start + offsetSeconds,
      end_seconds: Math.min(duration, Math.max(start, end)) + offsetSeconds,
      timing_source: timingSource,
      speaker: String(segment?.speaker || "发言人 1"),
      text: String(segment?.text || "").trim(),
    };
  }).filter((segment) => segment.text);
}

function comparableSpeaker(value) {
  return String(value || "").trim().toLocaleLowerCase();
}

function normalizedTranscriptSegments(values) {
  return (values || [])
    .map((segment, sourceIndex) => ({
      ...segment,
      speaker: String(segment?.speaker || "发言人 1"),
      text: String(segment?.text || "").trim(),
      timing_source: timingSource(segment),
      sourceIndex,
    }))
    .filter((segment) => segment.text)
    .sort((left, right) => sortableStart(left) - sortableStart(right) || left.sourceIndex - right.sourceIndex)
    .map(({ sourceIndex: _sourceIndex, ...segment }) => segment);
}

function transcriptionSegments(result) {
  if (Array.isArray(result?.segments)) return result.segments;
  const text = typeof result === "string" ? result : result?.text;
  return String(text || "").trim() ? [{ text: String(text).trim() }] : [];
}

function qualityEnvelope(result, segments) {
  return result && typeof result === "object" && !Array.isArray(result)
    ? { ...result, segments }
    : { segments };
}

function sortableStart(segment) {
  const value = Number(segment?.start_seconds);
  return Number.isFinite(value) && value >= 0 ? value : Number.POSITIVE_INFINITY;
}

function timingSource(segment) {
  if (segment?.timing_source === "provider" || segment?.timing_source === "inferred") return segment.timing_source;
  const start = Number(segment?.start_seconds);
  const end = Number(segment?.end_seconds);
  return Number.isFinite(start) && start >= 0 && Number.isFinite(end) && end > start ? "provider" : "inferred";
}

function replacementDiff(beforeValue, afterValue) {
  const before = String(beforeValue || "");
  const after = String(afterValue || "");
  if (before === after) return null;
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }
  return { start, end: beforeEnd, from: before.slice(start, beforeEnd), to: after.slice(start, afterEnd) };
}

function qualityEvent(assessment, startSeconds, durationSeconds, action, energy = null) {
  return {
    start_seconds: roundSeconds(startSeconds),
    duration_seconds: roundSeconds(durationSeconds),
    reason_codes: assessment.reasonCodes,
    action,
    metrics: {
      ...assessment.metrics,
      ...(energy ? { pcmRms: roundMetric(energy.rms), pcmPeak: roundMetric(energy.peak) } : {}),
    },
  };
}

function pcmEnergy(samples) {
  let sumSquares = 0;
  let peak = 0;
  for (const sample of samples) {
    const value = Number.isFinite(sample) ? sample : 0;
    sumSquares += value * value;
    peak = Math.max(peak, Math.abs(value));
  }
  const rms = Math.sqrt(sumSquares / Math.max(1, samples.length));
  return { rms, peak, silence: rms <= 0.000001 && peak <= 0.00001 };
}

function hasTemporalOverlap(previous, current) {
  const previousEnd = Number(previous?.end_seconds);
  const currentStart = Number(current?.start_seconds);
  return previous?.timing_source === "provider"
    && current?.timing_source === "provider"
    && Number.isFinite(previousEnd)
    && Number.isFinite(currentStart)
    && previousEnd > currentStart;
}

function roundSeconds(value) {
  return Math.round((Number(value) || 0) * 1_000) / 1_000;
}

function roundMetric(value) {
  return Math.round((Number(value) || 0) * 1_000_000) / 1_000_000;
}
