import { segmentSourceHash } from "./asr-pipeline.js";

// Ignore only pause tokens for matching. Published core text is never normalized.
function tokens(value) {
  const text = String(value || "");
  const result = [];
  const pattern = /[A-Za-z][A-Za-z0-9_-]*|\d+(?:[.,]\d+)*|[\p{L}\p{N}]|[?？]/gu;
  for (const match of text.matchAll(pattern)) {
    if (/^[呃嗯]$/u.test(match[0])) continue;
    result.push({ key: match[0].normalize("NFKC").toLowerCase().replace("？", "?"), start: match.index, end: match.index + match[0].length });
  }
  return result;
}
const keys = (items) => items.map((item) => item.key);
const same = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);

function findEdgeAnchor(core, context, edge, maxExtra) {
  const a = tokens(core), b = tokens(context);
  if (a.length < 4 || b.length < 4) return null;
  const length = Math.min(8, a.length);
  const needle = keys(edge === "tail" ? a.slice(-length) : a.slice(0, length));
  const matches = [];
  const first = edge === "tail" ? Math.max(0, b.length - length - maxExtra) : 0;
  const last = edge === "tail" ? b.length - length : Math.min(maxExtra, b.length - length);
  for (let index = first; index <= last; index += 1) {
    if (same(needle, keys(b.slice(index, index + length)))) matches.push(index);
  }
  if (matches.length !== 1) return null;
  const index = matches[0];
  return { core_tokens: a, context_tokens: b, context_start_offset: b[index].start, context_end_offset: b[index + length - 1].end,
    extra_tokens: keys(edge === "tail" ? b.slice(index + length) : b.slice(0, index)) };
}

function validateRecords(core, contextual) {
  if (!Array.isArray(core) || !Array.isArray(contextual) || core.length !== contextual.length) throw new TypeError("One contextual hypothesis is required per core window");
  const ids = new Set();
  const duration = core.at(-1)?.window?.core_end || 0;
  for (let index = 0; index < core.length; index += 1) {
    const a = core[index], b = contextual[index];
    if (typeof a?.text !== "string" || typeof b?.text !== "string" || !a.window || !b.window
      || !Number.isInteger(a.window.id) || a.window.id < 0 || ids.has(a.window.id)
      || a.window.id !== b.window.id || a.window.core_start !== b.window.core_start || a.window.core_end !== b.window.core_end
      || !(a.window.core_end > a.window.core_start) || !Number.isFinite(a.window.core_end) || !Number.isFinite(a.window.core_start) || a.window.core_start < 0
      || a.window.audio_start !== a.window.core_start || a.window.audio_end !== a.window.core_end
      || !Number.isFinite(b.window.audio_start) || !Number.isFinite(b.window.audio_end)
      || b.window.audio_start > a.window.core_start || b.window.audio_end < a.window.core_end
      || b.window.audio_start < 0 || b.window.audio_end > duration || (index && Math.abs(core[index - 1].window.core_end - a.window.core_start) > 0.00001)) throw new TypeError("Core and context windows do not share a valid contiguous timeline");
    ids.add(a.window.id);
  }
}

function sourceSignature(core, contextual, audioHash) {
  return segmentSourceHash({ text: JSON.stringify({ audioHash, core: core.map((record) => ({ window: record.window, text: record.text, status: record.status })),
    contextual: contextual.map((record) => ({ window: record.window, text: record.text, status: record.status })) }) }, 0);
}

export function confirmAsrBoundaries({ core, contextual, audioHash }) {
  if (typeof audioHash !== "string" || !audioHash) throw new TypeError("Audio source hash is required");
  validateRecords(core, contextual);
  const segments = core.map((record, index) => ({ start_seconds: record.window.core_start, end_seconds: record.window.core_end, timing_source: "inferred",
    speaker: "未区分说话人", speaker_source: "unknown", text: record.text, source_window_id: record.window.id,
    source_hash: segmentSourceHash({ start_seconds: record.window.core_start, end_seconds: record.window.core_end, text: record.text }, index) }));
  const boundaries = [];
  for (let index = 1; index < core.length; index += 1) {
    const left = core[index - 1], right = core[index], a = contextual[index - 1], b = contextual[index];
    const extraLeft = a.window.audio_end - left.window.core_end;
    const extraRight = right.window.core_start - b.window.audio_start;
    const common = { id: `boundary-${index}`, left_window_id: left.window.id, right_window_id: right.window.id, time: right.window.core_start,
      evidence_window_ids: [a.window.id, b.window.id], action: "publish_core_once" };
    if ([left, right, a, b].some((record) => (record.status && record.status !== "completed") || record.quality?.ok === false)) {
      boundaries.push({ ...common, status: "pending", reason: "recognition_failed" }); continue;
    }
    if (!(extraLeft > 0 && extraRight > 0)) { boundaries.push({ ...common, status: "pending", reason: "future_and_past_context_required" }); continue; }
    const tail = findEdgeAnchor(left.text, a.text, "tail", Math.min(48, Math.ceil(extraLeft * 16)));
    const head = findEdgeAnchor(right.text, b.text, "head", Math.min(48, Math.ceil(extraRight * 16)));
    if (!tail || !head) { boundaries.push({ ...common, status: "pending", reason: "core_edge_not_uniquely_supported" }); continue; }
    const leftKeys = keys(tail.core_tokens), rightKeys = keys(head.core_tokens);
    if (!same(tail.extra_tokens, rightKeys.slice(0, tail.extra_tokens.length))
      || !same(head.extra_tokens, head.extra_tokens.length ? leftKeys.slice(-head.extra_tokens.length) : [])) {
      boundaries.push({ ...common, status: "pending", reason: "cross_boundary_content_disagreement", left_future_tokens: tail.extra_tokens, right_past_tokens: head.extra_tokens }); continue;
    }
    boundaries.push({ ...common, status: "confirmed", reason: "core_edges_and_context_agree",
      anchors: [{ window_id: a.window.id, start_offset: tail.context_start_offset, end_offset: tail.context_end_offset },
        { window_id: b.window.id, start_offset: head.context_start_offset, end_offset: head.context_end_offset }] });
  }
  return { schema: 1, audio_sha256: audioHash, source_signature: sourceSignature(core, contextual, audioHash), segments, boundaries,
    status: boundaries.some((item) => item.status === "pending") ? "partial" : "confirmed",
    publication_policy: "Core hypotheses are emitted exactly once; context hypotheses are evidence, never concatenated into published text.",
    limitations: "Confirmed means lexical agreement under different windows, not acoustic truth or verified speaker attribution. Pause tokens 呃/嗯 are ignored only for matching." };
}

