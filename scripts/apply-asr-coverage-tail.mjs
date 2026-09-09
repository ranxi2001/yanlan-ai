import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {supplementAsrCoverageTail,TAIL_POLICY} from '../src/asr-coverage-tail.js';
const args=process.argv.slice(2),get=f=>args.includes(f)?args[args.indexOf(f)+1]:undefined;
const sha=b=>createHash('sha256').update(b).digest('hex');
const root=resolve(get('--root')||'artifacts/hf-asr-coverage'),started=Date.now();
const oldRaw=await readFile(join(root,'review/runs.json')),old=JSON.parse(oldRaw),baseRaw=await readFile(join(root,'baseline/runs.json')),scoutRaw=await readFile(join(root,'scout.json'));
const baseline=JSON.parse(baseRaw),scout=JSON.parse(scoutRaw);
if(!old.complete||sha(baseRaw)!==old.experiment.baseline_sha256||sha(scoutRaw)!==old.experiment.scout_sha256)throw new Error('Sources changed');
const groups=old.groups.map(g=>{
  const outcomes=g.outcomes.map(o=>{
    const r=baseline.runs.flatMap(run=>run.records).find(r=>r.stream_id+':'+r.window.id===o.window_id),s=scout.records.find(s=>s.stream_id+':'+s.window_id===o.window_id);
    const window={...r.window,id:o.window_id};
    return {...o,...supplementAsrCoverageTail({record:{...r,window},scout:{...s,window_id:o.window_id,window,parts:s.parts.map(p=>({...p,stream_id:s.stream_id}))},reviews:o.reviews})};
  });
  return {...g,outcomes,segments:g.segments.map(s=>({...s,text:outcomes.find(o=>o.window_id===s.source_window_id)?.text??s.text}))};
});
const output=join(root,'review-tail');await mkdir(output,{recursive:true});
const result={...old,groups,tail_refinement:{policy:TAIL_POLICY,algorithm_sha256:sha(await readFile(new URL('../src/asr-coverage-tail.js',import.meta.url))),
  source_review_sha256:sha(oldRaw),processing_milliseconds:Date.now()-started,
  provenance:'Developed after observing a missed tail on development gold; replayed on previously scored heldout data. Not a new untouched holdout or new ASR run.'}};
await writeFile(join(output,'runs.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({tail_supplements:groups.reduce((n,g)=>n+g.outcomes.filter(o=>o.tail_supplement).length,0),extra_asr_requests:0}));
