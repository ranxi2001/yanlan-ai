// Post-hoc diagnostic: replay one exact window and its two halves, retaining
// finish reasons. Results never replace the frozen benchmark hypotheses.
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { createHash } from 'node:crypto';
import { DEFAULT_CONFIG,transcribeAudio } from '../src/api.js';
import { parseKeyBackup } from '../src/key-backup.js';
const args=process.argv.slice(2),get=f=>args.includes(f)?args[args.indexOf(f)+1]:undefined;
const sha=b=>createHash('sha256').update(b).digest('hex');
function wav(pcm,rate){
  const h=Buffer.alloc(44);h.write('RIFF');h.writeUInt32LE(pcm.length+36,4);h.write('WAVEfmt ',8);h.writeUInt32LE(16,16);
  h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);h.writeUInt32LE(rate,24);h.writeUInt32LE(rate*2,28);
  h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(pcm.length,40);
  return new Blob([h,pcm],{type:'audio/wav'});
}
async function main(){
  const root=resolve(get('--root')||'artifacts/hf-asr-longform');
  const folder=resolve(get('--evaluation-dir')||join(root,'evaluation60'));
  const manifestRaw=await readFile(join(root,'prepared-manifest.json'),'utf8'),manifest=JSON.parse(manifestRaw);
  const plan=JSON.parse(await readFile(join(folder,'experiment.json'),'utf8'));
  if(sha(manifestRaw)!==plan.manifest_sha256)throw new Error('Manifest changed');
  const stream=manifest.streams.find(s=>s.id===get('--stream'));
  if(!stream)throw new Error('Unknown stream');
  const condition=get('--condition')||'vad60',index=Number(get('--window'));
  const window=plan.streams.find(s=>s.id===stream.id).conditions.find(c=>c.id===condition)?.windows.find(w=>w.id===index);
  if(!window)throw new Error('Unknown window');
  const original=JSON.parse(await readFile(join(folder,'requests',`${stream.id}-${condition}-${index}.json`),'utf8'));
  const pcm=await readFile(join(root,stream.pcm_file));if(sha(pcm)!==stream.pcm_sha256)throw new Error('PCM changed');
  const start=Math.round(window.audio_start*stream.sample_rate),end=Math.round(window.audio_end*stream.sample_rate),mid=Math.floor((start+end)/2);
  if(sha(pcm.subarray(start*2,end*2))!==original.pcm_sha256)throw new Error('Original request mismatch');
  const key=parseKeyBackup((await readFile(resolve(get('--keys')),'utf8')).replace(/^\uFEFF/u,''));
  const config={...DEFAULT_CONFIG,asrApiKey:key.mimo,asrModel:plan.model};
  const results=[];
  for(const [id,from,to] of [['repeat',start,end],['first_half',start,mid],['second_half',mid,end]]){
    const chunk=pcm.subarray(from*2,to*2),began=Date.now();
    const r=await transcribeAudio({config,blob:wav(chunk,stream.sample_rate),language:plan.language,signal:AbortSignal.timeout(120000)});
    results.push({id,start_seconds:from/stream.sample_rate,end_seconds:to/stream.sample_rate,pcm_sha256:sha(chunk),text:r.text,
      elapsed_milliseconds:Date.now()-began,finish_reason:r.raw?.choices?.[0]?.finish_reason??null,usage:r.raw?.usage??null});
  }
  const output=join(folder,'diagnostics');await mkdir(output,{recursive:true});
  const report={stream_id:stream.id,condition,window,original_text:original.text,results,
    purpose:'Post-hoc replay of an observed omission; original benchmark scores are unchanged. No references sent to ASR.'};
  await writeFile(join(output,`${stream.id}-${condition}-${index}.json`),JSON.stringify(report,null,2));
  console.log(JSON.stringify({diagnostic_requests:results.length,results:results.map(({text,usage,...r})=>({...r,characters:[...text].length,completion_tokens:usage?.completion_tokens??null}))}));
}
main().catch(e=>{console.error(JSON.stringify({error:'window_diagnostic_failed',code:e.code||null}));process.exitCode=1;});
