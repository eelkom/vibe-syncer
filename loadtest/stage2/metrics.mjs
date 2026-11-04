import { firstPlayback } from '../lib/stats.mjs';
import { delivery, distribution, correctionSeeks, errorWindows, interactionCandidates } from './stats.mjs';
const within = (rows, start, end) => rows.filter(r => (r[0] ?? r.t) >= start && (r[0] ?? r.t) <= end);
export function pageMetrics(data, start, end, profiling) {
  const memory = within(data.memory, start, end), longtasks = within(data.longtasks, start, end), commits = within(data.commits, start, end);
  const raf = data.raf_events ? within(data.raf_events, start, end).map(r => [1, r[1]]) : Object.entries(data.raf).filter(([t]) => Number(t) >= start && Number(t) <= end).map(([, v]) => v);
  const heap = memory.map(r => r[1]).filter(Number.isFinite);
  return { inp_ms: data.inp.filter(r => r[0] <= end).at(-1)?.[1] ?? null, input_count: within(data.inputs.map(t => [t]), start, end).length,
    long_task_count: longtasks.length, long_task_sum_ms: longtasks.reduce((sum, r) => sum + r[1], 0),
    dropped_frames: raf.reduce((sum, r) => sum + r[1], 0), total_frames: raf.reduce((sum, r) => sum + r[0], 0),
    react_commits: commits.length, react_commit_ms: distribution(profiling ? commits.map(r => r[1]).filter(Number.isFinite) : []),
    heap_start: heap[0] ?? null, heap_end: heap.at(-1) ?? null, heap_max: heap.length ? Math.max(...heap) : null,
    dom_nodes_start: memory[0]?.[2] ?? null, dom_nodes_end: memory.at(-1)?.[2] ?? null };
}
function gaveUp(ws, end) {
  const lastOpen = ws.findLastIndex(w => w.open_at !== null);
  const retries = ws.slice(lastOpen < 0 ? 1 : lastOpen + 1), last = retries.at(-1);
  return retries.length >= 5 && last?.close_at !== null && end - last?.close_at >= 1000 ? 1 : 0;
}
const tupleSamples = samples => samples.map(s => s.none ? [s.t, null] : [s.t, s.ct, s.paused, s.muted, s.volume]);
export function metrics(ctx, host, guest, bots, joiner) {
  const end = ctx.end, start = ctx.start;
  const sent = [...bots.sent.map(([id, seq, t]) => `c-b${id}-${seq}-${t}`), ...ctx.inputs.map(i => i.marker)];
  const chat = delivery(sent, guest.displayed, ctx.job.n > 2 ? new Set(bots.control.map(r => r[0])) : null);
  const errors = errorWindows(host.samples, guest.samples, ctx.actions, end);
  const firstPause = ctx.actions.find(a => a.action === 'pause')?.t ?? Infinity;
  const aggregate = { ...pageMetrics(guest, start, ctx.trafficEnd ?? end, ctx.job.profiling), ...chat,
    err_ms: errors.steady, join_err_ms: errors.join,
    err_p50: errors.steady.p50, err_p75: errors.steady.p75, err_p95: errors.steady.p95,
    join_err_p50: errors.join.p50, join_err_p75: errors.join.p75, join_err_p95: errors.join.p95,
    play_correction_seeks: correctionSeeks(guest.seeks, guest.sync, firstPause),
    bot_event_loop: bots.event_loop, bot_disconnects: bots.bots.reduce((sum, b) => sum + b.closes.length, 0),
    bot_gave_up: bots.gave_up, bot_join_failed: ctx.job.n - (ctx.job.scenario === 'join_burst' ? 3 : 2) - bots.bots.filter(b => b.join_ms !== null).length,
    bot_join_ms: distribution(bots.bots.map(b => b.join_ms).filter(Number.isFinite)),
    host_disconnects: host.ws.filter(w => w.close_at !== null && w.close_at <= end).length,
    guest_disconnects: guest.ws.filter(w => w.close_at !== null && w.close_at <= end).length,
    host_reconnects: Math.max(0, host.ws.length - 1), guest_reconnects: Math.max(0, guest.ws.length - 1),
    browser_gave_up: gaveUp(host.ws, end) + gaveUp(guest.ws, end),
    system_messages: guest.system_events.filter(t => t >= start && t <= end).length, welcome_messages: guest.welcome_events.filter(t => t >= start && t <= end).length,
    join_ms: joiner && ctx.joinSubmit ? firstPlayback(joiner.samples, ctx.joinSubmit) : null,
    join_success: ctx.job.scenario === 'join_burst' ? Boolean(joiner && ctx.joinSubmit && firstPlayback(joiner.samples, ctx.joinSubmit) !== null) : null,
    join_failed: ctx.job.scenario === 'join_burst' ? !joiner || !ctx.joinSubmit || firstPlayback(joiner.samples, ctx.joinSubmit) === null : false,
    joiner_disconnects: joiner?.ws.filter(w => w.close_at !== null && w.close_at <= end).length ?? 0 };
  aggregate.inp_ms = guest.inp.filter(r => r[0] <= end).at(-1)?.[1] ?? null;
  aggregate.input_count = guest.inputs.filter(t => t >= start && t <= end).length;
  if (joiner) aggregate.browser_gave_up += gaveUp(joiner.ws, end);
  if (ctx.job.scenario === 'chat_accumulation') {
    let previous = start;
    aggregate.checkpoints = guest.checkpoints.map(cp => {
      const interval = pageMetrics(guest, previous, cp.t, true);
      const input = ctx.inputs.find(i => i.checkpoint === cp.target);
      const candidates = input ? interactionCandidates(guest.candidates.filter(r => r[0] >= input.start && r[0] <= input.end + 1000)) : [];
      previous = cp.t;
      return { ...cp, ...interval, heap: cp.heap, dom_nodes: cp.dom_nodes, input: input ?? null, inp_candidates_ms: candidates };
    });
    aggregate.accumulation_received = guest.displayed.filter(r => /^c-b/.test(r[0])).length;
  }
  aggregate.raw = { sample_columns: ['t', 'ct (null = absent)', 'paused', 'muted', 'volume'], host_samples: tupleSamples(host.samples), guest_samples: tupleSamples(guest.samples),
    joiner_samples: joiner ? tupleSamples(joiner.samples) : null,
    bot_sent: bots.sent, displayed: guest.displayed, inputs: ctx.inputs, actions: ctx.actions,
    longtasks: guest.longtasks, heap: guest.memory, inp: guest.inp, raf: guest.raf,
    commit_durations: ctx.job.profiling ? guest.commits.map(c => c[1]) : null,
    seeks: guest.seeks, sync: guest.sync, host_ws: host.ws, guest_ws: guest.ws, joiner_ws: joiner?.ws ?? null,
    bots: bots.bots, start, end, traffic_end: ctx.trafficEnd ?? end };
  return aggregate;
}
export function boundedJSON(record) {
  let text = JSON.stringify(record);
  if (Buffer.byteLength(text) + 1 > 2 * 1024 * 1024) {
    const raw = record.metrics?.raw ?? {};
    record.ok = false;
    record.errors.push('RESULT_SIZE_LIMIT: raw diagnostic arrays omitted to keep the round under 2MB; media samples retained');
    record.metrics.raw = { sample_columns: raw.sample_columns, host_samples: raw.host_samples, guest_samples: raw.guest_samples,
      joiner_samples: raw.joiner_samples, omitted_keys: Object.keys(raw), start: raw.start, end: raw.end };
    text = JSON.stringify(record);
  }
  if (Buffer.byteLength(text) + 1 > 2 * 1024 * 1024) throw new Error('Round with media samples still exceeds 2MB');
  return text + '\n';
}
