import { characterUnits,editCounts } from './asr-benchmark-metrics.js';
import { reviewAsrContextProposal } from './asr-context-review.js';
import { planAsrWindows } from './asr-window-planner.js';

export const COVERAGE_POLICY=Object.freeze({minimumSpeechSeconds:5,minimumDensity:.9,missingUnits:8,missingFraction:.18,
  disagreementRate:.35,maxReviewAudioRatio:.15,maxExtraRequestRatio:.30,anchorUnits:4,maxPatchUnits:64});
const key=text=>characterUnits(text).join('');

export function planCoverageParts(window,speech){
  const start=window.core_start,end=window.core_end;
  const local=speech.filter(s=>s.start<end&&s.end>start).map(s=>({start:Math.max(start,s.start)-start,end:Math.min(end,s.end)-start}));
  const parts=planAsrWindows({duration:end-start,speech:local,targetSeconds:15,minSeconds:10,maxSeconds:20,mode:'vad'})
    .map(p=>({id:p.id,start_seconds:p.core_start+start,end_seconds:p.core_end+start}));
  if(parts.length>1&&parts.at(-1).end_seconds-parts.at(-1).start_seconds<10){
    const previous=parts.at(-2),last=parts.at(-1),middle=(previous.start_seconds+last.end_seconds)/2;
    previous.end_seconds=middle;last.start_seconds=middle;
  }
  return parts;
}

// Original offsets are retained; scoring/reference text is never accepted here.
function units(text){let offset=0;const r=[];for(const c of text){for(const k of characterUnits(c))r.push({key:k,start:offset,end:offset+c.length});offset+=c.length;}return r;}
function alignment(a,b){
  const width=b.length+1,size=(a.length+1)*width;
  if(size>4_000_000)throw new RangeError('Coverage alignment expects short windows');
  const dirs=new Uint8Array(size);
  let prev=Uint32Array.from({length:width},(_,i)=>i),curr=new Uint32Array(width);
  for(let j=1;j<width;j++)dirs[j]=2;
  for(let i=1;i<=a.length;i++){
    curr[0]=i;dirs[i*width]=1;
    for(let j=1;j<width;j++){
      let cost=prev[j-1]+Number(a[i-1]!==b[j-1]),d=0;
      if(prev[j]+1<cost){cost=prev[j]+1;d=1;}if(curr[j-1]+1<cost){cost=curr[j-1]+1;d=2;}
      curr[j]=cost;dirs[i*width+j]=d;
    }[prev,curr]=[curr,prev];
  }
  let i=a.length,j=b.length;const ops=[];
  while(i||j){const d=dirs[i*width+j];if(d===0){ops.push({a:i-1,b:j-1,op:a[i-1]===b[j-1]?'equal':'replace'});i--;j--;}
    else if(d===1){ops.push({a:i-1,b:j,op:'delete'});i--;}else{ops.push({a:i,b:j-1,op:'insert'});j--;}}
  return ops.reverse();
}
function countOccurrences(text,needle){if(!needle)return 0;let count=0,at=0;while((at=text.indexOf(needle,at))>=0){count++;at++;}return count;}

export function assessAsrCoverage(record,scout){
  if(typeof record?.text!=='string'||!scout||record.window.id!==scout.window_id||JSON.stringify(record.window)!==JSON.stringify(scout.window))throw new TypeError('Scout does not match core window');
  validateScout(record,scout);
  const primary=characterUnits(record.text),secondary=characterUnits(scout.parts.map(p=>p.text).join(''));
  const difference=editCounts(primary,secondary),speech=scout.speech_seconds;
  const missing=difference.insertions,disagreement=difference.errors/Math.max(1,secondary.length);
  const reasons=[];
  const supportedSilence=primary.length===0&&secondary.length===0&&speech<.5;
  if(record.status!=='completed'||(record.quality?.ok===false&&!supportedSilence))reasons.push('primary_quality');
  if(speech>=COVERAGE_POLICY.minimumSpeechSeconds&&primary.length/speech<COVERAGE_POLICY.minimumDensity)reasons.push('low_speech_text_coverage');
  if(missing>=COVERAGE_POLICY.missingUnits&&missing/Math.max(1,secondary.length)>=COVERAGE_POLICY.missingFraction)reasons.push('secondary_missing_content');
  if(secondary.length>=20&&disagreement>=COVERAGE_POLICY.disagreementRate)reasons.push('recognizer_disagreement');
  return {window_id:record.window.id,reasons,score:reasons.length?missing+disagreement*20+(reasons.includes('low_speech_text_coverage')?30:0)+(reasons.includes('primary_quality')?50:0):0,
    metrics:{speech_seconds:speech,primary_units:primary.length,secondary_units:secondary.length,secondary_insertions:missing,disagreement_rate:disagreement},
    interpretation:'Disagreement prioritizes audio review; secondary ASR is not ground truth.'};
}

