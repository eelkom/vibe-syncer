// 실행: node loadtest/deploy/host_stall_local_media.mjs --sha df1f9b6 --variants base,full [--runs 3]
// 호스트가 곡 중간에 실제로 버퍼링할 때 게스트가 되감기는지 잰다(#64).
// 서버는 실제 배포(Render), 프론트는 측정용 로컬 빌드(scripts/prepare_sync_grid.sh, 0.5초/5초),
// 곡은 YouTube 대신 로컬 미디어(.media/long.webm, 900초, ffmpeg 생성)를 127.0.0.1:15174에서 준다.
// 멈춤: 호스트 video의 재생 속도를 0으로 두어 재생 위치를 세우고, 플레이어 라이브러리가 버퍼링을
// 알리는 데 쓰는 waiting 이벤트를 보낸다. 정해진 시간 뒤 속도를 1로 돌리고 play, playing을 보낸다.
// play를 playing보다 먼저 보내는 것은 YouTube에서 react-player가 버퍼링 끝을 onPlay, onBufferEnd
// 순서로 알리는 것을 따른 것이다(players/YouTube.js의 PLAYING 처리).
// 네트워크 지연을 만든 것이 아니라 앱이 버퍼링으로 받는 신호와 멈춘 재생 위치를 재현한 것이다.
// (전송 속도를 묶는 방식은 Chrome이 메타데이터를 읽지 못해 재생이 시작되지 않았다.)
// 회차: 호스트 30초 재생 → 게스트 입장(T0) → T0+25s 3초 멈춤 → T0+45s 6초 멈춤 → T0+70s 종료.
// 입장마다 환영 메시지(Gemini)가 한 번씩 돈다. 방은 회차마다 삭제한다.
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, sleep, until } from '../lib/common.mjs';
import { launch, tab, enter, readyHost } from '../lib/browser.mjs';
import { staticServer, syncMedia } from '../lib/static-server.mjs';
import { interpolate, median, percentile } from '../lib/stats.mjs';
import { wake, warm, createRoom, deleteRoom, extraHosts } from './late_join_deployed.mjs';

const API = 'https://vibe-syncer.onrender.com';
const LOCAL_FRONT = 'http://127.0.0.1:15173';
const MEDIA_PORT = 15174;
// The server accepts only YouTube, SoundCloud or Spotify addresses and checks
// for the name in the URL (utils.detect_platform); the query only passes that
// check. The player still plays it as a plain file (.webm).
const MEDIA_URL = `http://127.0.0.1:${MEDIA_PORT}/long.webm?via=soundcloud.com`;
const MEDIA_SECONDS = 900;
const STALLS = [{ name: 'a', at: 25000, seconds: 3 }, { name: 'b', at: 45000, seconds: 6 }];
const END = 70000;

function parseArgs(args) {
  const opts = { runs: 3, sha: null, variants: [] };
  for (let i = 0; i < args.length; i++) {
    const key = args[i], value = args[++i];
    if (key === '--runs') opts.runs = Number(value);
    else if (key === '--sha') opts.sha = value;
    else if (key === '--variants') opts.variants = value.split(',');
    else throw new Error(`Unknown argument: ${key}`);
  }
  if (!/^[0-9a-f]{7}$/.test(opts.sha ?? '') || !opts.variants.length) throw new Error('--sha <7hex> --variants base,full required');
  return opts;
}

// Plain media server with range support (the static server serves only the build)
async function mediaServer(file) {
  const server = await staticServer(path.dirname(file), MEDIA_PORT);
  return { close: () => server.close() };
}

// Freezes the host's playback position and reports buffering to the app the way
// the player library does (waiting / playing on the media element).
async function stallHost(page, seconds) {
  const started = await page.evaluate(() => {
    const v = document.querySelector('video,audio');
    v.playbackRate = 0;
    v.dispatchEvent(new Event('waiting'));
    return { at: Date.now(), position: v.currentTime, rate: v.playbackRate };
  });
  await sleep(seconds * 1000);
  const ended = await page.evaluate(() => {
    const v = document.querySelector('video,audio');
    v.playbackRate = 1;
    v.dispatchEvent(new Event('play'));
    v.dispatchEvent(new Event('playing'));
    return { at: Date.now(), position: v.currentTime };
  });
  return { started, ended };
}

