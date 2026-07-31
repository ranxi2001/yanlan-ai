export const KEY_BACKUP_SCHEMA = "yanlan.api-keys";
export const KEY_BACKUP_VERSION = 1;

const MAX_KEY_LENGTH = 8_192;

export function createKeyBackup({ mimo = "", gpt = "" }, exportedAt = new Date().toISOString()) {
  return {
    schema: KEY_BACKUP_SCHEMA,
    version: KEY_BACKUP_VERSION,
    exportedAt,
    keys: {
      mimo: normalizeKey(mimo),
      gpt: normalizeKey(gpt),
    },
  };
}

export function parseKeyBackup(value) {
  let backup;
  try { backup = typeof value === "string" ? JSON.parse(value) : value; }
  catch { throw new Error("JSON 文件格式不正确"); }
  if (!backup || typeof backup !== "object" || backup.schema !== KEY_BACKUP_SCHEMA || backup.version !== KEY_BACKUP_VERSION) {
    throw new Error("这不是受支持的言澜 Key 备份文件");
  }
  if (!backup.keys || typeof backup.keys !== "object") throw new Error("备份文件缺少 Key");
  const mimo = normalizeImportedKey(backup.keys.mimo, "MiMo");
  const gpt = normalizeImportedKey(backup.keys.gpt, "GPT");
  if (!mimo && !gpt) throw new Error("备份文件中没有可导入的 Key");
  return { mimo, gpt };
}

function normalizeImportedKey(value, label) {
  if (typeof value !== "string") throw new Error(`${label} Key 格式不正确`);
  if (value.length > MAX_KEY_LENGTH) throw new Error(`${label} Key 长度异常`);
  return normalizeKey(value);
}

function normalizeKey(value) {
  return String(value || "").trim();
}
