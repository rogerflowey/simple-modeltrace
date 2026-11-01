import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generate } from '../scripts/client.mjs';
import { main } from '../scripts/cli.mjs';
import { atomicJson, loadRuns } from '../scripts/records.mjs';
import { report } from '../scripts/report.mjs';
import { probe, runHook } from '../scripts/session-start.mjs';
import { aggregateUsage, normalizeTokenUsage, sampleUsage } from '../scripts/usage.mjs';

const first = { inputTokens: 100, cachedInputTokens: 20, cacheWriteInputTokens: 0,
  outputTokens: 50, reasoningOutputTokens: 30, totalTokens: 150 };
const final = { ...first, outputTokens: 100, reasoningOutputTokens: 80, totalTokens: 200 };
const text = Array.from({ length: 310 }, (_, i) => 1 + ((i * 97) % 355)).join(',');
const event = { hook_event_name: 'SessionStart', source: 'startup', session_id: 'usage-thread', cwd: '/tmp' };
const settings = async () => ({ model: 'gpt-6.1-sol', provider: 'openai', effort: 'high', cwd: '/tmp' });
const makeChallenges = () => Array.from({ length: 3 }, () => ({ prompt: 'fixture', expected_count: 310 }));

function fixtureClient({ snapshots = [first, final], answer = text, status = 'completed', onStart = async () => {} } = {}) {
  const client = { listeners: new Set(), child: new EventEmitter(), closed: false };
  client.close = async () => { client.closed = true; };
  client.request = async (method, params) => {
    if (method === 'thread/start') return {
      thread: { id: 'probe', ephemeral: true, path: null }, model: 'gpt-6.1-sol', modelProvider: 'openai', reasoningEffort: 'high',
    };
    assert.equal(method, 'turn/start');
    const emit = (method, update) => {
      for (const listener of client.listeners) listener({ method, params: { threadId: params.threadId, ...update } });
    };
    emit('thread/tokenUsage/updated', { threadId: 'unrelated', tokenUsage: { total: { ...final, totalTokens: 999999 } } });
    // These arrive before turn/start's reply. `last` must never be added to total.
    for (const total of snapshots) emit('thread/tokenUsage/updated', { tokenUsage: { total, last: final } });
    await onStart();
    emit('item/completed', { item: { type: 'agentMessage', phase: 'final_answer', text: answer } });
    if (status) emit('turn/completed', { turn: { status } });
    return { turn: { id: 'turn' } };
  };
  return client;
}

async function temporary(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'modeltrace-usage-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function command(args, directory, env = {}) {
  let output = '', errors = '';
  await main(args, {
    env: { MODELTRACE_DATA_DIR: directory, ...env },
    stdout: { write: value => { output += value; } }, stderr: { write: value => { errors += value; } },
  });
  return { output, errors };
}

test('normalizes protocol counters and retains unknown optional breakdowns without inventing zeros', () => {
  assert.deepEqual(normalizeTokenUsage(final), {
    input_tokens: 100, cached_input_tokens: 20, cache_write_input_tokens: 0,
    output_tokens: 100, reasoning_output_tokens: 80, total_tokens: 200,
  });
  const older = normalizeTokenUsage({ inputTokens: 100, outputTokens: 100, totalTokens: 200 });
  assert.equal(older.cached_input_tokens, null);
  assert.equal(older.reasoning_output_tokens, null);
  assert.equal(older.cache_write_input_tokens, null);
  for (const invalid of [null, {}, { ...final, totalTokens: -1 }, { ...final, inputTokens: 1.5 },
    { ...final, outputTokens: '100' }, { ...final, totalTokens: Infinity }]) {
    assert.equal(normalizeTokenUsage(invalid), null);
  }
});

