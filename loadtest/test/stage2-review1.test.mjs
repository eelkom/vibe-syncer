import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { makePage, readPage } from '../stage2/browser.mjs';
import { installCollector } from '../stage2/collector.mjs';
import { hostAction, inputQueue } from '../stage2/scenarios.mjs';
import { metrics } from '../stage2/metrics.mjs';
import { verdict } from '../stage2/stats.mjs';
import { serverSummary } from '../stage2/monitor.mjs';
import { summarizeStage2, renderStage2 } from '../summarize_stage2.mjs';

test('web-vitals init explicitly exports its IIFE local onto window', async () => {
  const scripts = [], page = new EventEmitter();
  page.addInitScript = async script => { scripts.push(script); };
  const context = { newPage: async () => page };
  await makePage({ newContext: async () => context }, null, { errors: [] }, []);
  assert.match(scripts[0].content, /;window\.webVitals=webVitals;$/);
  const window = {};
  // Like addInitScript, execute in a function scope, not the VM global scope.
  vm.runInNewContext(`(function(){${scripts[0].content}\n})()`, { window });
  assert.equal(typeof window.webVitals.onINP, 'function');
});

test('collector registers INP and timestamps successful socket sends only', () => {
  let now = 500, ready;
  class Native extends EventTarget {
    static OPEN = 1;
    readyState = Native.OPEN;
    send() { if (this.fail) throw new Error('socket closed'); return 'sent'; }
  }
  const window = { WebSocket: Native, webVitals: { onINP(cb, opts) {
    assert.equal(opts.reportAllChanges, true); cb({ value: 120 });
  } } };
  const document = { addEventListener(type, cb) { if (type === 'DOMContentLoaded') ready = cb; } };
  vm.runInNewContext(`(${installCollector.toString()})({profiling:false})`, {
    window, document, Date: { now: () => now }, setInterval() {}, requestAnimationFrame() {},
    PerformanceObserver: class { observe() {} }, console: { debug() {} },
  });
  ready(); assert.equal(window.__stage2.vitals_ready, true);
  assert.deepEqual(JSON.parse(JSON.stringify(window.__stage2.inp)), [[500,120]]);
  const socket = new window.WebSocket(); now = 700;
  assert.equal(socket.send('{"type":"chat","message":"c-g-1-100"}'), 'sent');
  socket.fail = true; now = 800;
  assert.throws(() => socket.send('{"message":"c-g-2-100"}'), /socket closed/);
  socket.fail = false; socket.readyState = 2;
  assert.equal(socket.send('{"message":"c-g-3-100"}'), 'sent');
  assert.deepEqual(JSON.parse(JSON.stringify(window.__stage2.sent)), [['c-g-1-100',700]]);
});

test('missing host sync is a service timeout, while missing controls remain a tool error', async t => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const sent = []; sent.some = () => { now += 5000; return false; };
  const ctx = { actions: [], host: { sent, controls: { play: { x: 1, y: 2 } }, page: { mouse: { click: async () => {} } } } };
  await hostAction(ctx, 'pause'); assert.equal(ctx.host_action_timeouts, 1); assert.deepEqual(ctx.actions, []);
  assert.equal(ctx.host_action_failures[0].action, 'pause');
  ctx.host.controls = {};
  await assert.rejects(hostAction(ctx, 'play'), /controls|button unavailable/);
});

test('input deadline records the pending attempt and stops queued inputs without rejecting', async () => {
  let release, calls = 0;
  const ctx = { inputs: [], guest: { controls: { input: { x: 1, y: 2 } }, page: {
    mouse: { click: () => { calls++; return new Promise(resolve => { release = resolve; }); } },
    keyboard: { type: async () => {}, press: async () => {} },
  } } };
  const queue = inputQueue(ctx); queue.enqueue(); queue.enqueue();
  assert.equal(await queue.finish(5), false); assert.equal(ctx.input_stuck, true);
  assert.equal(ctx.inputs.length, 1); assert.equal(ctx.inputs[0].end, null);
  release(); await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1);
});

test('input errors unrelated to the completion deadline stay script errors', async () => {
  const ctx = { inputs: [], guest: { controls: {} } };
  const queue = inputQueue(ctx); queue.enqueue();
  await assert.rejects(queue.finish(), /coordinates unavailable/); assert.notEqual(ctx.input_stuck, true);
});

const pageState = () => ({ page: {
  evaluate: () => new Promise(() => {}), isClosed: () => false,
  context: () => ({ browser: () => ({ isConnected: () => true }) }),
} });
test('only an unanswered evaluation on an open live page becomes page_unresponsive', async () => {
  const state = pageState(); assert.equal(await readPage(state, 5), null); assert.equal(state.unresponsive, true);
  for (const change of [s => { s.crashed = true; }, s => { s.page.isClosed = () => true; },
    s => { s.page.context = () => ({ browser: () => ({ isConnected: () => false }) }); }]) {
    const unknown = pageState(); change(unknown);
    await assert.rejects(readPage(unknown, 5), /closed\/crashed/); assert.notEqual(unknown.unresponsive, true);
  }
  const unknown = pageState(); unknown.page.evaluate = async () => { throw new TypeError('collector missing'); };
  await assert.rejects(readPage(unknown, 5), TypeError); assert.notEqual(unknown.unresponsive, true);
});

for (const [field, value, reason] of [['host_action_timeouts',1,'HOST_SYNC_TIMEOUT'], ['input_stuck',true,'PAGE_STUCK'], ['page_unresponsive',true,'PAGE_STUCK']]) {
  test(`service failure ${field} preserves ok and fails with ${reason}`, () => {
    const run = { ok: true, metrics: { [field]: value } };
    assert.deepEqual(verdict(run).reasons, [reason]); assert.equal(run.ok, true);
  });
}

