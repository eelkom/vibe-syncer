import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { chromium } from 'playwright';
import { parseArgs, plan } from '../lib/config.mjs';
import { launch, tab, readyHostYouTube, hostResolverRules, YOUTUBE_HOSTS } from '../lib/browser.mjs';
import { YOUTUBE_VIDEO, sampleCounts, youtubeDiagnostics, p95ExcludingFlagged } from '../lib/youtube.mjs';
import * as stats from '../lib/stats.mjs';
import { summarizeYouTube, readYouTubeRuns, markdown } from '../summarize_youtube.mjs';

const source = name => readFile(new URL(`../${name}`, import.meta.url), 'utf8');
const media = (t, ct, extra = {}) => ({ t, ct, paused: false, ...extra });
test('YouTube requires an explicit commit even in smoke and direct plans; all stays unchanged', () => {
  for (const args of [[], ['--smoke']]) {
    assert.throws(() => parseArgs(['--scenario', 'late_join_youtube', ...args]), /requires --commit/);
  }
  assert.throws(() => plan({ scenario: 'late_join_youtube' }), /requires --commit/);
  const opts = parseArgs(['--scenario', 'late_join_youtube', '--commit', 'abcdef0']);
  const jobs = plan(opts);
  assert.equal(jobs.length, 5);
  assert.ok(jobs.every(j => j.sha === 'abcdef0' && j.serverSha === 'abcdef0' && j.condition === 'youtube'));
  assert.deepEqual(jobs.map(j => j.runNumber), [1, 2, 3, 4, 5]);
  assert.equal(plan({ ...opts, runs: 2 }).length, 2);
  assert.equal(plan({ ...opts, smoke: true }).length, 1);
  assert.throws(() => plan({ ...opts, condition: 'default' }), /No matching/);
  for (const smoke of [false, true]) {
    assert.deepEqual([...new Set(plan(parseArgs(smoke ? ['--smoke'] : [])).map(j => j.scenario))],
      ['late_join', 'message_burst', 'history_race', 'autoplay', 'reconnect']);
    const job = plan({ ...opts, smoke })[0];
    assert.equal(path.join('results', smoke ? 'smoke' : 'stage1', job.scenario, job.sha, job.condition, `run-${job.runNumber}.json`),
      `results/${smoke ? 'smoke' : 'stage1'}/late_join_youtube/abcdef0/youtube/run-1.json`);
  }
});

test('legacy late_join remains byte-identical to the pre-#40 scenario', async () => {
  assert.equal(createHash('sha256').update(await source('scenarios/late_join.mjs')).digest('hex'),
    'cd8a74107fe48c9e8fa9163434d8f804b3e664269ec56f7b3662348914964de0');
});

test('launch retains every legacy flag and only adds explicit DNS exclusions', async t => {
  const calls = [], cleanup = [];
  const browser = { version: () => 'mock', close: async () => {} };
  t.mock.method(chromium, 'launch', async options => { calls.push(options); return browser; });
  await launch(cleanup);
  assert.deepEqual(calls[0], { headless: true, args: [
    '--autoplay-policy=no-user-gesture-required',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    '--mute-audio', '--disable-features=HardwareMediaKeyHandling',
  ] });
  const hosts = ['youtube.com', '*.youtube.com', '*.youtube-nocookie.com', '*.googlevideo.com', '*.ytimg.com',
    '*.ggpht.com', '*.gstatic.com', '*.google.com', '*.googleapis.com', '*.doubleclick.net', '*.googlesyndication.com', '*.googleadservices.com'];
  assert.deepEqual(YOUTUBE_HOSTS, hosts);
  await launch(cleanup, true, { allowHosts: YOUTUBE_HOSTS });
  assert.equal(calls[1].args[0], '--autoplay-policy=document-user-activation-required');
  assert.equal(calls[1].args[1], calls[0].args[1] + hosts.map(host => `, EXCLUDE ${host}`).join(''));
  assert.equal(hostResolverRules(), calls[0].args[1]);
  assert.equal(cleanup.length, 2);
});

