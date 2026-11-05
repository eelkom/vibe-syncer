import test from 'node:test';
import assert from 'node:assert/strict';
import { seekCoordinates, hostAction } from '../stage2/scenarios.mjs';
import { maxSampleGap, sampleGapMetrics, machineStatus, verdict, shouldStopBatch } from '../stage2/stats.mjs';
import { options, shouldRun, skipAfterFailures } from '../stage2/config.mjs';
import { metrics } from '../stage2/metrics.mjs';
import { summarizeStage2, renderStage2 } from '../summarize_stage2.mjs';
import { parsePowerSource, readPowerSource, capturePower, warnBattery } from '../stage2/power.mjs';

test('120s seek clears the 16px thumb on the 229px / 600s fixture, reversing near the end', () => {
  const box = { left: 100, width: 229, y: 20 };
  for (const ct of [0,120,300,479.5,480,480.01,599.99,600]) {
    const point = seekCoordinates(box, ct, 600);
    const thumb = box.left + 8 + ct / 600 * (box.width - 16);
    assert.ok(Math.abs(point.x - thumb) > 16);
    assert.ok(point.x >= box.left + 8 && point.x <= box.left + box.width - 8);
    assert.equal(point.target, ct + 120 > 600 ? ct - 120 : ct + 120);
    assert.equal(point.y, box.y);
  }
  assert.throws(() => seekCoordinates({ ...box, width: 20 }, 100, 600), /thumb/);
  assert.throws(() => seekCoordinates(box, 30, 60), /thumb/);
});
test('host seek uses the helper coordinates and retains the actual sync timestamp', async t => {
  t.mock.method(Date, 'now', () => 1000);
  const box = { left: 100, width: 229, y: 20 }, clicks = [];
  const state = { controls: { seek: box }, media: { ct: 500, duration: 600, paused: false }, media_at: 1000, sent: [], page: { mouse: {
    async click(x, y) { clicks.push([x,y]); state.sent.push({ t: 1000, data: { action: 'seek', timestamp: 380.5 } }); },
  } } };
  const ctx = { host: state, actions: [] }; await hostAction(ctx, 'seek');
  const point = seekCoordinates(box, 500, 600);
  assert.deepEqual(clicks, [[point.x,point.y]]);
  assert.equal(ctx.actions[0].timestamp, 380.5);
});
test('sample gaps include pre-observation absent-media rows, never cross between pages', () => {
  assert.equal(maxSampleGap([{ t: 0, none: true },{ t: 6001, ct: 1 },{ t: 6101 }], [[5],[105]]), 6001);
  assert.equal(maxSampleGap([[0]], [[1000000]]), null);
  assert.equal(maxSampleGap([], null), null);
  assert.equal(maxSampleGap([[0],[100],[100]]), 100);
});
const round = metrics => ({ scenario: 'chat_burst', condition: 'default', n: 2, ok: true, metrics });
test('sample gaps remain diagnostic and only the stored OS flag decides a stall', () => {
  const boundary = round({ raw: { host_samples: [[0],[5000]] } });
  assert.equal(machineStatus(boundary).machine_stalled, false);
  const old = round({ max_sample_gap_ms: 100, raw: { host_samples: [[0],[100]], guest_samples: [[1],[37001]] } });
  assert.deepEqual(sampleGapMetrics(old), { max_gap_host_ms: 100, max_gap_guest_ms: 37000, max_sample_gap_ms: 37000 });
  assert.equal(machineStatus(old).machine_stalled, false);
  assert.equal(machineStatus(round({ machine_stalled: true, max_sample_gap_ms: 100 })).machine_stalled, true);
  assert.equal(sampleGapMetrics(round({})).max_sample_gap_ms, null);
});
test('script-failed stalled rounds are only INVALID, retain errors and do not stop the batch', () => {
  const run = { ...round({ machine_stalled: true, lost: 10, host_action_timeouts: 2, raw: { guest_samples: [[0],[1010000]] } }),
    ok: false, errors: ['original failure'], server: { queuepool_errors: 100 } };
  const before = JSON.stringify(run), decision = verdict(run);
  assert.equal(decision.status, 'INVALID'); assert.equal(decision.pass, null);
  assert.deepEqual(decision.reasons, ['INVALID_MACHINE_STALL']); assert.deepEqual(decision.external, {});
  assert.equal(shouldStopBatch(run), false); assert.equal(JSON.stringify(run), before);
  assert.equal(shouldStopBatch({ ...round({}), ok: false }), true);
  assert.equal(shouldStopBatch(round({ lost: 1 })), false);
});
test('normal metrics calculate the full-page gap even before the measurement window', () => {
  const page = () => ({ samples: [{t:0,none:true},{t:6001,none:true},{t:10000,none:true}], memory: [], longtasks: [],
    raf: {}, commits: [], inp: [], inputs: [], sync: [], seeks: [], sent: [], ws: [], system_events: [], welcome_events: [], displayed: [] });
  const ctx = { start: 10000, end: 11000, job: { scenario: 'steady', n: 2 }, actions: [], inputs: [] };
  const bots = { sent: [], control: [], bots: [], gave_up: 0, event_loop: {} };
  const m = metrics(ctx, page(), page(), bots);
  assert.equal(m.max_sample_gap_ms, 6001); assert.equal(m.max_gap_host_ms, 6001); assert.equal(m.max_gap_guest_ms, 6001);
  assert.equal(machineStatus({ metrics: m }).machine_stalled, false);
});
test('summary excludes invalid values and failures, counts them, and leaves all-invalid N neutral', () => {
  const valid = round({ inp_ms: 100, delivery_ms: { p95: 500 } });
  const invalid = { ...round({ machine_stalled: true, inp_ms: 9999, lost: 99, raw: { guest_samples: [[0],[6000]] } }), ok: false };
  const before = JSON.stringify([valid,invalid]);
  const group = summarizeStage2([valid,invalid])[0];
  assert.equal(group.status, 'PASS'); assert.equal(group.rounds, 2); assert.equal(group.invalid_machine_stall, 1);
  assert.deepEqual(group.reasons, []); assert.equal(group.thresholds.inp_over_200, false);
  assert.deepEqual(group.metrics.inp_ms, { median: 100, max: 100, missing: 0 });
  const all = summarizeStage2([invalid,invalid])[0];
  assert.equal(all.status, 'INVALID'); assert.equal(all.invalid_machine_stall, 2);
  assert.deepEqual(all.reasons, ['INVALID_MACHINE_STALL']); assert.equal(all.metrics.inp_ms.median, null); assert.equal(all.metrics.inp_ms.missing, 0);
  const failed = summarizeStage2([{ ...valid, metrics: { lost: 1 } },invalid])[0];
  assert.equal(failed.status, 'FAIL'); assert.deepEqual(failed.reasons, ['LOST']);
  assert.match(renderStage2([group,all]), /머신 정지 무효 회차/);
  assert.equal(JSON.stringify([valid,invalid]), before);
});
test('rerun-invalid selects only existing stalled rounds; force still selects the whole scenario', () => {
  const rerun = options(['--rerun-invalid','--scenario','chat_burst']);
  const legacy = round({ raw: { host_samples: [[0],[6000]] } });
  assert.equal(rerun.rerunInvalid, true); assert.equal(rerun.scenario, 'chat_burst');
  assert.equal(shouldRun(legacy, rerun), false);
  assert.equal(shouldRun(round({ machine_stalled: true }), rerun), true);
  assert.equal(shouldRun(round({}), rerun), false);
  assert.equal(shouldRun({ ...round({}), ok: false }, rerun), false);
  assert.equal(shouldRun(undefined, rerun), false);
  assert.equal(shouldRun(legacy, options([])), false); assert.equal(shouldRun(undefined, options([])), true);
  const force = options(['--scenario','steady','--force']);
  assert.equal(shouldRun(round({}), force), true); assert.equal(shouldRun(undefined, force), true);
  assert.equal(shouldRun(round({}), options(['--force','--rerun-invalid'])), true);
});
test('invalid setup failures cannot trigger the larger-pool-N skip rule', () => {
  const job = { scenario: 'steady', condition: 'pool-250', n: 50 };
  const bad = { ...job, n: 25, ok: true, setup_failed: true, metrics: { machine_stalled: true, raw: { host_samples: [[0],[6000]] } } };
  assert.equal(skipAfterFailures(job, [bad,bad,bad], 3), false);
});
test('power source parses the first pmset line only and records start/end without guessing', () => {
  assert.equal(parsePowerSource("Now drawing from 'AC Power'\n Battery Power"), 'AC Power');
  assert.equal(parsePowerSource("Now drawing from 'Battery Power'\r\n99%; discharging"), 'Battery Power');
  assert.equal(parsePowerSource("bad header\nNow drawing from 'AC Power'"), null);
  const power = readPowerSource((cmd,args,opts) => {
    assert.equal(cmd, 'pmset'); assert.deepEqual(args, ['-g','batt']); assert.equal(opts.encoding, 'utf8');
    return "Now drawing from 'AC Power'\n";
  });
  assert.deepEqual(power, { source: 'AC Power', error: null });
  assert.equal(readPowerSource(() => { throw new Error('pmset unavailable'); }).source, null);
  assert.equal(readPowerSource(() => 'unknown').error, 'Unrecognized pmset -g batt first line');
  const record = {}; capturePower(record, 'start', () => power);
  capturePower(record, 'end', () => ({ source: 'Battery Power', error: null }));
  assert.deepEqual(record.power_source, { start: 'AC Power', end: 'Battery Power' });
  assert.deepEqual(record.power_source_errors, { start: null, end: null });
  const warnings = []; warnBattery('Battery Power', line => warnings.push(line)); warnBattery('AC Power', line => warnings.push(line));
  assert.equal(warnings.length, 1); assert.match(warnings[0], /Battery Power/);
});
