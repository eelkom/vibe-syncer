import { launch, tab, readyHost, enter, samples, scriptedUser, readObservation } from '../lib/browser.mjs';
import { sleep } from '../lib/common.mjs';
import { positionErrors, syncTime, errorAt, median, percentile, countUnexpectedPauses, activationBeforeFirstClick } from '../lib/stats.mjs';
export async function run(ctx) {
  const { cleanup, result, seed, smoke } = ctx;
  const hostBrowser = await launch(cleanup);
  const guestBrowser = await launch(cleanup, true);
  const host = await tab(hostBrowser, seed.host, result, cleanup);
  await readyHost(host, seed.room);
  await sleep(smoke ? 5000 : 30000);
  const guest = await tab(guestBrowser, seed.guest, result, cleanup);
  const stopUser = scriptedUser(guest, cleanup, result);
  await enter(guest, seed.room);
  const duration = smoke ? 8000 : 25000;
  await sleep(Math.max(0, guest.t0 + duration - Date.now()));
  await stopUser();
  // Observation has ended: this is the first guest page evaluation.
  const observation = await readObservation(guest, result);
  const hs = await samples(host), gs = observation.samples;
  const end = guest.t0 + duration;
  const errors = positionErrors(hs, gs.filter(s => s.t <= end));
  const last = errors.filter(s => s.t >= Math.max(guest.t0, end - 10000)).map(s => s.err);
  const relative = frame => frame ? frame.t - guest.t0 : null;
  return {
    sync_time_ms: syncTime(errors, guest.t0),
    sync_time_2s_ms: syncTime(errors, guest.t0, 2000, 2000),
    activation_before_first_click: activationBeforeFirstClick(gs, guest.t0, end, observation.user_click_events),
    err_at_5s_ms: errorAt(errors, guest.t0 + 5000),
    err_at_10s_ms: errorAt(errors, guest.t0 + 10000),
    err_at_20s_ms: errorAt(errors, guest.t0 + 20000),
    err_p50_ms: median(last), err_p75_ms: percentile(last, 0.75), err_p95_ms: percentile(last), clicks: guest.clicks,
    first_sync_frame_ms: relative(guest.frames.find(f => f.data.type === 'sync')),
    queue_response_ms: relative(guest.responses.find(r => /\/queue_list(?:\?|$)/.test(r.url))),
    ws_reconnects: Math.max(0, observation.ws_log.length - 1),
    guest_console_errors: guest.consoleErrors.length,
    host_unexpected_pauses: countUnexpectedPauses(hs, host.lastPlayClickAt),
    guest_unexpected_pauses: countUnexpectedPauses(gs, guest.t0),
    raw: { t0: guest.t0, host_samples: hs, guest_samples: gs, errors, guest_frames: guest.frames,
      host_last_play_click_at: host.lastPlayClickAt,
      guest_console: guest.consoleErrors, host_sent: host.sent,
      ws_attempts: observation.ws_log.map(entry => entry.created_at), ws_log: observation.ws_log,
      user_click_events: observation.user_click_events, observation_end: end },
  };
}