test('replaces cumulative snapshots, ignores other threads and malformed updates, and awaits usage writes', async () => {
  const updates = [];
  const client = fixtureClient({ snapshots: [first, final, final, { ...final, totalTokens: -1 }] });
  const answer = await generate(client, 'probe', 'fixture', 1000, {
    onUsage: async (tokens, state) => {
      await new Promise(resolve => setTimeout(resolve, 1));
      updates.push({ tokens, ...state });
    },
  });
  assert.equal(answer, text);
  assert.deepEqual(updates.map(update => update.tokens.total_tokens), [150, 200, 200, 200]);
  assert.equal(updates.at(-1).finished, true);
  assert.equal(client.listeners.size, 0);
  assert.equal(client.child.listenerCount('exit'), 0);
});

test('preserves usage on a timeout and distinguishes missing usage from zero tokens', async () => {
  const updates = [];
  await assert.rejects(generate(fixtureClient({ status: null }), 'probe', 'fixture', 10, {
    onUsage: async (tokens, state) => { updates.push({ tokens, ...state }); },
  }), /timed out/);
  assert.equal(updates.at(-1).tokens.total_tokens, 200);
  assert.equal(updates.at(-1).finished, false);
  const absent = [];
  await generate(fixtureClient({ snapshots: [] }), 'probe', 'fixture', 1000, {
    onUsage: async (tokens, state) => { absent.push({ tokens, ...state }); },
  });
  assert.equal(absent.at(-1).tokens, null);
  assert.equal(sampleUsage([{ tokens: null, finished: true }]).totals, null);
  assert.equal(sampleUsage([{ tokens: normalizeTokenUsage({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }), finished: true }]).totals.total_tokens, 0);
});

test('three fresh probes save per-sample usage and aggregate totals without adding subset counters', async t => {
  const directory = await temporary(t);
  const clients = [];
  await runHook(event, { directory, env: {}, runProbe: (input, { onProgress }) => probe(input, {
    onProgress, getSettings: settings, makeChallenges,
    openClient: async () => { const client = fixtureClient(); clients.push(client); return client; },
  }) });
  const { runs } = await loadRuns({ directories: [directory] });
  assert.equal(runs.length, 1);
  const record = runs[0];
  assert.equal(record.status, 'completed');
  assert.equal(record.usage.complete, true);
  assert.equal(record.usage.samples_started, 3);
  assert.equal(record.usage.samples_reported, 3);
  assert.deepEqual(record.usage.totals, {
    input_tokens: 300, cached_input_tokens: 60, cache_write_input_tokens: 0,
    output_tokens: 300, reasoning_output_tokens: 240, total_tokens: 600,
  });
  assert.ok(record.samples.every(sample => sample.usage.total_tokens === 200));
  assert.equal(record.usage.samples.length, 3);
  assert.ok(clients.every(client => client.closed));
  assert.match(report(record, { details: true }), /Sample usage:[\s\S]*Sample 3: 200 total tokens/);
  assert.match((await command(['history'], directory)).output, /TOKENS[\s\S]*600/);
  const json = JSON.parse((await command(['usage', '--json'], directory)).output);
  assert.equal(json.usage.totals.total_tokens, 600);
  assert.equal(json.usage.runs_total, 1); // latest.json is not another run.
});

test('saves usage while inference is active and retains rejected sample usage after failure', async t => {
  const directory = await temporary(t);
  let release, ready, count = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const saved = new Promise(resolve => { ready = resolve; });
  const work = runHook(event, { directory, env: {}, runProbe: (input, { onProgress }) => probe(input, {
    onProgress: async (update, message) => {
      await onProgress(update, message);
      if (update.usage?.totals?.total_tokens === 400) ready();
    },
    getSettings: settings, makeChallenges,
    openClient: async () => fixtureClient(++count === 1 ? {} : { answer: '1,2,3', onStart: () => gate }),
  }) });
  try {
    await saved;
    const active = await command(['status'], directory);
    assert.match(active.output, /RUNNING[\s\S]*Usage: 400 total tokens[\s\S]*partial/);
    const totals = JSON.parse((await command(['usage', '--json'], directory)).output).usage;
    assert.equal(totals.runs_partial, 1);
    assert.equal(totals.totals.total_tokens, 400);
  } finally { release(); }
  await work;
  const record = JSON.parse(await readFile(path.join(directory, 'latest.json'), 'utf8'));
  assert.equal(record.status, 'failed');
  assert.equal(record.samples.length, 1);
  assert.equal(record.usage.samples_started, 2);
  assert.equal(record.usage.samples_reported, 2);
  assert.equal(record.usage.totals.total_tokens, 400);
  assert.equal(record.usage.samples[1].finished, true);
});

