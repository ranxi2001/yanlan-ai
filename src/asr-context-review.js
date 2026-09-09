// This gate annotates ASR disagreements; it never decides acoustic truth and
// never grants automatic approval merely because no protected token changed.
const patterns = {
  polarity: /不|没|无|未|别|勿|否/gu,
  number: /\d+(?:[.,]\d+)*|[零〇一二两三四五六七八九十百千万亿]+/gu,
  identifier: /[a-z][a-z0-9_-]*/gu,
  modality: /必须|可能|应该|至少|最多|已经|尚未|如果|除非|决定|确认|承诺|负责|截止/gu,
  question: /[?？]|吗|么/gu,
};
export function reviewAsrContextProposal(coreText, projection) {
  if(typeof coreText!=='string'||typeof projection?.text!=='string')throw new TypeError('Invalid context review input');
  if(coreText===projection.text)return {status:'unchanged',publish_text:coreText,candidate_text:null,risks:[]};
  const before=coreText.normalize('NFKC').toLowerCase(),after=projection.text.normalize('NFKC').toLowerCase();
  const risks=Object.entries(patterns).filter(([,pattern])=>JSON.stringify(before.match(pattern)||[])!==JSON.stringify(after.match(pattern)||[])).map(([name])=>name);
  return {status:'review_required',publish_text:coreText,candidate_text:projection.text,risks,
    reason:risks.length?'protected_content_disagreement':'unverified_asr_disagreement'};
}
