import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_CONFIG, formatTimestamp, transcribeAudio } from "./api.js";

export const CLI_VERSION = "0.4.5";
export const DEFAULT_MIMO_BASE_URL = "https://api.xiaomimimo.com/v1";

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
  -h, --help                Show this help

Environment:
  MIMO_API_KEY              Required unless --api-key is provided
  MIMO_BASE_URL             Defaults to https://api.xiaomimimo.com/v1
  MIMO_ASR_MODEL            Defaults to mimo-v2.5-asr
  MIMO_ASR_PROTOCOL         Defaults to mimo-chat
  MIMO_ASR_PATH             Defaults to chat/completions

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
    const info = await stat(inputPath).catch(() => null);
    if (!info?.isFile()) throw new CliUsageError(`Audio file not found: ${options.input}`);
    if (!info.size) throw new CliUsageError(`Audio file is empty: ${options.input}`);
    const extension = extname(inputPath).toLowerCase();
    const mimeType = AUDIO_TYPES[extension];
    if (!mimeType) throw new CliUsageError(`Unsupported audio extension: ${extension || "(none)"}`);

    const config = {
      ...DEFAULT_CONFIG,
      asrBaseUrl: firstValue(options.baseUrl, env.MIMO_BASE_URL, env.XIAOMI_BASE_URL, DEFAULT_MIMO_BASE_URL),
      asrApiKey: apiKey,
      asrModel: firstValue(options.model, env.MIMO_ASR_MODEL, DEFAULT_CONFIG.asrModel),
      asrProtocol: protocol,
      asrPath: firstValue(options.apiPath, env.MIMO_ASR_PATH, protocol === "openai-transcriptions" ? "audio/transcriptions" : DEFAULT_CONFIG.asrPath),
      transportMode: "direct",
    };
    if (!options.quiet) stderr.write(`Transcribing ${basename(inputPath)} with ${config.asrModel}...\n`);
    const bytes = await readFile(inputPath);
    const result = await transcribeAudio({
      config,
      blob: new Blob([bytes], { type: mimeType }),
      fileName: basename(inputPath),
      language: options.language,
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (!result.text?.trim()) throw new Error("MiMo ASR returned an empty transcript");
    const rendered = formatTranscription(result, options.format, {
      source: basename(inputPath), model: config.asrModel, language: options.language,
    });
    if (options.output) {
      const outputPath = resolve(options.output);
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, rendered, "utf8");
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
