import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './lib/common.mjs';
import { readSleepLog, sleepStatus } from './stage2/sleep.mjs';
import { sampleGapMetrics, verdict } from './stage2/stats.mjs';
export const isRunFile = name => /^run-\d+\.json$/.test(name);
export function recomputeStall(run, log) {
  const updated = { ...run, metrics: { ...run.metrics, ...sampleGapMetrics(run), ...sleepStatus(run.started_at, run.finished_at, log) } };
  updated.verdict = verdict(updated);
  return updated;
}
async function main() {
  // Read successfully before any writes. If pmset is unavailable, no files change.
  const log = readSleepLog(), root = path.join(ROOT, 'results/stage2');
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && isRunFile(entry.name)) {
        const updated = recomputeStall(JSON.parse(await readFile(target, 'utf8')), log);
        await writeFile(target, JSON.stringify(updated) + '\n');
        console.log(`${updated.metrics.machine_stall_unknown ? 'UNKNOWN' : 'UPDATED'} ${path.relative(ROOT, target)}`);
      }
    }
  }
  await visit(root);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
