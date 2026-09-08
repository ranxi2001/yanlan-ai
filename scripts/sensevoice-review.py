import argparse,json,subprocess,time,hashlib
from pathlib import Path
import numpy as np
import sherpa_onnx

p=argparse.ArgumentParser()
p.add_argument('--audio',required=True)
p.add_argument('--model',required=True)
p.add_argument('--output',required=True)
p.add_argument('--chunk-seconds',type=int,default=30)
a=p.parse_args()
started=time.perf_counter()
recognizer=sherpa_onnx.OfflineRecognizer.from_sense_voice(model=str(Path(a.model)/'model.int8.onnx'),tokens=str(Path(a.model)/'tokens.txt'),num_threads=4,language='zh',use_itn=True)
pcm=subprocess.run(['ffmpeg','-v','error','-i',a.audio,'-ac','1','-ar','16000','-f','f32le','pipe:1'],stdout=subprocess.PIPE,check=True).stdout
audio=np.frombuffer(pcm,dtype=np.float32)
segments=[]
for offset in range(0,len(audio),a.chunk_seconds*16000):
 end=min(len(audio),offset+a.chunk_seconds*16000)
 # Overlapping context is audio-only; use full hypothesis as auxiliary review, not concatenated final transcript.
 left=max(0,offset-16000);right=min(len(audio),end+16000)
 stream=recognizer.create_stream();stream.accept_waveform(16000,audio[left:right]);recognizer.decode_stream(stream)
 segments.append({'start_seconds':left/16000,'end_seconds':right/16000,'text':stream.result.text})
 print(f'Reviewed {end/16000:.1f}s',flush=True)
with open(a.audio,'rb') as f: audio_hash=hashlib.file_digest(f,'sha256').hexdigest()
result={'segments':segments,'audio_sha256':audio_hash,'model':'sensevoice-small-int8','elapsed_seconds':time.perf_counter()-started,'purpose':'independent_audio_only_review_with_overlapping_windows'}
Path(a.output).write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'elapsed_seconds':result['elapsed_seconds']}),flush=True)
