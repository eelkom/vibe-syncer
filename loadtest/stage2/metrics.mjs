import { firstPlayback } from '../lib/stats.mjs';
import { delivery, distribution, correctionSeeks, errorWindows, interactionCandidates, machineStatus } from './stats.mjs';
const within = (rows, start, end) => rows.filter(r => (r[0] ?? r.t) >= start && (r[0] ?? r.t) <= end);
export function pageMetrics(data, start, end, profiling) {
  if (!data) return Object.fromEntries(['inp_ms', 'input_count', 'long_task_count', 'long_task_sum_ms', 'dropped_frames', 'total_frames',
    'react_commits', 'heap_start', 'heap_end', 'heap_max', 'dom_nodes_start', 'dom_nodes_end'].map(k => [k, null]).concat([['react_commit_ms', distribution([])]]));
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
  const botSent = bots.sent.filter(entry => entry[3] === true);
  // Use the first successful socket.send for each guest marker, not typing time.
  const guestSent = new Map();
  for (const [marker, t] of guest?.sent ?? []) if (marker.startsWith('c-g-') && !guestSent.has(marker)) guestSent.set(marker, t);
  const sent = [...botSent.map(([id, seq, t]) => `c-b${id}-${seq}-${t}`), ...guestSent.keys()];
  const chat = delivery(sent, guest?.displayed ?? [], ctx.job.n > 2 ? new Set(bots.control.map(r => r[0])) : null, guestSent);
  // Missing a snapshot is unknown, not evidence that all its messages were lost.
  if (!guest) Object.assign(chat, { delivery_ms: distribution([]), delivery_values_ms: null, sent: null, lost: null, duplicates: null, server_side_lost: null });
  const errors = host && guest ? errorWindows(host.samples, guest.samples, ctx.actions, end) : { steady: distribution([]), join: distribution([]) };
  const firstPause = ctx.actions.find(a => a.action === 'pause')?.t ?? Infinity;
  const aggregate = { ...pageMetrics(guest, start, ctx.trafficEnd ?? end, ctx.job.profiling), ...chat,
    err_ms: errors.steady, join_err_ms: errors.join,
    err_p50: errors.steady.p50, err_p75: errors.steady.p75, err_p95: errors.steady.p95,
    join_err_p50: errors.join.p50, join_err_p75: errors.join.p75, join_err_p95: errors.join.p95,
    host_action_timeouts: ctx.host_action_timeouts ?? 0, input_stuck: ctx.input_stuck === true,
    page_unresponsive: [ctx.host, ctx.guest, ctx.joiner].some(s => s?.unresponsive === true),
    bot_unsent: bots.sent.length - botSent.length,
    guest_unsent: guest ? ctx.inputs.filter(i => !guestSent.has(i.marker)).length : null,
    play_correction_seeks: guest ? correctionSeeks(guest.seeks, guest.sync, firstPause) : null,
    bot_event_loop: bots.event_loop, bot_disconnects: bots.bots.reduce((sum, b) => sum + b.closes.length, 0),
    bot_gave_up: bots.gave_up, bot_join_failed: ctx.job.n - (ctx.job.scenario === 'join_burst' ? 3 : 2) - bots.bots.filter(b => b.join_ms !== null).length,
    bot_join_ms: distribution(bots.bots.map(b => b.join_ms).filter(Number.isFinite)),
    host_disconnects: host?.ws.filter(w => w.close_at !== null && w.close_at <= end).length ?? null,
    guest_disconnects: guest?.ws.filter(w => w.close_at !== null && w.close_at <= end).length ?? null,
    host_reconnects: host ? Math.max(0, host.ws.length - 1) : null, guest_reconnects: guest ? Math.max(0, guest.ws.length - 1) : null,
    browser_gave_up: host && guest ? gaveUp(host.ws, end) + gaveUp(guest.ws, end) : null,
    system_messages: guest?.system_events.filter(t => t >= start && t <= end).length ?? null, welcome_messages: guest?.welcome_events.filter(t => t >= start && t <= end).length ?? null,
    join_ms: joiner && ctx.joinSubmit ? firstPlayback(joiner.samples, ctx.joinSubmit) : null,
    join_success: ctx.job.scenario === 'join_burst' && !ctx.joiner?.unresponsive ? Boolean(joiner && ctx.joinSubmit && firstPlayback(joiner.samples, ctx.joinSubmit) !== null) : null,
    join_failed: ctx.job.scenario === 'join_burst' ? ctx.joiner?.unresponsive ? null : !joiner || !ctx.joinSubmit || firstPlayback(joiner.samples, ctx.joinSubmit) === null : false,
    joiner_disconnects: ctx.joiner?.unresponsive ? null : joiner?.ws.filter(w => w.close_at !== null && w.close_at <= end).length ?? 0 };
  aggregate.inp_ms = guest?.inp.filter(r => r[0] <= end).at(-1)?.[1] ?? null;
  aggregate.input_count = guest?.inputs.filter(t => t >= start && t <= end).length ?? null;
  if (joiner && aggregate.browser_gave_up !== null) aggregate.browser_gave_up += gaveUp(joiner.ws, end);
  if (ctx.joiner?.unresponsive) aggregate.browser_gave_up = null;
  if (ctx.job.scenario === 'chat_accumulation' && !guest) Object.assign(aggregate, { checkpoints: null, accumulation_received: null });
  if (ctx.job.scenario === 'chat_accumulation' && guest) {
    let previous = start;
    aggregate.checkpoints = guest.checkpoints.map(cp => {
      const interval = pageMetrics(guest, previous, cp.t, true);
      const input = ctx.inputs.find(i => i.checkpoint === cp.target);
      const candidates = input && input.end !== null ? interactionCandidates(guest.candidates.filter(r => r[0] >= input.start && r[0] <= input.end + 1000)) : [];
      previous = cp.t;
      return { ...cp, ...interval, heap: cp.heap, dom_nodes: cp.dom_nodes, input: input ?? null, inp_candidates_ms: candidates };
    });
    aggregate.accumulation_received = guest.displayed.filter(r => /^c-b/.test(r[0])).length;
  }
  aggregate.raw = { sample_columns: ['t', 'ct (null = absent)', 'paused', 'muted', 'volume'], host_samples: host ? tupleSamples(host.samples) : null, guest_samples: guest ? tupleSamples(guest.samples) : null,
    joiner_samples: joiner ? tupleSamples(joiner.samples) : null,
    bot_sent: bots.sent, guest_sent: guest?.sent ?? null, displayed: guest?.displayed ?? null, inputs: ctx.inputs, actions: ctx.actions, host_action_failures: ctx.host_action_failures ?? [],
    longtasks: guest?.longtasks ?? null, heap: guest?.memory ?? null, inp: guest?.inp ?? null, raf: guest?.raf ?? null,
    commit_durations: ctx.job.profiling && guest ? guest.commits.map(c => c[1]) : null,
    seeks: guest?.seeks ?? null, sync: guest?.sync ?? null, host_ws: host?.ws ?? null, guest_ws: guest?.ws ?? null, joiner_ws: joiner?.ws ?? null,
    bots: bots.bots, start, end, traffic_end: ctx.trafficEnd ?? end };
  return Object.assign(aggregate, machineStatus({ metrics: aggregate }));
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
