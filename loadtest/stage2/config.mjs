import { machineStatus } from './stats.mjs';
import { validateCommit } from '../lib/commit.mjs';
export const SHA = 'b86324b';
export function options(args) {
  const out = { smoke: false, force: false, rerunInvalid: false, scenario: 'all', runs: 3, commit: null, ns: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--smoke') out.smoke = true;
    else if (args[i] === '--force') out.force = true;
    else if (args[i] === '--rerun-invalid') out.rerunInvalid = true;
    else if (args[i] === '--scenario') out.scenario = args[++i];
    else if (args[i] === '--runs') out.runs = Number(args[++i]);
    else if (args[i] === '--commit') out.commit = validateCommit(args[++i]);
    else if (args[i] === '--n') {
      const values = args[++i]?.split(',').map(value => value.trim());
      if (!values?.length || values.some(value => !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 2)) throw new Error('--n needs comma-separated integers >= 2');
      out.ns = [...new Set(values.map(Number))].sort((a,b) => a-b);
    }
    else throw new Error(`Unknown argument ${args[i]}`);
  }
  if (!['all', 'steady', 'chat_burst', 'join_burst', 'chat_accumulation'].includes(out.scenario)) throw new Error('Unknown scenario');
  if (!Number.isInteger(out.runs) || out.runs < 1) throw new Error('Invalid runs');
  return out;
}
export function shouldRun(existing, opts) {
  if (opts.force) return true;
  if (opts.rerunInvalid) return Boolean(existing && machineStatus(existing).machine_stalled);
  return !existing;
}
export function plan(opts) {
  const jobs = [];
  for (const scenario of ['steady', 'chat_burst', 'join_burst', 'chat_accumulation']) {
    if (opts.scenario !== 'all' && opts.scenario !== scenario) continue;
    if (scenario === 'chat_accumulation') {
      for (let run = 1; run <= (opts.smoke ? 1 : 3); run++) jobs.push({ scenario, condition: 'default', n: 3, run, pool: null, cpu: 1, profiling: true });
      continue;
    }
    for (const [base, sizes] of [['default', opts.smoke ? [2, 10] : [2, 10, 14, 15, 16, 25]],
      ['pool-250', opts.smoke ? [10] : [10, 25, 50, 100, 200]]]) {
      for (const cpu of scenario === 'chat_burst' ? [1, 4] : [1]) for (const n of sizes) {
        if (scenario === 'join_burst' && n < 3) continue;
        for (let run = 1; run <= (opts.smoke ? 1 : opts.runs); run++) jobs.push({ scenario,
          condition: base + (cpu === 4 ? '-cpu4' : ''), n, run, pool: base === 'pool-250' ? 250 : null, cpu, profiling: false });
      }
    }
  }
  if (opts.ns) {
    const allowed = new Set(jobs.map(job => job.n));
    const missing = opts.ns.filter(n => !allowed.has(n));
    if (missing.length) throw new Error(`N not in selected scenario/smoke plan: ${missing.join(',')}`);
  }
  return jobs.filter(job => !opts.ns || opts.ns.includes(job.n)).map(job => ({ ...job, sha: opts.commit ?? SHA }));
}
export function skipAfterFailures(job, previous, expectedRuns) {
  if (!job.condition.startsWith('pool-250')) return false;
  const smaller = previous.filter(r => (r.commit ?? SHA) === (job.sha ?? SHA) && r.scenario === job.scenario && r.condition === job.condition && r.n < job.n && !r.skipped && !machineStatus(r).machine_stalled);
  return [...new Set(smaller.map(r => r.n))].some(n => {
    const rounds = smaller.filter(r => r.n === n);
    return rounds.length === expectedRuns && rounds.every(r => r.setup_failed === true && r.ok === true);
  });
}
