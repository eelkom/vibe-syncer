import { spawn } from 'node:child_process';
import { mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { ROOT, API, until, deadline } from './common.mjs';
export function serverArgs(sha, database, measurementPoolSize = null) {
  const args = [path.join(ROOT, 'server/run_server.py'),
    path.join(ROOT, '.baselines', sha, 'backend'), '18000', '--database-url',
    `postgresql://vibe@127.0.0.1:55432/${database}`];
  if (measurementPoolSize !== null) {
    if (!Number.isInteger(measurementPoolSize) || measurementPoolSize < 1 || measurementPoolSize > 300) {
      throw new Error('measurementPoolSize must be an integer in [1, 300]');
    }
    args.push('--measurement-pool-size', String(measurementPoolSize));
  }
  return args;
}
export async function startServer(sha, database, measurementPoolSize = null) {
  // Refuse to attach to another process already occupying the measurement port.
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(18000, '127.0.0.1', resolve); });
  await new Promise(resolve => probe.close(resolve));
  await mkdir(path.join(ROOT, '.logs'), { recursive: true });
  const log = await open(path.join(ROOT, '.logs', `launcher-${database}-${Date.now()}.log`), 'a');
  const child = spawn(path.join(ROOT, '.venv/bin/python'), serverArgs(sha, database, measurementPoolSize),
    { cwd: ROOT, stdio: ['ignore', log.fd, log.fd] });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  let spawnError;
  child.on('error', error => { spawnError = error; });
  const handle = {
    child, exited, listenAt: null, logPath: path.join(ROOT, '.logs', `server-${database}-${child.pid}.log`),
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      // Always confirm process exit before restart or DB removal.
      await deadline(exited, 10000, 'server SIGTERM exit');
    },
  };
  try {
    await until(async () => {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Server exited: ${child.exitCode}; see .logs`);
      try {
        const response = await fetch(API + '/', { signal: AbortSignal.timeout(500) });
        if (response.status === 200) {
          const content = await readFile(handle.logPath, 'utf8');
          const match = /STAGE1_LISTEN_MS=(\d+)/.exec(content);
          if (match) { handle.listenAt = Number(match[1]); return true; }
        }
      } catch {}
      return false;
    }, 30000, 'server GET / 200');
    return handle;
  } catch (error) { await handle.stop(); throw error; }
  finally { await log.close(); }
}
