import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { atomicJson, dataDirectories, loadRuns, workerIdentity } from '../scripts/records.mjs';
import { completionReport, finding, report } from '../scripts/report.mjs';
import { main } from '../scripts/cli.mjs';
import { runHook, startupNotice } from '../scripts/session-start.mjs';

const fixture = (overrides = {}) => ({
  session_id: 'thread-one', run_id: '1793443203368-aabbccdd-1234-1234-1234-123456789abc',
  started_at: '2026-10-31T10:40:03.369Z', finished_at: '2026-10-31T10:42:50.415Z', status: 'completed',
  source: { model: 'unseen-model', provider: 'openai', effort: 'high' }, expected_model_in_bank: false,
  result: { prediction: 'known-model', used_outputs: 3, results: [{ model: 'known-model', probability: 0.999999 }] }, ...overrides,
});

async function temporary(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'modeltrace-status-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function save(directory, record, name = `${record.session_id}-${record.run_id}.json`) {
  await mkdir(directory, { recursive: true });
  await atomicJson(path.join(directory, name), record);
}

async function command(args, env, extras = {}) {
  let output = '', errors = '';
  await main(args, { env, stdout: { write: s => { output += s; } }, stderr: { write: s => { errors += s; } }, ...extras });
  return { output, errors };
}

test('status sees active progress and partial samples, then a failure in the same run', async t => {
  const directory = await temporary(t);
  let release, ready;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { ready = resolve; });
  const work = runHook({ hook_event_name: 'SessionStart', source: 'resume', session_id: 'thread-one' }, {
    directory, env: {}, runProbe: async (_input, { onProgress }) => {
      await onProgress({ phase: 'sampling', sample_index: 2, samples_completed: 1, samples: [{ text: 'saved first sample' }],
        source: fixture().source }, 'Sampling 2/3');
      ready(); await gate;
      throw new Error('Second sample timed out');
    },
  });
  try {
    await started;
    const { output } = await command(['status'], { MODELTRACE_DATA_DIR: directory, CODEX_THREAD_ID: 'thread-one' });
    assert.match(output, /RUNNING/);
    assert.match(output, /Sampling 2\/3/);
    assert.match(output, /Samples: 1\/3 valid/);
  } finally { release(); }
  await work;
  const { runs } = await loadRuns({ directories: [directory] });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'failed');
  assert.equal(runs[0].samples[0].text, 'saved first sample');
  assert.equal(runs[0].failure_stage, 'Sampling 2/3');
  assert.match(report(runs[0], { details: true }), /Timeline:[\s\S]*Sampling 2\/3[\s\S]*Failed: Second sample timed out/);
});

test('discovers installed and legacy records without duplicating latest.json or changing old files', async t => {
  const home = await temporary(t);
  const installed = path.join(home, 'plugins/data/modeltrace-session-roger-local');
  const legacy = path.join(home, 'modeltrace-session');
  const first = fixture();
  await save(installed, first);
  await save(installed, first, 'latest.json');
  await save(legacy, first);
  await save(legacy, fixture({ run_id: 'older', started_at: '2026-10-30T10:40:00Z' }));
  assert.deepEqual(new Set(await dataDirectories({ CODEX_HOME: home })), new Set([installed, legacy]));
  const before = await readFile(path.join(installed, 'latest.json'), 'utf8');
  const { runs } = await loadRuns({ env: { CODEX_HOME: home } });
  assert.equal(runs.length, 2);
  assert.equal(runs[0].run_id, first.run_id);
  assert.ok(!runs[0].filename.endsWith('/latest.json'));
  assert.equal(await readFile(path.join(installed, 'latest.json'), 'utf8'), before);
});

