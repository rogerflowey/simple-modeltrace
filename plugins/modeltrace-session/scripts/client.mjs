import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// Every probe has its own app-server process. Closing it destroys its ephemeral
// threads. Credentials are handled entirely by Codex, never by this plugin.
export class Client {
  constructor(child) {
    this.child = child;
    this.pending = new Map();
    this.listeners = new Set();
    this.nextId = 0;
    this.lines = createInterface({ input: child.stdout });
    this.lines.on('line', line => {
      try {
        const m = JSON.parse(line);
        const p = this.pending.get(m.id);
        if (p && !m.method) {
          clearTimeout(p.timer);
          this.pending.delete(m.id);
          if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`));
          else p.resolve(m.result);
        } else if (m.method) {
          // No permission requests, tool executions, or user interaction.
          if (m.id !== undefined) this.send({ id: m.id, error: { code: -32601, message: 'Fingerprint probes cannot use tools' } });
          for (const listener of this.listeners) listener(m);
        }
      } catch (error) { this.fail(error); }
    });
    child.stderr.resume();
    child.stdin.on('error', error => this.fail(error));
    this.exited = new Promise(resolve => {
      child.once('error', error => { this.fail(error); resolve(); });
      child.once('exit', () => { this.fail(new Error('Codex transport closed')); resolve(); });
    });
  }

  fail(error) {
    this.error ??= error;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    if (!this.closing) this.child.kill();
  }

  send(message) {
    if (this.error) throw this.error;
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  request(method, params = {}, timeout = 15000) {
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  async close() {
    this.closing = true;
    this.child.stdin.end();
    this.child.kill();
    let timer;
    await Promise.race([this.exited, new Promise(resolve => {
      timer = setTimeout(() => { this.child.kill('SIGKILL'); resolve(); }, 2000);
    })]);
    clearTimeout(timer);
    this.lines.close();
  }
}

export async function connect({ env = process.env } = {}) {
  const args = [
    'app-server', '--stdio', '-c', 'features.hooks=false',
    '-c', 'tools.shell=false', '-c', 'web_search="disabled"',
  ];
  const child = spawn(env.MODELTRACE_CODEX_PATH || 'codex', args, {
    env: { ...env, MODELTRACE_SESSION_PROBE: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const client = new Client(child);
  try {
    await client.request('initialize', {
      clientInfo: { name: 'modeltrace_session', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    client.send({ method: 'initialized' });
    return client;
  } catch (error) { await client.close(); throw error; }
}

export async function generate(client, threadId, prompt, timeout = 150000) {
  let resolve, reject;
  let text = null;
  const unphased = [];
  const result = new Promise((yes, no) => { resolve = yes; reject = no; });
  result.catch(() => {});
  const timer = setTimeout(() => reject(new Error('Fingerprint sample timed out')), timeout);
  const listener = m => {
    const p = m.params;
    if (p?.threadId !== threadId) return;
    if (m.method === 'item/started' && !['userMessage', 'agentMessage', 'reasoning'].includes(p.item?.type)) {
      reject(new Error('Fingerprint sample attempted a tool; sample rejected'));
    }
    if (m.method === 'item/completed' && p.item?.type === 'agentMessage') {
      if (['final_answer', 'final'].includes(p.item.phase)) text = p.item.text;
      else if (!p.item.phase) unphased.push(p.item.text);
    }
    if (m.method === 'error' && !p.willRetry) reject(new Error('Codex fingerprint inference failed'));
    if (m.method === 'turn/completed') {
      if (p.turn?.status !== 'completed') reject(new Error('Fingerprint turn did not complete'));
      else resolve(text ?? (unphased.length === 1 ? unphased[0] : null));
    }
  };
  client.listeners.add(listener);
  const onExit = () => reject(new Error('Codex exited before the sample completed'));
  client.child.once('exit', onExit);
  try {
    // The listener is registered before turn/start: notifications can race the reply.
    await client.request('turn/start', { threadId, input: [{ type: 'text', text: prompt }] });
    const answer = await result;
    if (typeof answer !== 'string') throw new Error('Fingerprint returned no final answer');
    return answer;
  } finally {
    clearTimeout(timer);
    client.listeners.delete(listener);
    client.child.removeListener('exit', onExit);
  }
}
