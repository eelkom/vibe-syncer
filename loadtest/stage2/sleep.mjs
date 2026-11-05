import { execFileSync } from 'node:child_process';
export function parseSleepLog(text) {
  let firstAt = null;
  const sleeps = new Set();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?)\s+([+-]\d{4})\s+(.*)$/);
    if (!match) continue;
    const t = Date.parse(`${match[1].replace(' ', 'T')}${match[2].slice(0,3)}:${match[2].slice(3)}`);
    if (!Number.isFinite(t)) continue;
    firstAt ??= t;
    if (/^Sleep(?:\s|$)/.test(match[3])) sleeps.add(t);
  }
  return { first_at: firstAt, sleep_events: [...sleeps].sort((a,b) => a-b) };
}
export function readSleepLog(exec = execFileSync) {
  return parseSleepLog(exec('pmset', ['-g', 'log'], { encoding: 'utf8', timeout: 15000, maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'] }));
}
export function sleepStatus(startedAt, finishedAt, log) {
  const start = Date.parse(startedAt), end = Date.parse(finishedAt);
  const valid = Number.isFinite(start) && Number.isFinite(end) && end >= start;
  const events = valid ? (log?.sleep_events ?? []).filter(t => t >= start && t <= end) : [];
  return { machine_stalled: events.length > 0, machine_sleep_events: events.map(t => new Date(t).toISOString()),
    machine_stall_unknown: !valid || log?.first_at == null || log.first_at > start };
}
