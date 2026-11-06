import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './lib/common.mjs';
import { SYNC_CONDITIONS } from './lib/sync-plan.mjs';
import { median, numeric } from './lib/stats.mjs';
import { JOIN_INTERVALS } from './lib/join-timeline-stats.mjs';

const E2E = ['reconnect_recovery', 'reconnect_exhausted', 'ws_room_token'];
export async function readSyncRuns(root = path.join(ROOT, 'results')) {
  const runs = [];
  const dirs = async dir => {
    try { return (await readdir(dir, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort(); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  const read = async (dir, defaults) => {
    let files;
    try { files = await readdir(dir); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const file of files.filter(f => /^run-\d+\.json$/.test(f))) {
      try { runs.push({ ...defaults, ...JSON.parse(await readFile(path.join(dir, file), 'utf8')) }); }
      catch (error) { throw new Error(`${path.join(dir, file)}: ${error.message}`); }
    }
  };
  for (const scenario of Object.keys(SYNC_CONDITIONS)) {
    const base = path.join(root, 'stage1', scenario);
    for (const commit of await dirs(base)) for (const condition of await dirs(path.join(base, commit))) {
      await read(path.join(base, commit, condition), { scenario, commit, condition, suite: 'stage1' });
    }
  }
  for (const scenario of E2E) {
    const base = path.join(root, 'e2e', scenario);
    for (const commit of await dirs(base)) await read(path.join(base, commit), { scenario, commit, condition: 'default', suite: 'e2e' });
  }
  const deployed = path.join(root, 'deploy/join_timeline');
  for (const commit of await dirs(deployed)) await read(path.join(deployed, commit), {
    scenario: 'join_timeline_deployed', commit, condition: 'youtube', suite: 'deploy',
  });
  return runs;
}
// Flatten small diagnostic structures and arrays into separate table metrics.
// Raw time series and individual injected frames remain exclusively in JSON.
export function metricValues(metrics, prefix = '') {
  const out = {};
  for (const [key, value] of Object.entries(metrics ?? {})) {
    if (['raw', 'injected_syncs', 'host_final', 'guest_final', 'song', 'seek', 'retries'].includes(key)) continue;
    const name = prefix ? `${prefix}.${key}` : key;
    if (value === null || typeof value !== 'object') out[name] = value;
    else if (Array.isArray(value)) {
      if (value.every(v => v === null || typeof v !== 'object')) out[name] = value;
      else value.forEach((v, i) => Object.assign(out, metricValues({ [i + 1]: v }, name)));
    } else Object.assign(out, metricValues(value, name));
  }
  return out;
}
export function summarizeSync(runs) {
  const grouped = new Map();
  for (const run of runs) {
    const key = `${run.suite ?? 'stage1'}/${run.scenario}/${run.condition}/${run.commit}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(run);
  }
  return [...grouped].sort(([a], [b]) => a.localeCompare(b)).map(([key, values]) => {
    const rows = values.toSorted((a, b) => a.run - b.run).map(run => ({ ...run, values: metricValues(run.metrics) }));
    const names = [...new Set(rows.flatMap(r => Object.keys(r.values)))].sort();
    const metrics = Object.fromEntries(names.map(name => {
      const good = rows.filter(r => r.ok).map(r => r.values[name]);
      const numbers = numeric(good);
      return [name, { median: median(numbers), min: numbers.length ? Math.min(...numbers) : null,
        max: numbers.length ? Math.max(...numbers) : null,
        missing: good.filter(v => v === null || v === undefined).length }];
    }));
    return { key, rows, metrics };
  });
}
const cell = value => (value === undefined ? 'missing' : value === null ? 'null' : typeof value === 'object' ? JSON.stringify(value) : String(value))
  .replaceAll('|', '\\|').replaceAll('\n', '<br>');
export function syncMarkdown(groups) {
  if (!groups.length) return '측정 원본 없음\n';
  const lines = ['# 재생 동기화 비교', '', '단위는 지표 이름을 따른다. 오차와 시간 차이는 ms다. null은 관측되지 않은 값이며 0이 아니다. 실행 실패 회차도 표시하고 중앙값과 범위에서만 제외한다. e2e FAIL 판정은 실행 성공이면 통계에 포함한다.', ''];
  for (const group of groups) {
    lines.push(`## ${group.key}`, '', '| 회차 | 실행 | 판정 | 오류 |', '|---|---|---|---|');
    for (const row of group.rows) lines.push(`| ${row.run} | ${row.ok ? 'OK' : 'FAILED'} | ${row.passed === undefined ? '관측' : row.passed ? 'PASS' : 'FAIL'} | ${cell((row.errors ?? []).join('; '))} |`);
    const columns = group.rows.map(r => `run-${r.run}${r.ok ? '' : ' FAILED'}`);
    if (group.rows.some(r => ['join_timeline', 'join_timeline_deployed'].includes(r.scenario))) {
      lines.push('', '### 입장부터 첫 재생까지 구간', '',
        '시간 구간은 ms, queue_blocking_share는 비율이다. 위치 오차 p95는 입장 클릭 후 15초부터 25초 구간이다.', '',
        `| 구간 | ${columns.join(' | ')} | 중앙값 | 결측(실행 성공) |`,
        `|---|${columns.map(() => '---').join('|')}|---|---|`);
      for (const name of JOIN_INTERVALS) {
        const key = `join_timeline.intervals.${name}`;
        const stats = group.metrics[key];
        lines.push(`| ${name} | ${group.rows.map(r => cell(r.values[key])).join(' | ')} | ${cell(stats?.median ?? null)} | ${stats?.missing ?? group.rows.filter(r => r.ok).length} |`);
      }
    }
    lines.push('', `| 지표 | ${columns.join(' | ')} | 중앙값 | 범위 | 결측(실행 성공) |`,
      `|---|${columns.map(() => '---').join('|')}|---|---|---|`);
    for (const [name, stats] of Object.entries(group.metrics)) {
      lines.push(`| ${name} | ${group.rows.map(r => cell(r.values[name])).join(' | ')} | ${cell(stats.median)} | ${cell(stats.min)} ~ ${cell(stats.max)} | ${stats.missing} |`);
    }
    lines.push('');
  }
  return lines.join('\n') + '\n';
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length > 3) throw new Error('Usage: node loadtest/summarize_sync.mjs [results-root]');
  console.log(syncMarkdown(summarizeSync(await readSyncRuns(process.argv[2] ?? path.join(ROOT, 'results')))));
}
