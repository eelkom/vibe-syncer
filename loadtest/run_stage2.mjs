import path from 'node:path';
import { mkdir, readFile, stat, writeFile, copyFile, unlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { ROOT, REPO, deadline } from './lib/common.mjs';
import { createDatabase, dropDatabase } from './lib/database.mjs';
import { startServer } from './lib/server.mjs';
import { environment } from './lib/environment.mjs';
import { staticServer, tone } from './lib/static-server.mjs';
import { readyHost } from './lib/browser.mjs';
import { SHA, options, plan, skipAfterFailures, shouldRun } from './stage2/config.mjs';
import { seedStage2 } from './stage2/seed.mjs';
import { launchStage2, makePage, navigate, readyGuest, readPage } from './stage2/browser.mjs';
import { startBots } from './stage2/bots.mjs';
import { monitorServer, serverSummary } from './stage2/monitor.mjs';
import { runScenario } from './stage2/scenarios.mjs';
import { metrics, boundedJSON, consoleObservations } from './stage2/metrics.mjs';
import { verdict, sampleGapMetrics, shouldStopBatch } from './stage2/stats.mjs';
import { capturePower, warnBattery } from './stage2/power.mjs';
import { readSleepLog, sleepStatus } from './stage2/sleep.mjs';
import { closeOwnedBrowser } from './stage2/browser-process.mjs';
const opts = options(process.argv.slice(2)), jobs = plan(opts);
const root = path.join(ROOT, opts.smoke ? 'results/smoke/stage2' : 'results/stage2');
await mkdir(root, { recursive: true }); await mkdir(path.join(ROOT, '.logs'), { recursive: true });
const lock = path.join(ROOT, '.logs/stage2.lock');
await writeFile(lock, `${process.pid}\n`, { flag: 'wx' });
const previous = [], stamp = new Date().toISOString().replaceAll(':', '-');
let env, envPath;
try {
  const power = {}; warnBattery(capturePower(power, 'start'));
  const full = execFileSync('git', ['rev-parse', SHA], { cwd: REPO, encoding: 'utf8' }).trim();
  if ((await readFile(path.join(ROOT, '.baselines', SHA, '.archive-sha'), 'utf8')).trim() !== full) throw new Error('Prepare archived b86324b first');
  for (const profiling of new Set(jobs.map(j => j.profiling))) await stat(path.join(ROOT, '.baselines', SHA, 'frontend', profiling ? 'dist-profiling/index.html' : 'dist/index.html'));
  env = await environment(process.argv.slice(2)); env.stage = 2; env.commit = full; Object.assign(env, power);
  envPath = path.join(root, `env-${stamp}.json`); await writeFile(envPath, JSON.stringify(env, null, 2) + '\n');
  for (const job of jobs) {
    const target = path.join(root, job.scenario, SHA, job.condition, `n-${job.n}`, `run-${job.run}.json`);
    let existingText;
    try { existingText = await readFile(target, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    // --force preserves even incomplete JSON as before; only selection by
    // validity and the default skip path need to parse an existing round.
    const existing = existingText === undefined || opts.force ? undefined : JSON.parse(existingText);
    if (!shouldRun(existing, opts)) {
      if (existing) previous.push(existing);
      console.log(`SKIP ${existing ? 'existing' : 'no invalid round'} ${path.relative(ROOT, target)}`); continue;
    }
    await mkdir(path.dirname(target), { recursive: true });
    if (existingText !== undefined) await copyFile(target, target.replace('.json', `.previous-${stamp}.json`));
    const result = { stage: 2, scenario: job.scenario, commit: SHA, commit_full: full, condition: job.condition, n: job.n, run: job.run,
      smoke: opts.smoke, profiling: job.profiling, cpu_throttle: job.cpu, measurement_pool_size: job.pool,
      environment: path.relative(ROOT, envPath), started_at: new Date().toISOString(), phase: 'init', ok: false, skipped: false,
      setup_failed: false, connected_at_setup: 0, blocked_external_requests: 0, server_forced_kills: 0, browser_forced_kills: 0, errors: [], metrics: {} };
    capturePower(result, 'start');
    if (skipAfterFailures(job, previous, 3)) {
      result.skipped = true; result.ok = true; result.skip_reason = 'SMALLER_N_SETUP_FAILED_ALL_3'; result.verdict = verdict(result);
      capturePower(result, 'end');
      result.finished_at = new Date().toISOString(); await writeFile(target, boundedJSON(result), { flag: existingText !== undefined ? 'w' : 'wx' }); previous.push(result); continue;
    }
    const database = `loadtest_s2_${job.scenario}_${job.n}_${job.run}`;
    const instrument = path.join(ROOT, '.logs', `stage2-${job.scenario}-${job.condition}-${job.n}-${job.run}-${stamp}.jsonl`);
    const cleanup = [], browsers = []; let created = false, server, monitor, bots, ctx, hostData, guestData, joinData, botData;
    console.log(`RUN ${job.scenario} ${job.condition} N=${job.n} #${job.run}`);
    try {
      result.phase = 'database'; await createDatabase(database); created = true;
      result.phase = 'server'; server = await startServer(SHA, database, job.pool, instrument); monitor = monitorServer(server, instrument);
      result.server_log = path.relative(ROOT, server.logPath); result.instrument_log = path.relative(ROOT, instrument);
      const seed = await seedStage2(database);
      const media = await staticServer(await tone(), 15174); cleanup.push(() => media.close());
      const front = await staticServer(path.join(ROOT, '.baselines', SHA, 'frontend', job.profiling ? 'dist-profiling' : 'dist'), 15173, true); cleanup.push(() => front.close());
      ctx = { job, smoke: opts.smoke, cleanup, result, seed, inputs: [], actions: [], checkpointInputs: [] };
      result.phase = 'browsers';
      const hb = await launchStage2(browsers), gb = await launchStage2(browsers, true);
      env.chromium_version = gb.version(); await writeFile(envPath, JSON.stringify(env, null, 2) + '\n');
      const host = ctx.host = await makePage(hb, seed.host, result, cleanup, job.profiling);
      await navigate(host, seed.room);
      const guest = ctx.guest = await makePage(gb, seed.guest, result, cleanup, job.profiling,
        job.scenario === 'chat_accumulation' ? (opts.smoke ? [100, 500] : [1000, 2000, 5000, 10000]) : []);
      await readyGuest(guest, seed.room, cleanup, result);
      await readyHost(host, seed.room, true);
      if (job.cpu === 4) {
        const cdp = await guest.page.context().newCDPSession(guest.page);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 }); // Session is disposed with its owned browser.
      }
      let joiner;
      if (job.scenario === 'join_burst') joiner = await makePage(await launchStage2(browsers), null, result, cleanup);
      bots = await startBots();
      Object.assign(ctx, { joiner, bots });
      result.phase = 'observation'; await runScenario(ctx);
      // First observer evaluation is after runScenario has finished observing.
      result.phase = 'read';
      hostData = await readPage(host); guestData = await readPage(guest); if (joiner) joinData = await readPage(joiner);
      result.page_read_issues = [['host', host], ['guest', guest], ['entrant', joiner]].filter(([, state]) => state?.unresponsive)
        .map(([page]) => ({ page, reason: 'FINAL_EVALUATION_DID_NOT_RESPOND', timeout_ms: 15000 }));
      if (guestData && !guestData.vitals_ready) throw new Error('web-vitals IIFE/onINP was not initialized');
      botData = await bots.snapshot();
      result.metrics = metrics(ctx, hostData, guestData, botData, joinData);
      result.ok = true;
    } catch (error) {
      result.errors.push(error.stack ?? String(error));
      if (error.serverForced) result.server_forced_kills++;
      if (error.serverLog) {
        result.server_log = path.relative(ROOT, error.serverLog);
        try { result.failure = { phase: result.phase, server_log_tail: (await readFile(error.serverLog, 'utf8')).slice(-6000) }; } catch {}
      }
    }
    finally {
      if (bots) { try { botData = await bots.stop(); } catch (error) { result.errors.push(`bots stop: ${error.message}`); result.ok = false; await bots.kill(); } }
      // On script failure retain small diagnostics, never raw websocket frames.
      if (!result.ok && ctx) {
        result.failure = { phase: result.phase, bot_status: bots?.status, host_connected: ctx.host?.connected ?? null,
          guest_connected: ctx.guest?.connected ?? null, host_console: ctx.host?.consoleErrors.slice(0, 20) ?? [], guest_console: ctx.guest?.consoleErrors.slice(0, 20) ?? [] };
        // Read independently so a failed host capture cannot discard guest
        // samples (or vice versa), including gaps before observation started.
        try { if (ctx.host && !ctx.host.unresponsive) hostData ??= await readPage(ctx.host, 10000); } catch (error) { result.errors.push(`host failure samples: ${error.message}`); }
        try { if (ctx.guest && !ctx.guest.unresponsive) guestData ??= await readPage(ctx.guest, 10000); } catch (error) { result.errors.push(`guest failure samples: ${error.message}`); }
        result.metrics.raw ??= {};
        if (hostData) result.metrics.raw.host_samples = hostData.samples.map(s => [s.t,s.ct ?? null,s.paused,s.muted,s.volume]);
        if (guestData) result.metrics.raw.guest_samples = guestData.samples.map(s => [s.t,s.ct ?? null,s.paused,s.muted,s.volume]);
      }
      result.metrics.console_observations ??= consoleObservations(ctx);
      for (const close of cleanup.reverse()) try { await deadline(close(), 10000, 'stage2 resource cleanup'); } catch (error) { result.errors.push(`cleanup: ${error.message}`); result.ok = false; }
      result.browser_pids = browsers.map(owner => owner.pid);
      for (const owner of browsers.reverse()) {
        try { await closeOwnedBrowser(owner); }
        catch (error) { result.errors.push(`browser cleanup pid=${owner.pid}: ${error.message}`); result.ok = false; result.browser_cleanup_failed = true; }
        finally { if (owner.forced) result.browser_forced_kills++; }
      }
      if (server) try { if ((await server.stop()).forced) result.server_forced_kills++; } catch (error) { result.errors.push(`server stop: ${error.message}`); result.ok = false; }
      if (monitor) {
        await monitor.stop();
        try { result.server = await monitor.result(); } catch (error) { result.errors.push(`server metrics: ${error.message}`); result.ok = false; }
      }
      result.server_summary = serverSummary(result.server, ctx?.start, ctx?.end, result.server_forced_kills);
      if (created) try { await dropDatabase(database); } catch (error) { result.errors.push(`DB cleanup: ${error.message}`); result.ok = false; }
      delete result.browser_artifacts;
      Object.assign(result.metrics, sampleGapMetrics(result));
      capturePower(result, 'end');
      result.finished_at = new Date().toISOString();
      try { Object.assign(result.metrics, sleepStatus(result.started_at, result.finished_at, readSleepLog())); }
      catch (error) { Object.assign(result.metrics, sleepStatus(result.started_at, result.finished_at, null)); result.machine_stall_log_error = error.message; }
      result.verdict = verdict(result);
      boundedJSON(result); result.verdict = verdict(result);
      await writeFile(target, boundedJSON(result), { flag: existingText !== undefined ? 'w' : 'wx' });
      previous.push(result); console.log(`${result.verdict.status === 'INVALID' ? 'INVALID' : result.ok ? result.setup_failed ? 'SETUP_FAILED' : 'OK' : 'SCRIPT_FAILED'} ${path.relative(ROOT, target)}`);
    }
    // Never start another round after a browser exit/cleanup could not be
    // confirmed, even if OS Sleep also invalidated this round's measurements.
    if (result.browser_cleanup_failed || shouldStopBatch(result)) { process.exitCode = 1; break; }
  }
} finally {
  try { if (envPath) { capturePower(env, 'end'); await writeFile(envPath, JSON.stringify(env, null, 2) + '\n'); } }
  finally { await unlink(lock); }
}
