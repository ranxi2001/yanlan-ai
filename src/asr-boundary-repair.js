import { segmentSourceHash } from "./asr-pipeline.js";
import { confirmBoundaryWithBridge } from "./asr-boundary-confirmation.js";

function units(text) {
  const result = [];
  for (const match of text.matchAll(/[A-Za-z][A-Za-z0-9_-]*|\d+(?:[.,]\d+)*|[\p{L}\p{N}]|[?？]/gu)) {
    if (/^[呃嗯]$/u.test(match[0])) continue;
    result.push({ key: match[0].normalize("NFKC").toLowerCase().replace("？", "?"), start: match.index, end: match.index + match[0].length });
  }
  return result;
}
const equal = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const keys = (items) => items.map((item) => item.key);

function occurrences(haystack, needle) {
  const result = [];
  for (let i = 0; i <= haystack.length - needle.length; i += 1) if (equal(haystack.slice(i, i + needle.length), needle)) result.push(i);
  return result;
}

function anchoredGap(view, left, right) {
  const tokens = units(view.text), values = keys(tokens);
  const starts = occurrences(values, left), ends = occurrences(values, right);
  if (starts.length !== 1 || ends.length !== 1) return null;
  const start = starts[0] + left.length, end = ends[0];
  if (end < start || end - start > 8) return null;
  return { keys: values.slice(start, end), text: start === end ? "" : view.text.slice(tokens[start].start, tokens[end - 1].end),
    start_offset: start === end ? tokens[start - 1].end : tokens[start].start,
    end_offset: start === end ? tokens[start - 1].end : tokens[end - 1].end };
}

function protectedChange(before, after) {
  // Conservative eligibility, not a semantic guarantee. Protect factual polarity,
  // numbers, identifiers, named entities, punctuation and meaningful acknowledgements.
  const protectedPattern = /[A-Za-z0-9０-９零〇一二两三四五六七八九十百千万亿不没未无否勿吗么？?呃嗯啊哦诶呀]|可能|应该|必须|至少|最多|已经|尚未|如果|除非|假如|只要|决定|确认|承诺|负责|截止|录用|批准/u;
  return protectedPattern.test(before) || protectedPattern.test(after)
    || /[\p{P}\p{S}]/u.test(before + after);
}

function fingerprint(report) {
  return segmentSourceHash({ text: JSON.stringify({ signature: report.source_signature, audio: report.audio_sha256,
    segments: report.segments, boundaries: report.boundaries, reviews: report.reviews }) }, 0);
}

export function proposeStableBoundaryRepairs(report) {
  if (report?.schema !== 1 || !report.audio_sha256 || !report.source_signature || !Array.isArray(report.segments)
    || !Array.isArray(report.boundaries) || !Array.isArray(report.reviews)) throw new TypeError("Invalid boundary report");
  const proposals = [], seen = new Set();
  for (const review of report.reviews) {
    if (review.status !== "pending") continue;
    const boundary = report.boundaries.find((item) => item.id === review.boundary_id);
    if (!boundary) continue;
    const leftIndex = report.segments.findIndex((item) => item.source_window_id === boundary.left_window_id);
    const rightIndex = leftIndex + 1;
    const leftSegment = report.segments[leftIndex], rightSegment = report.segments[rightIndex];
    if (!leftSegment || rightSegment?.source_window_id !== boundary.right_window_id) continue;
    const views = (review.evidence || []).filter((item) => item.boundary_id === boundary.id && item.status === "completed" && item.quality?.ok !== false
      && item.source_signature === report.source_signature && item.audio_sha256 === report.audio_sha256
      && Number.isFinite(item.start_seconds) && Number.isFinite(item.end_seconds)
      && item.start_seconds >= 0 && item.start_seconds < boundary.time && item.end_seconds > boundary.time
      && item.end_seconds <= report.segments.at(-1).end_seconds && item.end_seconds - item.start_seconds <= 30);
    const uniqueViews = [...new Map(views.map((item) => [`${item.start_seconds}:${item.end_seconds}`, item])).values()];
    if (uniqueViews.length < 2) continue;
    const joined = leftSegment.text + rightSegment.text;
    const tokens = units(joined), boundaryOffset = leftSegment.text.length;
    const seam = tokens.findIndex((item) => item.start >= boundaryOffset);
    if (seam < 0) continue;
    for (let start = Math.max(4, seam - 20); start < Math.min(tokens.length - 4, seam + 20); start += 1) {
      for (let length = 0; length <= 6 && start + length + 4 <= tokens.length; length += 1) {
        const left = keys(tokens.slice(start - 4, start)), right = keys(tokens.slice(start + length, start + length + 4));
        const gaps = uniqueViews.map((view) => anchoredGap(view, left, right));
        if (gaps.some((gap) => !gap) || !gaps.every((gap) => equal(gap.keys, gaps[0].keys))) continue;
        const original = keys(tokens.slice(start, start + length)), replacement = gaps[0].keys;
        if (equal(original, replacement)) continue;
        let head = 0, tail = 0;
        while (head < original.length && head < replacement.length && original[head] === replacement[head]) head += 1;
        while (tail < original.length - head && tail < replacement.length - head && original.at(-1 - tail) === replacement.at(-1 - tail)) tail += 1;
        const changedStart = start + head, changedEnd = start + length - tail;
        const from = tokens[changedStart].start;
        const to = changedStart === changedEnd ? from : tokens[changedEnd - 1].end;
        if (from < boundaryOffset && to > boundaryOffset) continue;
        const targetIndex = from < boundaryOffset ? leftIndex : rightIndex;
        const offset = targetIndex === rightIndex ? boundaryOffset : 0;
        const before = joined.slice(from, to);
        const firstTokens = units(gaps[0].text);
        const afterKeys = replacement.slice(head, replacement.length - tail);
        const after = afterKeys.length ? gaps[0].text.slice(firstTokens[head].start, firstTokens[replacement.length - tail - 1].end) : "";
        if ((!before && !after) || before.length > 12 || after.length > 12 || protectedChange(before, after)) continue;
        const key = JSON.stringify([targetIndex, from - offset, to - offset, after]);
        if (seen.has(key)) continue;
        seen.add(key);
        proposals.push({ id: `boundary-patch-${proposals.length}`, boundary_id: boundary.id, segment_id: targetIndex,
          source_window_id: report.segments[targetIndex].source_window_id, start_offset: from - offset, end_offset: to - offset, before, after,
          source_hash: segmentSourceHash(report.segments[targetIndex], targetIndex),
          left_anchor: left.join(""), right_anchor: right.join(""),
          evidence: uniqueViews.map((view, i) => ({ start_seconds: view.start_seconds, end_seconds: view.end_seconds,
            quote: gaps[i].text, quote_start_offset: gaps[i].start_offset, quote_end_offset: gaps[i].end_offset,
            source_hash: segmentSourceHash({ text: view.text, start_seconds: view.start_seconds, end_seconds: view.end_seconds }, 0) })) });
      }
    }
  }
  return { schema: 1, input_fingerprint: fingerprint(report), proposals,
    status: "proposed_requires_semantic_review", warning: "Two windows from the same ASR are correlated evidence, not acoustic gold." };
}

