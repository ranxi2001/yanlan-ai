import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const audioPath = process.env.YANLAN_LONG_AUDIO;
if (!audioPath) throw new Error("Set YANLAN_LONG_AUDIO to a local recording path");
const minimumDurationSeconds = Math.max(1, Number(process.env.YANLAN_LONG_AUDIO_MIN_SECONDS) || 60 * 60);
const source = await stat(audioPath);
const developmentServer = await createServer({
  root: fileURLToPath(new URL("..", import.meta.url)),
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false },
});
await developmentServer.listen();
const baseUrl = developmentServer.resolvedUrls.local[0].replace(/\/$/, "");
const browser = await chromium.launch({ headless: true, args: ["--enable-precise-memory-info"] });
const browserSession = await browser.newBrowserCDPSession();
const page = await browser.newPage();
page.setDefaultTimeout(15 * 60_000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });

try {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.id = "longAudioFixture";
    document.body.append(input);
  });
  await page.locator("#longAudioFixture").setInputFiles(audioPath);
  const baselineHeapBytes = await page.evaluate(() => performance.memory?.usedJSHeapSize || 0);
  const baselineProcessMemory = await chromiumProcessMemory(browserSession);
  let settled = false;
  const startedAt = performance.now();
  const decode = page.evaluate(async ({ moduleUrl }) => {
    const file = document.querySelector("#longAudioFixture").files[0];
    const { createStreamingAudioDecoder } = await import(moduleUrl);
    const decoder = await createStreamingAudioDecoder(file, {
      chunkSeconds: 30,
      maxDurationSeconds: 4 * 60 * 60,
    });
    let chunkCount = 0;
    let decodedSeconds = 0;
    let maxChunkBytes = 0;
    for await (const chunk of decoder) {
      chunkCount += 1;
      decodedSeconds = Math.max(decodedSeconds, chunk.startSeconds + chunk.durationSeconds);
      maxChunkBytes = Math.max(maxChunkBytes, chunk.pcm.byteLength);
    }
    return {
      fileSize: file.size,
      chunkCount,
      decodedSeconds,
      durationSeconds: decoder.durationSeconds,
      sampleRate: decoder.sampleRate,
      sourceSampleRate: decoder.sourceSampleRate,
      maxChunkBytes,
      maxBufferedPcmBytes: decoder.maxBufferedPcmBytes,
      sourceCacheBytes: decoder.sourceCacheBytes,
    };
  }, { moduleUrl: `${baseUrl}/src/audio-stream.js` });
  void decode.then(() => { settled = true; }, () => { settled = true; });
  let maxHeapBytes = baselineHeapBytes;
  let maxRendererPssBytes = baselineProcessMemory?.rendererPssBytes || 0;
  let maxChromiumPssBytes = baselineProcessMemory?.totalPssBytes || 0;
  while (!settled) {
    const [heapBytes, processMemory] = await Promise.all([
      page.evaluate(() => performance.memory?.usedJSHeapSize || 0),
      chromiumProcessMemory(browserSession),
    ]);
    maxHeapBytes = Math.max(maxHeapBytes, heapBytes);
    maxRendererPssBytes = Math.max(maxRendererPssBytes, processMemory?.rendererPssBytes || 0);
    maxChromiumPssBytes = Math.max(maxChromiumPssBytes, processMemory?.totalPssBytes || 0);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const result = await decode;
  const elapsedSeconds = (performance.now() - startedAt) / 1_000;
  const rendererPssGrowthBytes = baselineProcessMemory ? maxRendererPssBytes - baselineProcessMemory.rendererPssBytes : null;
  const chromiumPssGrowthBytes = baselineProcessMemory ? maxChromiumPssBytes - baselineProcessMemory.totalPssBytes : null;
  process.stdout.write(`${JSON.stringify({
    fileSize: result.fileSize,
    durationSeconds: result.durationSeconds,
    decodedSeconds: result.decodedSeconds,
    chunkCount: result.chunkCount,
    sampleRate: result.sampleRate,
    sourceSampleRate: result.sourceSampleRate,
    maxChunkBytes: result.maxChunkBytes,
    maxBufferedPcmBytes: result.maxBufferedPcmBytes,
    mainHeapGrowthBytes: maxHeapBytes - baselineHeapBytes,
    rendererPssGrowthBytes,
    chromiumPssGrowthBytes,
    elapsedSeconds: Number(elapsedSeconds.toFixed(2)),
  })}\n`);

  assert.equal(result.fileSize, source.size);
  assert.ok(result.decodedSeconds >= minimumDurationSeconds, `decoded only ${result.decodedSeconds} seconds`);
  assert.ok(result.chunkCount >= Math.floor(minimumDurationSeconds / 30));
  assert.ok(result.maxChunkBytes <= Math.ceil(30 * result.sampleRate) * Float32Array.BYTES_PER_ELEMENT);
  assert.ok(result.maxBufferedPcmBytes <= Math.ceil(30 * result.sampleRate) * Float32Array.BYTES_PER_ELEMENT);
  assert.equal(result.sourceCacheBytes, 4 * 1024 * 1024);
  assert.ok(maxHeapBytes - baselineHeapBytes < 96 * 1024 * 1024, `main-thread heap grew by ${maxHeapBytes - baselineHeapBytes} bytes`);
  if (process.platform === "linux") {
    assert.ok(baselineProcessMemory?.processCount > 0, "could not sample Chromium process memory");
    assert.ok(rendererPssGrowthBytes < 192 * 1024 * 1024, `renderer/worker PSS grew by ${rendererPssGrowthBytes} bytes`);
    assert.ok(chromiumPssGrowthBytes < 256 * 1024 * 1024, `total Chromium PSS grew by ${chromiumPssGrowthBytes} bytes`);
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await developmentServer.close();
}

async function chromiumProcessMemory(session) {
  if (process.platform !== "linux") return null;
  let processInfo;
  try {
    ({ processInfo } = await session.send("SystemInfo.getProcessInfo"));
  } catch {
    return null;
  }
  const samples = await Promise.all(processInfo.map(async (item) => {
    const pid = Number(item.id);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const rollup = await readFile(`/proc/${pid}/smaps_rollup`, "utf8").catch(() => "");
    const pssKiB = Number(/^Pss:\s+(\d+)\s+kB$/m.exec(rollup)?.[1]);
    if (!Number.isFinite(pssKiB) || pssKiB <= 0) return null;
    return { type: item.type, pssBytes: pssKiB * 1024 };
  }));
  const available = samples.filter(Boolean);
  if (!available.length) return null;
  return {
    processCount: available.length,
    rendererPssBytes: available.filter((item) => item.type === "renderer").reduce((sum, item) => sum + item.pssBytes, 0),
    totalPssBytes: available.reduce((sum, item) => sum + item.pssBytes, 0),
  };
}
