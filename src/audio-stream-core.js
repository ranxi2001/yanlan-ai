export class PcmChunker {
  constructor({ sampleRate, chunkSeconds, startSeconds = 0, maxGapSeconds = 0.25 }) {
    this.sampleRate = positiveNumber(sampleRate, "sampleRate");
    this.chunkFrames = Math.max(1, Math.round(positiveNumber(chunkSeconds, "chunkSeconds") * this.sampleRate));
    this.maxGapFrames = Math.max(0, Math.round(Number(maxGapSeconds) * this.sampleRate));
    this.bufferStartFrame = Math.max(0, Math.round(Number(startSeconds) * this.sampleRate));
    this.nextFrame = this.bufferStartFrame;
    this.buffers = [];
    this.headOffset = 0;
    this.bufferedFrames = 0;
    this.maxBufferedFrames = 0;
  }

  push(pcm, startSeconds) {
    if (!(pcm instanceof Float32Array)) throw new TypeError("pcm must be a Float32Array");
    let startFrame = Math.max(0, Math.round(Number(startSeconds) * this.sampleRate));
    let inputOffset = 0;
    const chunks = [];

    if (startFrame > this.nextFrame) {
      const gapFrames = startFrame - this.nextFrame;
      if (gapFrames <= this.maxGapFrames) {
        this.#appendSilence(gapFrames, chunks);
      } else {
        this.#flushPartial(chunks);
        this.bufferStartFrame = startFrame;
        this.nextFrame = startFrame;
      }
    } else if (startFrame < this.nextFrame) {
      inputOffset = Math.min(pcm.length, this.nextFrame - startFrame);
      startFrame += inputOffset;
    }

    if (inputOffset < pcm.length) this.#appendFrames(pcm.subarray(inputOffset), chunks);
    return chunks;
  }

  finish() {
    const chunks = [];
    this.#flushPartial(chunks);
    return chunks;
  }

  #appendSilence(frameCount, chunks) {
    let remaining = frameCount;
    while (remaining > 0) {
      const count = Math.min(remaining, this.chunkFrames - this.bufferedFrames);
      this.#appendFrames(new Float32Array(count), chunks);
      remaining -= count;
    }
  }

  #appendFrames(input, chunks) {
    let offset = 0;
    while (offset < input.length) {
      const count = Math.min(input.length - offset, this.chunkFrames - this.bufferedFrames);
      this.buffers.push(input.subarray(offset, offset + count));
      this.bufferedFrames += count;
      this.nextFrame += count;
      this.maxBufferedFrames = Math.max(this.maxBufferedFrames, this.bufferedFrames);
      offset += count;
      if (this.bufferedFrames === this.chunkFrames) chunks.push(this.#take(this.chunkFrames));
    }
  }

  #flushPartial(chunks) {
    if (this.bufferedFrames) chunks.push(this.#take(this.bufferedFrames));
  }

  #take(frameCount) {
    const pcm = new Float32Array(frameCount);
    let outputOffset = 0;
    while (outputOffset < frameCount) {
      const head = this.buffers[0];
      const available = head.length - this.headOffset;
      const count = Math.min(available, frameCount - outputOffset);
      pcm.set(head.subarray(this.headOffset, this.headOffset + count), outputOffset);
      outputOffset += count;
      this.headOffset += count;
      this.bufferedFrames -= count;
      if (this.headOffset === head.length) {
        this.buffers.shift();
        this.headOffset = 0;
      }
    }
    const startFrame = this.bufferStartFrame;
    this.bufferStartFrame += frameCount;
    return {
      pcm,
      startSeconds: startFrame / this.sampleRate,
      durationSeconds: frameCount / this.sampleRate,
    };
  }
}

export class StreamingPcmResampler {
  constructor({ sourceRate, targetRate }) {
    this.sourceRate = positiveNumber(sourceRate, "sourceRate");
    this.targetRate = positiveNumber(targetRate, "targetRate");
    this.nextOutputFrame = null;
    this.previousSample = 0;
    this.previousSampleTime = null;
  }

  push(pcm, startSeconds) {
    if (!(pcm instanceof Float32Array)) throw new TypeError("pcm must be a Float32Array");
    if (!pcm.length) return null;
    const inputStart = Math.max(0, Number(startSeconds));
    if (!Number.isFinite(inputStart)) throw new RangeError("startSeconds must be finite");
    const expectedStart = this.previousSampleTime === null
      ? null
      : this.previousSampleTime + 1 / this.sourceRate;
    const continuous = expectedStart !== null
      && Math.abs(inputStart - expectedStart) <= 0.5 / this.sourceRate;
    const hasPrefix = continuous;
    const dataStart = hasPrefix ? this.previousSampleTime : inputStart;
    const dataLength = pcm.length + (hasPrefix ? 1 : 0);
    const dataEnd = dataStart + (dataLength - 1) / this.sourceRate;

    if (this.nextOutputFrame === null || this.nextOutputFrame / this.targetRate < dataStart - 0.5 / this.targetRate) {
      this.nextOutputFrame = Math.max(0, Math.ceil(dataStart * this.targetRate - 1e-7));
    }
    const firstOutputFrame = this.nextOutputFrame;
    const outputFrames = Math.max(0, Math.floor(dataEnd * this.targetRate + 1e-7) - firstOutputFrame + 1);
    const output = new Float32Array(outputFrames);
    const sampleAt = (index) => {
      if (hasPrefix && index === 0) return this.previousSample;
      return pcm[index - (hasPrefix ? 1 : 0)];
    };

    for (let index = 0; index < outputFrames; index += 1) {
      const outputTime = (firstOutputFrame + index) / this.targetRate;
      const position = Math.max(0, Math.min(dataLength - 1, (outputTime - dataStart) * this.sourceRate));
      const left = Math.floor(position);
      const right = Math.min(dataLength - 1, left + 1);
      const weight = position - left;
      output[index] = sampleAt(left) * (1 - weight) + sampleAt(right) * weight;
    }

    this.nextOutputFrame += outputFrames;
    this.previousSample = pcm[pcm.length - 1];
    this.previousSampleTime = inputStart + (pcm.length - 1) / this.sourceRate;
    return outputFrames ? {
      pcm: output,
      startSeconds: firstOutputFrame / this.targetRate,
    } : null;
  }
}

export async function mapAsyncIterableWithConcurrency(iterable, concurrency, mapper) {
  const limit = Math.max(1, Number(concurrency) || 1);
  const results = [];
  const active = new Set();
  const iterator = iterable[Symbol.asyncIterator]();
  let index = 0;
  let firstError = null;
  let iterationDone = false;

  try {
    while (!iterationDone) {
      while (active.size >= limit) {
        await Promise.race(active);
        if (firstError) throw firstError;
      }
      if (firstError) throw firstError;
      const next = await iterator.next();
      iterationDone = Boolean(next.done);
      if (iterationDone) break;
      if (firstError) throw firstError;
      const resultIndex = index;
      index += 1;
      let task;
      task = Promise.resolve()
        .then(() => mapper(next.value, resultIndex))
        .then((result) => { results[resultIndex] = result; })
        .catch((error) => { firstError ||= error; })
        .finally(() => active.delete(task));
      active.add(task);
    }

    await Promise.all(active);
    if (firstError) throw firstError;
    return results;
  } finally {
    if (!iterationDone && typeof iterator.return === "function") await iterator.return();
    await Promise.all(active);
  }
}

function positiveNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new RangeError(`${name} must be greater than zero`);
  return number;
}
