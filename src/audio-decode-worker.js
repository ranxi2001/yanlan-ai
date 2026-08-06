import {
  ADTS,
  AudioSampleSink,
  BlobSource,
  FLAC,
  Input,
  MATROSKA,
  MP3,
  MP4,
  OGG,
  QTFF,
  WAVE,
  WEBM,
} from "mediabunny";
import { PcmChunker, StreamingPcmResampler } from "./audio-stream-core.js";

const SOURCE_CACHE_BYTES = 4 * 1024 * 1024;
const OUTPUT_SAMPLE_RATE = 16_000;
const INPUT_FORMATS = [WEBM, MATROSKA, MP4, QTFF, MP3, ADTS, FLAC, OGG, WAVE];

let input = null;
let sampleIterator = null;
let chunker = null;
let resampler = null;
let pendingChunks = [];
let firstTimestamp = 0;
let sourceSampleRate = 0;
let rangeStartSeconds = 0;
let rangeEndSeconds = Number.POSITIVE_INFINITY;
let metadataDurationSeconds = null;
let decodedEndSeconds = 0;
let maxDurationSeconds = Number.POSITIVE_INFINITY;
let streamEnded = false;
let disposed = false;
let commandQueue = Promise.resolve();

self.addEventListener("message", (event) => {
  const message = event.data || {};
  if (message.type === "dispose") {
    dispose();
    return;
  }
  if (message.type === "init") commandQueue = commandQueue.then(() => initialize(message)).catch((error) => fail(error, "open"));
  if (message.type === "pull") commandQueue = commandQueue.then(produceNextChunk).catch((error) => fail(error, "decode"));
});

async function initialize(message) {
  if (!(message.blob instanceof Blob)) throw new TypeError("Audio source must be a Blob");
  rangeStartSeconds = Math.max(0, finiteNumber(message.startSeconds, 0));
  rangeEndSeconds = finiteNumber(message.endSeconds, Number.POSITIVE_INFINITY);
  maxDurationSeconds = finiteNumber(message.maxDurationSeconds, Number.POSITIVE_INFINITY);
  if (!(rangeEndSeconds > rangeStartSeconds)) throw new RangeError("Audio range end must be greater than its start");

  input = new Input({
    source: new BlobSource(message.blob, { maxCacheSize: SOURCE_CACHE_BYTES }),
    formats: INPUT_FORMATS,
  });
  const track = await input.getPrimaryAudioTrack();
  if (!track) throw streamError("音频文件中没有可解码的音轨");
  if (!await track.canDecode()) throw streamError("当前浏览器不支持这段音频使用的编解码器");

  sourceSampleRate = await track.getSampleRate();
  firstTimestamp = await input.getFirstTimestamp([track]);
  const metadataEnd = await input.getDurationFromMetadata([track]);
  metadataDurationSeconds = finiteDuration(metadataEnd === null ? null : metadataEnd - firstTimestamp);
  if (metadataDurationSeconds !== null && metadataDurationSeconds > maxDurationSeconds) {
    throw audioLimitError(maxDurationSeconds);
  }

  chunker = new PcmChunker({
    sampleRate: OUTPUT_SAMPLE_RATE,
    chunkSeconds: message.chunkSeconds,
    startSeconds: rangeStartSeconds,
  });
  resampler = new StreamingPcmResampler({ sourceRate: sourceSampleRate, targetRate: OUTPUT_SAMPLE_RATE });
  const sink = new AudioSampleSink(track);
  const absoluteEnd = Number.isFinite(rangeEndSeconds) ? firstTimestamp + rangeEndSeconds : undefined;
  sampleIterator = sink.samples(firstTimestamp + rangeStartSeconds, absoluteEnd)[Symbol.asyncIterator]();
  self.postMessage({
    type: "ready",
    sampleRate: OUTPUT_SAMPLE_RATE,
    sourceSampleRate,
    durationSeconds: metadataDurationSeconds,
    sourceCacheBytes: SOURCE_CACHE_BYTES,
  });
}

