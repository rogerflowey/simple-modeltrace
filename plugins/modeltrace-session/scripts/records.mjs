import { readFile, readlink, readdir, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export function dataDirectory(env = process.env) {
  return env.MODELTRACE_DATA_DIR || env.PLUGIN_DATA
    || path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'modeltrace-session');
}

export async function atomicJson(filename, value) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, filename);
}

export async function dataDirectories(env = process.env) {
  if (env.MODELTRACE_DATA_DIR || env.PLUGIN_DATA) return [path.resolve(dataDirectory(env))];
  const home = env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const installed = path.join(home, 'plugins/data');
  let entries;
  try { entries = await readdir(installed, { withFileTypes: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; entries = []; }
  return [...entries.filter(e => e.isDirectory() && /^modeltrace-session(?:-|$)/.test(e.name))
    .map(e => path.join(installed, e.name)), path.join(home, 'modeltrace-session')];
}

// Linux process start ticks distinguish a worker from an unrelated reused PID.
export async function workerIdentity(pid = process.pid) {
  const pidNamespace = await readlink('/proc/self/ns/pid').catch(() => undefined);
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { pid, pid_namespace: pidNamespace, start_ticks: fields[19], process_state: fields[0] };
  } catch { return { pid, pid_namespace: pidNamespace }; }
}

export async function workerAlive(worker, { checkNamespace = false } = {}) {
  if (!Number.isSafeInteger(worker?.pid) || worker.pid <= 0) return false;
  if (checkNamespace) {
    const current = await workerIdentity();
    // Hook workers can run outside the shell tool's PID namespace. A missing
    // PID there is not evidence of a dead host worker, especially for v1 files.
    if (!worker.pid_namespace || !current.pid_namespace || worker.pid_namespace !== current.pid_namespace) return null;
  }
  try { process.kill(worker.pid, 0); }
  catch (error) { return error.code === 'EPERM'; }
  const current = await workerIdentity(worker.pid);
  if (['Z', 'X'].includes(current.process_state)) return false;
  if (worker.start_ticks && current.start_ticks && current.start_ticks !== worker.start_ticks) return false;
  return true;
}

async function effectiveRecord(record, directory) {
  if (record.status !== 'running') return record;
  let worker = record.worker;
  if (!worker) {
    // Version 1.0 stored the worker PID only in a per-session lock.
    try {
      const lock = JSON.parse(await readFile(path.join(directory, `${record.session_id}.lock`), 'utf8'));
      if (Math.abs(Date.parse(lock.at) - Date.parse(record.started_at)) < 1000) worker = lock;
    } catch (error) { if (!['ENOENT'].includes(error.code) && !(error instanceof SyntaxError)) throw error; }
  }
  const alive = await workerAlive(worker, { checkNamespace: true });
  const expired = Date.now() > Date.parse(record.deadline_at || new Date(Date.parse(record.started_at) + 600_000).toISOString());
  if (alive === true || (alive === null && !expired)) return record;
  return { ...record, status: 'interrupted', interrupted_at_unknown: true,
    error: alive === false ? 'Worker exited before saving a final result; the exact stop time is unknown.'
      : 'No final result was saved before the hook deadline; the exact stop time is unknown.' };
}

export async function loadRuns({ directories, env = process.env, sessionId } = {}) {
  directories ??= await dataDirectories(env);
  const unique = new Map();
  const warnings = [];
  for (const directory of directories) {
    let names;
    try { names = await readdir(directory); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const name of names.filter(n => n.endsWith('.json'))) {
      const filename = path.join(directory, name);
      let record;
      try { record = JSON.parse(await readFile(filename, 'utf8')); }
      catch (error) {
        if (error.code === 'ENOENT') continue;
        if (!(error instanceof SyntaxError)) throw error;
        warnings.push(`Unreadable result JSON: ${filename}`); continue;
      }
      if (!record || typeof record.run_id !== 'string' || !/^[a-zA-Z0-9_-]{1,150}$/.test(record.session_id || '')
        || !Number.isFinite(Date.parse(record.started_at)) || !['running', 'completed', 'failed', 'skipped', 'interrupted'].includes(record.status)) {
        warnings.push(`Invalid result record: ${filename}`); continue;
      }
      if (sessionId && record.session_id !== sessionId) continue;
      const key = `${record.session_id}/${record.run_id}`;
      const previous = unique.get(key);
      const stamp = Date.parse(record.updated_at || record.finished_at || record.started_at) || 0;
      const prevStamp = previous ? Date.parse(previous.updated_at || previous.finished_at || previous.started_at) || 0 : -1;
      if (stamp > prevStamp || (stamp === prevStamp && name !== 'latest.json' && previous?.filename.endsWith('/latest.json'))) {
        unique.set(key, { ...record, filename, directory });
      }
    }
  }
  const runs = await Promise.all([...unique.values()].map(r => effectiveRecord(r, r.directory)));
  runs.sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at) || b.run_id.localeCompare(a.run_id));
  return { runs, warnings, directories };
}