export function verifyBoundaryPublication(artifact, input) {
  try {
    const replayed = confirmAsrBoundaries(input);
    return JSON.stringify(replayed) === JSON.stringify(artifact);
  } catch { return false; }
}

export function planBoundaryAudioReviews(artifact, { radiusSeconds = 6, maxReviews = 12 } = {}) {
  if (!Number.isFinite(radiusSeconds) || radiusSeconds <= 0 || radiusSeconds > 15 || !Number.isInteger(maxReviews) || maxReviews < 0 || maxReviews > 100) throw new TypeError("Invalid boundary audio budget");
  const pending = artifact.boundaries.filter((boundary) => boundary.status === "pending").sort((a, b) => Number(a.reason !== "cross_boundary_content_disagreement") - Number(b.reason !== "cross_boundary_content_disagreement") || a.time - b.time);
  const duration = artifact.segments.at(-1)?.end_seconds || 0;
  return { selected: pending.slice(0, maxReviews).map((boundary) => ({ boundary_id: boundary.id, time: boundary.time, start_seconds: Math.max(0, boundary.time - radiusSeconds), end_seconds: Math.min(duration, boundary.time + radiusSeconds), reason: boundary.reason })),
    deferred: pending.slice(maxReviews).map((boundary) => boundary.id) };
}

export function confirmBoundaryWithBridge({ artifact, core, bridge }) {
  const boundary = artifact.boundaries.find((item) => item.id === bridge.boundary_id);
  if (!boundary || bridge.audio_sha256 !== artifact.audio_sha256 || bridge.source_signature !== artifact.source_signature
    || !Number.isFinite(bridge.start_seconds) || !Number.isFinite(bridge.end_seconds)
    || bridge.start_seconds < 0 || bridge.end_seconds > (artifact.segments.at(-1)?.end_seconds || 0)
    || bridge.start_seconds >= boundary.time || bridge.end_seconds <= boundary.time
    || bridge.end_seconds - bridge.start_seconds > 30 || typeof bridge.text !== "string") throw new TypeError("Boundary review is not bound to this source and time range");
  const index = artifact.boundaries.indexOf(boundary) + 1;
  if (core[index - 1]?.window.id !== boundary.left_window_id || core[index]?.window.id !== boundary.right_window_id
    || core.some((record, i) => record.text !== artifact.segments[i]?.text)) throw new TypeError("Boundary core source changed");
  const evidence = { boundary_id: boundary.id, start_seconds: bridge.start_seconds, end_seconds: bridge.end_seconds,
    evidence_hash: segmentSourceHash({ start_seconds: bridge.start_seconds, end_seconds: bridge.end_seconds, text: bridge.text }, index), text: bridge.text };
  if (bridge.status !== "completed" || bridge.quality?.ok === false) return { ...evidence, status: "pending", reason: "bridge_recognition_failed" };
  const left = findEdgeAnchor(core[index - 1].text, bridge.text, "tail", 120);
  const right = findEdgeAnchor(core[index].text, bridge.text, "head", 120);
  if (!left || !right || left.context_end_offset > right.context_start_offset) return { ...evidence, status: "pending", reason: "bridge_disagrees_with_core_edges" };
  const between = bridge.text.slice(left.context_end_offset, right.context_start_offset);
  if (tokens(between).length) return { ...evidence, status: "pending", reason: "possible_boundary_omission", additional_bridge_text: between };
  return { ...evidence, status: "confirmed", reason: "bridge_matches_adjacent_core_edges", anchors: [
    { start_offset: left.context_start_offset, end_offset: left.context_end_offset },
    { start_offset: right.context_start_offset, end_offset: right.context_end_offset },
  ] };
}
