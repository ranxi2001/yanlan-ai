import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { DEFAULT_CONFIG, transcribeAudio, formatTimestamp } from "../src/api.js";
import { parseKeyBackup } from "../src/key-backup.js";
import { assessTranscriptionQuality } from "../src/asr-quality.js";
import { planAsrWindows, stitchAsrWindows } from "../src/asr-window-planner.js";
import { parseTranscriptMarkdown } from "./meeting-content-eval.mjs";
import { characterDistance, normalizeTranscriptComparison } from "./transcript-comparison.mjs";

const args = process.argv.slice(2);
const get = (flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const specs = [
  { id: "fixed30", mode: "fixed", targetSeconds: 30, minSeconds: 30, maxSeconds: 30, contextSeconds: 0 },
  { id: "vad30", mode: "vad", targetSeconds: 30, minSeconds: 20, maxSeconds: 40, contextSeconds: 0 },
  { id: "vad60", mode: "vad", targetSeconds: 60, minSeconds: 40, maxSeconds: 80, contextSeconds: 0 },
  { id: "vad30_context1", mode: "vad", targetSeconds: 30, minSeconds: 20, maxSeconds: 40, contextSeconds: 1 },
];

function wav(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(pcm.length + 36, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
  return new Blob([header, pcm], { type: "audio/wav" });
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] : null;
}

async function main() {
  const manifestPath = resolve(get("--manifest"));
  const output = resolve(get("--output-dir"));
  const audio = JSON.parse(await readFile(manifestPath, "utf8"));
  const pcm = await readFile(join(dirname(manifestPath), audio.pcm_file));
  if (hash(pcm) !== audio.pcm_sha256) throw new Error("PCM hash mismatch");
  const keys = parseKeyBackup((await readFile(resolve(get("--keys")), "utf8")).replace(/^\uFEFF/u, ""));
  const config = { ...DEFAULT_CONFIG, asrApiKey: keys.mimo };
  await mkdir(join(output, "requests"), { recursive: true });
  const requestedConditions = get("--conditions")?.split(",");
  if (requestedConditions?.some((id) => !specs.some((spec) => spec.id === id))) throw new Error("Unknown experiment condition");
  const selectedSpecs = requestedConditions ? specs.filter((spec) => requestedConditions.includes(spec.id)) : specs;
  const conditions = selectedSpecs.map((spec) => ({ ...spec, windows: planAsrWindows({ ...spec, duration: audio.duration, speech: audio.speech }) }));
  const experiment = { schema: 1, audio_sha256: audio.audio_sha256, pcm_sha256: audio.pcm_sha256, duration: audio.duration, model: config.asrModel,
    language: "zh", prompt: "audio_only_gateway_default", vad: audio.vad, concurrency: 2, scheduling: "round_robin_by_window_index",
    conditions, fixed_repeat_ids: [0, 17, 34, 50],
    normalization: ["NFKC/lowercase/remove whitespace punctuation symbols", "same plus remove only 呃嗯啊"],
    overlap_policy: "retain raw hypotheses; exact bounded suffix-prefix overlap projection; unresolved seams retained",
    reference_status: "Feishu machine output is not acoustic gold", created_at: new Date().toISOString() };
  const planPath = join(output, "experiment.json");
  try {
    const previous = JSON.parse(await readFile(planPath, "utf8"));
    if (previous.pcm_sha256 !== experiment.pcm_sha256 || previous.model !== experiment.model || previous.language !== experiment.language
      || previous.prompt !== experiment.prompt || JSON.stringify(previous.conditions) !== JSON.stringify(conditions)) throw new Error("Existing experiment differs; choose a new output directory");
  } catch (error) { if (error.code !== "ENOENT") throw error; await writeFile(planPath, JSON.stringify(experiment, null, 2)); }
  const tasks = [];
  for (let index = 0; index < Math.max(...conditions.map((item) => item.windows.length)); index += 1)
    for (const condition of conditions) if (condition.windows[index]) tasks.push({ condition: condition.id, window: condition.windows[index] });
  const fixedCondition = conditions.find((condition) => condition.id === "fixed30");
  for (const id of experiment.fixed_repeat_ids) if (fixedCondition?.windows[id]) tasks.push({ condition: "fixed30_repeat", window: fixedCondition.windows[id] });
  let cursor = 0, completed = 0, cacheHits = 0;
  const started = performance.now();
  const records = [];
  async function worker() {
    while (cursor < tasks.length) {
      const task = tasks[cursor++], path = join(output, "requests", `${task.condition}-${task.window.id}.json`);
      let record;
      try { record = JSON.parse(await readFile(path, "utf8")); cacheHits += 1; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (!record) {
        const from = Math.max(0, Math.round(task.window.audio_start * audio.sample_rate) * 2);
        const to = Math.min(pcm.length, Math.round(task.window.audio_end * audio.sample_rate) * 2);
        const chunk = pcm.subarray(from, to), began = performance.now();
        let attempts = 0, result, failure;
        for (; attempts < 3; attempts += 1) {
          try {
            result = await transcribeAudio({ config, blob: wav(chunk, audio.sample_rate), fileName: "window.wav", language: "zh", signal: AbortSignal.timeout(120_000) });
            attempts += 1; break;
          } catch (error) { failure = { code: String(error.code || "request_failed"), status: error.status || null }; if (!error.retryable) { attempts += 1; break; } }
        }
        const text = result?.text || result?.segments?.map((item) => item.text).join("\n") || "";
        record = { ...task, pcm_sha256: hash(chunk), status: result ? "completed" : "failed", text, request_milliseconds: performance.now() - began, attempts,
          usage: result?.raw?.usage || null, quality: assessTranscriptionQuality(text, (to - from) / (audio.sample_rate * 2)), ...(result ? {} : { failure }) };
        await writeFile(path + ".tmp", JSON.stringify(record)); await rename(path + ".tmp", path);
      }
      records.push(record); completed += 1;
      if (completed % 10 === 0 || completed === tasks.length) console.log(JSON.stringify({ event: "progress", completed, total: tasks.length, cache_hits: cacheHits }));
    }
  }
  await Promise.all([worker(), worker()]);
  // Reference data is first read after every ASR request has finished.
  const reference = parseTranscriptMarkdown(await readFile(resolve(get("--reference")), "utf8"));
  const refText = normalizeTranscriptComparison(reference.segments.map((segment) => segment.text).join(""));
  const neutral = (text) => text.replace(/[呃嗯啊]/gu, "");
  const summary = [];
  for (const condition of conditions) {
    const list = records.filter((record) => record.condition === condition.id).sort((a, b) => a.window.id - b.window.id);
    const stitched = stitchAsrWindows(list);
    const rawText = normalizeTranscriptComparison(list.map((item) => item.text).join(""));
    const text = normalizeTranscriptComparison(stitched.segments.map((item) => item.text).join(""));
    const metrics = { condition: condition.id, windows: list.length, failed_requests: list.filter((item) => item.status !== "completed").length,
      attempts: list.reduce((sum, item) => sum + item.attempts, 0), submitted_audio_seconds: list.reduce((sum, item) => sum + item.window.audio_end - item.window.audio_start, 0),
      nominal_boundary_count: Math.max(0, list.length - 1), silence_cut_count: condition.windows.filter((window) => window.boundary_reason === "silence_midpoint").length,
      core_duration_median: percentile(list.map((item) => item.window.core_end - item.window.core_start), .5), quality_flagged_windows: list.filter((item) => !item.quality.ok).length,
      request_milliseconds_median: percentile(list.map((item) => item.request_milliseconds), .5), request_milliseconds_p95: percentile(list.map((item) => item.request_milliseconds), .95),
      summed_request_milliseconds: list.reduce((sum, item) => sum + item.request_milliseconds, 0),
      raw_reference_difference_rate: characterDistance(refText, rawText) / [...refText].length,
      projected_reference_difference_rate: characterDistance(refText, text) / [...refText].length,
      filler_neutral_reference_difference_rate: characterDistance(neutral(refText), neutral(text)) / [...neutral(refText)].length,
      exact_overlap_projections: stitched.boundaries.filter((item) => item.status === "exact_overlap_projected").length,
      unresolved_overlap_boundaries: stitched.boundaries.filter((item) => item.status === "unresolved_overlap").length };
    summary.push(metrics);
    await writeFile(join(output, condition.id + ".json"), JSON.stringify({ condition, metrics, records: list, ...stitched }, null, 2));
    const markdown = [`# 美团面试 ASR实验：${condition.id}`, "", "仅ASR输出，未经LLM重写。时间为窗口范围；说话人未区分。重叠投影有单独账本，未解决边界保留原文。", "", "## 逐字稿", "",
      ...stitched.segments.flatMap((segment) => [`### ${formatTimestamp(segment.start_seconds)} · 未区分说话人`, "", segment.text, ""])].join("\n");
    await writeFile(join(output, condition.id + ".md"), markdown);
  }
  const repeats = records.filter((record) => record.condition === "fixed30_repeat").map((record) => {
    const original = records.find((item) => item.condition === "fixed30" && item.window.id === record.window.id);
    const a = normalizeTranscriptComparison(original.text), b = normalizeTranscriptComparison(record.text);
    return { window_id: record.window.id, same_pcm: original.pcm_sha256 === record.pcm_sha256, exact_text_match: a === b, character_distance: characterDistance(a, b), original_characters: [...a].length };
  });
  const report = { schema: 1, elapsed_milliseconds: performance.now() - started, cache_hits: cacheHits, requested_windows: tasks.length, preparation_seconds: audio.preparation_seconds, conditions: summary, repeat_checks: repeats,
    limitations: ["One development recording, single run per variant, only four same-input repeat checks.", "Reference difference rates are not acoustic CER or semantic accuracy.", "Overlap projection is experimental; unresolved seams can duplicate speech.", "Summed request time is service occupancy, not per-variant wall-clock time under interleaving.", "No LLM rewriting or user vocabulary is used; no quality-failure resegmentation was applied."] };
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => { console.error(JSON.stringify({ error: "asr_window_eval_failed", code: error.code || null })); process.exitCode = 1; });
