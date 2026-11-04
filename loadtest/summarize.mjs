import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './lib/common.mjs';
import { median, percentile } from './lib/stats.mjs';
const fields = {
  late_join: ['sync_time_ms', 'err_at_5s_ms', 'err_at_10s_ms', 'err_at_20s_ms', 'err_p50_ms', 'err_p75_ms', 'err_p95_ms', 'clicks_count', 'first_sync_frame_ms', 'queue_response_ms', 'ws_reconnects', 'guest_console_errors'],
  message_burst: ['n', 'control_received', 'on_screen_unique', 'delivery_ratio', 'missing_count', 'duplicates', 'elapsed_ms'],
  history_race: ['lost_a', 'lost_b', 'dup_a', 'dup_b', 'lost_total', 'dup_total', 'on_screen_total', 'extra_history_gets'],
  reconnect: ['peak_attempts_per_s', 'peak_opens_per_s', 'time_to_all_reconnected_ms', 'reconnected', 'gave_up', 'pending', 'first_retry_range_ms', 'first_retry_stddev_ms', 'missing_first_retry'],
  autoplay: ['first_playback_ms', 'audible_ms', 'clicks_count', 'err_after_audible_ms', 'blocked_play_calls'],
};
function value(run, field) {
  if (field === 'clicks_count') return Array.isArray(run.metrics?.clicks) ? run.metrics.clicks.length : null;
  if (field === 'missing_count') return Array.isArray(run.metrics?.missing) ? run.metrics.missing.length : null;
  return run.metrics?.[field] ?? null;
}
export function summarizeRuns(runs) {
  const groups = new Map();
  for (const run of runs) {
    const key = [run.scenario, run.commit, run.condition].join('/');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(run);
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([key, group]) => {
    const keys = fields[group[0].scenario] ?? [];
    const applicable = group[0].scenario === 'reconnect'
      ? keys.filter(k => group[0].condition === 'browser-10'
        ? ['first_retry_range_ms', 'first_retry_stddev_ms', 'missing_first_retry'].includes(k)
        : !['first_retry_range_ms', 'first_retry_stddev_ms', 'missing_first_retry'].includes(k))
      : keys;
    return { key, runs: group.length, script_failed: group.filter(r => !r.ok).length,
      autoplay_failed: group.filter(r => r.metrics?.failed === true).length,
      injection_ineffective: group.filter(r => r.metrics?.injection_effective === false).length,
      metrics: Object.fromEntries(applicable.map(k => {
        const values = group.map(r => value(r, k));
        const valid = values.filter(v => typeof v === 'number' && Number.isFinite(v));
        return [k, { median: median(valid), p75: percentile(valid, 0.75), p95: percentile(valid), valid: valid.length, missing: group.length - valid.length }];
      })) };
  });
}
export async function readRuns(dir) {
  const runs = [];
  async function visit(folder) {
    let entries;
    try { entries = await readdir(folder, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const target = path.join(folder, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (/^run-\d+\.json$/.test(entry.name)) runs.push(JSON.parse(await readFile(target, 'utf8')));
    }
  }
  await visit(dir); return runs;
}
export function markdown(groups) {
  const lines = [
    '# Stage 1 측정 요약', '',
    '회차별 값의 중앙값 및 nearest-rank p75/p95. 회차가 5개면 nearest-rank p95는 최댓값과 같다. null/미기록은 제외하고 결측 회차 수로 표시한다. 실패 회차도 원본과 집계에 남긴다.', '',
    'history_race: 조회 요청과 응답에 **지연 주입**. autoplay/all-blocked: 사용자 활성화 전 play 및 autoplay 속성 차단 주입으로 저전력 모드 등을 모사한다. 사용자 반응 시간 1000ms가 결과에 포함된다. 주입 무효 회차는 injection_effective가 명시적으로 false인 회차만 센다.', '',
    '| 시나리오/커밋/조건 | 회차 | 스크립트 실패 | 소리 재생 실패 | 주입 무효 회차 |',
    '|---|---:|---:|---:|---:|',
    ...groups.map(g => `| ${g.key} | ${g.runs} | ${g.script_failed} | ${g.autoplay_failed} | ${g.injection_ineffective} |`), '',
    '| 시나리오/커밋/조건 | 지표 | 회차 중앙값 | 회차 p75 | 회차 p95 | 유효 회차 | 결측 회차 |',
    '|---|---|---:|---:|---:|---:|---:|',
  ];
  const format = n => n === null ? 'null' : Number(n.toFixed(3)).toString();
  for (const g of groups) for (const [key, metric] of Object.entries(g.metrics)) {
    lines.push(`| ${g.key} | ${key} | ${format(metric.median)} | ${format(metric.p75)} | ${format(metric.p95)} | ${metric.valid} | ${metric.missing} |`);
  }
  if (!groups.length) lines.push('', '측정 원본 없음.');
  return lines.join('\n') + '\n';
}
async function main() {
  const dir = path.join(ROOT, 'results/stage1');
  const runs = await readRuns(dir);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'SUMMARY.md'), markdown(summarizeRuns(runs)));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
