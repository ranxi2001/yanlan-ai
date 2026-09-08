import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { DEFAULT_CONFIG, publicMeeting, summarizeTranscript, toMarkdown } from "../src/api.js";

const hash = (text) => createHash("sha256").update(text).digest("hex");
const seconds = (value) => value.split(":").reduce((sum, part) => sum * 60 + Number(part), 0);

export function parseTranscriptMarkdown(markdown) {
  const transcript = markdown.split(/^## 逐字稿\s*$/mu).at(-1);
  const heading = /^### (\d{2,}:\d{2}(?::\d{2})?)\s*·\s*([^\r\n]+)\r?\n+([\s\S]*?)(?=^### |$(?![\s\S]))/gmu;
  const inline = /^- \*\*\[(\d{2,}:\d{2}(?::\d{2})?)\]\*\*\s*([^\r\n]+)/gmu;
  const segments = [...transcript.matchAll(heading)].map((match) => ({ start_seconds: seconds(match[1]), speaker: match[2].trim(), text: match[3].trim(), timing_source: "inferred" }));
  if (!segments.length) {
    for (const match of transcript.matchAll(inline)) segments.push({ start_seconds: seconds(match[1]), speaker: "未区分说话人", speaker_source: "unknown", text: match[2].trim(), timing_source: "inferred" });
  }
  if (!segments.length) throw new Error("No timestamped transcript found");
  const durationMatch = markdown.match(/^- 时长：\s*(\d{2,}:\d{2}(?::\d{2})?)/mu);
  const duration = durationMatch ? seconds(durationMatch[1]) : segments.at(-1).start_seconds + 1;
  segments.forEach((segment, index) => { segment.end_seconds = segments[index + 1]?.start_seconds ?? duration; });
  const summary = markdown.match(/^## (?:AI 摘要|原文摘录[^\r\n]*)\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/mu)?.[1]?.trim() || "";
  return { title: markdown.match(/^# (.+)/mu)?.[1]?.trim() || "会议", duration, segments, summary, createdAt: "" };
}

export function evaluateContentStructure(meeting, spec = { facts: [] }) {
  const segments = meeting.segments || [];
  const summary = String(meeting.summary || "");
  const summaryText = summary.replace(/[\s\p{P}\p{S}]/gu, "");
  const normalizedSources = segments.map((segment) => String(segment.text).replace(/[\s\p{P}\p{S}]/gu, ""));
  const grams = [...summaryText].map((_, index, all) => all.slice(index, index + 12).join("")).filter((value) => [...value].length === 12);
  const copied = grams.filter((gram) => normalizedSources.some((source) => source.includes(gram))).length;
  const facts = (spec.facts || []).map((fact) => ({ id: fact.id, mentioned: fact.mentions.every((pattern) => new RegExp(pattern, "iu").test(summary)) }));
  const differences = segments.slice(1).map((segment, index) => segment.start_seconds - segments[index].start_seconds);
  return {
    summary_characters: summary.length,
    summary_kind: meeting.summary_kind || "legacy_unclassified",
    content_status: meeting.summary_content?.status || "unreviewed",
    reviewed_points: meeting.summary_content?.points?.length || 0,
    transcript_segments: segments.length,
    distinct_speaker_labels: new Set(segments.map((segment) => segment.speaker)).size,
    thirty_second_boundary_ratio: differences.length ? differences.filter((value) => value === 30).length / differences.length : null,
    copied_12_character_ratio: grams.length ? copied / grams.length : null,
    lexical_fact_mention_proxy: { matched: facts.filter((fact) => fact.mentioned).length, total: facts.length, facts },
    limitations: ["Lexical mentions do not establish semantic coverage or correctness.", "Copied text is descriptive, not a standalone quality score.", "Speaker labels and exported timestamps are not acoustic ground truth."],
  };
}

export async function runContentEvaluation({ input, specPath, output, live = false, configPath }, env = process.env) {
  const raw = await readFile(resolve(input), "utf8");
  const meeting = input.endsWith(".json") ? JSON.parse(raw) : parseTranscriptMarkdown(raw);
  const spec = specPath ? JSON.parse(await readFile(resolve(specPath), "utf8")) : { id: "structural-only", facts: [] };
  const before = evaluateContentStructure(meeting, spec);
  let result = meeting;
  const started = performance.now();
  if (live) {
    const fileConfig = configPath ? JSON.parse(await readFile(resolve(configPath), "utf8")) : {};
    const config = {
      ...DEFAULT_CONFIG,
      chatBaseUrl: env.YANLAN_LUNA_BASE_URL || env.OPENAI_BASE_URL || "",
      chatApiKey: env.YANLAN_LUNA_API_KEY || env.OPENAI_API_KEY || "",
      chatModel: env.YANLAN_LUNA_MODEL || DEFAULT_CONFIG.chatModel,
      ...fileConfig,
    };
    if (!config.chatBaseUrl || !config.chatApiKey) throw new Error("Live evaluation requires a local config or YANLAN_LUNA_BASE_URL / YANLAN_LUNA_API_KEY");
    result = { ...meeting, ...await summarizeTranscript({ config, meeting }) };
  }
  const elapsed = performance.now() - started;
  const report = {
    schema: 1, corpus: spec.id, mode: live ? "live_summary_on_existing_transcript" : "export_baseline",
    input_sha256: hash(raw), reference_status: spec.reference_status || "none",
    before, ...(live ? { after: evaluateContentStructure(result, spec), elapsed_milliseconds: Math.round(elapsed), usage: result.analysisRun?.usage || result.contentRun?.usage || null } : {}),
    acoustic_evaluation: "not_run", feishu_parity: "not_established",
  };
  if (output) {
    const target = resolve(output);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(report, null, 2) + "\n");
    if (live) {
      await writeFile(target.replace(/\.json$/u, "") + ".meeting.json", JSON.stringify(publicMeeting(result), null, 2) + "\n");
      await writeFile(target.replace(/\.json$/u, "") + ".md", toMarkdown(result));
    }
  }
  return report;
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invoked === import.meta.url) {
  const args = process.argv.slice(2);
  const get = (flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  const input = get("--input");
  if (!input) {
    console.error("Usage: node scripts/meeting-content-eval.mjs --input transcript.md [--spec data/infra-interview-content-eval.json] [--output artifacts/content-eval.json] [--live --config local-config.json]");
    process.exitCode = 1;
  } else {
    runContentEvaluation({ input, specPath: get("--spec"), output: get("--output"), live: args.includes("--live"), configPath: get("--config") })
      .then((report) => console.log(JSON.stringify(report, null, 2)))
      .catch(() => { console.error("Content evaluation failed. Check input/configuration and local provider availability; provider output and credentials are not printed."); process.exitCode = 1; });
  }
}
