import { launch, tab, enter, readyHost, readyHostYouTube, scriptedUser, readObservation, YOUTUBE_HOSTS } from './browser.mjs';
import { sleep, until } from './common.mjs';
import { positionErrors, percentile } from './stats.mjs';
import { windowP95, sourceMatches } from './sync-stats.mjs';
import { youtubeDiagnostics } from './youtube.mjs';

export const syncFrames = frames => frames.filter(f => f.data.type === 'sync');
export const mediaSamples = state => state.youtube ? state.ytSamples : state.probeSamples;
export const socketLog = state => state.probeWsLog.map(row => row.record);
export const delayTo = async t => sleep(Math.max(0, t - Date.now()));
export async function waitPlaying(state, { target = null, since = state.t0, timeout = 20000 } = {}) {
  await until(() => {
    const s = mediaSamples(state).at(-1);
    const matches = !target || (state.youtube
      ? s?.media_url?.includes(new URL(target).searchParams.get('v')) : s?.src === target);
    return s && s.t >= since && Date.now() - s.t < 1000 && matches && !s.none && !s.paused && !s.ad && s.ct > 0.2;
  }, timeout, `host playback${target ? ` ${target}` : ''}`);
  return mediaSamples(state).at(-1).t;
}
export async function waitOpen(state, since, timeout = 35000) {
  let opened = null;
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    opened = socketLog(state).find(row => row.open_at !== null && row.open_at >= since)?.open_at ?? null;
    if (opened !== null) break;
    await sleep(50);
  }
  return opened;
}
export async function session(ctx, { prepared = false, beforeGuestEnter = null } = {}) {
  const { cleanup, result, seed, condition, smoke } = ctx;
  const youtube = condition.includes('youtube');
  const allowHosts = youtube ? YOUTUBE_HOSTS : undefined;
  const hostBrowser = await launch(cleanup, false, { allowHosts });
  const guestBrowser = await launch(cleanup, true, { allowHosts });
  const options = { youtube, syncProbe: true };
  const host = await tab(hostBrowser, seed.host, result, cleanup, 'muted-allowed', true, options);
  host.youtube = youtube;
  const m = result.metrics;
  const savedHost = [];
  let guest, stopUser, finished = false;
  m.raw = { host_samples: mediaSamples(host), host_frames: host.frames, host_sent: host.sent,
    host_seeked: host.seeked, host_ws_events: host.probeWsLog, host_observations_before_reload: savedHost };
  const api = { host, metrics: m, youtube,
    async join() {
      guest = await tab(guestBrowser, seed.guest, result, cleanup, 'muted-allowed', true, options);
      guest.youtube = youtube;
      api.guest = guest;
      Object.assign(m.raw, { guest_samples: mediaSamples(guest), guest_frames: guest.frames,
        guest_sent: guest.sent, guest_seeked: guest.seeked, guest_ws_events: guest.probeWsLog });
      if (beforeGuestEnter) await beforeGuestEnter(guest);
      stopUser = scriptedUser(guest, cleanup, result);
      cleanup.push(async () => { if (!finished) await api.finish(); });
      await enter(guest, seed.room);
      m.raw.guest_enter_at = guest.t0;
      return guest;
    },
    async stopGuestUser() { if (stopUser) await stopUser(); },
    async saveBeforeReload() { savedHost.push(await readObservation(host, result)); },
    async finish(endAt = Date.now()) {
      if (finished) return m;
      if (stopUser) await stopUser();
      const ho = await readObservation(host, result);
      const go = guest ? await readObservation(guest, result) : null;
      // Page-owned samples disappear on reload. Read them before reload and
      // combine them explicitly; console samples remain available on failures.
      const hs = youtube ? [...host.ytSamples] : [...savedHost.flatMap(o => o.samples), ...ho.samples];
      const gs = guest ? youtube ? [...guest.ytSamples] : go.samples : [];
      const end = endAt;
      const errors = positionErrors(hs, gs.filter(s => s.t <= end));
      const firstSync = guest?.frames.find(f => f.data.type === 'sync' && f.t <= end);
      const lastH = hs.filter(s => s.t <= end).at(-1), lastG = gs.filter(s => s.t <= end).at(-1);
      Object.assign(m, {
        host_final: lastH ?? null, guest_final: lastG ?? null,
        guest_first_sync: firstSync ? { videoId: firstSync.data.videoId ?? null,
          timestamp: firstSync.data.timestamp ?? null, received_at: firstSync.t } : null,
        guest_received_sync: !!firstSync,
        host_sync_frames: syncFrames(host.sent).filter(f => f.t <= end).length,
        guest_sync_frames: guest ? syncFrames(guest.frames).filter(f => f.t <= end).length : null,
        join_p95_ms: guest ? windowP95(errors, smoke ? guest.t0 : guest.t0 + 15000,
          Math.min(end + 1, guest.t0 + (smoke ? 8000 : 25000))) : null,
        last_10s_p95_ms: windowP95(errors, end - (smoke ? 3000 : 10000), end + 1),
        max_error_ms: percentile(errors.map(s => s.err), 1),
      });
      const matches = youtube ? null : sourceMatches(hs, gs);
      m.guest_src_matches_host = matches ? {
        compared: matches.filter(s => s.same !== null).length,
        mismatches: matches.filter(s => s.same === false).length,
        final: matches.at(-1)?.same ?? null,
      } : null;
      if (youtube && guest) Object.assign(m, youtubeDiagnostics(hs, gs, host.t0, guest.t0, end));
      Object.assign(m.raw, { host_samples: hs, guest_samples: gs, errors, source_matches: matches,
        host_observation: ho, guest_observation: go, observation_end: end,
        host_ws_log: socketLog(host), guest_ws_log: guest ? socketLog(guest) : [],
        host_sent: host.sent.filter(f => f.t <= end), host_frames: host.frames.filter(f => f.t <= end),
        guest_sent: guest ? guest.sent.filter(f => f.t <= end) : [], guest_frames: guest ? guest.frames.filter(f => f.t <= end) : [] });
      finished = true;
      return m;
    },
  };
  // Preserve partial measurements even when a later action or wait fails.
  cleanup.push(async () => { if (!finished) await api.finish(); });
  if (prepared) {
    if (youtube) await readyHostYouTube(host, seed.room, undefined, { playbackTimeout: smoke ? 15000 : 60000 });
    else await readyHost(host, seed.room);
    m.host_playing_at = host.lastPlayClickAt;
  } else {
    await enter(host, seed.room);
    m.host_playing_at = await waitPlaying(host, { timeout: smoke ? 15000 : youtube ? 60000 : 20000 });
    await until(() => socketLog(host).some(row => row.open_at !== null), 10000, 'host socket open');
  }
  m.raw.host_enter_at = host.t0;
  return api;
}

