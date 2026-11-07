// 실행: node loadtest/deploy/late_join_deployed.mjs --front-commit <sha> --server-commit <sha> [--runs 5]
// 주의: 실제 배포 서버에 접속하며, 입장마다 Gemini 호출이 발생할 수 있다.
// 부하용 봇 없이 호스트·게스트 브라우저만 사용한다. SHA는 배포 검증 없이 결과에 기록만 한다.
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, sleep } from '../lib/common.mjs';
import { YOUTUBE_VIDEO } from '../lib/youtube.mjs';
import { markdown, summarizeYouTube } from '../summarize_youtube.mjs';

export const FRONT = 'https://vibe-syncer.eelkom.com';
const API = 'https://vibe-syncer.onrender.com';
export const extraHosts = ['vibe-syncer.eelkom.com', 'vibe-syncer.onrender.com'];

export function parseArgs(args) {
  const opts = { runs: 5, frontCommit: null, serverCommit: null };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!['--runs', '--front-commit', '--server-commit'].includes(key)) throw new Error(`Unknown argument: ${key}`);
    const value = args[++i];
    if (key === '--runs') {
      if (!/^\d+$/.test(value ?? '') || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
        throw new Error('--runs must be a positive integer');
      }
      opts.runs = Number(value);
    } else {
      if (!/^[0-9a-f]{7,40}$/.test(value ?? '')) throw new Error(`${key} needs a 7–40 character lowercase hexadecimal SHA`);
      opts[key === '--front-commit' ? 'frontCommit' : 'serverCommit'] = value;
    }
  }
  if (!opts.frontCommit || !opts.serverCommit) throw new Error('--front-commit and --server-commit are required');
  return opts;
}

export function resultPath(frontCommit, runNumber) {
  return path.join(ROOT, 'results/deploy/late_join', frontCommit, `run-${runNumber}.json`);
}

async function request(route, { method = 'GET', body, token, timeout = 30000, allow404 = false } = {}) {
  const response = await fetch(`${API}${route}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  // Consume the body within the same timeout, including unsuccessful responses.
  const text = await response.text();
  if (!(allow404 && response.status === 404) && !response.ok) {
    throw new Error(`${method} ${route}: HTTP ${response.status}: ${text}`);
  }
  return { status: response.status, text };
}

export async function wake(result) {
  const start = performance.now(), deadline = start + 120000;
  let lastError;
  try {
    while (performance.now() < deadline) {
      try {
        const response = await request('/', { timeout: Math.max(1, Math.ceil(Math.min(30000, deadline - performance.now()))) });
        if (response.status === 200) return;
        lastError = new Error(`GET /: HTTP ${response.status}`);
      } catch (error) { lastError = error; }
      const remaining = deadline - performance.now();
      if (remaining > 0) await sleep(Math.min(2000, remaining));
    }
    throw new Error(`Preparation failed: API did not return 200 within 120s; ${lastError?.message ?? 'no response'}`);
  } finally { result.wake_ms = performance.now() - start; }
}

export async function warm(result) {
  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    const response = await request('/');
    if (response.status !== 200) throw new Error(`Preparation failed: warm GET /: HTTP ${response.status}`);
    result.warm_ms.push(performance.now() - start);
  }
}

export async function createRoom(result) {
  const room = JSON.parse((await request('/rooms/', { method: 'POST',
    body: { name: `loadtest-${Date.now()}`, host_nickname: 'loadtest-host' } })).text);
  result.room_code = room.room_code;
  const host = { userId: room.host_id, nickname: 'loadtest-host', isHost: true, token: room.token };
  return { room, host };
}

export async function addSong(room, host) {
  await request(`/rooms/${room.room_code}/queue`, { method: 'POST', token: host.token,
    body: { music_url: YOUTUBE_VIDEO.url, title: 'Big Buck Bunny', artist: 'Blender' } });
}

export async function deleteRoom(result, room, host) {
  if (room && host) {
    try {
      const response = await request(`/rooms/${room.room_code}`, { method: 'DELETE', token: host.token, allow404: true });
      result.room_deleted = response.status === 404 ? 'already' : true;
    } catch (error) {
      result.room_deleted = false;
      result.room_delete_error = error.message ?? String(error);
      result.errors.push(`room cleanup (${room.room_code}): ${result.room_delete_error}`);
      result.ok = false;
      console.error(`Room ${room.room_code} deletion failed: ${result.room_delete_error}`);
    }
  }
}

async function measure(opts, runNumber, target) {
  const result = {
    scenario: 'late_join_deployed', commit: opts.frontCommit, commit_full: opts.frontCommit,
    front_commit: opts.frontCommit, server_commit: opts.serverCommit, condition: 'youtube', run: runNumber,
    started_at: new Date().toISOString(), measurement_pool_size: null, server_forced_kills: 0,
    environment: null, smoke: false, metrics: { video: YOUTUBE_VIDEO },
    blocked_external_requests: 0, errors: [], ok: false,
    wake_ms: null, warm_ms: [], vibebot_frames: 0, room_deleted: null,
  };
  const cleanup = [];
  let room, host;
  console.log(`RUN late_join_deployed ${opts.frontCommit} #${runNumber}`);
  try {
    await wake(result);
    await warm(result);
    ({ room, host } = await createRoom(result));
    const joined = JSON.parse((await request('/rooms/join', { method: 'POST',
      body: { room_code: room.room_code, nickname: 'loadtest-guest' } })).text);
    const guest = { userId: joined.user_id, nickname: 'loadtest-guest', isHost: false, token: joined.token };
    await addSong(room, host);
    const { run } = await import('../scenarios/late_join_youtube.mjs');
    result.metrics = await run({ cleanup, result, seed: { room, host, guest }, smoke: false, front: FRONT, extraHosts });
    result.ok = true;
  } catch (error) {
    result.errors.push(error.stack ?? String(error));
  } finally {
    // Reverse order captures partial observations, stops scripted input, and
    // closes both contexts and browsers before sending the room DELETE.
    for (const fn of cleanup.reverse()) {
      try { await fn(); }
      catch (error) { result.errors.push(`cleanup: ${error.stack ?? error}`); result.ok = false; }
    }
    const guestFrames = result.browser_artifacts?.find(artifact => artifact.role === 'loadtest-guest')?.frames
      ?? result.metrics.raw?.guest_frames ?? [];
    result.vibebot_frames = guestFrames.filter(frame => frame.data?.type === 'chat' && frame.data.user_id === 0).length;
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
  const lock = path.join(ROOT, '.logs/late_join_deployed.lock');
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
    console.log(markdown(summarizeYouTube(results)));
  } finally { await unlink(lock); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
