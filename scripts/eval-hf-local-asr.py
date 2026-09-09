"""Run local ASR models on the exact locked examples, without reference conditioning."""
import argparse,gc,hashlib,json,time,wave
from pathlib import Path
import numpy as np

def digest(path):
    with Path(path).open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()

def read_audio(path):
    with wave.open(str(path),'rb') as w:
        if (w.getnchannels(),w.getframerate(),w.getsampwidth())!=(1,16000,2):raise ValueError('Benchmark expects mono 16kHz PCM16 WAV')
        data=w.readframes(w.getnframes())
    return np.frombuffer(data,dtype='<i2').astype(np.float32)/32768

def main():
    p=argparse.ArgumentParser();p.add_argument('--root',default='artifacts/hf-asr-benchmark');p.add_argument('--lock',default='data/hf-asr-benchmark-lock.json');p.add_argument('--plan',required=True)
    p.add_argument('--whisper-model',required=True);p.add_argument('--sensevoice-model');p.add_argument('--output-dir',default='artifacts/hf-asr-benchmark/evaluation')
    p.add_argument('--backend',choices=['all','whisper','sensevoice'],default='all');p.add_argument('--whisper-language',default=None);p.add_argument('--chinese-corpora-only',action='store_true');p.add_argument('--run-label',default='full');a=p.parse_args()
    if a.backend in ['all','sensevoice'] and not a.sensevoice_model:p.error('--sensevoice-model is required for SenseVoice')
    if not a.run_label or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_' for c in a.run_label):p.error('Invalid run label')
    root=Path(a.root);out=Path(a.output_dir);out.mkdir(parents=True,exist_ok=True)
    locked={r['id']:r for r in json.loads(Path(a.lock).read_text(encoding='utf-8'))['samples']};rows={}
    for name in ['aishell1/manifest.jsonl','ascend/manifest.jsonl','aishell4/utterance-manifest.jsonl']:
        for line in (root/name).read_text(encoding='utf-8').splitlines():
            r=json.loads(line);expected=locked[r['id']]
            if expected['audio_sha256']!=r['audio_sha256'] or expected['reference_sha256']!=hashlib.sha256(r['reference_text'].encode()).hexdigest():raise ValueError('Sample lock mismatch')
            rows[r['id']]=r
    plan=json.loads(Path(a.plan).read_text(encoding='utf-8'));selected=[rows[i] for i in plan['sample_ids']]
    if len(selected)!=len(locked) or len({r['id'] for r in selected})!=len(locked):raise ValueError('Model comparison must cover the exact full lock')
    if a.chinese_corpora_only:selected=[r for r in selected if r['dataset'] in ['TwinkStart/AISHELL-1','AISHELL/AISHELL-4']]
    for r in selected:
        path=(root/r['audio']).resolve()
        if not path.is_relative_to(root.resolve()) or digest(path)!=r['audio_sha256']:raise ValueError('Audio source mismatch')
    for backend in (['whisper','sensevoice'] if a.backend=='all' else [a.backend]):
        started=time.perf_counter()
        if backend=='whisper':
            import faster_whisper
            model=faster_whisper.WhisperModel(a.whisper_model,device='cuda',compute_type='float16',local_files_only=True)
            metadata={'model':'faster-whisper-large-v3-turbo','implementation':faster_whisper.__version__,'device':'cuda','compute_type':'float16','language':a.whisper_language or 'auto','beam_size':5,'vad_filter':False,'condition_on_previous_text':False,'temperature':[0,.2,.4,.6,.8,1.0]}
        else:
            import sherpa_onnx
            model=sherpa_onnx.OfflineRecognizer.from_sense_voice(model=str(Path(a.sensevoice_model)/'model.int8.onnx'),tokens=str(Path(a.sensevoice_model)/'tokens.txt'),num_threads=4,language='auto',use_itn=True)
            metadata={'model':'sensevoice-small-int8','implementation':'sherpa-onnx '+sherpa_onnx.__version__,'device':'cpu','threads':4,'language':'auto','use_itn':True}
        loaded=time.perf_counter();records=[]
        for index,r in enumerate(selected):
            t=time.perf_counter();audio=read_audio(root/r['audio']);decoded=time.perf_counter()
            if backend=='whisper':
                hypotheses,info=model.transcribe(audio,language=a.whisper_language,task='transcribe',beam_size=5,vad_filter=False,condition_on_previous_text=False,temperature=(0,.2,.4,.6,.8,1.0),word_timestamps=False)
                text=''.join(s.text for s in hypotheses).strip();language=info.language
            else:
                stream=model.create_stream();stream.accept_waveform(16000,audio);model.decode_stream(stream);text=stream.result.text;language=getattr(stream.result,'lang',None)
            records.append({'id':r['id'],'dataset':r['dataset'],'audio_sha256':r['audio_sha256'],'hypothesis':text,'seconds':r['duration'],'decode_milliseconds':(decoded-t)*1000,'elapsed_milliseconds':(time.perf_counter()-decoded)*1000,'detected_language':language})
            if (index+1)%20==0 or index+1==len(selected):
                (out/(backend+'-'+a.run_label+'.raw.json')).write_text(json.dumps({'metadata':metadata,'model_load_seconds':loaded-started,'records':records,'complete':index+1==len(selected)},ensure_ascii=False,indent=2),encoding='utf-8')
                print(json.dumps({'backend':backend,'completed':index+1,'total':len(selected)}),flush=True)
        metadata['elapsed_seconds_including_load']=time.perf_counter()-started
        (out/(backend+'-'+a.run_label+'.raw.json')).write_text(json.dumps({'metadata':metadata,'model_load_seconds':loaded-started,'records':records,'complete':True},ensure_ascii=False,indent=2),encoding='utf-8')
        del model;gc.collect()

if __name__=='__main__':main()