export function applyReviewedBoundaryRepairs(report, draft, reviews) {
  if (draft.input_fingerprint !== fingerprint(report)) throw new Error("boundary_repair_source_changed");
  const replayed = proposeStableBoundaryRepairs(report);
  if (JSON.stringify(replayed.proposals) !== JSON.stringify(draft.proposals)) throw new Error("boundary_repair_proposal_changed");
  if (!Array.isArray(reviews) || reviews.length !== draft.proposals.length) throw new Error("boundary_repair_review_incomplete");
  const byId = new Map();
  for (const review of reviews) {
    if (!draft.proposals.some((item) => item.id === review.id) || byId.has(review.id)
      || !["supported", "unsupported", "uncertain"].includes(review.verdict)) throw new Error("boundary_repair_invalid_review");
    byId.set(review.id, review);
  }
  const accepted = [], rejected = [];
  for (const proposal of draft.proposals) {
    const review = byId.get(proposal.id);
    if (review.verdict !== "supported") { rejected.push({ ...proposal, verdict: review.verdict, reason: String(review.reason || "").slice(0, 240) }); continue; }
    const collision = accepted.some((patch) => patch.segment_id === proposal.segment_id && !(proposal.end_offset < patch.start_offset || proposal.start_offset > patch.end_offset));
    if (collision) { rejected.push({ ...proposal, verdict: "uncertain", reason: "overlapping_proposals" }); continue; }
    accepted.push({ ...proposal, review_reason: String(review.reason || "").slice(0, 240) });
  }
  const segments = report.segments.map((segment, index) => {
    let text = segment.text;
    for (const patch of accepted.filter((item) => item.segment_id === index).sort((a, b) => b.start_offset - a.start_offset)) {
      if (text.slice(patch.start_offset, patch.end_offset) !== patch.before) throw new Error("boundary_repair_replay_failed");
      text = text.slice(0, patch.start_offset) + patch.after + text.slice(patch.end_offset);
    }
    return { ...segment, text };
  });
  const projected = { ...report, segments };
  const projectedCore = segments.map((segment) => ({ text: segment.text, window: { id: segment.source_window_id } }));
  const boundaryReviews = report.reviews.map((review) => ({ boundary_id: review.boundary_id,
    verdicts: review.evidence.map((bridge) => confirmBoundaryWithBridge({ artifact: projected, core: projectedCore, bridge })) }));
  const boundaries = report.boundaries.map((boundary) => {
    const checked = boundaryReviews.find((review) => review.boundary_id === boundary.id);
    return boundary.status === "pending" && checked?.verdicts.some((item) => item.status === "confirmed")
      ? { ...boundary, status: "confirmed", reason: "reviewed_local_repair_then_bridge_agreement" } : boundary;
  });
  return { schema: 1, source_signature: report.source_signature, audio_sha256: report.audio_sha256, input_fingerprint: draft.input_fingerprint,
    source_segments: report.segments, segments, accepted, rejected, original_pending_boundaries: report.boundaries.filter((item) => item.status === "pending"),
    boundaries, boundary_reviews_after_repairs: boundaryReviews,
    status: "partial", warning: "Local repairs do not resolve all boundary uncertainty or establish acoustic accuracy. Published timing remains core-window timing." };
}