test('current-session status never silently shows another thread, and --all is explicit', async t => {
  const directory = await temporary(t);
  await save(directory, fixture());
  await save(directory, fixture({ session_id: 'thread-two', run_id: 'newer-run', started_at: '2026-10-31T11:00:00Z' }));
  const env = { MODELTRACE_DATA_DIR: directory, CODEX_THREAD_ID: 'thread-one' };
  const current = JSON.parse((await command(['status', '--json'], env)).output);
  assert.equal(current.runs[0].session_id, 'thread-one');
  assert.equal(current.runs[0].finding, 'inconclusive');
  const all = JSON.parse((await command(['status', '--all', '--json'], env)).output);
  assert.equal(all.runs[0].session_id, 'thread-two');
  const empty = await command(['status', '--session', 'missing-thread'], env);
  assert.match(empty.output, /No ModelTrace test recorded for this session/);
  assert.doesNotMatch(empty.output, /known-model/);
});

test('history includes failures and interruptions, supports limits, and short IDs open full details', async t => {
  const directory = await temporary(t);
  await save(directory, fixture({ events: [{ at: fixture().started_at, message: 'Reading session settings' }] }));
  await save(directory, fixture({ run_id: 'failed', status: 'failed', started_at: '2026-10-31T11:00:00Z', error: 'timeout' }));
  await save(directory, fixture({ run_id: 'stale', status: 'running', finished_at: undefined, started_at: '2026-10-30T11:00:00Z' }));
  const env = { MODELTRACE_DATA_DIR: directory };
  const history = await command(['history', '--limit', '2'], env);
  assert.match(history.output, /Showing 2 of 3 tests/);
  assert.ok(history.output.indexOf('FAILED') < history.output.indexOf('COMPLETED'));
  const full = await command(['show', 'aabbccdd'], { ...env, CODEX_THREAD_ID: 'another-thread' });
  assert.match(full.output, /Run: 1793443203368-aabbccdd/);
  assert.match(full.output, /Timeline:[\s\S]*Reading session settings/);
  const all = await command(['history', '--json'], env);
  const stale = JSON.parse(all.output).runs.find(r => r.run_id === 'stale');
  assert.equal(stale.status, 'interrupted');
  assert.equal(stale.finished_at, undefined);
});

test('detects dead workers and reused PIDs without declaring workers in another namespace dead', async t => {
  const directory = await temporary(t);
  const identity = await workerIdentity();
  const now = new Date().toISOString();
  const base = fixture({ status: 'running', started_at: now, finished_at: undefined });
  await save(directory, { ...base, run_id: 'live', worker: identity });
  await save(directory, { ...base, run_id: 'dead', worker: { ...identity, pid: 2147483647 } });
  await save(directory, { ...base, run_id: 'foreign', worker: { ...identity, pid: 2147483647, pid_namespace: 'another-namespace' } });
  await save(directory, { ...base, run_id: 'expired-foreign', deadline_at: '2020-01-01T00:00:00Z', worker: { ...identity, pid_namespace: 'another-namespace' } });
  if (identity.start_ticks) await save(directory, { ...base, run_id: 'reused', worker: { ...identity, start_ticks: '0' } });
  const { runs } = await loadRuns({ directories: [directory] });
  const statuses = Object.fromEntries(runs.map(r => [r.run_id, r.status]));
  assert.equal(statuses.live, 'running');
  assert.equal(statuses.dead, 'interrupted');
  assert.equal(statuses.foreign, 'running');
  assert.equal(statuses['expired-foreign'], 'interrupted');
  if (identity.start_ticks) assert.equal(statuses.reused, 'interrupted');
});

test('malformed results are reported without hiding valid history', async t => {
  const directory = await temporary(t);
  await save(directory, fixture());
  await writeFile(path.join(directory, 'broken.json'), '{broken');
  await writeFile(path.join(directory, 'invalid.json'), 'null');
  const { output, errors } = await command(['history'], { MODELTRACE_DATA_DIR: directory });
  assert.match(output, /COMPLETED/);
  assert.match(errors, /Unreadable result JSON/);
  assert.match(errors, /Invalid result record/);
});

