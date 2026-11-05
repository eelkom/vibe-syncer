import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './lib/common.mjs';
import { median, numeric } from './lib/stats.mjs';

const fields = ['err_p95_ms', 'err_p95_excluding_flagged_ms', 'err_p50_ms', 'sync_time_ms', 'first_playing_ms', 'clicks', 'external_hosts'];
export function summarizeYouTube(runs) {
  const groups = new Map();
  for (const run of runs) {
    if (!groups.has(run.commit)) groups.set(run.commit, []);
    groups.get(run.commit).push(run);
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([commit, group]) => {
    const rows = [...group].sort((a, b) => a.run - b.run).map(run => ({
      run: run.run, ok: run.ok,
      ...Object.fromEntries(fields.map(field => [field, field === 'clicks'
        ? (Array.isArray(run.metrics?.clicks) ? run.metrics.clicks.length : null)
        : field === 'external_hosts' ? Object.keys(run.external_hosts ?? {}).length : run.metrics?.[field] ?? null])),
      flags: run.metrics?.flags ?? [], blocked_hosts: run.blocked_hosts ?? {},
    }));
    return { commit, rows, metrics: Object.fromEntries(fields.map(field => {
      const values = numeric(rows.filter(row => row.ok === true).map(row => row[field]));
      return [field, { median: median(values), min: values.length ? Math.min(...values) : null,
        max: values.length ? Math.max(...values) : null }];
    })) };
  });
}

export async function readYouTubeRuns(root = path.join(ROOT, 'results/stage1/late_join_youtube')) {
  let commits;
  try { commits = await readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const runs = [];
  for (const commit of commits.filter(entry => entry.isDirectory())) {
    const dir = path.join(root, commit.name, 'youtube');
    let files;
    try { files = await readdir(dir); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const file of files.filter(name => /^run-\d+\.json$/.test(name)).sort()) {
      runs.push(JSON.parse(await readFile(path.join(dir, file), 'utf8')));
    }
  }
  return runs;
}

export function markdown(groups) {
  const lines = ['# YouTube 늦은 합류 측정', '', 'ok=true 회차의 유한한 숫자만 집계한다. null은 결측이다. external_hosts는 서로 다른 외부 호스트 수다.', ''];
  const format = value => value === null ? 'null' : typeof value === 'number' ? String(Number(value.toFixed(3))) : String(value);
  const cell = value => format(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
  for (const group of groups) {
    lines.push(`## ${group.commit}`, '',
      `| 회차 | ok | ${fields.join(' | ')} | flags | blocked_hosts |`,
      `|---:|---|${fields.map(() => '---:').join('|')}|---|---|`);
    for (const row of group.rows) lines.push(`| ${[row.run, row.ok, ...fields.map(field => row[field]), row.flags.join(', '), JSON.stringify(row.blocked_hosts)].map(cell).join(' | ')} |`);
    lines.push('', '| 지표 | 중앙값 | 최솟값 | 최댓값 |', '|---|---:|---:|---:|');
    for (const [field, metric] of Object.entries(group.metrics)) lines.push(`| ${field} | ${[metric.median, metric.min, metric.max].map(format).join(' | ')} |`);
    lines.push('');
  }
  if (!groups.length) lines.push('측정 원본 없음.', '');
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(markdown(summarizeYouTube(await readYouTubeRuns())));
}
