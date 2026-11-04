import { launch, tab, readyHost, enter, samples, scriptedUser } from '../lib/browser.mjs';
import { sleep } from '../lib/common.mjs';
import { firstPlayback, positionErrors, errorAt, countUnexpectedPauses } from '../lib/stats.mjs';
export async function run({ cleanup, result, seed, condition }) {
  const hb = await launch(cleanup), gb = await launch(cleanup, true);
  const host = await tab(hb, seed.host, result, cleanup);
  await readyHost(host, seed.room);
  await sleep(5000);
  const guest = await tab(gb, seed.guest, result, cleanup, condition === 'all-blocked');
  const stopUser = scriptedUser(guest, cleanup, result);
  await enter(guest, seed.room);
  await sleep(Math.max(0, guest.t0 + 30000 - Date.now()));
  await stopUser();
  let gs = await samples(guest);
  const within = gs.filter(s => s.t <= guest.t0 + 30000);
  const audible = firstPlayback(within, guest.t0, true);
  // Preserve the full 30s success deadline; allow two further seconds only to
  // observe the specified error after an audible onset near the deadline.
  if (audible !== null && Date.now() < guest.t0 + audible + 2200) await sleep(guest.t0 + audible + 2200 - Date.now());
  gs = await samples(guest);
  const hs = await samples(host), errors = positionErrors(hs, gs);
  const injection = condition === 'all-blocked' ? await guest.page.evaluate(() => ({
    blocked: window.__blockedPlay, first_click: window.__userClickEvents[0]?.t ?? null,
  })) : null;
  return {
    first_playback_ms: firstPlayback(within, guest.t0), audible_ms: audible,
    clicks: guest.clicks, err_after_audible_ms: audible === null ? null : errorAt(errors, guest.t0 + audible + 2000),
    failed: audible === null, reaction_time_ms: 1000,
    host_unexpected_pauses: countUnexpectedPauses(hs, host.lastPlayClickAt),
    guest_unexpected_pauses: countUnexpectedPauses(gs, guest.t0),
    blocked_play_calls: injection?.blocked ?? null,
    injection_effective: injection === null ? null
      : firstPlayback(gs.filter(s => injection.first_click === null || s.t < injection.first_click), guest.t0) === null,
    injection: condition === 'all-blocked' ? 'play・autoplay 차단 주입: userActivation 전 play 거부 및 자동재생 속성 무시 (저전력 모드 모사)' : null,
    raw: { t0: guest.t0, host_samples: hs, guest_samples: gs, errors, guest_console: guest.consoleErrors, host_sent: host.sent,
      host_last_play_click_at: host.lastPlayClickAt },
  };
}
