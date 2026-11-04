import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { parseServerJSONL } from './stats.mjs';
const exec = promisify(execFile);
export function monitorServer(server, instrument) {
  const samples = [], errors = []; let stopped = false;
  const sample = async () => {
    try {
      const { stdout } = await exec('ps', ['-o', '%cpu=,rss=', '-p', String(server.child.pid)], { env: { ...process.env, LC_ALL: 'C' } });
      const [cpu, rss] = stdout.trim().split(/\s+/).map(Number);
      if (Number.isFinite(cpu) && Number.isFinite(rss)) samples.push([Date.now(), cpu, rss * 1024]);
    } catch (error) { if (!stopped && errors.length < 10) errors.push(error.message); }
  };
  let pending = sample();
  const timer = setInterval(() => { pending = pending.then(sample); }, 1000);
  return { async stop() { stopped = true; clearInterval(timer); await pending; },
    async result() {
      let text = '', log = null;
      try { text = await readFile(instrument, 'utf8'); } catch (error) { errors.push(`instrument: ${error.message}`); }
      try { log = await readFile(server.logPath, 'utf8'); } catch (error) { errors.push(`server log: ${error.message}`); }
      return { samples, instrument: parseServerJSONL(text), queuepool_errors: log === null ? null : (log.match(/QueuePool/g) ?? []).length, errors,
        cpu_peak: samples.length ? Math.max(...samples.map(s => s[1])) : null,
        rss_peak_bytes: samples.length ? Math.max(...samples.map(s => s[2])) : null };
    } };
}
