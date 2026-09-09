import {characterUnits,editCounts} from '../src/asr-benchmark-metrics.js';
const normalized=s=>characterUnits(s).join('');
const occurrences=(text,needle)=>{const result=[];if(!needle)return result;let at=0;while((at=text.indexOf(needle,at))>=0){result.push(at);at++;}return result;};

// Local patch diagnosis only, not full-meeting CER. Gold is never available to
// the inference harness. Exclude complete overlapping/tagged/boundary utterances.
export function assessPatchAgainstNonoverlapReference(patch,window,references){
  const bad=new Set();
  for(const [i,r] of references.entries()){
    if(/<[^>]*>/u.test(r.text)||r.start_seconds<window.core_start||r.end_seconds>window.core_end)bad.add(i);
    for(let j=i+1;j<references.length&&references[j].start_seconds<r.end_seconds;j++)
      if(references[j].speaker!==r.speaker){bad.add(i);bad.add(j);}
  }
  const blocks=[];let current='';
  for(const [i,r] of references.entries()){
    if(bad.has(i)){if(current)blocks.push(current);current='';}
    else current+=normalized(r.text);
  }
  if(current)blocks.push(current);
  const candidates=[];
  for(const text of blocks){
    const left=occurrences(text,patch.left_anchor),right=occurrences(text,patch.right_anchor);
    if(left.length===1&&right.length===1&&right[0]>=left[0]+patch.left_anchor.length)
      candidates.push(text.slice(left[0]+patch.left_anchor.length,right[0]));
  }
  if(candidates.length!==1)return {status:'unscored',reason:'No unique anchors inside a continuous nonoverlap reference block wholly within the window.'};
  const gold=candidates[0],before=editCounts([...gold],characterUnits(patch.before)),after=editCounts([...gold],characterUnits(patch.after));
  return {status:'scored_local_patch',gold,before,after,error_delta:after.errors-before.errors};
}
