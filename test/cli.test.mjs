import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatTranscription, parseCliArguments, runCli } from "../src/cli.js";

function outputCollector() {
  let value = "";
  return { stream: { write: (chunk) => { value += String(chunk); } }, value: () => value };
}

test("CLI parses a single transcribe input and infers output format", () => {
  const parsed = parseCliArguments(["transcribe", "meeting.mp3", "-o", "meeting.json", "--language", "zh"]);
  assert.equal(parsed.input, "meeting.mp3");
  assert.equal(parsed.format, "json");
  assert.equal(parsed.language, "zh");
});

test("CLI formats plain, Markdown, and JSON transcripts", () => {
  const result = { text: "你好 OneFly", segments: [{ start_seconds: 0, end_seconds: 0, speaker: "发言人 1", text: "你好 OneFly" }] };
  const metadata = { source: "voice.wav", model: "mimo-v2.5-asr", language: "auto" };
  assert.equal(formatTranscription(result, "text", metadata), "你好 OneFly\n");
  assert.match(formatTranscription(result, "markdown", metadata), /^# voice\.wav[\s\S]*你好 OneFly/);
  assert.equal(JSON.parse(formatTranscription(result, "json", metadata)).model, "mimo-v2.5-asr");
});

test("CLI sends local audio to MiMo and writes the requested transcript", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yanlan-cli-"));
  const input = join(directory, "voice sample.mp3");
  const output = join(directory, "result.json");
  await writeFile(input, "fake mp3 bytes");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "https://api.xiaomimimo.com/v1/chat/completions");
    assert.equal(options.headers.Authorization, "Bearer test-key");
    const body = JSON.parse(options.body);
    assert.equal(body.model, "mimo-v2.5-asr");
    assert.equal(body.asr_options.language, "zh");
    assert.match(body.messages[0].content[0].input_audio.data, /^data:audio\/mpeg;base64,/);
    return new Response(JSON.stringify({ choices: [{ message: { content: "这是一段测试录音。" } }] }), {
      headers: { "content-type": "application/json" },
    });
  };
  const stdout = outputCollector();
  const stderr = outputCollector();
  try {
    const code = await runCli(["transcribe", input, "-o", output, "--format", "json", "--language", "zh"], {
      env: { MIMO_API_KEY: "test-key" }, stdout: stdout.stream, stderr: stderr.stream,
    });
    assert.equal(code, 0);
    const transcript = JSON.parse(await readFile(output, "utf8"));
    assert.equal(transcript.text, "这是一段测试录音。");
    assert.equal(transcript.source, "voice sample.mp3");
    assert.match(stderr.value(), /Saved transcript/);
    assert.equal(stdout.value(), "");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI fails before upload when the API Key is missing", async () => {
  const stdout = outputCollector();
  const stderr = outputCollector();
  const code = await runCli(["transcribe", "missing.mp3"], { env: {}, stdout: stdout.stream, stderr: stderr.stream });
  assert.equal(code, 2);
  assert.match(stderr.value(), /MIMO_API_KEY/);
  assert.equal(stdout.value(), "");
});
