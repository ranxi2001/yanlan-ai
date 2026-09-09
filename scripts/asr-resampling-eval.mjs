import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { StreamingPcmResampler } from "../src/audio-stream-core.js";
import { DEFAULT_CONFIG, transcribeAudio } from "../src/api.js";
import { parseKeyBackup } from "../src/key-backup.js";

const args = process.argv.slice(2), get = (flag) => args[args.indexOf(flag) + 1];
function ffmpeg(parameters, input) {
  return new Promise((resolvePromise, reject) => {
    const process = spawn("ffmpeg", ["-v", "error", ...parameters], { windowsHide: true });
    const parts = []; process.stdout.on("data", (part) => parts.push(part)); process.stderr.resume();
    process.on("error", reject); process.on("close", (code) => code === 0 ? resolvePromise(Buffer.concat(parts)) : reject(new Error("ffmpeg failed")));
    process.stdin.end(input);
  });
}
const samples = (buffer) => new Float32Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length));
const bytes = (array) => Buffer.from(array.buffer, array.byteOffset, array.byteLength);
function currentResample(input) {
  const resampler = new StreamingPcmResampler({ sourceRate: 48000, targetRate: 16000 });
  const parts = [];
  for (let offset = 0; offset < input.length; offset += 1024) {
    const result = resampler.push(input.subarray(offset, offset + 1024), offset / 48000);
    if (result) parts.push(result.pcm);
  }
  const output = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
  let cursor = 0; for (const part of parts) { output.set(part, cursor); cursor += part.length; }
  return output;
}
async function filtered(input) {
  return samples(await ffmpeg(["-f", "f32le", "-ar", "48000", "-ac", "1", "-i", "pipe:0", "-ar", "16000", "-f", "f32le", "pipe:1"], bytes(input)));
}
function wav(input) {
  const result = Buffer.alloc(44 + input.length * 2);
  result.write("RIFF"); result.writeUInt32LE(result.length - 8, 4); result.write("WAVEfmt ", 8); result.writeUInt32LE(16, 16);
  result.writeUInt16LE(1, 20); result.writeUInt16LE(1, 22); result.writeUInt32LE(16000, 24); result.writeUInt32LE(32000, 28);
  result.writeUInt16LE(2, 32); result.writeUInt16LE(16, 34); result.write("data", 36); result.writeUInt32LE(input.length * 2, 40);
  for (let i = 0; i < input.length; i += 1) { const s = Math.max(-1, Math.min(1, input[i])); result.writeInt16LE(Math.trunc(s < 0 ? s * 32768 : s * 32767), 44 + i * 2); }
  return new Blob([result], { type: "audio/wav" });
}
function rms(input) { let sum = 0; const slice = input.subarray(1600, input.length - 1600); for (const x of slice) sum += x * x; return Math.sqrt(sum / slice.length); }
async function main() {
  const output = resolve(get("--output-dir")); await mkdir(output, { recursive: true });
  const key = parseKeyBackup((await readFile(resolve(get("--keys")), "utf8")).replace(/^\uFEFF/u, "")).mimo;
  const config = { ...DEFAULT_CONFIG, asrApiKey: key };
  const tone = Float32Array.from({ length: 48000 * 2 }, (_, i) => .5 * Math.sin(2 * Math.PI * 12000 * i / 48000));
  const a = currentResample(tone), b = await filtered(tone);
  const spectral = { source_hz: 12000, source_rate: 48000, target_rate: 16000, expected_alias_hz: 4000, linear_output_rms: rms(a), filtered_output_rms: rms(b), filtered_vs_linear_db: 20 * Math.log10(rms(b) / rms(a)) };
  const plan = { starts: [0, 240, 810, 930, 1050], duration: 30, mixing: "explicit 0.5 L + 0.5 R", source_rate: 48000, target_rate: 16000, language: "zh", model: config.asrModel, limitations: "This isolates resampling using one FFmpeg native decode; it is not a full browser-decoder comparison." };
  await writeFile(join(output, "plan.json"), JSON.stringify(plan, null, 2));
  const results = [];
  for (const start of plan.starts) {
    const input = samples(await ffmpeg(["-ss", String(start), "-t", "30", "-i", resolve(get("--audio")), "-af", "pan=mono|c0=0.5*c0+0.5*c1", "-ar", "48000", "-f", "f32le", "pipe:1"]));
    const current = currentResample(input), lowpass = await filtered(input);
    const variants = await Promise.all([["current_linear", current], ["filtered", lowpass]].map(async ([method, data]) => {
      const started = Date.now();
      const response = await transcribeAudio({ config, blob: wav(data), language: "zh", signal: AbortSignal.timeout(120_000) });
      return { method, text: response.text, elapsed_milliseconds: Date.now() - started, samples: data.length, pcm_sha256: createHash("sha256").update(bytes(data)).digest("hex") };
    }));
    results.push({ start_seconds: start, end_seconds: start + 30, variants });
    await writeFile(join(output, "report.json"), JSON.stringify({ plan, spectral, results }, null, 2));
    console.log(JSON.stringify({ completed_clips: results.length, total: plan.starts.length }));
  }
  console.log(JSON.stringify(spectral));
}
main().catch(() => { console.error("Resampling evaluation failed; inspect input paths and provider availability."); process.exitCode = 1; });
