import test from 'node:test';
import assert from 'node:assert/strict';
import {assessAsrCoverage,planAsrCoverageReviews,resolveAsrCoverageReview,runAsrCoverageReview,planCoverageParts} from '../src/asr-coverage-harness.js';

function fixture(text,secondary=text,id=0){
  const window={id,core_start:0,core_end:30,audio_start:0,audio_end:30};
  const record={text,window,status:'completed',quality:{ok:true}};
  const scout={window_id:id,window,speech_seconds:25,parts:[{id:0,start_seconds:0,end_seconds:15,pcm_sha256:'a',text:secondary},{id:1,start_seconds:15,end_seconds:30,pcm_sha256:'b',text:''}]};
  return {record,scout};
}
const reviews=(scout,text)=>scout.parts.map((p,i)=>({...p,text:i?'':text,status:'completed',quality:{ok:true}}));
test('review planning rebalances tiny tails without gaps or dropped audio',()=>{
  for(const duration of [20.096,25,30,35,40]){
    const parts=planCoverageParts({core_start:100,core_end:100+duration},[]);
    assert.equal(parts[0].start_seconds,100);assert.equal(parts.at(-1).end_seconds,100+duration);
    for(const [i,p] of parts.entries()){
      assert.ok(p.end_seconds-p.start_seconds>=10);assert.ok(p.end_seconds-p.start_seconds<=20);
      if(i)assert.equal(p.start_seconds,parts[i-1].end_seconds);
    }
  }
});
test('fluent incomplete output is flagged even when existing quality checks pass',()=>{
  const {record,scout}=fixture('今天讨论采购安排','今天讨论采购安排然后继续讨论工作人员轮班以及仓库盘点具体工作');
  const r=assessAsrCoverage(record,scout);assert.ok(r.reasons.includes('secondary_missing_content'));
});
test('agreed silence does not consume the review budget',()=>{
  const {record,scout}=fixture('');record.quality={ok:false};scout.speech_seconds=0;
  assert.deepEqual(assessAsrCoverage(record,scout).reasons,[]);
});
test('recover omitted interior only when independent ASR corroborates unique anchors',()=>{
  const before='会议开始讨论然后安排执行',after='会议开始讨论采购流程然后安排执行';
  const {record,scout}=fixture(before,after),r=resolveAsrCoverageReview({record,scout,reviews:reviews(scout,after)});
  assert.equal(r.text,after);assert.equal(r.accepted.length,1);assert.equal(r.accepted[0].after,'采购流程');
  const unsupported=fixture(before,before);
  const denied=resolveAsrCoverageReview({...unsupported,reviews:reviews(unsupported.scout,after)});
  assert.equal(denied.text,before);assert.equal(denied.accepted.length,0);
});
test('sensitive changes and unanchored or deletion-only edits retain original content',()=>{
  for(const [before,after] of [['会议开始讨论允许采购然后安排执行','会议开始讨论不允许采购然后安排执行'],
    ['会议开始讨论十五万元然后安排执行','会议开始讨论五十万元然后安排执行'],
    ['会议开始讨论采购采购流程然后安排执行','会议开始讨论采购流程然后安排执行'],
    ['会议开始讨论','会议开始讨论采购流程']]){
    const {record,scout}=fixture(before,after),r=resolveAsrCoverageReview({record,scout,reviews:reviews(scout,after)});
    assert.equal(r.text,before);assert.equal(r.accepted.length,0);
  }
});
test('review must cover same PCM/timeline and incomplete parts cannot overwrite text',()=>{
  const {record,scout}=fixture('会议开始讨论然后安排执行','会议开始讨论采购流程然后安排执行');
  const rs=reviews(scout,scout.parts[0].text);rs[0].pcm_sha256='wrong';
  assert.equal(resolveAsrCoverageReview({record,scout,reviews:rs}).status,'review_failed');
  scout.parts[1].start_seconds=16;assert.throws(()=>assessAsrCoverage(record,scout),/scout part/);
});
test('budgeted harness preserves originals when no review can fit and respects cancellation',async()=>{
  const fixtures=Array.from({length:20},(_,i)=>fixture('开会','开会以后继续讨论工作人员轮班以及仓库盘点具体工作',i));
  const records=fixtures.map(x=>x.record),scouts=fixtures.map(x=>x.scout),plan=planAsrCoverageReviews(records,scouts);
  assert.ok(plan.selected.length>0);assert.ok(plan.budget.selected_requests<=6);assert.ok(plan.budget.selected_audio_seconds<=90);
  const small=await runAsrCoverageReview({records:records.slice(0,1),scouts:scouts.slice(0,1),transcribePart:()=>{throw new Error('Must not call');}});
  assert.equal(small.segments[0].text,'开会');assert.equal(small.plan.selected.length,0);
  const controller=new AbortController();controller.abort();
  await assert.rejects(runAsrCoverageReview({records,scouts,signal:controller.signal,transcribePart:()=>{throw new Error('Must not call');}}),{name:'AbortError'});
});
