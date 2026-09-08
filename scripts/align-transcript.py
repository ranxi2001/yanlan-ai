"""Optional WhisperX/pyannote worker. Dependencies are loaded only for an actual run."""
import argparse
import hashlib
import json
import os
import sys
from pathlib import Path


def surface(value):
    import unicodedata
    return "".join(c.lower() for c in unicodedata.normalize("NFKC", value) if c.isalnum())


def map_words(source, words):
    """Map aligned words to exact UTF-16 source spans; decline incomplete alignment."""
    meaningful = [(i, surface(c)) for i, c in enumerate(source) if surface(c)]
    cursor = 0
    mapped = []
    for word in words:
        normalized = surface(word.get("word", ""))
        if not normalized:
            continue
        if "start" not in word or "end" not in word or word["end"] <= word["start"]:
            return []
        start = cursor
        joined = ""
        while cursor < len(meaningful) and len(joined) < len(normalized):
            joined += meaningful[cursor][1]
            cursor += 1
        if joined != normalized:
            return []
        mapped.append({"char_start": meaningful[start][0], "char_end": meaningful[cursor - 1][0] + 1,
                       "start_seconds": float(word["start"]), "end_seconds": float(word["end"])})
    if cursor != len(meaningful) or not mapped:
        return []
    result = []
    for index, word in enumerate(mapped):
        start = 0 if index == 0 else word["char_start"]
        end = mapped[index + 1]["char_start"] if index + 1 < len(mapped) else len(source)
        result.append({"start_offset": len(source[:start].encode("utf-16-le")) // 2,
                       "end_offset": len(source[:end].encode("utf-16-le")) // 2,
                       "text": source[start:end], "start_seconds": word["start_seconds"], "end_seconds": word["end_seconds"]})
    return result


def main():
    parser = argparse.ArgumentParser(description="Align existing transcript without retranscribing or rewriting its words; optional whole-recording diarization.")
    parser.add_argument("--input", required=True, help="Input prepared by acoustic-annotations.mjs")
    parser.add_argument("--audio", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--device", choices=["cpu", "cuda"], default="cpu")
    parser.add_argument("--diarize", action="store_true")
    parser.add_argument("--min-speakers", type=int)
    parser.add_argument("--max-speakers", type=int)
    args = parser.parse_args()
    data = json.loads(Path(args.input).read_text(encoding="utf-8"))
    if data.get("schema") != 1 or not data.get("source_signature"):
        raise ValueError("Invalid source schema")
    import whisperx
    audio = whisperx.load_audio(args.audio)
    duration = len(audio) / 16000
    model, metadata = whisperx.load_align_model(language_code=data.get("language", "zh"), device=args.device)
    results = []
    for index, segment in enumerate(data["segments"]):
        start = float(segment["start_seconds"])
        end = float(segment["end_seconds"])
        if start < 0 or end <= start or end > duration + 0.5:
            raise ValueError("Transcript timing is outside the audio")
        aligned = whisperx.align([{"start": start, "end": min(end, duration), "text": segment["text"]}],
                                model, metadata, audio, args.device, return_char_alignments=False)
        words = [word for item in aligned.get("segments", []) for word in item.get("words", [])]
        results.append({"source_segment_id": index, "words": map_words(segment["text"], words)})
        print(f"Aligned source segment {index + 1}/{len(data['segments'])}", file=sys.stderr)
    turns = []
    if args.diarize:
        from whisperx.diarize import DiarizationPipeline
        token = os.environ.get("HF_TOKEN")
        if not token:
            raise ValueError("HF_TOKEN required for the selected diarization model")
        pipeline = DiarizationPipeline(token=token, device=args.device)
        table = pipeline(audio, min_speakers=args.min_speakers, max_speakers=args.max_speakers)
        turns = [{"start_seconds": max(0, float(row.start)), "end_seconds": min(duration, float(row.end)), "speaker": str(row.speaker)}
                 for row in table.itertuples() if float(row.end) > float(row.start)]
        turns.sort(key=lambda turn: turn["start_seconds"])
    with open(args.audio, "rb") as stream:
        audio_hash = hashlib.file_digest(stream, "sha256").hexdigest()
    output = {"schema": 1, "source_signature": data["source_signature"], "audio_sha256": audio_hash,
              "audio_duration": duration, "provider": "whisperx" + ("+pyannote" if args.diarize else ""),
              "segments": results, "speaker_turns": turns}
    Path(args.output).write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Acoustic processing failed ({type(error).__name__}). Check local dependencies, model access, audio and input. Source transcript was not changed.", file=sys.stderr)
        sys.exit(1)