const playing = s => s && !s.none && !s.paused && Number.isFinite(s.ct);
const mediaSamples = state => state.probeSamples.filter(s => s.src?.startsWith(MEDIA_URL.split('?')[0]) || s.none);

// Position jumps between consecutive samples (beyond normal playback)
function jumps(samples, from, to) {
  const out = { back: 0, forward: 0, list: [] };
  const sel = samples.filter(s => s.t >= from && s.t < to && playing(s));
  for (let i = 1; i < sel.length; i++) {
    if (sel[i].t - sel[i - 1].t > 1000) continue;
    const d = (sel[i].ct - sel[i - 1].ct) - (sel[i].t - sel[i - 1].t) / 1000;
    if (d <= -0.3) { out.back++; out.list.push([sel[i].t - from, +d.toFixed(2)]); }
    else if (d >= 0.3) { out.forward++; out.list.push([sel[i].t - from, +d.toFixed(2)]); }
  }
  return out;
}

// Longest run of samples where the host did not advance while not paused
function stallSpan(samples, from, to) {
  let best = null, start = null;
  const sel = samples.filter(s => s.t >= from && s.t < to && playing(s));
  for (let i = 1; i < sel.length; i++) {
    if (sel[i].ct - sel[i - 1].ct < 0.02) { start ??= sel[i - 1].t; const len = sel[i].t - start; if (!best || len > best.ms) best = { from_ms: start - from, ms: len }; }
    else start = null;
  }
  return best;
}

