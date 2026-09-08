"""Run an installed faster-whisper model on actual audio; keep word timestamps and raw results."""
import argparse
import hashlib
import json
import time
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--audio", required=True)
parser.add_argument("--model", required=True)
parser.add_argument("--output", required=True)
parser.add_argument("--device", default="cuda")
parser.add_argument("--beam-size", type=int, default=5)
args = parser.parse_args()
from faster_whisper import WhisperModel

started = time.perf_counter()
model = WhisperModel(args.model, device=args.device, compute_type="float16" if args.device == "cuda" else "int8", local_files_only=True)
loaded = time.perf_counter()
segments, info = model.transcribe(args.audio, language="zh", beam_size=args.beam_size, word_timestamps=True,
                                  vad_filter=True, condition_on_previous_text=False, temperature=0)
output = []
for segment in segments:
    output.append({"start_seconds": segment.start, "end_seconds": segment.end, "speaker": "未区分说话人",
                   "speaker_source": "unknown", "timing_source": "provider", "text": segment.text.strip(),
                   "avg_logprob": segment.avg_logprob, "no_speech_prob": segment.no_speech_prob,
                   "words": [{"start_seconds": w.start, "end_seconds": w.end, "text": w.word, "probability": w.probability} for w in segment.words or []]})
    print(f"Transcribed through {segment.end:.1f}s", flush=True)
finished = time.perf_counter()
with open(args.audio, "rb") as stream:
    digest = hashlib.file_digest(stream, "sha256").hexdigest()
result = {"title": "云原生周会：本地音频转写基线", "duration": info.duration, "segments": output,
          "asr_run": {"model": Path(args.model).name, "device": args.device, "beam_size": args.beam_size,
                      "audio_sha256": digest, "model_load_seconds": loaded-started, "transcription_seconds": finished-loaded,
                      "total_seconds": finished-started, "realtime_factor": (finished-loaded)/info.duration}}
target = Path(args.output)
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
def timestamp(value):
    value = int(value)
    return f"{value//60:02d}:{value%60:02d}"
lines = ["# 云原生周会：实际音频转写基线", "", "本文件是本地 Whisper 实际识别结果，尚未经过逐字稿纠错 Harness；说话人未区分。", "", "## 逐字稿", ""]
for segment in output:
    lines += [f"### {timestamp(segment['start_seconds'])}", "", segment["text"], ""]
target.with_suffix(".md").write_text("\n".join(lines), encoding="utf-8")
print(json.dumps(result["asr_run"], ensure_ascii=True), flush=True)
