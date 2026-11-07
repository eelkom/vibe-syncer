import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ROOT } from '../lib/common.mjs';
import { parseArgs, resultPath } from '../deploy/late_join_deployed.mjs';

const commits = ['--front-commit', 'abcdef0', '--server-commit', '1234567'];

test('deployed late join requires both commit labels and defaults to five runs', () => {
  assert.deepEqual(parseArgs(commits), { runs: 5, frontCommit: 'abcdef0', serverCommit: '1234567' });
  assert.deepEqual(parseArgs(['--runs', '2', ...commits]), { runs: 2, frontCommit: 'abcdef0', serverCommit: '1234567' });
  for (const args of [[], commits.slice(0, 2), commits.slice(2)]) assert.throws(() => parseArgs(args), /required/);
  for (const value of ['0', '-1', '1.5', 'Infinity', '9007199254740992', undefined]) {
    assert.throws(() => parseArgs([...commits, '--runs', ...(value === undefined ? [] : [value])]), /positive integer/);
  }
  for (const flag of ['--front-commit', '--server-commit']) {
    for (const value of ['../outside', 'main', 'abcd', 'a'.repeat(41), undefined]) {
      assert.throws(() => parseArgs([...commits, flag, ...(value === undefined ? [] : [value])]), /SHA/);
    }
  }
  for (const flag of ['--summary', '--force', '--smoke', '--front']) {
    assert.throws(() => parseArgs([...commits, flag]), /Unknown argument/);
  }
});

test('deployed results use the supplied frontend SHA without resolving or shortening it', () => {
  const frontCommit = 'a'.repeat(40);
  const opts = parseArgs(['--front-commit', frontCommit, '--server-commit', 'b'.repeat(40)]);
  assert.equal(resultPath(opts.frontCommit, 3), path.join(ROOT, 'results/deploy/late_join', frontCommit, 'run-3.json'));
});
