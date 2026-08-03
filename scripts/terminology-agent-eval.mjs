import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_CONFIG, correctTranscript, transcribeAudioWithRetry } from "../src/api.js";
import { DEFAULT_TERMINOLOGY_SPEC, parseShareMeeting } from "./terminology-eval.mjs";

export async function runTerminologyAgentEvaluation(specPath = DEFAULT_TERMINOLOGY_SPEC, env = process.env) {
  const resolvedSpecPath = resolve(specPath);
  const spec = JSON.parse(await readFile(resolvedSpecPath, "utf8"));
  const dataDirectory = dirname(resolvedSpecPath);
  const audioPath = resolve(dataDirectory, spec.audio.path);
  const audioBytes = await readFile(audioPath);
  const audioSha256 = sha256(audioBytes);
  assert.equal(audioSha256, spec.audio.sha256, "Live Agent eval audio fixture hash does not match the gold spec");
  const shareHtml = await readFile(resolve(dataDirectory, spec.share_html.path), "utf8");
  const meeting = parseShareMeeting(shareHtml);
  const sourceGeometry = transcriptGeometry(meeting.segments);
  const config = agentEvalConfig(env);
  const disclosure = terminologyPromptDisclosure(config.contextHint, spec.terminology);
  assert.deepEqual(disclosure.disclosed_terms, [], "Live Agent eval context leaks one or more gold terminology answers");
  const transcribeAudioRange = mimoRangeTool(config, audioPath, env);
  const startedAt = Date.now();
  const corrected = await correctTranscript({ config, meeting, transcribeAudioRange });
  const elapsedMilliseconds = Date.now() - startedAt;
  const correctedText = transcriptText(corrected.segments);
  const canonicalOccurrences = countCanonicalOccurrences(correctedText, spec.terminology.canonical);
  const forbiddenOccurrences = countTerms(correctedText, spec.terminology.aliases);
  const accepted = corrected.corrections.filter((entry) => entry.status === "accepted");
  const rejected = corrected.corrections.filter((entry) => entry.status === "rejected");
  const targetAliases = new Set(spec.terminology.aliases.map((term) => String(term).normalize("NFKC")));
  const targetAccepted = accepted.filter((entry) => targetAliases.has(String(entry.from || "").normalize("NFKC")));
  const targetRejected = rejected.filter((entry) => targetAliases.has(String(entry.from || "").normalize("NFKC")));

  assert.equal(canonicalOccurrences, spec.terminology.expected_occurrences, "Luna did not canonicalize every expected occurrence");
  assert.equal(forbiddenOccurrences, 0, "Luna left one or more known aliases in the transcript");
  assert.deepEqual(transcriptGeometry(corrected.segments), sourceGeometry, "Agent correction changed timestamps or speakers");
  assert.equal(targetAccepted.length, spec.terminology.expected_occurrences, "Agent correction ledger is missing target accepted occurrences");
  assert.equal(
    targetAccepted.every((entry) => String(entry.to || "").normalize("NFKC") === String(spec.terminology.canonical).normalize("NFKC")),
    true,
    "Agent correction ledger contains a target alias mapped to the wrong canonical",
  );
  assert.equal(targetRejected.length, 0, "Agent correction ledger contains rejected target mappings");
  assert.ok(corrected.agentRun?.trace?.length, "Agent run trace is missing");

  const toolStarts = corrected.agentRun.trace.filter((event) => event.type === "tool.started");
  return {
    schema: 1,
    ok: true,
    mode: "live_agent_discovery_without_terminology_hint",
    corpus: spec.id,
    elapsed_milliseconds: elapsedMilliseconds,
    prompt_disclosure: {
      canonical_supplied: disclosure.canonical_supplied,
      aliases_supplied: disclosure.aliases_supplied,
      context_hint_characters: config.contextHint.length,
      context_hint_sha256: sha256(config.contextHint),
    },
    models: {
      supervisor: config.chatModel,
      asr_review: transcribeAudioRange ? config.asrModel : null,
    },
    terminology: {
      canonical: spec.terminology.canonical,
      expected_occurrences: spec.terminology.expected_occurrences,
      canonical_occurrences: canonicalOccurrences,
      forbidden_alias_occurrences: forbiddenOccurrences,
      accepted_ledger_entries: targetAccepted.length,
      rejected_ledger_entries: targetRejected.length,
      other_accepted_ledger_entries: accepted.length - targetAccepted.length,
      other_rejected_ledger_entries: rejected.length - targetRejected.length,
    },
    agent: {
      run_id: corrected.agentRun.id,
      usage: corrected.agentRun.usage,
      tool_calls: toolStarts.map((event) => event.data.tool),
      mimo_audio_reviews: corrected.agentRun.trace.filter((event) => event.type === "term.audio_retranscribed").length,
    },
  };
}

