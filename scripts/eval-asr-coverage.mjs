import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {DEFAULT_CONFIG,transcribeAudio} from '../src/api.js';
import {parseKeyBackup} from '../src/key-backup.js';
import {assessTranscriptionQuality} from '../src/asr-quality.js';
import {COVERAGE_POLICY,runAsrCoverageReview,planAsrCoverageReviews} from '../src/asr-coverage-harness.js';

const args=process.argv.slice(2),get=f=>args.includes(f)?args[args.indexOf(f)+1]:undefined;
const sha=b=>createHash('sha256').update(b).digest('hex');
function wav(pcm,rate){const h=Buffer.alloc(44);h.write('RIFF');h.writeUInt32LE(pcm.length+36,4);h.write('WAVEfmt ',8);h.writeUInt32LE(16,16);
  h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);h.writeUInt32LE(rate,24);h.writeUInt32LE(rate*2,28);h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(pcm.length,40);return new Blob([h,pcm],{type:'audio/wav'});}
async function main(){
  const root=resolve(get('--root')||'artifacts/hf-asr-coverage'),out=join(root,'review');await mkdir(join(out,'requests'),{recursive:true});
  const baselineRaw=await readFile(join(root,'baseline/runs.json')),scoutRaw=await readFile(join(root,'scout.json'));
  const baseline=JSON.parse(baselineRaw),scout=JSON.parse(scoutRaw),planRaw=await readFile(join(root,'coverage-plan.json')),plan=JSON.parse(planRaw);
  if(!baseline.complete||!scout.complete||scout.plan_sha256!==sha(planRaw)||plan.manifest_sha256!==baseline.plan.manifest_sha256)throw new Error('Incomplete or mismatched sources');
  const groups=new Map(),pcm=new Map();
  for(const stream of plan.streams){
    const path=resolve(root,stream.pcm_file);if(!path.startsWith(root+'/')&&!path.startsWith(root+'\\'))throw new Error('Invalid PCM path');
    const data=await readFile(path);if(sha(data)!==stream.pcm_sha256)throw new Error('PCM changed');pcm.set(stream.id,data);
    const base=baseline.runs.find(r=>r.stream_id===stream.id&&r.condition==='vad30');
    const seen=scout.records.filter(r=>r.stream_id===stream.id);
    if(!base||base.records.length!==stream.windows.length||seen.length!==base.records.length||new Set(seen.map(s=>s.window_id)).size!==seen.length)throw new Error('Scout coverage mismatch');
    const groupKey=stream.kind+':'+stream.split;if(!groups.has(groupKey))groups.set(groupKey,{id:groupKey,records:[],scouts:[]});
    const group=groups.get(groupKey);
    for(const r of base.records){
      const s=seen.find(s=>s.window_id===r.window.id),w=stream.windows.find(w=>w.window.id===r.window.id);
      if(!s||s.source_pcm_sha256!==stream.pcm_sha256||JSON.stringify(s.window)!==JSON.stringify(r.window)
        ||JSON.stringify(w.window)!==JSON.stringify(r.window)||s.parts.length!==w.parts.length)throw new Error('Window source mismatch');
      for(const [i,part] of s.parts.entries()){
        if(part.id!==w.parts[i].id||part.start_seconds!==w.parts[i].start_seconds||part.end_seconds!==w.parts[i].end_seconds)throw new Error('Scout part mismatch');
        const chunk=data.subarray(Math.round(part.start_seconds*stream.sample_rate)*2,Math.round(part.end_seconds*stream.sample_rate)*2);
        if(sha(chunk)!==part.pcm_sha256)throw new Error('Scout audio mismatch');
      }
      const id=stream.id+':'+r.window.id,window={...r.window,id};
      group.records.push({...r,window,source_window_id:r.window.id});
      group.scouts.push({...s,window_id:id,window,parts:s.parts.map(p=>({...p,stream_id:stream.id}))});
    }
  }
  const experiment={schema:1,baseline_sha256:sha(baselineRaw),scout_sha256:sha(scoutRaw),policy:COVERAGE_POLICY,
    algorithm_sha256:sha(await readFile(new URL('../src/asr-coverage-harness.js',import.meta.url))),
    review_gate_sha256:sha(await readFile(new URL('../src/asr-context-review.js',import.meta.url))),
    metrics_sha256:sha(await readFile(new URL('../src/asr-benchmark-metrics.js',import.meta.url))),
    window_planner_sha256:sha(await readFile(new URL('../src/asr-window-planner.js',import.meta.url))),
    grouping:'Budget pooled by full/clean and development/heldout; no scores or references used.',
    groups:[...groups.values()].map(g=>({id:g.id,...planAsrCoverageReviews(g.records,g.scouts)}))};
  const frozen=join(out,'experiment.json');try{if((await readFile(frozen,'utf8'))!==JSON.stringify(experiment,null,2))throw new Error('Review experiment changed; use fresh output');}
  catch(e){if(e.code!=='ENOENT')throw e;await writeFile(frozen,JSON.stringify(experiment,null,2));}
  if(args.includes('--dry-run')){console.log(JSON.stringify(experiment.groups.map(g=>({group:g.id,selected:g.selected.length,budget:g.budget}))));return;}
  const keys=parseKeyBackup((await readFile(resolve(get('--keys')),'utf8')).replace(/^\uFEFF/u,'')),config={...DEFAULT_CONFIG,asrApiKey:keys.mimo,asrModel:baseline.plan.model};
  let completed=0,cached=0;const started=Date.now(),queue=[...groups.values()],results=[];
  async function transcribePart(part){
    const source=plan.streams.find(s=>s.id===part.stream_id),bytes=pcm.get(part.stream_id);
    const chunk=bytes.subarray(Math.round(part.start_seconds*source.sample_rate)*2,Math.round(part.end_seconds*source.sample_rate)*2);
    if(sha(chunk)!==part.pcm_sha256)throw new Error('Review PCM differs from scout');
    const path=join(out,'requests',part.window_id.replaceAll(':','_')+'-'+part.id+'.json');let record;
    try{record=JSON.parse(await readFile(path,'utf8'));if(record.pcm_sha256!==part.pcm_sha256)throw new Error('Cache mismatch');if(record.status!=='completed')record=null;else cached++;}catch(e){if(e.code!=='ENOENT')throw e;}
    if(!record){
      const began=Date.now();let response,failure;
      try{response=await transcribeAudio({config,blob:wav(chunk,source.sample_rate),language:baseline.plan.language,signal:AbortSignal.timeout(120000)});}
      catch(e){failure={code:e.code||null,status:e.status||null};}
      record={...part,text:response?.text||'',status:response?'completed':'failed',request_milliseconds:Date.now()-began,
        finish_reason:response?.raw?.choices?.[0]?.finish_reason??null,usage:response?.raw?.usage??null,
        quality:assessTranscriptionQuality(response?.text||'',part.end_seconds-part.start_seconds),...(response?{}:{failure})};
      await writeFile(path+'.tmp',JSON.stringify(record));await rename(path+'.tmp',path);
    }
    completed++;if(completed%5===0)console.log(JSON.stringify({review_requests:completed,cache_hits:cached}));return record;
  }
  async function worker(){while(queue.length){const group=queue.shift();results.push({id:group.id,...await runAsrCoverageReview({records:group.records,scouts:group.scouts,transcribePart})});}}
  await Promise.all([worker(),worker()]);
  const report={schema:1,experiment,complete:results.every(g=>g.outcomes.every(o=>o.reviews.every(r=>r.status==='completed'))),groups:results,
    elapsed_seconds:(Date.now()-started)/1000,requests:completed,cache_hits:cached,baseline_elapsed_seconds:baseline.elapsed_milliseconds/1000,scout_elapsed_seconds:scout.elapsed_seconds};
  await writeFile(join(out,'runs.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({complete:report.complete,requests:completed,seconds:report.elapsed_seconds,accepted:results.reduce((n,g)=>n+g.outcomes.reduce((m,o)=>m+o.accepted.length,0),0)}));
  if(!report.complete)throw new Error('Some review requests failed; rerun to resume');
}
main().catch(e=>{console.error(JSON.stringify({error:'coverage_review_failed',message:e.message?.replace(/sk-[A-Za-z0-9_-]+/gu,'[redacted]')}));process.exitCode=1;});
