"""Install an isolated local recognizer; invoked explicitly by the operator."""
import os
from pathlib import Path
import subprocess
import sys
import urllib.request
import venv

root = Path(__file__).resolve().parent.parent
environment = root / '.venv-coverage'
venv.create(environment, with_pip=True)
python = environment / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
subprocess.run([str(python), '-m', 'pip', 'install', '-r', str(root / 'server/coverage-requirements.txt')], check=True)
model = Path(os.environ.get('YANLAN_SENSEVOICE_DIR', str(root / 'artifacts/models/sensevoice')))
model.mkdir(parents=True, exist_ok=True)
base = 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/'
for name in ['model.int8.onnx', 'tokens.txt']:
    destination = model / name
    if destination.is_file() and destination.stat().st_size:
        continue
    temporary = model / (name + '.download')
    print('Downloading ' + name, flush=True)
    urllib.request.urlretrieve(base + name, temporary)
    temporary.replace(destination)
subprocess.run([str(python), '-c',
    'import sherpa_onnx,sys; from pathlib import Path; p=Path(sys.argv[1]); '
    'sherpa_onnx.OfflineRecognizer.from_sense_voice(model=str(p/"model.int8.onnx"), tokens=str(p/"tokens.txt"), num_threads=4) ',
    str(model)], check=True)
print('Local coverage ready. Run npm run local and select the local gateway in settings.')
