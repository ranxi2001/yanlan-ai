import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeLongformRuns } from '../scripts/longform-run-merge.mjs';

function round(condition) {
  return {source:condition,result:{complete:true,requests:2,elapsed_milliseconds:1000,cache_hits:0,
    plan:{manifest_sha256:'manifest',model:'model',language:'auto',prompt:'audio_only',concurrency:2,context_projection:{algorithm_sha256:'v1'},
      streams:[{id:'one',kind:'full',split:'development',source_audio_sha256:'audio',pcm_sha256:'pcm',conditions:[{id:condition}]}]},
    runs:[{stream_id:'one',condition}],repeats:[]}};
}
test('combining disjoint window conditions preserves rounds and leaves originals unchanged',()=>{
  const a=round('fixed30'),b=round('fixed60'),r=mergeLongformRuns([a,b]);
  assert.equal(r.requests,4);assert.equal(r.execution_rounds.length,2);
  assert.deepEqual(r.plan.streams[0].conditions.map(c=>c.id),['fixed30','fixed60']);
  assert.equal(a.result.plan.streams[0].conditions.length,1);
});
test('reject changed corpus/model and duplicate or missing conditions/streams',()=>{
  assert.throws(()=>mergeLongformRuns([round('fixed30'),round('fixed30')]),/Duplicate condition/);
  for(const field of ['manifest_sha256','model','language']) {
    const b=round('fixed60');b.result.plan[field]='changed';
    assert.throws(()=>mergeLongformRuns([round('fixed30'),b]),/Incompatible/);
  }
  const b=round('fixed60');b.result.plan.streams[0].pcm_sha256='changed';
  assert.throws(()=>mergeLongformRuns([round('fixed30'),b]),/source mismatch/);
  b.result.plan.streams=[];assert.throws(()=>mergeLongformRuns([round('fixed30'),b]),/coverage mismatch/);
});
