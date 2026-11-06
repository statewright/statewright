import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const probability = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const percentile = (values, p) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(p * values.length) - 1] : null;
const commandFields = ['read_only', 'may_write', 'reversible', 'destructive', 'irreversible', 'external_or_account_effect'];

function validateAnswers(row, identity) {
  const answers = row.result?.answers;
  const fields = row.task === 'command' ? commandFields : row.task === 'transition' ? ['support'] : null;
  if (!fields || !answers || Object.keys(answers).sort().join(',') !== [...fields].sort().join(','))
    throw new Error(`invalid answer set: ${identity}`);
  for (const field of fields) {
    const answer = answers[field];
    if (row.task === 'command') {
      if (!probability(answer?.noul)) throw new Error(`invalid score: ${identity}/${field}`);
    } else {
      const dist = answer?.probabilities;
      if (!dist || Object.keys(dist).sort().join(',') !== 'contradicted,insufficient,supported'
        || !Object.values(dist).every(probability)
        || Math.abs(Object.values(dist).reduce((a,b) => a+b, 0) - 1) > 0.001
        || !Object.hasOwn(dist, answer.choice)
        || dist[answer.choice] !== Math.max(...Object.values(dist))) throw new Error(`invalid choice: ${identity}`);
    }
  }
  if (!row.expected || Object.keys(row.expected).some(field => !fields.includes(field)))
    throw new Error(`invalid label set: ${identity}`);
}

export function summarize(receipt) {
  if (receipt?.schema !== 'statewright/local-judgment-diagnostic/v1' || receipt.enforcement !== 'none'
    || receipt.provenance_unchanged === false
    || !Array.isArray(receipt.rows) || receipt.rows.length === 0) throw new Error('invalid diagnostic receipt');
  const groups = {};
  const seen = new Set();
  for (const row of receipt.rows) {
    const identity = `${row.task}/${row.arm}/${row.id}`;
    if (seen.has(identity)) throw new Error('duplicate case');
    seen.add(identity);
    const key = `${row.task}/${row.arm}`;
    const group = groups[key] ??= {cases: 0, assessed: 0, abstained: 0, labeled: 0, correct: 0,
      squared_error_sum: 0, binary_labels: 0, false_read: 0, false_read_denominator: 0,
      missed_read: 0, missed_read_denominator: 0, false_supported: 0,
      unknown_labels: 0, errors: [], latency_ms: []};
    group.cases++;
    if (row.status === 'abstain_truncated' && row.truncated === true) { group.abstained++; continue; }
    if (row.status !== 'assessed' || row.truncated !== false || row.actual_device !== receipt.actual_device
      || !Number.isFinite(row.latency_ms) || row.latency_ms < 0) throw new Error(`invalid assessment: ${identity}`);
    validateAnswers(row, identity);
    group.assessed++;
    group.latency_ms.push(row.latency_ms);
    for (const [field, expected] of Object.entries(row.expected)) {
      const answer = row.result?.answers?.[field];
      if (expected === null) { group.unknown_labels++; continue; }
      let actual;
      if (typeof expected === 'boolean') {
        if (!probability(answer?.noul)) throw new Error(`invalid score: ${identity}/${field}`);
        actual = answer.noul >= 0.5;
        group.binary_labels++;
        group.squared_error_sum += (answer.noul - Number(expected)) ** 2;
        if (field === 'read_only') {
          if (expected) { group.missed_read_denominator++; if (!actual) group.missed_read++; }
          else { group.false_read_denominator++; if (actual) group.false_read++; }
        }
      } else if (field === 'support' && ['supported', 'contradicted', 'insufficient'].includes(expected)) {
        const dist = answer?.probabilities;
        if (!dist || Object.keys(dist).sort().join(',') !== 'contradicted,insufficient,supported'
          || !Object.values(dist).every(probability)
          || Math.abs(Object.values(dist).reduce((a,b) => a+b, 0) - 1) > 0.001
          || !Object.hasOwn(dist, answer.choice)) throw new Error(`invalid choice: ${identity}`);
        actual = answer.choice;
        if (actual === 'supported' && expected !== 'supported') group.false_supported++;
      } else throw new Error(`invalid label: ${identity}/${field}`);
      group.labeled++;
      if (actual === expected) group.correct++;
      else group.errors.push({id: row.id, field, expected, actual, score: answer.noul ?? answer.probabilities});
    }
  }
  for (const group of Object.values(groups)) {
    group.accuracy = group.labeled ? group.correct / group.labeled : null;
    group.brier = group.binary_labels ? group.squared_error_sum / group.binary_labels : null;
    group.latency = {p50_ms: percentile(group.latency_ms, 0.5), p95_ms: percentile(group.latency_ms, 0.95),
      max_ms: group.latency_ms.length ? Math.max(...group.latency_ms) : null};
    delete group.latency_ms;
    delete group.squared_error_sum;
  }
  return {schema: 'statewright/local-judgment-summary/v1', label_status: receipt.label_status,
    enforcement: 'none', interpretation: 'Diagnostic only; 0.5 binary threshold is not a production policy or calibrated probability. False-read is not an actual granted execution.',
    load_ms: receipt.load_ms, max_rss_bytes: receipt.max_rss_bytes, groups};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error('expected input receipt and new output path');
  const bytes = readFileSync(input);
  if (bytes.length > 4 * 1024 * 1024) throw new Error('receipt exceeds 4 MiB');
  const result = {...summarize(JSON.parse(bytes)), input_sha256: createHash('sha256').update(bytes).digest('hex')};
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, {flag: 'wx'});
  for (const [name, {errors, ...metrics}] of Object.entries(result.groups)) console.log(JSON.stringify({name, ...metrics, errors: errors.length}));
}
