import { percentile, syncTime } from './stats.mjs';

// Require two continuous seconds below 2s. Missing/paused samples and gaps
// invalidate the hold, as in the existing late-join measurement.
export function recoveryTime(errors, start, end = Infinity, hold = 2000) {
  return syncTime(errors.filter(s => s.t < end), start, hold, 2000);
}
export function windowP95(errors, start, end) {
  return percentile(errors.filter(s => s.t >= start && s.t < end).map(s => s.err));
}
export function intervalP95(errors, start, end, interval = 30000) {
  if (!(interval > 0)) throw new Error('interval must be positive');
  const rows = [];
  for (let t = start; t < end; t += interval) {
    const stop = Math.min(t + interval, end);
    const selected = errors.filter(s => s.t >= t && s.t < stop);
    rows.push({ start_ms: t - start, end_ms: stop - start,
      p95_ms: percentile(selected.map(s => s.err)),
      valid_samples: selected.filter(s => Number.isFinite(s.err)).length, total_samples: selected.length });
  }
  return rows;
}
export function backwardJumps(samples, start = -Infinity, threshold = 2) {
  let previous = null, count = 0;
  for (const s of samples) {
    if (s.none || !Number.isFinite(s.ct)) { previous = null; continue; }
    if (s.t >= start && previous && previous.ct - s.ct > threshold) count++;
    previous = s;
  }
  return count;
}
export function staleVideoSyncs(frames, since, target, until = Infinity) {
  return frames.filter(f => f.t >= since && f.t < until && f.data.type === 'sync'
    && typeof f.data.videoId === 'string' && f.data.videoId !== target).length;
}
export function reconnectFrames(frames, start, end = Infinity) {
  const selected = frames.filter(f => f.t >= start && f.t < end);
  return { join: selected.filter(f => f.data.type === 'system' && /has joined/.test(f.data.message ?? '')).length,
    welcome: selected.filter(f => f.data.type === 'chat' && f.data.user_id === 0).length };
}
export function sourceMatches(host, guest) {
  let i = 0;
  return guest.map(s => {
    while (i + 1 < host.length && host[i + 1].t <= s.t) i++;
    const h = host[i];
    return { t: s.t, host_src: h?.t <= s.t ? h.src ?? null : null, guest_src: s.src ?? null,
      same: h?.t <= s.t && h.src && s.src ? h.src === s.src : null };
  });
}