async function fakeTab(youtube = true, capture = false) {
  let init, args;
  const page = new EventEmitter(), cleanup = [];
  const result = { errors: [], blocked_external_requests: 0 };
  const context = { addInitScript: async (fn, data) => { init = fn; args = data; }, newPage: async () => page, close: async () => {} };
  const state = await tab({ newContext: async () => context }, { nickname: 'observer', token: 'private' }, result, cleanup,
    'muted-allowed', capture, { youtube });
  return { state, page, result, cleanup, init, args };
}

function runInit(fixture, { top = false, hostname = 'www.youtube.com', pathname = '/embed/test' } = {}) {
  const timers = [], messages = [], storage = [];
  class NativeWebSocket {}
  const window = { WebSocket: NativeWebSocket, location: { hostname, pathname } };
  window.top = top ? window : {};
  const document = { addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] };
  vm.runInNewContext(`(${fixture.init.toString()})(${JSON.stringify(fixture.args)})`, {
    window, document, sessionStorage: { setItem: (...args) => storage.push(args) },
    navigator: { userActivation: { hasBeenActive: false } },
    setInterval: (fn, delay) => timers.push({ fn, delay }), console: { debug: (...args) => messages.push(args) },
  });
  return { window, document, timers, messages, storage, NativeWebSocket };
}

test('YouTube init keeps credentials and existing instrumentation in the top frame only', async () => {
  const fixture = await fakeTab();
  const top = runInit(fixture, { top: true, hostname: '127.0.0.1', pathname: '/room/test' });
  assert.equal(JSON.parse(top.storage[0][1]).token, 'private');
  assert.ok(top.window.__samples);
  assert.notEqual(top.window.WebSocket, top.NativeWebSocket);
  assert.deepEqual(top.timers.map(timer => timer.delay), [250, 100]);
  for (const frame of [
    { hostname: 'www.youtube.com', pathname: '/watch' },
    { hostname: 'youtube.com.evil.test' }, { hostname: 'other.test' }, { hostname: '127.0.0.1' },
  ]) {
    const child = runInit(fixture, frame);
    assert.equal(child.storage.length, 0);
    assert.equal(child.window.__samples, undefined);
    assert.equal(child.window.WebSocket, child.NativeWebSocket);
    assert.equal(child.timers.length, 0);
  }
  const legacy = runInit(await fakeTab(false));
  assert.equal(legacy.storage.length, 1); // Default still instruments all frames.
  assert.ok(legacy.window.__samples);
});

test('only YouTube embed frames emit 100ms video samples including ads, buffering and missing video', async () => {
  const fixture = await fakeTab();
  for (const hostname of ['youtube.com', 'www.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com']) {
    const child = runInit(fixture, { hostname });
    assert.equal(child.storage.length, 0);
    assert.equal(child.timers.length, 1);
    assert.equal(child.timers[0].delay, 100);
    const tick = child.timers[0].fn;
    tick();
    assert.equal(JSON.parse(child.messages[0][0].slice('__yt_sample '.length)).none, true);
    let ad = true, buffering = false;
    const video = { currentTime: 4, paused: false, muted: true, volume: 0.4, readyState: 2 };
    child.document.querySelector = selector => ({
      video, '.html5-video-player': { classList: ['html5-video-player', 'playing-mode'] },
      '.html5-video-player.ad-showing': ad, '.html5-video-player.buffering-mode': buffering,
    })[selector];
    tick();
    const sample = JSON.parse(child.messages[1][0].slice('__yt_sample '.length));
    assert.deepEqual({ ...sample, t: 0 }, { t: 0, ct: 4, paused: false, muted: true, volume: 0.4, readyState: 2,
      ad: true, buffering: true, player_state: 'playing-mode' });
    ad = false; video.readyState = 4; buffering = true; tick();
    assert.equal(JSON.parse(child.messages[2][0].slice('__yt_sample '.length)).buffering, true);
    buffering = false; tick();
    assert.equal(JSON.parse(child.messages[3][0].slice('__yt_sample '.length)).buffering, false);
  }
});

