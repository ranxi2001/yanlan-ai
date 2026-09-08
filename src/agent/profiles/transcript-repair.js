import { segmentSourceHash } from "../../asr-pipeline.js";
import { createTranscriptEvidenceTools, corroboratingViews } from "./transcript-evidence-tools.js";
import { locateAudioSpan } from "../../audio-span-locator.js";

const object = (properties) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const string = (minLength, maxLength) => ({ type: "string", minLength, maxLength });
const integer = (minimum, maximum) => ({ type: "integer", minimum, maximum });
const array = (items, minItems, maxItems) => ({ type: "array", items, minItems, maxItems });

export function createTranscriptRepairProfile({ segments, suspects = [], alternatives = [], alignedSegments = [], requireCorroboration = false, transcribeAudioRange, verifyPatch, sourceIsCurrent = () => true } = {}) {
  if (!Array.isArray(segments) || typeof transcribeAudioRange !== "function" || typeof verifyPatch !== "function") throw new TypeError("Transcript repair requires segments, audio review and independent patch verification");
  const source = segments.map((segment, id) => ({ ...segment, id, text: String(segment.text || ""), hash: segmentSourceHash(segment, id) }));
  const duration = source.reduce((max, segment) => Math.max(max, Number(segment.end_seconds) || 0), 0);
  const inventory = suspects.filter((item) => source[item.segment_id]?.text.includes(item.before))
    .map((item, index) => ({ id: `suspect-${index}`, segment_id: item.segment_id, before: item.before, reason: item.reason }));
  const suspectAudioSeconds = [...new Set(inventory.map((item) => item.segment_id))].reduce((sum, id) => sum + Math.min(90, Math.max(0, Number(source[id].end_seconds) - Number(source[id].start_seconds)) + 2), 0);
  const audioBudget = Math.min(900, Math.max(90, inventory.length ? Math.min(duration * 0.5, suspectAudioSeconds + 64) : duration * 0.35));
  const initialState = { covered: [], audio: [], audio_seconds: 0, patches: [], rejected_spans: [], unresolved: [], finalized: false, artifact: null };
  function fail(code) { return { output: { ok: false, code } }; }
  const profile = {
    name: "transcript-repair",
    input: JSON.stringify({ task: "Find and repair actual ASR errors using audio; preserve verbatim speech.", segments: source.length, duration_seconds: duration, audio_budget_seconds: audioBudget, suspect_inventory: inventory }),
    initialState,
    instructions: `你是逐字稿纠错监督 Agent。目标是忠实记录音频，不是润色、摘要或清理口语。
本轮累计音频复核预算为${audioBudget}秒；优先复用已完成的缓存。预算根据疑点清单的不同音频区间计算，已回听的同一区间不用再次调用。
必须读取全部片段，在每个窗口内检查普通语义错词、同音错词、跨块断词、人名项目名、数字和否定；不能只找重复术语。
suspect_inventory来自独立的全篇诊断，不是正确答案。必须处理清单中的每个疑点：优先回听再修订，不能因读过全文就跳过。没有修复的疑点必须留在unresolved；不能仅选少量熟悉的技术词后结束。清单之外发现的新错误也应处理。
按事实影响分配回听预算：先处理明显改变业务含义的错词、断词、数字与否定，再处理专名。不要把预算花在大小写调整、语气词或原本通顺的句子上。读到疑点时记录真正含该词的segment_id，而不是上一段的ID。
使用相邻上下文发现疑点，但上下文猜测不能直接修改原文。对疑点先用 review_transcript_audio 回听，再提交 propose_transcript_patch。每次只修具体片段的一处最小错误，同一词的其他出现不自动替换。
回听工具不接收你猜测的正确答案，避免诱导识别。如果音频与语言常识冲突，以音频证据为准；声音含糊或两次说法都可能成立则保留原文并记入 unresolved。
propose_transcript_patch 的 before 必须精确匹配原始片段。默认start_offset=-1，runtime会定位唯一出现；只有before出现多次时才需要提供精确UTF-16 offset。不要删除语气词、重复、自我修正或替发言人改观点；数字、否定、承诺、姓名的修改尤其需要明确声学支持。
不同说话人或跨片段的回答不可替代目标位置的证据。不把行业常识当成此处说了什么的证据。
使用search_recording_terms检查全文专名一致性；用inspect_transcript_boundary检查跨块拼接；用compare_audio_hypotheses查看不同识别结果。第一次回听不清或多个ASR有分歧时，用review_audio_context扩大音频上下文。不要把一个模糊专名直接改成常见品牌或项目名。
有字词时间索引时，优先用locate_suspect_audio定位疑点，再用review_focused_audio只回听约几秒的目标短音频。定位失败就回退整段复核，不猜时间。短窗可避免整段ASR上下文造成的误识别，也节省音频预算。
当预算不足或继续上一轮待核项时，先调用plan_audio_reviews，取得仍能在剩余预算内回听的短片段计划，不要因整段音频预算不足就跳过可定位的几秒短片段。
后续证据推翻已接受补丁时，使用retract_transcript_patch撤回，再保留疑点或提交新提案。
注意跨块断词：上一片段以“工作”结束、下一片段错误开头为“车辆”时，只将“车辆”改成“量”，不能补成“工作量”造成重复。原文offset不确定时先提交可核对的精确before，工具会返回匹配位置。
同一音频复核覆盖的多个已确认错误，请合并到propose_transcript_patches中一次提交，避免为每个词重复完整模型调用。
全覆盖后调用 finalize_transcript_repair，明确列出还需要人工回听的位置和原因。没有足够音频预算时保留疑点，不伪造成功。只使用工具提交产物。`,
    tools: [{
      name: "read_repair_window", description: "Read original transcript segments and adjacent boundary context to discover all kinds of ASR errors.", strict: true, stateful: true,
      parameters: object({ start_segment: integer(0, 100_000), max_segments: integer(1, 40) }),
      execute({ start_segment, max_segments }, { state, trace }) {
        if (state.finalized) return fail("already_finalized");
        const window = source.slice(start_segment, start_segment + max_segments);
        const covered = [...new Set([...state.covered, ...window.map((segment) => segment.id)])];
        trace.append("repair.window_read", { start_segment, segments: window.length });
        return { state: { ...state, covered }, output: { segments: window, previous: source[start_segment - 1] || null, next: source[start_segment + window.length] || null, remaining: source.length - covered.length } };
      },
    }, {
      name: "review_transcript_audio", description: "Blindly re-transcribe the target segment with a small audio context margin; no proposed replacement is sent to ASR.", strict: true, stateful: true,
      parameters: object({ segment_id: integer(0, 100_000) }),
      async execute({ segment_id }, { state, signal, trace }) {
        if (state.finalized) return fail("already_finalized");
        const segment = source[segment_id];
        if (!segment || !state.covered.includes(segment_id)) return fail("segment_not_inspected");
        const variant = "primary";
        const cached = state.audio.find((item) => item.segment_id === segment_id && item.status === "completed" && item.variant !== "expanded");
        if (cached) {
          trace.append("repair.audio_cache_hit", { segment_id, review_id: cached.id });
          return { output: { ok: true, ...cached, cached: true } };
        }
        const start = Math.max(0, Number(segment.start_seconds) - 1);
        const end = Math.min(duration, Number(segment.end_seconds) + 1);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 90) return fail("audio_range_invalid");
        if (state.audio.length >= 32 || state.audio_seconds + end - start > audioBudget) return fail("audio_budget_exhausted");
        const id = `review-${state.audio.length}`;
        const record = { id, segment_id, variant, start_seconds: start, end_seconds: end, status: "failed", text: "" };
        try {
          const result = await transcribeAudioRange({ start_seconds: start, end_seconds: end, signal });
          const text = typeof result === "string" ? result : result?.text || result?.segments?.map((item) => item.text).join("\n") || "";
          if (typeof text === "string" && text.trim() && text.length <= 8_000) { record.status = "completed"; record.text = text.trim(); }
        } catch (error) {
          if (signal?.aborted || error?.name === "AbortError") throw error;
        }
        trace.append("repair.audio_reviewed", { review_id: id, segment_id, start_seconds: start, end_seconds: end, status: record.status });
        return { state: { ...state, audio: [...state.audio, record], audio_seconds: state.audio_seconds + end - start }, output: { ok: record.status === "completed", ...record } };
      },
    }, {
      name: "propose_transcript_patch", description: "Validate one minimal, occurrence-local ASR replacement against blind audio evidence and independent semantic review.", strict: true, stateful: true,
      parameters: object({ segment_id: integer(0, 100_000), start_offset: integer(-1, 1_000_000), before: string(1, 120), after: string(1, 120), audio_review_id: string(1, 80), reason: string(1, 240) }),
      async execute(patch, { state, signal, trace }) {
        if (state.finalized) return fail("already_finalized");
        if (!sourceIsCurrent()) return fail("source_changed");
        const segment = source[patch.segment_id];
        if (patch.start_offset === -1 && segment) {
          const first = segment.text.indexOf(patch.before);
          if (first < 0 || segment.text.indexOf(patch.before, first + patch.before.length) >= 0) return fail("source_span_not_unique");
          patch = { ...patch, start_offset: first };
        }
        const end = patch.start_offset + patch.before.length;
        if (!segment || !state.covered.includes(patch.segment_id) || segment.text.slice(patch.start_offset, end) !== patch.before || patch.before === patch.after) {
          const occurrences = [];
          if (segment && patch.before) {
            let cursor = segment.text.indexOf(patch.before);
            while (cursor >= 0 && occurrences.length < 12) { occurrences.push(cursor); cursor = segment.text.indexOf(patch.before, cursor + patch.before.length); }
          }
          return { output: { ok: false, code: "source_span_mismatch", matching_start_offsets: occurrences } };
        }
        if (state.patches.length >= 100) return fail("patch_budget_exhausted");
        if (patch.before.normalize("NFKC").toLowerCase() === patch.after.normalize("NFKC").toLowerCase()) return fail("case_normalization_is_not_audio_repair");
        if (introducesBoundaryDuplicate(source, patch)) return fail("boundary_duplicate_introduced");
        if (state.patches.some((item) => item.segment_id === patch.segment_id && patch.start_offset < item.end_offset && end > item.start_offset)) return fail("overlapping_patch");
        const audio = state.audio.find((item) => item.id === patch.audio_review_id && item.segment_id === patch.segment_id && item.status === "completed");
        if (!audio) return fail("target_audio_evidence_required");
        const comparable = (text) => text.normalize("NFKC").toLowerCase().replace(/[\s\p{P}]/gu, "");
        if (!comparable(audio.text).includes(comparable(patch.after))) return fail("replacement_absent_from_audio");
        if (audio.target_start_offset != null && (patch.start_offset < audio.target_start_offset || end > audio.target_end_offset)) return fail("focused_audio_does_not_cover_patch");
        const corroboration = corroboratingViews(segment, patch.after, state.audio, alternatives, audio.id, { ...patch, end_offset: end });
        if (requireCorroboration && !corroboration.length) return { output: { ok: false, code: "additional_audio_view_required", next_tool: "review_audio_context", segment_id: patch.segment_id } };
        const novelIdentifiers = (patch.after.match(/[A-Za-z][A-Za-z0-9_-]{2,}/gu) || []).filter((term) => !source.some((item) => item.text.toLowerCase().includes(term.toLowerCase())));
        if (requireCorroboration && novelIdentifiers.length && !state.audio.some((review) => review.segment_id === patch.segment_id && review.variant === "expanded" && review.status === "completed" && comparable(review.text).includes(comparable(patch.after)))) {
          return { output: { ok: false, code: "new_identifier_requires_context_review", next_tool: "review_audio_context", segment_id: patch.segment_id, identifiers: novelIdentifiers } };
        }
        const verdict = await verifyPatch({ segment, previous: source[patch.segment_id - 1] || null, next: source[patch.segment_id + 1] || null, patch, audio, signal });
        if (verdict?.supported !== true || verdict?.same_occurrence !== true || verdict?.minimal !== true || verdict?.verbatim !== true) {
          trace.append("repair.patch_rejected", { segment_id: patch.segment_id });
          return { state: { ...state, rejected_spans: [...state.rejected_spans, { segment_id: patch.segment_id, start_offset: patch.start_offset }] },
            output: { ok: false, code: "independent_review_rejected", feedback: String(verdict?.reason || "目标位置、最小修改或音频支持未通过复核").slice(0, 180) } };
        }
        const accepted = { ...patch, end_offset: end, source_hash: segment.hash, corroborating_view_ids: corroboration.map((view) => view.id), status: "accepted", reason: "audio_verified_occurrence", review_reason: patch.reason };
        trace.append("repair.patch_accepted", { segment_id: patch.segment_id, changed_characters: patch.before.length });
        return { state: { ...state, patches: [...state.patches, accepted], rejected_spans: state.rejected_spans.filter((item) => item.segment_id !== patch.segment_id || item.start_offset !== patch.start_offset) }, output: { ok: true, accepted_patches: state.patches.length + 1 } };
      },
    }, {
      name: "finalize_transcript_repair", description: "Atomically replay accepted patches after full transcript coverage and disclose remaining uncertainty.", strict: true, stateful: true,
      parameters: object({ unresolved: array(object({ segment_id: integer(0, 100_000), reason: string(1, 240) }), 0, 100) }),
      execute({ unresolved }, { state, trace }) {
        if (state.finalized) return fail("already_finalized");
        if (!sourceIsCurrent()) return fail("source_changed");
        if (state.covered.length !== source.length) return fail("transcript_coverage_incomplete");
        if (state.patches.some((patch) => introducesBoundaryDuplicate(source, patch))) return fail("boundary_duplicate_introduced");
        if (requireCorroboration && state.patches.some((patch) => !corroboratingViews(source[patch.segment_id], patch.after, state.audio, alternatives, patch.audio_review_id, patch).length)) return fail("accepted_patch_requires_revalidation");
        if (unresolved.some((item) => !source[item.segment_id])) return fail("unknown_unresolved_segment");
        const remainingSuspects = inventory.filter((suspect) => {
          const text = source[suspect.segment_id].text;
          const spans = [];
          let offset = text.indexOf(suspect.before);
          while (offset >= 0) { spans.push([offset, offset + suspect.before.length]); offset = text.indexOf(suspect.before, offset + suspect.before.length); }
          return !spans.every(([start, end]) => state.patches.some((patch) => patch.segment_id === suspect.segment_id && patch.start_offset < end && patch.end_offset > start));
        });
        const supplied = new Set(unresolved.map((item) => item.segment_id));
        const missingSuspects = remainingSuspects.filter((suspect) => !supplied.has(suspect.segment_id));
        if (missingSuspects.length) return { output: { ok: false, code: "suspect_disposition_incomplete", remaining_suspects: missingSuspects } };
        const disclosed = new Set(unresolved.map((item) => item.segment_id));
        const failedAudio = state.audio.filter((item) => item.status !== "completed"
          && !state.audio.some((other) => other.segment_id === item.segment_id && other.status === "completed"));
        if ([...failedAudio, ...state.rejected_spans].some((item) => !disclosed.has(item.segment_id))) return fail("unresolved_audio_must_be_disclosed");
        const corrected = segments.map((segment, id) => {
          let text = source[id].text;
          for (const patch of state.patches.filter((item) => item.segment_id === id).sort((a, b) => b.start_offset - a.start_offset)) {
            if (source[id].hash !== patch.source_hash || text.slice(patch.start_offset, patch.end_offset) !== patch.before) throw new Error("repair_replay_failed");
            text = text.slice(0, patch.start_offset) + patch.after + text.slice(patch.end_offset);
          }
          return { ...segment, text };
        });
        const artifact = { segments: corrected, source_segments: segments.map((segment) => ({ ...segment })), repairs: state.patches, unresolved, suspect_inventory: inventory, audio_reviews: state.audio, status: unresolved.length ? "partial" : "completed" };
        trace.append("repair.finalized", { patches: state.patches.length, unresolved: unresolved.length, audio_seconds: state.audio_seconds });
        return { state: { ...state, unresolved, finalized: true, artifact }, output: { ok: true, patches: state.patches.length, unresolved: unresolved.length } };
      },
    }],
    isComplete: ({ state }) => state.finalized,
    isTerminalState: ({ state }) => state.finalized,
    completeOnTerminalState: true, allowEmptyFinal: true,
    result: ({ state }) => state.artifact,
    onIncomplete: () => "Continue inspecting uncertain ASR spans and reviewing audio. Finalize only after all transcript segments are read; disclose unresolved spans.",
  };
  profile.tools.unshift(...createTranscriptEvidenceTools({ source, alternatives, alignedSegments }));
  profile.tools.unshift({
    name: "plan_audio_reviews", description: "Compute which unresolved suspect spans have unique two-sided audio anchors and fit the remaining budget. Prioritizes ordinary semantic errors before unfamiliar identifiers; no guessed replacements.",
    strict: true, stateful: false, parameters: object({ limit: integer(1, 12) }),
    execute({ limit }, { state }) {
      let remaining = Math.max(0, audioBudget - state.audio_seconds);
      const candidates = inventory.filter((suspect) => !state.patches.some((patch) => patch.segment_id === suspect.segment_id && (suspect.before.includes(patch.before) || patch.before.includes(suspect.before))))
        .map((suspect) => ({ suspect, location: locateAudioSpan(source[suspect.segment_id], suspect.before, -1, alignedSegments) }))
        .filter((item) => item.location.ok)
        .sort((a, b) => Number(/[A-Za-z]/u.test(a.suspect.before)) - Number(/[A-Za-z]/u.test(b.suspect.before)) || (a.location.end_seconds - a.location.start_seconds) - (b.location.end_seconds - b.location.start_seconds));
      const plan = [];
      for (const { suspect, location } of candidates) {
        const seconds = location.end_seconds - location.start_seconds;
        if (seconds > remaining || plan.length >= limit) continue;
        if (state.audio.some((review) => review.variant === "focused" && review.segment_id === suspect.segment_id && review.target_start_offset === location.source_start_offset && review.status === "completed")) continue;
        plan.push({ segment_id: suspect.segment_id, before: suspect.before, start_offset: location.source_start_offset, start_seconds: location.start_seconds, end_seconds: location.end_seconds, reason: suspect.reason });
        remaining -= seconds;
      }
      return { output: { remaining_audio_seconds: Math.max(0, audioBudget - state.audio_seconds), planned_audio_seconds: Math.max(0, audioBudget - state.audio_seconds) - remaining, plan, nonlocatable_or_deferred_suspects: inventory.length - plan.length } };
    },
  });
  profile.tools.splice(profile.tools.length - 1, 0, {
    name: "review_focused_audio", description: "Review a short suspect span localized by two unchanged text anchors in timestamped ASR. Uses only audio, no proposed replacement; falls back explicitly when localization is ambiguous.",
    strict: true, stateful: true, parameters: object({ segment_id: integer(0, 100_000), before: string(1, 120), start_offset: integer(-1, 1_000_000) }),
    async execute({ segment_id, before, start_offset }, { state, signal, trace }) {
      if (state.finalized) return fail("already_finalized");
      const segment = source[segment_id];
      if (!segment || !state.covered.includes(segment_id)) return fail("segment_not_inspected");
      const location = locateAudioSpan(segment, before, start_offset, alignedSegments);
      if (!location.ok) return { output: location };
      const cached = state.audio.find((item) => item.variant === "focused" && item.segment_id === segment_id && item.target_start_offset === location.source_start_offset && item.target_end_offset === location.source_end_offset && item.status === "completed");
      if (cached) return { output: { ok: true, ...cached, cached: true } };
      const start = location.start_seconds, end = Math.min(duration, location.end_seconds);
      if (!(end > start) || state.audio.length >= 48 || state.audio_seconds + end - start > audioBudget) return fail("audio_budget_exhausted");
      const record = { id: `review-${state.audio.length}`, segment_id, variant: "focused", start_seconds: start, end_seconds: end,
        target_start_offset: location.source_start_offset, target_end_offset: location.source_end_offset, status: "failed", text: "" };
      try {
        const result = await transcribeAudioRange({ start_seconds: start, end_seconds: end, signal });
        const text = typeof result === "string" ? result : result?.text || result?.segments?.map((item) => item.text).join("\n") || "";
        if (typeof text === "string" && text.trim() && text.length <= 4_000) { record.status = "completed"; record.text = text.trim(); }
      } catch (error) { if (signal?.aborted || error?.name === "AbortError") throw error; }
      trace.append("repair.focused_audio_reviewed", { segment_id, start_seconds: start, end_seconds: end, status: record.status });
      return { state: { ...state, audio: [...state.audio, record], audio_seconds: state.audio_seconds + end - start }, output: { ok: record.status === "completed", ...record } };
    },
  });
  profile.tools.splice(profile.tools.length - 1, 0, {
    name: "retract_transcript_patch", description: "Revoke one previously accepted proposal when later evidence contradicts it; original transcript remains available and unresolved evidence is retained.",
    strict: true, stateful: true, parameters: object({ segment_id: integer(0, 100_000), start_offset: integer(0, 1_000_000), reason: string(1, 240) }),
    execute({ segment_id, start_offset }, { state, trace }) {
      if (state.finalized) return fail("already_finalized");
      const patches = state.patches.filter((patch) => patch.segment_id !== segment_id || patch.start_offset !== start_offset);
      if (patches.length === state.patches.length) return fail("patch_not_found");
      trace.append("repair.patch_retracted", { segment_id, start_offset });
      return { state: { ...state, patches, rejected_spans: [...state.rejected_spans, { segment_id, start_offset }] }, output: { ok: true, accepted_patches: patches.length } };
    },
  });
  profile.tools.splice(profile.tools.length - 1, 0, {
    name: "review_audio_context", description: "Re-transcribe the same target with 15 seconds of audio context on both sides (maximum 90 seconds). No candidate text is supplied to ASR. Stable agreement across audio windows can corroborate a patch.",
    strict: true, stateful: true, parameters: object({ segment_id: integer(0, 100_000) }),
    async execute({ segment_id }, { state, signal, trace }) {
      if (state.finalized) return fail("already_finalized");
      const segment = source[segment_id];
      if (!segment || !state.covered.includes(segment_id)) return fail("segment_not_inspected");
      const cached = state.audio.find((item) => item.segment_id === segment_id && item.variant === "expanded" && item.status === "completed");
      if (cached) return { output: { ok: true, ...cached, cached: true } };
      const start = Math.max(0, Number(segment.start_seconds) - 15), end = Math.min(duration, Number(segment.end_seconds) + 15);
      if (state.audio.some((item) => item.segment_id === segment_id && item.start_seconds === start && item.end_seconds === end && item.status === "completed")) return fail("no_additional_audio_context_available");
      if (!(end > start) || end - start > 90 || state.audio.length >= 32 || state.audio_seconds + end - start > audioBudget) return fail("audio_budget_exhausted");
      const record = { id: `review-${state.audio.length}`, segment_id, variant: "expanded", start_seconds: start, end_seconds: end, status: "failed", text: "" };
      try {
        const result = await transcribeAudioRange({ start_seconds: start, end_seconds: end, signal });
        const text = typeof result === "string" ? result : result?.text || result?.segments?.map((item) => item.text).join("\n") || "";
        if (typeof text === "string" && text.trim() && text.length <= 8_000) { record.text = text.trim(); record.status = "completed"; }
      } catch (error) { if (signal?.aborted || error?.name === "AbortError") throw error; }
      trace.append("repair.context_reviewed", { segment_id, start_seconds: start, end_seconds: end, status: record.status });
      return { state: { ...state, audio: [...state.audio, record], audio_seconds: state.audio_seconds + end - start }, output: { ok: record.status === "completed", ...record } };
    },
  });
  const singlePatch = profile.tools.find((tool) => tool.name === "propose_transcript_patch");
  profile.tools.splice(profile.tools.length - 1, 0, {
    name: "propose_transcript_patches", description: "Batch occurrence-local corrections already supported by audio. Each patch is independently validated; rejected patches never commit.",
    strict: true, stateful: true, parameters: object({ patches: array(singlePatch.parameters, 1, 12) }),
    async execute({ patches }, context) {
      let state = context.state;
      const results = [];
      for (const patch of patches) {
        const result = await singlePatch.execute(patch, { ...context, state });
        state = result.state || state;
        results.push({ segment_id: patch.segment_id, before: patch.before, ...result.output });
      }
      return { state, output: { results } };
    },
  });
  return profile;
}

function introducesBoundaryDuplicate(source, patch) {
  if (patch.start_offset !== 0 || patch.segment_id === 0) return false;
  const previous = source[patch.segment_id - 1];
  const segment = source[patch.segment_id];
  if (Number(segment.start_seconds) - Number(previous.end_seconds) > 2) return false;
  const tail = previous.text.trim();
  for (let length = Math.min(12, tail.length, patch.after.length); length >= 2; length -= 1) {
    const boundary = tail.slice(-length);
    if (patch.after.startsWith(boundary) && !patch.before.startsWith(boundary)) return true;
  }
  return false;
}
