import path from 'node:path';
import { readFileSync } from 'node:fs';
import { ROOT, FRONT, until } from '../lib/common.mjs';
import { tab as stage1Tab, selectors, scriptedUser } from '../lib/browser.mjs';
import { installCollector } from './collector.mjs';
import { ownBrowser } from './browser-process.mjs';
const { chromium } = await import('playwright');
export async function launchStage2(browsers, precise = false) {
  const server = await chromium.launchServer({ host: '127.0.0.1', headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio',
    '--disable-features=HardwareMediaKeyHandling', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', ...(precise ? ['--enable-precise-memory-info'] : [])] });
  let owner;
  try { owner = ownBrowser(server); } catch (error) { await server.kill(); throw error; }
  browsers.push(owner);
  owner.browser = await chromium.connect(server.wsEndpoint()); return owner.browser;
}
export async function makePage(browser, identity, result, cleanup, profiling = false, checkpoints = []) {
  let state;
  if (identity) {
    // The owned browser closes all contexts. A per-context close can hang on
    // an unresponsive renderer before the browser's forced-exit path runs.
    state = await stage1Tab(browser, identity, result, [], 'muted-allowed', false);
    // Stage2 keeps only sync frames and one readiness token in Node memory.
    state.page.removeAllListeners('websocket');
  } else {
    // Joiner deliberately has no sessionStorage initializer; REST/UI logs in.
    const context = await browser.newContext({ serviceWorkers: 'block' });
    state = { page: await context.newPage(), frames: [], sent: [], attempts: [], clicks: [], consoleErrors: [] };
    state.page.on('request', req => { if (new URL(req.url()).hostname !== '127.0.0.1') result.blocked_external_requests++; });
  }
  state.page.removeAllListeners('console'); state.page.removeAllListeners('pageerror');
  state.controls = {}; state.connected = false; state.checkpoints = []; state.delivered = new Set(); state.deliveredAt = new Map(); state.connectionEvents = []; state.console_error_count = 0;
  const vitals = readFileSync(path.join(ROOT, 'node_modules/web-vitals/dist/web-vitals.iife.js'), 'utf8');
  await state.page.addInitScript({ content: vitals + '\n;window.webVitals=webVitals;' });
  await state.page.addInitScript(installCollector, { profiling, checkpoints });
  state.page.on('crash', () => { state.crashed = true; });
  state.page.on('console', msg => {
    const text = msg.text();
    if (msg.type() === 'error') { state.console_error_count++; if (state.consoleErrors.length < 20) state.consoleErrors.push(text.slice(0, 500)); }
    for (const [prefix, receive] of [['__stage2_controls ', value => { state.controls = value.controls; state.media = value.media; state.media_at = value.t; }],
      ['__stage2_delivered ', value => { state.delivered.add(value.marker); if (!state.deliveredAt.has(value.marker)) state.deliveredAt.set(value.marker, value.t); }],
      ['__stage2_ws ', value => { state.connected = value.connected; state.connectionEvents.push(value); if (value.connected) state.connected_at = value.t; }],
      ['__stage2_checkpoint ', value => { state.checkpoints.push(value); state.onCheckpoint?.(value); }]]) {
      if (text.startsWith(prefix)) receive(JSON.parse(text.slice(prefix.length)));
    }
  });
  state.page.on('pageerror', error => { result.page_error_count = (result.page_error_count ?? 0) + 1; if (result.errors.length < 20) result.errors.push(`page error: ${error.message.slice(0, 500)}`); });
  state.page.on('websocket', ws => {
    if (new URL(ws.url()).hostname !== '127.0.0.1') result.blocked_external_requests++;
    state.attempts.push(Date.now());
    ws.on('framereceived', frame => {
      if (!state.frames.length) state.frames.push({ t: Date.now(), data: { type: 'ready' } });
      if (/"type"\s*:\s*"sync"/.test(frame.payload.toString())) state.frames.push({ t: Date.now(), data: JSON.parse(frame.payload.toString()) });
    });
    ws.on('framesent', frame => { if (/"type"\s*:\s*"sync"/.test(frame.payload.toString())) state.sent.push({ t: Date.now(), data: JSON.parse(frame.payload.toString()) }); });
  });
  return state;
}
export async function navigate(state, room) { state.t0 = Date.now(); await state.page.goto(`${FRONT}/room/${room.room_code}`, { waitUntil: 'domcontentloaded' }); }
export async function readyGuest(state, room, cleanup, result) {
  const stop = scriptedUser(state, cleanup, result);
  await navigate(state, room);
  await until(() => state.connected && state.controls.input && state.clicks.length >= 1 && state.media && !state.media.muted && !state.media.paused, 20000, 'guest connected and unmute clicked once');
  await stop();
}
// Only a timer owned here is a known non-response. Rejections from Playwright
// or evaluated code remain script errors; closed/crashed browsers are ambiguous.
export async function settleWithin(promise, ms) {
  const expired = Symbol('expired'); let timer;
  try {
    const value = await Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(expired), ms); })]);
    return value === expired ? { timedOut: true } : { timedOut: false, value };
  } finally { clearTimeout(timer); }
}
export async function readPage(state, timeout = 15000) {
  const snapshot = await settleWithin(state.page.evaluate(() => {
    const s = window.__stage2;
    return { ...s, displayed: s.displayed() };
  }), timeout);
  if (!snapshot.timedOut) return snapshot.value;
  if (state.crashed || state.page.isClosed() || !state.page.context().browser()?.isConnected()) {
    throw new Error('Final snapshot timed out with a closed/crashed page or disconnected browser');
  }
  state.unresponsive = true;
  return null;
}
export async function input(state, sequence, onStart = () => {}) {
  const control = state.controls.input;
  if (!control) throw new Error('Chat input coordinates unavailable');
  const start = Date.now(), marker = `c-g-${sequence}-${start}`;
  const attempt = { marker, start, end: null }; onStart(attempt);
  await state.page.mouse.click(control.x, control.y);
  await state.page.keyboard.type(marker); await state.page.keyboard.press('Enter');
  attempt.end = Date.now(); return attempt;
}
export { selectors };
