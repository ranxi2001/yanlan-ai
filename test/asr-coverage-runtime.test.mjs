import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createCoverageSession, pcm16Bytes } from '../src/asr-coverage-runtime.js';
import { transcribePcmAdaptively, replayTranscriptReconciliations } from '../src/asr-pipeline.js';
import { publicMeeting } from '../src/api.js';

const core = '今天会议讨论采购安排还有仓库盘点现在这些事情已经说完了';
const tail = '，然后安排保洁部门清理小广告并把安全通道的垃圾清理干净。';
const full = core + tail;
const primary = { text: core, segments: [{ text: core, start_seconds: 0, end_seconds: 0,
  timing_source: 'inferred', speaker: '未区分说话人', speaker_source: 'unknown', speaker_scope: 'unknown' }] };
const pcm = new Float32Array(30 * 16000).fill(.05);
function session(overrides = {}) {
  let requests = 0;
  const review = createCoverageSession({ durationSeconds: 600, chunkSeconds: 30,
    scout: async ({ parts }) => ({ model: 'sensevoice-small-int8', parts: parts.map((p, i) => ({
      pcm_sha256: createHash('sha256').update(pcm16Bytes(p.pcm)).digest('hex'), text: i ? full.slice(35) : full.slice(0, 35),
    })) }),
    transcribe: async () => ({ text: (++requests % 2) ? full.slice(0, 35) : full.slice(35) }), ...overrides });
  return { review, requests: () => requests };
}
async function run(review, options = {}) {
  return transcribePcmAdaptively({ pcm, sampleRate: 16000, transcribe: async () => structuredClone(primary), reviewCoverage: review, ...options });
}

test('production pipeline preserves raw ASR and replays independent audio evidence through downstream grounding', async () => {
  const s = session(), result = await run(s.review);
  assert.equal(s.requests(), 2);
  assert.equal(result.rawSegments[0].text, core);
  assert.equal(result.segments[0].text, full);
  assert.equal(result.segments[0].asr_coverage, undefined);
  const restored = JSON.parse(JSON.stringify(result));
  assert.deepEqual(replayTranscriptReconciliations(restored.rawSegments, []), result.segments);
  const shared = publicMeeting({ ...result, corrections: [], asrReconciliations: [], highlights: [{ start_seconds: 0, speaker: '未区分说话人', quote: full }] });
  assert.equal(shared.segments[0].text, full);
  assert.equal(shared.highlights[0]?.quote, full);
  assert.ok(!JSON.stringify(shared).includes('asr_coverage'));
  assert.ok(!JSON.stringify(shared).includes('pcm_sha256'));
  const invalid = structuredClone(result.rawSegments);
  invalid[0].text += '伪造';
  assert.equal(replayTranscriptReconciliations(invalid, []), null);
  const wrongAudio = structuredClone(result.rawSegments);
  wrongAudio[0].asr_coverage.reviews[0].pcm_sha256 = 'different';
  assert.equal(replayTranscriptReconciliations(wrongAudio, []), null);
});

test('online concurrent reviews reserve both audio and request budget before remote calls', async () => {
  const s = session();
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => run(s.review, { startSeconds: i * 30 })));
  assert.equal(s.requests(), 6);
  assert.equal(results.filter(r => r.qualityEvents.some(e => e.reason_codes.includes('budget'))).length, 17);
});

test('basic mode has no remote calls and disabled mode performs no coverage checks', async () => {
  const sparse = { text: '今天开会', segments: [{ ...primary.segments[0], text: '今天开会' }] };
  const s = session({ scout: null });
  const result = await run(s.review, { transcribe: async () => sparse });
  assert.equal(s.requests(), 0);
  assert.ok(result.qualityEvents.some(e => e.action === 'coverage_pending'));
  const disabled = await run(createCoverageSession({ enabled: false }), { transcribe: async () => sparse });
  assert.equal(disabled.qualityEvents.length, 0);
});

test('unavailable or corrupt secondary output never replaces primary text or leaks provider errors', async () => {
  let calls = 0;
  const s = session({ scout: async () => { calls++; throw new Error('secret transcript and API key'); } });
  const first = await run(s.review), next = await run(s.review);
  assert.equal(calls, 1);
  assert.equal(first.segments[0].text, core);
  assert.equal(next.segments[0].text, core);
  assert.match(JSON.stringify(first.qualityEvents), /coverage_unavailable/);
  assert.ok(!JSON.stringify(first.qualityEvents).includes('secret'));
});

test('cancellation during audio review prevents any repaired result from committing', async () => {
  const controller = new AbortController();
  const s = session({ signal: controller.signal, transcribe: async () => { controller.abort(); return { text: full }; } });
  await assert.rejects(run(s.review), { name: 'AbortError' });
});

test('provider speaker assignments and timestamps are never rewritten by coverage repair', async () => {
  const s = session();
  const result = await run(s.review, { transcribe: async () => ({ ...primary, segments: [{ ...primary.segments[0],
    speaker_source: 'provider', speaker: 'Alice', end_seconds: 30, timing_source: 'provider' }] }) });
  assert.equal(s.requests(), 0);
  assert.equal(result.segments[0].speaker, 'Alice');
  assert.equal(result.segments[0].text, core);
  assert.ok(result.qualityEvents.some(e => e.reason_codes.includes('speaker_or_timing_requires_review')));
});
