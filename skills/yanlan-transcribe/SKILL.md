---
name: yanlan-transcribe
description: Transcribe a local audio recording into plain text, Markdown, or structured JSON with the Yanlan CLI and MiMo ASR. Use when an Agent needs to convert MP3, WAV, M4A, WebM, OGG, Opus, AAC, FLAC, or MP4 audio files into text, including voice memos, interviews, meetings, lectures, and podcasts. Do not use for live microphone recording, speaker diarization, summarization, or transcript correction.
---

# Yanlan Transcribe

Use the deterministic Yanlan CLI for one local audio file at a time. The command uploads the audio to the configured MiMo-compatible ASR API; it does not send the file to a Yanlan server.

## Workflow

1. Resolve the input audio path and verify that the user requested transcription of that file.
2. Check for Node.js 20 or newer with `node --version`.
3. Check whether `MIMO_API_KEY` is available without printing its value. If it is absent, ask the user to set it locally and stop.
4. Choose an output beside the audio unless the user supplied another path. Use `.txt` by default, `.md` for a readable document, or `.json` when downstream automation needs segments and metadata.
5. Run the pinned release:

```bash
npx --yes github:ranxi2001/yanlan-ai#v0.4.5 transcribe "/absolute/path/recording.mp3" --output "/absolute/path/recording.txt"
```

6. Confirm the output file exists and is non-empty. Report its path, selected language, and model. Do not paste a sensitive transcript into the response unless the user asks to see it.

## Options

Use automatic language detection unless the user requests a bias:

```bash
yanlan transcribe recording.m4a -o recording.txt --language auto
yanlan transcribe interview.wav -o interview.md --language zh --format markdown
yanlan transcribe lecture.mp3 -o lecture.json --language en --format json
```

Set `MIMO_BASE_URL` for a compatible gateway. Use `MIMO_ASR_MODEL`, `MIMO_ASR_PROTOCOL`, and `MIMO_ASR_PATH` only when the provider requires non-default values. Prefer environment variables over `--api-key` so credentials do not enter shell history or process listings.

## Failure handling

- On `401` or `403`, ask the user to verify the local Key and account access without exposing the Key.
- On timeout or connection failure, preserve the audio and any existing output, then report the endpoint host and error without credentials.
- On an unsupported extension, do not rename the file to bypass detection; convert it with a trusted audio tool or ask for a supported format.
- On an empty transcript, report the failure instead of inventing content.
- Do not summarize, correct terminology, or infer speakers unless the user separately requests those tasks after transcription.
