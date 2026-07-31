export const MAX_MIMO_UPLOAD_SECONDS = 30 * 60;
export const MAX_MIMO_UPLOAD_BYTES = 128 * 1024 * 1024;
export const MAX_MIMO_FALLBACK_BYTES = 40 * 1024 * 1024;

export function mimoUploadLimitMessage({ protocol, size, duration }) {
  if (protocol === "openai-transcriptions") return "";
  if (Number(duration) > MAX_MIMO_UPLOAD_SECONDS) {
    return "默认 MiMo 上传路径最多处理 30 分钟音频；请切分文件、使用实时录音，或改用标准 Transcriptions 协议";
  }
  if (Number(size) > MAX_MIMO_UPLOAD_BYTES) {
    return "默认 MiMo 上传路径最多读取 128 MiB 音频；请压缩或切分文件，或改用标准 Transcriptions 协议";
  }
  return "";
}
