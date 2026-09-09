import argparse,hashlib,json,subprocess,time
from pathlib import Path
import numpy as np
from faster_whisper.vad import get_speech_timestamps,VadOptions

p=argparse.ArgumentParser();p.add_argument('--audio',required=True);p.add_argument('--output-dir',required=True);a=p.parse_args()
root=Path(a.output_dir);root.mkdir(parents=True,exist_ok=True)
started=time.perf_counter()
pcm=subprocess.run(['ffmpeg','-v','error','-i',a.audio,'-ac','1','-ar','16000','-f','s16le','pipe:1'],stdout=subprocess.PIPE,check=True).stdout
(root/'audio.s16le').write_bytes(pcm)
samples=np.frombuffer(pcm,dtype='<i2').astype(np.float32)/32768
speech=get_speech_timestamps(samples,VadOptions(threshold=.5,min_silence_duration_ms=300,speech_pad_ms=0,max_speech_duration_s=float('inf')))
with open(a.audio,'rb') as f:audio_hash=hashlib.file_digest(f,'sha256').hexdigest()
result={'schema':1,'audio_sha256':audio_hash,'pcm_sha256':hashlib.sha256(pcm).hexdigest(),'duration':len(samples)/16000,'sample_rate':16000,'pcm_file':'audio.s16le','speech':[{'start':s['start']/16000,'end':s['end']/16000} for s in speech],'vad':{'implementation':'faster-whisper 1.2.1 / Silero','threshold':.5,'min_silence_duration_ms':300,'speech_pad_ms':0,'silence_removed':False},'preparation_seconds':time.perf_counter()-started}
(root/'audio-manifest.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
print(json.dumps({k:v for k,v in result.items() if k!='speech'}))
