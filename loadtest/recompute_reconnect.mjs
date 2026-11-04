import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './lib/common.mjs';
import { reconnectRollingPeaks } from './lib/stats.mjs';

export const isBotCondition = name => /-(14|200-pool)$/.test(name);
export function addRollingMetrics(run) {
  const raw = run.metrics?.raw;
  return { ...run, metrics: { ...run.metrics,
    ...reconnectRollingPeaks(raw?.bots, raw?.outage_at, raw?.listen_at) } };
}
async function main() {
  const root = path.join(ROOT, 'results/stage1/reconnect');
  for (const commit of await readdir(root, { withFileTypes: true })) {
    if (!commit.isDirectory()) continue;
    const commitDir = path.join(root, commit.name);
    for (const condition of await readdir(commitDir, { withFileTypes: true })) {
      if (!condition.isDirectory() || !isBotCondition(condition.name)) continue;
      const dir = path.join(commitDir, condition.name);
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !/^run-.*\.json$/.test(entry.name)) continue;
        const target = path.join(dir, entry.name);
        try {
          const run = JSON.parse(await readFile(target, 'utf8'));
          const updated = addRollingMetrics(run);
          await writeFile(target, JSON.stringify(updated, null, 2) + '\n');
          console.log(`UPDATED ${path.relative(ROOT, target)}`);
        } catch (error) { throw new Error(`Cannot recompute ${target}: ${error.message}`); }
      }
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
