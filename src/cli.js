import { openAsBlob } from "node:fs";
import { link, mkdir, open, realpath, rename, stat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_CONFIG, formatTimestamp, transcribeAudioWithRetry } from "./api.js";

export const CLI_VERSION = "0.6.1";
export const DEFAULT_MIMO_BASE_URL = "https://api.xiaomimimo.com/v1";
const DEFAULT_MIMO_ASR_PATH = "chat/completions";

const AUDIO_TYPES = Object.freeze({
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".mp4": "audio/mp4",
  ".oga": "audio/ogg",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".wav": "audio/wav",
  ".webm": "audio/webm",
});
const MAX_MIMO_CHAT_AUDIO_BYTES = 40 * 1024 * 1024;

const HELP = `Yanlan CLI ${CLI_VERSION}

Turn a local audio file into text with MiMo ASR.

Usage:
  yanlan transcribe <audio-file> [options]
  yanlan --help
  yanlan --version

Options:
  -o, --output <file>       Save the transcript instead of writing to stdout
  -f, --format <format>     text, markdown, or json (default: infer from output)
  -l, --language <lang>     auto, zh, or en (default: auto)
      --base-url <url>      MiMo-compatible API base URL
      --api-key <key>       API Key; prefer MIMO_API_KEY to avoid shell history
      --model <model>       ASR model (default: mimo-v2.5-asr)
      --protocol <name>     mimo-chat or openai-transcriptions
      --api-path <path>     Override the protocol endpoint path
      --timeout <seconds>   Request timeout (default: 300)
  -q, --quiet               Suppress progress messages
      --force               Replace an existing output file (never the input)
  -h, --help                Show this help

Environment:
  MIMO_API_KEY              Required unless --api-key is provided
  MIMO_BASE_URL             Defaults to https://api.xiaomimimo.com/v1
  MIMO_ASR_MODEL            Defaults to mimo-v2.5-asr
  MIMO_ASR_PROTOCOL         Defaults to mimo-chat
  MIMO_ASR_PATH             Defaults to chat/completions

Limits:
  The default mimo-chat data-URL protocol accepts files up to 40 MiB. Split or
  compress larger files, or use openai-transcriptions with a compatible provider.

Examples:
  yanlan transcribe interview.m4a
  yanlan transcribe meeting.mp3 -o meeting.txt
  yanlan transcribe voice.wav -o voice.md --format markdown --language zh
`;

class CliUsageError extends Error {}

export function parseCliArguments(argv) {
  const args = [...argv];
  if (!args.length || args[0] === "--help" || args[0] === "-h") return { command: "help" };
  if (args[0] === "--version") return { command: "version" };
  const command = args.shift();
  if (command !== "transcribe") throw new CliUsageError(`Unknown command: ${command}`);

  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        output: { type: "string", short: "o" },
        format: { type: "string", short: "f" },
        language: { type: "string", short: "l" },
        "base-url": { type: "string" },
        "api-key": { type: "string" },
        model: { type: "string" },
        protocol: { type: "string" },
        "api-path": { type: "string" },
        timeout: { type: "string" },
        quiet: { type: "boolean", short: "q" },
        force: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    throw new CliUsageError(error.message);
  }

  if (parsed.values.help) return { command: "help" };
  if (parsed.positionals.length !== 1) throw new CliUsageError("transcribe requires exactly one audio file");

  const language = String(parsed.values.language || "auto").toLowerCase();
  if (!["auto", "zh", "en"].includes(language)) throw new CliUsageError("--language must be auto, zh, or en");
  const protocol = String(parsed.values.protocol || "").toLowerCase();
  if (protocol && !["mimo-chat", "openai-transcriptions"].includes(protocol)) {
    throw new CliUsageError("--protocol must be mimo-chat or openai-transcriptions");
  }
  const timeoutSeconds = parsed.values.timeout == null ? 300 : Number(parsed.values.timeout);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) throw new CliUsageError("--timeout must be a positive number");

  return {
    command,
    input: parsed.positionals[0],
    output: parsed.values.output || "",
    format: normalizeFormat(parsed.values.format, parsed.values.output),
    language,
    baseUrl: parsed.values["base-url"] || "",
    apiKey: parsed.values["api-key"] || "",
    model: parsed.values.model || "",
    protocol,
    apiPath: parsed.values["api-path"] || "",
    timeoutMs: Math.round(timeoutSeconds * 1000),
    quiet: Boolean(parsed.values.quiet),
    force: Boolean(parsed.values.force),
  };
}

