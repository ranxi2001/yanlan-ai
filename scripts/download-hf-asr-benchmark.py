"""Download a fixed public ASR benchmark without loading dataset-provided Python code."""
import argparse,concurrent.futures,hashlib,json,random,re,subprocess,time,urllib.parse,urllib.request,wave
from pathlib import Path

USER_AGENT='yanlan-asr-benchmark/1'

def request(url):
    return urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':USER_AGENT}),timeout=60)

def get_json(url):
    for attempt in range(4):
        try:
            with request(url) as r:return json.load(r)
        except Exception:
            if attempt==3:raise
            time.sleep(attempt+1)

def download(url,path):
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    if path.exists() and path.stat().st_size:return path
    partial=path.with_name(path.name+'.partial')
    for attempt in range(4):
        try:
            with request(url) as r,partial.open('wb') as f:
                last=time.monotonic();total=0
                while True:
                    b=r.read(1024*1024)
                    if not b:break
                    f.write(b);total+=len(b)
                    if time.monotonic()-last>25:print(json.dumps({'event':'download_progress','file':path.name,'bytes':total}),flush=True);last=time.monotonic()
            partial.replace(path);return path
        except Exception:
            if attempt==3:raise
            time.sleep(attempt+1)

def sha(path):
    with Path(path).open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()

def asset_url(spec,path):
    return 'https://huggingface.co/datasets/'+spec['dataset']+'/resolve/'+spec['revision']+'/'+path

def audio_info(path):
    with wave.open(str(path),'rb') as w:
        return {'duration':w.getnframes()/w.getframerate(),'sample_rate':w.getframerate(),'channels':w.getnchannels(),'frames':w.getnframes()}

def fetch_rows(spec,offset,length=100):
    query=urllib.parse.urlencode({'dataset':spec['dataset'],'config':spec['config'],'split':spec['split'],'offset':offset,'length':length})
    return get_json('https://datasets-server.huggingface.co/rows?'+query)

def preserve_source(spec,root):
    meta=get_json('https://huggingface.co/api/datasets/'+spec['dataset']+'/revision/'+spec['revision'])
    if meta['sha']!=spec['revision']:raise ValueError('Dataset revision does not match the pinned source specification')
    dest=root/'provenance'/spec['id'];dest.mkdir(parents=True,exist_ok=True)
    (dest/'metadata.json').write_text(json.dumps(meta,ensure_ascii=False,indent=2),encoding='utf-8')
    download(asset_url(spec,'README.md'),dest/'README.md')
    return meta

