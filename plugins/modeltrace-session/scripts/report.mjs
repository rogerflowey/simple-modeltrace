export function finding(record) {
  if (record.status !== 'completed') return null;
  const prediction = record.result?.prediction || record.result?.results?.[0]?.model;
  if (record.expected_model_in_bank !== true || !prediction) return 'inconclusive';
  return prediction === record.source?.model ? 'consistent' : 'unexpected fingerprint';
}

function findingExplanation(record) {
  const outcome = finding(record);
  if (outcome === 'inconclusive') return record.expected_model_in_bank === false
    ? 'Reason: Configured model is absent from the reference bank; exact identity is unverified.'
    : 'Reason: Reference coverage or attribution is unavailable.';
  if (outcome === 'unexpected fingerprint') return 'Finding: Closest reference differs from the configured model. This is a statistical signal, not proof of substitution.';
  if (outcome === 'consistent') return 'Finding: Closest reference matches the configured model; this does not prove identity.';
  return null;
}

function oneLine(value, limit = 120) {
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length > limit ? text.slice(0, limit - 1) + '…' : text;
}

export function briefReport(record) {
  const outcome = finding(record);
  const parts = [record.status === 'completed' ? 'FINISHED' : record.status.toUpperCase()];
  if (outcome) parts.push(outcome.toUpperCase());
  parts.push(`configured ${oneLine(record.source?.model || record.configured_model || 'unknown', 80)}`);
  const prediction = record.result?.prediction || record.result?.results?.[0]?.model;
  if (prediction) parts.push(`closest reference ${oneLine(prediction, 80)}`);
  parts.push(record.interrupted_at_unknown ? 'duration unknown' : duration(record));
  if (record.error) parts.push(`Reason: ${oneLine(record.error)}`);
  return parts.join(' · ');
}

export function completionReport(record) {
  const lines = [`ModelTrace — ${briefReport(record)}`];
  const explanation = findingExplanation(record);
  if (explanation) lines.push(explanation);
  if (record.failure_stage) lines.push(`Failed during: ${oneLine(record.failure_stage)}`);
  lines.push('Details: !modeltrace status · History: !modeltrace history');
  return lines.join('\n');
}

export function duration(record, now = Date.now()) {
  const start = Date.parse(record.started_at);
  const end = record.finished_at ? Date.parse(record.finished_at)
    : record.status === 'running' ? now : Date.parse(record.updated_at || record.started_at);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'unknown';
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  return seconds >= 3600 ? `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m`
    : seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}

export function timestamp(value) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) return 'unknown';
  const pad = n => String(n).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}

export function phase(record) {
  if (record.phase === 'sampling') return `Sampling ${record.sample_index}/${record.samples_total || 3}`;
  return ({ starting: 'Reading session settings', preparing: 'Preparing challenges', analyzing: 'Analyzing fingerprints' })[record.phase]
    || (record.status === 'running' ? 'Running (legacy record has no progress details)' : record.phase || record.status);
}

function weight(probability) {
  const percent = Number(probability) * 100;
  if (percent > 99.9) return '>99.9%';
  if (percent < 0.1) return '<0.1%';
  return `${percent.toFixed(1)}%`;
}

export function report(record, { now = Date.now(), details = false } = {}) {
  const outcome = finding(record);
  const lines = [`ModelTrace — ${record.status.toUpperCase()}${outcome ? ` · ${outcome.toUpperCase()}` : ''}`,
    `Started: ${timestamp(record.started_at)}`];
  if (record.finished_at) lines.push(`Finished: ${timestamp(record.finished_at)} · Duration: ${duration(record, now)}`);
  else if (record.status === 'running') lines.push(`Elapsed: ${duration(record, now)} · ${phase(record)}`);
  else if (record.interrupted_at_unknown) lines.push('Stopped: unknown (no final result saved)');
  if (record.updated_at) lines.push(`Last progress: ${timestamp(record.updated_at)}`);
  lines.push(`Configured: ${record.source?.model || record.configured_model || 'unknown'}${record.source ? ` · ${record.source.provider} · ${record.source.effort || 'default effort'}` : ''}`);
  const completed = record.samples_completed ?? record.samples?.length ?? record.result?.used_outputs;
  lines.push(`Samples: ${completed ?? '?'}/${record.samples_total || 3} valid`);
  if (record.result?.results?.length) {
    lines.push(`Closest reference: ${record.result.results[0].model}`);
    lines.push(`Candidate weights (within reference bank): ${record.result.results.slice(0, 3).map(r => `${r.model} ${weight(r.probability)}`).join(', ')}`);
  }
  const explanation = findingExplanation(record);
  if (explanation) lines.push(explanation);
  if (record.error) lines.push(`Reason: ${record.error}`);
  if (record.failure_stage) lines.push(`Failed during: ${record.failure_stage}`);
  if (record.reason) lines.push(`Reason: ${record.reason}`);
  if (record.status === 'completed') lines.push('Scope: Configured model in independent conversations; not the current task response.');
  lines.push(`Session: ${record.session_id}`, `Run: ${record.run_id}`);
  if (details && record.events?.length) {
    lines.push('Timeline:');
    for (const event of record.events) lines.push(`  ${timestamp(event.at)} · ${event.message}`);
  }
  if (record.filename) lines.push(`Result: ${record.filename}`);
  return lines.join('\n');
}

export function runLabel(record) {
  return record.run_id.match(/^\d{13}-([a-f\d]{8})-/)?.[1] || record.run_id;
}

export function history(runs, { now = Date.now() } = {}) {
  if (!runs.length) return 'No ModelTrace tests recorded.';
  const rows = runs.map(r => [timestamp(r.started_at), r.status.toUpperCase(), finding(r) || '—',
    r.interrupted_at_unknown ? 'unknown' : duration(r, now), r.source?.model || r.configured_model || 'unknown',
    r.result?.prediction || r.result?.results?.[0]?.model || '—', r.session_id.slice(0, 8), runLabel(r)]);
  const header = ['STARTED', 'STATUS', 'FINDING', 'DURATION', 'CONFIGURED', 'CLOSEST REFERENCE', 'SESSION', 'RUN'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map(r => String(r[i]).length)));
  return [header, ...rows].map(row => row.map((v, i) => String(v).padEnd(widths[i])).join('  ').trimEnd()).join('\n');
}