test('console samples survive remounts, external diagnostics stay separate, and failed artifacts keep samples', async () => {
  const { page, state, result, cleanup } = await fakeTab(true, true);
  page.evaluate = async () => ({ samples: [], user_click_events: [], ws_log: [], blocked_play_calls: 0 });
  const emit = (text, type = 'debug') => page.emit('console', { text: () => text, type: () => type });
  emit('__yt_sample {"t":1,"ct":2}', 'error');
  emit('__yt_sample {"t":2,"none":true}');
  emit('__yt_sample {"t":3,"ct":0}');
  emit('real console error', 'error');
  assert.equal(state.ytSamples.length, 3);
  assert.equal(state.consoleErrors.length, 1);
  const request = host => ({ url: () => `https://${host}/x`, failure: () => ({ errorText: 'net::ERR_NAME_NOT_RESOLVED' }) });
  page.emit('request', request('www.youtube.com')); page.emit('request', request('www.youtube.com'));
  page.emit('request', request('127.0.0.1')); page.emit('requestfailed', request('missed.example'));
  page.emit('websocket', { url: () => 'wss://external.example/ws', on() {} });
  page.emit('pageerror', new Error('iframe error'));
  assert.equal(result.blocked_external_requests, 0);
  assert.deepEqual(result.external_hosts, { 'www.youtube.com': 2, 'external.example': 1 });
  assert.deepEqual(result.blocked_hosts, { 'missed.example': 1 });
  assert.equal(result.youtube_page_errors[0].text, 'iframe error');
  assert.deepEqual(result.errors, []);
  await cleanup.at(-1)();
  assert.deepEqual(result.browser_artifacts[0].yt_samples, state.ytSamples);
  const legacy = await fakeTab(false);
  legacy.page.emit('request', request('external.example'));
  legacy.page.emit('pageerror', new Error('legacy error'));
  assert.equal(legacy.result.blocked_external_requests, 1);
  assert.deepEqual(legacy.result.errors, ['pageerror: legacy error']);
  assert.equal(legacy.result.youtube_page_errors, undefined);
});

test('host readiness uses console samples and top-frame pause/play clicks with sync receipts', async () => {
  const operations = [], sent = [];
  const state = { ytSamples: [media(Date.now(), 0.3)], attempts: [1], frames: [1], sent, page: {
    goto: async () => operations.push('enter'),
    locator: selector => { assert.equal(selector, 'button.h-14'); return { click: async () => {
      const action = sent.length ? 'play' : 'pause'; operations.push(action);
      sent.push({ t: Date.now(), data: { type: 'sync', action } });
    } }; },
    evaluate: async fn => { assert.match(fn.toString(), /__lastPlaybackClickAt/); return 42; },
  } };
  await readyHostYouTube(state, { room_code: 'test' });
  assert.deepEqual(operations, ['enter', 'pause', 'play']);
  assert.equal(state.lastPlayClickAt, 42);
});

test('host timeout reports the last ten samples and blocked hosts', async t => {
  let now = 0;
  t.mock.method(Date, 'now', () => (now += 60001));
  const state = { ytSamples: Array.from({ length: 12 }, (_, t) => ({ t, none: true })),
    blockedHosts: { 'missed.example': 1 }, page: { goto: async () => {} } };
  await assert.rejects(readyHostYouTube(state, { room_code: 'test' }), error => {
    assert.match(error.message, /host YouTube playback/);
    assert.match(error.message, /missed.example/);
    assert.ok(error.message.includes(JSON.stringify(state.ytSamples.slice(-10))));
    return true;
  });
});

