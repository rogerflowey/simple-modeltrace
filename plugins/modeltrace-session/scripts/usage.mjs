const FIELDS = {
  input_tokens: 'inputTokens', cached_input_tokens: 'cachedInputTokens',
  cache_write_input_tokens: 'cacheWriteInputTokens', output_tokens: 'outputTokens',
  reasoning_output_tokens: 'reasoningOutputTokens', total_tokens: 'totalTokens',
};
const REQUIRED = ['input_tokens', 'output_tokens', 'total_tokens'];
const counter = value => Number.isSafeInteger(value) && value >= 0;

function validTotals(value) {
  return value && REQUIRED.every(key => counter(value[key]))
    && Object.keys(FIELDS).every(key => value[key] == null || counter(value[key]));
}

// Codex sends cumulative thread snapshots. Each probe uses a fresh thread, so
// replace its previous snapshot rather than adding notifications or `last`.
export function normalizeTokenUsage(value) {
  if (!value || typeof value !== 'object') return null;
  const tokens = Object.fromEntries(Object.entries(FIELDS).map(([key, wire]) => [key, value[wire] ?? null]));
  return validTotals(tokens) ? tokens : null;
}

function sumTokens(values) {
  if (!values.length) return null;
  return Object.fromEntries(Object.keys(FIELDS).map(key => [key,
    values.every(value => counter(value[key])) ? values.reduce((sum, value) => sum + value[key], 0) : null,
  ]));
}

export function sampleUsage(samples) {
  const reported = samples.filter(sample => validTotals(sample.tokens));
  return {
    totals: sumTokens(reported.map(sample => sample.tokens)),
    samples_started: samples.length, samples_reported: reported.length,
    complete: samples.length > 0 && samples.every(sample => sample.finished && validTotals(sample.tokens)),
    samples: samples.map(sample => ({ ...sample })),
  };
}

export function recordedUsage(record) {
  return validTotals(record.usage?.totals) ? record.usage : null;
}

function summarizeRuns(runs) {
  const measured = runs.map(recordedUsage).filter(Boolean);
  return {
    runs_total: runs.length, runs_with_usage: measured.length,
    runs_partial: measured.filter(usage => usage.complete !== true).length,
    runs_without_usage: runs.length - measured.length,
    totals: sumTokens(measured.map(usage => usage.totals)),
  };
}

export function aggregateUsage(runs) {
  const groups = new Map();
  for (const run of runs) {
    const model = run.source?.model || run.configured_model || 'unknown';
    const provider = run.source?.provider || 'unknown';
    const key = JSON.stringify([model, provider]);
    if (!groups.has(key)) groups.set(key, { model, provider, runs: [] });
    groups.get(key).runs.push(run);
  }
  return {
    ...summarizeRuns(runs),
    by_model: [...groups.values()].map(({ model, provider, runs: group }) => ({ model, provider, ...summarizeRuns(group) })),
  };
}