export function formatTranscription(result, format, metadata) {
  const text = String(result?.text || "").trim();
  const segments = Array.isArray(result?.segments) ? result.segments : [];
  if (format === "json") {
    return `${JSON.stringify({
      schema: 1,
      source: metadata.source,
      model: metadata.model,
      language: metadata.language,
      text,
      segments: segments.map(({ start_seconds, end_seconds, speaker, text: segmentText }) => ({
        start_seconds, end_seconds, speaker, text: segmentText,
      })),
    }, null, 2)}\n`;
  }
  if (format === "markdown") {
    const heading = `# ${metadata.source}\n\n`;
    const details = `> MiMo ASR · ${metadata.model} · language=${metadata.language}\n\n`;
    if (segments.length > 1 || segments.some((segment) => Number(segment.start_seconds) > 0)) {
      const transcript = segments.map((segment) => (
        `### ${formatTimestamp(segment.start_seconds)} · ${segment.speaker || "发言人"}\n\n${String(segment.text || "").trim()}`
      )).join("\n\n");
      return `${heading}${details}${transcript}\n`;
    }
    return `${heading}${details}${text}\n`;
  }
  return `${text}\n`;
}

export async function runCli(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const env = io.env || process.env;
  let outputPlan = null;
  try {
    const options = parseCliArguments(argv);
    if (options.command === "help") {
      stdout.write(HELP);
      return 0;
    }
    if (options.command === "version") {
      stdout.write(`${CLI_VERSION}\n`);
      return 0;
    }

    const apiKey = firstValue(options.apiKey, env.MIMO_API_KEY, env.XIAOMI_API_KEY, env.YANLAN_ASR_API_KEY);
    if (!apiKey) throw new CliUsageError("Missing API Key. Set MIMO_API_KEY or pass --api-key.");
    const protocol = firstValue(options.protocol, env.MIMO_ASR_PROTOCOL, DEFAULT_CONFIG.asrProtocol);
    if (!["mimo-chat", "openai-transcriptions"].includes(protocol)) {
      throw new CliUsageError("MIMO_ASR_PROTOCOL must be mimo-chat or openai-transcriptions");
    }
    const inputPath = resolve(options.input);
    const info = await optionalStat(inputPath);
    if (!info?.isFile()) throw new CliUsageError(`Audio file not found: ${options.input}`);
    if (!info.size) throw new CliUsageError(`Audio file is empty: ${options.input}`);
    const extension = extname(inputPath).toLowerCase();
    const mimeType = AUDIO_TYPES[extension];
    if (!mimeType) throw new CliUsageError(`Unsupported audio extension: ${extension || "(none)"}`);
    if (protocol === "mimo-chat" && info.size > MAX_MIMO_CHAT_AUDIO_BYTES) {
      throw new CliUsageError("The default mimo-chat protocol accepts audio files up to 40 MiB. Split or compress the file, or use --protocol openai-transcriptions with a compatible provider.");
    }
    const outputPath = options.output ? resolve(options.output) : "";
    if (outputPath) outputPlan = await prepareOutput(inputPath, info, outputPath, options.force);

    const config = {
      ...DEFAULT_CONFIG,
      asrBaseUrl: firstValue(options.baseUrl, env.MIMO_BASE_URL, env.XIAOMI_BASE_URL, DEFAULT_MIMO_BASE_URL),
      asrApiKey: apiKey,
      asrModel: firstValue(options.model, env.MIMO_ASR_MODEL, DEFAULT_CONFIG.asrModel),
      asrProtocol: protocol,
      asrPath: firstValue(options.apiPath, env.MIMO_ASR_PATH, protocol === "openai-transcriptions" ? "audio/transcriptions" : DEFAULT_MIMO_ASR_PATH),
      transportMode: "direct",
    };
    if (!options.quiet) stderr.write(`Transcribing ${basename(inputPath)} with ${config.asrModel}...\n`);
    const audioBlob = await openAsBlob(inputPath, { type: mimeType });
    const result = await transcribeAudioWithRetry({
      config,
      blob: audioBlob,
      fileName: basename(inputPath),
      language: options.language,
      signal: AbortSignal.timeout(options.timeoutMs),
    }, { baseDelayMs: io.retryDelayMs ?? 500 });
    if (!result.text?.trim()) throw new Error("MiMo ASR returned an empty transcript");
    const rendered = formatTranscription(result, options.format, {
      source: basename(inputPath), model: config.asrModel, language: options.language,
    });
    if (options.output) {
      await outputPlan.handle.writeFile(rendered, "utf8");
      await outputPlan.handle.sync();
      await outputPlan.handle.close();
      outputPlan.handle = null;
      if (options.force) await rename(outputPlan.temporaryPath, outputPath);
      else await link(outputPlan.temporaryPath, outputPath).catch((error) => {
        if (error?.code === "EEXIST") throw new CliUsageError(`Output file already exists: ${options.output}. Pass --force to replace it.`);
        throw error;
      });
      await unlink(outputPlan.temporaryPath).catch((error) => { if (error?.code !== "ENOENT") throw error; });
      outputPlan = null;
      if (!options.quiet) stderr.write(`Saved transcript to ${outputPath}\n`);
    } else {
      stdout.write(rendered);
    }
    return 0;
  } catch (error) {
    const usage = error instanceof CliUsageError;
    const message = error?.name === "TimeoutError" ? "The transcription request timed out" : String(error?.message || error);
    stderr.write(`yanlan: ${message}\n`);
    if (usage) stderr.write("Run 'yanlan --help' for usage.\n");
    return usage ? 2 : 1;
  } finally {
    await outputPlan?.handle?.close().catch(() => {});
    if (outputPlan?.temporaryPath) await unlink(outputPlan.temporaryPath).catch(() => {});
  }
}

