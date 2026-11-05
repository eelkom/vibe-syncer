import test from 'node:test';
import assert from 'node:assert/strict';
import { median, percentile, interpolate, positionErrors, syncTime, peakPerSecond, countMarkers, firstPlayback, stddev, countUnexpectedPauses, activationBeforeFirstClick, reconcileClicks, browserReconnectState } from '../lib/stats.mjs';
import { MAX_ATTEMPTS, reconnectDelay } from '../lib/reconnect-policy.mjs';
import { summarizeRuns, markdown } from '../summarize.mjs';
import { parseArgs, plan } from '../lib/config.mjs';
const sample = (t, ct, paused = false) => ({ t, ct, paused, muted: false, volume: 1 });
test('nearest-rank p95 uses ceil, handles empty and one value', () => {
  assert.equal(percentile(Array.from({ length: 20 }, (_, i) => i + 1)), 19);
  assert.equal(percentile([1, 2, 3, 4, 5]), 5);
  assert.equal(percentile([4]), 4); assert.equal(percentile([]), null);
});
test('nearest-rank p75 and five-run p95 match the reported table', () => {
  assert.equal(percentile([5, 1, 4, 2, 3], 0.75), 4);
  assert.equal(percentile(Array.from({ length: 20 }, (_, i) => i + 1), 0.75), 15);
  assert.equal(percentile([], 0.75), null);
  const runs = [5, 1, 4, 2, 3].map(v => ({ scenario: 'late_join', commit: 'abc', condition: 'default', ok: true,
    metrics: { err_p75_ms: v } }));
  const group = summarizeRuns(runs)[0];
  assert.deepEqual(group.metrics.err_p75_ms, { median: 3, p75: 4, p95: 5, valid: 5, missing: 0 });
  assert.match(markdown([group]), /회차 p75 \| 회차 p95/);
  assert.match(markdown([group]), /err_p75_ms \| 3 \| 4 \| 5 \| 5 \| 0/);
  assert.match(markdown([group]), /회차가 5개면 nearest-rank p95는 최댓값과 같다/);
});
test('median: odd, even, null and zero', () => {
  assert.equal(median([3, 1, 2]), 2); assert.equal(median([4, 2, 1, 3]), 2.5);
  assert.equal(median([null, 0, 2]), 1); assert.equal(median([null]), null);
});
test('interpolate at guest clock; no extrapolation, paused host excluded', () => {
  const host = [sample(1000, 5), sample(1200, 5.2)];
  assert.equal(interpolate(host, 1100), 5.1);
  assert.equal(interpolate(host, 1000), 5); assert.equal(interpolate(host, 999), null);
  assert.equal(interpolate([host[0], sample(1200, 5.2, true)], 1100), null);
  const result = positionErrors(host, [sample(1100, 5), sample(1150, 5.1, true), { t: 1200, none: true }]);
  assert.ok(Math.abs(result[0].err - 100) < 1e-8);
  assert.equal(result[1].err, null); assert.equal(result[2].err, null);
});
test('sync starts only after full two seconds strictly below 500ms', () => {
  const a = Array.from({ length: 31 }, (_, i) => ({ t: 1000 + i * 100, err: 200 }));
  assert.equal(syncTime(a.slice(0, 20), 1000), null);
  assert.equal(syncTime(a.slice(0, 21), 1000), 0);
  a[5].err = 500; assert.equal(syncTime(a, 1000), 600);
  a[5].err = null; assert.equal(syncTime(a, 1000), 600);
});
test('sync does not bridge sampling gaps or a paused sample', () => {
  assert.equal(syncTime([{ t: 0, err: 0 }, { t: 2000, err: 0 }], 0), null);
  const a = Array.from({ length: 30 }, (_, i) => ({ t: i * 100, err: i === 15 ? null : 0 }));
  assert.equal(syncTime(a, 0), null);
});
test('2000ms sync threshold supplements the unchanged strict 500ms target', () => {
  const errors = Array.from({ length: 31 }, (_, i) => ({ t: 1000 + i * 100, err: 1500 }));
  assert.equal(syncTime(errors, 1000), null);
  assert.equal(syncTime(errors, 1000, 2000, 2000), 0);
  errors[5].err = 2000;
  assert.equal(syncTime(errors, 1000, 2000, 2000), 600);
  assert.equal(syncTime(errors.slice(0, 20), 1000, 2000, 2000), null);
});
test('activation contamination uses pre-click samples, including absent media and no-click runs', () => {
  const samples = [{ t: 0, act: true }, { t: 100, none: true, act: false },
    { t: 200, act: true }, { t: 300, act: true }];
  assert.equal(activationBeforeFirstClick(samples, 100, 300, [{ t: 200 }]), false);
  assert.equal(activationBeforeFirstClick(samples, 100, 300, [{ t: 250 }]), true);
  assert.equal(activationBeforeFirstClick(samples, 100, 300, []), true);
  assert.equal(activationBeforeFirstClick(samples, 100, 200, []), false);
  assert.equal(activationBeforeFirstClick([{ t: 150, none: true, act: true }], 100, 300, []), true);
});
test('click reconciliation requires a distinct trusted record of the intended kind during input', () => {
  const attempts = [
    { kind: 'sync', attempted_at: 100, input_finished_at: 200 },
    { kind: 'sync', attempted_at: 100, input_finished_at: 200 },
    { kind: 'unmute', attempted_at: 300, input_finished_at: 400 },
    { kind: 'unmute', attempted_at: 500, input_finished_at: 600 },
  ];
  const events = [{ kind: 'sync', t: 150 }, { kind: 'sync', t: 350 }, { kind: 'unmute', t: 601 }];
  const original = structuredClone(attempts);
  const checked = reconcileClicks(attempts, events);
  assert.deepEqual(checked.map(c => c.ok), [true, false, false, false]);
  assert.equal(checked[0].t, 150);
  assert.equal(checked[1].t, null);
  assert.deepEqual(attempts, original);
});
test('browser retries use constructor timestamps even when early attempts never open', () => {
  const log = [
    { created_at: 0, open_at: 50, close_at: 1000, code: 1012 },
    { created_at: 2000, open_at: null, close_at: 2100, code: 1006 },
    { created_at: 4000, open_at: null, close_at: 4100, code: 1006 },
    { created_at: 8000, open_at: 8050, close_at: null, code: null },
  ];
  assert.deepEqual(browserReconnectState(log, 1000, 5000, 9000), {
    attempts: [2000, 4000, 8000], reconnected: true, gave_up: false,
  });
});
test('browser gives up after five failed retries and one second after final close', () => {
  const log = Array.from({ length: 5 }, (_, i) => ({ created_at: 1100 + 100 * i,
    open_at: null, close_at: 1150 + 100 * i, code: 1006 }));
  assert.equal(browserReconnectState(log, 1000, 2000, 2549).gave_up, false);
  assert.equal(browserReconnectState(log, 1000, 2000, 2550).gave_up, true);
  assert.equal(browserReconnectState(log.slice(0, 4), 1000, 2000, 5000).gave_up, false);
  log[4].close_at = null;
  assert.equal(browserReconnectState(log, 1000, 2000, 5000).gave_up, false);
});
test('pause counts start at the first playing sample after the final host play click', () => {
  const samples = [sample(0, 1), sample(100, 1, true), sample(200, 1, true),
    sample(300, 1.1), sample(400, 1.1, true), sample(500, 1.1, true),
    sample(600, 1.2), sample(700, 1.2, true)];
  assert.equal(countUnexpectedPauses(samples, 150), 2);
  assert.equal(countUnexpectedPauses(samples.slice(0, 3), 150), 0);
  assert.equal(countUnexpectedPauses(samples), 3);
  assert.equal(countUnexpectedPauses([]), 0);
});
test('guest initial pause and absent media do not create pause transitions', () => {
  const samples = [{ t: 0, none: true }, sample(100, 0, true), sample(200, 0.1),
    sample(300, 0.1, true), { t: 400, none: true }, sample(500, 0, true),
    sample(600, 0.1), { t: 700, none: true }, sample(800, 0.1, true)];
  assert.equal(countUnexpectedPauses(samples), 1);
  assert.equal(countUnexpectedPauses([sample(0, 0, true), sample(100, 0, true)]), 0);
});
test('one-second fixed bins include boundaries and exclude prior events', () => {
  assert.equal(peakPerSecond([999, 1000, 1999, 2000, 2001, 2999], 1000), 3);
  assert.equal(peakPerSecond([], 0), 0);
});
test('source exponential delay and five retry budget', () => {
  assert.equal(MAX_ATTEMPTS, 5);
  assert.deepEqual(Array.from({ length: 5 }, (_, i) => reconnectDelay('exponential', i)), [1000, 2000, 4000, 8000, 16000]);
  assert.equal(reconnectDelay('exponential', 6), 30000);
});
test('full jitter is [0, min(cap, base*2^attempt)), including cap', () => {
  for (let attempt = 0; attempt < 10; attempt++) {
    const cap = Math.min(30000, 1000 * 2 ** attempt);
    assert.equal(reconnectDelay('full-jitter', attempt, () => 0), 0);
    assert.ok(reconnectDelay('full-jitter', attempt, () => 1 - Number.EPSILON) < cap);
    assert.equal(reconnectDelay('full-jitter', attempt, () => 0.5), cap / 2);
  }
});
test('markers are exact tokens and duplicates count only excess occurrences', () => {
  const r = countMarkers('m-1-1\nm-1-10 m-1-1 xm-1-2 m-1-2x', ['m-1-1', 'm-1-2', 'm-1-10']);
  assert.equal(r.unique, 2); assert.equal(r.duplicates, 1); assert.deepEqual(r.missing, ['m-1-2']);
});
test('summarize never converts null/missing failed runs to zero', () => {
  const runs = [10, null, 30, undefined].map((v, i) => ({ scenario: 'late_join', commit: 'abc', condition: 'default', ok: i !== 3,
    metrics: i === 3 ? {} : { sync_time_ms: v } }));
  const g = summarizeRuns(runs)[0];
  assert.deepEqual(g.metrics.sync_time_ms, { median: 20, p75: 30, p95: 30, valid: 2, missing: 2 });
  assert.equal(g.script_failed, 1);
  const allNull = summarizeRuns([{ ...runs[0], metrics: { sync_time_ms: null } }])[0];
  assert.equal(allNull.metrics.sync_time_ms.median, null);
  assert.match(markdown([allNull]), /null \| null \| null \| 0 \| 1/);
});
test('summarize counts explicit ineffective injections and retains null counters', () => {
  const runs = [false, true, null, undefined].map(v => ({ scenario: 'autoplay', commit: 'abc', condition: 'all-blocked', ok: true,
    metrics: { injection_effective: v, blocked_play_calls: v === false ? 0 : null } }));
  const group = summarizeRuns(runs)[0];
  assert.equal(group.injection_ineffective, 1);
  assert.deepEqual(group.metrics.blocked_play_calls, { median: null, p75: null, p95: null, valid: 0, missing: 3 });
  assert.match(markdown([group]), /주입 무효 회차/);
  assert.match(markdown([group]), /autoplay\/abc\/all-blocked \| 4 \| 0 \| 0 \| 1/);
});
test('host pause invalidates numeric aggregates, preserves originals and counts separately from nulls', () => {
  const runs = [
    { sync_time_ms: 0, host_unexpected_pauses: 1 },
    { sync_time_ms: 10, host_unexpected_pauses: 0, guest_unexpected_pauses: 3 },
    { sync_time_ms: 20, host_unexpected_pauses: 0 },
    { sync_time_ms: 1000, host_unexpected_pauses: 2 },
    { sync_time_ms: null, host_unexpected_pauses: 0 },
  ].map(metrics => ({ scenario: 'late_join', commit: 'abc', condition: 'default', ok: true, metrics }));
  const original = structuredClone(runs);
  const group = summarizeRuns(runs)[0];
  assert.equal(group.runs, 5);
  assert.equal(group.host_pause_invalid, 2);
  assert.deepEqual(group.metrics.sync_time_ms, { median: 15, p75: 20, p95: 20, valid: 2, missing: 1 });
  assert.equal(group.metrics.guest_unexpected_pauses.median, 3);
  assert.deepEqual(runs, original);
  assert.match(markdown([group]), /호스트 멈춤 무효 회차/);
  assert.match(markdown([group]), /late_join\/abc\/default \| 5 \| 0 \| 0 \| 0 \| 2/);
});
test('all host-paused autoplay runs yield null aggregates without becoming missing runs', () => {
  const group = summarizeRuns([{ scenario: 'autoplay', commit: 'abc', condition: 'all-blocked', ok: true,
    metrics: { host_unexpected_pauses: 1, audible_ms: 100 } }])[0];
  assert.equal(group.host_pause_invalid, 1);
  assert.deepEqual(group.metrics.audible_ms, { median: null, p75: null, p95: null, valid: 0, missing: 0 });
});
test('activation and host invalidity exclude their union while preserving independent counts', () => {
  const runs = [
    { sync_time_2s_ms: 0, activation_before_first_click: true },
    { sync_time_2s_ms: 1000, activation_before_first_click: true, host_unexpected_pauses: 1 },
    { sync_time_2s_ms: 20, activation_before_first_click: false },
    { sync_time_2s_ms: 40 },
    { sync_time_2s_ms: null, activation_before_first_click: false },
  ].map(metrics => ({ scenario: 'late_join', commit: 'abc', condition: 'default', ok: true, metrics }));
  const original = structuredClone(runs);
  const group = summarizeRuns(runs)[0];
  assert.equal(group.activation_invalid, 2);
  assert.equal(group.host_pause_invalid, 1);
  assert.deepEqual(group.metrics.sync_time_2s_ms, { median: 30, p75: 40, p95: 40, valid: 2, missing: 1 });
  assert.deepEqual(runs, original);
  assert.match(markdown([group]), /활성화 오염 무효 회차/);
  assert.match(markdown([group]), /2000ms는 앱의 재생 시작 시 보정 기준값이고, 500ms는 자체 목표값/);
});
test('playback/audible timestamps require .2s advancement and audible state', () => {
  const a = [sample(0, 5), sample(100, 5.1), sample(300, 5.3)];
  a[0].muted = true;
  assert.equal(firstPlayback(a, 0), 300); assert.equal(firstPlayback(a, 0, true), 300);
  assert.equal(firstPlayback([sample(0, 1, true), sample(100, 5)], 0), null);
  assert.equal(stddev([1, 3]), 1);
});
test('plan uses fixed commits, smoke size and independent browser run default', () => {
  const jobs = plan(parseArgs(['--scenario', 'reconnect']));
  assert.equal(jobs.filter(j => j.condition === 'browser-10').length, 6);
  assert.ok(jobs.filter(j => j.condition !== 'browser-10').every(j => j.serverSha === 'b86324b'));
  assert.equal(plan(parseArgs(['--scenario', 'message_burst', '--smoke'])).length, 2);
  const autoplay = plan(parseArgs(['--scenario', 'autoplay', '--smoke', '--runs', '100']));
  assert.equal(autoplay.length, 9);
  for (const condition of ['muted-allowed', 'all-blocked', 'silent-blocked']) {
    assert.deepEqual(autoplay.filter(job => job.condition === condition).map(job => job.sha), ['ea2acea', 'a086001', 'b86324b']);
    assert.ok(autoplay.filter(job => job.condition === condition).every(job => job.runNumber === 1));
  }
});
