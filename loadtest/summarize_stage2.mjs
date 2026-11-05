import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { ROOT } from './lib/common.mjs';
import { readRuns } from './summarize.mjs';
import { median, numeric } from './lib/stats.mjs';
import { verdict, machineStatus } from './stage2/stats.mjs';
const fields = ['inp_ms', 'delivery_ms.p50', 'delivery_ms.p75', 'delivery_ms.p95',
  'control_delivery_ms.p50', 'control_delivery_ms.p75', 'control_delivery_ms.p95', 'err_p50', 'err_p75', 'err_p95',
  'join_err_p50', 'join_err_p75', 'join_err_p95', 'join_ms', 'bot_join_ms.p50', 'bot_join_ms.p75', 'bot_join_ms.p95',
  'lost', 'duplicates', 'server_side_lost', 'play_correction_seeks', 'input_count', 'long_task_count', 'long_task_sum_ms',
  'dropped_frames', 'total_frames', 'react_commits', 'react_commit_ms.p50', 'react_commit_ms.p75', 'react_commit_ms.p95',
  'heap_start', 'heap_end', 'heap_max', 'bot_event_loop.p95_ms', 'bot_event_loop.max_ms', 'system_messages', 'welcome_messages',
  'bot_disconnects', 'host_disconnects', 'guest_disconnects', 'bot_gave_up', 'bot_join_failed', 'host_action_timeouts', 'bot_unsent', 'guest_unsent',
  'connected_at_setup', 'server_summary.event_loop_max_ms', 'server_summary.event_loop_p95_ms_approx_max',
  'server_summary.broadcast_p95_ms_approx_max', 'server_summary.broadcast_sum_ms', 'server_summary.connections_max',
  'server_summary.pool_checked_out_max', 'server_summary.cpu_peak', 'server_summary.rss_peak_bytes',
  'server_summary.queuepool_errors', 'server_summary.server_forced_kills', 'browser_forced_kills'];
export function summarizeStage2(runs) {
  const groups = new Map();
  for (const run of runs) {
    const key = `${run.scenario}/${run.commit ?? 'b86324b'}/${run.condition}/n-${run.n}`;
    if (!groups.has(key)) groups.set(key, []); groups.get(key).push(run);
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })).map(([key, rounds]) => {
    const judged = rounds.filter(r => !machineStatus(r).machine_stalled), invalid = rounds.length - judged.length;
    const decisions = judged.map(verdict), active = judged.filter(r => !r.skipped);
    return { key, rounds: rounds.length, invalid_machine_stall: invalid,
      status: !judged.length ? 'INVALID' : judged.every(r => r.skipped) ? 'SKIPPED' : decisions.every(d => d.pass) ? 'PASS' : 'FAIL',
      reasons: !judged.length ? ['INVALID_MACHINE_STALL'] : [...new Set(decisions.flatMap(d => d.reasons))], measurement_load: decisions.some(d => d.measurement_load),
      thresholds: Object.fromEntries(['inp_over_200', 'delivery_p95_over_1000', 'err_p95_over_500'].map(k => [k,
        decisions.some(d => d.external?.[k] === true) ? true : decisions.some(d => d.external?.[k] === false) ? false : null])),
      metrics: Object.fromEntries(fields.map(field => {
        const values = numeric(active.map(r => field.split('.').reduce((obj, key) => obj?.[key],
          ['connected_at_setup','browser_forced_kills'].includes(field) || field.startsWith('server_summary.') ? r : r.metrics)));
        return [field, { median: median(values), max: values.length ? Math.max(...values) : null, missing: active.length - values.length }];
      })) };
  });
}
export function renderStage2(groups) {
  const fmt = v => v === null ? 'null' : typeof v === 'number' ? String(Number(v.toFixed(3))) : v ? '초과' : '이하';
  const lines = ['# Stage 2 결과', '',
    '합격 규칙은 2026-11-04 확정한 값이다. 유효 회차 중 한 회차라도 서비스/연결 불합격 사유가 있으면 해당 N은 FAIL이다. 스크립트 실패도 FAIL로 표시한다.', '',
    '무효 판정은 저장된 machine_stalled만 사용한다. 회차 시작~끝 사이 pmset -g log의 Sleep 도메인 기록이 있으면 true이며 INVALID_MACHINE_STALL이다. 「머신 정지 무효 회차」로 세고 판정·통계·결측 집계에서 제외한다. 전부 무효이면 INVALID다. 샘플 간격은 페이지 병목의 기록 지표이며 무효 사유가 아니다. machine_stall_unknown은 OS 로그 보존 기간 부족 등으로 확인할 수 없는 회차이고 자동 제외하지 않는다. 기존 원본은 recompute_stage2_stall.mjs로 재계산한 뒤 요약한다.', '',
    'default는 풀을 수정하지 않은 서버의 약 15연결 한계를 측정한다. pool-250은 풀 상한 250으로 다음 병목을 찾는 진단용이며 원래 서버의 수용량과 구분한다.', '',
    'INP 200ms·전달 지연 p95 1000ms는 이 시험 조건의 외부 기준 지표로 초과 여부를 별도 표시한다. err_p95 500ms는 공인 기준이 없는 자체 목표다. 이 초과 표시는 서비스 실패 코드와 별도로 제시한다.', '',
    '봇 이벤트 루프 지연 p95 > 100ms는 「측정기 부하」로 표시한다. 이 경우 지연 지표를 믿기 어렵다. 집계에서 제외하지 않는다. 숫자는 회차 중앙값·최댓값이며 결측은 0으로 만들지 않는다. Long Task와 버려진 프레임은 기록 지표다.', '',
    '| 시나리오/커밋/조건/N | 회차 | 머신 정지 무효 회차 | 판정 | 사유 코드 | INP>200 | 전달p95>1000 | 오차p95>500 | 측정기 부하 |', '|---|---:|---:|---|---|---|---|---|---|',
    ...groups.map(g => `| ${g.key} | ${g.rounds} | ${g.invalid_machine_stall} | ${g.status} | ${g.reasons.join(', ') || '-'} | ${fmt(g.thresholds.inp_over_200)} | ${fmt(g.thresholds.delivery_p95_over_1000)} | ${fmt(g.thresholds.err_p95_over_500)} | ${g.measurement_load ? '측정기 부하' : '-'} |`), '',
    '| 시나리오/커밋/조건/N | 지표 | 회차 중앙값 | 회차 최댓값 | 결측 회차 |', '|---|---|---:|---:|---:|'];
  for (const g of groups) for (const [field, m] of Object.entries(g.metrics)) lines.push(`| ${g.key} | ${field} | ${fmt(m.median)} | ${fmt(m.max)} | ${m.missing} |`);
  return lines.join('\n') + '\n';
}
async function main() { const dir = path.join(ROOT, 'results/stage2'); await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'SUMMARY.md'), renderStage2(summarizeStage2(await readRuns(dir)))); }
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