function agentEvalConfig(env) {
  const chatBaseUrl = firstValue(env.YANLAN_LUNA_BASE_URL, env.OPENAI_BASE_URL);
  const chatApiKey = firstValue(env.YANLAN_LUNA_API_KEY, env.OPENAI_API_KEY);
  if (!chatBaseUrl || !chatApiKey) {
    throw new Error("Live Agent eval requires YANLAN_LUNA_BASE_URL and YANLAN_LUNA_API_KEY (or OPENAI_BASE_URL and OPENAI_API_KEY)");
  }
  return {
    ...DEFAULT_CONFIG,
    chatBaseUrl,
    chatApiKey,
    chatModel: firstValue(env.YANLAN_LUNA_MODEL, "gpt-5.6-luna"),
    chatProtocol: "responses",
    chatPath: firstValue(env.YANLAN_LUNA_RESPONSES_PATH, "responses"),
    contextHint: firstValue(env.YANLAN_AGENT_EVAL_CONTEXT, "云原生 Kubernetes 调度与任务类型适配方案周会"),
    asrBaseUrl: firstValue(env.MIMO_BASE_URL, DEFAULT_CONFIG.asrBaseUrl),
    asrApiKey: firstValue(env.MIMO_API_KEY, env.XIAOMI_API_KEY),
    asrModel: firstValue(env.MIMO_ASR_MODEL, DEFAULT_CONFIG.asrModel),
  };
}

function mimoRangeTool(config, audioPath, env) {
  if (!config.asrApiKey) return undefined;
  return async ({ start_seconds: start, end_seconds: end, signal }) => {
    const wav = await ffmpegAudioRange({
      audioPath,
      start,
      duration: end - start,
      executable: firstValue(env.FFMPEG_PATH, "ffmpeg"),
      signal,
    });
    const result = await transcribeAudioWithRetry({
      config,
      blob: new Blob([wav], { type: "audio/wav" }),
      fileName: `agent-eval-${Math.round(start * 1_000)}-${Math.round(end * 1_000)}.wav`,
      language: "zh",
      signal,
    });
    return {
      text: result.text,
      segments: result.segments.map((segment) => ({
        start_seconds: start + (Number(segment.start_seconds) || 0),
        end_seconds: start + (Number(segment.end_seconds) || 0),
        text: segment.text,
      })),
    };
  };
}

function ffmpegAudioRange({ audioPath, start, duration, executable, signal }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, [
      "-v", "error",
      "-ss", String(start),
      "-t", String(duration),
      "-i", audioPath,
      "-vn", "-ac", "1", "-ar", "16000",
      "-f", "wav", "pipe:1",
    ], { windowsHide: true });
    const stdout = [];
    const stderr = [];
    const abort = () => child.kill();
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) {
        reject(signal.reason || new DOMException("Aborted", "AbortError"));
        return;
      }
      if (code !== 0) {
        reject(new Error(`ffmpeg audio-range extraction failed (${code}): ${Buffer.concat(stderr).toString("utf8").trim()}`));
        return;
      }
      resolvePromise(Buffer.concat(stdout));
    });
  });
}

function firstValue(...values) {
  return values.map((value) => String(value || "").trim()).find(Boolean) || "";
}

function transcriptText(segments) {
  return (segments || []).map((segment) => String(segment.text || "")).join("\n");
}

function transcriptGeometry(segments) {
  return (segments || []).map(({ start_seconds, end_seconds, speaker }) => ({ start_seconds, end_seconds, speaker }));
}

function countTerms(value, terms) {
  return terms.reduce((total, term) => total + countLiteral(value, term), 0);
}

export function countCanonicalOccurrences(value, canonical) {
  if (!canonical) return 0;
  const escaped = String(canonical).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return [...String(value).matchAll(new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, "gu"))].length;
}

export function terminologyPromptDisclosure(contextHint, terminology) {
  const context = promptDisclosureKey(contextHint);
  const canonical = String(terminology?.canonical || "");
  const aliases = Array.isArray(terminology?.aliases) ? terminology.aliases.map(String) : [];
  const disclosed = [canonical, ...aliases].filter((term) => {
    const key = promptDisclosureKey(term);
    return key && context.includes(key);
  });
  return {
    canonical_supplied: disclosed.some((term) => term.normalize("NFKC") === canonical.normalize("NFKC")),
    aliases_supplied: disclosed.some((term) => term.normalize("NFKC") !== canonical.normalize("NFKC")),
    disclosed_terms: [...new Set(disclosed)],
  };
}

function promptDisclosureKey(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase("en-US").replace(/[\s\p{P}\p{S}]+/gu, "");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function countLiteral(value, term) {
  if (!term) return 0;
  let count = 0;
  let offset = String(value).indexOf(term);
  while (offset >= 0) {
    count += 1;
    offset = String(value).indexOf(term, offset + term.length);
  }
  return count;
}

function failureReport(error) {
  return {
    schema: 1,
    ok: false,
    error: { name: error?.name || "Error", message: error?.message || String(error) },
    ...(error?.agentUsage ? { agent_usage: error.agentUsage } : {}),
  };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  runTerminologyAgentEvaluation(process.argv[2] || DEFAULT_TERMINOLOGY_SPEC)
    .then((report) => console.log(JSON.stringify(report, null, 2)))
    .catch((error) => {
      console.error(JSON.stringify(failureReport(error), null, 2));
      process.exitCode = 1;
    });
}
