import { spawnSync } from 'node:child_process';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeGlobalOutputs, parseNumbers } from '../vendor/fingerprint-core.mjs';
import { connect, generate } from './client.mjs';
import { readDaemonThread } from './daemon.mjs';
import { atomicJson, dataDirectory, loadRuns, workerAlive, workerIdentity } from './records.mjs';
import { briefReport, completionReport, report, timestamp, phase as describePhase } from './report.mjs';
export { atomicJson } from './records.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = dataDirectory();
const SCOPE = 'This is a standalone ModelTrace numerical fingerprint sample, authorized by the session-start plugin. Complete only the numerical task below. Do not call any tools.';

export function challenges() {
  const code = 'import json,runpy,sys; m=runpy.run_path(sys.argv[1]); print(json.dumps(m["generate_challenges"](3)))';
  const p = spawnSync('python3', ['-c', code, path.join(ROOT, 'vendor/challenges.py')], { encoding: 'utf8', timeout: 10000 });
  if (p.status !== 0) throw new Error('Python 3 is required to generate the ModelTrace challenges');
  return JSON.parse(p.stdout);
}

// Prefer the live daemon so a CLI -m or resumed thread model is respected. A
// standalone app-server can read persisted threads when the CLI has no daemon.
export async function sourceSettings(input, openClient = connect, readLive = readDaemonThread) {
  let lastError;
  for (const live of [true, false]) {
    let client;
    try {
      let thread;
      if (live) thread = await readLive(input.session_id);
      else {
        client = await openClient();
        ({ thread } = await client.request('thread/read', { threadId: input.session_id, includeTurns: false }));
      }
      if (thread.parentThreadId || thread.agentRole) return null;
      if (!thread.model || !thread.modelProvider) throw new Error('Session model metadata is not available yet');
      return { model: thread.model, provider: thread.modelProvider, effort: thread.reasoningEffort ?? null, cwd: thread.cwd || input.cwd };
    } catch (error) { lastError = error; }
    finally { await client?.close(); }
  }
  throw lastError;
}

export async function probe(input, { openClient = connect, makeChallenges = challenges, getSettings = sourceSettings,
  onProgress = async () => {},
} = {}) {
  const source = await getSettings(input, openClient);
  if (!source) return { status: 'skipped', reason: 'subagent' };
  const bank = JSON.parse(await readFile(path.join(ROOT, 'vendor/unified_bank.json'), 'utf8'));
  const samples = [];
  await onProgress({ source, expected_model_in_bank: bank.models.some(m => m.id === source.model), phase: 'preparing' }, 'Session settings resolved; preparing challenges');
  // Independent clean conversations avoid prior sample contamination and match
  // the upstream manual/API test. This tests the configured model/provider; it
  // does not sample the original task's in-flight response or preserve its context.
  for (const challenge of makeChallenges()) {
    await onProgress({ phase: 'sampling', sample_index: samples.length + 1, sample_started_at: new Date().toISOString() }, `Sampling ${samples.length + 1}/3`);
    const client = await openClient();
    try {
      const started = await client.request('thread/start', {
        model: source.model, modelProvider: source.provider, cwd: source.cwd,
        ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only',
        baseInstructions: SCOPE, developerInstructions: SCOPE,
        config: { features: { hooks: false }, ...(source.effort ? { model_reasoning_effort: source.effort } : {}) },
      });
      if (!started.thread?.ephemeral || started.thread.path || started.model !== source.model || started.modelProvider !== source.provider
          || (source.effort && started.reasoningEffort !== source.effort)) {
        throw new Error('Probe did not preserve the source model/provider/effort in an ephemeral thread');
      }
      const text = await generate(client, started.thread.id, challenge.prompt);
      const count = parseNumbers(text).length;
      if (count < Math.max(80, Math.ceil(challenge.expected_count * 0.55))) throw new Error('Fingerprint answer was refused or truncated');
      samples.push({ ...challenge, text, parsed_numbers: count });
      await onProgress({ samples: [...samples], samples_completed: samples.length }, `Sample ${samples.length}/3 validated (${count} numbers)`);
    } finally { await client.close(); }
  }
  if (samples.length !== 3) throw new Error('Expected exactly three valid fingerprint samples');
  await onProgress({ phase: 'analyzing' }, 'Analyzing three valid samples');
  return {
    status: 'completed', source, scope: 'configured-model-independent-conversations',
    expected_model_in_bank: bank.models.some(m => m.id === source.model),
    result: analyzeGlobalOutputs(samples, bank), samples,
    caveat: 'Closed-set attribution among the bundled candidates, not proof of model identity. Task context and routing can affect results.',
  };
}

