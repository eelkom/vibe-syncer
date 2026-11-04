export const MAIN = 'b86324b';
export const COMPARISONS = {
  late_join: ['8003014', 'e75a31c', MAIN], message_burst: ['e7904b9', MAIN],
  history_race: ['32cdc26', '08eb0e5', MAIN], autoplay: ['ea2acea', 'a086001', MAIN],
};
export function parseArgs(args) {
  const opts = { scenario: 'all', runs: null, smoke: false, force: false, condition: null };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--smoke') opts.smoke = true;
    else if (key === '--force') opts.force = true;
    else if (key === '--scenario') opts.scenario = args[++i];
    else if (key === '--runs') opts.runs = Number(args[++i]);
    else if (key === '--condition') opts.condition = args[++i];
    else throw new Error(`Unknown argument: ${key}`);
  }
  if (![...Object.keys(COMPARISONS), 'all', 'reconnect'].includes(opts.scenario)) throw new Error('Unknown scenario');
  if (opts.runs !== null && (!Number.isInteger(opts.runs) || opts.runs < 1)) throw new Error('--runs must be a positive integer');
  if (opts.condition !== null && !opts.condition) throw new Error('--condition needs a value');
  return opts;
}
export function plan(opts) {
  const names = opts.scenario === 'all' ? [...Object.keys(COMPARISONS), 'reconnect'] : [opts.scenario];
  const jobs = [];
  for (const scenario of names) {
    if (scenario === 'reconnect') {
      jobs.push({ scenario, sha: '1b2e6c4', serverSha: MAIN, condition: 'exponential', defaultRuns: 5 },
        { scenario, sha: MAIN, serverSha: MAIN, condition: 'full-jitter', defaultRuns: 5 });
      for (const sha of ['1b2e6c4', MAIN]) jobs.push({ scenario, sha, serverSha: sha, condition: 'browser-10', defaultRuns: 3 });
    } else {
      const conditions = scenario === 'message_burst' ? (opts.smoke ? ['50'] : ['50', '200', '1000'])
        : scenario === 'autoplay' ? ['muted-allowed', 'all-blocked'] : ['default'];
      for (const sha of COMPARISONS[scenario]) for (const condition of conditions) jobs.push({ scenario, sha, serverSha: sha, condition, defaultRuns: 5 });
    }
  }
  const selected = jobs.filter(j => !opts.condition || j.condition === opts.condition);
  if (!selected.length) throw new Error('No matching scenario/condition');
  return selected.flatMap(j => Array.from({ length: opts.smoke ? 1 : opts.runs ?? j.defaultRuns },
    (_, i) => ({ ...j, runNumber: i + 1 })));
}