test('usage scopes, deduplication, model groups, partial counts, and unavailable history are explicit', async t => {
  const directory = await temporary(t);
  const usage = sampleUsage([{ sample_index: 1, tokens: normalizeTokenUsage(final), finished: true }]);
  const base = { session_id: event.session_id, run_id: 'one', started_at: '2026-11-01T00:00:00Z', status: 'completed',
    source: { model: 'first-model', provider: 'openai' }, usage };
  for (const [name, record] of [
    ['one.json', base], ['latest.json', base], ['legacy.json', { ...base, run_id: 'legacy', usage: undefined }],
    ['partial.json', { ...base, run_id: 'partial', status: 'failed', usage: sampleUsage([
      { sample_index: 1, tokens: normalizeTokenUsage(first), finished: false }, { sample_index: 2, tokens: null, finished: false },
    ]) }],
    ['other.json', { ...base, session_id: 'other-session', run_id: 'other', source: { model: 'second-model', provider: 'custom' } }],
  ]) await atomicJson(path.join(directory, name), record);
  await writeFile(path.join(directory, 'broken.json'), '{broken');
  const env = { CODEX_THREAD_ID: event.session_id };
  const scoped = JSON.parse((await command(['usage', '--json', '--limit', '1'], directory, env)).output);
  assert.equal(scoped.session_id, event.session_id);
  assert.equal(scoped.usage.runs_total, 3);
  assert.equal(scoped.usage.runs_with_usage, 2);
  assert.equal(scoped.usage.runs_partial, 1);
  assert.equal(scoped.usage.runs_without_usage, 1);
  assert.equal(scoped.usage.totals.total_tokens, 350);
  assert.equal(scoped.usage.by_model.length, 1);
  assert.match(scoped.warnings[0], /Unreadable result JSON/);
  const all = JSON.parse((await command(['usage', '--all', '--json'], directory, env)).output);
  assert.equal(all.session_id, null);
  assert.equal(all.usage.runs_total, 4);
  assert.equal(all.usage.totals.total_tokens, 550);
  assert.equal(all.usage.by_model.length, 2);
  const selected = JSON.parse((await command(['usage', '--session', 'other-session', '--json'], directory, env)).output);
  assert.equal(selected.usage.totals.total_tokens, 200);
  const display = await command(['usage'], directory, env);
  assert.match(display.output, /350 total tokens[\s\S]*2\/3 runs with usage · 1 partial · 1 unavailable/);
  assert.match(display.errors, /Unreadable result JSON/);
  assert.match((await command(['show', 'legacy'], directory)).output, /Usage: unavailable \(not recorded for this run\)/);
  const empty = JSON.parse((await command(['usage', '--session', 'missing', '--json'], directory)).output);
  assert.equal(empty.usage.runs_total, 0);
  assert.equal(empty.usage.totals, null);
  assert.match((await command(['usage', '--session', 'missing'], directory)).output, /No ModelTrace tests recorded/);
});

test('aggregates only measured totals and preserves unknown optional counters', () => {
  const summary = aggregateUsage([
    { usage: sampleUsage([{ tokens: normalizeTokenUsage(final), finished: true }]) },
    { usage: sampleUsage([{ tokens: normalizeTokenUsage({ inputTokens: 10, outputTokens: 20, totalTokens: 30 }), finished: true }]) },
    {}, { usage: { totals: { total_tokens: -1 } } },
  ]);
  assert.equal(summary.totals.total_tokens, 230);
  assert.equal(summary.totals.reasoning_output_tokens, null);
  assert.equal(summary.runs_without_usage, 2);
});
