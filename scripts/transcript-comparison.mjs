import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { parseTranscriptMarkdown } from "./meeting-content-eval.mjs";

export function normalizeTranscriptComparison(value) {
  return String(value).normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
}

export function characterDistance(left, right) {
  const a = [...left], b = [...right];
  let previous = Uint32Array.from({ length: b.length + 1 }, (_, index) => index);
  let current = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    [previous, current] = [current, previous];
  }
  return previous[b.length];
}

async function load(path) {
  const raw = await readFile(path, "utf8");
  return { raw, data: path.endsWith(".json") ? JSON.parse(raw) : parseTranscriptMarkdown(raw) };
}

export async function compareTranscripts({ reference, before, after, output }) {
  const [r, b, a] = await Promise.all([load(reference), load(before), load(after)]);
  const text = (item) => item.data.segments.map((segment) => segment.text).join("");
  const normalizedReference = normalizeTranscriptComparison(text(r));
  const metric = (item) => {
    const normalized = normalizeTranscriptComparison(text(item));
    const distance = characterDistance(normalizedReference, normalized);
    return { characters: [...normalized].length, reference_edit_distance: distance, reference_character_difference_rate: distance / [...normalizedReference].length,
      segments: item.data.segments.length, sha256: createHash("sha256").update(item.raw).digest("hex") };
  };
  const result = {
    schema: 1, reference_status: "feishu_machine_transcript_not_audio_gold",
    normalization: "NFKC, lowercase, remove whitespace/punctuation/symbols; no number or terminology normalization",
    before: metric(b), after: metric(a), reference_characters: [...normalizedReference].length,
    repairs: a.data.repairs?.length ?? a.data.accepted?.length ?? 0,
    unresolved: a.data.unresolved?.length ?? a.data.boundaries?.filter((item) => item.status === "pending").length ?? 0,
    run: a.data.repairRun ? { status: a.data.repairRun.status, elapsedMilliseconds: a.data.repairRun.elapsedMilliseconds, usage: a.data.repairRun.usage,
      events: a.data.repairRun.trace.reduce((counts, event) => { counts[event.type] = (counts[event.type] || 0) + 1; return counts; }, {}) } : a.data.review_run || a.data.asr_run || null,
    limitations: ["Difference from Feishu is not acoustic word/character error rate.", "Filler retention and number spelling affect the score.", "Closer wording does not prove a correction is right; review audio evidence and unresolved spans."],
    feishu_parity: "not_established",
  };
  if (output) { await mkdir(dirname(resolve(output)), { recursive: true }); await writeFile(output, JSON.stringify(result, null, 2) + "\n"); }
  return result;
}

if (process.argv[1]?.endsWith("transcript-comparison.mjs")) {
  const args = process.argv.slice(2), get = (name) => args[args.indexOf(name) + 1];
  compareTranscripts({ reference: get("--reference"), before: get("--before"), after: get("--after"), output: args.includes("--output") ? get("--output") : undefined })
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch(() => { console.error("Comparison failed; provide reference, before and after transcript paths."); process.exitCode = 1; });
}