test('watch emits changes in captured shell output and exits when the test finishes', async t => {
  const directory = await temporary(t);
  const record = fixture({ status: 'running', phase: 'sampling', sample_index: 3, samples_completed: 2,
    started_at: new Date().toISOString(), finished_at: undefined, worker: await workerIdentity() });
  await save(directory, record);
  let sleeps = 0;
  const { output } = await command(['watch'], { MODELTRACE_DATA_DIR: directory }, {
    sleep: async () => {
      sleeps++;
      if (sleeps === 2) await save(directory, { ...record, status: 'completed', samples_completed: 3, finished_at: new Date().toISOString() });
      assert.ok(sleeps <= 2);
    },
  });
  assert.equal(sleeps, 2);
  assert.equal(output.match(/ModelTrace — /g).length, 2);
  assert.match(output, /RUNNING[\s\S]*Sampling 3\/3[\s\S]*COMPLETED/);
  assert.doesNotMatch(output, /\x1b/);
});

test('completed tests distinguish coverage, a matching fingerprint, and an unexpected reference', () => {
  assert.equal(finding(fixture()), 'inconclusive');
  assert.equal(finding(fixture({ expected_model_in_bank: true })), 'unexpected fingerprint');
  assert.equal(finding(fixture({ expected_model_in_bank: true, source: { model: 'known-model' } })), 'consistent');
  assert.match(report(fixture()), /COMPLETED · INCONCLUSIVE/);
  assert.doesNotMatch(report(fixture()), /100\.0%/);
  assert.match(report(fixture()), /\d{4}-\d{2}-\d{2} .* [+-]\d{2}:\d{2}/);
});

test('an explicit model alias is consistent with its reference group and keeps the group label visible', () => {
  const record = fixture({ expected_model_in_bank: true, source: { model: 'gpt-6.1-sol' },
    reference_match: { id: 'gpt-6-astra', members: ['gpt-6-astra', 'gpt-6.1-sol'] },
    result: { prediction: 'gpt-6-astra', prediction_name: 'gpt-6-astra/6.1-sol',
      results: [{ model: 'gpt-6-astra', display_name: 'gpt-6-astra/6.1-sol', probability: .99 }] } });
  assert.equal(finding(record), 'consistent');
  assert.match(completionReport(record), /FINISHED · CONSISTENT.*closest reference gpt-6-astra\/6\.1-sol/);
  assert.match(completionReport(record), /does not distinguish its members or prove exact identity/);
  assert.match(report(record), /Closest reference: gpt-6-astra\/6\.1-sol/);
  assert.equal(finding({ ...record, result: { prediction: 'different-model' } }), 'unexpected fingerprint');
  assert.equal(finding({ ...record, reference_match: undefined, expected_model_in_bank: false }), 'inconclusive');
});

test('startup stays silent without a previous result and never creates history', async t => {
  const directory = await temporary(t);
  const env = { MODELTRACE_DATA_DIR: directory };
  const event = { hook_event_name: 'SessionStart', source: 'startup', session_id: 'thread-one' };
  assert.equal(await startupNotice(event, env), null);
  assert.equal(await startupNotice({ ...event, source: 'compact' }, env), null);
  assert.equal(await startupNotice(event, { ...env, MODELTRACE_SESSION_PROBE: '1' }), null);
  assert.deepEqual(await readdir(directory), []);
});

test('startup stays silent after a consistent result instead of resurfacing older or other-session failures', async t => {
  const directory = await temporary(t);
  const event = { hook_event_name: 'SessionStart', source: 'resume', session_id: 'thread-one' };
  const env = { MODELTRACE_DATA_DIR: directory };
  await save(directory, fixture({ run_id: 'older-failure', status: 'failed', started_at: '2026-10-30T10:40:00Z', error: 'old failure' }));
  await save(directory, fixture({ expected_model_in_bank: true, source: { model: 'known-model' } }));
  assert.equal(await startupNotice(event, env), null);
  assert.equal(await startupNotice({ ...event, session_id: 'brand-new' }, env), null);
  await save(directory, fixture({ session_id: 'another-thread', run_id: 'other-failure', status: 'failed',
    started_at: '2026-10-31T11:00:00Z', error: 'other session failure' }));
  assert.equal(await startupNotice(event, env), null);
  await writeFile(path.join(directory, 'broken.json'), '{broken');
  const notice = await startupNotice(event, env);
  assert.match(notice.systemMessage, /history is unreadable/);
});