function validateScout(record,scout){
  const w=record.window;
  if(w.audio_start!==w.core_start||w.audio_end!==w.core_end||!Number.isFinite(w.core_start)||!Number.isFinite(w.core_end)||w.core_start<0||w.core_end<=w.core_start
    ||!Array.isArray(scout.parts)||!scout.parts.length||!Number.isFinite(scout.speech_seconds)||scout.speech_seconds<0||scout.speech_seconds>w.core_end-w.core_start+1e-6)
    throw new TypeError('Invalid scout timeline');
  let cursor=w.core_start;
  for(const part of scout.parts){
    if(!Number.isFinite(part.start_seconds)||!Number.isFinite(part.end_seconds)||Math.abs(part.start_seconds-cursor)>1e-6||part.end_seconds<=part.start_seconds
      ||part.end_seconds-part.start_seconds>20.001||typeof part.text!=='string'||!part.pcm_sha256)throw new TypeError('Invalid scout part');
    cursor=part.end_seconds;
  }
  if(Math.abs(cursor-w.core_end)>1e-6)throw new TypeError('Scout coverage gap');
}

export function planAsrCoverageReviews(records,scouts){
  if(records.length!==scouts.length||new Set(records.map(r=>r.window.id)).size!==records.length)throw new TypeError('Incomplete or duplicate windows');
  const risks=records.map(r=>assessAsrCoverage(r,scouts.find(s=>s.window_id===r.window.id)));
  const seconds=records.reduce((n,r)=>n+r.window.core_end-r.window.core_start,0),maxSeconds=seconds*COVERAGE_POLICY.maxReviewAudioRatio;
  const maxRequests=Math.floor(records.length*COVERAGE_POLICY.maxExtraRequestRatio);
  let spentSeconds=0,spentRequests=0;const selected=[],deferred=[];
  for(const risk of [...risks].filter(r=>r.score>0).sort((a,b)=>b.score-a.score||(String(a.window_id)<String(b.window_id)?-1:String(a.window_id)>String(b.window_id)?1:0))){
    const scout=scouts.find(s=>s.window_id===risk.window_id),duration=scout.window.core_end-scout.window.core_start;
    if(spentSeconds+duration>maxSeconds+1e-6||spentRequests+scout.parts.length>maxRequests){deferred.push({...risk,reason:'budget'});continue;}
    selected.push({...risk,parts:scout.parts.map(({text,...part})=>part)});spentSeconds+=duration;spentRequests+=scout.parts.length;
  }
  return {risks,selected,deferred,budget:{max_audio_seconds:maxSeconds,max_requests:maxRequests,selected_audio_seconds:spentSeconds,selected_requests:spentRequests}};
}

