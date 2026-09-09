"""Local short-window coverage scout; reads only PCM and reference-free plans."""
import argparse,hashlib,json,time,math
from pathlib import Path
import numpy as np
import sherpa_onnx

def sha(b):return hashlib.sha256(b).hexdigest()
def main():
    p=argparse.ArgumentParser();p.add_argument('--root',default='artifacts/hf-asr-coverage');p.add_argument('--model',default='artifacts/models/sensevoice');a=p.parse_args()
    root=Path(a.root);plan_data=(root/'coverage-plan.json').read_bytes();plan=json.loads(plan_data)
    started=time.perf_counter();model_root=Path(a.model)
    model=sherpa_onnx.OfflineRecognizer.from_sense_voice(model=str(model_root/'model.int8.onnx'),tokens=str(model_root/'tokens.txt'),num_threads=4,language='auto',use_itn=True)
    loaded=time.perf_counter();records=[]
    for source in plan['streams']:
        path=(root/source['pcm_file']).resolve()
        if not path.is_relative_to(root.resolve()):raise ValueError('PCM outside corpus')
        data=path.read_bytes()
        if sha(data)!=source['pcm_sha256']:raise ValueError('PCM changed')
        for w in source['windows']:
            parts=[];began=time.perf_counter()
            for part in w['parts']:
                lo=math.floor(part['start_seconds']*source['sample_rate']+.5)*2;hi=math.floor(part['end_seconds']*source['sample_rate']+.5)*2
                chunk=data[lo:hi];audio=np.frombuffer(chunk,dtype='<i2').astype(np.float32)/32768
                stream=model.create_stream();stream.accept_waveform(source['sample_rate'],audio);model.decode_stream(stream)
                parts.append({**part,'pcm_sha256':sha(chunk),'text':stream.result.text})
            records.append({'stream_id':source['id'],'window_id':w['window']['id'],'window':w['window'],'speech_seconds':w['speech_seconds'],
                'source_pcm_sha256':source['pcm_sha256'],'parts':parts,'elapsed_milliseconds':(time.perf_counter()-began)*1000})
            if len(records)%20==0:print(json.dumps({'scouted_windows':len(records)}),flush=True)
    result={'schema':1,'complete':True,'plan_sha256':sha(plan_data),'records':records,'elapsed_seconds':time.perf_counter()-started,
        'model_load_seconds':loaded-started,'metadata':{'model':'sensevoice-small-int8','implementation':sherpa_onnx.__version__,'device':'cpu','threads':4,'language':'auto','use_itn':True}}
    (root/'scout.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'complete':True,'windows':len(records),'seconds':result['elapsed_seconds']}),flush=True)
if __name__=='__main__':main()
