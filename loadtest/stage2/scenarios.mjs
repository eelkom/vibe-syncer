import { sleep, until, deadline, FRONT } from '../lib/common.mjs';
import { input, settleWithin } from './browser.mjs';
export async function waitAdmission(ctx, start = Date.now()) {
  const connected = () => Number(ctx.host.connected) + Number(ctx.guest.connected) + ctx.bots.status.connected + Number(ctx.joiner?.connected ?? false);
  await until(() => connected() >= ctx.job.n || Date.now() - start >= 60000, 61000, 'admission deadline');
  ctx.result.connected_at_setup = connected();
  ctx.result.setup_failed = connected() < ctx.job.n;
  if (ctx.result.setup_failed) {
    ctx.start = start; ctx.end = Date.now() + 30000;
    await sleep(30000); // Service failure observation, never retried/marked a script failure.
  }
  return !ctx.result.setup_failed;
}
export function inputQueue(ctx) {
  let sequence = 0, pending = Promise.resolve(), stopped = false;
  return { enqueue(checkpoint = null) {
    pending = pending.then(() => {
      if (!stopped) return input(ctx.guest, ++sequence, attempt => { attempt.checkpoint = checkpoint; ctx.inputs.push(attempt); });
    }); pending.catch(() => {});
  }, async finish(timeout = 30000) {
    try {
      const done = await settleWithin(pending, timeout);
      if (done.timedOut) ctx.input_stuck = true;
      return !done.timedOut;
    } finally { stopped = true; }
  } };
}
export function seekCoordinates(box, currentTime, duration) {
  if (!box || ![currentTime, duration, box.left, box.width, box.y].every(Number.isFinite) || duration <= 0 || box.width <= 16) {
    throw new Error('Host seek controls unavailable');
  }
  const target = currentTime + 120 > duration ? currentTime - 120 : currentTime + 120;
  const trackWidth = box.width - 16;
  const currentX = box.left + 8 + currentTime / duration * trackWidth;
  const x = box.left + 8 + target / duration * trackWidth;
  if (target < 0 || target > duration || Math.abs(x - currentX) <= 8) throw new Error('Seek target does not clear the 16px thumb');
  return { x, y: box.y, target };
}
export async function hostAction(ctx, action) {
  const state = ctx.host, start = Date.now();
  if (action === 'seek') {
    const box = state.controls.seek, media = state.media;
    if (!box || !media || !Number.isFinite(media.duration) || !media.duration) throw new Error('Host seek controls unavailable');
    // Native Chromium range thumb is 16px. +120s clears it at the 600s
    // fixture's 229px track; near the end go -120s instead of clamping.
    // Record the actual sync timestamp, which reflects pointer pixel resolution.
    const ct = media.ct + (media.paused ? 0 : (Date.now() - state.media_at) / 1000);
    const target = seekCoordinates(box, ct, media.duration);
    await state.page.mouse.click(target.x, target.y);
  } else {
    const box = state.controls.play;
    if (!box) throw new Error('Host playback button unavailable');
    await state.page.mouse.click(box.x, box.y);
  }
  const waitStarted = Date.now();
  while (!state.sent.some(f => f.t >= start && f.data.action === action) && Date.now() - waitStarted < 5000) await sleep(50);
  const frame = state.sent.find(f => f.t >= start && f.data.action === action);
  if (!frame) {
    ctx.host_action_timeouts = (ctx.host_action_timeouts ?? 0) + 1;
    (ctx.host_action_failures ??= []).push({ t: start, action });
    return;
  }
  ctx.actions.push({ t: frame.t, action, timestamp: frame.data.timestamp });
}
export async function runScenario(ctx) {
  const { job, smoke } = ctx;
  if (job.scenario === 'join_burst') return joinBurst(ctx);
  const admissionStart = Date.now();
  await ctx.bots.admit({ room: ctx.seed.room.room_code, count: job.n - 2 });
  if (!await waitAdmission(ctx, admissionStart)) return;
  await sleep(job.scenario === 'chat_burst' ? 5000 : 10000);
  ctx.start = Date.now();
  const queue = inputQueue(ctx);
  if (job.scenario === 'chat_accumulation') {
    const total = smoke ? 500 : 10000;
    ctx.guest.onCheckpoint = checkpoint => { ctx.checkpointInputs.push({ ...checkpoint, input_index: ctx.inputs.length }); queue.enqueue(checkpoint.target); };
    await ctx.bots.traffic({ mode: 'accumulation', total });
    await until(() => ctx.guest.checkpoints.some(c => c.target === total) || Date.now() - ctx.start >= 300000, 301000, 'accumulation deadline');
    const finished = await queue.finish(Math.max(1, ctx.start + 300000 - Date.now()));
    if (finished) await until(() => ctx.inputs.every(i => ctx.guest.delivered.has(i.marker)) || Date.now() - ctx.start >= 300000,
      Math.max(1, ctx.start + 300000 - Date.now()) + 1000, 'checkpoint input echoes');
    // Fixed paint/event-timing tail, still inside the overall 300s bound.
    await sleep(Math.min(1000, Math.max(0, ctx.start + 300000 - Date.now())));
    ctx.end = Math.min(Date.now(), ctx.start + 300000); ctx.guest.onCheckpoint = null; return;
  }
  const seconds = job.scenario === 'steady' ? (smoke ? 20 : 60) : (smoke ? 10 : 30);
  if (job.n > 2) await ctx.bots.traffic({ mode: job.scenario === 'steady' ? 'steady' : 'burst', seconds });
  const events = [];
  for (let ms = job.scenario === 'steady' ? 5000 : 2000; ms < seconds * 1000; ms += job.scenario === 'steady' ? 5000 : 2000) events.push({ ms, input: true });
  if (job.scenario === 'steady') {
    if (job.n === 2) for (let ms = 0; ms < seconds * 1000; ms += 500) events.push({ ms, input: true });
    for (let ms = 15000; ms < seconds * 1000; ms += 33000) {
      events.push({ ms, action: 'pause' });
      if (ms + 3000 < seconds * 1000) events.push({ ms: ms + 3000, action: 'play' });
      if (ms + 18000 < seconds * 1000) events.push({ ms: ms + 18000, action: 'seek' });
    }
  }
  events.sort((a, b) => a.ms - b.ms);
  for (const event of events) {
    await sleep(Math.max(0, ctx.start + event.ms - Date.now()));
    if (event.input) queue.enqueue(); else await hostAction(ctx, event.action);
  }
  await sleep(Math.max(0, ctx.start + seconds * 1000 - Date.now()));
  await queue.finish();
  if (job.scenario === 'chat_burst') {
    // Fixed 30s drain upper bound; no page queries to end early based on good results.
    await sleep(30000);
  }
  ctx.end = Date.now(); ctx.trafficEnd = ctx.start + seconds * 1000;
}
async function joinBurst(ctx) {
  await sleep(10000);
  const start = ctx.start = Date.now();
  await ctx.bots.admit({ room: ctx.seed.room.room_code, count: ctx.job.n - 3, burst: true });
  const entrant = ctx.joiner;
  const flow = (async () => {
    await sleep(Math.max(0, start + 1500 - Date.now()));
    await entrant.page.goto(FRONT, { waitUntil: 'domcontentloaded' });
    await until(() => entrant.controls.join_existing, 15000, 'landing Join Existing Room');
    let box = entrant.controls.join_existing; await entrant.page.mouse.click(box.x, box.y);
    await until(() => entrant.controls.room && entrant.controls.nickname && entrant.controls.join_submit, 10000, 'join form');
    box = entrant.controls.room; await entrant.page.mouse.click(box.x, box.y); await entrant.page.keyboard.type(ctx.seed.room.room_code);
    box = entrant.controls.nickname; await entrant.page.mouse.click(box.x, box.y); await entrant.page.keyboard.type('entrant');
    box = entrant.controls.join_submit; ctx.joinSubmit = Date.now(); await entrant.page.mouse.click(box.x, box.y);
  })();
  // Flow errors are script errors; join HTTP/rejection with no navigation is a service failure.
  await deadline(flow, 60000, 'entrant UI flow');
  if (!await waitAdmission(ctx, start)) return;
  await sleep(ctx.smoke ? 10000 : 30000); ctx.end = Date.now();
}
