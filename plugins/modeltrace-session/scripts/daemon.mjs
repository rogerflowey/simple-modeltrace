import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

// The control socket speaks WebSocket, not newline-delimited stdio. This small
// read-only client uses only Node built-ins and never starts or resumes a turn.
export async function readDaemonThread(threadId, env = process.env) {
  const socketPath = env.MODELTRACE_CODEX_SOCKET || path.join(
    env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'app-server-control/app-server-control.sock',
  );
  const key = randomBytes(16).toString('base64');
  const request = http.request({
    socketPath, path: '/', headers: {
      Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key,
    },
  });
  let socket, buffer = Buffer.alloc(0), fragments = [], fragmentBytes = 0;
  const pending = new Map();
  const fail = error => {
    for (const p of pending.values()) p.reject(error);
    pending.clear();
  };
  const sendFrame = (data, opcode = 1) => {
    const payload = Buffer.from(data);
    const extra = payload.length < 126 ? 0 : 2;
    const frame = Buffer.alloc(2 + extra + 4 + payload.length);
    frame[0] = 0x80 | opcode;
    frame[1] = 0x80 | (extra ? 126 : payload.length);
    if (extra) frame.writeUInt16BE(payload.length, 2);
    const mask = randomBytes(4);
    mask.copy(frame, 2 + extra);
    for (let i = 0; i < payload.length; i++) frame[6 + extra + i] = payload[i] ^ mask[i % 4];
    socket.write(frame);
  };
  const receive = chunk => {
    try {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        const final = !!(buffer[0] & 0x80), opcode = buffer[0] & 15;
        let length = buffer[1] & 127, header = 2;
        if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); header = 4; }
        if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); header = 10; }
        if (length > 1024 * 1024 || (buffer[1] & 0x80)) throw new Error('Invalid daemon WebSocket frame');
        if (buffer.length < header + length) return;
        const payload = buffer.subarray(header, header + length);
        buffer = buffer.subarray(header + length);
        if (opcode === 8) throw new Error('Codex daemon closed the connection');
        if (opcode === 9) { sendFrame(payload, 10); continue; }
        if (opcode === 10) continue;
        if (![0, 1].includes(opcode)) throw new Error('Unexpected daemon WebSocket message');
        fragments.push(payload); fragmentBytes += payload.length;
        if (fragmentBytes > 1024 * 1024) throw new Error('Daemon metadata response too large');
        if (!final) continue;
        const message = JSON.parse(Buffer.concat(fragments).toString('utf8'));
        fragments = []; fragmentBytes = 0;
        const p = pending.get(message.id);
        if (p && !message.method) {
          pending.delete(message.id);
          if (message.error) p.reject(new Error(`Codex daemon: ${message.error.message}`));
          else p.resolve(message.result);
        }
      }
    } catch (error) { fail(error); socket.destroy(); }
  };
  const deadline = setTimeout(() => {
    const error = new Error('Codex daemon metadata request timed out');
    fail(error); request.destroy(error); socket?.destroy();
  }, 5000);
  try {
    await new Promise((resolve, reject) => {
      request.once('error', reject);
      request.once('response', response => { response.resume(); reject(new Error('Codex daemon refused WebSocket upgrade')); });
      request.once('upgrade', (response, stream, head) => {
        socket = stream;
        const expected = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        if (response.headers['sec-websocket-accept'] !== expected) {
          stream.destroy(); reject(new Error('Invalid Codex daemon handshake')); return;
        }
        stream.on('data', receive);
        stream.on('error', fail);
        stream.on('close', () => fail(new Error('Codex daemon connection closed')));
        if (head.length) receive(head);
        resolve();
      });
      request.end();
    });
    let id = 0;
    const rpc = (method, params) => new Promise((resolve, reject) => {
      const requestId = ++id;
      pending.set(requestId, { resolve, reject });
      sendFrame(JSON.stringify({ id: requestId, method, params }));
    });
    await rpc('initialize', { clientInfo: { name: 'modeltrace_session', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    sendFrame(JSON.stringify({ method: 'initialized' }));
    const { thread } = await rpc('thread/read', { threadId, includeTurns: false });
    return thread;
  } finally {
    clearTimeout(deadline);
    socket?.destroy();
    request.destroy();
  }
}
