import {characterUnits,editCounts} from './asr-benchmark-metrics.js';
import {resolveAsrCoverageReview,runAsrCoverageReview} from './asr-coverage-harness.js';
import {reviewAsrContextProposal} from './asr-context-review.js';

export const TAIL_POLICY=Object.freeze({anchorUnits:6,minimumCoreUnits:24,minimumAddedUnits:12,minimumLengthRatio:1.35,maxPrefixDifference:.20,maxSpeechUnitsPerSecond:8});
function units(text){const r=[];let offset=0;for(const c of text){for(const k of characterUnits(c))r.push({key:k,start:offset,end:offset+c.length});offset+=c.length;}return r;}
function uniqueIndex(values,needle){const hits=[];for(let i=0;i<=values.length-needle.length;i++)if(needle.every((x,j)=>x===values[i+j]))hits.push(i);return hits.length===1?hits[0]:-1;}

// A separate development refinement. Keep prior text; append only a long
// agreeing tail from two ASR backends bound to exactly the same audio window.
export function supplementAsrCoverageTail({record,scout,reviews}){
  const base=resolveAsrCoverageReview({record,scout,reviews});
  if(base.status==='review_failed')return base;
  const a=units(record.text),b=units(base.candidate_text||''),secondary=scout.parts.map(p=>p.text).join(''),c=units(secondary);
  if(a.length<TAIL_POLICY.minimumCoreUnits||Math.min(b.length,c.length)<a.length*TAIL_POLICY.minimumLengthRatio)return base;
  const ak=a.map(x=>x.key),bk=b.map(x=>x.key),ck=c.map(x=>x.key),anchor=ak.slice(-TAIL_POLICY.anchorUnits);
  if(uniqueIndex(ak,anchor)!==a.length-anchor.length)return base;
  const bi=uniqueIndex(bk,anchor),ci=uniqueIndex(ck,anchor);
  if(bi<0||ci<0)return base;
  const be=bi+anchor.length,ce=ci+anchor.length;
  if(editCounts(ak,bk.slice(0,be)).rate>TAIL_POLICY.maxPrefixDifference||editCounts(ak,ck.slice(0,ce)).rate>TAIL_POLICY.maxPrefixDifference)return base;
  let common=0;while(be+common<b.length&&ce+common<c.length&&bk[be+common]===ck[ce+common])common++;
  if(common<TAIL_POLICY.minimumAddedUnits||a.length+common>Math.ceil(scout.speech_seconds*TAIL_POLICY.maxSpeechUnitsPerSecond))return base;
  const from=b[be-1].end;let end=b[be+common-1].end;
  while(end<base.candidate_text.length&&/[\s\p{P}]/u.test(base.candidate_text[end]))end++;
  // When the tails disagree later, stop at an agreed phrase punctuation boundary.
  if(be+common<b.length||ce+common<c.length){
    const prefix=base.candidate_text.slice(from,end),punct=[...prefix.matchAll(/[，,。.!！?？；;]/gu)].at(-1);
    if(!punct)return base;end=from+punct.index+punct[0].length;
  }
  const after=base.candidate_text.slice(from,end);
  if(characterUnits(after).length<TAIL_POLICY.minimumAddedUnits)return base;
  const patch={start_offset:record.text.length,end_offset:record.text.length,before:'',after,left_anchor:anchor.join(''),right_anchor:'',
    evidence:'same_audio_short_mimo_and_sensevoice_agree_on_omitted_tail_prefix',new_content_risks:reviewAsrContextProposal('',{text:after}).risks};
  return {...base,text:base.text+after,status:'repaired',accepted:[...base.accepted,patch],
    pending:base.pending.map(p=>p.start_offset===record.text.length&&p.end_offset===record.text.length
      ? {...p,reason:'partially_supported_tail',accepted_prefix:after}:p),
    tail_supplement:{added_units:characterUnits(after).length,core_units:a.length,anchor:anchor.join(''),
      candidate_evidence_start:from,candidate_evidence_end:end,warning:'Agreement supports an append, not independently verified acoustic truth. Existing text is preserved.'}};
}

export async function runAsrCoverageReviewWithTail(options){
  const result=await runAsrCoverageReview({...options,onReview:undefined});
  const outcomes=[];
  for(const old of result.outcomes){
    const record=options.records.find(r=>r.window.id===old.window_id),scout=options.scouts.find(s=>s.window_id===old.window_id);
    const outcome={...old,...supplementAsrCoverageTail({record,scout,reviews:old.reviews})};
    outcomes.push(outcome);await options.onReview?.(outcome);
  }
  return {...result,outcomes,tail_policy:TAIL_POLICY,segments:result.segments.map(s=>({...s,text:outcomes.find(o=>o.window_id===s.source_window_id)?.text??s.text}))};
}