test('diagnostics count full observation and final window separately without inventing playback', () => {
  const host = [media(0, 0, { ad: true }), media(15100, 15, { buffering: true }), { t: 25001, none: true }];
  const guest = [{ t: 100, none: true }, media(150, 1, { ad: true }), media(200, 0), media(300, 2, { paused: true }), media(400, 2)];
  const before = structuredClone({ host, guest });
  const d = youtubeDiagnostics(host, guest, 0, 100, 25100);
  assert.equal(d.first_sample_ms, 0); assert.equal(d.first_playing_ms, 300);
  assert.deepEqual(d.interference.host.observation, { ad_samples: 1, buffering_samples: 1, none_samples: 1, paused_samples: 0, total_samples: 3 });
  assert.equal(d.interference.host.window.ad_samples, 0);
  assert.equal(d.interference.host.window.buffering_samples, 1);
  assert.deepEqual(d.flags, ['host_ad', 'host_buffering', 'host_buffering_window', 'guest_ad']);
  assert.deepEqual({ host, guest }, before);
  const empty = youtubeDiagnostics([], [], 0, 100, 8100);
  assert.equal(empty.first_sample_ms, null); assert.equal(empty.first_playing_ms, null);
  assert.deepEqual(empty.flags, ['guest_never_played']);
  const blocked = youtubeDiagnostics([], [media(100, 0, { paused: true }), media(8101, 2)], 0, 100, 8100);
  assert.equal(blocked.first_sample_ms, 0); assert.equal(blocked.first_playing_ms, null);
  assert.deepEqual(blocked.flags, ['guest_never_played']);
  const smoke = youtubeDiagnostics([], [media(110, 2, { ad: true, buffering: true })], 0, 100, 8100);
  assert.deepEqual(smoke.flags, ['guest_ad', 'guest_buffering', 'guest_ad_window', 'guest_buffering_window', 'guest_never_played']);
  assert.deepEqual(sampleCounts([{ t: 99, none: true }, { t: 100, none: true }, media(200, 2, { paused: true }), { t: 201, none: true }], 100, 200),
    { ad_samples: 0, buffering_samples: 0, none_samples: 1, paused_samples: 1, total_samples: 2 });
});

test('primary errors include ad positions; optional p95 excludes either side and interpolation endpoints', () => {
  const host = [media(0, 10), media(100, 10.1, { ad: true }), media(200, 10.2), media(300, 10.3), media(400, 10.4)];
  const guest = [media(50, 1), media(100, 1), media(200, 1, { buffering: true }), media(300, 10.2), media(400, 10.2)];
  const errors = stats.positionErrors(host, guest);
  assert.ok(stats.percentile(errors.map(s => s.err)) > 9000);
  assert.ok(Math.abs(p95ExcludingFlagged(errors, host, guest, 0, 400) - 200) < 1e-8);
  assert.equal(p95ExcludingFlagged(errors, host, guest, 0, 200), null);
  assert.equal(p95ExcludingFlagged([], [], [], 0, 100), null);
});

test('YouTube scenario keeps late_join timing and metrics and never reads iframe samples by evaluation', async () => {
  const code = (await source('scenarios/late_join_youtube.mjs')).split('export async function run')[1];
  for (const smoke of [false, true]) for (const noSamples of [false, true]) {
    const duration = smoke ? 8000 : 25000, end = 40000 + duration;
    const hs = [media(40000, 10), media(end, 10 + duration / 1000)];
    const gs = noSamples ? [] : [media(40100, 10.1, { ad: true }), media(end, 10 + duration / 1000)];
    const host = { ytSamples: hs, t0: 0, sent: [], lastPlayClickAt: 100 },
      guest = { ytSamples: gs, t0: 40000, clicks: [], frames: [], responses: [], consoleErrors: [] };
    const waits = [], launches = [], tabs = [];
    const sandbox = { ...stats, YOUTUBE_VIDEO, YOUTUBE_HOSTS, youtubeDiagnostics, p95ExcludingFlagged,
      Date: { now: () => 40000 },
      launch: async (...args) => { launches.push(args); return {}; },
      tab: async (...args) => { tabs.push(args); return tabs.length === 1 ? host : guest; },
      readyHostYouTube: async state => assert.equal(state, host),
      sleep: async ms => { waits.push(ms); },
      scriptedUser: () => async () => {}, enter: async state => assert.equal(state, guest),
      readObservation: async state => {
        assert.equal(state, guest); assert.deepEqual(waits, [smoke ? 5000 : 30000, duration]);
        return { samples: [{ t: 40100, act: true }], ws_log: [], user_click_events: [] };
      },
    };
    const run = vm.runInNewContext(`(async function run${code})`, sandbox);
    const metrics = await run({ smoke, cleanup: [], result: {}, seed: { host: {}, guest: {}, room: {} } });
    assert.equal(launches[0][1], false); assert.equal(launches[1][1], true);
    assert.equal(launches[0][2].allowHosts, YOUTUBE_HOSTS);
    assert.ok(tabs.every(args => args[6].youtube === true));
    assert.equal(metrics.video, YOUTUBE_VIDEO);
    assert.equal(metrics.activation_before_first_click, true); // Top-frame act, not ytSamples.
    assert.deepEqual(Array.from(metrics.raw.errors), stats.positionErrors(hs, gs));
    assert.deepEqual([...metrics.raw.host_samples], hs);
    assert.equal(metrics.first_sample_ms, noSamples ? null : 100);
    assert.equal(metrics.first_playing_ms, noSamples ? null : duration);
    if (noSamples) assert.equal(metrics.err_p95_ms, null);
  }
});

