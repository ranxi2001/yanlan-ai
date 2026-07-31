import test from "node:test";
import assert from "node:assert/strict";
import { createKeyBackup, parseKeyBackup } from "../src/key-backup.js";

test("key backups round-trip only MiMo and GPT credentials", () => {
  const backup = createKeyBackup({ mimo: " sk-mimo ", gpt: " gpt-secret " }, "2026-07-31T12:00:00.000Z");
  assert.deepEqual(backup, {
    schema: "yanlan.api-keys",
    version: 1,
    exportedAt: "2026-07-31T12:00:00.000Z",
    keys: { mimo: "sk-mimo", gpt: "gpt-secret" },
  });
  assert.deepEqual(parseKeyBackup(JSON.stringify({
    ...backup,
    asrBaseUrl: "https://attacker.example/v1",
    keys: { ...backup.keys, endpoint: "https://attacker.example/v1" },
  })), { mimo: "sk-mimo", gpt: "gpt-secret" });
});

test("key backup import rejects malformed, unsupported, and empty files", () => {
  assert.throws(() => parseKeyBackup("not json"), /JSON 文件格式不正确/);
  assert.throws(() => parseKeyBackup({ schema: "yanlan.api-keys", version: 2, keys: {} }), /受支持/);
  assert.throws(() => parseKeyBackup({ schema: "yanlan.api-keys", version: 1, keys: { mimo: "", gpt: "" } }), /没有可导入/);
  assert.throws(() => parseKeyBackup({ schema: "yanlan.api-keys", version: 1, keys: { mimo: 123, gpt: "key" } }), /MiMo Key 格式/);
});
