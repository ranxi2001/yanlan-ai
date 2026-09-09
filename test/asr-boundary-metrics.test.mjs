import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreAsrBoundaryMask } from '../src/asr-boundary-metrics.js';
import { characterUnits,scoreAsr } from '../src/asr-benchmark-metrics.js';

test('masked alignment preserves S/D/I accounting and shared CER definition',()=>{
  for(const [ref,hyp] of [['甲乙丙丁','甲错丁多'],['A中１２','a中12!'],['','插入'],['',''],['删除',''],['对对对','对对'],['混合English语音','混和english声音']]) {
    const mask=characterUnits(ref).map((_,i)=>i%2===0),r=scoreAsrBoundaryMask(ref,hyp,mask);
    assert.deepEqual(r.overall,scoreAsr(ref,hyp).cer);
    assert.equal(r.boundary.errors+r.interior.errors,r.overall.errors);
  }
});
test('an insertion is charged to the preceding reference unit without changing text',()=>{
  const r=scoreAsrBoundaryMask('甲乙','甲插乙',[true,false]);
  assert.equal(r.boundary.insertions,1);assert.equal(r.interior.errors,0);
  assert.throws(()=>scoreAsrBoundaryMask('甲','乙',[]),/mask/);
});
