import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { challenges, probe, referenceForModel, runHook, sourceSettings, summary } from '../scripts/session-start.mjs';
import { generate } from '../scripts/client.mjs';
import { EventEmitter } from 'node:events';

const event = { hook_event_name: 'SessionStart', source: 'startup', session_id: 'test-thread', cwd: '/tmp' };

async function temporary(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'modeltrace-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('uses three full upstream challenges with different lengths', () => {
  const list = challenges();
  assert.equal(list.length, 3);
  assert.equal(new Set(list.map(x => x.expected_count)).size, 3);
  for (const c of list) assert.ok(c.expected_count >= 292 && c.expected_count <= 332);
});

test('reference aliases match complete model names without accepting partial or extended names', () => {
  const bank = { models: [{ id: 'gpt-6-astra', aliases: ['gpt-6.1-sol'] }] };
  const expected = { id: 'gpt-6-astra', members: ['gpt-6-astra', 'gpt-6.1-sol'] };
  assert.deepEqual(referenceForModel(bank, 'gpt-6.1-sol'), expected);
  assert.deepEqual(referenceForModel(bank, 'gpt-6-astra'), expected);
  assert.equal(referenceForModel(bank, 'gpt-6'), null);
  assert.equal(referenceForModel(bank, 'gpt-6.1-sol-mini'), null);
});

test('ignores compact, probe processes, other events, and invalid IDs', async t => {
  const directory = await temporary(t);
  const runProbe = () => assert.fail('must not run inference');
  for (const input of [{ ...event, source: 'compact' }, { ...event, hook_event_name: 'PostToolUse' }]) {
    assert.equal(await runHook(input, { directory, runProbe, env: {} }), null);
  }
  assert.equal(await runHook(event, { directory, runProbe, env: { MODELTRACE_SESSION_PROBE: '1' } }), null);
  await assert.rejects(runHook({ ...event, session_id: '../escape' }, { directory, runProbe, env: {} }), /Invalid session/);
  assert.deepEqual(await readdir(directory), []);
});

test('locks concurrent invocations but runs again on a later resume', async t => {
  const directory = await temporary(t);
  let release, count = 0;
  const waiting = new Promise(resolve => { release = resolve; });
  const runProbe = async () => { count++; await waiting; return { status: 'failed', error: 'fixture' }; };
  const first = runHook(event, { directory, runProbe, env: {} });
  while (!count) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(await runHook(event, { directory, runProbe, env: {} }), null);
  release();
  await first;
  await runHook({ ...event, source: 'resume' }, { directory, runProbe, env: {} });
  assert.equal(count, 2);
  assert.equal((await readdir(directory)).filter(f => f.endsWith('.lock')).length, 0);
});

test('records failures and reports them without blocking the session', async t => {
  const directory = await temporary(t);
  const output = await runHook(event, { directory, env: {}, runProbe: async () => { throw new Error('unavailable'); } });
  assert.match(output.systemMessage, /FAILED/);
  assert.match(output.systemMessage, /Reason: unavailable/);
  const record = JSON.parse(await readFile(path.join(directory, 'latest.json')));
  assert.equal(record.status, 'failed');
  assert.ok(record.finished_at);
  assert.equal(output.continue, undefined);
  assert.equal(output.hookSpecificOutput, undefined);
});

test('a dead worker lock can be recovered', async t => {
  const directory = await temporary(t);
  await writeFile(path.join(directory, 'test-thread.lock'), JSON.stringify({ pid: 2147483647 }));
  const output = await runHook(event, { directory, env: {}, runProbe: async () => ({ status: 'failed', error: 'recovered' }) });
  assert.match(output.systemMessage, /recovered/);
});

test('reads the session model rather than the global default and closes transport', async () => {
  let closed = 0;
  const source = await sourceSettings(event, async () => ({
    request: async () => ({ thread: { model: 'session-override', modelProvider: 'custom', reasoningEffort: 'high', cwd: '/workspace' } }),
    close: async () => { closed++; },
  }), async () => { throw new Error('no daemon'); });
  assert.deepEqual(source, { model: 'session-override', provider: 'custom', effort: 'high', cwd: '/workspace' });
  assert.equal(closed, 1);
  assert.equal(await sourceSettings(event, null, async () => ({ parentThreadId: 'parent' })), null);
});

test('missing model metadata fails rather than silently testing a different model', async () => {
  await assert.rejects(sourceSettings(event, async () => ({ request: async () => ({ thread: {} }), close: async () => {} }), async () => ({})), /model metadata/);
});

