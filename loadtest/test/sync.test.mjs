import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { recoveryTime, intervalP95, backwardJumps, staleVideoSyncs, sourceMatches, reconnectFrames } from '../lib/sync-stats.mjs';
import { parseArgs, plan } from '../lib/config.mjs';
import { SYNC_CONDITIONS, syncSongs } from '../lib/sync-plan.mjs';
import { serverArgs } from '../lib/server.mjs';
import { summarizeSync, syncMarkdown, readSyncRuns } from '../summarize_sync.mjs';

const errors = (start, end, err = 100) => Array.from({ length: (end - start) / 100 + 1 }, (_, i) => ({ t: start + i * 100, err }));
test('recovery requires a continuous 2s below 2000ms, rejects missing values and sampling gaps, respects next disturbance', () => {
  assert.equal(recoveryTime(errors(100, 2100), 0), 100);
  assert.equal(recoveryTime(errors(0, 2000, 2000), 0), null);
  const samples = errors(0, 5000);
  samples[2].err = null;
  assert.equal(recoveryTime(samples, 0), 300);
  assert.equal(recoveryTime([{ t: 0, err: 0 }, ...errors(1000, 3000)], 0), 1000);
  assert.equal(recoveryTime(errors(0, 3000), 0, 2000), null);
  assert.equal(recoveryTime([], 0), null);
});
test('interval p95 has non-overlapping 30s windows and keeps empty/paused intervals', () => {
  const rows = intervalP95([{ t: 0, err: 10 }, { t: 29999, err: 20 }, { t: 30000, err: 99 },
    { t: 60000, err: null }, { t: 90000, err: 1000 }], 0, 90000);
  assert.deepEqual(rows.map(r => r.p95_ms), [20, 99, null]);
  assert.deepEqual(rows.map(r => r.valid_samples), [2, 1, 0]);
  assert.equal(rows[2].total_samples, 1);
  assert.throws(() => intervalP95([], 0, 10, 0), /positive/);
});
test('backward jumps count strict >2s, including first post-reload jump but not absent media', () => {
  const samples = [{ t: 0, ct: 10 }, { t: 100, ct: 8 }, { t: 200, ct: 5 }, { t: 300, none: true },
    { t: 400, ct: 0 }, { t: 500, ct: 3 }, { t: 600, ct: 0 }];
  assert.equal(backwardJumps(samples), 2);
  assert.equal(backwardJumps(samples, 200), 2);
  assert.equal(backwardJumps(samples, 201), 1);
});
test('stale sync count checks video URL including query, excludes earlier frames and non-sync', () => {
  const frame = (t, videoId, type = 'sync') => ({ t, data: { type, videoId } });
  const frames = [frame(0, 'old'), frame(10, 'old'), frame(11, 'target'), frame(12, 'target?song=b'),
    frame(13, undefined), frame(14, 'old', 'request_sync'), frame(20, 'old')];
  assert.equal(staleVideoSyncs(frames, 10, 'target', 20), 2);
  assert.equal(staleVideoSyncs([], 10, 'target'), 0);
});
test('source matching preserves unknown samples and reconnect counts stay separate per receiver', () => {
  assert.deepEqual(sourceMatches([{ t: 10, src: 'a' }, { t: 30, src: 'b' }],
    [{ t: 0 }, { t: 20, src: 'b' }, { t: 30, src: 'b' }]).map(s => s.same), [null, false, true]);
  const frames = [{ t: 10, data: { type: 'system', message: 'host has joined the room.' } },
    { t: 20, data: { type: 'chat', user_id: 0 } }, { t: 21, data: { type: 'chat', user_id: 1 } }];
  assert.deepEqual(reconnectFrames(frames, 10, 20), { join: 1, welcome: 0 });
  assert.deepEqual(reconnectFrames(frames, 20), { join: 0, welcome: 1 });
});
test('all sync plans require explicit commit and preserve their conditions', () => {
  for (const [scenario, conditions] of Object.entries(SYNC_CONDITIONS)) {
    assert.throws(() => parseArgs(['--scenario', scenario]), /requires --commit/);
    assert.throws(() => plan({ scenario }), /requires --commit/);
    const opts = parseArgs(['--scenario', scenario, '--commit', '24a8650', '--runs', '2']);
    const jobs = plan(opts);
    assert.equal(jobs.length, conditions.length * 2);
    assert.deepEqual([...new Set(jobs.map(j => j.condition))], conditions);
    assert.ok(jobs.every(j => j.sha === '24a8650' && j.serverSha === j.sha));
    assert.equal(plan({ ...opts, condition: conditions[0], smoke: true }).length, 1);
    if (scenario === 'server_block') assert.ok(jobs.every(j => j.slowAiMs === 10000));
  }
  assert.ok(!plan(parseArgs([])).some(j => SYNC_CONDITIONS[j.scenario]));
  const local = syncSongs('song_change', 'local-prev');
  assert.equal(local.length, 2);
  assert.notEqual(local[0].musicUrl, local[1].musicUrl);
  assert.equal(syncSongs('natural_end', 'local')[1].musicUrl, 'http://127.0.0.1:15174/long.webm');
  assert.ok(syncSongs('song_change', 'youtube-next')[1].musicUrl.endsWith('eRsGyueVLvQ'));
});
test('slow AI server option is opt-in and validated without changing legacy arguments', () => {
  const legacy = serverArgs('24a8650', 'loadtest_sync');
  assert.ok(!legacy.includes('--slow-ai-ms'));
  assert.deepEqual(serverArgs('24a8650', 'loadtest_sync', null, null, 10000), [...legacy, '--slow-ai-ms', '10000']);
  for (const n of [-1, NaN, 0.5]) assert.throws(() => serverArgs('24a8650', 'loadtest_sync', null, null, n), /slowAiMs/);
});
test('summary separates scenarios, conditions and commits, shows failed values and missing recoveries', () => {
  const base = { scenario: 'host_reconnect', condition: 'local-seek', commit: '24a8650' };
  const runs = [
    { ...base, run: 1, ok: true, metrics: { recovery_ms: 10, recovery_times_ms: [10, null] } },
    { ...base, run: 2, ok: true, metrics: { recovery_ms: 30 } },
    { ...base, run: 3, ok: false, errors: ['setup error'], metrics: { recovery_ms: 999 } },
    { ...base, run: 4, ok: true, metrics: { recovery_ms: null } },
    { ...base, commit: 'abcdef0', run: 1, ok: true, metrics: { recovery_ms: 100 } },
    { ...base, condition: 'local-alone', run: 1, ok: false },
  ];
  const before = structuredClone(runs), groups = summarizeSync(runs);
  const g = groups.find(g => g.key.endsWith('/local-seek/24a8650'));
  assert.deepEqual(g.metrics.recovery_ms, { median: 20, min: 10, max: 30, missing: 1 });
  const md = syncMarkdown(groups);
  assert.match(md, /run-3 FAILED/); assert.match(md, /999/); assert.match(md, /setup error/);
  assert.match(md, /\[10,null\]/);
  assert.equal(groups.length, 3);
  assert.deepEqual(runs, before);
});
test('summary reads only new stage1/e2e originals, never backups or existing scenario results', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sync-summary-'));
  try {
    const a = path.join(root, 'stage1/host_no_action/24a8650/local'), b = path.join(root, 'e2e/ws_room_token/24a8650');
    await mkdir(a, { recursive: true }); await mkdir(b, { recursive: true });
    await writeFile(path.join(a, 'run-1.json'), JSON.stringify({ run: 1, ok: false }));
    await writeFile(path.join(a, 'run-1.previous-stamp.json'), 'invalid');
    await writeFile(path.join(b, 'run-1.json'), JSON.stringify({ run: 1, ok: true, passed: false }));
    const runs = await readSyncRuns(root);
    assert.equal(runs.length, 2);
    assert.equal(runs[0].scenario, 'host_no_action');
    assert.equal(runs[1].suite, 'e2e');
    assert.match(syncMarkdown(summarizeSync(runs)), /FAIL/);
    assert.match(syncMarkdown([]), /측정 원본 없음/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// These fixtures run browser init code in a VM, never Chromium or PostgreSQL.
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { tab, dropSocket, restoreSocket } from '../lib/browser.mjs';
import { seekForward } from '../lib/sync-session.mjs';
async function probeFixture({ youtube = false, iframe = false } = {}) {
  let init, args;
  const page = new EventEmitter();
  const context = { addInitScript: async (fn, data) => { init = fn; args = data; }, newPage: async () => page };
  const result = { errors: [], blocked_external_requests: 0 };
  const state = await tab({ newContext: async () => context }, { nickname: 'probe' }, result, [], 'muted-allowed', false,
    { youtube, syncProbe: true });
  const timers = [], listeners = {};
  class NativeWebSocket extends EventTarget {
    static OPEN = 1;
    constructor(...values) { super(); this.values = values; }
    close() { this.dispatchEvent(new Event('close')); }
  }
  const window = { WebSocket: NativeWebSocket, location: { hostname: 'www.youtube.com', pathname: '/embed/aqz-KE-bpKQ', href: 'https://www.youtube.com/embed/aqz-KE-bpKQ' } };
  window.top = iframe ? {} : window;
  const video = { tagName: 'VIDEO', currentTime: 42, paused: false, src: 'http://127.0.0.1/tone.webm?song=a', muted: false,
    currentSrc: 'http://127.0.0.1/tone.webm?song=b', volume: 1, readyState: 4, matches: () => true };
  const document = { addEventListener: (type, fn) => { listeners[type] = fn; },
    querySelector: selector => ['video', 'audio,video'].includes(selector) ? video : null, querySelectorAll: () => [] };
  const sandbox = { window, document, navigator: { userActivation: { hasBeenActive: false } }, sessionStorage: { setItem() {} },
    setInterval: (fn, delay) => timers.push({ fn, delay }), console: { debug: (...values) => {
      page.emit('console', { text: () => values.join(' '), type: () => 'debug' });
    } } };
  const vmContext = vm.createContext(sandbox);
  vm.runInContext(`(${init.toString()})(${JSON.stringify(args)})`, vmContext);
  page.evaluate = async fn => vm.runInContext(`(${fn.toString()})()`, vmContext);
  return { state, window, video, listeners, timers, result };
}
test('socket fault injection redirects only blocked constructions and restore keeps native URLs/protocols', async () => {
  const f = await probeFixture();
  const first = new f.window.WebSocket('ws://127.0.0.1:18000/ws/room', ['protocol']);
  first.dispatchEvent(new Event('open'));
  assert.equal(f.window.__wsLast, first);
  assert.ok(f.state.probeWsLog[0].record.open_at);
  await dropSocket(f.state);
  assert.equal(f.window.__wsBlocked, true);
  const failed = new f.window.WebSocket('ws://127.0.0.1:18000/ws/room', ['protocol']);
  assert.equal(failed.values[0], 'ws://127.0.0.1:1/');
  assert.equal(failed.values[1][0], 'protocol');
  assert.equal(f.window.__wsLast, failed);
  await restoreSocket(f.state);
  const restored = new f.window.WebSocket('ws://127.0.0.1:18000/ws/room');
  assert.equal(restored.values[0], 'ws://127.0.0.1:18000/ws/room');
  assert.equal(f.state.probeWsLog.length, 3);
  assert.deepEqual(f.result.errors, []);
});
test('local probe adds actual src and seeked events; YouTube keeps iframe fields and counts seeks', async () => {
  const local = await probeFixture();
  local.listeners.seeked({ target: local.video });
  local.timers.find(t => t.delay === 100).fn();
  assert.equal(local.state.seeked.length, 1);
  assert.equal(local.state.probeSamples[0].src, local.video.currentSrc);
  assert.equal(local.state.probeSamples[0].seeked_count, 1);
  assert.equal(local.state.probeSamples[0].ct, 42);
  const iframe = await probeFixture({ youtube: true, iframe: true });
  iframe.listeners.seeked({ target: iframe.video });
  iframe.timers[0].fn();
  const sample = iframe.state.ytSamples[0];
  assert.equal(sample.ct, 42);
  assert.equal(sample.seeked_count, 1);
  assert.equal(sample.media_url, iframe.window.location.href);
  assert.equal(sample.ad, false);
  assert.equal(sample.buffering, false);
  assert.equal(iframe.state.seeked.length, 1);
});
test('range seek bypasses the React value tracker, emits bubbling input/change, and confirms actual position', async () => {
  const events = [], target = { disabled: false };
  let tracked = 0;
  class HTMLInputElement {
    set value(value) { this.nativeValue = value; }
  }
  Object.defineProperty(target, 'value', { set() { tracked++; } });
  const state = { probeSamples: [{ t: 1, ct: 20 }], youtube: false, page: { locator: selector => ({
    evaluate: async (fn, fraction) => {
      if (selector === 'video') return 600;
      target.dispatchEvent = event => {
        events.push({ type: event.type, bubbles: event.bubbles });
        state.probeSamples.push({ t: Date.now(), ct: Number(target.nativeValue) * 600 });
      };
      return vm.runInNewContext(`(${fn.toString()})(target, fraction)`, { target, fraction, HTMLInputElement, Event });
    },
  }) } };
  const action = await seekForward(state);
  assert.equal(tracked, 0);
  assert.equal(action.target, 80);
  assert.equal(action.observed.ct, 80);
  assert.deepEqual(events, [{ type: 'input', bubbles: true }, { type: 'change', bubbles: true }]);
});
test('multi-song seed uses a transaction and explicit one-second creation order without touching the legacy seed', async () => {
  const source = await readFile(new URL('../lib/database.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('export async function orderedSeed');
  const end = source.indexOf('export async function seed(', start);
  const calls = [];
  const orderedSeed = vm.runInNewContext(`(${source.slice(start, end).replace('export ', '')})`, {
    seed: async (_database, options) => { assert.equal(options.queue, false); return { room: { id: 1, host_id: 2 } }; },
    DB: {}, Date,
    pg: { Client: class {
      async connect() {} async end() { calls.push(['end']); }
      async query(sql, params) { calls.push([sql, params]); return { rows: [{ id: calls.length }] }; }
    } },
  });
  const result = await orderedSeed('loadtest_fixture', syncSongs('song_change', 'local-next'));
  const inserts = calls.filter(([sql]) => /INSERT/.test(sql));
  assert.equal(inserts.length, 2);
  assert.equal(inserts[1][1][6] - inserts[0][1][6], 1000);
  assert.notEqual(inserts[0][1][4], inserts[1][1][4]);
  assert.equal(calls[0][0], 'BEGIN');
  assert.equal(calls.at(-2)[0], 'COMMIT');
  assert.equal(calls.at(-1)[0], 'end');
  assert.equal(result.queue.length, 2);
});
