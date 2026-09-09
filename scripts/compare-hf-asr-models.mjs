import { readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { scoreAsr, aggregateAsrScores } from "../src/asr-benchmark-metrics.js";

const args = process.argv.slice(2), get = (flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
function percentile(values, fraction) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]; }
function seededRandom() { let value = 20260909; return () => { value ^= value << 13; value ^= value >>> 17; value ^= value << 5; return (value >>> 0) / 4294967296; }; }
function paired(records, baseline, metadata, metric, dataset) {
  let better = 0, equal = 0, worse = 0;
  const groups = new Map();
  for (const row of records) {
    const base = baseline.get(row.id), sample = metadata.get(row.id);
    const delta = row.scores[metric].errors - base.scores[metric].errors;
    if (delta < 0) better += 1; else if (delta > 0) worse += 1; else equal += 1;
    const key = dataset.includes('AISHELL-4') ? sample.session_id : sample.speaker_id ?? sample.original_speaker_id;
    if (!groups.has(key)) groups.set(key, { delta: 0, denominator: 0 });
    groups.get(key).delta += delta; groups.get(key).denominator += row.scores[metric].reference_units;
  }
  const values = [...groups.values()], result = { metric, better_samples: better, equal_error_count_samples: equal, worse_samples: worse, independent_groups: values.length,
    error_rate_delta_vs_mimo: values.reduce((sum, value) => sum + value.delta, 0) / values.reduce((sum, value) => sum + value.denominator, 0) };
  if (values.length < 10) return { ...result, bootstrap_95_interval: null, interval_note: "Too few speaker/session groups for a useful group-bootstrap interval." };
  const random = seededRandom(), draws = [];
  for (let iteration = 0; iteration < 2000; iteration += 1) {
    let numerator = 0, denominator = 0;
    for (let i = 0; i < values.length; i += 1) { const value = values[Math.floor(random() * values.length)]; numerator += value.delta; denominator += value.denominator; }
    draws.push(numerator / denominator);
  }
  return { ...result, bootstrap_95_interval: [percentile(draws, .025), percentile(draws, .975)], interval_note: "Paired bootstrap by speaker; conditional on this selected public subset, not model pretraining independence." };
}

