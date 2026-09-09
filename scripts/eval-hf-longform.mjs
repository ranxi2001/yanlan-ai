import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { DEFAULT_CONFIG, transcribeAudio } from '../src/api.js';
import { parseKeyBackup } from '../src/key-backup.js';
import { planAsrWindows } from '../src/asr-window-planner.js';
import { assessTranscriptionQuality } from '../src/asr-quality.js';
import { projectAsrContext } from '../src/asr-context-projection.js';

const args=process.argv.slice(2),get=f=>args.includes(f)?args[args.indexOf(f)+1]:undefined;
const sha=b=>createHash('sha256').update(b).digest('hex');
const availableSpecs=[
  { id:'fixed30',mode:'fixed',targetSeconds:30,minSeconds:30,maxSeconds:30,contextSeconds:0 },
  { id:'vad30',mode:'vad',targetSeconds:30,minSeconds:20,maxSeconds:40,contextSeconds:0 },
  { id:'vad30_context2',mode:'vad',targetSeconds:30,minSeconds:20,maxSeconds:40,contextSeconds:2 },
  { id:'fixed60',mode:'fixed',targetSeconds:60,minSeconds:60,maxSeconds:60,contextSeconds:0 },
  { id:'vad60',mode:'vad',targetSeconds:60,minSeconds:40,maxSeconds:80,contextSeconds:0 },
];
function wav(pcm,rate) {
  const h=Buffer.alloc(44);h.write('RIFF');h.writeUInt32LE(pcm.length+36,4);h.write('WAVEfmt ',8);
  h.writeUInt32LE(16,16);h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);h.writeUInt32LE(rate,24);
  h.writeUInt32LE(rate*2,28);h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(pcm.length,40);
  return new Blob([h,pcm],{type:'audio/wav'});
}
async function main() {
  const requested=(get('--conditions')||'fixed30,vad30,vad30_context2').split(',');
  if(new Set(requested).size!==requested.length||requested.some(id=>!availableSpecs.some(s=>s.id===id))
    ||(requested.includes('vad30_context2')&&!requested.includes('vad30')))throw new Error('Invalid conditions or missing context core');
  const specs=availableSpecs.filter(s=>requested.includes(s.id));
  const root=resolve(get('--root')||'artifacts/hf-asr-longform'),output=resolve(get('--output-dir')||join(root,'evaluation'));
  const raw=await readFile(join(root,'prepared-manifest.json'),'utf8'),manifest=JSON.parse(raw);
  const pcm=new Map();
  for(const stream of manifest.streams) {
    const path=resolve(root,stream.pcm_file);if(!path.startsWith(root+'\\')&&!path.startsWith(root+'/'))throw new Error('Audio path outside root');
    const bytes=await readFile(path);
    if(sha(bytes)!==stream.pcm_sha256||bytes.length!==Math.round(stream.duration*stream.sample_rate)*2)throw new Error('PCM lock mismatch');
    pcm.set(stream.id,bytes);
  }
  const plan={schema:1,manifest_sha256:sha(raw),model:DEFAULT_CONFIG.asrModel,language:'auto',prompt:'audio_only',concurrency:2,
    context_projection:{anchor_units:8,max_change_rate:.15,algorithm_sha256:sha(await readFile(new URL('../src/asr-context-projection.js',import.meta.url)))},
    streams:manifest.streams.map(s=>({id:s.id,kind:s.kind,split:s.split,source_audio_sha256:s.source_audio_sha256,pcm_sha256:s.pcm_sha256,
      conditions:specs.map(spec=>({...spec,windows:planAsrWindows({...spec,duration:s.duration,speech:s.speech})}))})),
    reference_policy:'No reference read by this inference runner. Full sessions are not scored by serializing overlapping annotations.'};
  await mkdir(join(output,'requests'),{recursive:true});
  const planPath=join(output,'experiment.json');
  try {if((await readFile(planPath,'utf8'))!==JSON.stringify(plan,null,2))throw new Error('Experiment differs; choose new output directory');}
  catch(e){if(e.code!=='ENOENT')throw e;await writeFile(planPath,JSON.stringify(plan,null,2));}
  const tasks=[];
  for(const stream of plan.streams) {
    for(let i=0;i<Math.max(...stream.conditions.map(c=>c.windows.length));i++)
      for(const c of stream.conditions)if(c.windows[i])tasks.push({stream_id:stream.id,condition:c.id,window:c.windows[i]});
    // Two blind repeats on full recordings estimate API variation on unchanged audio.
    const fixed=stream.conditions.find(c=>c.mode==='fixed');
    if(stream.kind==='full'&&fixed)for(const i of new Set([0,Math.floor(fixed.windows.length/2)]))
      tasks.push({stream_id:stream.id,condition:fixed.id+'_repeat',window:fixed.windows[i]});
  }
  if(args.includes('--dry-run')){console.log(JSON.stringify({streams:plan.streams.length,requests:tasks.length}));return;}
  const keys=parseKeyBackup((await readFile(resolve(get('--keys')),'utf8')).replace(/^\uFEFF/u,''));
  const config={...DEFAULT_CONFIG,asrApiKey:keys.mimo};
  const records=[];let cursor=0,completed=0,cacheHits=0;const started=Date.now();
  async function worker() {
    while(cursor<tasks.length) {
      const task=tasks[cursor++],stream=manifest.streams.find(s=>s.id===task.stream_id),bytes=pcm.get(stream.id);
      const chunk=bytes.subarray(Math.round(task.window.audio_start*stream.sample_rate)*2,Math.round(task.window.audio_end*stream.sample_rate)*2);
      const audioHash=sha(chunk),path=join(output,'requests',`${task.stream_id}-${task.condition}-${task.window.id}.json`);
      let record;
      try {record=JSON.parse(await readFile(path,'utf8'));
        if(record.pcm_sha256!==audioHash||record.stream_id!==task.stream_id||record.condition!==task.condition||JSON.stringify(record.window)!==JSON.stringify(task.window))throw new Error('Cached request mismatch');
        if(record.status!=='completed')record=null;else cacheHits++;
      }catch(e){if(e.code!=='ENOENT')throw e;}
      if(!record) {
        const began=Date.now();let result,failure,attempts=0;
        for(;attempts<3;) {
          attempts++;
          try {result=await transcribeAudio({config,blob:wav(chunk,stream.sample_rate),language:'auto',signal:AbortSignal.timeout(120000)});break;}
          catch(e){failure={code:String(e.code||'request_failed'),status:e.status||null};if(!e.retryable)break;}
        }
        const text=result?.text||result?.segments?.map(s=>s.text).join('')||'';
        record={...task,pcm_sha256:audioHash,text,status:result?'completed':'failed',attempts,request_milliseconds:Date.now()-began,
          quality:assessTranscriptionQuality(text,chunk.length/stream.sample_rate/2),...(result?{}:{failure})};
        await writeFile(path+'.tmp',JSON.stringify(record));await rename(path+'.tmp',path);
      }
      records.push(record);completed++;
      if(completed%10===0||completed===tasks.length)console.log(JSON.stringify({completed,total:tasks.length,cache_hits:cacheHits,elapsed_seconds:(Date.now()-started)/1000}));
    }
  }
  await Promise.all([worker(),worker()]);
  const runs=[];
  for(const stream of plan.streams) {
    const byCondition=id=>records.filter(r=>r.stream_id===stream.id&&r.condition===id).sort((a,b)=>a.window.id-b.window.id);
    const core=byCondition('vad30');
    for(const c of stream.conditions) {
      const list=byCondition(c.id);
      const projections=c.id==='vad30_context2'?list.map((r,i)=>projectAsrContext({core:core[i],contextual:r})):[];
      const segments=list.map((r,i)=>({start_seconds:r.window.core_start,end_seconds:r.window.core_end,
        text:projections[i]?.text??r.text,timing_source:'inferred',source_window_id:r.window.id}));
      runs.push({stream_id:stream.id,condition:c.id,records:list,segments,projections,
        summed_request_milliseconds:list.reduce((n,r)=>n+r.request_milliseconds,0)+(c.id==='vad30_context2'?core.reduce((n,r)=>n+r.request_milliseconds,0):0),
        submitted_audio_seconds:list.reduce((n,r)=>n+r.window.audio_end-r.window.audio_start,0)+(c.id==='vad30_context2'?core.reduce((n,r)=>n+r.window.audio_end-r.window.audio_start,0):0)});
    }
  }
  const result={schema:1,plan,complete:records.every(r=>r.status==='completed'),requests:records.length,cache_hits:cacheHits,
    elapsed_milliseconds:Date.now()-started,runs,repeats:records.filter(r=>r.condition.endsWith('_repeat'))};
  await writeFile(join(output,'runs.json'),JSON.stringify(result,null,2));
  if(!result.complete)throw new Error('Incomplete ASR requests; rerun to retry failures');
  console.log(JSON.stringify({complete:true,requests:records.length,elapsed_seconds:result.elapsed_milliseconds/1000}));
}
main().catch(e=>{console.error(JSON.stringify({error:'longform_eval_failed',message:e.message?.replace(/sk-[A-Za-z0-9_-]+/gu,'[redacted]'),code:e.code||null}));process.exitCode=1;});
