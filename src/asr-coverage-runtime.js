import { characterUnits } from './asr-benchmark-metrics.js';
import { assessAsrCoverage, COVERAGE_POLICY, planCoverageParts } from './asr-coverage-harness.js';
import { supplementAsrCoverageTail } from './asr-coverage-tail.js';
import { assessTranscriptionQuality } from './asr-quality.js';

export const COVERAGE_VERSION = 'coverage-v1';
const replayCache = new WeakMap();

// Energy is only a conservative activity signal, not a speech detector.
export function audioActivity(pcm, sampleRate) {
  const step = Math.max(1, Math.round(sampleRate * .02));
  let seconds = 0;
  for (let start = 0; start < pcm.length; start += step) {
    const end = Math.min(pcm.length, start + step);
    let squares = 0;
    for (let i = start; i < end; i++) squares += (Number.isFinite(pcm[i]) ? pcm[i] : 0) ** 2;
    if (Math.sqrt(squares / (end - start)) >= .01) seconds += (end - start) / sampleRate;
  }
  return seconds;
}

export function pcm16Bytes(pcm) {
  const bytes = new Uint8Array(pcm.length * 2), view = new DataView(bytes.buffer);
  for (let i = 0; i < pcm.length; i++) {
    const value = Math.max(-1, Math.min(1, Number.isFinite(pcm[i]) ? pcm[i] : 0));
    view.setInt16(i * 2, value < 0 ? value * 32768 : value * 32767, true);
  }
  return bytes;
}

async function sha256(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
}

// Raw text and geometry remain immutable. Only this reproducible evidence may
// derive new canonical text, before the existing boundary/terminology ledgers.
export function replayCoverageSegment(segment) {
  const { asr_coverage: evidence, ...source } = segment;
  if (!evidence) return source;
  if (evidence.version !== COVERAGE_VERSION || evidence.model !== 'sensevoice-small-int8'
    || evidence.source !== JSON.stringify([source.start_seconds, source.end_seconds, source.speaker, source.text])
    || evidence.record.text !== source.text || evidence.record.window.core_start !== source.start_seconds
    || evidence.record.window.core_end !== source.end_seconds || evidence.record.window.core_end - evidence.record.window.core_start > 30.001
    || source.timing_source !== 'inferred' || source.speaker_source !== 'unknown'
    || !Array.isArray(evidence.scout.parts) || evidence.scout.parts.length > 3
    || !Array.isArray(evidence.reviews) || evidence.reviews.length > 3
    || evidence.record.text.length > 4000 || evidence.scout.parts.some(p => p.text.length > 4000)
    || evidence.reviews.some(p => p.text.length > 4000)) throw new Error('Invalid ASR coverage evidence');
  const fingerprint = JSON.stringify(evidence);
  const cached = replayCache.get(evidence);
  if (cached?.fingerprint === fingerprint) return { ...source, text: cached.text };
  const result = supplementAsrCoverageTail(evidence);
  if (!result.accepted.length || result.status !== 'repaired') throw new Error('ASR coverage evidence does not support this repair');
  replayCache.set(evidence, { fingerprint, text: result.text });
  return { ...source, text: result.text };
}

