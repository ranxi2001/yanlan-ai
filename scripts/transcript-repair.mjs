import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { DEFAULT_CONFIG, repairTranscript, formatTimestamp } from "../src/api.js";
import { parseTranscriptMarkdown } from "./meeting-content-eval.mjs";
import { mimoRangeTool } from "./terminology-agent-eval.mjs";
import { parseKeyBackup } from "../src/key-backup.js";

const args = process.argv.slice(2);
const get = (key) => args.includes(key) ? args[args.indexOf(key) + 1] : undefined;
try {
  if (args.includes("--help")) {
    console.log("node scripts/transcript-repair.mjs --input transcript.md|meeting.json --audio original.webm --config local-config.json --output artifacts/repair/result.json");
  } else {
    const input = get("--input"), audio = get("--audio"), output = get("--output");
    if (!input || !audio || !output) throw new Error("input_audio_output_required");
    const raw = await readFile(resolve(input), "utf8");
    const meeting = input.endsWith(".json") ? JSON.parse(raw) : parseTranscriptMarkdown(raw);
    if (get("--second-asr")) meeting.acousticAlternatives = JSON.parse(await readFile(resolve(get("--second-asr")), "utf8"));
    if (get("--aligned-asr")) meeting.alignedAsr = JSON.parse(await readFile(resolve(get("--aligned-asr")), "utf8"));
    let fileConfig = get("--config") ? JSON.parse((await readFile(resolve(get("--config")), "utf8")).replace(/^\uFEFF/u, "")) : {};
    if (fileConfig.schema === "yanlan.api-keys") {
      const keys = parseKeyBackup(fileConfig);
      fileConfig = { asrApiKey: keys.mimo, chatApiKey: keys.gpt };
    }
    const config = { ...DEFAULT_CONFIG,
      chatBaseUrl: process.env.YANLAN_LUNA_BASE_URL || process.env.OPENAI_BASE_URL || "",
      chatApiKey: process.env.YANLAN_LUNA_API_KEY || process.env.OPENAI_API_KEY || "",
      asrApiKey: process.env.MIMO_API_KEY || process.env.XIAOMI_API_KEY || "",
      ...fileConfig,
      ...(get("--chat-base-url") ? { chatBaseUrl: get("--chat-base-url") } : {}),
      ...(get("--model") ? { chatModel: get("--model") } : {}),
    };
    if (!config.chatApiKey || !config.chatBaseUrl || !config.asrApiKey) throw new Error("model_configuration_required");
    const audioBytes = await readFile(resolve(audio));
    const target = resolve(output);
    await mkdir(dirname(target), { recursive: true });
    const checkpointPath = target + ".checkpoint.json";
    const resume = args.includes("--resume") ? JSON.parse(await readFile(checkpointPath, "utf8")) : undefined;
    if (args.includes("--revisit-unresolved")) {
      if (!resume?.state.finalized || resume.state.artifact?.status !== "partial") throw new Error("partial_checkpoint_required");
      resume.state = { ...resume.state, finalized: false, artifact: null };
      resume.history.push({ role: "user", content: "继续复核上一轮未解决疑点。保留已接受补丁和原始证据，复用音频缓存。复核器现在会返回具体原因；第二套ASR的明显残字不是绝对否决。若两个结果都构成合理但不同的说法，则仍须保留疑点。对已审阅但错误提案非最小的情况，提交更精确的最小替换。不要为了增加改动数强改不确定项。" });
    }
    const audioTool = mimoRangeTool(config, resolve(audio));
    const audioHash = createHash("sha256").update(audioBytes).digest("hex");
    if (resume && (resume.audio_sha256 !== audioHash || resume.supervisor_model !== config.chatModel || resume.asr_model !== config.asrModel)) throw new Error("checkpoint_audio_or_model_changed");
    if (meeting.alignedAsr && meeting.alignedAsr.asr_run?.audio_sha256 !== audioHash) throw new Error("aligned_audio_source_mismatch");
    const cachePath = target + ".audio-cache.json";
    let cache = { audio_sha256: audioHash, model: config.asrModel, base_url: config.asrBaseUrl, ranges: {} };
    try {
      const stored = JSON.parse(await readFile(cachePath, "utf8"));
      if (stored.audio_sha256 === audioHash && stored.model === config.asrModel && stored.base_url === config.asrBaseUrl) cache = stored;
    } catch { /* No valid cache yet. */ }
    const result = await repairTranscript({ config, meeting, resume, onCheckpoint: async (checkpoint) => {
      await writeFile(checkpointPath + ".tmp", JSON.stringify({ ...checkpoint, audio_sha256: audioHash, supervisor_model: config.chatModel, asr_model: config.asrModel }));
      await rename(checkpointPath + ".tmp", checkpointPath);
      console.log(JSON.stringify({ event: "checkpoint", turns: checkpoint.usage.modelTurns, patches: checkpoint.state.patches.length, audio_reviews: checkpoint.state.audio.length }));
    }, transcribeAudioRange: async (request) => {
      const key = `${request.start_seconds}:${request.end_seconds}`;
      if (cache.ranges[key]) { console.log(JSON.stringify({ event: "audio_cache_hit", start_seconds: request.start_seconds })); return cache.ranges[key]; }
      console.log(JSON.stringify({ event: "audio_review", start_seconds: request.start_seconds, end_seconds: request.end_seconds }));
      const result = await audioTool(request);
      cache.ranges[key] = result;
      await writeFile(cachePath + ".tmp", JSON.stringify(cache));
      await rename(cachePath + ".tmp", cachePath);
      return result;
    } });
    result.input_sha256 = createHash("sha256").update(raw).digest("hex");
    result.audio_sha256 = createHash("sha256").update(audioBytes).digest("hex");
    await writeFile(target, JSON.stringify(result, null, 2) + "\n");
    const markdown = ["# 音频复核逐字稿", "", `- 状态：${result.status === "partial" ? "有待回听疑点" : "完成纠错流程（非人工金标准）"}`,
      `- 修订：${result.repairs.length} 处`, "", "## 逐字稿", "",
      ...result.segments.flatMap((segment) => [`### ${formatTimestamp(segment.start_seconds)} · ${segment.speaker}`, "", segment.text, ""]),
      "## 修订依据", "", ...result.repairs.map((patch) => `- 片段 ${patch.segment_id}：${patch.before} → ${patch.after}；音频复核 ${patch.audio_review_id}；${patch.review_reason}`),
      "", "## 待人工回听", "", ...result.unresolved.map((item) => `- 片段 ${item.segment_id}：${item.reason}`), ""].join("\n");
    await writeFile(target.replace(/\.json$/u, "") + ".md", markdown);
    console.log(JSON.stringify({ status: result.status, patches: result.repairs.length, unresolved: result.unresolved.length, usage: result.repairRun.usage, elapsed_milliseconds: result.repairRun.elapsedMilliseconds }));
  }
} catch (error) {
  if (get("--output")) {
    const target = resolve(get("--output"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target + ".failure.json", JSON.stringify({
      code: /^[a-zA-Z0-9_-]{1,80}$/u.test(String(error?.code || "")) ? error.code : "repair_failed",
      kind: error?.kind, status: error?.status,
      usage: error?.agentUsage, trace: error?.agentTrace, state: error?.agentState,
    }, null, 2));
  }
  console.error(JSON.stringify({ code: error?.code || "repair_failed", status: error?.status, kind: error?.kind }));
  console.error("Transcript repair did not complete. Original audio, timestamped transcript, Responses API and ASR credentials are required. Provider responses and secrets are not printed. Use --help for arguments.");
  process.exitCode = 1;
}
