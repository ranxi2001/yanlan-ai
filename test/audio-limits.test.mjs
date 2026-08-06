import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  canUseMimoWholeFileFallback,
  MAX_MIMO_FALLBACK_BYTES,
  MAX_MIMO_FALLBACK_SECONDS,
  MAX_MIMO_UPLOAD_BYTES,
  MAX_MIMO_UPLOAD_SECONDS,
  audioDurationOrNull,
  mimoUploadLimitMessage,
  storedAudioDuration,
} from "../src/audio-limits.js";

test("audio durations preserve known values and normalize unknown values for storage", () => {
  assert.equal(audioDurationOrNull(0), null);
  assert.equal(storedAudioDuration(0), 0);
  assert.equal(audioDurationOrNull(12.5), 12.5);
  for (const value of [null, undefined, "12", Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1]) {
    assert.equal(audioDurationOrNull(value), null);
    assert.equal(storedAudioDuration(value), 0);
  }
});

test("MiMo streaming bounds accept hour-long unknown-duration recordings", () => {
  assert.equal(mimoUploadLimitMessage({ protocol: "mimo-chat", size: MAX_MIMO_UPLOAD_BYTES, duration: MAX_MIMO_UPLOAD_SECONDS }), "");
  assert.equal(mimoUploadLimitMessage({ protocol: "mimo-chat", size: 94_163_881, duration: null }), "");
  assert.equal(mimoUploadLimitMessage({ protocol: "mimo-chat", size: 94_163_881, duration: 61 * 60 + 35 }), "");
  assert.match(mimoUploadLimitMessage({ protocol: "mimo-chat", size: MAX_MIMO_UPLOAD_BYTES + 1, duration: 1 }), /512 MiB/);
  assert.match(mimoUploadLimitMessage({ protocol: "mimo-chat", size: 1, duration: MAX_MIMO_UPLOAD_SECONDS + 1 }), /4 小时/);
  assert.equal(mimoUploadLimitMessage({ protocol: "mimo-chat", size: MAX_MIMO_FALLBACK_BYTES + 1, duration: 1 }), "");
  for (const duration of [0, null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(mimoUploadLimitMessage({ protocol: "mimo-chat", size: MAX_MIMO_UPLOAD_BYTES, duration }), "");
  }
  assert.equal(mimoUploadLimitMessage({ protocol: "openai-transcriptions", size: Number.MAX_SAFE_INTEGER, duration: null }), "");
  assert.equal(MAX_MIMO_UPLOAD_SECONDS, 4 * 60 * 60);
  assert.equal(MAX_MIMO_UPLOAD_BYTES, 512 * 1024 * 1024);
  assert.equal(MAX_MIMO_FALLBACK_BYTES, 40 * 1024 * 1024);
});

test("whole-file fallback requires a small file with a short known duration", () => {
  assert.equal(canUseMimoWholeFileFallback({ size: MAX_MIMO_FALLBACK_BYTES, duration: MAX_MIMO_FALLBACK_SECONDS }), true);
  assert.equal(canUseMimoWholeFileFallback({ size: MAX_MIMO_FALLBACK_BYTES + 1, duration: 60 }), false);
  assert.equal(canUseMimoWholeFileFallback({ size: 1, duration: MAX_MIMO_FALLBACK_SECONDS + 1 }), false);
  for (const duration of [0, null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(canUseMimoWholeFileFallback({ size: 1, duration }), false);
  }
});

test("root recording formats are ignored without hiding explicit subdirectory assets", () => {
  const repository = fileURLToPath(new URL("..", import.meta.url));
  const ignored = (path) => {
    try {
      execFileSync("git", ["check-ignore", "--no-index", "--quiet", path], { cwd: repository, stdio: "ignore" });
      return true;
    } catch (error) {
      if (error.status === 1) return false;
      throw error;
    }
  };
  for (const extension of ["webm", "wav", "m4a", "mp3", "ogg", "aac", "flac", "mp4"]) {
    assert.equal(ignored(`local-recording.${extension}`), true, extension);
    assert.equal(ignored(`docs/local-recording.${extension}`), false, extension);
  }
});
