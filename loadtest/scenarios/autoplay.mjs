import { launch, tab, readyHost, enter, samples, scriptedUser, readObservation } from '../lib/browser.mjs';
import { sleep } from '../lib/common.mjs';
import { firstPlayback, positionErrors, errorAt, countUnexpectedPauses, activationBeforeFirstClick } from '../lib/stats.mjs';
export async function run({ cleanup, result, seed, condition }) {
  const hb = await launch(cleanup), gb = await launch(cleanup, true);
  const host = await tab(hb, seed.host, result, cleanup);
  await readyHost(host, seed.room);
  await sleep(5000);
  const guest = await tab(gb, seed.guest, result, cleanup, condition);
  const stopUser = scriptedUser(guest, cleanup, result);
  await enter(guest, seed.room);
  await sleep(Math.max(0, guest.t0 + 30000 - Date.now()));
  await stopUser();
  // Fixed tail covers audible+2s even at the 30s success deadline. Do not read
  // guest samples to calculate a wait: evaluate itself can grant activation.
  await sleep(Math.max(0, guest.t0 + 32200 - Date.now()));
  const observationEnd = Date.now();
  // Observation has ended: this is the first guest page evaluation.
  const observation = await readObservation(guest, result);
  const gs = observation.samples;
  const within = gs.filter(s => s.t <= guest.t0 + 30000);
  const audible = firstPlayback(within, guest.t0, true);
  const hs = await samples(host), errors = positionErrors(hs, gs);
  const injection = condition !== 'muted-allowed' ? {
    blocked: observation.blocked_play_calls, first_click: observation.user_click_events[0]?.t ?? null,
  } : null;
  return {
    first_playback_ms: firstPlayback(within, guest.t0), audible_ms: audible,
    clicks: guest.clicks, err_after_audible_ms: audible === null ? null : errorAt(errors, guest.t0 + audible + 2000),
    failed: audible === null, reaction_time_ms: 1000,
    activation_before_first_click: activationBeforeFirstClick(gs, guest.t0, observationEnd, observation.user_click_events),
    host_unexpected_pauses: countUnexpectedPauses(hs, host.lastPlayClickAt),
    guest_unexpected_pauses: countUnexpectedPauses(gs, guest.t0),
    blocked_play_calls: injection?.blocked ?? null,
    injection_effective: injection === null ? null
      : firstPlayback(gs.filter(s => s.t < Math.min(injection.first_click ?? Infinity, observationEnd)), guest.t0) === null,
    injection: condition === 'all-blocked'
      ? 'all-blocked 주입: userActivation 전 play 즉시 NotAllowedError 거부 및 autoplay 속성 무시'
      : condition === 'silent-blocked'
        ? 'silent-blocked 주입: userActivation 전 play Promise 영구 대기(재생 시작 안 함) 및 autoplay 속성 무시'
        : null,
    raw: { t0: guest.t0, host_samples: hs, guest_samples: gs, errors, guest_console: guest.consoleErrors, host_sent: host.sent,
      host_last_play_click_at: host.lastPlayClickAt, user_click_events: observation.user_click_events,
      ws_log: observation.ws_log, observation_end: observationEnd },
  };
}
