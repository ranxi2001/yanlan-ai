import { readFile,writeFile } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { createHash } from 'node:crypto';
import { planCoverageParts } from '../src/asr-coverage-harness.js';
const args=process.argv.slice(2),get=f=>args.includes(f)?args[args.indexOf(f)+1]:undefined;
const sha=b=>createHash('sha256').update(b).digest('hex');
const root=resolve(get('--root')||'artifacts/hf-asr-coverage');
const raw=await readFile(join(root,'prepared-manifest.json'),'utf8'),manifest=JSON.parse(raw);
const base=JSON.parse(await readFile(join(root,'baseline/experiment.json'),'utf8'));
if(sha(raw)!==base.manifest_sha256)throw new Error('Baseline source changed');
const streams=manifest.streams.map(stream=>({id:stream.id,kind:stream.kind,split:stream.split,duration:stream.duration,
  pcm_file:stream.pcm_file,pcm_sha256:stream.pcm_sha256,sample_rate:stream.sample_rate,
  windows:base.streams.find(s=>s.id===stream.id).conditions.find(c=>c.id==='vad30').windows.map(window=>{
    const speech=stream.speech.filter(s=>s.start<window.core_end&&s.end>window.core_start)
      .map(s=>({start:Math.max(s.start,window.core_start)-window.core_start,end:Math.min(s.end,window.core_end)-window.core_start}));
    const parts=planCoverageParts(window,stream.speech);
    return {window,speech_seconds:speech.reduce((n,s)=>n+s.end-s.start,0),parts};
  })}));
await writeFile(join(root,'coverage-plan.json'),JSON.stringify({schema:1,manifest_sha256:sha(raw),model:'sensevoice-small-int8',
  purpose:'Reference-free local scout; same disjoint short spans reused for remote review.',streams},null,2));
console.log(JSON.stringify({streams:streams.length,scout_parts:streams.reduce((n,s)=>n+s.windows.reduce((m,w)=>m+w.parts.length,0),0)}));