test('startup prefers this session’s previous result over newer runs, active tests, and skipped tests', async t => {
  const directory = await temporary(t);
  await save(directory, fixture());
  await save(directory, fixture({ session_id: 'another-thread', run_id: 'other', started_at: '2026-10-31T11:00:00Z',
    status: 'failed', error: 'other session failure' }));
  await save(directory, fixture({ run_id: 'active', status: 'running', started_at: new Date().toISOString(),
    finished_at: undefined, worker: await workerIdentity() }));
  await save(directory, fixture({ run_id: 'skip', status: 'skipped', started_at: '2026-10-31T12:00:00Z' }));
  const notice = await startupNotice({ hook_event_name: 'SessionStart', source: 'resume', session_id: 'thread-one' },
    { MODELTRACE_DATA_DIR: directory });
  assert.match(notice.systemMessage, /Last \(this session, .*\): FINISHED · INCONCLUSIVE/);
  assert.match(notice.systemMessage, /configured unseen-model · closest reference known-model · 2m 47s/);
  assert.doesNotMatch(notice.systemMessage, /RUNNING|SKIPPED|other session failure/);
  assert.equal(notice.systemMessage.split('\n').length, 2);
  assert.deepEqual(Object.keys(notice), ['systemMessage']);
});

test('new sessions label a fallback from another session and retain the most recent failure', async t => {
  const directory = await temporary(t);
  await save(directory, fixture());
  await save(directory, fixture({ run_id: 'failed', status: 'failed', started_at: '2026-10-31T11:00:00Z',
    finished_at: '2026-10-31T11:00:10Z', error: 'Second sample\ntimed out' }));
  const notice = await startupNotice({ hook_event_name: 'SessionStart', source: 'startup', session_id: 'brand-new' },
    { MODELTRACE_DATA_DIR: directory });
  assert.match(notice.systemMessage, /Last \(another session, .*\): FAILED/);
  assert.match(notice.systemMessage, /Reason: Second sample timed out/);
  assert.doesNotMatch(notice.systemMessage, /FINISHED|this session/);
  assert.equal(notice.systemMessage.split('\n').length, 2);
});

test('startup discovers saved history and tolerates corrupt or inaccessible records', async t => {
  const home = await temporary(t);
  const legacy = path.join(home, 'modeltrace-session');
  const event = { hook_event_name: 'SessionStart', source: 'startup', session_id: 'thread-one' };
  await mkdir(legacy);
  await writeFile(path.join(legacy, 'broken.json'), '{broken');
  const corrupt = await startupNotice(event, { CODEX_HOME: home });
  assert.match(corrupt.systemMessage, /testing in background[\s\S]*history is unreadable/);
  await save(legacy, fixture());
  const valid = await startupNotice(event, { CODEX_HOME: home });
  assert.match(valid.systemMessage, /Last \(this session, .*\): FINISHED/);
  const unavailable = await startupNotice(event, { MODELTRACE_DATA_DIR: path.join(legacy, 'broken.json') });
  assert.match(unavailable.systemMessage, /testing in background[\s\S]*history is unavailable/);
});

test('completion emits FINISHED with a brief finding after saving the full result', async t => {
  const directory = await temporary(t);
  const event = { hook_event_name: 'SessionStart', source: 'startup', session_id: 'thread-one' };
  const output = await runHook(event, { directory, env: {}, runProbe: async () => ({
    status: 'completed', source: fixture().source, expected_model_in_bank: false,
    result: fixture().result, samples_completed: 3,
  }) });
  assert.match(output.systemMessage, /ModelTrace — FINISHED · INCONCLUSIVE/);
  assert.match(output.systemMessage, /configured unseen-model · closest reference known-model/);
  assert.match(output.systemMessage, /absent from the reference bank; exact identity is unverified/);
  assert.match(output.systemMessage, /!modeltrace status.*!modeltrace history/);
  assert.equal(output.systemMessage.split('\n').length, 3);
  assert.deepEqual(Object.keys(output), ['systemMessage']);
  const saved = JSON.parse(await readFile(path.join(directory, 'latest.json'), 'utf8'));
  assert.equal(saved.status, 'completed');
  assert.equal(saved.samples_completed, 3);
  assert.ok(saved.finished_at);
  assert.match(report(saved), /ModelTrace — COMPLETED · INCONCLUSIVE/);
});

