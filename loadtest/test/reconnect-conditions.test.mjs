import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { parseArgs, plan } from '../lib/config.mjs';
import { reconnectDelay } from '../lib/reconnect-policy.mjs';
import { serverArgs } from '../lib/server.mjs';
import { ROOT } from '../lib/common.mjs';
import { summarizeRuns, markdown } from '../summarize.mjs';

const expected = [
  ['exponential-14', '1b2e6c4', 14, null],
  ['full-jitter-14', 'b86324b', 14, null],
  ['exponential-200-pool', '1b2e6c4', 200, 250],
  ['full-jitter-200-pool', 'b86324b', 200, 250],
];
test('four bot conditions fix formula commit, count, main server and optional pool; five runs each', () => {
  const jobs = plan(parseArgs(['--scenario', 'reconnect']));
  for (const [condition, sha, count, pool] of expected) {
    const selected = jobs.filter(job => job.condition === condition);
    assert.equal(selected.length, 5);
    assert.ok(selected.every(job => job.sha === sha && job.serverSha === 'b86324b'
      && job.botCount === count && job.measurementPoolSize === pool));
    assert.deepEqual(selected.map(job => job.runNumber), [1, 2, 3, 4, 5]);
  }
  assert.equal(jobs.filter(job => job.condition === 'browser-10').length, 6);
  for (const legacy of ['exponential', 'full-jitter']) {
    assert.throws(() => plan(parseArgs(['--scenario', 'reconnect', '--condition', legacy])), /No matching/);
  }
});
test('smoke keeps ten bots and the same fixed pool override only on pool conditions', () => {
  const jobs = plan(parseArgs(['--scenario', 'reconnect', '--smoke', '--runs', '99']));
  for (const [condition, , , pool] of expected) {
    const selected = jobs.filter(job => job.condition === condition);
    assert.equal(selected.length, 1);
    assert.equal(selected[0].botCount, 10);
    assert.equal(selected[0].measurementPoolSize, pool);
  }
  for (const job of plan(parseArgs([]))) {
    assert.equal(job.measurementPoolSize ?? null, job.condition.endsWith('-200-pool') ? 250 : null);
  }
});
test('delay formula selection follows the condition prefix for both sizes', () => {
  for (const [condition] of expected) for (let attempt = 0; attempt < 7; attempt++) {
    const cap = Math.min(30000, 1000 * 2 ** attempt);
    assert.equal(reconnectDelay(condition, attempt, () => 0.5), condition.startsWith('exponential') ? cap : cap / 2);
  }
  assert.throws(() => reconnectDelay('unknown-14', 0), /Unknown reconnect policy/);
});
test('server arguments omit pool by default and add only the requested measurement override', () => {
  const base = serverArgs('b86324b', 'loadtest_test');
  assert.deepEqual(base, [path.join(ROOT, 'server/run_server.py'), path.join(ROOT, '.baselines/b86324b/backend'),
    '18000', '--database-url', 'postgresql://vibe@127.0.0.1:55432/loadtest_test']);
  assert.deepEqual(serverArgs('b86324b', 'loadtest_test', null), base);
  assert.deepEqual(serverArgs('b86324b', 'loadtest_test', 250), [...base, '--measurement-pool-size', '250']);
  for (const invalid of [0, -1, 301, 1.5]) assert.throws(() => serverArgs('b86324b', 'loadtest_test', invalid), /integer in/);
});
test('Python pool hook leaves default engine untouched and forces measurement pool and zero overflow', () => {
  const source = `
import importlib.util, io, logging, sys, types
spec = importlib.util.spec_from_file_location('stage1_runner', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
def original(*args, **kwargs):
    return args, kwargs
fake = types.SimpleNamespace(create_engine=original)
sys.modules['sqlalchemy'] = fake
logs = io.StringIO()
logging.basicConfig(level=logging.INFO, stream=logs, force=True)
module.configure_measurement_pool(None)
assert fake.create_engine is original
module.configure_measurement_pool(250)
args, kwargs = fake.create_engine('postgresql://local', pool_size=5, max_overflow=10, echo=False)
assert args == ('postgresql://local',)
assert kwargs == dict(pool_size=250, max_overflow=0, echo=False)
assert 'application defaults (no override)' in logs.getvalue()
assert 'pool_size=250 max_overflow=0' in logs.getvalue()
print('pool branches OK')
`;
  const checked = spawnSync('python3', ['-c', source, path.join(ROOT, 'server/run_server.py')], { encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, /pool branches OK/);
  const invalid = spawnSync('python3', [path.join(ROOT, 'server/run_server.py'), 'unused-backend', '18000',
    '--database-url', 'postgresql://vibe@127.0.0.1:55432/loadtest_test', '--measurement-pool-size', '301'], { encoding: 'utf8' });
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /must be in \[1, 300\]/);
});
test('summary retains legacy failed rounds and displays gave_up for current bot conditions', () => {
  const legacy = { scenario: 'reconnect', commit: '1b2e6c4', condition: 'exponential', ok: false, metrics: {} };
  const current = { scenario: 'reconnect', commit: 'b86324b', condition: 'full-jitter-200-pool', ok: true, metrics: { gave_up: 3 } };
  const groups = summarizeRuns([legacy, current]);
  assert.equal(groups.find(group => group.key === 'reconnect/1b2e6c4/exponential').script_failed, 1);
  assert.equal(groups.find(group => group.key.endsWith('/exponential')).metrics.gave_up.missing, 1);
  assert.match(markdown(groups), /reconnect\/1b2e6c4\/exponential/);
  assert.match(markdown(groups), /full-jitter-200-pool \| gave_up \| 3 \| 3 \| 3/);
});