// React's controlled range uses a prototype setter so its value tracker sees
// a real change. The bubbling input event reaches onChange -> handleSeekChange
// -> onSeek, the same path as the UI (range is a fraction in [0,1]).
export async function seekForward(host, seconds = 60) {
  const current = mediaSamples(host).at(-1)?.ct;
  if (!Number.isFinite(current)) throw new Error('Missing host position before seek');
  const duration = host.youtube
    ? await host.page.locator('input[type=range]').evaluate(el => {
      const time = el.parentElement.parentElement.lastElementChild.textContent.trim().split(':').map(Number);
      return time.reduce((total, n) => total * 60 + n, 0);
    })
    : await host.page.locator('video').evaluate(el => el.duration);
  if (!Number.isFinite(duration) || duration <= current + seconds) throw new Error('Media is too short for +60s seek');
  const target = current + seconds;
  const action = await host.page.locator('input[type=range]').evaluate((el, fraction) => {
    if (el.disabled) throw new Error('Host seek range is disabled');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, String(fraction));
    const t = Date.now();
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { at: t, fraction };
  }, target / duration);
  await until(() => {
    const s = mediaSamples(host).at(-1);
    return s?.t >= action.at && Math.abs(s.ct - target) < 3;
  }, 5000, 'host seek applied through range onChange');
  return { ...action, before: current, target, duration, observed: mediaSamples(host).at(-1) };
}
