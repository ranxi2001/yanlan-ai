import { readFile,writeFile } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { createHash } from 'node:crypto';
import { characterUnits,scoreAsr,aggregateAsrScores } from '../src/asr-benchmark-metrics.js';
import { scoreAsrBoundaryMask } from '../src/asr-boundary-metrics.js';
import { projectAsrContext } from '../src/asr-context-projection.js';
import { reviewAsrContextProposal } from '../src/asr-context-review.js';
import { mergeLongformRuns } from './longform-run-merge.mjs';

const args=process.argv.slice(2),get=f=>args.includes(f)?args[args.indexOf(f)+1]:undefined;
const sha=b=>createHash('sha256').update(b).digest('hex');
const percentile=(values,fraction)=>{
  const sorted=[...values].sort((a,b)=>a-b);
  return sorted.length?sorted[Math.min(sorted.length-1,Math.floor(sorted.length*fraction))]:null;
};
function seamCandidates(segments) {
  const candidates=[];
  for(let i=1;i<segments.length;i++) {
    const a=characterUnits(segments[i-1].text),b=characterUnits(segments[i].text);
    for(let n=Math.min(32,a.length,b.length);n>=4;n--)
      if(a.slice(-n).join('')===b.slice(0,n).join('')){candidates.push({window:i,units:n,text:b.slice(0,n).join('')});break;}
  }
  return candidates;
}
const stamp=t=>`${Math.floor(t/60).toString().padStart(2,'0')}:${Math.floor(t%60).toString().padStart(2,'0')}`;
async function main() {
  const root=resolve(get('--root')||'artifacts/hf-asr-longform'),folder=resolve(get('--output-dir')||join(root,'evaluation'));
  const raw=await readFile(join(root,'prepared-manifest.json'),'utf8'),manifest=JSON.parse(raw);
  const current=JSON.parse(await readFile(join(folder,'runs.json'),'utf8'));
  const baselineFolder=get('--baseline-dir')?resolve(get('--baseline-dir')):null;
  const results=baselineFolder?mergeLongformRuns([
    {source:baselineFolder,result:JSON.parse(await readFile(join(baselineFolder,'runs.json'),'utf8'))},
    {source:folder,result:current},
  ]):current;
  const conditionIds=results.plan.streams[0].conditions.map(c=>c.id);
  if(new Set(conditionIds).size!==conditionIds.length||results.plan.streams.some(s=>JSON.stringify(s.conditions.map(c=>c.id))!==JSON.stringify(conditionIds)))throw new Error('Inconsistent condition coverage');
  if(!results.complete||sha(raw)!==results.plan.manifest_sha256)throw new Error('Incomplete or mismatched run');
  if(sha(await readFile(new URL('../src/asr-context-projection.js',import.meta.url)))!==results.plan.context_projection.algorithm_sha256)throw new Error('Projection algorithm changed after experiment freeze');
  const summaries=[],clean=[],edits=[];
  for(const stream of manifest.streams) {
    const variants=results.runs.filter(r=>r.stream_id===stream.id);
    if(variants.length!==conditionIds.length||new Set(variants.map(r=>r.condition)).size!==conditionIds.length
      ||variants.some(r=>!conditionIds.includes(r.condition)))throw new Error('Missing/duplicate condition');
    const core=variants.find(r=>r.condition==='vad30');
    const boundaries=[...new Set(variants.flatMap(r=>r.records.slice(1).map(x=>x.window.core_start)))];
    let references,refText,mask;
    if(stream.kind==='clean') {
      const data=await readFile(join(root,stream.reference_file));if(sha(data)!==stream.reference_sha256)throw new Error('Reference lock changed');
      references=JSON.parse(data);
      if(references.some((r,i)=>/<[^>]*>/u.test(r.text)||r.start_seconds<0||r.end_seconds>stream.duration+1e-6
        ||references.slice(i+1).some(o=>o.start_seconds<r.end_seconds&&o.end_seconds>r.start_seconds&&o.speaker!==r.speaker)))throw new Error('Invalid clean reference');
      refText=references.map(r=>r.text).join('');
      mask=references.flatMap(r=>characterUnits(r.text).map(()=>boundaries.some(t=>r.start_seconds<t+1&&r.end_seconds>t-1)));
    }
    for(const run of variants) {
      const planned=results.plan.streams.find(s=>s.id===stream.id).conditions.find(c=>c.id===run.condition);
      if(run.records.length!==planned.windows.length||run.segments.length!==planned.windows.length)throw new Error('Incomplete windows');
      for(const [i,r] of run.records.entries())if(r.status!=='completed'||JSON.stringify(r.window)!==JSON.stringify(planned.windows[i]))throw new Error('Invalid request record');
      if(run.condition==='vad30_context2') {
        const replay=run.records.map((r,i)=>projectAsrContext({core:core.records[i],contextual:r}));
        if(JSON.stringify(replay)!==JSON.stringify(run.projections)||replay.some((r,i)=>r.text!==run.segments[i].text))throw new Error('Projection replay mismatch');
      } else if(run.records.some((r,i)=>r.text!==run.segments[i].text))throw new Error('Raw transcript changed');
      const summary={stream_id:stream.id,session_id:stream.session_id,split:stream.split,kind:stream.kind,condition:run.condition,
        audio_seconds:stream.duration,windows:run.records.length,failed_requests:run.records.filter(r=>r.status!=='completed').length,
        submitted_audio_seconds:run.submitted_audio_seconds,summed_request_seconds:run.summed_request_milliseconds/1000,
        request_seconds_median:percentile(run.records.map(r=>r.request_milliseconds/1000),.5),
        request_seconds_p95:percentile(run.records.map(r=>r.request_milliseconds/1000),.95),
        quality_flags:run.records.filter(r=>!r.quality.ok).length,empty_outputs:run.records.filter(r=>!r.text.trim()).length,
        published_empty_windows:run.segments.filter(s=>!s.text.trim()).length,
        silence_cuts:run.records.filter(r=>r.window.boundary_reason==='silence_midpoint').length,
        projected_windows:run.projections.filter(p=>p.changed).length,projection_statuses:Object.fromEntries([...new Set(run.projections.map(p=>p.reason||p.status))].map(reason=>[reason,run.projections.filter(p=>(p.reason||p.status)===reason).length])),
        seam_repetition_candidates:seamCandidates(run.segments),scores:null};
      if(run.condition==='vad30_context2') {
        summary.context_review_gate=run.projections.map((p,i)=>({window_id:i,...reviewAsrContextProposal(core.records[i].text,p)}))
          .filter(r=>r.status==='review_required');
        summary.context_review_note='Post-baseline diagnostic gate. Keeps original core text; experimental candidate scores below are unchanged.';
      }
      if(stream.kind==='clean') {
        const hypothesis=run.segments.map(s=>s.text).join('');
        summary.scores=scoreAsr(refText,hypothesis);
        summary.boundary_alignment=scoreAsrBoundaryMask(refText,hypothesis,mask);
        if(JSON.stringify(summary.scores.cer)!==JSON.stringify(summary.boundary_alignment.overall))throw new Error('Boundary/overall alignment disagree');
        if(run.condition==='vad30_context2') {
          summary.naive_context_concatenation=scoreAsr(refText,run.records.map(r=>r.text).join(''));
          for(const [i,p] of run.projections.entries())if(p.changed) {
            const before=core.segments.map(s=>s.text).join('');
            const single=core.segments.map((s,j)=>i===j?p.text:s.text).join('');
            edits.push({stream_id:stream.id,window_id:i,...p.patch,
              diagnostic_isolated_cer_error_delta:scoreAsr(refText,single).cer.errors-scoreAsr(refText,before).cer.errors,
              note:'Gold used only for offline assessment, never patch selection. Individual deltas need not sum under global alignment.'});
          }
        }
        clean.push(summary);
      }
      summaries.push(summary);
      const publication=run.condition==='vad30_context2'
        ? '实验候选：上下文按唯一锚点投影，尚未完成逐处听音核实，不能作为已审核逐字稿。'
        : '原始 ASR 输出，未做 LLM 润色或纠错。';
      const markdown=[`# ${stream.id} / ${run.condition}`,'',publication+'时间表示音频窗口范围，不是逐词时间；未区分说话人。','',
        ...run.segments.flatMap(s=>[`## ${stamp(s.start_seconds+stream.source_start)}–${stamp(s.end_seconds+stream.source_start)}`,'',s.text,''])].join('\n');
      await writeFile(join(folder,`${stream.id}-${run.condition}.md`),markdown);
    }
  }
  const aggregate=[];
  for(const split of ['development','heldout','all'])for(const condition of conditionIds) {
    const rows=clean.filter(r=>r.condition===condition&&(split==='all'||r.split===split));
    const masked=field=>aggregateAsrScores(rows.map(r=>({scores:{cer:r.boundary_alignment[field],mer:r.boundary_alignment[field]}}))).cer;
    aggregate.push({split,condition,...aggregateAsrScores(rows),audio_seconds:rows.reduce((n,r)=>n+r.audio_seconds,0),
      summed_request_seconds:rows.reduce((n,r)=>n+r.summed_request_seconds,0),submitted_audio_seconds:rows.reduce((n,r)=>n+r.submitted_audio_seconds,0),
      boundary_adjacent_utterance_cer:masked('boundary'),interior_cer:masked('interior')});
  }
  const repeats=results.repeats.map(r=>{
    const condition=r.condition.replace(/_repeat$/u,'');
    const original=results.runs.find(x=>x.stream_id===r.stream_id&&x.condition===condition).records.find(x=>x.window.id===r.window.id);
    if(r.status!=='completed'||r.pcm_sha256!==original.pcm_sha256)throw new Error('Repeat input mismatch');
    return {stream_id:r.stream_id,condition,window_id:r.window.id,...scoreAsr(original.text,r.text).cer,interpretation:'Same-audio output variation; original is not gold.'};
  });
  const baselineCondition=conditionIds.includes('fixed30')?'fixed30':conditionIds[0];
  const base=aggregate.find(r=>r.split==='heldout'&&r.condition===baselineCondition);
  const acceptance=aggregate.filter(r=>r.split==='heldout'&&r.condition!==baselineCondition).map(r=>({condition:r.condition,baseline_condition:baselineCondition,
    relative_cer_reduction:(base.cer.rate-r.cer.rate)/base.cer.rate,
    cer_target_met:r.cer.rate<=base.cer.rate*.9,deletions_not_increased:r.cer.deletions<=base.cer.deletions,
    insertions_not_increased:r.cer.insertions<=base.cer.insertions,
    summed_request_time_ratio:r.summed_request_seconds/base.summed_request_seconds,
    request_time_proxy_target_met:r.summed_request_seconds<=base.summed_request_seconds*1.3,
    full_meeting_quality_verified:false,standalone_wall_time_target_verified:false,
    note:'Pilot subset criteria, not production acceptance. Cost is summed request time, not standalone wall time.'}));
  const report={schema:1,requests:results.requests,elapsed_seconds:results.elapsed_milliseconds/1000,acceptance,
    ...(results.execution_rounds?{execution_rounds:results.execution_rounds,elapsed_note:results.elapsed_note}:{}),
    full_recording_seconds:manifest.streams.filter(s=>s.kind==='full').reduce((n,s)=>n+s.duration,0),
    clean_scoring_seconds:manifest.streams.filter(s=>s.kind==='clean').reduce((n,s)=>n+s.duration,0),aggregate,streams:summaries,isolated_patch_diagnostics:edits,repeats,
    limitations:['CER only on separately decoded continuous nonoverlap spans; does not measure the complete meetings or overlap recognition.',
      'Boundary mask covers entire reference utterances touching +/-1 second around the union of all conditions cuts. No word timestamps assumed.',
      'Seam repetition candidates are lexical alerts, not confirmed duplicated audio; insertions are not necessarily repetitions.',
      'Only one development and one heldout session; no robust statistical generalization claim.',
      'Context condition includes core ASR plus extended ASR costs. Interleaved summed request times are not variant wall times.',
      'Conditions frozen before scoring their run; no LLM rewriting. A later round reuses previously inspected sessions, not a new untouched holdout.',
      ...(baselineFolder?['Historical baseline and new conditions were run in different rounds. Boundary masks are recomputed over all compared cuts; prior boundary percentages have different denominators.']:[])]};
  await writeFile(join(folder,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({requests:report.requests,full_seconds:report.full_recording_seconds,scoring_seconds:report.clean_scoring_seconds,aggregate},null,2));
}
main().catch(e=>{console.error(JSON.stringify({error:'longform_scoring_failed',message:e.message}));process.exitCode=1;});