test('seed defaults preserve the existing local queue values and YouTube options set only song fields', async () => {
  const text = await source('lib/database.mjs'), queries = [];
  const sandbox = { DB: {}, guest: async () => ({}), rest: async () => ({ id: 1, host_id: 2 }),
    pg: { Client: class { async connect() {} async end() {} async query(...args) { queries.push(args); } } } };
  const seed = vm.runInNewContext(`(${text.slice(text.indexOf('export async function seed')).replace('export async function seed', 'async function seed')})`, sandbox);
  await seed('loadtest_test');
  assert.deepEqual([...queries[0][1]], [1, 2, 'http://127.0.0.1:15174/tone.webm', 'Stage1 tone', 'Local', 'Local']);
  await seed('loadtest_test', { musicUrl: YOUTUBE_VIDEO.url, title: 'Big Buck Bunny', artist: 'Blender', platform: 'Youtube' });
  assert.deepEqual([...queries[1][1]], [1, 2, YOUTUBE_VIDEO.url, 'Big Buck Bunny', 'Blender', 'Youtube']);
  await seed('loadtest_test', { queue: false });
  assert.equal(queries.length, 2);
});

test('summary groups commits, keeps failed rows, excludes only non-ok and missing numbers, and does not mutate', () => {
  const runs = [
    { commit: 'abc', run: 2, ok: true, metrics: { err_p95_ms: 20, first_playing_ms: null, clicks: [], flags: ['guest_ad'] }, external_hosts: { a: 5, b: 1 }, blocked_hosts: { c: 2 } },
    { commit: 'abc', run: 1, ok: true, metrics: { err_p95_ms: 10, first_playing_ms: 100, clicks: [{}] } },
    { commit: 'abc', run: 3, ok: false, metrics: { err_p95_ms: 999, first_playing_ms: 999, clicks: [{}, {}] } },
    { commit: 'def', run: 1, ok: false },
  ];
  const before = structuredClone(runs), groups = summarizeYouTube(runs);
  assert.deepEqual(groups[0].rows.map(row => row.run), [1, 2, 3]);
  assert.equal(groups[0].rows[2].ok, false);
  assert.deepEqual(groups[0].metrics.err_p95_ms, { median: 15, min: 10, max: 20 });
  assert.deepEqual(groups[0].metrics.first_playing_ms, { median: 100, min: 100, max: 100 });
  assert.deepEqual(groups[0].metrics.clicks, { median: 0.5, min: 0, max: 1 });
  assert.equal(groups[0].rows[1].external_hosts, 2);
  assert.deepEqual(groups[1].metrics.err_p95_ms, { median: null, min: null, max: null });
  assert.match(markdown(groups), /guest_ad/); assert.match(markdown(groups), /999/);
  assert.match(markdown(groups), /"c":2/); assert.match(markdown([]), /측정 원본 없음/);
  assert.deepEqual(runs, before);
});

test('summary reads only commit/youtube/run-N.json and ignores previous backups and other paths', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'youtube-summary-'));
  try {
    for (const dir of ['abc/youtube', 'abc/default', 'def/youtube']) await mkdir(path.join(root, dir), { recursive: true });
    await writeFile(path.join(root, 'abc/youtube/run-1.json'), JSON.stringify({ commit: 'abc', run: 1 }));
    for (const file of ['abc/youtube/run-1.previous-stamp.json', 'abc/youtube/env.json', 'abc/default/run-1.json', 'def/run-2.json']) {
      await writeFile(path.join(root, file), 'invalid JSON that must not be read');
    }
    assert.deepEqual(await readYouTubeRuns(root), [{ commit: 'abc', run: 1 }]);
    assert.deepEqual(await readYouTubeRuns(path.join(root, 'missing')), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
