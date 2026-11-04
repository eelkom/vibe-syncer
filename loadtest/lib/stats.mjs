export const numeric = values => values.filter(v => typeof v === 'number' && Number.isFinite(v));
export function median(values) {
  const a = numeric(values).sort((x, y) => x - y);
  if (!a.length) return null;
  const i = Math.floor(a.length / 2);
  return a.length % 2 ? a[i] : (a[i - 1] + a[i]) / 2;
}
export function percentile(values, p = 0.95) {
  if (!(p > 0 && p <= 1)) throw new Error('Percentile must be in (0,1]');
  const a = numeric(values).sort((x, y) => x - y);
  return a.length ? a[Math.ceil(a.length * p) - 1] : null;
}
const playing = s => s && !s.none && s.paused === false && Number.isFinite(s.ct);
export function interpolate(samples, t) {
  let lo = 0, hi = samples.length - 1;
  while (lo <= hi) {
    const i = (lo + hi) >> 1;
    if (samples[i].t === t) return playing(samples[i]) ? samples[i].ct : null;
    if (samples[i].t < t) lo = i + 1; else hi = i - 1;
  }
  const a = samples[hi], b = samples[lo];
  if (!playing(a) || !playing(b)) return null;
  return a.ct + (b.ct - a.ct) * (t - a.t) / (b.t - a.t);
}
// Retain null samples: removing a paused interval would fabricate sustained sync.
export function positionErrors(host, guest) {
  return guest.map(s => {
    const ct = playing(s) ? interpolate(host, s.t) : null;
    return { t: s.t, err: ct === null ? null : Math.abs(ct - s.ct) * 1000 };
  });
}
export function syncTime(errors, t0, hold = 2000) {
  let start = null, previous = null;
  for (const s of errors) {
    if (s.t < t0) continue;
    // >250ms sampling gaps cannot prove a continuous two-second hold.
    if (s.err === null || s.err >= 500 || (previous !== null && s.t - previous > 250)) start = null;
    if (s.err !== null && s.err < 500) {
      start ??= s.t;
      if (s.t - start >= hold) return start - t0;
    }
    previous = s.t;
  }
  return null;
}
export function errorAt(errors, t, tolerance = 200) {
  const candidates = errors.filter(s => Math.abs(s.t - t) <= tolerance);
  const nearest = candidates.sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t))[0];
  return nearest?.err ?? null;
}
export function peakPerSecond(times, origin) {
  const buckets = new Map();
  for (const t of times) {
    if (t < origin) continue;
    const bin = Math.floor((t - origin) / 1000);
    buckets.set(bin, (buckets.get(bin) ?? 0) + 1);
  }
  return Math.max(0, ...buckets.values());
}
export function stddev(values) {
  const a = numeric(values);
  if (!a.length) return null;
  const mean = a.reduce((x, y) => x + y, 0) / a.length;
  return Math.sqrt(a.reduce((sum, x) => sum + (x - mean) ** 2, 0) / a.length);
}
export function countMarkers(text, markers) {
  // Whitespace-separated exact tokens; m-1-1 never matches m-1-10 or xm-1-1.
  const tokens = text.split(/\s+/u);
  const counts = new Map(markers.map(m => [m, 0]));
  for (const token of tokens) if (counts.has(token)) counts.set(token, counts.get(token) + 1);
  return {
    counts: Object.fromEntries(counts),
    unique: [...counts.values()].filter(n => n > 0).length,
    missing: [...counts].filter(([, n]) => n === 0).map(([m]) => m),
    duplicates: [...counts.values()].reduce((sum, n) => sum + Math.max(0, n - 1), 0),
  };
}
// The first sample that demonstrates >=0.2s advancement from a playing sample.
export function firstPlayback(samples, t0, audible = false) {
  let start = null;
  for (const s of samples) {
    if (s.t < t0) continue;
    if (!playing(s) || (audible && (s.muted || !(s.volume > 0)))) { start = null; continue; }
    if (!start || s.ct < start.ct) start = s;
    if (s.ct - start.ct >= 0.2) return s.t - t0;
  }
  return null;
}
