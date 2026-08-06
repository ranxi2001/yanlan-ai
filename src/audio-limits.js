export const MAX_MIMO_UPLOAD_SECONDS = 4 * 60 * 60;
export const MAX_MIMO_UPLOAD_BYTES = 512 * 1024 * 1024;
export const MAX_MIMO_FALLBACK_SECONDS = 30 * 60;
export const MAX_MIMO_FALLBACK_BYTES = 40 * 1024 * 1024;

export function audioDurationOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

export function storedAudioDuration(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function mimoUploadLimitMessage({ protocol, size, duration }) {
  if (protocol === "openai-transcriptions") return "";
  const knownDuration = audioDurationOrNull(duration);
  if (knownDuration !== null && knownDuration > MAX_MIMO_UPLOAD_SECONDS) {
    return "MiMo 流式转写最多处理 4 小时音频；请切分文件或改用标准 Transcriptions 协议";
  }
  if (Number(size) > MAX_MIMO_UPLOAD_BYTES) {
    return "MiMo 流式转写最多读取 512 MiB 音频；请压缩或切分文件，或改用标准 Transcriptions 协议";
  }
  return "";
}

export function canUseMimoWholeFileFallback({ size, duration }) {
  const knownDuration = audioDurationOrNull(duration);
  return Number(size) <= MAX_MIMO_FALLBACK_BYTES
    && knownDuration !== null
    && knownDuration <= MAX_MIMO_FALLBACK_SECONDS;
}
