import { median, percentile, positionErrors } from '../lib/stats.mjs';
export const distribution = values => ({ p50: median(values), p75: percentile(values, .75), p95: percentile(values), max: values.length ? Math.max(...values) : null });
export function delivery(sent, displayed, control = null, sentAt = new Map()) {
  const visible = new Map(displayed.map(m => [m[0], m]));
  const expected = new Set(sent), delays = []; let lost = 0, duplicates = 0;
  for (const marker of expected) {
    const row = visible.get(marker);
    if (!row) lost++;
    else { const t = sentAt.get(marker) ?? Number(marker.match(/-(\d+)$/)?.[1]); delays.push(row[1] - t); duplicates += Math.max(0, row[2] - 1); }
  }
  return { delivery_ms: distribution(delays), delivery_values_ms: delays, sent: expected.size, lost, duplicates,
    server_side_lost: control === null ? null : [...expected].filter(m => !control.has(m)).length };
}
export function correctionSeeks(seeks, frames, firstPause = Infinity) {
  return seeks.filter(t => {
    const last = frames.filter(f => f.t <= t).at(-1);
    // Exclude initial join sync and classify by the latest action: pause/seek
    // must not be mistaken for a play correction, even inside a play's 1s.
    return t >= firstPause && last?.action === 'play' && t - last.t <= 1000;
  }).length;
}
export function droppedFrame(delta) { return Math.max(0, Math.round(delta / 16.67) - 1); }
export function errorWindows(host, guest, actions, end) {
  const pause = actions.find(a => a.action === 'pause')?.t ?? end;
  const resume = actions.find(a => a.action === 'play' && a.t > pause)?.t ?? end;
  const errors = positionErrors(host, guest).filter(s => s.t <= end);
  // Paused samples are already null in positionErrors. Explicitly exclude
  // host UI pause->play windows and every 1.5s following an explicit seek.
  const valid = errors.filter(s => s.err !== null && !actions.some((a, i) =>
    a.action === 'seek' ? s.t >= a.t && s.t < a.t + 1500
      : a.action === 'pause' && s.t >= a.t && s.t < (actions.slice(i + 1).find(b => b.action === 'play')?.t ?? end)));
  return { join: distribution(valid.filter(s => s.t < pause).map(s => s.err)),
    steady: distribution(valid.filter(s => s.t >= resume).map(s => s.err)) };
}
export function parseServerJSONL(text) {
  return text.split('\n').filter(Boolean).map((line, i) => {
    try { return JSON.parse(line); } catch { throw new Error(`Invalid server JSONL line ${i + 1}`); }
  });
}
export function verdict(run) {
  if (run.skipped) return { pass: false, reasons: ['SKIPPED'], external: {} };
  const m = run.metrics ?? {}, reasons = [];
  const add = (yes, code) => { if (yes) reasons.push(code); };
  add(!run.ok, 'SCRIPT_ERROR'); add(run.setup_failed, 'SETUP_FAILED');
  add(m.host_action_timeouts > 0, 'HOST_SYNC_TIMEOUT');
  add(m.input_stuck || m.page_unresponsive, 'PAGE_STUCK');
  add(run.scenario === 'steady' && m.play_correction_seeks > 0, 'PLAY_CORRECTION');
  add(m.lost > 0, 'LOST'); add(m.duplicates > 0, 'DUPLICATES'); add(m.server_side_lost > 0, 'BOT_LOST');
  add(m.join_failed === true || m.bot_join_failed > 0, 'JOIN_FAILED');
  add(m.bot_gave_up > 0 || m.browser_gave_up > 0, 'RETRY_EXHAUSTED');
  add((run.server?.queuepool_errors ?? 0) > 0, 'QUEUE_POOL');
  add(m.bot_disconnects > 0 || m.host_disconnects > 0 || m.guest_disconnects > 0 || m.joiner_disconnects > 0, 'DISCONNECTED');
  const external = { inp_over_200: m.inp_ms == null ? null : m.inp_ms > 200,
    delivery_p95_over_1000: m.delivery_ms?.p95 == null ? null : m.delivery_ms.p95 > 1000,
    err_p95_over_500: (m.err_p95 ?? m.err_ms?.p95) == null ? null : (m.err_p95 ?? m.err_ms?.p95) > 500 };
  return { pass: reasons.length === 0, reasons, external, measurement_load: (m.bot_event_loop?.p95_ms ?? 0) > 100 };
}

export function interactionCandidates(events) {
  const interactions = new Map();
  for (const [, duration, id] of events) interactions.set(id, Math.max(duration, interactions.get(id) ?? 0));
  return [...interactions.values()];
}
