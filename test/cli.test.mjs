import test from "node:test";
import assert from "node:assert/strict";
import { link, mkdtemp, readFile, readdir, rm, symlink, truncate, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatTranscription, parseCliArguments, runCli } from "../src/cli.js";

function outputCollector() {
  let value = "";
  return { stream: { write: (chunk) => { value += String(chunk); } }, value: () => value };
}

test("CLI parses a single transcribe input and infers output format", () => {
  const parsed = parseCliArguments(["transcribe", "meeting.mp3", "-o", "meeting.json", "--language", "zh", "--force"]);
  assert.equal(parsed.input, "meeting.mp3");
  assert.equal(parsed.format, "json");
  assert.equal(parsed.language, "zh");
  assert.equal(parsed.force, true);
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

test("CLI rejects oversized data-URL audio before reading or uploading it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yanlan-cli-large-"));
  const input = join(directory, "long-meeting.mp3");
  const output = join(directory, "long-meeting.txt");
  await writeFile(input, "audio");
  await truncate(input, 40 * 1024 * 1024 + 1);
  let requests = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { requests += 1; throw new Error("must not upload"); };
  try {
    const stderr = outputCollector();
    const code = await runCli(["transcribe", input, "-o", output], {
      env: { MIMO_API_KEY: "test-key" }, stdout: outputCollector().stream, stderr: stderr.stream,
    });
    assert.equal(code, 2);
    assert.equal(requests, 0);
    assert.match(stderr.value(), /up to 40 MiB/);
    assert.deepEqual(await readdir(directory), ["long-meeting.mp3"]);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI allows a file-backed multipart upload when the provider supports transcriptions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yanlan-cli-multipart-"));
  const input = join(directory, "long-meeting.mp3");
  await writeFile(input, "audio");
  await truncate(input, 40 * 1024 * 1024 + 1);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "https://mimo.example/v1/audio/transcriptions");
    assert.ok(options.body instanceof FormData);
    assert.equal(options.body.get("file").size, 40 * 1024 * 1024 + 1);
    return new Response(JSON.stringify({ text: "multipart transcript" }));
  };
  try {
    const stdout = outputCollector();
    const code = await runCli([
      "transcribe", input, "--protocol", "openai-transcriptions", "--base-url", "https://mimo.example/v1", "--quiet",
    ], { env: { MIMO_API_KEY: "test-key" }, stdout: stdout.stream, stderr: outputCollector().stream });
    assert.equal(code, 0);
    assert.equal(stdout.value(), "multipart transcript\n");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI refuses to overwrite its input or an existing output before upload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yanlan-cli-safety-"));
  const input = join(directory, "recording.mp3");
  const hardLink = join(directory, "same-recording.mp3");
  const output = join(directory, "recording.txt");
  await writeFile(input, "original audio bytes");
  await link(input, hardLink);
  await writeFile(output, "existing transcript");
  let requests = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { requests += 1; throw new Error("must not upload"); };
  try {
    for (const target of [input, hardLink, output]) {
      const stderr = outputCollector();
      const code = await runCli(["transcribe", input, "-o", target], {
        env: { MIMO_API_KEY: "test-key" }, stdout: outputCollector().stream, stderr: stderr.stream,
      });
      assert.equal(code, 2);
      assert.match(stderr.value(), target === output ? /already exists/ : /must not be the input/);
    }
    assert.equal(requests, 0);
    assert.equal(await readFile(input, "utf8"), "original audio bytes");
    assert.equal(await readFile(output, "utf8"), "existing transcript");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI replaces an existing output only with --force", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yanlan-cli-force-"));
  const input = join(directory, "recording.mp3");
  const output = join(directory, "recording.txt");
  await writeFile(input, "audio bytes");
  await writeFile(output, "old transcript");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: "new transcript" } }] }), {
    headers: { "content-type": "application/json" },
  });
  try {
    const code = await runCli(["transcribe", input, "-o", output, "--force", "--quiet"], {
      env: { MIMO_API_KEY: "test-key" }, stdout: outputCollector().stream, stderr: outputCollector().stream,
    });
    assert.equal(code, 0);
    assert.equal(await readFile(output, "utf8"), "new transcript\n");
    assert.equal(await readFile(input, "utf8"), "audio bytes");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI atomically replaces an output path without following a swapped symlink", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "yanlan-cli-race-"));
  const input = join(directory, "recording.mp3");
  const output = join(directory, "recording.txt");
  await writeFile(input, "audio bytes");
  await writeFile(output, "old transcript");
  const probe = join(directory, "symlink-probe.txt");
  try {
    await symlink(input, probe);
    await unlink(probe);
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
      t.skip(`symlink creation is unavailable: ${error.code}`);
      await rm(directory, { recursive: true, force: true });
      return;
    }
    throw error;
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    await unlink(output);
    await symlink(input, output);
    return new Response(JSON.stringify({ choices: [{ message: { content: "safe transcript" } }] }));
  };
  try {
    const code = await runCli(["transcribe", input, "-o", output, "--force", "--quiet"], {
      env: { MIMO_API_KEY: "test-key" }, stdout: outputCollector().stream, stderr: outputCollector().stream,
    });
    assert.equal(code, 0);
    assert.equal(await readFile(input, "utf8"), "audio bytes");
    assert.equal(await readFile(output, "utf8"), "safe transcript\n");
    assert.deepEqual((await readdir(directory)).sort(), ["recording.mp3", "recording.txt"]);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI validates the output directory before uploading", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yanlan-cli-parent-"));
  const input = join(directory, "recording.mp3");
  const invalidParent = join(directory, "not-a-directory");
  await writeFile(input, "audio bytes");
  await writeFile(invalidParent, "file");
  let requests = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { requests += 1; throw new Error("must not upload"); };
  try {
    const stderr = outputCollector();
    const code = await runCli(["transcribe", input, "-o", join(invalidParent, "result.txt")], {
      env: { MIMO_API_KEY: "test-key" }, stdout: outputCollector().stream, stderr: stderr.stream,
    });
    assert.equal(code, 2);
    assert.equal(requests, 0);
    assert.match(stderr.value(), /Cannot prepare output file/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI retries transient ASR failures within the user timeout budget", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yanlan-cli-retry-"));
  const input = join(directory, "recording.mp3");
  await writeFile(input, "audio bytes");
  const originalFetch = globalThis.fetch;
  const originalTimeout = AbortSignal.timeout;
  const timeouts = [];
  let requests = 0;
  AbortSignal.timeout = (milliseconds) => {
    timeouts.push(milliseconds);
    return originalTimeout(milliseconds);
  };
  globalThis.fetch = async () => {
    requests += 1;
    if (requests < 3) return new Response(JSON.stringify({ error: { message: "temporary" } }), { status: 503 });
    return new Response(JSON.stringify({ choices: [{ message: { content: "retry succeeded" } }] }));
  };
  try {
    const stdout = outputCollector();
    const code = await runCli(["transcribe", input, "--timeout", "300", "--quiet"], {
      env: { MIMO_API_KEY: "test-key" }, stdout: stdout.stream, stderr: outputCollector().stream, retryDelayMs: 0,
    });
    assert.equal(code, 0);
    assert.equal(stdout.value(), "retry succeeded\n");
    assert.equal(requests, 3);
    assert.equal(timeouts[0], 300000);
    assert.deepEqual(timeouts.slice(1), Array(requests).fill(120000));
  } finally {
    globalThis.fetch = originalFetch;
    AbortSignal.timeout = originalTimeout;
    await rm(directory, { recursive: true, force: true });
  }
});
