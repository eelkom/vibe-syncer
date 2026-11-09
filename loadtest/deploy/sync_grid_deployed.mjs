// 실행: node loadtest/deploy/sync_grid_deployed.mjs --sha 669a045 --combos 2:5000,0.5:2000 [--runs 3] [--variant <name>]
// 보정 기준(초)과 호스트 주기 전송 간격(ms)만 바꾼 측정용 프론트 빌드를 127.0.0.1:15173에서 띄우고
// 실제 배포 서버(Render)에 접속한다. 빌드는 scripts/prepare_sync_grid.sh로 만든다.
// 입장마다 Gemini 환영 메시지 호출이 발생한다. 방은 회차마다 삭제한다.
//
// 회차 구성 (게스트 입장 T0 기준):
//   0~25s   늦은 합류. 15~25s 구간이 기존 배포 측정과 같은 창이다.
//   25s     교란 A: 게스트 iframe video.currentTime -= 0.8s (작은 어긋남)
//   45s     교란 B: 게스트 iframe video.currentTime -= 4s (큰 어긋남)
//   65s     종료
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { ROOT, sleep, until } from '../lib/common.mjs';
import { launch, tab, readyHostYouTube, enter, scriptedUser, readObservation, YOUTUBE_HOSTS } from '../lib/browser.mjs';
import { staticServer } from '../lib/static-server.mjs';
import { interpolate, median, percentile } from '../lib/stats.mjs';
import { recoveryTime } from '../lib/sync-stats.mjs';
import { youtubeDiagnostics, YOUTUBE_VIDEO } from '../lib/youtube.mjs';
import { wake, warm, createRoom, addSong, deleteRoom, extraHosts } from './late_join_deployed.mjs';

const LOCAL_FRONT = 'http://127.0.0.1:15173';
const API = 'https://vibe-syncer.onrender.com';
const DIST = sha => path.join(ROOT, `.baselines/sync-grid-${sha}-dist`);
const PHASES = { join: [15000, 25000], a: [25000, 45000], b: [45000, 65000] };
const DISTURB = [{ name: 'a', at: 25000, seconds: 0.8 }, { name: 'b', at: 45000, seconds: 4 }];
const END = 65000;

function parseArgs(args) {
  const opts = { runs: 3, sha: null, combos: [], variant: null, tag: null };
  for (let i = 0; i < args.length; i++) {
    const key = args[i], value = args[++i];
    if (key === '--runs') opts.runs = Number(value);
    else if (key === '--sha') opts.sha = value;
    else if (key === '--combos') opts.combos = value.split(',');
    else if (key === '--variant') opts.variant = value;
    // Separate result folder, e.g. for an alternating before/after comparison
    else if (key === '--tag') opts.tag = value;
    else throw new Error(`Unknown argument: ${key}`);
  }
  if (!/^[0-9a-f]{7}$/.test(opts.sha ?? '') || !opts.combos.length || !(opts.runs >= 1)) throw new Error('--sha <7hex> --combos t:i,... required');
  return opts;
}

const playing = s => s && !s.none && !s.paused && !s.ad && Number.isFinite(s.ct);
// Signed error in ms: positive means the guest is behind the host.
export function signedErrors(hs, gs) {
  return gs.map(s => {
    const h = playing(s) ? interpolate(hs, s.t) : null;
    return { t: s.t, signed: h === null ? null : (h - s.ct) * 1000, err: h === null ? null : Math.abs(h - s.ct) * 1000 };
  });
}
const stats = (errors, t0, [a, b]) => {
  const sel = errors.filter(e => e.t >= t0 + a && e.t < t0 + b);
  const abs = sel.map(e => e.err), signed = sel.map(e => e.signed);
  return { p50_ms: median(abs), p95_ms: percentile(abs), signed_median_ms: median(signed),
    valid: abs.filter(v => v !== null).length, total: sel.length };
};

// Which network a run used: delivery delay depends on it. Gateway IP and MAC
// tell networks apart without recording the network name.
function network() {
  try {
    const gateway = /gateway: (\S+)/.exec(execFileSync('route', ['-n', 'get', 'default'], { encoding: 'utf8' }))?.[1] ?? null;
    const mac = gateway ? /at (\S+)/.exec(execFileSync('arp', ['-n', gateway], { encoding: 'utf8' }))?.[1] ?? null : null;
    return { gateway, gateway_mac: mac, label: process.env.NETWORK_LABEL ?? null };
  } catch (error) { return { error: error.message }; }
}

