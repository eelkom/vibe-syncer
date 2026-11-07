import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './common.mjs';
import { validateArchive } from './commit.mjs';
import { createDatabase, dropDatabase, seed } from './database.mjs';
import { startServer } from './server.mjs';
import { staticServer, tone } from './static-server.mjs';

export function e2eOptions(args) {
  let commit;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--commit' && commit === undefined) commit = args[++i];
    else throw new Error(`Unknown or incomplete option: ${args[i]}`);
  }
  if (!commit) throw new Error('--commit <sha> is required');
  return { commit };
}
// Append a new round automatically. Never overwrite an existing raw result.
// A FAIL verdict is a completed measurement, so only execution errors exit 2.
export async function runE2E(name, measure, { browser = true } = {}) {
  const { commit } = e2eOptions(process.argv.slice(2));
  const archive = await validateArchive(commit, { frontend: browser });
  const lock = path.join(ROOT, '.logs/stage1.lock');
  await mkdir(path.dirname(lock), { recursive: true });
  await writeFile(lock, `${process.pid}\n`, { flag: 'wx' });
  try {
    const root = path.join(ROOT, 'results/e2e', name, archive.sha);
    await mkdir(root, { recursive: true });
    const rounds = (await readdir(root)).map(file => /^run-(\d+)\.json$/.exec(file)).filter(Boolean).map(m => Number(m[1]));
    const run = Math.max(0, ...rounds) + 1;
    const target = path.join(root, `run-${run}.json`);
    const result = { scenario: name, condition: 'default', commit: archive.sha, commit_full: archive.full, run,
      started_at: new Date().toISOString(), ok: false, passed: false,
      metrics: {}, blocked_external_requests: 0, errors: [] };
    const database = `loadtest_e2e_${name}_${archive.sha}_${run}`;
    const cleanup = [];
    let created = false, server;
    try {
      await createDatabase(database); created = true;
      server = await startServer(archive.sha, database);
      result.server_logs = [path.relative(ROOT, server.logPath)];
      const data = await seed(database, { queue: browser });
      if (browser) {
        const media = await staticServer(await tone(), 15174);
        cleanup.push(() => media.close());
        const front = await staticServer(path.join(ROOT, '.baselines', archive.sha, 'frontend/dist'), 15173, true);
        cleanup.push(() => front.close());
      }
      result.metrics = await measure({ sha: archive.sha, seed: data, cleanup, result });
      result.passed = result.metrics.passed === true;
      result.ok = true;
    } catch (error) { result.errors.push(error.stack ?? String(error)); }
    finally {
      const failed = error => { result.ok = false; result.passed = false; result.errors.push(error.stack ?? String(error)); };
      for (const fn of cleanup.reverse()) { try { await fn(); } catch (error) { failed(error); } }
      try { if (server) result.server_forced_kills = (await server.stop()).forced ? 1 : 0; } catch (error) { failed(error); }
      try { if (created) await dropDatabase(database); } catch (error) { failed(error); }
      if (result.ok) delete result.browser_artifacts;
      result.finished_at = new Date().toISOString();
      await writeFile(target, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    }
    console.log(`${result.ok && result.passed ? 'PASS' : 'FAIL'} ${path.relative(ROOT, target)}${result.ok ? '' : ' (execution error)'}`);
    console.log(JSON.stringify(result.metrics, (key, value) => key === 'raw' ? undefined : value, 2));
    return result.ok ? 0 : 2;
  } finally { await unlink(lock); }
}
export async function e2eMain(name, measure, options) {
  try { process.exitCode = await runE2E(name, measure, options); }
  catch (error) { console.error(`FAIL execution error: ${error.stack ?? error}`); process.exitCode = 2; }
}
