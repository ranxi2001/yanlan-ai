import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewAsrContextProposal } from '../src/asr-context-review.js';
test('polarity reversal is flagged and cannot change published text',()=>{
  const core='让家长不放心',r=reviewAsrContextProposal(core,{text:'让家长放心'});
  assert.equal(r.status,'review_required');assert.ok(r.risks.includes('polarity'));assert.equal(r.publish_text,core);
});
test('numeric and identifier disagreements require review',()=>{
  const r=reviewAsrContextProposal('Redis预算15万元',{text:'Redisson预算50万元'});
  assert.ok(r.risks.includes('number'));assert.ok(r.risks.includes('identifier'));
});
test('unchanged negative clauses do not flag unrelated corrections, but no automatic approval',()=>{
  const core='不能修改服物器配置',r=reviewAsrContextProposal(core,{text:'不能修改服务器配置'});
  assert.deepEqual(r.risks,[]);assert.equal(r.status,'review_required');assert.equal(r.publish_text,core);
  assert.equal(reviewAsrContextProposal(core,{text:core}).status,'unchanged');
});