test('reads an empty session directly from the live daemon without a persisted rollout', async () => {
  const source = await sourceSettings(event, () => assert.fail('must not use persisted metadata'), async () => ({
    model: 'new-session-override', modelProvider: 'openai', reasoningEffort: 'xhigh', cwd: '/tmp',
  }));
  assert.equal(source.model, 'new-session-override');
});

function fixtureClient({ text, tool = false, model = 'gpt-6.1-sol' } = {}) {
  const client = { listeners: new Set(), child: new EventEmitter(), closed: false, close: async () => { client.closed = true; } };
  client.request = async (method, params) => {
    if (method === 'thread/start') {
      assert.equal(params.ephemeral, true);
      assert.equal(params.config.features.hooks, false);
      return { thread: { id: 'ephemeral', ephemeral: true, path: null }, model, modelProvider: 'openai', reasoningEffort: 'high' };
    }
    assert.equal(method, 'turn/start');
    const emit = (method, p) => { for (const listener of client.listeners) listener({ method, params: { threadId: params.threadId, ...p } }); };
    if (tool) emit('item/started', { item: { type: 'commandExecution' } });
    emit('item/completed', { item: { type: 'agentMessage', phase: 'final_answer', text } });
    emit('turn/completed', { turn: { status: 'completed' } });
    return { turn: { id: 'turn' } };
  };
  return client;
}

test('handles notifications before the turn/start reply and rejects tool samples', async () => {
  assert.equal(await generate(fixtureClient({ text: '123' }), 'ephemeral', 'prompt'), '123');
  await assert.rejects(generate(fixtureClient({ text: '123', tool: true }), 'ephemeral', 'prompt'), /attempted a tool/);
});

test('runs three independent probes, scores with the real bank, and flags unseen models', async () => {
  const clients = [];
  // Synthetic data is only a transport/scorer fixture, never a real fingerprint.
  const text = Array.from({ length: 310 }, (_, i) => 1 + ((i * 97) % 355)).join(',');
  const record = await probe(event, {
    getSettings: async () => ({ model: 'unseen-fixture-model', provider: 'openai', effort: 'high', cwd: '/tmp' }),
    makeChallenges: () => Array.from({ length: 3 }, () => ({ prompt: 'fixture', expected_count: 310 })),
    openClient: async () => { const c = fixtureClient({ text, model: 'unseen-fixture-model' }); clients.push(c); return c; },
  });
  assert.equal(record.status, 'completed');
  assert.equal(record.result.used_outputs, 3);
  assert.equal(record.expected_model_in_bank, false);
  assert.equal(record.reference_match, null);
  assert.match(summary(record), /absent from the reference bank/);
  assert.equal(clients.length, 3);
  assert.ok(clients.every(c => c.closed));
});

test('rejects model fallback and truncated output and always closes probe processes', async () => {
  for (const options of [{ model: 'different' }, { text: '1,2,3' }]) {
    const c = fixtureClient(options);
    await assert.rejects(probe(event, {
      getSettings: async () => ({ model: 'gpt-6.1-sol', provider: 'openai', effort: 'high', cwd: '/tmp' }),
      makeChallenges: () => [{ prompt: 'fixture', expected_count: 300 }],
      openClient: async () => c,
    }), /preserve|truncated/);
    assert.equal(c.closed, true);
  }
});

test('a real probe failure preserves settings, its completed sample, and the failed sample number', async t => {
  const directory = await temporary(t);
  const text = Array.from({ length: 310 }, (_, i) => 1 + ((i * 97) % 355)).join(',');
  let count = 0;
  const clients = [];
  await runHook(event, {
    directory, env: {}, runProbe: (input, { onProgress }) => probe(input, {
      onProgress,
      getSettings: async () => ({ model: 'gpt-6.1-sol', provider: 'openai', effort: 'high', cwd: '/tmp' }),
      makeChallenges: () => Array.from({ length: 3 }, () => ({ prompt: 'fixture', expected_count: 310 })),
      openClient: async () => {
        const client = fixtureClient({ text: count++ === 0 ? text : '1,2,3' });
        clients.push(client); return client;
      },
    }),
  });
  const record = JSON.parse(await readFile(path.join(directory, 'latest.json')));
  assert.equal(record.status, 'failed');
  assert.equal(record.failure_stage, 'Sampling 2/3');
  assert.equal(record.source.model, 'gpt-6.1-sol');
  assert.equal(record.expected_model_in_bank, true);
  assert.deepEqual(record.reference_match, { id: 'gpt-6-astra', members: ['gpt-6-astra', 'gpt-6.1-sol'] });
  assert.equal(record.samples_completed, 1);
  assert.equal(record.samples[0].text, text);
  assert.equal(clients.length, 2);
  assert.ok(clients.every(client => client.closed));
});
