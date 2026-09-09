export function characterUnits(text) {
  return [...String(text || "").normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "")];
}

export function mixedUnits(text) {
  return String(text || "").normalize("NFKC").toLowerCase().replace(/’/gu, "'")
    .match(/\p{Script=Han}|\p{Script=Latin}+(?:'\p{Script=Latin}+)*|\d+(?:\.\d+)?/gu) || [];
}

export function editCounts(reference, hypothesis) {
  const width = hypothesis.length + 1;
  let previous = Array.from({ length: 4 }, () => new Uint32Array(width));
  let current = Array.from({ length: 4 }, () => new Uint32Array(width));
  for (let j = 0; j < width; j += 1) { previous[0][j] = j; previous[3][j] = j; }
  for (let i = 1; i <= reference.length; i += 1) {
    current[0][0] = i; current[1][0] = 0; current[2][0] = i; current[3][0] = 0;
    for (let j = 1; j < width; j += 1) {
      const substitution = reference[i - 1] === hypothesis[j - 1] ? 0 : 1;
      let source = previous, column = j - 1, operation = substitution ? 1 : 0, cost = previous[0][j - 1] + substitution;
      if (previous[0][j] + 1 < cost) { source = previous; column = j; operation = 2; cost = previous[0][j] + 1; }
      if (current[0][j - 1] + 1 < cost) { source = current; column = j - 1; operation = 3; cost = current[0][j - 1] + 1; }
      current[0][j] = cost;
      for (let k = 1; k <= 3; k += 1) current[k][j] = source[k][column] + (operation === k ? 1 : 0);
    }
    [previous, current] = [current, previous];
  }
  const errors = previous[0][width - 1];
  return { reference_units: reference.length, hypothesis_units: hypothesis.length, errors,
    substitutions: previous[1][width - 1], deletions: previous[2][width - 1], insertions: previous[3][width - 1],
    rate: reference.length ? errors / reference.length : errors ? null : 0 };
}

export function scoreAsr(reference, hypothesis) {
  return { cer: editCounts(characterUnits(reference), characterUnits(hypothesis)),
    mer: editCounts(mixedUnits(reference), mixedUnits(hypothesis)) };
}

export function aggregateAsrScores(records) {
  const result = { samples: records.length };
  for (const metric of ["cer", "mer"]) {
    const totals = { reference_units: 0, hypothesis_units: 0, errors: 0, substitutions: 0, deletions: 0, insertions: 0 };
    for (const record of records) for (const field of Object.keys(totals)) totals[field] += record.scores[metric][field];
    result[metric] = { ...totals, rate: totals.reference_units ? totals.errors / totals.reference_units : null };
  }
  return result;
}
