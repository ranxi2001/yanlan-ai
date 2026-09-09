import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DEFAULT_CONFIG, transcribeAudio } from "../src/api.js";
import { parseKeyBackup } from "../src/key-backup.js";
import { compareGrowingHypotheses } from "../src/asr-window-planner.js";

const args = process.argv.slice(2), get = (flag) => args[args.indexOf(flag) + 1];
async function main() {
  const root = resolve(get("--experiment")), manifest = JSON.parse(await readFile(resolve(get("--manifest")), "utf8"));
  const pcm = await readFile(join(resolve(get("--manifest")), "..", manifest.pcm_file));
  const keys = parseKeyBackup((await readFile(resolve(get("--keys")), "utf8")).replace(/^\uFEFF/u, ""));
  const config = { ...DEFAULT_CONFIG, asrApiKey: keys.mimo };
  const plan = { window_ids: [6, 16, 21], extensions_seconds: [2, 4], basis: "Previously observed chunk-boundary word errors; development diagnostics, not held-out accuracy." };
  await writeFile(join(root, "growth-plan.json"), JSON.stringify(plan, null, 2));
  const results = [];
  for (const id of plan.window_ids) {
    const base = JSON.parse(await readFile(join(root, "requests", `fixed30-${id}.json`), "utf8"));
    let previous = { audio_sha256: manifest.audio_sha256, audio_start: base.window.audio_start, audio_end: base.window.audio_end, text: base.text };
    const row = { window_id: id, base: previous, updates: [] };
    for (const extension of plan.extensions_seconds) {
      const end = Math.min(manifest.duration, base.window.audio_end + extension);
      const chunk = pcm.subarray(Math.round(base.window.audio_start * 16000) * 2, Math.round(end * 16000) * 2);
      const header = Buffer.alloc(44); header.write("RIFF"); header.writeUInt32LE(chunk.length + 36, 4); header.write("WAVEfmt ", 8);
      header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(chunk.length, 40);
      const started = Date.now();
      const result = await transcribeAudio({ config, blob: new Blob([header, chunk], { type: "audio/wav" }), language: "zh", signal: AbortSignal.timeout(120_000) });
      const next = { audio_sha256: manifest.audio_sha256, audio_start: previous.audio_start, audio_end: end, text: result.text };
      row.updates.push({ extension, elapsed_milliseconds: Date.now() - started, hypothesis: next, comparison: compareGrowingHypotheses(previous, next) });
      previous = next;
    }
    results.push(row);
    await writeFile(join(root, "growth-results.json"), JSON.stringify({ plan, results }, null, 2));
    console.log(JSON.stringify({ window_id: id, prefix_lengths: row.updates.map((item) => item.comparison.stable_units) }));
  }
}
main().catch(() => { console.error("Boundary growth experiment failed; check input paths and provider availability."); process.exitCode = 1; });
