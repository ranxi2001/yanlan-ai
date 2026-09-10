"""Private stdin/stdout worker. No network, audio files, or transcript logging."""
import argparse
import base64
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import sherpa_onnx


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', required=True)
    args = parser.parse_args()
    root = Path(args.model)
    recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
        model=str(root / 'model.int8.onnx'), tokens=str(root / 'tokens.txt'),
        num_threads=4, language='auto', use_itn=True)
    while True:
        line = sys.stdin.buffer.readline(1400000)
        if not line:
            return
        if not line.endswith(b'\n'):
            return
        request = {}
        try:
            request = json.loads(line)
            data = base64.b64decode(request['pcm'], validate=True)
            lengths = request['lengths']
            if (not 0 < len(data) <= 960000 or len(data) % 2 or not 1 <= len(lengths) <= 3
                    or any(type(n) is not int or not 0 < n <= 320000 for n in lengths)
                    or sum(lengths) * 2 != len(data)):
                raise ValueError('Invalid PCM')
            parts = []
            offset = 0
            for frames in lengths:
                chunk = data[offset:offset + frames * 2]
                offset += frames * 2
                stream = recognizer.create_stream()
                stream.accept_waveform(16000, np.frombuffer(chunk, dtype='<i2').astype(np.float32) / 32768)
                recognizer.decode_stream(stream)
                parts.append({'pcm_sha256': hashlib.sha256(chunk).hexdigest(), 'text': stream.result.text})
            result = {'id': request['id'], 'model': 'sensevoice-small-int8', 'parts': parts}
        except Exception:
            result = {'id': request.get('id'), 'error': 'Local coverage failed'}
        print(json.dumps(result, ensure_ascii=True), flush=True)


if __name__ == '__main__':
    main()