async function main() {
  const root = resolve(get("--root") || "artifacts/hf-asr-benchmark"), folder = join(root, "evaluation");
  const metadata = new Map();
  for (const name of ["aishell1/manifest.jsonl", "ascend/manifest.jsonl", "aishell4/utterance-manifest.jsonl"])
    for (const line of (await readFile(join(root, name), "utf8")).trim().split(/\r?\n/u)) {
      const row = JSON.parse(line);
      if (metadata.has(row.id)) throw new Error("Duplicate manifest sample");
      metadata.set(row.id, row);
    }
  const lock = JSON.parse(await readFile(resolve(get("--lock") || "data/hf-asr-benchmark-lock.json"), "utf8"));
  if (lock.samples.length !== metadata.size) throw new Error("Manifest coverage differs from lock");
  for (const expected of lock.samples) {
    const sample = metadata.get(expected.id);
    if (!sample || sample.audio_sha256 !== expected.audio_sha256 || sample.revision !== expected.revision
      || sample.source_split !== expected.source_split
      || createHash("sha256").update(sample.reference_text).digest("hex") !== expected.reference_sha256) throw new Error("Manifest differs from lock");
  }
  const scoreRecord = (row) => {
    const sample = metadata.get(row.id);
    if (!sample || row.audio_sha256 !== sample.audio_sha256 || row.dataset !== sample.dataset
      || Math.abs(row.seconds - sample.duration) > 1e-6 || typeof row.hypothesis !== "string"
      || (row.reference !== undefined && row.reference !== sample.reference_text)) throw new Error("Sample mismatch across model runs");
    return { ...row, reference: sample.reference_text, reference_type: sample.reference_type, scores: scoreAsr(sample.reference_text, row.hypothesis) };
  };
  const baseline = JSON.parse(await readFile(join(folder, "mimo-full.json"), "utf8"));
  if (baseline.records.length !== metadata.size || new Set(baseline.records.map((row) => row.id)).size !== metadata.size) throw new Error("Incomplete MiMo baseline");
  const models = [{ id: "mimo", metadata: { model: baseline.plan.model, device: "remote API", language: baseline.plan.language }, elapsed_seconds: baseline.elapsed_milliseconds / 1000,
    records: baseline.records.map(scoreRecord) }];
  for (const id of ["whisper", "sensevoice"]) {
    const raw = JSON.parse(await readFile(join(folder, `${id}-full.raw.json`), "utf8"));
    if (!raw.complete || raw.records.length !== metadata.size || new Set(raw.records.map((row) => row.id)).size !== metadata.size) throw new Error("Incomplete local model run");
    const records = raw.records.map(scoreRecord);
    models.push({ id, metadata: raw.metadata, elapsed_seconds: raw.metadata.elapsed_seconds_including_load, model_load_seconds: raw.model_load_seconds, records });
    await writeFile(join(folder, `${id}-full.json`), JSON.stringify({ ...raw, records }, null, 2));
  }
  const baseById = new Map(models[0].records.map((row) => [row.id, row]));
  const datasets = [...new Set([...metadata.values()].map((row) => row.dataset))];
  const summaries = models.map((model) => ({ id: model.id, metadata: model.metadata, elapsed_seconds: model.elapsed_seconds, model_load_seconds: model.model_load_seconds || null,
    summed_request_or_inference_seconds: model.records.reduce((sum, row) => sum + row.elapsed_milliseconds, 0) / 1000,
    audio_seconds: model.records.reduce((sum, row) => sum + row.seconds, 0),
    per_dataset: Object.fromEntries(datasets.map((dataset) => {
      const records = model.records.filter((row) => row.dataset === dataset);
      return [dataset, { ...aggregateAsrScores(records), perfect_samples: records.filter((row) => row.scores.cer.errors === 0).length,
        empty_hypotheses: records.filter((row) => !row.hypothesis.trim()).length,
        ...(model.id === "mimo" ? {} : { paired_vs_mimo: paired(records, baseById, metadata, dataset === "CAiRE/ASCEND" ? "mer" : "cer", dataset) }) }];
    })),
    ascend_by_language: Object.fromEntries(["mixed", "zh", "en"].map((language) => [language, aggregateAsrScores(model.records.filter((row) => row.dataset === "CAiRE/ASCEND" && metadata.get(row.id).language === language))])),
    overall: aggregateAsrScores(model.records),
  }));
  const report = { schema: 1, samples_per_model: metadata.size, total_inferences: metadata.size * models.length, models: summaries,
    limitations: ["Fixed public test subsets, not full official leaderboard results.", "No lexical hints, rewriting, or reference text conditioning.", "Backends retain different decoder/ITN internals; remote API wall time and local CPU/GPU time are not directly comparable compute throughput.", "ASCEND contains only two test speakers and meetings only two sessions; no group confidence intervals claimed there.", "Does not measure long-form chunking, overlapping speech, diarization or technical-name accuracy."] };
  if (args.includes("--whisper-zh-diagnostic")) {
    const raw = JSON.parse(await readFile(join(folder, "whisper-zh-diagnostic.raw.json"), "utf8"));
    const expected = [...metadata.values()].filter((row) => row.dataset !== "CAiRE/ASCEND");
    if (!raw.complete || raw.metadata.language !== "zh" || raw.records.length !== expected.length
      || new Set(raw.records.map((row) => row.id)).size !== expected.length
      || raw.records.some((row) => row.dataset === "CAiRE/ASCEND")) throw new Error("Invalid Chinese diagnostic coverage");
    const records = raw.records.map(scoreRecord);
    report.whisper_zh_diagnostic = { note: "Post-baseline diagnostic on the same Chinese-only corpora, changing only language=zh; not a held-out improvement estimate or a mixed-speech result.",
      metadata: raw.metadata, samples: records.length,
      per_dataset: Object.fromEntries([...new Set(expected.map((row) => row.dataset))].map((dataset) => [dataset, aggregateAsrScores(records.filter((row) => row.dataset === dataset))])) };
    await writeFile(join(folder, "whisper-zh-diagnostic.json"), JSON.stringify({ ...raw, records }, null, 2));
  }
  await writeFile(join(folder, "model-comparison.json"), JSON.stringify(report, null, 2));
  const examples = datasets.map((dataset) => ({ dataset, examples: models[0].records.filter((row) => row.dataset === dataset)
    .map((row) => ({ id: row.id, reference: row.reference, hypotheses: Object.fromEntries(models.map((model) => { const sample = model.records.find((item) => item.id === row.id); return [model.id, { text: sample.hypothesis, cer: sample.scores.cer.rate, mer: sample.scores.mer.rate }]; })) }))
    .sort((a, b) => b.hypotheses.mimo.cer - a.hypotheses.mimo.cer).slice(0, 8) }));
  await writeFile(join(folder, "error-examples.json"), JSON.stringify(examples, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
main().catch((error) => { console.error(JSON.stringify({ error: "model_comparison_failed", code: error.code || null })); process.exitCode = 1; });
