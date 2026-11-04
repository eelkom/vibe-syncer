import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { firstPlayback, rollingPeak, peakPerSecond, reconnectRollingPeaks } from '../lib/stats.mjs';
import { stopProcess } from '../lib/server.mjs';
import { deadline } from '../lib/common.mjs';
import { summarizeRuns, markdown } from '../summarize.mjs';
import { addRollingMetrics, isBotCondition } from '../recompute_reconnect.mjs';

const media = (t, ct) => ({ t, ct, paused: false, muted: false, volume: 1 });
test('forward seek resets playback origin until a subsequent 0.2s advancement', () => {
  const seek = [media(0, 1), media(100, 10)];
  assert.equal(firstPlayback(seek, 0), null);
  assert.equal(firstPlayback([...seek, media(350, 10.25)], 0), 350);
  assert.equal(firstPlayback([...seek, media(350, 10.25)], 0, true), 350);
  assert.equal(firstPlayback([media(0, 5), media(100, 5.125), media(200, 4), media(450, 4.25)], 0), 450);
});
test('seek threshold scales with the actual time between consecutive samples, including gaps', () => {
  assert.equal(firstPlayback([media(0, 0), media(2000, 4)], 0), 2000);
  assert.equal(firstPlayback([media(0, 0), media(2000, 4.25)], 0), null);
  assert.equal(firstPlayback([media(0, 0), media(2000, 4.25), media(2250, 4.5)], 0), 2250);
});
test('rolling peaks cross fixed-bin boundaries, use strict window width, and do not mutate input', () => {
  const times = [1001, 999, 1000], original = [...times];
  assert.equal(peakPerSecond(times, 0), 2);
  assert.equal(rollingPeak(times), 3);
  assert.deepEqual(times, original);
  assert.equal(rollingPeak([0, 1000]), 1);
  assert.equal(rollingPeak([0, 0, 999, 1000]), 3);
  assert.equal(rollingPeak([0, 499, 500, 501], 500), 3);
  assert.equal(rollingPeak([]), 0);
});
const bots = [
  { attempts: [-1, 999, 1000], opens: [4500, 5000] },
  { attempts: [1001, 1999], opens: [4999, 5999, 6000] },
];
test('recompute adds exactly the two rolling fields using the scenario helper and preserves every other field', () => {
  const original = { scenario: 'reconnect', condition: 'full-jitter-200-pool', ok: true,
    browser_artifacts: [{ legacy: 'must remain' }], metrics: { gave_up: 2, peak_attempts_per_s: 2,
      raw: { bots, outage_at: 1000, listen_at: 5000, note: 'keep' } } };
  const before = structuredClone(original);
  const peaks = reconnectRollingPeaks(bots, 1000, 5000);
  assert.deepEqual(peaks, { peak_attempts_rolling_1s: 3, peak_opens_rolling_1s: 2 });
  const updated = addRollingMetrics(original);
  assert.deepEqual(updated, { ...before, metrics: { ...before.metrics, ...peaks } });
  assert.deepEqual(original, before);
  assert.deepEqual(addRollingMetrics(updated), updated);
  for (const condition of ['exponential-14', 'full-jitter-14', 'exponential-200-pool', 'full-jitter-200-pool']) assert.ok(isBotCondition(condition));
  for (const legacy of ['exponential', 'full-jitter', 'browser-10']) assert.equal(isBotCondition(legacy), false);
  assert.throws(() => addRollingMetrics({ metrics: { raw: { bots } } }), /outage_at/);
  assert.throws(() => reconnectRollingPeaks([{}], 1000, 5000), /attempts and opens/);
});
test('ineffective injection is excluded along with overlapping host/activation invalidity without changing originals', () => {
  const runs = [
    { audible_ms: 0, injection_effective: false },
    { audible_ms: 1000, injection_effective: false, host_unexpected_pauses: 1, activation_before_first_click: true },
    { audible_ms: 20, injection_effective: true }, { audible_ms: 40, injection_effective: null },
  ].map(metrics => ({ scenario: 'autoplay', commit: 'abc', condition: 'silent-blocked', ok: true, metrics }));
  const original = structuredClone(runs), group = summarizeRuns(runs)[0];
  assert.equal(group.injection_ineffective, 2);
  assert.equal(group.host_pause_invalid, 1);
  assert.equal(group.activation_invalid, 1);
  assert.deepEqual(group.metrics.audible_ms, { median: 30, p75: 40, p95: 40, valid: 2, missing: 0 });
  assert.deepEqual(runs, original);
  assert.match(markdown([group]), /injection_effective = false/);
  assert.match(markdown([group]), /silent-blocked/);
});
async function childProcess(ignoreTerm) {
  const child = spawn(process.execPath, ['-e', `${ignoreTerm ? "process.on('SIGTERM', () => {});" : ''}
    process.stdout.write('ready'); setInterval(() => {}, 1000);`], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  try { await deadline(once(child.stdout, 'data'), 3000, 'test child readiness'); }
  catch (error) { child.kill('SIGKILL'); await exited; throw error; }
  return { child, exited };
}
test('server stop confirms graceful process exit and returns forced false', async () => {
  const { child, exited } = await childProcess(false);
  try {
    assert.deepEqual(await stopProcess(child, exited), { forced: false });
    assert.equal(child.signalCode, 'SIGTERM');
    assert.deepEqual(await stopProcess(child, exited), { forced: false });
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } }
});
test('server stop force-kills a real child that ignores SIGTERM after the fixed 10s grace', async () => {
  const { child, exited } = await childProcess(true);
  const start = Date.now();
  try {
    assert.deepEqual(await stopProcess(child, exited), { forced: true });
    assert.ok(Date.now() - start >= 10000);
    assert.equal(child.signalCode, 'SIGKILL');
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } }
});