def utterances(spec,root,seed):
    preserve_source(spec,root)
    import pyarrow.parquet as pq
    parquet_paths=[download(asset_url(spec,remote),root/'downloads'/spec['id']/Path(remote).name) for remote in spec['parquet_files']]
    rows=[];index=0
    for path in parquet_paths:
        file=pq.ParquetFile(path)
        columns=[name for name in file.schema_arrow.names if name!='audio']
        for batch in file.iter_batches(batch_size=256,columns=columns):
            for row in batch.to_pylist():rows.append({'row_idx':index,'row':row});index+=1
    rng=random.Random(seed+':'+spec['id'])
    official={}
    if spec['id']=='aishell1':
        ref={'dataset':spec['reference_dataset'],'revision':spec['reference_revision']}
        path=download(asset_url(ref,spec['reference_file']),root/'provenance'/'aishell1'/'official-transcript.txt')
        for line in path.read_text(encoding='utf-8-sig').splitlines():
            parts=line.split(maxsplit=1)
            if len(parts)==2:official[parts[0]]=re.sub(r'\s+','',parts[1])
        groups={}
        for entry in rows:
            row=entry['row'];uid=row['name'];speaker=re.search(r'S\d+',uid).group()
            if row['WavPath'].split('/')[0]!='test':raise ValueError('Non-test sample in AISHELL test mirror')
            if re.sub(r'\s+','',row['text'])!=official.get(uid):raise ValueError('Mirror transcription differs from official AISHELL reference')
            groups.setdefault(speaker,[]).append(entry)
        for group in groups.values():rng.shuffle(group)
        names=sorted(groups);rng.shuffle(names);selected=[]
        while len(selected)<spec['sample_count']:
            advanced=False
            for name in names:
                if groups[name] and len(selected)<spec['sample_count']:selected.append(groups[name].pop());advanced=True
            if not advanced:break
    else:
        groups={}
        for entry in rows:
            row=entry['row']
            if row['duration']<1 or not row['transcription'].strip():continue
            groups.setdefault(row['language'],[]).append(entry)
        for group in groups.values():rng.shuffle(group)
        selected=[]
        # Half mixed utterances, then equal zh/en where available; deterministic fill.
        counts={'mixed':spec['sample_count']//2,'zh':spec['sample_count']//4,'en':spec['sample_count']//4}
        for lang,count in counts.items():selected.extend(groups.get(lang,[])[:count]);groups[lang]=groups.get(lang,[])[count:]
        remaining=[entry for group in groups.values() for entry in group];rng.shuffle(remaining)
        selected.extend(remaining[:spec['sample_count']-len(selected)])
    selection=[{'row_idx':x['row_idx'],'id':x['row'].get('name',x['row'].get('id'))} for x in selected]
    (root/'provenance'/spec['id']/'selection.json').write_text(json.dumps({'seed':seed,'source_revision':spec['revision'],'rows':selection},indent=2),encoding='utf-8')
    selected_by_index={entry['row_idx']:entry for entry in selected}
    audio_bytes={};index=0
    for path in parquet_paths:
        for batch in pq.ParquetFile(path).iter_batches(batch_size=32,columns=['audio']):
            for row in batch.to_pylist():
                if index in selected_by_index:audio_bytes[index]=row['audio']['bytes']
                index+=1
    def save(entry):
        row=entry['row'];index=entry['row_idx'];uid=row.get('name',row.get('id'))
        path=root/spec['id']/'audio'/(str(uid)+'.wav')
        if not path.exists():
            path.parent.mkdir(parents=True,exist_ok=True)
            encoded=audio_bytes[index]
            if encoded[:4]==b'RIFF':path.write_bytes(encoded)
            else:
                # Write a seekable WAV to avoid an unknown-size RIFF header in manifests.
                temporary=path.with_suffix('.encoded');temporary.write_bytes(encoded)
                subprocess.run(['ffmpeg','-v','error','-y','-i',str(temporary),'-acodec','pcm_s16le',str(path)],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,check=True)
                temporary.unlink()
        info=audio_info(path)
        text=official[uid] if official else row['transcription']
        record={'id':spec['id']+':'+str(uid),'dataset':spec['dataset'],'revision':spec['revision'],'source_split':spec['split'],'row_index':index,
                'audio':str(path.relative_to(root)).replace('\\','/'),'audio_sha256':sha(path),'reference_text':text,'reference_type':'official_human_transcript_verified_by_id' if official else 'dataset_expert_transcription',**info}
        if official:record['speaker_id']=re.search(r'S\d+',uid).group();record['reference_revision']=spec['reference_revision']
        else:
            for key in ['language','original_speaker_id','session_id','topic']:record[key]=row[key]
        return record
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as ex:records=list(ex.map(save,selected))
    (root/spec['id']/'manifest.jsonl').write_text(''.join(json.dumps(row,ensure_ascii=False)+'\n' for row in records),encoding='utf-8')
    print(json.dumps({'event':'dataset_ready','dataset':spec['id'],'samples':len(records),'seconds':sum(x['duration'] for x in records)}),flush=True)
    return records

def meetings(spec,root):
    preserve_source(spec,root);records=[]
    for session in spec['sessions']:
        paths={}
        for kind,remote in [('textgrid',f'test/TextGrid/{session}.TextGrid'),('rttm',f'test/TextGrid/{session}.rttm'),('audio',f'test/wav/{session}.flac')]:
            paths[kind]=download(asset_url(spec,remote),root/spec['id']/session/Path(remote).name)
        probe=subprocess.run(['ffprobe','-v','error','-show_entries','format=duration:stream=sample_rate,channels','-of','json',str(paths['audio'])],capture_output=True,text=True,check=True)
        info=json.loads(probe.stdout);stream=info['streams'][0]
        record={'id':'aishell4:'+session,'dataset':spec['dataset'],'revision':spec['revision'],'source_split':spec['split'],'session_id':session,
                'duration':float(info['format']['duration']),'sample_rate':int(stream['sample_rate']),'channels':stream['channels'],
                'reference_type':'official_TextGrid_and_RTTM',**{k:str(v.relative_to(root)).replace('\\','/') for k,v in paths.items()},
                **{k+'_sha256':sha(v) for k,v in paths.items()}}
        records.append(record);print(json.dumps({'event':'meeting_ready','session':session,'seconds':record['duration'],'channels':record['channels']}),flush=True)
    (root/'aishell4'/'manifest.jsonl').write_text(''.join(json.dumps(row,ensure_ascii=False)+'\n' for row in records),encoding='utf-8')
    return records

def main():
    p=argparse.ArgumentParser();p.add_argument('--spec',default='data/hf-asr-benchmark-sources.json');p.add_argument('--output-dir',default='artifacts/hf-asr-benchmark');a=p.parse_args()
    spec=json.loads(Path(a.spec).read_text(encoding='utf-8'));root=Path(a.output_dir);root.mkdir(parents=True,exist_ok=True)
    existing=root/'source-spec.json'
    if existing.exists() and json.loads(existing.read_text(encoding='utf-8'))!=spec:raise ValueError('Source spec changed; use a new output directory')
    existing.write_text(json.dumps(spec,ensure_ascii=False,indent=2),encoding='utf-8')
    def run(source):return meetings(source,root) if source['id']=='aishell4' else utterances(source,root,spec['seed'])
    results=[]
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as ex:
        for records in ex.map(run,spec['sources']):results.extend(records)
    summary={'schema':1,'samples':len(results),'audio_seconds':sum(x['duration'] for x in results),'audio_bytes':sum((root/x['audio']).stat().st_size for x in results),
             'datasets':{source['id']:sum(x['id'].startswith(source['id']+':') for x in results) for source in spec['sources']},'status':'downloaded_and_audio_headers_verified','asr_evaluation':'not_run'}
    (root/'summary.json').write_text(json.dumps(summary,indent=2),encoding='utf-8');print(json.dumps(summary),flush=True)

if __name__=='__main__':main()
