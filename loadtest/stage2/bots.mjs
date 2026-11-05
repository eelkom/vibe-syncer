import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { deadline } from '../lib/common.mjs';
export async function startBots() {
  const child = fork(fileURLToPath(new URL('./bots-worker.mjs', import.meta.url)), [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], execArgv: [] });
  let next = 0, exited = false, errorText = '', state = { connected: 0, attempted: 0, admission_failed: 0, gave_up: 0 };
  const pending = new Map();
  child.stderr.on('data', b => { errorText = (errorText + b.toString()).slice(-4000); });
  const ready = new Promise(resolve => child.on('message', m => { if (m.type === 'ready') resolve(); }));
  child.on('message', m => {
    if (m.type === 'status') state = m;
    if (m.reply) { pending.get(m.reply)?.resolve(m); pending.delete(m.reply); }
  });
  const ended = new Promise(resolve => child.once('exit', resolve));
  child.on('exit', (code, signal) => { exited = true; for (const p of pending.values()) p.reject(new Error(`Bot child exited ${code}/${signal}: ${errorText}`)); pending.clear(); });
  child.on('error', error => { errorText += error.message; });
  try { await deadline(ready, 10000, 'bot child ready'); }
  catch (error) { child.kill('SIGKILL'); throw error; }
  const request = async (type, data = {}) => {
    const id = ++next;
    const promise = new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); });
    promise.catch(() => {});
    child.send({ type, id, ...data });
    return deadline(promise, 10000, `bot child ${type}`);
  };
  return { child, get status() { return state; },
    admit: config => request('admit', config), traffic: config => request('traffic', config),
    snapshot: async () => (await request('snapshot')).data,
    async stop() { if (exited) throw new Error(`Bot child unavailable: ${errorText}`); const data = (await request('stop')).data; await deadline(ended, 10000, 'bot process exit'); return data; },
    async kill() { if (!exited) { child.kill('SIGKILL'); await deadline(ended, 10000, 'bot SIGKILL exit'); } } };
}