function normalizeFormat(value, output) {
  const requested = String(value || "").toLowerCase();
  const inferred = requested || ({ ".json": "json", ".md": "markdown", ".markdown": "markdown" }[extname(output || "").toLowerCase()] || "text");
  const format = ({ txt: "text", md: "markdown" })[inferred] || inferred;
  if (!["text", "markdown", "json"].includes(format)) throw new CliUsageError("--format must be text, markdown, or json");
  return format;
}

function firstValue(...values) {
  return values.map((value) => String(value || "").trim()).find(Boolean) || "";
}

async function validateOutputPath(inputPath, inputInfo, outputPath, force) {
  if (inputPath === outputPath) throw new CliUsageError("Output file must not be the input audio file");
  const outputInfo = await optionalStat(outputPath);
  if (!outputInfo) return;
  if (!outputInfo.isFile()) throw new CliUsageError(`Output path is not a file: ${outputPath}`);
  const [realInput, realOutput] = await Promise.all([realpath(inputPath), realpath(outputPath)]);
  if (realInput === realOutput || (inputInfo.dev === outputInfo.dev && inputInfo.ino === outputInfo.ino)) {
    throw new CliUsageError("Output file must not be the input audio file");
  }
  if (!force) throw new CliUsageError(`Output file already exists: ${outputPath}. Pass --force to replace it.`);
}

async function prepareOutput(inputPath, inputInfo, outputPath, force) {
  try {
    await mkdir(dirname(outputPath), { recursive: true });
    await validateOutputPath(inputPath, inputInfo, outputPath, force);
    const temporaryPath = join(dirname(outputPath), `.${basename(outputPath)}.yanlan-${randomUUID()}.tmp`);
    const handle = await open(temporaryPath, "wx", 0o600);
    return { temporaryPath, handle };
  } catch (error) {
    if (error instanceof CliUsageError) throw error;
    throw new CliUsageError(`Cannot prepare output file ${outputPath}: ${error.message}`);
  }
}

async function optionalStat(path) {
  try {
    return await stat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new CliUsageError(`Cannot access ${path}: ${error.message}`);
  }
}
