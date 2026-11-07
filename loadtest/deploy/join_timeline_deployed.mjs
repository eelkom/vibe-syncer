// SHA labels describe the deployment; this script does not verify deployments.
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, sleep } from '../lib/common.mjs';
import { YOUTUBE_VIDEO } from '../lib/youtube.mjs';
import { syncMarkdown, summarizeSync } from '../summarize_sync.mjs';
import { FRONT, extraHosts, parseArgs, wake, warm, createRoom, addSong, deleteRoom } from './late_join_deployed.mjs';
export { parseArgs };

export function resultPath(frontCommit, runNumber) {
  return path.join(ROOT, 'results/deploy/join_timeline', frontCommit, `run-${runNumber}.json`);
}

async function measure(opts, runNumber, target) {
  const result = {
    suite: 'deploy', scenario: 'join_timeline_deployed', condition: 'youtube', run: runNumber,
    commit: opts.frontCommit, commit_full: opts.frontCommit,
    front_commit: opts.frontCommit, server_commit: opts.serverCommit,
    started_at: new Date().toISOString(), environment: null, smoke: false,
    measurement_pool_size: null, server_forced_kills: 0, metrics: { video: YOUTUBE_VIDEO },
    blocked_external_requests: 0, errors: [], ok: false,
    wake_ms: null, warm_ms: [], vibebot_frames: 0, room_deleted: null,
  };
  const cleanup = [];
  let room, host;
  console.log(`RUN join_timeline_deployed ${opts.frontCommit} #${runNumber}`);
  try {
    await wake(result);
    await warm(result);
    ({ room, host } = await createRoom(result));
    await addSong(room, host);
    // The guest is created only by the real landing modal submission.
    const guest = { nickname: 'loadtest-guest' };
    const { run } = await import('../scenarios/join_timeline.mjs');
    result.metrics = await run({ cleanup, result, seed: { room, host, guest },
      condition: 'youtube', smoke: false, front: FRONT, extraHosts });
    result.ok = true;
  } catch (error) { result.errors.push(error.stack ?? String(error)); }
  finally {
    for (const fn of cleanup.reverse()) {
      try { await fn(); }
      catch (error) { result.errors.push(`cleanup: ${error.stack ?? error}`); result.ok = false; }
    }
    const frames = result.metrics.raw?.guest_frames ?? [];
    result.vibebot_frames = frames.filter(f => f.data?.type === 'chat' && f.data.user_id === 0).length;
    await deleteRoom(result, room, host);
    if (result.ok) delete result.browser_artifacts;
    result.finished_at = new Date().toISOString();
    await writeFile(target, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    console.log(`${result.ok ? 'OK' : 'FAILED'} ${path.relative(ROOT, target)}`);
  }
  return result;
}

export async function main(args = process.argv.slice(2)) {
  const opts = parseArgs(args);
  const lock = path.join(ROOT, '.logs/join_timeline_deployed.lock');
  await mkdir(path.dirname(lock), { recursive: true });
  await writeFile(lock, `${process.pid}\n`, { flag: 'wx' });
  const results = [];
  let measured = false;
  try {
    for (let runNumber = 1; runNumber <= opts.runs; runNumber++) {
      const target = resultPath(opts.frontCommit, runNumber);
      let exists = false;
      try { await stat(target); exists = true; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (exists) {
        console.log(`SKIP ${path.relative(ROOT, target)}`);
        results.push(JSON.parse(await readFile(target, 'utf8')));
        continue;
      }
      await mkdir(path.dirname(target), { recursive: true });
      if (measured) await sleep(10000);
      const result = await measure(opts, runNumber, target);
      results.push(result);
      measured = true;
      if (!result.ok) { process.exitCode = 1; break; }
    }
    console.log(syncMarkdown(summarizeSync(results)));
  } finally { await unlink(lock); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
