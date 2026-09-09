"""Prepare full sessions and continuous clean scoring spans; never splice audio."""
import argparse,hashlib,importlib.util,json,re,subprocess,time
from pathlib import Path

spec=importlib.util.spec_from_file_location('meeting_parser',Path(__file__).with_name('prepare-hf-meeting-benchmark.py'))
parser=importlib.util.module_from_spec(spec);spec.loader.exec_module(parser)

def digest(data):return hashlib.sha256(data).hexdigest()

def clean_spans(rows,duration,minimum=60):
    bad=[]
    for i,row in enumerate(rows):
        if re.search(r'<[^>]*>',row['text']):bad.append((row['start_seconds'],row['end_seconds']))
        for other in rows[i+1:]:
            if other['start_seconds']>=row['end_seconds']:break
            if row['speaker']!=other['speaker']:
                bad.append((min(row['start_seconds'],other['start_seconds']),max(row['end_seconds'],other['end_seconds'])))
    merged=[]
    for start,end in sorted(bad):
        if merged and start<=merged[-1][1]:merged[-1][1]=max(end,merged[-1][1])
        else:merged.append([start,end])
    spans=[];cursor=0
    for start,end in merged+[[duration,duration]]:
        if start-cursor>=minimum:
            chosen=[r for r in rows if r['start_seconds']>=cursor and r['end_seconds']<=start]
            if chosen:
                lo=max(cursor,chosen[0]['start_seconds']-.05);hi=min(start,chosen[-1]['end_seconds']+.05)
                if hi-lo>=minimum:spans.append((lo,hi,chosen))
        cursor=end
    return spans

def main():
    import numpy as np
    from faster_whisper.vad import get_speech_timestamps,VadOptions
    p=argparse.ArgumentParser();p.add_argument('--root',default='artifacts/hf-asr-longform');a=p.parse_args()
    root=Path(a.root);prepared=root/'prepared';prepared.mkdir(parents=True,exist_ok=True)
    source=json.loads((root/'source-spec.json').read_text(encoding='utf-8'))
    sessions=[json.loads(l) for l in (root/'aishell4/manifest.jsonl').read_text(encoding='utf-8').splitlines()]
    streams=[];started=time.perf_counter()
    for session in sessions:
        name=session['session_id'];split='development' if name==source['development_session'] else 'heldout'
        audio=root/session['audio'];annotation=root/session['textgrid']
        if parser.sha(audio)!=session['audio_sha256'] or parser.sha(annotation)!=session['textgrid_sha256']:raise ValueError('Source hash mismatch')
        pcm=subprocess.run(['ffmpeg','-v','error','-i',str(audio),'-af','pan=mono|c0=c0','-ar','16000','-f','s16le','pipe:1'],capture_output=True,check=True).stdout
        samples=np.frombuffer(pcm,dtype='<i2').astype(np.float32)/32768
        speech=get_speech_timestamps(samples,VadOptions(threshold=.5,min_silence_duration_ms=300,speech_pad_ms=0,max_speech_duration_s=float('inf')))
        rows=parser.parse_textgrid(annotation.read_text(encoding='utf-8-sig'))
        regions=[(0,len(samples)/16000,rows,'full')]+[(lo,hi,rs,'clean') for lo,hi,rs in clean_spans(rows,len(samples)/16000)]
        for index,(lo,hi,rs,kind) in enumerate(regions):
            start=round(lo*16000);end=round(hi*16000);lo=start/16000;hi=end/16000
            uid=f'{name}-{kind}-{index}';chunk=pcm[start*2:end*2]
            pcm_path=prepared/(uid+'.s16le');pcm_path.write_bytes(chunk)
            refs=[{**r,'start_seconds':max(0,r['start_seconds']-lo),'end_seconds':min(hi-lo,r['end_seconds']-lo)} for r in rs]
            ref_path=prepared/(uid+'.reference.json');ref_data=json.dumps(refs,ensure_ascii=False,indent=2).encode();ref_path.write_bytes(ref_data)
            streams.append({'id':uid,'session_id':name,'split':split,'kind':kind,'duration':hi-lo,'sample_rate':16000,
                'source_start':lo,'source_end':hi,'source_audio_sha256':session['audio_sha256'],'source_channel':0,
                'pcm_file':str(pcm_path.relative_to(root)).replace('\\','/'),'pcm_sha256':digest(chunk),
                'reference_file':str(ref_path.relative_to(root)).replace('\\','/'),'reference_sha256':digest(ref_data),
                'speech':[{'start':max(0,s['start']/16000-lo),'end':min(hi-lo,s['end']/16000-lo)} for s in speech if s['start']/16000<hi and s['end']/16000>lo]})
        print(json.dumps({'session':name,'full_seconds':len(samples)/16000,'clean_spans':len(regions)-1,'clean_seconds':sum(hi-lo for lo,hi,_,k in regions if k=='clean')}),flush=True)
    manifest={'schema':1,'streams':streams,'vad':{'implementation':'faster-whisper Silero','threshold':.5,'minimum_silence_ms':300,'speech_padding_ms':0,'silence_removed':False},
        'clean_selection':'All continuous spans >=60s after excluding entire tagged/overlapping utterance unions; original intervening silence retained. Not full-meeting CER.',
        'preparation_seconds':time.perf_counter()-started}
    (root/'prepared-manifest.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')

if __name__=='__main__':main()
