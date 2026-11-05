import { percentile } from './stats.mjs';

export const YOUTUBE_VIDEO = Object.freeze({
  id: 'aqz-KE-bpKQ',
  url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
});

export function sampleCounts(samples, start, end) {
  const selected = samples.filter(s => s.t >= start && s.t <= end);
  return {
    ad_samples: selected.filter(s => s.ad).length,
    buffering_samples: selected.filter(s => s.buffering).length,
    none_samples: selected.filter(s => s.none).length,
    paused_samples: selected.filter(s => s.paused).length,
    total_samples: selected.length,
  };
}

export function youtubeDiagnostics(host, guest, hostT0, guestT0, end) {
  const windowStart = Math.max(guestT0, end - 10000);
  const interference = Object.fromEntries([['host', host, hostT0], ['guest', guest, guestT0]].map(([role, samples, start]) => [role, {
    observation: sampleCounts(samples, start, end),
    window: sampleCounts(samples, windowStart, end),
  }]));
  const observedGuest = guest.filter(s => s.t >= guestT0 && s.t <= end);
  const first = observedGuest[0];
  const playing = observedGuest.find(s => !s.none && !s.paused && s.ct > 0 && !s.ad);
  const flags = [];
  for (const role of ['host', 'guest']) for (const [period, suffix] of [['observation', ''], ['window', '_window']]) {
    for (const factor of ['ad', 'buffering']) {
      if (interference[role][period][`${factor}_samples`] > 0) flags.push(`${role}_${factor}${suffix}`);
    }
  }
  if (!playing) flags.push('guest_never_played');
  return { interference, flags, first_sample_ms: first ? first.t - guestT0 : null,
    first_playing_ms: playing ? playing.t - guestT0 : null };
}

// Match positionErrors' host interpolation: both bracketing samples contribute
// to an in-between timestamp, so either flagged endpoint excludes that error.
export function p95ExcludingFlagged(errors, host, guest, start, end) {
  const flagged = s => !!(s?.ad || s?.buffering);
  const guestAt = new Map(guest.map(s => [s.t, s]));
  let i = 0;
  const values = [];
  for (const error of errors) {
    if (error.t < start || error.t > end) continue;
    while (i < host.length && host[i].t < error.t) i++;
    const hostFlagged = host[i]?.t === error.t ? flagged(host[i]) : flagged(host[i - 1]) || flagged(host[i]);
    if (!flagged(guestAt.get(error.t)) && !hostFlagged) values.push(error.err);
  }
  return percentile(values);
}
