import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { DEFAULT_CONFIG, transcribeAudio } from "../src/api.js";
import { parseKeyBackup } from "../src/key-backup.js";
import { scoreAsr, aggregateAsrScores } from "../src/asr-benchmark-metrics.js";

const args = process.argv.slice(2), get = (flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
const sha = (buffer) => createHash("sha256").update(buffer).digest("hex");
async function main() {
  const root = resolve(get("--root") || "artifacts/hf-asr-benchmark");
  const output = resolve(get("--output") || "artifacts/hf-asr-benchmark/evaluation/mimo-baseline.json");
  const limit = Number(get("--per-dataset") || 0);
  if (!Number.isInteger(limit) || limit < 0) throw new Error("Invalid sample limit");
  const manifests = ["aishell1/manifest.jsonl", "ascend/manifest.jsonl", "aishell4/utterance-manifest.jsonl"];
  const lock = JSON.parse(await readFile(resolve(get("--lock") || "data/hf-asr-benchmark-lock.json"), "utf8"));
  const locked = new Map(lock.samples.map((row) => [row.id, row]));
  const observed = new Set();
  const selections = [];
  for (const manifest of manifests) {
    const rows = (await readFile(join(root, manifest), "utf8")).trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
    for (const row of rows) {
      const expected = locked.get(row.id);
      if (!expected || observed.has(row.id) || expected.revision !== row.revision || expected.source_split !== row.source_split
        || expected.audio_sha256 !== row.audio_sha256 || expected.reference_sha256 !== sha(Buffer.from(row.reference_text))) throw new Error("Benchmark sample does not match the frozen lock");
      observed.add(row.id);
    }
    const chosen = [];
    const groups = new Map();
    for (const row of rows) {
      const group = row.session_id ?? row.speaker_id ?? row.original_speaker_id ?? "default";
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(row);
    }
    while (chosen.length < (limit || rows.length)) {
      let added = false;
      for (const group of groups.values()) if (group.length && chosen.length < (limit || rows.length)) { chosen.push(group.shift()); added = true; }
      if (!added) break;
    }
    selections.push(...chosen);
  }
  if (observed.size !== locked.size) throw new Error("Benchmark manifest coverage differs from the frozen lock");
  await mkdir(dirname(output), { recursive: true });
  const model = get("--model") || DEFAULT_CONFIG.asrModel;
  const language = get("--language") || "auto";
  const plan = { schema: 1, model, language, sample_ids: selections.map((row) => row.id), reference_types: [...new Set(selections.map((row) => row.reference_type))],
    normalization: "NFKC/lowercase; CER excludes whitespace/punctuation/symbols; MER uses Chinese characters + English words + numeric tokens. No reference text, hotwords or speaker metadata is sent to ASR.",
    sample_limit_per_dataset: limit || null, purpose: limit ? "integration_smoke_not_model_ranking" : "fixed_public_test_subset" };
  await writeFile(output + ".plan.json", JSON.stringify(plan, null, 2));
  if (args.includes("--dry-run")) { console.log(JSON.stringify({ samples: selections.length, seconds: selections.reduce((sum, row) => sum + row.duration, 0), plan: output + ".plan.json" })); return; }
  const keys = parseKeyBackup((await readFile(resolve(get("--keys")), "utf8")).replace(/^\uFEFF/u, ""));
  const config = { ...DEFAULT_CONFIG, asrModel: model, asrApiKey: keys.mimo };
  const records = []; const started = Date.now();
  for (const sample of selections) {
    const path = resolve(root, sample.audio);
    if (!path.startsWith(root + "/") && !path.startsWith(root + "\\")) throw new Error("Audio path escapes corpus");
    const audio = await readFile(path);
    if (sha(audio) !== sample.audio_sha256) throw new Error("Corpus audio hash mismatch");
    const began = Date.now();
    const result = await transcribeAudio({ config, blob: new Blob([audio], { type: "audio/wav" }), language, signal: AbortSignal.timeout(120_000) });
    const record = { id: sample.id, dataset: sample.dataset, revision: sample.revision, source_split: sample.source_split,
      audio_sha256: sample.audio_sha256, reference_type: sample.reference_type, reference: sample.reference_text, hypothesis: result.text,
      seconds: sample.duration, elapsed_milliseconds: Date.now() - began, scores: scoreAsr(sample.reference_text, result.text) };
    records.push(record);
    await writeFile(output + ".partial.json", JSON.stringify({ plan, records }, null, 2));
    console.log(JSON.stringify({ completed: records.length, total: selections.length, dataset: sample.dataset }));
  }
  const grouped = Object.fromEntries([...new Set(records.map((record) => record.dataset))].map((dataset) => [dataset, aggregateAsrScores(records.filter((record) => record.dataset === dataset))]));
  const report = { schema: 1, plan, records, per_dataset: grouped, overall: aggregateAsrScores(records), elapsed_milliseconds: Date.now() - started,
    limitations: ["A selected public test subset is not the full official leaderboard.", "Smoke results do not rank models or establish parity with Feishu.", "Meeting ASR clips exclude annotated overlap and use channel 0; full meeting audio/RTTM remains available separately."] };
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ per_dataset: grouped, samples: records.length, elapsed_milliseconds: report.elapsed_milliseconds }));
}
main().catch((error) => { console.error(JSON.stringify({ error: "hf_asr_evaluation_failed", code: error.code || null })); process.exitCode = 1; });
