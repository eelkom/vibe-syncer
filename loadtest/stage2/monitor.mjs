import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { parseServerJSONL } from './stats.mjs';
const exec = promisify(execFile);
export function serverSummary(server, start, end, forcedKills) {
  // JSONL timestamps mark the end of each aggregate bucket. Include buckets
  // and ps samples stamped inside observation; keep per-run log/kill counts.
  const inside = t => Number.isFinite(start) && Number.isFinite(end) && t >= start && t <= end;
  const rows = (server?.instrument ?? []).filter(r => inside(r.t));
  const samples = (server?.samples ?? []).filter(r => inside(r[0]));
  const broadcastSums = rows.map(r => r.broadcast?.sum_ms).filter(Number.isFinite);
  const max = values => { const finite = values.filter(Number.isFinite); return finite.length ? Math.max(...finite) : null; };
  return { event_loop_max_ms: max(rows.map(r => r.event_loop?.max_ms)),
    event_loop_p95_ms_approx_max: max(rows.map(r => r.event_loop?.p95_ms_approx)),
    broadcast_p95_ms_approx_max: max(rows.map(r => r.broadcast?.p95_ms_approx)),
    broadcast_sum_ms: broadcastSums.length ? broadcastSums.reduce((sum, ms) => sum + ms, 0) : null,
    connections_max: max(rows.map(r => r.connections_max)), pool_checked_out_max: max(rows.map(r => r.pool?.checked_out)),
    cpu_peak: max(samples.map(r => r[1])), rss_peak_bytes: max(samples.map(r => r[2])),
    queuepool_errors: server?.queuepool_errors ?? null, server_forced_kills: forcedKills };
}
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
