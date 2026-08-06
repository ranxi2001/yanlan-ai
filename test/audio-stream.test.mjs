import test from "node:test";
import assert from "node:assert/strict";
import { mapAsyncIterableWithConcurrency, PcmChunker, StreamingPcmResampler } from "../src/audio-stream-core.js";

test("PCM chunking keeps fixed windows without retaining the full recording", () => {
  const chunker = new PcmChunker({ sampleRate: 2, chunkSeconds: 2 });
  assert.deepEqual(chunker.push(Float32Array.from([1, 2, 3]), 0), []);
  const ready = chunker.push(Float32Array.from([4, 5, 6, 7]), 1.5);
  const tail = chunker.finish();

  assert.deepEqual([...ready[0].pcm], [1, 2, 3, 4]);
  assert.equal(ready[0].startSeconds, 0);
  assert.equal(ready[0].durationSeconds, 2);
  assert.deepEqual([...tail[0].pcm], [5, 6, 7]);
  assert.equal(tail[0].startSeconds, 2);
  assert.equal(chunker.maxBufferedFrames, chunker.chunkFrames);
});

test("PCM chunking fills short timestamp jitter and preserves long discontinuities", () => {
  const shortGap = new PcmChunker({ sampleRate: 4, chunkSeconds: 1 });
  shortGap.push(Float32Array.from([1, 2]), 0);
  const shortReady = shortGap.push(Float32Array.from([3, 4]), 0.75);
  assert.deepEqual([...shortReady[0].pcm], [1, 2, 0, 3]);
  assert.deepEqual([...shortGap.finish()[0].pcm], [4]);

  const longGap = new PcmChunker({ sampleRate: 4, chunkSeconds: 1 });
  longGap.push(Float32Array.from([1, 2]), 0);
  const discontinuity = longGap.push(Float32Array.from([3, 4]), 2);
  const tail = longGap.finish();
  assert.deepEqual([...discontinuity[0].pcm], [1, 2]);
  assert.equal(discontinuity[0].startSeconds, 0);
  assert.deepEqual([...tail[0].pcm], [3, 4]);
  assert.equal(tail[0].startSeconds, 2);
});

test("PCM chunking trims overlapping decoded samples", () => {
  const chunker = new PcmChunker({ sampleRate: 4, chunkSeconds: 1 });
  chunker.push(Float32Array.from([1, 2, 3]), 0);
  const ready = chunker.push(Float32Array.from([30, 4, 5]), 0.5);
  assert.deepEqual([...ready[0].pcm], [1, 2, 3, 4]);
  assert.deepEqual([...chunker.finish()[0].pcm], [5]);
});

test("streaming PCM resampling preserves phase across decoded sample boundaries", () => {
  const resampler = new StreamingPcmResampler({ sourceRate: 6, targetRate: 3 });
  const first = resampler.push(Float32Array.from([0, 1, 0]), 0);
  const second = resampler.push(Float32Array.from([-1, 0, 1]), 0.5);
  assert.equal(first.startSeconds, 0);
  assert.equal(second.startSeconds, 2 / 3);
  assert.deepEqual([...first.pcm, ...second.pcm], [0, 0, 0]);
});

test("streaming PCM resampling restarts its time grid after a discontinuity", () => {
  const resampler = new StreamingPcmResampler({ sourceRate: 4, targetRate: 2 });
  const first = resampler.push(Float32Array.from([1, 2]), 0);
  const second = resampler.push(Float32Array.from([3, 4]), 2);
  assert.deepEqual([...first.pcm], [1]);
  assert.deepEqual([...second.pcm], [3]);
  assert.equal(second.startSeconds, 2);
});

test("async mapping applies backpressure before requesting a third PCM window", async () => {
  let produced = 0;
  let active = 0;
  let maxActive = 0;
  const releases = [];
  async function* source() {
    for (let index = 0; index < 5; index += 1) {
      produced += 1;
      yield index;
    }
  }
  const run = mapAsyncIterableWithConcurrency(source(), 2, async (value) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => releases.push(resolve));
    active -= 1;
    return value * 2;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(produced, 2);
  releases.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(produced, 3);
  while (releases.length) {
    releases.shift()();
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(await run, [0, 2, 4, 6, 8]);
  assert.equal(maxActive, 2);
});

test("async mapping closes the source after a transcription failure", async () => {
  let closed = false;
  async function* source() {
    try {
      yield 1;
      yield 2;
      yield 3;
    } finally {
      closed = true;
    }
  }

  await assert.rejects(
    mapAsyncIterableWithConcurrency(source(), 1, async (value) => {
      if (value === 2) throw new Error("ASR failed");
      return value;
    }),
    /ASR failed/,
  );
  assert.equal(closed, true);
});
