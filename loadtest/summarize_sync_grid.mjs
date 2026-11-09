// 실행: node loadtest/summarize_sync_grid.mjs [669a045]
// results/deploy/sync_grid/<sha>/<조건>/run-N.json을 읽어 조합별 중앙값 표를 낸다.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './lib/common.mjs';
import { median, percentile, syncTime } from './lib/stats.mjs';

const sha = process.argv[2] ?? '669a045';
const dir = path.join(ROOT, 'results/deploy/sync_grid', sha, ...(process.argv[3] ? [process.argv[3]] : []));
const r0 = v => v === null || v === undefined ? '-' : Math.round(v);
const list = vs => vs.map(r0).join(', ');
const rows = [];
for (const cond of readdirSync(dir).sort()) {
  if (!/^(?:[a-z]+-)?t[\d.]+-i\d+$/.test(cond)) continue;
  const runs = readdirSync(path.join(dir, cond)).filter(f => /^run-\d+\.json$/.test(f)).sort()
    .map(f => JSON.parse(readFileSync(path.join(dir, cond, f), 'utf8')));
  if (!runs.length) continue;
  const ok = runs.filter(r => r.ok);
  // Time from a disturbance until the error stays under 500ms for 2s.
  const rec500 = (x, i) => {
    const d = x.disturbances[i], stop = x.disturbances[i + 1]?.at ?? x.raw.end;
    return syncTime(x.raw.errors.filter(e => e.t < stop), d.at, 2000, 500);
  };
  const m = k => ok.map(r => k(r.metrics));
  rows.push({ cond, threshold: runs[0]?.threshold_s, interval: runs[0]?.interval_ms, variant: runs[0]?.variant ?? null,
    n: `${ok.length}/${runs.length}`,
    join_p50: m(x => x.join.p50_ms), join_p95: m(x => x.join.p95_ms),
    a_p95: m(x => x.a_steady.p95_ms), b_p95: m(x => x.b_steady.p95_ms),
    a_rec: m(x => rec500(x, 0)), b_rec: m(x => rec500(x, 1)),
    join_500: m(x => syncTime(x.raw.errors.filter(e => e.t < x.disturbances[0].at), x.raw.t0, 2000, 500)),
    seeks: m(x => x.guest_seeks.correction), steady_seeks: m(x => x.guest_seeks.after_first_play_steady),
    buffering: m(x => x.guest_buffering_samples), msgs: m(x => x.host_sync_per_min),
    delivery: ok.flatMap(r => r.metrics.delivery_ms), rtt: ok.flatMap(r => r.metrics.host_echo_rtt_ms),
    flags: ok.map(r => r.metrics.flags.join('+') || '-') });
}
console.log('| 조건 | 회차 | 합류 p50 | 합류 p95 | 0.8s 교란 뒤 p95 | 4s 교란 뒤 p95 | 합류 뒤 500ms 미만 유지 | 0.8s 교란 복구(<500ms) | 4s 교란 복구(<500ms) | 보정 seek | 메시지/분 |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of rows) {
  console.log(`| ${r.variant ? `${r.variant} ` : ''}${r.threshold}s / ${r.interval / 1000}s | ${r.n} | ${r0(median(r.join_p50))} (${list(r.join_p50)}) | ${r0(median(r.join_p95))} (${list(r.join_p95)}) | ${r0(median(r.a_p95))} (${list(r.a_p95)}) | ${r0(median(r.b_p95))} (${list(r.b_p95)}) | ${r0(median(r.join_500))} (${list(r.join_500)}) | ${r0(median(r.a_rec))} (${list(r.a_rec)}) | ${r0(median(r.b_rec))} (${list(r.b_rec)}) | ${list(r.seeks)} | ${r0(median(r.msgs))} |`);
}
console.log('\n| 조건 | 전달 지연 p50 / p95 | 호스트 왕복 p50 / p95 | 게스트 버퍼링 표본 | 플래그 |');
console.log('|---|---|---|---|---|');
for (const r of rows) console.log(`| ${r.cond} | ${r0(median(r.delivery))} / ${r0(percentile(r.delivery))} | ${r0(median(r.rtt))} / ${r0(percentile(r.rtt))} | ${list(r.buffering)} | ${r.flags.join(', ')} |`);
