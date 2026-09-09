import test from 'node:test';
import assert from 'node:assert/strict';
import {assessPatchAgainstNonoverlapReference} from '../scripts/asr-patch-gold-diagnostic.mjs';
test('patch diagnosis compares a unique nonoverlap reference gap and excludes overlap',()=>{
  const patch={before:'',after:'采购流程',left_anchor:'开始讨论',right_anchor:'然后安排'},window={core_start:0,core_end:30};
  const refs=[{speaker:'A',start_seconds:2,end_seconds:20,text:'开始讨论采购流程然后安排'}];
  assert.equal(assessPatchAgainstNonoverlapReference(patch,window,refs).error_delta,-4);
  refs.push({speaker:'B',start_seconds:5,end_seconds:10,text:'插话'});
  assert.equal(assessPatchAgainstNonoverlapReference(patch,window,refs).status,'unscored');
});
