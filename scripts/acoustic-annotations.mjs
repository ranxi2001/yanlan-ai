import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { applyAcousticAnnotations } from "../src/acoustic-annotations.js";
import { contentSourceSignature } from "../src/meeting-content.js";
import { parseTranscriptMarkdown } from "./meeting-content-eval.mjs";

const args = process.argv.slice(2);
const get = (flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
try {
  const input = get("--input");
  const output = get("--output");
  if (!input || !output) throw new Error("usage");
  const raw = await readFile(resolve(input), "utf8");
  const meeting = input.endsWith(".json") ? JSON.parse(raw) : parseTranscriptMarkdown(raw);
  if (get("--apply")) {
    const annotation = JSON.parse(await readFile(resolve(get("--apply")), "utf8"));
    const updated = applyAcousticAnnotations(meeting, annotation);
    await writeFile(resolve(output), JSON.stringify(updated, null, 2) + "\n");
    console.log(JSON.stringify({ aligned_segments: updated.acousticAnnotations.aligned_segments, total_segments: meeting.segments.length, summary_status: "stale_requires_regeneration" }));
  } else {
    await writeFile(resolve(output), JSON.stringify({ schema: 1, source_signature: contentSourceSignature(meeting.segments), language: get("--language") || "zh", segments: meeting.segments }, null, 2) + "\n");
    console.log("Acoustic input prepared; no audio was processed.");
  }
} catch {
  console.error("Usage: node scripts/acoustic-annotations.mjs --input meeting.json|transcript.md --output output.json [--apply annotations.json] [--language zh]. Invalid/stale annotations are rejected without changing input.");
  process.exitCode = 1;
}
