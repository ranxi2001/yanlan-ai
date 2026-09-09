import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { DEFAULT_CONFIG, transcribeAudio, formatTimestamp } from "../src/api.js";
import { parseKeyBackup } from "../src/key-backup.js";
import { assessTranscriptionQuality } from "../src/asr-quality.js";
import { confirmAsrBoundaries, verifyBoundaryPublication, planBoundaryAudioReviews, confirmBoundaryWithBridge } from "../src/asr-boundary-confirmation.js";

const args = process.argv.slice(2), get = (flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
function wav(pcm) {
  const header = Buffer.alloc(44); header.write("RIFF"); header.writeUInt32LE(pcm.length + 36, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
  return new Blob([header, pcm], { type: "audio/wav" });
}
async function main() {
  const experimentPath = resolve(get("--experiment")), manifestPath = resolve(get("--manifest")), output = resolve(get("--output-dir"));
  const experiment = JSON.parse(await readFile(join(experimentPath, "experiment.json"), "utf8"));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const core = JSON.parse(await readFile(join(experimentPath, "vad30.json"), "utf8")).records;
  const contextual = JSON.parse(await readFile(join(experimentPath, "vad30_context1.json"), "utf8")).records;
  const pcm = await readFile(join(dirname(manifestPath), manifest.pcm_file));
  if (manifest.audio_sha256 !== experiment.audio_sha256 || manifest.pcm_sha256 !== createHash("sha256").update(pcm).digest("hex") || manifest.sample_rate !== 16000) throw new Error("Audio source mismatch");
  const keys = parseKeyBackup((await readFile(resolve(get("--keys")), "utf8")).replace(/^\uFEFF/u, ""));
  const config = { ...DEFAULT_CONFIG, asrApiKey: keys.mimo };
  if (experiment.model !== config.asrModel || experiment.language !== "zh") throw new Error("ASR model or language mismatch");
  await mkdir(join(output, "reviews"), { recursive: true });
  const artifact = confirmAsrBoundaries({ core, contextual, audioHash: manifest.audio_sha256 });
  if (!verifyBoundaryPublication(artifact, { core, contextual, audioHash: manifest.audio_sha256 })) throw new Error("Publication replay failed");
  const plan = planBoundaryAudioReviews(artifact, { radiusSeconds: 6, maxReviews: Number(get("--max-reviews") || 12) });
  await writeFile(join(output, "plan.json"), JSON.stringify({ source_signature: artifact.source_signature, audio_sha256: artifact.audio_sha256, primary_radius_seconds: 6, retry_radius_seconds: 10, ...plan }, null, 2));
  const began = Date.now(), reviews = [];
  let cursor = 0, newRequests = 0, cacheHits = 0, newAudioSeconds = 0;
  async function review(target, radius) {
    const start = Math.max(0, target.time - radius), end = Math.min(manifest.duration, target.time + radius);
    const chunk = pcm.subarray(Math.round(start * 16000) * 2, Math.round(end * 16000) * 2);
    const chunkHash = createHash("sha256").update(chunk).digest("hex"), file = join(output, "reviews", `${target.boundary_id}-${radius}.json`);
    try {
      const cached = JSON.parse(await readFile(file, "utf8"));
      if (cached.pcm_sha256 !== chunkHash || cached.source_signature !== artifact.source_signature || cached.model !== config.asrModel) throw new Error("Stale review cache");
      cacheHits += 1; return cached;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const started = Date.now();
    const result = await transcribeAudio({ config, blob: wav(chunk), language: "zh", signal: AbortSignal.timeout(120_000) });
    newRequests += 1;
    newAudioSeconds += end - start;
    const item = { boundary_id: target.boundary_id, audio_sha256: artifact.audio_sha256, source_signature: artifact.source_signature, pcm_sha256: chunkHash, model: config.asrModel,
      start_seconds: start, end_seconds: end, text: result.text, status: "completed", quality: assessTranscriptionQuality(result.text, end - start), elapsed_milliseconds: Date.now() - started };
    await writeFile(file + ".tmp", JSON.stringify(item)); await rename(file + ".tmp", file);
    return item;
  }
  async function worker() {
    while (cursor < plan.selected.length) {
      const target = plan.selected[cursor++];
      const first = await review(target, 6);
      const firstVerdict = confirmBoundaryWithBridge({ artifact, core, bridge: first });
      const evidence = [first], verdicts = [firstVerdict];
      if (firstVerdict.status !== "confirmed") {
        const second = await review(target, 10); evidence.push(second);
        verdicts.push(confirmBoundaryWithBridge({ artifact, core, bridge: second }));
      }
      const confirmed = verdicts.find((item) => item.status === "confirmed");
      reviews.push({ boundary_id: target.boundary_id, evidence, verdicts, status: confirmed ? "confirmed" : "pending" });
      console.log(JSON.stringify({ boundary_id: target.boundary_id, status: confirmed ? "confirmed" : "pending", audio_calls: evidence.length }));
    }
  }
  await Promise.all([worker(), worker()]);
  reviews.sort((a, b) => Number(a.boundary_id.split("-")[1]) - Number(b.boundary_id.split("-")[1]));
  const reviewed = new Map(reviews.map((item) => [item.boundary_id, item]));
  const boundaries = artifact.boundaries.map((boundary) => reviewed.get(boundary.id)?.status === "confirmed" ? { ...boundary, status: "confirmed", reason: "bridge_matches_adjacent_core_edges" } : boundary);
  const report = { schema: 1, algorithm: "core-ownership-with-context-and-bounded-bridge-review-v1", source_signature: artifact.source_signature,
    audio_sha256: artifact.audio_sha256, segments: artifact.segments, boundaries, initial_confirmation: artifact, reviews,
    metrics: { windows: core.length, boundaries: boundaries.length, initially_confirmed: artifact.boundaries.filter((item) => item.status === "confirmed").length,
      finally_confirmed: boundaries.filter((item) => item.status === "confirmed").length, pending: boundaries.filter((item) => item.status === "pending").length,
      additional_requests: newRequests, cache_hits: cacheHits, selected_reviews: plan.selected.length, deferred_reviews: plan.deferred.length,
      total_evidence_requests: reviews.reduce((sum, item) => sum + item.evidence.length, 0), newly_submitted_audio_seconds: newAudioSeconds,
      submitted_audio_seconds: reviews.flatMap((item) => item.evidence).reduce((sum, item) => sum + item.end_seconds - item.start_seconds, 0),
      elapsed_milliseconds: Date.now() - began, published_text_exactly_core: artifact.segments.map((item) => item.text).join("") === core.map((item) => item.text).join(""),
      context_text_insertions: 0 },
    limitations: ["Uses cached non-overlapping core and contextual ASR hypotheses; their original recognition cost is excluded from this replay.", "Publication uses each core text exactly once. Agreement is not acoustic correctness.", "Bridge reviews confirm or flag evidence; they do not rewrite words or infer speakers."] };
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  const markdown = ["# 美团面试 · 核心区间唯一发布与边界确认", "", "文字来自约30秒静音切片的核心识别，未经LLM重写。上下文与桥接音频只用于边界核对；待核列表保留在文末，时间是窗口级近似时间，发言人尚未区分。", "", "## 逐字稿", "",
    ...artifact.segments.flatMap((segment) => [`### ${formatTimestamp(segment.start_seconds)} · 未区分说话人`, "", segment.text, ""]),
    "## 待核边界", "", ...boundaries.filter((item) => item.status === "pending").map((item) => `- ${formatTimestamp(item.time)}：${item.reason}`), ""].join("\n");
  await writeFile(join(output, "meituan-boundary-confirmed.md"), markdown);
  console.log(JSON.stringify(report.metrics));
}
main().catch((error) => { console.error(JSON.stringify({ error: "boundary_confirmation_eval_failed", code: error.code || null })); process.exitCode = 1; });
