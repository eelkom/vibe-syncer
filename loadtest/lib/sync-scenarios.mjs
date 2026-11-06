import { session, waitPlaying, waitOpen, syncFrames, seekForward, delayTo } from './sync-session.mjs';
import { dropSocket, restoreSocket, selectors } from './browser.mjs';
import { sleep, until } from './common.mjs';
import { median, percentile } from './stats.mjs';
import { recoveryTime, windowP95, intervalP95, backwardJumps, staleVideoSyncs, reconnectFrames } from './sync-stats.mjs';

export async function hostNoAction(ctx) {
  const s = await session(ctx);
  await delayTo(s.metrics.host_playing_at + (ctx.smoke ? 2000 : 30000));
  await s.join();
  await delayTo(s.guest.t0 + (ctx.smoke ? 8000 : 25000));
  return s.finish();
}
export async function songChange(ctx) {
  const s = await session(ctx), { host, metrics: m } = s;
  const prev = ctx.condition.endsWith('-prev'), jump = ctx.condition.endsWith('-jump');
  const next = () => host.page.locator('button:has(svg.lucide-skip-forward)').click();
  const old = ctx.seed.songs[prev ? 1 : 0].musicUrl;
  const target = ctx.seed.songs[prev ? 0 : 1].musicUrl;
  await delayTo(m.host_playing_at + (ctx.smoke ? 1000 : 10000));
  if (prev) {
    const at = Date.now();
    await next();
    const playingAt = await waitPlaying(host, { target: old, since: at, timeout: ctx.smoke ? 10000 : 60000 });
    await delayTo(playingAt + (ctx.smoke ? 1000 : 10000));
  }
  const changedAt = Date.now();
  m.raw.song_change_at = changedAt;
  m.target_video = target;
  m.previous_video = old;
  if (prev) await host.page.locator('button:has(svg.lucide-skip-back)').click();
  else if (jump) await host.page.getByText(ctx.seed.songs[1].title, { exact: true }).click();
  else await next();
  m.target_playing_at = await waitPlaying(host, { target, since: changedAt, timeout: ctx.smoke ? 15000 : 60000 });
  await delayTo(m.target_playing_at + (ctx.smoke ? 2000 : 30000));
  await s.join();
  await delayTo(s.guest.t0 + (ctx.smoke ? 8000 : 25000));
  await s.finish();
  m.host_stale_video_syncs = staleVideoSyncs(m.raw.host_sent, changedAt, target);
  const sentAfterChange = syncFrames(m.raw.host_sent).filter(f => f.t >= changedAt);
  m.host_syncs_after_change = sentAfterChange.length;
  m.host_missing_video_syncs = sentAfterChange.filter(f => typeof f.data.videoId !== 'string').length;
  m.host_syncs_all_target = sentAfterChange.length ? m.host_stale_video_syncs === 0 && m.host_missing_video_syncs === 0 : null;
  return m;
}
export async function naturalEnd(ctx) {
  const s = await session(ctx), m = s.metrics;
  m.target_video = ctx.seed.songs[1].musicUrl;
  m.second_song_playing_at = await waitPlaying(s.host, { target: m.target_video, timeout: 35000 });
  await delayTo(m.second_song_playing_at + (ctx.smoke ? 1000 : 30000));
  await s.join();
  await delayTo(s.guest.t0 + (ctx.smoke ? 8000 : 25000));
  return s.finish();
}
export async function hostReconnect(ctx) {
  const s = await session(ctx, { prepared: true }), { host, metrics: m } = s;
  const alone = ctx.condition === 'local-alone';
  if (!alone) await s.join();
  await delayTo((alone ? m.host_playing_at : s.guest.t0) + (ctx.smoke ? 3000 : 20000));
  m.drop_at = await dropSocket(host);
  if (!alone) m.seek = await seekForward(host);
  await sleep(ctx.smoke ? 1000 : alone ? 5000 : 8000);
  m.restore_at = await restoreSocket(host);
  m.open_at = await waitOpen(host, m.restore_at, ctx.smoke ? 12000 : 35000);
  m.reconnected = m.open_at !== null;
  if (alone) {
    if (m.open_at !== null) await delayTo(m.open_at + (ctx.smoke ? 1000 : 10000));
    await s.join();
    await delayTo(s.guest.t0 + (ctx.smoke ? 8000 : 25000));
  } else if (m.open_at !== null) await delayTo(m.open_at + (ctx.smoke ? 8000 : 40000));
  await s.finish();
  m.before_disconnect_p95_ms = windowP95(m.raw.errors, s.guest.t0, m.drop_at);
  m.recovery_ms = m.open_at === null ? null : recoveryTime(m.raw.errors, m.open_at);
  m.after_reconnect_last_10s_p95_ms = m.open_at === null ? null : windowP95(m.raw.errors,
    Math.max(m.open_at, m.raw.observation_end - (ctx.smoke ? 3000 : 10000)), m.raw.observation_end + 1);
  // Per receiver counts prevent double counting broadcasts; guest coverage also
  // catches the join broadcast delivered before the host's open console event.
  const boundary = m.open_at ?? m.restore_at;
  m.reconnect_frame_counts = Object.fromEntries([['host', host], ['guest', s.guest]].map(([role, state]) => [role, {
    before: reconnectFrames(state.frames, -Infinity, m.drop_at),
    during: reconnectFrames(state.frames, m.drop_at, boundary),
    after: reconnectFrames(state.frames, boundary),
    after_restore: reconnectFrames(state.frames, m.restore_at),
  }]));
  m.join_frames_after_reconnect = Object.fromEntries(Object.entries(m.reconnect_frame_counts).map(([role, counts]) => [role, counts.after_restore.join]));
  m.welcome_frames_after_reconnect = Object.fromEntries(Object.entries(m.reconnect_frame_counts).map(([role, counts]) => [role, counts.after_restore.welcome]));
  return m;
}
export async function hostRefresh(ctx) {
  const s = await session(ctx, { prepared: true }), m = s.metrics;
  await s.join();
  await delayTo(s.guest.t0 + (ctx.smoke ? 3000 : 20000));
  await s.saveBeforeReload();
  m.reload_at = Date.now();
  await s.host.page.reload({ waitUntil: 'domcontentloaded' });
  await delayTo(m.reload_at + (ctx.smoke ? 10000 : 30000));
  await s.finish();
  const played = m.raw.host_samples.find(p => p.t >= m.reload_at && !p.none && !p.paused && p.ct > 0.2);
  m.host_playback_after_reload_ms = played ? played.t - m.reload_at : null;
  m.samples_after_reload = m.raw.host_samples.filter(p => p.t >= m.reload_at).length;
  m.guest_backward_jumps = backwardJumps(m.raw.guest_samples, m.reload_at);
  m.after_reload_last_10s_p95_ms = windowP95(m.raw.errors,
    m.raw.observation_end - (ctx.smoke ? 3000 : 10000), m.raw.observation_end + 1);
  return m;
}
export async function longPlayback(ctx) {
  const s = await session(ctx), { host, metrics: m } = s;
  await s.join();
  if (ctx.condition === 'youtube-natural') {
    const end = s.guest.t0 + (ctx.smoke ? 30000 : 300000);
    await delayTo(end);
    await s.finish(end);
    m.interval_p95 = intervalP95(m.raw.errors, s.guest.t0, m.raw.observation_end);
    m.guest_seeked = s.guest.seeked.filter(e => e.t >= s.guest.t0).length;
    return m;
  }
  return disturbed(ctx, s, host);
}
export async function intervalProbe(ctx) {
  const s = await session(ctx), { host, metrics: m } = s;
  const interval = Number(ctx.condition.split('-')[1]);
  m.injected_interval_ms = interval;
  m.reference_build = ctx.sha;
  m.reference_build_note = 'Run on 24a8650 to choose the periodic sync interval.';
  // This timer belongs to the measurement harness, not the application build.
  await host.page.evaluate(ms => {
    window.__probeSyncSent = [];
    window.__probeSyncTimer = setInterval(() => {
      const video = document.querySelector('video'), ws = window.__wsLast;
      if (!video || video.paused || ws?.readyState !== WebSocket.OPEN) return;
      const data = { type: 'sync', action: 'play', timestamp: video.currentTime, videoId: video.currentSrc || video.src };
      ws.send(JSON.stringify(data));
      window.__probeSyncSent.push({ t: Date.now(), data });
    }, ms);
  }, interval);
  ctx.cleanup.push(() => host.page.evaluate(() => clearInterval(window.__probeSyncTimer)));
  await s.join();
  return disturbed(ctx, s, host, true);
}
async function disturbed(ctx, s, host, injected = false) {
  const m = s.metrics, first = ctx.smoke ? 7000 : 20000, interval = ctx.smoke ? 4000 : 30000;
  m.disturbances = [];
  for (let i = 0; i < 6; i++) {
    await delayTo(s.guest.t0 + first + i * interval);
    // Deliberate media fault, never an app seek handler or host command.
    m.disturbances.push(await s.guest.page.evaluate(() => {
      const video = document.querySelector('video');
      if (!video || video.paused) throw new Error('Guest must be playing before disturbance');
      const before = video.currentTime, at = Date.now();
      const target = Math.max(0, before - 10);
      video.currentTime = target;
      return { at, before, target, applied_seconds: before - target, clamped: before < 10 };
    }));
    if (!ctx.smoke && m.disturbances.at(-1).clamped) throw new Error('Guest has less than 10s available for the required disturbance');
  }
  await delayTo(m.disturbances.at(-1).at + interval);
  if (injected) m.injected_syncs = await host.page.evaluate(() => {
    clearInterval(window.__probeSyncTimer);
    return window.__probeSyncSent;
  });
  await s.finish();
  const end = m.raw.observation_end;
  for (const [i, d] of m.disturbances.entries()) {
    const next = m.disturbances[i + 1]?.at ?? end;
    d.end = next;
    d.recovery_ms = recoveryTime(m.raw.errors, d.at, next);
    d.host_sync_frames = syncFrames(host.sent).filter(f => f.t >= d.at && f.t < next).length;
    d.guest_sync_frames = syncFrames(s.guest.frames).filter(f => f.t >= d.at && f.t < next).length;
  }
  m.recovery_times_ms = m.disturbances.map(d => d.recovery_ms);
  m.recovery_median_ms = median(m.recovery_times_ms);
  m.recovery_max_ms = percentile(m.recovery_times_ms, 1);
  m.unrecovered_disturbances = m.recovery_times_ms.filter(v => v === null).length;
  m.server_forwarded_sync_frames = syncFrames(s.guest.frames).filter(f => f.t >= s.guest.t0 && f.t <= end).length;
  // Exclude disturbance->recovery+hold periods, and the deliberate seek's own
  // seeked event. Unrecovered periods run to the next disturbance/end.
  const quiet = event => event.t >= s.guest.t0 && event.t <= end && !m.disturbances.some(d =>
    event.t >= d.at && event.t < (d.recovery_ms === null ? d.end : d.at + d.recovery_ms + 2000));
  m.undisturbed_guest_seeked = s.guest.seeked.filter(quiet).length;
  if (injected) m.injected_sync_frames = m.injected_syncs.length;
  return m;
}
export async function serverBlock(ctx) {
  // Do not call readyHost: a pause/play cycle would wait for the welcome and
  // erase the welcome blocking condition before the measured pause.
  const s = await session(ctx), { host, metrics: m } = s;
  const isBot = f => f.data.type === 'chat' && f.data.user_id === 0;
  if (ctx.condition === 'welcome') await delayTo(host.t0 + 1000);
  else {
    await until(() => host.frames.some(isBot), 20000, 'initial welcome finished');
    m.initial_welcome_at = host.frames.find(isBot).t;
    const message = ctx.condition === 'dj' ? '!dj hello' : 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
    await host.page.locator(selectors.input).fill(message);
    m.chat_input_at = Date.now();
    await host.page.locator(selectors.input).press('Enter');
    await until(() => host.sent.some(f => f.t >= m.chat_input_at && f.data.type === 'chat' && f.data.message === message), 5000, 'chat sent');
    m.chat_sent_at = host.sent.find(f => f.t >= m.chat_input_at && f.data.type === 'chat' && f.data.message === message).t;
    await delayTo(m.chat_sent_at + 200);
  }
  m.pause_click_at = Date.now();
  m.pause_click_since_enter_ms = m.pause_click_at - host.t0;
  await host.page.locator(selectors.play).click();
  await until(() => host.sent.some(f => f.t >= m.pause_click_at && f.data.type === 'sync' && f.data.action === 'pause'), 5000, 'measured pause sync sent');
  const sent = host.sent.find(f => f.t >= m.pause_click_at && f.data.type === 'sync' && f.data.action === 'pause');
  m.sync_sent_at = sent.t;
  const echo = () => host.frames.find(f => f.t >= sent.t && f.data.type === 'sync' && f.data.action === 'pause'
    && f.data.timestamp === sent.data.timestamp && f.data.videoId === sent.data.videoId);
  const bot = () => host.frames.find(f => f.t >= (m.chat_sent_at ?? host.t0) && isBot(f));
  const queue = () => host.frames.find(f => f.t >= (m.chat_sent_at ?? host.t0) && f.data.type === 'queue_update');
  // Keep observing up to 20s if either the echo or relevant response is absent.
  const end = sent.t + 20000;
  while (Date.now() < end && !(echo() && (ctx.condition === 'url' ? queue() : bot()))) await sleep(50);
  m.sync_echo_at = echo()?.t ?? null;
  m.sync_echo_ms = echo() ? echo().t - sent.t : null;
  m.echo_within_5s = m.sync_echo_ms !== null && m.sync_echo_ms <= 5000;
  m.bot_chat_at = bot()?.t ?? null;
  m.bot_chat_since_send_ms = bot() ? bot().t - (m.chat_sent_at ?? host.t0) : null;
  m.queue_update_at = queue()?.t ?? null;
  return s.finish();
}
