// Combine disjoint conditions without silently mixing audio, models or rounds.
export function mergeLongformRuns(rounds) {
  if(!Array.isArray(rounds)||!rounds.length)throw new TypeError('No experiment rounds');
  const first=rounds[0].result;
  const signature=p=>JSON.stringify([p.manifest_sha256,p.model,p.language,p.prompt,p.concurrency,p.context_projection]);
  const streamSignature=s=>JSON.stringify([s.id,s.kind,s.split,s.source_audio_sha256,s.pcm_sha256]);
  const ids=first.plan.streams.map(s=>s.id);
  if(new Set(ids).size!==ids.length)throw new Error('Duplicate stream');
  for(const {result} of rounds) {
    if(!result.complete||signature(result.plan)!==signature(first.plan))throw new Error('Incompatible experiment rounds');
    if(result.plan.streams.length!==ids.length||new Set(result.plan.streams.map(s=>s.id)).size!==ids.length)throw new Error('Stream coverage mismatch');
    for(const stream of result.plan.streams) {
      const original=first.plan.streams.find(s=>s.id===stream.id);
      if(!original||streamSignature(stream)!==streamSignature(original))throw new Error('Stream source mismatch');
    }
  }
  const streams=first.plan.streams.map(stream=>{
    const conditions=rounds.flatMap(({result})=>result.plan.streams.find(s=>s.id===stream.id).conditions);
    if(new Set(conditions.map(c=>c.id)).size!==conditions.length)throw new Error('Duplicate condition across rounds');
    return {...stream,conditions};
  });
  return {...first,plan:{...first.plan,streams},requests:rounds.reduce((n,r)=>n+r.result.requests,0),
    runs:rounds.flatMap(r=>r.result.runs),repeats:rounds.flatMap(r=>r.result.repeats),
    elapsed_milliseconds:rounds.reduce((n,r)=>n+r.result.elapsed_milliseconds,0),
    execution_rounds:rounds.map(({source,result})=>({source,requests:result.requests,elapsed_seconds:result.elapsed_milliseconds/1000,cache_hits:result.cache_hits})),
    elapsed_note:'Sum of historical round wall times, not a single contemporaneous experiment or per-condition wall time.'};
}
