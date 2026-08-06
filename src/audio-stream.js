export { mapAsyncIterableWithConcurrency } from "./audio-stream-core.js";

export async function createStreamingAudioDecoder(blob, options = {}) {
  if (typeof Worker !== "function") throw streamOpenError("当前浏览器不支持后台流式音频处理");
  const decoder = new WorkerAudioDecoder(blob, options);
  try {
    await decoder.ready;
    return decoder;
  } catch (error) {
    decoder.dispose();
    throw error;
  }
}

export function isStreamingAudioOpenError(error) {
  return error?.audioStreamPhase === "open";
}

class WorkerAudioDecoder {
  constructor(blob, options) {
    this.worker = new Worker(new URL("./audio-decode-worker.js", import.meta.url), { type: "module" });
    this.signal = options.signal;
    this.done = false;
    this.disposed = false;
    this.opened = false;
    this.pendingPull = null;
    this.durationSeconds = null;
    this.processedEndSeconds = 0;
    this.maxBufferedPcmBytes = 0;
    this.sourceCacheBytes = 0;
    this.sourceSampleRate = 0;
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.worker.addEventListener("message", (event) => this.#handleMessage(event.data || {}));
    this.worker.addEventListener("error", (event) => {
      this.#fail(streamWorkerError(
        event.message || "流式音频工作线程失败",
        this.opened ? "decode" : "open",
      ));
    });
    this.abortHandler = () => this.dispose(this.signal?.reason || abortError());
    this.signal?.addEventListener("abort", this.abortHandler, { once: true });
    if (this.signal?.aborted) {
      this.dispose(this.signal.reason || abortError());
      return;
    }
    this.worker.postMessage({
      type: "init",
      blob,
      chunkSeconds: options.chunkSeconds,
      startSeconds: options.startSeconds,
      endSeconds: options.endSeconds,
      maxDurationSeconds: options.maxDurationSeconds,
    });
  }

  async next() {
    await this.ready;
    if (this.done || this.disposed) return { done: true, value: undefined };
    if (this.pendingPull) throw new Error("流式音频读取不能并行调用 next() ");
    return new Promise((resolve, reject) => {
      this.pendingPull = { resolve, reject };
      this.worker.postMessage({ type: "pull" });
    });
  }

  async return() {
    this.dispose();
    return { done: true, value: undefined };
  }

  [Symbol.asyncIterator]() {
    return this;
  }

  dispose(reason = null) {
    if (this.disposed) return;
    this.disposed = true;
    this.done = true;
    this.signal?.removeEventListener("abort", this.abortHandler);
    try { this.worker.postMessage({ type: "dispose" }); } catch {}
    this.worker.terminate();
    if (reason) {
      this.rejectReady(reason);
      this.pendingPull?.reject(reason);
    }
    this.pendingPull = null;
  }

  #handleMessage(message) {
    if (this.disposed) return;
    if (message.type === "ready") {
      this.opened = true;
      this.sampleRate = message.sampleRate;
      this.sourceSampleRate = message.sourceSampleRate;
      this.durationSeconds = finiteDuration(message.durationSeconds);
      this.sourceCacheBytes = Number(message.sourceCacheBytes) || 0;
      this.resolveReady(this);
      return;
    }
    if (message.type === "chunk") {
      const pending = this.pendingPull;
      this.pendingPull = null;
      pending?.resolve({
        done: false,
        value: {
          pcm: new Float32Array(message.buffer),
          startSeconds: Number(message.startSeconds) || 0,
          durationSeconds: Number(message.durationSeconds) || 0,
        },
      });
      return;
    }
    if (message.type === "done") {
      this.done = true;
      this.durationSeconds = finiteDuration(message.durationSeconds) ?? this.durationSeconds;
      this.processedEndSeconds = Number(message.processedEndSeconds) || 0;
      this.maxBufferedPcmBytes = Number(message.maxBufferedPcmBytes) || 0;
      const pending = this.pendingPull;
      this.pendingPull = null;
      pending?.resolve({ done: true, value: undefined });
      this.dispose();
      return;
    }
    if (message.type === "error") {
      const error = new Error(message.message || "浏览器流式解码音频失败");
      error.name = message.name || "EncodingError";
      error.audioStreamPhase = message.phase || "decode";
      this.#fail(error);
    }
  }

  #fail(error) {
    this.rejectReady(error);
    this.pendingPull?.reject(error);
    this.pendingPull = null;
    this.dispose();
  }
}

function streamOpenError(message) {
  return streamWorkerError(message, "open");
}

function streamWorkerError(message, phase) {
  const error = new Error(message);
  error.name = "StreamingAudioUnsupportedError";
  error.audioStreamPhase = phase;
  return error;
}

function abortError() {
  return new DOMException("The operation was aborted", "AbortError");
}

function finiteDuration(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}