async function runOnce(opts, variant, runNumber, target, media) {
  const result = { scenario: 'host_stall_local_media', sha: opts.sha, variant, run: runNumber, started_at: new Date().toISOString(),
    api: API, media: { url: MEDIA_URL, seconds: MEDIA_SECONDS }, stall_method: 'playbackRate 0 + waiting, then play and playing events',
    stalls: STALLS, errors: [], ok: false, warm_ms: [], metrics: {} };
  const cleanup = [];
  let room, host, front, hostTab;
  console.log(`RUN ${variant} #${runNumber}`);
  try {
    const dir = path.join(ROOT, `.baselines/sync-grid-${opts.sha}-dist`, variant === 'base' ? 't0.5-i5000' : `${variant}-t0.5-i5000`);
    result.build = JSON.parse(await readFile(path.join(dir, 'sync-grid.json'), 'utf8'));
    front = await staticServer(dir, 15173, true);
    await wake(result); await warm(result);
    ({ room, host } = await createRoom(result));
    const add = await fetch(`${API}/rooms/${room.room_code}/queue`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
      body: JSON.stringify({ music_url: MEDIA_URL, title: 'tone', artist: 'loadtest' }), signal: AbortSignal.timeout(30000) });
    if (!add.ok) throw new Error(`queue HTTP ${add.status}`);
    const joinRes = await fetch(`${API}/rooms/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room_code: room.room_code, nickname: 'loadtest-guest' }), signal: AbortSignal.timeout(30000) });
    if (!joinRes.ok) throw new Error(`join HTTP ${joinRes.status}`);
    const joined = await joinRes.json();
    const guestUser = { userId: joined.user_id, nickname: 'loadtest-guest', isHost: false, token: joined.token };
    const hb = await launch(cleanup, false, { allowHosts: extraHosts }), gb = await launch(cleanup, false, { allowHosts: extraHosts });
    const h = hostTab = await tab(hb, host, result, cleanup, 'muted-allowed', false, { syncProbe: true });
    // Only the host's media requests are throttled
    await enter(h, room, LOCAL_FRONT);
    await readyHost(h, room, true);
    await sleep(30000);
    const g = await tab(gb, guestUser, result, cleanup, 'muted-allowed', false, { syncProbe: true });
    await enter(g, room, LOCAL_FRONT);
    const t0 = g.t0;
    const stalls = [];
    for (const s of STALLS) {
      await sleep(Math.max(0, t0 + s.at - Date.now()));
      const { started, ended } = await stallHost(h.page, s.seconds);
      stalls.push({ name: s.name, seconds: s.seconds, from_ms: started.at - t0, to_ms: ended.at - t0,
        position: started.position, position_after: ended.position, rate_set: started.rate });
    }
    await sleep(Math.max(0, t0 + END - Date.now()));
    const end = t0 + END;
    const hs = mediaSamples(h).filter(s => s.t <= end), gs = mediaSamples(g).filter(s => s.t <= end);
    const errors = gs.map(s => { const x = playing(s) ? interpolate(hs.filter(playing), s.t) : null; return { t: s.t, signed: x === null ? null : (x - s.ct) * 1000 }; });
    const window = (a, b) => { const v = errors.filter(e => e.t >= t0 + a && e.t < t0 + b && e.signed !== null).map(e => Math.abs(e.signed)); return { p50_ms: median(v), p95_ms: percentile(v), n: v.length }; };
    const m = result.metrics;
    m.stalls = stalls.map((s, i) => ({ ...s, host_stall: stallSpan(hs, t0 + STALLS[i].at, t0 + STALLS[i].at + 20000) }));
    m.join = window(15000, 25000);
    m.after_a = window(35000, 45000);
    m.after_b = window(60000, 70000);
    m.guest_jumps = { join: jumps(gs, t0 + 5000, t0 + 25000), a: jumps(gs, t0 + 25000, t0 + 45000), b: jumps(gs, t0 + 45000, end) };
    m.host_jumps = { a: jumps(hs, t0 + 25000, t0 + 45000), b: jumps(hs, t0 + 45000, end) };
    m.guest_seeked = g.seeked.filter(e => e.t >= t0 && e.t <= end).map(e => e.t - t0);
    m.host_seeked = h.seeked.filter(e => e.t >= t0 && e.t <= end).map(e => e.t - t0);
    m.raw = { t0, end, host_samples: hs.filter(s => s.t >= t0 - 2000), guest_samples: gs, errors,
      host_sent: h.sent.filter(f => f.data.type === 'sync'), guest_frames: g.frames.filter(f => f.data.type === 'sync') };
    result.ok = true;
  } catch (error) {
    result.errors.push(error.stack ?? String(error));
    result.failure_artifacts = { host_samples: hostTab?.probeSamples?.slice(-20) ?? [], host_console: hostTab?.consoleErrors?.slice(0, 20) ?? [],
      host_frames: hostTab?.frames?.slice(-5).map(f => f.data) ?? [] };
  } finally {
    for (const fn of cleanup.reverse()) { try { await fn(); } catch (error) { result.errors.push(`cleanup: ${error.message}`); } }
    if (front) await front.close();
    await deleteRoom(result, room, host);
    result.finished_at = new Date().toISOString();
    await writeFile(target, JSON.stringify(result) + '\n', { flag: 'wx' });
    const mm = result.metrics;
    console.log(`${result.ok ? 'OK' : 'FAILED'} ${variant} #${runNumber} stalls ${JSON.stringify(mm.stalls?.map(s => s.host_stall?.ms))} guest back ${mm.guest_jumps?.a.back}/${mm.guest_jumps?.b.back} host fwd ${mm.host_jumps?.a.forward}/${mm.host_jumps?.b.forward} p95 ${mm.join?.p95_ms?.toFixed?.(0)}/${mm.after_a?.p95_ms?.toFixed?.(0)}/${mm.after_b?.p95_ms?.toFixed?.(0)}`);
  }
}

const opts = parseArgs(process.argv.slice(2));
const mediaDir = await syncMedia();
const media = await mediaServer(path.join(mediaDir, 'long.webm'));
try {
  for (let run = 1; run <= opts.runs; run++) {
    for (const variant of opts.variants) {
      const dir = path.join(ROOT, 'results/deploy/host_stall', opts.sha, variant);
      const target = path.join(dir, `run-${run}.json`);
      try { await stat(target); console.log(`SKIP ${target}`); continue; } catch {}
      await mkdir(dir, { recursive: true });
      await runOnce(opts, variant, run, target, media);
      await sleep(5000);
    }
  }
} finally { await media.close(); }
