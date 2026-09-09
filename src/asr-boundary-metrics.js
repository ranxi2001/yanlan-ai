import { characterUnits } from './asr-benchmark-metrics.js';

// Alignment is for evaluation only. The mask labels complete reference
// utterances near the union of all conditions' cuts, not inferred word times.
export function scoreAsrBoundaryMask(reference, hypothesis, mask) {
  const a=characterUnits(reference),b=characterUnits(hypothesis),width=b.length+1;
  if(!Array.isArray(mask)||mask.length!==a.length||mask.some(x=>typeof x!=='boolean'))throw new TypeError('Invalid reference mask');
  if((a.length+1)*width>25_000_000)throw new RangeError('Score continuous evaluation spans, not full recordings');
  const directions=new Uint8Array((a.length+1)*width);
  let prev=Uint32Array.from({length:width},(_,i)=>i),curr=new Uint32Array(width);
  for(let j=1;j<width;j++)directions[j]=2;
  for(let i=1;i<=a.length;i++) {
    curr[0]=i;directions[i*width]=1;
    for(let j=1;j<width;j++) {
      let cost=prev[j-1]+Number(a[i-1]!==b[j-1]),direction=0;
      if(prev[j]+1<cost){cost=prev[j]+1;direction=1;}
      if(curr[j-1]+1<cost){cost=curr[j-1]+1;direction=2;}
      curr[j]=cost;directions[i*width+j]=direction;
    }
    [prev,curr]=[curr,prev];
  }
  const blank=()=>({reference_units:0,hypothesis_units:0,errors:0,substitutions:0,deletions:0,insertions:0});
  const groups={boundary:blank(),interior:blank()};
  let i=a.length,j=b.length;
  while(i||j) {
    const d=directions[i*width+j],g=groups[mask[Math.max(0,i-1)]?'boundary':'interior'];
    if(d===0){g.reference_units++;g.hypothesis_units++;if(a[i-1]!==b[j-1])g.substitutions++;i--;j--;}
    else if(d===1){g.reference_units++;g.deletions++;i--;}
    else {g.hypothesis_units++;g.insertions++;j--;}
  }
  const overall=blank();
  for(const g of Object.values(groups)) {
    g.errors=g.substitutions+g.deletions+g.insertions;
    for(const k of Object.keys(overall))overall[k]+=g[k];
    g.rate=g.reference_units?g.errors/g.reference_units:g.errors?null:0;
  }
  overall.rate=overall.reference_units?overall.errors/overall.reference_units:overall.errors?null:0;
  return {overall,...groups};
}
