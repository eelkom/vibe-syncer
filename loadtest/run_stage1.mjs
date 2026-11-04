import { mkdir, readFile, stat, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, REPO, sleep } from './lib/common.mjs';
import { parseArgs, plan } from './lib/config.mjs';
import { createDatabase, dropDatabase, seed } from './lib/database.mjs';
import { startServer } from './lib/server.mjs';
import { staticServer, tone } from './lib/static-server.mjs';
import { environment } from './lib/environment.mjs';

const opts = parseArgs(process.argv.slice(2));
const jobs = plan(opts);
const resultRoot = path.join(ROOT, 'results', opts.smoke ? 'smoke' : 'stage1');
const stamp = new Date().toISOString().replaceAll(':', '-');
await mkdir(resultRoot, { recursive: true });
// A single lock prevents fixed-port collisions and concurrent force overwrites.
const lock = path.join(ROOT, '.logs/stage1.lock');
await mkdir(path.dirname(lock), { recursive: true });
await writeFile(lock, `${process.pid}\n`, { flag: 'wx' });
let env;
const envPath = path.join(resultRoot, `env-${stamp}.json`);
try {
  for (const job of jobs) {
    // Bot policies use the same main server and do not require an old frontend.
    const botOnly = job.scenario === 'reconnect' && job.condition !== 'browser-10';
    for (const sha of new Set(botOnly ? [job.serverSha] : [job.sha, job.serverSha])) {
      try {
        const archive = await readFile(path.join(ROOT, '.baselines', sha, '.archive-sha'), 'utf8');
        const expected = execFileSync('git', ['rev-parse', sha], { cwd: REPO, encoding: 'utf8' }).trim();
        if (archive.trim() !== expected) throw new Error('Archive SHA mismatch');
        await stat(path.join(ROOT, '.baselines', sha, 'frontend/dist/index.html'));
      } catch (error) { throw new Error(`Run loadtest/scripts/prepare_commit.sh ${sha} first: ${error.message}`); }
    }
  }
  env = await environment(process.argv.slice(2));
  await writeFile(envPath, JSON.stringify(env, null, 2) + '\n');
  for (const job of jobs) {
    const { scenario, sha, serverSha, condition, runNumber } = job;
    const measurementPoolSize = job.measurementPoolSize ?? null;
    const target = path.join(resultRoot, scenario, sha, condition, `run-${runNumber}.json`);
    let exists = false;
    try { await stat(target); exists = true; } catch {}
    if (exists && !opts.force) { console.log(`SKIP ${path.relative(ROOT, target)}`); continue; }
    await mkdir(path.dirname(target), { recursive: true });
    if (exists) await copyFile(target, target.replace('.json', `.previous-${stamp}.json`));
    const result = { scenario, commit: sha, commit_full: execFileSync('git', ['rev-parse', sha], { cwd: REPO, encoding: 'utf8' }).trim(),
      server_commit: serverSha, condition, run: runNumber, started_at: new Date().toISOString(),
      measurement_pool_size: measurementPoolSize,
      environment: path.relative(ROOT, envPath), smoke: opts.smoke, metrics: {},
      blocked_external_requests: 0, errors: [], ok: false };
    const cleanup = [];
    const database = `loadtest_${scenario}_${sha}_${runNumber}`;
    let server, created = false;
    console.log(`RUN ${scenario} ${sha} ${condition} #${runNumber}`);
    try {
      await createDatabase(database); created = true;
      server = await startServer(serverSha, database, measurementPoolSize);
      result.server_logs = [path.relative(ROOT, server.logPath)];
      const data = await seed(database);
      const botOnly = scenario === 'reconnect' && condition !== 'browser-10';
      if (!botOnly) {
        const media = await staticServer(await tone(), 15174); cleanup.push(() => media.close());
        const front = await staticServer(path.join(ROOT, '.baselines', sha, 'frontend/dist'), 15173, true);
        cleanup.push(() => front.close());
      }
      const restart = async () => {
        if (server.child.exitCode !== null || server.child.signalCode !== null) throw new Error('Server exited before planned SIGTERM');
        await server.stop();
        const exitedAt = Date.now();
        result.server_restart = { exited_at: exitedAt, fixed_wait_ms: 3000 };
        await sleep(3000);
        server = await startServer(serverSha, database, measurementPoolSize);
        result.server_logs.push(path.relative(ROOT, server.logPath));
        result.server_restart.listen_at = server.listenAt;
        return server;
      };
      const mod = await import(`./scenarios/${scenario}.mjs`);
      result.metrics = await mod.run({ ...job, smoke: opts.smoke, cleanup, result, seed: data, restart });
      result.ok = true;
    } catch (error) {
      result.errors.push(error.stack ?? String(error));
      process.exitCode = 1;
    } finally {
      for (const fn of cleanup.reverse()) {
        try { await fn(); } catch (error) { result.errors.push(`cleanup: ${error.stack ?? error}`); result.ok = false; process.exitCode = 1; }
      }
      try { if (server) await server.stop(); }
      catch (error) { result.errors.push(`server stop: ${error.stack ?? error}`); result.ok = false; process.exitCode = 1; }
      try { if (created) await dropDatabase(database); }
      catch (error) { result.errors.push(`DB cleanup: ${error.stack ?? error}`); result.ok = false; process.exitCode = 1; }
      result.finished_at = new Date().toISOString();
      await writeFile(target, JSON.stringify(result, null, 2) + '\n', { flag: opts.force ? 'w' : 'wx' });
      console.log(`${result.ok ? 'OK' : 'FAILED'} ${path.relative(ROOT, target)}`);
    }
    // A failed run is preserved, and stops the batch for diagnosis; no retry.
    if (!result.ok) break;
  }
} finally {
  if (env) {
    const { browserVersions } = await import('./lib/browser.mjs');
    env.chromium_version = browserVersions.size ? [...browserVersions].join(', ') : null;
    await writeFile(envPath, JSON.stringify(env, null, 2) + '\n');
  }
  const { unlink } = await import('node:fs/promises');
  await unlink(lock);
}
