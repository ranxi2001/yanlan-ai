import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_MIMO_FALLBACK_BYTES,
  MAX_MIMO_UPLOAD_BYTES,
  MAX_MIMO_UPLOAD_SECONDS,
  mimoUploadLimitMessage,
} from "../src/audio-limits.js";

test("default MiMo upload bounds reject unsafe browser decoding before transcription", () => {
  assert.equal(mimoUploadLimitMessage({ protocol: "mimo-chat", size: MAX_MIMO_UPLOAD_BYTES, duration: MAX_MIMO_UPLOAD_SECONDS }), "");
  assert.match(mimoUploadLimitMessage({ protocol: "mimo-chat", size: MAX_MIMO_UPLOAD_BYTES + 1, duration: 0 }), /128 MiB/);
  assert.match(mimoUploadLimitMessage({ protocol: "mimo-chat", size: 1, duration: MAX_MIMO_UPLOAD_SECONDS + 1 }), /30 分钟/);
  assert.equal(mimoUploadLimitMessage({ protocol: "openai-transcriptions", size: Number.MAX_SAFE_INTEGER, duration: Number.MAX_SAFE_INTEGER }), "");
  assert.equal(MAX_MIMO_FALLBACK_BYTES, 40 * 1024 * 1024);
});
