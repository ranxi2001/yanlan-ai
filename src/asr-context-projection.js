// Core text defines ownership. Context may replace only the uniquely anchored
// interior; it never contributes an unanchored prefix/suffix or word timestamps.
import { characterUnits, editCounts } from './asr-benchmark-metrics.js';

function units(text) {
  const result = []; let offset = 0;
  for (const character of text) {
    for (const key of characterUnits(character)) result.push({ key, start: offset, end: offset + character.length });
    offset += character.length;
  }
  return result;
}

function findAll(haystack, needle) {
  const matches = [];
  for (let i = 0; i <= haystack.length - needle.length; i++)
    if (needle.every((x, j) => x.key === haystack[i + j].key)) matches.push(i);
  return matches;
}

export function projectAsrContext({ core, contextual, anchorUnits = 8, maxChangeRate = .15 }) {
  if (typeof core?.text !== 'string' || typeof contextual?.text !== 'string'
    || !Number.isInteger(anchorUnits) || anchorUnits < 4 || !Number.isFinite(maxChangeRate) || maxChangeRate < 0 || maxChangeRate > 1) throw new TypeError('Invalid context projection input');
  const a = core.window, b = contextual.window;
  if (!a || !b || ![a.core_start,a.core_end,a.audio_start,a.audio_end,b.core_start,b.core_end,b.audio_start,b.audio_end].every(Number.isFinite)
    || a.id !== b.id || a.core_start < 0 || a.core_end <= a.core_start || a.core_start !== b.core_start || a.core_end !== b.core_end
    || a.audio_start !== a.core_start || a.audio_end !== a.core_end || b.audio_start < 0 || b.audio_start > a.core_start || b.audio_end < a.core_end)
    throw new TypeError('Core and contextual audio ownership differ');
  const fallback = (reason) => ({ text: core.text, status: 'fallback', reason, changed: false });
  if ([core,contextual].some(r => (r.status && r.status !== 'completed') || r.quality?.ok === false)) return fallback('recognition_quality');
  const ca = units(core.text), cb = units(contextual.text);
  if (ca.length < anchorUnits * 2 + 1) return fallback('short_core');
  const head = ca.slice(0,anchorUnits), tail = ca.slice(-anchorUnits);
  const starts = findAll(cb,head), ends = findAll(cb,tail);
  if (findAll(ca,head).length !== 1 || findAll(ca,tail).length !== 1 || starts.length !== 1 || ends.length !== 1) return fallback('ambiguous_or_missing_anchor');
  const start = starts[0], end = ends[0];
  if (end < start + anchorUnits) return fallback('reversed_anchors');
  const prefixLimit = Math.ceil((a.core_start - b.audio_start) * 24) + 4;
  const suffixLimit = Math.ceil((b.audio_end - a.core_end) * 24) + 4;
  if (start > prefixLimit || cb.length - end - anchorUnits > suffixLimit) return fallback('anchor_outside_context_edge');
  const coreStart = ca[anchorUnits - 1].end, coreEnd = ca[ca.length - anchorUnits].start;
  const contextStart = cb[start + anchorUnits - 1].end, contextEnd = cb[end].start;
  const before = core.text.slice(coreStart,coreEnd), after = contextual.text.slice(contextStart,contextEnd);
  const difference = editCounts(characterUnits(before),characterUnits(after));
  if (difference.errors > Math.max(2,Math.floor(ca.length * maxChangeRate))) return fallback('excessive_change');
  if (difference.errors === 0) return { text: core.text, status: 'supported', changed: false, reason: 'same_lexical_content' };
  return { text: core.text.slice(0,coreStart) + after + core.text.slice(coreEnd), status: 'projected', changed: true,
    patch: { start_offset: coreStart, end_offset: coreEnd, before, after, evidence_start_offset: contextStart, evidence_end_offset: contextEnd },
    removed_context_prefix: contextual.text.slice(0,cb[start].start), removed_context_suffix: contextual.text.slice(cb[end + anchorUnits - 1].end),
    edit_errors: difference.errors, warning: 'Unique anchors establish lexical ownership, not acoustic correctness.' };
}