const observation = () => ({ samples: [], memory: [], longtasks: [], raf: {}, raf_events: [], commits: [], inp: [], inputs: [],
  sync: [], seeks: [], sent: [], ws: [], checkpoints: [], system_events: [], welcome_events: [], candidates: [], displayed: [] });
function fixture() {
  const ctx = { start: 0, end: 1000, job: { scenario: 'steady', n: 3, profiling: false }, actions: [], inputs: [
    { marker: 'c-g-1-50', start: 50, end: 350 }, { marker: 'c-g-2-60', start: 60, end: 360 },
  ], host: {}, guest: {} };
  const bots = { sent: [[0,1,100,true],[0,2,100,false]], control: [['c-b0-1-100',1],['c-g-1-50',1]],
    bots: [{ join_ms: 0, closes: [[250,1006]] }], gave_up: 0, event_loop: { max_ms: 20, p95_ms: 20 } };
  const guest = observation(); guest.sent = [['c-g-1-50',300]];
  guest.displayed = [['c-b0-1-100',150,1],['c-g-1-50',400,1]];
  return { ctx, bots, guest };
}
test('metrics excludes bot/guest unsent attempts and starts guest delivery at socket.send', () => {
  const { ctx, bots, guest } = fixture(); const m = metrics(ctx, observation(), guest, bots);
  assert.equal(m.sent, 2); assert.equal(m.bot_unsent, 1); assert.equal(m.guest_unsent, 1);
  assert.equal(m.lost, 0); assert.equal(m.server_side_lost, 0); assert.equal(m.duplicates, 0);
  assert.deepEqual(m.delivery_values_ms, [50,100]);
  assert.equal(m.delivery_ms.p95, 100); assert.deepEqual(m.raw.guest_sent, [['c-g-1-50',300]]);
  assert.ok(verdict({ ok: true, metrics: m }).reasons.includes('DISCONNECTED'));
  guest.displayed = []; const lost = metrics(ctx, observation(), guest, bots);
  assert.equal(lost.lost, 2); assert.equal(lost.bot_unsent, 1); assert.equal(lost.guest_unsent, 1);
});
test('unresponsive observer preserves bot metrics and available host samples, leaving unknowns null', () => {
  const { ctx, bots } = fixture(); ctx.guest.unresponsive = true; ctx.input_stuck = true; ctx.host_action_timeouts = 2;
  const host = observation(); host.samples = [{ t: 1, ct: 2, paused: false, muted: false, volume: 1 }];
  const m = metrics(ctx, host, null, bots);
  assert.equal(m.page_unresponsive, true); assert.equal(m.bot_disconnects, 1); assert.equal(m.host_action_timeouts, 2);
  for (const key of ['lost','duplicates','guest_unsent','guest_disconnects','input_count','inp_ms','heap_max','sent']) assert.equal(m[key], null, key);
  assert.equal(m.delivery_ms.p95, null); assert.equal(m.raw.host_samples.length, 1); assert.equal(m.raw.guest_samples, null);
  assert.deepEqual(verdict({ ok: true, metrics: m }).reasons, ['HOST_SYNC_TIMEOUT','PAGE_STUCK','DISCONNECTED']);
});

test('server summary filters observation buckets/samples and keeps run-wide log/kill counts', () => {
  const row = (t, n) => ({ t, event_loop: { max_ms: n+1, p95_ms_approx: n+2 }, broadcast: { p95_ms_approx: n+3, sum_ms: n },
    connections_max: n+4, pool: { checked_out: n+5 } });
  const server = { instrument: [row(1000,999),row(2000,4),row(3000,6),row(5000,999)],
    samples: [[1000,999,9999],[2500,10,1000],[3500,30,2000],[4500,999,9999]], queuepool_errors: 2 };
  const summary = serverSummary(server, 2000, 4000, 1);
  assert.deepEqual(summary, { event_loop_max_ms:7,event_loop_p95_ms_approx_max:8,broadcast_p95_ms_approx_max:9,
    broadcast_sum_ms:10,connections_max:10,pool_checked_out_max:11,cpu_peak:30,rss_peak_bytes:2000,queuepool_errors:2,server_forced_kills:1 });
  const missing = serverSummary(undefined, undefined, undefined, 0);
  assert.equal(missing.event_loop_max_ms, null); assert.equal(missing.broadcast_sum_ms, null); assert.equal(missing.cpu_peak, null);
  const run = { scenario:'steady',condition:'default',n:10,ok:true,server_summary:summary,connected_at_setup:8,
    metrics:{bot_disconnects:1,host_disconnects:2,guest_disconnects:3,bot_gave_up:4,bot_join_failed:5,host_action_timeouts:6,bot_unsent:7} };
  const second = { ...run, server_summary:{...summary,cpu_peak:50} };
  const groups = summarizeStage2([run,second]);
  assert.deepEqual(groups[0].metrics['server_summary.cpu_peak'], {median:40,max:50,missing:0});
  assert.equal(groups[0].metrics.connected_at_setup.max, 8); assert.equal(groups[0].metrics.bot_unsent.median, 7);
  const table = renderStage2(groups);
  for (const field of Object.keys(summary)) assert.match(table, new RegExp(`server_summary\\.${field}`));
  for (const field of Object.keys(run.metrics)) assert.ok(table.includes(`| ${field} |`), field);
});