// A session spends a bounded online budget; unknown duration accrues credit
// from completed windows. Reservations happen synchronously before requests.
export function createCoverageSession({ enabled = true, durationSeconds, chunkSeconds = 30, scout, transcribe, signal, onProgress } = {}) {
  let seenSeconds = 0, seenRequests = 0, spentSeconds = 0, spentRequests = 0, localFailed = false;
  return async ({ pcm, sampleRate, segments, startSeconds, durationSeconds: duration }) => {
    if (!enabled) return { segments, events: [] };
    signal?.throwIfAborted();
    seenSeconds += duration; seenRequests++;
    const text = segments.map(s => s.text).join('');
    const activity = audioActivity(pcm, sampleRate);
    const events = [];
    const event = (action, reasons = [], extra = {}) => ({ start_seconds: startSeconds, duration_seconds: duration,
      action, reason_codes: reasons, ...extra });
    const lowDensity = activity >= 5 && characterUnits(text).length / activity < COVERAGE_POLICY.minimumDensity;
    if (!scout || localFailed || sampleRate !== 16000 || duration > 30.001) {
      if (lowDensity) events.push(event('coverage_pending', ['low_audio_text_coverage']));
      if (scout && (localFailed || sampleRate !== 16000)) events.push(event('coverage_unavailable'));
      return { segments, events };
    }
    const window = { id: startSeconds, core_start: startSeconds, core_end: startSeconds + duration,
      audio_start: startSeconds, audio_end: startSeconds + duration };
    const record = { window, text, status: 'completed', quality: { ok: true } };
    try {
      const parts = planCoverageParts(window, []).map(p => {
        const lo = Math.round((p.start_seconds - startSeconds) * sampleRate);
        const hi = Math.round((p.end_seconds - startSeconds) * sampleRate);
        return { ...p, start_seconds: startSeconds + lo / sampleRate, end_seconds: startSeconds + hi / sampleRate, pcm: pcm.subarray(lo, hi) };
      });
      const audioParts = [];
      for (const part of parts) audioParts.push({ ...part, pcm_sha256: await sha256(pcm16Bytes(part.pcm)) });
      signal?.throwIfAborted();
      onProgress?.(startSeconds);
      const local = await scout({ pcm, sampleRate, parts: audioParts, signal });
      signal?.throwIfAborted();
      if (local.model !== 'sensevoice-small-int8' || local.parts?.length !== parts.length) throw new Error('Invalid local coverage response');
      const localScout = { window_id: window.id, window, speech_seconds: activity, parts: audioParts.map((part, i) => {
        const output = local.parts[i];
        if (output.pcm_sha256 !== part.pcm_sha256 || typeof output.text !== 'string' || output.text.length > 4000) throw new Error('Local audio mismatch');
        const { pcm: _pcm, ...metadata } = part;
        return { ...metadata, text: output.text };
      }) };
      const risk = assessAsrCoverage(record, localScout);
      if (!risk.reasons.length) return { segments, events: [event('coverage_checked')] };
      // Never merge provider timings or assign newly recovered words to a speaker.
      if (segments.length !== 1 || segments[0].timing_source !== 'inferred' || segments[0].speaker_source !== 'unknown'
        || segments[0].start_seconds !== window.core_start || segments[0].end_seconds !== window.core_end) {
        return { segments, events: [event('coverage_pending', [...risk.reasons, 'speaker_or_timing_requires_review'])] };
      }
      const totalSeconds = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : seenSeconds;
      const totalRequests = Number.isFinite(durationSeconds) && durationSeconds > 0 ? Math.ceil(durationSeconds / chunkSeconds) : seenRequests;
      if (spentSeconds + duration > totalSeconds * COVERAGE_POLICY.maxReviewAudioRatio + 1e-6
        || spentRequests + parts.length > Math.floor(totalRequests * COVERAGE_POLICY.maxExtraRequestRatio)) {
        return { segments, events: [event('coverage_pending', [...risk.reasons, 'budget'])] };
      }
      spentSeconds += duration; spentRequests += parts.length;
      const reviews = [];
      for (const part of audioParts) {
        signal?.throwIfAborted();
        const output = await transcribe({ pcm: part.pcm, startSeconds: part.start_seconds, signal });
        signal?.throwIfAborted();
        const { pcm: _pcm, ...metadata } = part;
        reviews.push({ ...metadata, text: String(output.text ?? output.segments?.map(s => s.text).join('') ?? ''),
          status: 'completed', quality: assessTranscriptionQuality(output, part.end_seconds - part.start_seconds) });
      }
      const evidence = { version: COVERAGE_VERSION, model: local.model,
        source: JSON.stringify([segments[0].start_seconds, segments[0].end_seconds, segments[0].speaker, segments[0].text]),
        record, scout: localScout, reviews };
      const result = supplementAsrCoverageTail(evidence);
      if (result.accepted.length) {
        const raw = { ...segments[0], asr_coverage: evidence };
        replayCoverageSegment(raw);
        events.push(event('coverage_repaired', risk.reasons, { accepted_patches: result.accepted.length }));
        const unresolved = result.pending.filter(p => p.reason !== 'partially_supported_tail'
          || characterUnits(p.after).join('') !== characterUnits(p.accepted_prefix).join(''));
        if (unresolved.length) events.push(event('coverage_pending', ['unresolved_candidates']));
        return { segments: [raw], events };
      }
      return { segments, events: [event(result.status === 'unchanged' ? 'coverage_checked' : 'coverage_pending', risk.reasons)] };
    } catch (error) {
      signal?.throwIfAborted();
      // No provider error text, original transcript, or credentials in events.
      localFailed = true;
      return { segments, events: [event('coverage_unavailable'), ...(lowDensity ? [event('coverage_pending', ['low_audio_text_coverage'])] : [])] };
    }
  };
}

export function localCoverageScout(config) {
  if (config.transportMode !== 'relay' || typeof location === 'undefined'
    || !['127.0.0.1', 'localhost'].includes(location.hostname)) return null;
  return async ({ pcm, parts, signal }) => {
    const bytes = pcm16Bytes(pcm);
    const url = new URL('/api/coverage/scout', location.origin);
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream',
      'X-Coverage-Parts': parts.map(p => Math.round(p.pcm.length)).join(',') }, body: bytes,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error('Local coverage unavailable');
    return response.json();
  };
}