async function runOnce(opts, combo, runNumber, target) {
  const [threshold, interval] = combo.split(':').map(Number);
  const result = { scenario: 'sync_grid_deployed', sha: opts.sha, variant: opts.variant, tag: opts.tag, threshold_s: threshold, interval_ms: interval,
    run: runNumber, started_at: new Date().toISOString(), front: `${LOCAL_FRONT} (local build, ${DIST(opts.sha)})`, api: API,
    video: YOUTUBE_VIDEO, network: network(), errors: [], ok: false, wake_ms: null, warm_ms: [], room_deleted: null, metrics: {} };
  const cleanup = [];
  let room, host, server, hostTab, guest;
  console.log(`RUN ${combo}${opts.variant ? ` ${opts.variant}` : ''} #${runNumber}`);
  try {
    const dir = path.join(DIST(opts.sha), opts.variant ? `${opts.variant}-t${threshold}-i${interval}` : `t${threshold}-i${interval}`);
    result.build = JSON.parse(await readFile(path.join(dir, 'sync-grid.json'), 'utf8'));
    server = await staticServer(dir, 15173, true);
    await wake(result);
    await warm(result);
    ({ room, host } = await createRoom(result));
    const res = await fetch(`${API}/rooms/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room_code: room.room_code, nickname: 'loadtest-guest' }), signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`join HTTP ${res.status}`);
    const joined = await res.json();
    const guestUser = { userId: joined.user_id, nickname: 'loadtest-guest', isHost: false, token: joined.token };
    await addSong(room, host);
    const allowHosts = [...YOUTUBE_HOSTS, ...extraHosts];
    const hb = await launch(cleanup, false, { allowHosts }), gb = await launch(cleanup, true, { allowHosts });
    hostTab = await tab(hb, host, result, cleanup, 'muted-allowed', false, { youtube: true, syncProbe: true });
    await readyHostYouTube(hostTab, room, LOCAL_FRONT);
    await sleep(30000);
    guest = await tab(gb, guestUser, result, cleanup, 'muted-allowed', false, { youtube: true, syncProbe: true });
    const stopUser = scriptedUser(guest, cleanup, result);
    await enter(guest, room, LOCAL_FRONT);
    const t0 = guest.t0;
    const disturbances = [];
    for (const d of DISTURB) {
      await sleep(Math.max(0, t0 + d.at - Date.now()));
      const frame = guest.page.frames().find(f => f.url().includes('/embed/'));
      if (!frame) throw new Error('guest embed frame missing');
      // Deliberate media fault inside the iframe, never an app handler.
      disturbances.push({ name: d.name, ...(await frame.evaluate(s => {
        const v = document.querySelector('video');
        const before = v.currentTime, at = Date.now();
        v.currentTime = Math.max(0, before - s);
        return { at, before, target: v.currentTime, paused: v.paused };
      }, d.seconds)) });
    }
    await sleep(Math.max(0, t0 + END - Date.now()));
    await stopUser();
    await readObservation(guest, result);
    const end = t0 + END;
    const hs = [...hostTab.ytSamples], gs = guest.ytSamples.filter(s => s.t <= end);
    const errors = signedErrors(hs, gs);
    const m = result.metrics;
    for (const [name, range] of Object.entries(PHASES)) m[name] = stats(errors, t0, range);
    // Steady state after each disturbance: last 10s of the phase.
    m.a_steady = stats(errors, t0, [35000, 45000]);
    m.b_steady = stats(errors, t0, [55000, 65000]);
    m.disturbances = disturbances.map(d => {
      const stop = d.name === 'a' ? t0 + PHASES.b[0] : end;
      return { ...d, recovery_2s_ms: recoveryTime(errors, d.at, stop, 2000),
        recovery_1s_ms: (() => { const r = errors.filter(e => e.t >= d.at && e.t < stop);
          let start = null; for (const e of r) { if (e.err !== null && e.err < 1000) { start ??= e.t; if (e.t - start >= 2000) return start - d.at; } else start = null; } return null; })() };
    });
    // Guest seeked events not caused by our own disturbance (within 1s after it).
    const ownSeek = e => disturbances.some(d => e.t >= d.at && e.t < d.at + 1000);
    const seeks = guest.seeked.filter(e => e.t >= t0 && e.t <= end);
    m.guest_seeks = { total: seeks.length, correction: seeks.filter(e => !ownSeek(e)).length,
      after_first_play_steady: seeks.filter(e => !ownSeek(e) && e.t >= t0 + 10000).length,
      times_ms: seeks.map(e => e.t - t0) };
    m.guest_buffering_samples = gs.filter(s => s.t >= t0 + 10000 && s.buffering).length;
    m.guest_pause_samples = gs.filter(s => s.t >= t0 + 10000 && s.paused).length;
    const hostSyncs = hostTab.sent.filter(f => f.data.type === 'sync' && f.t >= t0 && f.t <= end);
    m.host_sync_messages = hostSyncs.length;
    m.host_sync_per_min = hostSyncs.length / (END / 60000);
    // Delivery (host send -> guest receive, one shared clock) and host echo RTT.
    const key = f => `${f.data.action}:${f.data.timestamp}`;
    const sent = new Map(hostTab.sent.filter(f => f.data.type === 'sync').map(f => [key(f), f.t]));
    m.delivery_ms = guest.frames.filter(f => f.data.type === 'sync' && !f.data.snapshot && sent.has(key(f))).map(f => f.t - sent.get(key(f)));
    m.host_echo_rtt_ms = hostTab.frames.filter(f => f.data.type === 'sync' && sent.has(key(f))).map(f => f.t - sent.get(key(f)));
    m.report_err_ms = hostTab.sent.filter(f => f.data.type === 'sync').map(f => { const h = interpolate(hs, f.t); return h === null ? null : Math.round((h - f.data.timestamp) * 1000); });
    Object.assign(m, youtubeDiagnostics(hs, gs, hostTab.t0, t0, end));
    m.clicks = guest.clicks;
    m.raw = { t0, end, host_samples: hs.filter(s => s.t >= t0 - 2000), guest_samples: gs, errors,
      host_sent: hostTab.sent.filter(f => f.data.type === 'sync'), guest_frames: guest.frames.filter(f => f.data.type === 'sync'),
      guest_seeked: seeks, guest_console: guest.consoleErrors.slice(0, 50) };
    result.ok = true;
  } catch (error) {
    result.errors.push(error.stack ?? String(error));
    // Keep what was observed so the failure can be diagnosed.
    result.failure_artifacts = { t0: guest?.t0 ?? null, host_samples: hostTab?.ytSamples?.slice(-300) ?? [],
      guest_samples: guest?.ytSamples ?? [], guest_frames: guest?.frames?.filter(f => f.data.type === 'sync') ?? [],
      guest_seeked: guest?.seeked ?? [], guest_console: guest?.consoleErrors?.slice(0, 50) ?? [],
      guest_frame_urls: guest ? guest.page.frames().map(f => f.url()) : [] };
  } finally {
    for (const fn of cleanup.reverse()) { try { await fn(); } catch (error) { result.errors.push(`cleanup: ${error.message}`); } }
    if (server) await server.close();
    await deleteRoom(result, room, host);
    result.finished_at = new Date().toISOString();
    await writeFile(target, JSON.stringify(result) + '\n', { flag: 'wx' });
    const mm = result.metrics;
    console.log(`${result.ok ? 'OK' : 'FAILED'} ${combo} #${runNumber} join p95 ${mm.join?.p95_ms?.toFixed?.(0)} a ${mm.a_steady?.p95_ms?.toFixed?.(0)} b ${mm.b_steady?.p95_ms?.toFixed?.(0)} seeks ${mm.guest_seeks?.correction}`);
  }
  return result;
}

const opts = parseArgs(process.argv.slice(2));
// Round-robin so that every combination sees similar network and Gemini conditions.
for (let run = 1; run <= opts.runs; run++) {
  for (const combo of opts.combos) {
    const dir = path.join(ROOT, 'results/deploy/sync_grid', opts.sha, ...(opts.tag ? [opts.tag] : []), `${opts.variant ? `${opts.variant}-` : ''}t${combo.replace(':', '-i')}`);
    const target = path.join(dir, `run-${run}.json`);
    try { await stat(target); console.log(`SKIP ${target}`); continue; } catch {}
    await mkdir(dir, { recursive: true });
    await runOnce(opts, combo, run, target);
    await sleep(5000);
  }
}
