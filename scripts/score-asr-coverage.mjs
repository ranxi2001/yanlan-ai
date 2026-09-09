import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {scoreAsr,aggregateAsrScores} from '../src/asr-benchmark-metrics.js';
import {planAsrCoverageReviews,resolveAsrCoverageReview} from '../src/asr-coverage-harness.js';
import {assessPatchAgainstNonoverlapReference} from './asr-patch-gold-diagnostic.mjs';
import {supplementAsrCoverageTail} from '../src/asr-coverage-tail.js';
const args=process.argv.slice(2),get=f=>args.includes(f)?args[args.indexOf(f)+1]:undefined;
const sha=b=>createHash('sha256').update(b).digest('hex');
const stamp=t=>`${Math.floor(t/60).toString().padStart(2,'0')}:${Math.floor(t%60).toString().padStart(2,'0')}`;
async function main(){
  const root=resolve(get('--root')||'artifacts/hf-asr-coverage'),out=resolve(get('--review-dir')||join(root,'review'));
  const baseRaw=await readFile(join(root,'baseline/runs.json')),scoutRaw=await readFile(join(root,'scout.json'));
  const baseline=JSON.parse(baseRaw),scout=JSON.parse(scoutRaw),review=JSON.parse(await readFile(join(out,'runs.json'),'utf8'));
  const raw=await readFile(join(root,'prepared-manifest.json')),manifest=JSON.parse(raw);
  let initialScout=null;
  try{initialScout=JSON.parse(await readFile(join(root,'scout-initial.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  if(!review.complete||!baseline.complete||!scout.complete||sha(baseRaw)!==review.experiment.baseline_sha256||sha(scoutRaw)!==review.experiment.scout_sha256
    ||sha(raw)!==baseline.plan.manifest_sha256)throw new Error('Incomplete or changed experiment');
  for(const [file,expected] of [['asr-coverage-harness.js',review.experiment.algorithm_sha256],['asr-context-review.js',review.experiment.review_gate_sha256],['asr-benchmark-metrics.js',review.experiment.metrics_sha256],['asr-window-planner.js',review.experiment.window_planner_sha256]])
    if(sha(await readFile(new URL('../src/'+file,import.meta.url)))!==expected)throw new Error('Frozen algorithm changed');
  if(review.tail_refinement&&sha(await readFile(new URL('../src/asr-coverage-tail.js',import.meta.url)))!==review.tail_refinement.algorithm_sha256)throw new Error('Tail algorithm changed');
  const outcomes=new Map(review.groups.flatMap(g=>g.outcomes.map(o=>[o.window_id,o]))),allRecords=new Map(),allScouts=new Map();
  for(const run of baseline.runs)for(const r of run.records){
    const id=run.stream_id+':'+r.window.id,source=scout.records.find(s=>s.stream_id===run.stream_id&&s.window_id===r.window.id);
    if(!source)throw new Error('Missing scout');
    const window={...r.window,id};allRecords.set(id,{...r,window,source_window_id:r.window.id});
    allScouts.set(id,{...source,window_id:id,window,parts:source.parts.map(p=>({...p,stream_id:run.stream_id}))});
  }
  for(const group of review.groups){
    const ids=manifest.streams.filter(s=>s.kind+':'+s.split===group.id).flatMap(s=>baseline.runs.find(r=>r.stream_id===s.id).records.map(r=>s.id+':'+r.window.id));
    const plan=planAsrCoverageReviews(ids.map(id=>allRecords.get(id)),ids.map(id=>allScouts.get(id)));
    if(JSON.stringify(plan)!==JSON.stringify(group.plan))throw new Error('Risk selection changed');
    if(group.outcomes.length!==plan.selected.length||new Set(group.outcomes.map(o=>o.window_id)).size!==group.outcomes.length)throw new Error('Incomplete reviews');
    for(const o of group.outcomes){
      if(!plan.selected.some(s=>s.window_id===o.window_id))throw new Error('Unplanned review');
      const replay=(review.tail_refinement?supplementAsrCoverageTail:resolveAsrCoverageReview)({record:allRecords.get(o.window_id),scout:allScouts.get(o.window_id),reviews:o.reviews});
      for(const k of ['text','candidate_text','accepted','pending','status'])if(JSON.stringify(replay[k])!==JSON.stringify(o[k]))throw new Error('Repair replay changed');
    }
    if(group.segments.length!==ids.length||group.segments.some((s,i)=>s.source_window_id!==ids[i]||s.text!==(outcomes.get(ids[i])?.text??allRecords.get(ids[i]).text)))throw new Error('Published text differs');
  }
  const streams=[],patches=[],windowDiagnostics=[],fullPatchDiagnostics=[];
  for(const source of manifest.streams){
    const base=baseline.runs.find(r=>r.stream_id===source.id),ids=base.records.map(r=>source.id+':'+r.window.id);
    const results=ids.map(id=>outcomes.get(id));
    const original=base.segments.map(s=>s.text).join(''),final=base.segments.map((s,i)=>results[i]?.text??s.text).join('');
    const candidate=base.segments.map((s,i)=>results[i]?.candidate_text??s.text).join('');
    const summary={id:source.id,split:source.split,kind:source.kind,audio_seconds:source.duration,baseline_windows:base.records.length,
      selected_windows:results.filter(Boolean).length,review_requests:results.reduce((n,o)=>n+(o?.reviews.length||0),0),
      baseline_request_seconds:base.summed_request_milliseconds/1000,
      scout_seconds:scout.records.filter(r=>r.stream_id===source.id).reduce((n,r)=>n+r.elapsed_milliseconds,0)/1000,
      review_request_seconds:results.reduce((n,o)=>n+(o?.reviews.reduce((m,r)=>m+r.request_milliseconds,0)||0),0)/1000,
      accepted_patches:results.reduce((n,o)=>n+(o?.accepted.length||0),0),pending_patches:results.reduce((n,o)=>n+(o?.pending.length||0),0),scores:null};
    if(source.kind==='full'&&summary.accepted_patches){
      const refRaw=await readFile(join(root,source.reference_file));if(sha(refRaw)!==source.reference_sha256)throw new Error('Reference changed');
      const refs=JSON.parse(refRaw);
      for(const [i,o] of results.entries())if(o)for(const p of o.accepted)
        fullPatchDiagnostics.push({stream_id:source.id,split:source.split,window_id:i,...p,...assessPatchAgainstNonoverlapReference(p,base.records[i].window,refs)});
    }
    if(source.kind==='clean'){
      const refRaw=await readFile(join(root,source.reference_file));if(sha(refRaw)!==source.reference_sha256)throw new Error('Reference changed');
      const refs=JSON.parse(refRaw);
      if(refs.some((r,i)=>/<[^>]*>/u.test(r.text)||r.start_seconds<0||r.end_seconds>source.duration+1e-6
        ||refs.slice(i+1).some(o=>o.speaker!==r.speaker&&o.start_seconds<r.end_seconds&&o.end_seconds>r.start_seconds)))throw new Error('Invalid clean reference');
      const ref=refs.map(r=>r.text).join('');summary.scores={baseline:scoreAsr(ref,original),repaired:scoreAsr(ref,final),ungated_candidate:scoreAsr(ref,candidate)};
      for(const [i,o] of results.entries())if(o){
        const isolated=base.segments.map((s,j)=>j===i?(o.candidate_text??s.text):s.text).join('');
        const isolatedFinal=base.segments.map((s,j)=>j===i?o.text:s.text).join('');
        windowDiagnostics.push({stream_id:source.id,split:source.split,window_id:i,risk:o.risk,
          candidate_error_delta:scoreAsr(ref,isolated).cer.errors-summary.scores.baseline.cer.errors,
          repaired_error_delta:scoreAsr(ref,isolatedFinal).cer.errors-summary.scores.baseline.cer.errors});
        for(const p of o.accepted){
          const text=base.segments[i].text,changed=text.slice(0,p.start_offset)+p.after+text.slice(p.end_offset);
          const full=base.segments.map((s,j)=>i===j?changed:s.text).join('');
          patches.push({stream_id:source.id,split:source.split,window_id:i,...p,isolated_error_delta:scoreAsr(ref,full).cer.errors-summary.scores.baseline.cer.errors});
        }
      }
    }
    streams.push(summary);
    for(const [label,segments] of [['baseline',base.segments],['repaired',base.segments.map((s,i)=>({...s,text:results[i]?.text??s.text}))]]){
      const markdown=[`# ${source.id} / ${label}`,'','ASR 逐字稿；未做 LLM 润色，时间为音频窗口范围，未区分说话人。修复版仅接纳局部双路文本证据支持的非敏感候选，仍需听音核实。','',
        ...segments.flatMap(s=>[`## ${stamp(s.start_seconds+source.source_start)}–${stamp(s.end_seconds+source.source_start)}`,'',s.text,''])].join('\n');
      await writeFile(join(out,source.id+'-'+label+'.md'),markdown);
    }
  }
  const aggregate=[];
  for(const split of ['development','heldout','all'])for(const variant of ['baseline','repaired','ungated_candidate']){
    const rows=streams.filter(s=>s.kind==='clean'&&(split==='all'||s.split===split));
    aggregate.push({split,variant,...aggregateAsrScores(rows.map(r=>({scores:r.scores[variant]})))});
  }
  const report={schema:1,aggregate,streams,patches,window_diagnostics:windowDiagnostics,full_patch_diagnostics:fullPatchDiagnostics,
    ...(review.tail_refinement?{tail_refinement:review.tail_refinement}:{}),
    budgets:review.groups.map(g=>({group:g.id,...g.plan.budget,flagged_windows:g.plan.risks.filter(r=>r.score>0).length,selected_windows:g.plan.selected.length})),
    timings:{baseline_wall_seconds:review.baseline_elapsed_seconds,scout_wall_seconds:review.scout_elapsed_seconds,review_wall_seconds:review.elapsed_seconds,
      discarded_initial_scout_wall_seconds:initialScout?.elapsed_seconds??0,
      added_review_wall_ratio:review.elapsed_seconds/review.baseline_elapsed_seconds,
      sequential_scout_and_review_ratio:(review.scout_elapsed_seconds+review.elapsed_seconds)/review.baseline_elapsed_seconds,
      note:'Initial scouting overlapped baseline; balanced scouting was rerun after baseline during development. Individual stage wall times are measured, not standalone end-to-end product latency.'},
    requests:{baseline:baseline.requests,remote_review:review.requests,local_scout_parts:scout.records.reduce((n,s)=>n+s.parts.length,0),
      discarded_initial_scout_parts:initialScout?.records.reduce((n,s)=>n+s.parts.length,0)??0},
    limitations:['CER only on continuous annotated nonoverlap spans; full meetings are transcribed but not assigned serialized-reference CER.',
      'One development session and two new heldout sessions; selected clean coverage is small. No robust population confidence interval.',
      'Local ASR agreement is evidence, not truth; sensitive and deletion-only changes remain pending.',
      'Ungated candidate is an offline diagnostic, not the published output. All gold references are used after inference and decisions.',
      'Isolated patch/window error deltas can interact under global alignment and need not sum exactly.']};
  await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({aggregate,requests:report.requests,timings:report.timings,patches:patches.length},null,2));
}
main().catch(e=>{console.error(JSON.stringify({error:'coverage_scoring_failed',message:e.message}));process.exitCode=1;});
