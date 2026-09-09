"""Parse original meeting annotations and derive fixed non-overlapping ASR clips."""
import argparse,hashlib,json,random,re,subprocess,wave
from pathlib import Path

def sha(path):
    with Path(path).open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()

def parse_textgrid(text):
    records=[]
    for tier in re.split(r'^\s*item \[\d+\]:\s*$',text,flags=re.M)[1:]:
        name=re.search(r'name\s*=\s*"((?:""|[^"])*)"',tier)
        if not name or 'class = "IntervalTier"' not in tier:continue
        speaker=name.group(1).replace('""','"')
        for block in re.split(r'^\s*intervals \[\d+\]:\s*$',tier,flags=re.M)[1:]:
            start=re.search(r'xmin\s*=\s*([0-9.eE+-]+)',block);end=re.search(r'xmax\s*=\s*([0-9.eE+-]+)',block)
            value=re.search(r'text\s*=\s*"((?:""|[^"])*)"',block,re.S)
            if not (start and end and value):raise ValueError('Malformed TextGrid interval')
            content=value.group(1).replace('""','"').strip()
            if content:records.append({'speaker':speaker,'start_seconds':float(start.group(1)),'end_seconds':float(end.group(1)),'text':content})
    return sorted(records,key=lambda r:(r['start_seconds'],r['end_seconds'],r['speaker']))

def prepare(root,count):
    sessions=[json.loads(line) for line in (root/'aishell4'/'manifest.jsonl').read_text(encoding='utf-8').splitlines()]
    all_clips=[];summary=[]
    for session in sessions:
        rows=parse_textgrid((root/session['textgrid']).read_text(encoding='utf-8-sig'))
        if not rows:raise ValueError('Empty meeting reference')
        for row in rows:
            if row['start_seconds']<0 or row['end_seconds']<=row['start_seconds'] or row['end_seconds']>session['duration']+.01:raise ValueError('Annotation out of audio bounds')
        eligible=[]
        for index,row in enumerate(rows):
            duration=row['end_seconds']-row['start_seconds']
            if not 3<=duration<=15 or re.search(r'<[^>]*>',row['text']):continue
            start=max(0,row['start_seconds']-.05);end=min(session['duration'],row['end_seconds']+.05)
            if any(other['speaker']!=row['speaker'] and other['start_seconds']<end and other['end_seconds']>start for other in rows):continue
            eligible.append((index,row,start,end))
        rng=random.Random('yanlan-meeting-test-v1:'+session['session_id'])
        grouped={}
        for item in eligible:grouped.setdefault(item[1]['speaker'],[]).append(item)
        for group in grouped.values():rng.shuffle(group)
        speakers=sorted(grouped);rng.shuffle(speakers);selected=[]
        while len(selected)<count:
            added=False
            for speaker in speakers:
                if grouped[speaker] and len(selected)<count:selected.append(grouped[speaker].pop());added=True
            if not added:break
        (root/'aishell4'/session['session_id']/'reference-segments.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2),encoding='utf-8')
        for index,row,start,end in selected:
            name=f"{session['session_id']}-{index:04d}";path=root/'aishell4'/'clips'/(name+'.wav');path.parent.mkdir(parents=True,exist_ok=True)
            if not path.exists():
                subprocess.run(['ffmpeg','-v','error','-y','-ss',str(start),'-t',str(end-start),'-i',str(root/session['audio']),'-af','pan=mono|c0=c0','-ar','16000','-acodec','pcm_s16le',str(path)],check=True)
            with wave.open(str(path),'rb') as w:duration=w.getnframes()/w.getframerate();rate=w.getframerate();channels=w.getnchannels()
            all_clips.append({'id':'aishell4:'+name,'dataset':session['dataset'],'revision':session['revision'],'source_split':'test',
                'session_id':session['session_id'],'speaker_id':row['speaker'],'audio':str(path.relative_to(root)).replace('\\','/'),'audio_sha256':sha(path),
                'duration':duration,'sample_rate':rate,'channels':channels,'reference_text':row['text'],'reference_type':'official_TextGrid_nonoverlap_human_transcript',
                'source_audio':session['audio'],'source_audio_sha256':session['audio_sha256'],'source_channel':0,'source_start_seconds':start,'source_end_seconds':end,
                'annotation_start_seconds':row['start_seconds'],'annotation_end_seconds':row['end_seconds'],'overlap_excluded':True})
        summary.append({'session':session['session_id'],'annotated_intervals':len(rows),'speakers':len({r['speaker'] for r in rows}),'eligible_nonoverlap_intervals':len(eligible),'selected':len(selected)})
    (root/'aishell4'/'utterance-manifest.jsonl').write_text(''.join(json.dumps(r,ensure_ascii=False)+'\n' for r in all_clips),encoding='utf-8')
    (root/'aishell4'/'preparation-summary.json').write_text(json.dumps(summary,indent=2),encoding='utf-8')
    print(json.dumps({'sessions':summary,'asr_clips':len(all_clips),'seconds':sum(x['duration'] for x in all_clips)}))

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--root',default='artifacts/hf-asr-benchmark');p.add_argument('--per-session',type=int,default=32);a=p.parse_args();prepare(Path(a.root),a.per_session)
