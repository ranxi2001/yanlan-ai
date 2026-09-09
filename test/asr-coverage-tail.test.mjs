import test from 'node:test';
import assert from 'node:assert/strict';
import {supplementAsrCoverageTail,runAsrCoverageReviewWithTail} from '../src/asr-coverage-tail.js';
const core='今天会议讨论采购安排还有仓库盘点现在这些事情已经说完了';
function fixture(a,b=a){
  const window={id:0,core_start:0,core_end:30,audio_start:0,audio_end:30};
  const parts=[{id:0,start_seconds:0,end_seconds:15,pcm_sha256:'a',text:b},{id:1,start_seconds:15,end_seconds:30,pcm_sha256:'b',text:''}];
  return {record:{text:core,window,status:'completed',quality:{ok:true}},scout:{window_id:0,window,speech_seconds:28,parts},
    reviews:parts.map((p,i)=>({...p,text:i?'':a,status:'completed',quality:{ok:true}}))};
}
test('append corroborated omitted speech without changing the original prefix',()=>{
  const tail='，然后安排保洁部门清理小广告并把安全通道的垃圾清理干净。';
  const r=supplementAsrCoverageTail(fixture(core+tail));
  assert.ok(r.text.startsWith(core));assert.equal(r.text,core+tail);assert.ok(r.tail_supplement.added_units>=12);
});
test('stop at agreed phrase boundary before the backends disagree',()=>{
  const shared='，然后安排保洁部门清理小广告，';
  const r=supplementAsrCoverageTail(fixture(core+shared+'接下来清理通道。',core+shared+'随后检查仓库。'));
  assert.equal(r.text,core+shared);assert.equal(r.accepted.at(-1).before,'');
});
test('short, unsupported or wrong-audio additions remain unpublished',()=>{
  assert.equal(supplementAsrCoverageTail(fixture(core+'，现在散会。')).text,core);
  assert.equal(supplementAsrCoverageTail(fixture(core+'，然后安排保洁部门清理小广告和垃圾。',core)).text,core);
  const f=fixture(core+'，然后安排保洁部门清理小广告和垃圾。');f.reviews[0].pcm_sha256='wrong';
  assert.equal(supplementAsrCoverageTail(f).text,core);
});
test('live harness calls only budgeted audio parts and publishes reviewed tail output',async()=>{
  const tail='，然后安排保洁部门清理小广告并把安全通道的垃圾清理干净。';
  const cases=Array.from({length:20},(_,i)=>{const f=fixture(core+tail);f.record.window={...f.record.window,id:i};f.scout.window=f.record.window;f.scout.window_id=i;return f;});
  let calls=0;
  const r=await runAsrCoverageReviewWithTail({records:cases.map(f=>f.record),scouts:cases.map(f=>f.scout),
    transcribePart:async p=>{calls++;return {...p,status:'completed',quality:{ok:true},text:p.id===0?core+tail:''};}});
  assert.equal(calls,r.plan.budget.selected_requests);assert.ok(calls<=6);
  assert.ok(r.outcomes.length>0);assert.ok(r.outcomes.every(o=>o.text===core+tail));
});