export function summary(record) {
  return report(record);
}

function eligible(input, env) {
  return env.MODELTRACE_SESSION_PROBE !== '1' && input.hook_event_name === 'SessionStart'
    && /^(startup|resume|clear|fork)$/.test(input.source || '') && !!input.session_id;
}

export async function startupNotice(input, env = process.env) {
  if (!eligible(input, env)) return null;
  let last = 'Last: no previous result.';
  try {
    const { runs, warnings } = await loadRuns({ env });
    const finished = runs.filter(r => ['completed', 'failed', 'interrupted'].includes(r.status));
    const previous = finished.find(r => r.session_id === input.session_id) || finished[0];
    if (previous) {
      const scope = previous.session_id === input.session_id ? 'this session' : 'another session';
      const time = timestamp(previous.finished_at || previous.started_at);
      last = `Last (${scope}, ${time}): ${briefReport(previous)}`;
    } else if (warnings.length) last = 'Last: saved history is unreadable · !modeltrace history';
  } catch { last = 'Last: saved history is unavailable · !modeltrace history'; }
  return { systemMessage: `ModelTrace · testing in background · !modeltrace status\n${last}` };
}

export async function runHook(input, { directory, runProbe = probe, env = process.env } = {}) {
  directory ??= dataDirectory(env);
  if (!eligible(input, env)) return null;
  if (!/^[a-zA-Z0-9_-]{1,150}$/.test(input.session_id)) throw new Error('Invalid session ID');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = path.join(directory, `${input.session_id}.lock`);
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // Never run two batches for concurrent startup/resume notifications.
    try {
      const existing = JSON.parse(await readFile(lockPath, 'utf8'));
      if (await workerAlive(existing)) return null;
      await unlink(lockPath);
    } catch { return null; }
    return runHook(input, { directory, runProbe, env });
  }
  let record;
  try {
    const worker = await workerIdentity();
    const runId = `${Date.now()}-${randomUUID()}`;
    const startedAt = new Date().toISOString();
    await lock.writeFile(JSON.stringify({ ...worker, run_id: runId, at: startedAt }));
    record = { schema_version: 2, session_id: input.session_id, source_event: input.source, run_id: runId,
      started_at: startedAt, updated_at: startedAt, deadline_at: new Date(Date.parse(startedAt) + 600_000).toISOString(),
      status: 'running', phase: 'starting', worker,
      configured_model: input.model || null, samples_completed: 0, samples_total: 3, samples: [],
      events: [{ at: startedAt, message: 'Reading session settings' }] };
    const filename = path.join(directory, `${input.session_id}-${runId}.json`);
    await atomicJson(filename, record);
    const onProgress = async (update, message) => {
      Object.assign(record, update, { updated_at: new Date().toISOString() });
      record.events.push({ at: record.updated_at, message });
      await atomicJson(filename, record);
    };
    try { Object.assign(record, await runProbe(input, { onProgress })); }
    catch (error) { Object.assign(record, { status: 'failed', error: error.message, failure_stage: describePhase(record) }); }
    record.finished_at = new Date().toISOString();
    record.updated_at = record.finished_at;
    record.duration_ms = Date.parse(record.finished_at) - Date.parse(record.started_at);
    record.phase = record.status;
    record.events.push({ at: record.finished_at, message: record.status === 'failed' ? `Failed: ${record.error}` : record.status });
    await atomicJson(filename, record);
    await atomicJson(path.join(directory, 'latest.json'), record);
    if (record.status === 'skipped') return null;
    return { systemMessage: completionReport(record) };
  } finally {
    await lock.close();
    await unlink(lockPath).catch(() => {});
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] && process.argv[2] !== 'notice') {
      const { main } = await import('./cli.mjs');
      await main();
    } else {
      let raw = '';
      for await (const chunk of process.stdin) raw += chunk;
      const input = JSON.parse(raw);
      const output = process.argv[2] === 'notice' ? await startupNotice(input) : await runHook(input);
      if (output) console.log(JSON.stringify(output));
    }
  } catch (error) {
    console.log(JSON.stringify({ systemMessage: `ModelTrace session test failed: ${error.message}` }));
    process.exitCode = 1;
  }
}
