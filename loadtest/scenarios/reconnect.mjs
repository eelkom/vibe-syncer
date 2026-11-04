import WebSocket from 'ws';
import { guest } from '../lib/database.mjs';
import { socketURL } from '../lib/socket.mjs';
import { sleep, until } from '../lib/common.mjs';
import { MAX_ATTEMPTS, reconnectDelay } from '../lib/reconnect-policy.mjs';
import { peakPerSecond, stddev } from '../lib/stats.mjs';

export async function run(ctx) {
  return ctx.condition === 'browser-10' ? browserRun(ctx) : botRun(ctx);
}
async function botRun({ cleanup, result, seed, smoke, condition, restart }) {
  const count = smoke ? 10 : 200;
  const traces = [];
  result.metrics = { raw: { bots: traces } };
  let stopped = false, outageAt = null;
  const bots = [];
  cleanup.push(async () => {
    stopped = true;
    for (const bot of bots) {
      clearTimeout(bot.timer);
      if (bot.socket && bot.socket.readyState !== WebSocket.CLOSED) bot.socket.terminate();
    }
  });
  // Obtain all identities via REST before connecting at the fixed 20/s rate.
  const identities = [];
  for (let i = 0; i < count; i++) identities.push(await guest(seed.room, `bot-${i}`));
  function connect(bot) {
    if (stopped) return;
    bot.trace.attempts.push(Date.now());
    const ws = new WebSocket(socketURL(seed.room, bot.user));
    bot.socket = ws;
    ws.on('message', () => { bot.trace.received_frames++; });
    ws.on('error', error => bot.trace.errors.push({ t: Date.now(), message: error.message }));
    ws.on('open', () => {
      bot.trace.opens.push(Date.now());
      bot.attempt = 0; // Source onopen reset, even if the later connection closes.
      bot.connected = true;
    });
    ws.on('close', (code, reason) => {
      bot.connected = false;
      bot.trace.closes.push({ t: Date.now(), code, reason: reason.toString() });
      if (stopped) return;
      if (bot.attempt < MAX_ATTEMPTS) {
        const delay = reconnectDelay(condition, bot.attempt);
        bot.trace.delays.push({ t: Date.now(), attempt: bot.attempt, delay });
        bot.timer = setTimeout(() => { bot.attempt++; connect(bot); }, delay);
      } else bot.trace.gave_up_at = Date.now();
    });
  }
  const admissionStart = Date.now();
  for (let i = 0; i < count; i++) {
    await sleep(Math.max(0, admissionStart + i * 50 - Date.now()));
    const trace = { id: i, attempts: [], opens: [], closes: [], delays: [], errors: [], received_frames: 0, gave_up_at: null };
    traces.push(trace);
    const bot = { user: identities[i], trace, attempt: 0, connected: false, socket: null, timer: null };
    bots.push(bot); connect(bot);
  }
  await until(() => bots.every(b => b.connected), 30000, 'all initial bot connections');
  await sleep(smoke ? 2000 : 10000);
  outageAt = Date.now();
  result.metrics.raw.outage_at = outageAt;
  const server = await restart();
  const listenAt = server.listenAt;
  result.metrics.raw.listen_at = listenAt;
  await until(() => bots.every(b => b.connected || b.trace.gave_up_at !== null) || Date.now() - outageAt >= 120000,
    121000, 'bot reconnect completion');
  const reconnected = bots.filter(b => b.connected && b.trace.opens.some(t => t >= listenAt));
  const pending = bots.filter(b => !b.connected && b.trace.gave_up_at === null).length;
  if (pending) result.errors.push(`${pending} bots hit 120s limit without reconnecting or exhausting retries`);
  const attempts = traces.flatMap(b => b.attempts).filter(t => t >= outageAt);
  const opens = traces.flatMap(b => b.opens).filter(t => t >= listenAt);
  return {
    peak_attempts_per_s: peakPerSecond(attempts, outageAt),
    peak_opens_per_s: peakPerSecond(opens, listenAt),
    time_to_all_reconnected_ms: reconnected.length === count
      ? Math.max(...reconnected.map(b => b.trace.opens.find(t => t >= listenAt))) - listenAt : null,
    reconnected: reconnected.length, gave_up: bots.filter(b => b.trace.gave_up_at !== null).length,
    pending, bot_count: count, raw: result.metrics.raw,
  };
}
async function browserRun({ cleanup, result, seed, smoke, restart }) {
  const { launch, tab, enter, scriptedUser } = await import('../lib/browser.mjs');
  const count = smoke ? 2 : 10, browser = await launch(cleanup, true), tabs = [];
  const records = [];
  result.metrics = { raw: { tabs: records } };
  for (let i = 0; i < count; i++) {
    const identity = await guest(seed.room, `tab-${i}`);
    const state = await tab(browser, identity, result, cleanup);
    scriptedUser(state, cleanup, result);
    records.push({ id: i, attempts: state.attempts });
    tabs.push(state);
    await enter(state, seed.room);
  }
  await until(() => tabs.every(t => t.frames.length > 0), 20000, 'initial browser WS receives');
  await sleep(smoke ? 2000 : 10000);
  const outageAt = Date.now();
  result.metrics.raw.outage_at = outageAt;
  const server = await restart();
  result.metrics.raw.listen_at = server.listenAt;
  // Five source retries can last 31s total; 120s is a fixed upper bound.
  await until(() => tabs.every(t => t.frames.some(f => f.t >= server.listenAt)) || Date.now() - outageAt >= 120000,
    121000, 'browser reconnect completion');
  const first = tabs.map(t => t.attempts.find(time => time >= outageAt)).map(t => t === undefined ? null : t - outageAt);
  const valid = first.filter(t => t !== null);
  records.forEach((record, i) => { record.first_retry_ms = first[i]; });
  return { first_retry_range_ms: valid.length === count ? Math.max(...valid) - Math.min(...valid) : null,
    first_retry_stddev_ms: valid.length === count ? stddev(valid) : null,
    missing_first_retry: count - valid.length, raw: result.metrics.raw };
}
