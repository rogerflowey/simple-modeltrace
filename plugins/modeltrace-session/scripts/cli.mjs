import { setTimeout as delay } from 'node:timers/promises';
import { loadRuns } from './records.mjs';
import { finding, history, report, runLabel, usageReport } from './report.mjs';
import { aggregateUsage } from './usage.mjs';

const HELP = `Usage: modeltrace [status|history|show RUN|watch|usage] [options]

  status             Show the newest test for this Codex session
  history            Show recent tests (newest first)
  show RUN           Show a saved test and its timeline; accepts the short run ID
  watch              Follow progress until the newest test finishes
  usage              Sum plugin token usage across all tests in the selected scope

  --all              Include all sessions (default outside Codex)
  --session ID       Select a particular session
  --limit N          History length (default 10)
  --data-dir PATH    Read only this data directory
  --json             Print structured records, including raw samples
  --help             Show this help

Inside Codex: !modeltrace status, !modeltrace history, or !modeltrace usage
These commands read local results and never start a fingerprint test.`;

function options(args, env) {
  const result = { command: 'status', limit: 10, sessionId: env.CODEX_THREAD_ID || null };
  if (args[0] && !args[0].startsWith('-')) result.command = args.shift();
  if (!['status', 'history', 'show', 'watch', 'usage'].includes(result.command)) throw new Error(`Unknown command: ${result.command}`);
  if (result.command === 'show') {
    result.runId = args.shift();
    if (!result.runId || result.runId.startsWith('-')) throw new Error('show requires a run ID');
    result.sessionId = null;
  }
  let all = false, session = false;
  while (args.length) {
    const arg = args.shift();
    if (arg === '--json') result.json = true;
    else if (arg === '--all') { all = true; result.sessionId = null; }
    else if (['--session', '--limit', '--data-dir'].includes(arg)) {
      const value = args.shift();
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      if (arg === '--session') { session = true; result.sessionId = value; }
      else if (arg === '--data-dir') result.directory = value;
      else {
        result.limit = Number(value);
        if (!Number.isInteger(result.limit) || result.limit < 1 || result.limit > 1000) throw new Error('--limit must be between 1 and 1000');
      }
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (all && session) throw new Error('Choose --all or --session, not both');
  return result;
}

export async function main(args = process.argv.slice(2), {
  env = process.env, stdout = process.stdout, stderr = process.stderr, sleep = delay, interval = 2000,
} = {}) {
  if (args.includes('--help') || args.includes('-h')) { stdout.write(HELP + '\n'); return; }
  const opts = options([...args], env);
  let previous;
  do {
    const data = await loadRuns({ env, sessionId: opts.sessionId, directories: opts.directory ? [opts.directory] : undefined });
    const scope = opts.sessionId ? `Scope: session ${opts.sessionId}` : 'Scope: all sessions';
    if (opts.command === 'usage') {
      const usage = aggregateUsage(data.runs);
      stdout.write((opts.json ? JSON.stringify({ session_id: opts.sessionId, usage, warnings: data.warnings }, null, 2)
        : `${scope}\n${usageReport(usage)}`) + '\n');
      if (!opts.json) for (const warning of data.warnings) stderr.write(`ModelTrace: ${warning}\n`);
      return;
    }
    const selected = opts.command === 'show'
      ? data.runs.filter(r => r.run_id === opts.runId || runLabel(r) === opts.runId || r.run_id.startsWith(opts.runId)) : data.runs;
    if (opts.command === 'show' && selected.length !== 1) throw new Error(selected.length ? 'Run ID is ambiguous; use the full ID' : `No run found: ${opts.runId}`);
    const runs = opts.command === 'history' ? selected.slice(0, opts.limit) : selected.slice(0, 1);
    const output = opts.json ? JSON.stringify({ session_id: opts.sessionId, runs: runs.map(r => ({ ...r, finding: finding(r) })), warnings: data.warnings }, null, 2)
      : `${scope}\n${opts.command === 'history' ? `${history(runs)}\nShowing ${runs.length} of ${selected.length} tests. Details: !modeltrace show RUN`
        : runs[0] ? report(runs[0], { details: opts.command === 'show' })
        : opts.sessionId ? 'No ModelTrace test recorded for this session. Use --all to view other sessions.'
          : 'No ModelTrace tests recorded. Review /hooks, then start or resume a session.'}`;
    // In Codex the shell output is captured: append only actual state changes.
    // In a standalone terminal, redraw elapsed time every two seconds.
    const signature = JSON.stringify(runs);
    if (signature !== previous || stdout.isTTY) {
      if (opts.command === 'watch' && stdout.isTTY && previous !== undefined) stdout.write('\x1b[2J\x1b[H');
      stdout.write(output + '\n');
      if (!opts.json) for (const warning of data.warnings) stderr.write(`ModelTrace: ${warning}\n`);
    }
    previous = signature;
    if (opts.command !== 'watch' || !runs.length || runs[0].status !== 'running') return;
    await sleep(interval);
  } while (true);
}