export function resolveAsrCoverageReview({record,scout,reviews}){
  if(record.window.id!==scout.window_id||JSON.stringify(record.window)!==JSON.stringify(scout.window))throw new TypeError('Review source differs');
  validateScout(record,scout);
  if(reviews.length!==scout.parts.length||reviews.some((r,i)=>r.status!=='completed'||r.quality?.ok===false||r.pcm_sha256!==scout.parts[i].pcm_sha256
    ||r.start_seconds!==scout.parts[i].start_seconds||r.end_seconds!==scout.parts[i].end_seconds))
    return {text:record.text,candidate_text:null,accepted:[],pending:[],status:'review_failed'};
  const candidate=reviews.map(r=>r.text).join(''),a=units(record.text),b=units(candidate),ops=alignment(a.map(x=>x.key),b.map(x=>x.key));
  const secondary=key(scout.parts.map(p=>p.text).join('')),accepted=[],pending=[];
  let cursor=0;
  while(cursor<ops.length){
    if(ops[cursor].op==='equal'){cursor++;continue;}
    const start=cursor;while(cursor<ops.length&&ops[cursor].op!=='equal')cursor++;
    const changes=ops.slice(start,cursor),ai=changes[0].a,bi=changes[0].b;
    const ae=ai+changes.filter(o=>o.op!=='insert').length,be=bi+changes.filter(o=>o.op!=='delete').length;
    const from=a[ai]?.start??record.text.length,to=ae>ai?a[ae-1].end:from;
    const before=record.text.slice(from,to),after=be>bi?candidate.slice(b[bi].start,b[be-1].end):'';
    const left=ops.slice(Math.max(0,start-COVERAGE_POLICY.anchorUnits),start),right=ops.slice(cursor,cursor+COVERAGE_POLICY.anchorUnits);
    const anchorBefore=left.map(o=>a[o.a]?.key||'').join(''),anchorAfter=right.map(o=>a[o.a]?.key||'').join('');
    const patch={start_offset:from,end_offset:to,before,after,left_anchor:anchorBefore,right_anchor:anchorAfter};
    let reason=null;
    if(!after)reason='deletion_requires_review';
    else if(/[呃嗯啊哦儿]/u.test(key(before)+key(after))&&/^[呃嗯啊哦儿]*$/u.test(key(before)+key(after)))reason='verbatim_filler_change';
    else if(Math.max(ae-ai,be-bi)>COVERAGE_POLICY.maxPatchUnits)reason='large_change';
    else if(left.length!==COVERAGE_POLICY.anchorUnits||right.length!==COVERAGE_POLICY.anchorUnits||[...left,...right].some(o=>o.op!=='equal'))reason='missing_edge_anchor';
    else if(countOccurrences(key(record.text),anchorBefore)!==1||countOccurrences(key(record.text),anchorAfter)!==1)reason='ambiguous_core_anchor';
    else if(countOccurrences(secondary,anchorBefore+key(after)+anchorAfter)!==1)reason='secondary_does_not_corroborate';
    const sensitive=reviewAsrContextProposal(before,{text:after}).risks;
    if(!reason&&sensitive.length)reason='sensitive_content_requires_review';
    if(reason)pending.push({...patch,reason,risks:sensitive});else accepted.push({...patch,evidence:'same_audio_split_mimo_and_sensevoice_exact_local_agreement'});
  }
  let text=record.text;
  for(const patch of [...accepted].reverse())text=text.slice(0,patch.start_offset)+patch.after+text.slice(patch.end_offset);
  return {text,candidate_text:candidate,accepted,pending,status:accepted.length?'repaired':pending.length?'review_required':'unchanged'};
}

export async function runAsrCoverageReview({records,scouts,transcribePart,signal,onReview}){
  if(typeof transcribePart!=='function')throw new TypeError('Audio review callback required');
  const plan=planAsrCoverageReviews(records,scouts),outcomes=[];
  for(const item of plan.selected){
    signal?.throwIfAborted();const record=records.find(r=>r.window.id===item.window_id),scout=scouts.find(s=>s.window_id===item.window_id);
    const reviews=[];for(const part of item.parts){signal?.throwIfAborted();reviews.push(await transcribePart({...part,window_id:item.window_id},signal));}
    const resolution=resolveAsrCoverageReview({record,scout,reviews}),outcome={window_id:item.window_id,risk:item,reviews,...resolution};
    outcomes.push(outcome);await onReview?.(outcome);
  }
  return {plan,outcomes,segments:records.map(r=>({start_seconds:r.window.core_start,end_seconds:r.window.core_end,timing_source:'inferred',
    text:outcomes.find(o=>o.window_id===r.window.id)?.text??r.text,source_window_id:r.window.id}))};
}