async function produceNextChunk() {
  if (disposed) return;
  while (!pendingChunks.length && !streamEnded) {
    const next = await sampleIterator.next();
    if (next.done) {
      pendingChunks.push(...chunker.finish());
      streamEnded = true;
      break;
    }
    const sample = next.value;
    try {
      appendSample(sample);
    } finally {
      sample.close();
    }
  }

  if (pendingChunks.length) {
    const chunk = pendingChunks.shift();
    if (chunk.startSeconds + chunk.durationSeconds > maxDurationSeconds + 1 / sourceSampleRate) {
      throw audioLimitError(maxDurationSeconds);
    }
    self.postMessage({
      type: "chunk",
      startSeconds: chunk.startSeconds,
      durationSeconds: chunk.durationSeconds,
      buffer: chunk.pcm.buffer,
    }, [chunk.pcm.buffer]);
    return;
  }

  const durationSeconds = metadataDurationSeconds ?? decodedEndSeconds;
  input?.dispose();
  input = null;
  self.postMessage({
    type: "done",
    durationSeconds,
    processedEndSeconds: decodedEndSeconds,
    maxBufferedPcmBytes: chunker.maxBufferedFrames * Float32Array.BYTES_PER_ELEMENT,
  });
}

function appendSample(sample) {
  if (sample.sampleRate !== sourceSampleRate) throw new Error("音频采样率在文件中发生变化，无法安全分段");
  const relativeStart = sample.timestamp - firstTimestamp;
  const relativeEnd = relativeStart + sample.duration;
  if (relativeEnd <= rangeStartSeconds || relativeStart >= rangeEndSeconds) return;
  if (relativeEnd > maxDurationSeconds + 1 / sourceSampleRate) throw audioLimitError(maxDurationSeconds);

  const boundedStart = Math.max(rangeStartSeconds, relativeStart);
  const boundedEnd = Math.min(rangeEndSeconds, relativeEnd);
  const frameOffset = Math.max(0, Math.min(sample.numberOfFrames, Math.ceil((boundedStart - relativeStart) * sourceSampleRate - 1e-7)));
  const frameEnd = Math.max(frameOffset, Math.min(sample.numberOfFrames, Math.ceil((boundedEnd - relativeStart) * sourceSampleRate - 1e-7)));
  const frameCount = frameEnd - frameOffset;
  if (!frameCount) return;

  const interleaved = new Float32Array(frameCount * sample.numberOfChannels);
  sample.copyTo(interleaved, { planeIndex: 0, format: "f32", frameOffset, frameCount });
  const mono = sample.numberOfChannels === 1 ? interleaved : downmix(interleaved, sample.numberOfChannels);
  const actualStart = relativeStart + frameOffset / sourceSampleRate;
  const resampled = resampler.push(mono, actualStart);
  if (resampled) pendingChunks.push(...chunker.push(resampled.pcm, resampled.startSeconds));
  decodedEndSeconds = Math.max(decodedEndSeconds, actualStart + frameCount / sourceSampleRate);
}

function downmix(interleaved, channels) {
  const mono = new Float32Array(interleaved.length / channels);
  for (let frame = 0; frame < mono.length; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) sum += interleaved[frame * channels + channel];
    mono[frame] = sum / channels;
  }
  return mono;
}

function fail(error, phase) {
  if (disposed) return;
  const payload = {
    type: "error",
    phase,
    name: error?.name || "Error",
    message: error?.message || String(error),
  };
  dispose();
  self.postMessage(payload);
}

function dispose() {
  if (disposed) return;
  disposed = true;
  input?.dispose();
  input = null;
  sampleIterator = null;
  resampler = null;
  pendingChunks = [];
}

function streamError(message) {
  const error = new Error(message);
  error.name = "StreamingAudioUnsupportedError";
  return error;
}

function audioLimitError(seconds) {
  const error = new Error(`流式音频最多处理 ${Math.round(seconds / 3600)} 小时`);
  error.name = "AudioLimitError";
  return error;
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function finiteDuration(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}