test('consistent completions stay silent while status and history retain the result, including model aliases', async t => {
  for (const reference of [
    { source: { model: 'known-model' }, result: fixture().result },
    { source: { model: 'gpt-6.1-sol' }, reference_match: { id: 'gpt-6-astra', members: ['gpt-6-astra', 'gpt-6.1-sol'] },
      result: { prediction: 'gpt-6-astra', results: [{ model: 'gpt-6-astra', probability: .99 }] } },
  ]) {
    const directory = await temporary(t);
    const event = { hook_event_name: 'SessionStart', source: 'startup', session_id: 'thread-one' };
    const env = { MODELTRACE_DATA_DIR: directory, CODEX_THREAD_ID: event.session_id };
    const output = await runHook(event, { directory, env, runProbe: async () => ({
      status: 'completed', expected_model_in_bank: true, samples_completed: 3, ...reference,
    }) });
    assert.equal(output, null);
    const saved = JSON.parse(await readFile(path.join(directory, 'latest.json'), 'utf8'));
    assert.equal(saved.status, 'completed');
    assert.equal(saved.samples_completed, 3);
    assert.ok(saved.finished_at);
    const { runs } = await loadRuns({ env });
    assert.equal(runs.length, 1);
    assert.equal(finding(runs[0]), 'consistent');
    assert.match((await command(['status'], env)).output, /COMPLETED · CONSISTENT/);
    assert.match((await command(['history'], env)).output, /consistent/);
    assert.equal(await startupNotice(event, env), null);
    assert.ok(!(await readdir(directory)).some(name => name.endsWith('.lock')));
  }
});

test('unexpected fingerprints still emit a warning after saving the result', async t => {
  const directory = await temporary(t);
  const event = { hook_event_name: 'SessionStart', source: 'startup', session_id: 'thread-one' };
  const output = await runHook(event, { directory, env: {}, runProbe: async () => ({
    status: 'completed', source: fixture().source, expected_model_in_bank: true,
    result: fixture().result, samples_completed: 3,
  }) });
  assert.match(output.systemMessage, /FINISHED · UNEXPECTED FINGERPRINT/);
  const saved = JSON.parse(await readFile(path.join(directory, 'latest.json'), 'utf8'));
  assert.equal(finding(saved), 'unexpected fingerprint');
});

test('brief completion keeps matching and unexpected fingerprints qualified and bounds errors', () => {
  const consistent = completionReport(fixture({ expected_model_in_bank: true, source: { model: 'known-model' } }));
  assert.match(consistent, /FINISHED · CONSISTENT/);
  assert.match(consistent, /does not prove identity/);
  const unexpected = completionReport(fixture({ expected_model_in_bank: true }));
  assert.match(unexpected, /FINISHED · UNEXPECTED FINGERPRINT/);
  assert.match(unexpected, /not proof of substitution/);
  const failure = completionReport(fixture({ status: 'failed', error: 'timeout\n' + 'x'.repeat(500) }));
  assert.match(failure, /FAILED.*Reason: timeout x+…/);
  assert.doesNotMatch(failure, /FINISHED/);
  assert.equal(failure.split('\n').length, 2);
});

test('invalid filters and ambiguous run prefixes fail clearly', async t => {
  const directory = await temporary(t);
  const env = { MODELTRACE_DATA_DIR: directory };
  await save(directory, fixture({ run_id: 'same-one' }));
  await save(directory, fixture({ run_id: 'same-two' }));
  await assert.rejects(command(['show', 'same'], env), /ambiguous/);
  await assert.rejects(command(['history', '--limit', '0'], env), /between 1 and 1000/);
  await assert.rejects(command(['status', '--session', 'one', '--all'], env), /Choose --all or --session/);
});
