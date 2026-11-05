import WebSocket from 'ws';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { reconnectDelay, MAX_ATTEMPTS } from '../lib/reconnect-policy.mjs';
import { receiveControl, controlRows } from './control.mjs';
const delay = monitorEventLoopDelay({ resolution: 20 }); delay.enable();
const bots = [], sent = [], control = new Map(), timers = new Set(), aborts = new Set();
let closed = false, sequence = 0, admissionStart, controlIndex = 0;
const status = () => ({ connected: bots.filter(b => b.connected).length, attempted: bots.length,
  admission_failed: bots.filter(b => b.admission_error).length, gave_up: bots.filter(b => b.gave_up).length });
const schedule = (fn, ms) => { const timer = setTimeout(() => { timers.delete(timer); if (!closed) fn(); }, ms); timers.add(timer); return timer; };
const mark = (source, seq, t) => `c-${source}-${seq}-${t}`;
function open(bot, url) {
  if (closed) return;
  bot.attempts.push(Date.now());
  const socket = new WebSocket(url); bot.socket = socket;
  socket.on('error', error => { bot.last_error = error.message.slice(0, 500); });
  socket.on('open', () => { bot.connected = true; bot.retry = 0; bot.opens.push(Date.now()); bot.join_ms ??= Date.now() - bot.started_at; process.send?.({ type: 'status', ...status() }); });
  socket.on('message', buffer => {
    bot.received++;
    // Parse markers only, never JSON-decode every join/welcome/chat frame.
    if (bot.id === controlIndex) receiveControl(control, buffer);
  });
  socket.on('close', code => {
    bot.connected = false; bot.closes.push([Date.now(), code]);
    process.send?.({ type: 'status', ...status() });
    if (closed) return;
    if (bot.retry < MAX_ATTEMPTS) {
      const wait = reconnectDelay('full-jitter', bot.retry);
      schedule(() => { bot.retry++; open(bot, url); }, wait);
    } else { bot.gave_up = true; process.send?.({ type: 'status', ...status() }); }
  });
}
async function admit(id, config) {
  const bot = { id, started_at: Date.now(), attempts: [], opens: [], closes: [], received: 0, retry: 0, connected: false, gave_up: false, join_ms: null };
  bots.push(bot);
  const abort = new AbortController(); aborts.add(abort);
  const timeout = setTimeout(() => abort.abort(), 60000);
  try {
    const response = await fetch(`http://127.0.0.1:18000/rooms/join`, { method: 'POST', signal: abort.signal,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room_code: config.room, nickname: `bot-${id}` }) });
    if (!response.ok) throw new Error(`join HTTP ${response.status}`);
    const user = await response.json();
    open(bot, `ws://127.0.0.1:18000/ws/${config.room}?token=${encodeURIComponent(user.token)}`);
  } catch (error) { bot.admission_error = error.message.slice(0, 500); process.send?.({ type: 'status', ...status() }); }
  finally { clearTimeout(timeout); aborts.delete(abort); }
}
function sendOne(id) {
  const bot = bots.find(b => b.id === id);
  const t = Date.now(), seq = ++sequence;
  const entry = [id, seq, t, false]; sent.push(entry);
  if (bot?.socket?.readyState === WebSocket.OPEN) {
    bot.socket.send(JSON.stringify({ type: 'chat', message: mark(`b${id}`, seq, t) })); entry[3] = true;
  }
}
function snapshot() {
  return { ...status(), admission_started_at: admissionStart, sent, control: controlRows(control),
    event_loop: { max_ms: delay.count ? delay.max / 1e6 : null, p95_ms: delay.count ? delay.percentile(95) / 1e6 : null },
    bots: bots.map(({ socket, ...bot }) => bot) };
}
process.on('message', message => {
  const reply = data => process.send?.({ reply: message.id, ...data });
  if (message.type === 'admit') {
    admissionStart = Date.now(); controlIndex = 0;
    for (let i = 0; i < message.count; i++) schedule(() => admit(i, message),
      message.burst ? (message.count > 1 ? i * 3000 / message.count : 0) : i * 50);
    reply({ started_at: admissionStart });
  } else if (message.type === 'traffic') {
    const start = Date.now();
    if (message.mode === 'burst') {
      for (let second = 0; second < message.seconds; second++) for (const bot of bots) schedule(() => sendOne(bot.id), second * 1000 + Math.random() * 1000);
    } else {
      const total = message.mode === 'accumulation' ? message.total : Math.floor(message.seconds * 2);
      const gap = message.mode === 'accumulation' ? 5 : 500;
      for (let i = 0; i < total; i++) schedule(() => sendOne(bots.length ? bots[i % bots.length].id : 0), i * gap);
    }
    reply({ started_at: start });
  } else if (message.type === 'snapshot') reply({ data: snapshot() });
  else if (message.type === 'stop') {
    closed = true; for (const timer of timers) clearTimeout(timer); for (const abort of aborts) abort.abort();
    const data = snapshot(); delay.disable();
    for (const bot of bots) bot.socket?.terminate();
    if (process.connected) process.send({ reply: message.id, data }, () => process.exit(0));
    else process.exit(0);
  }
});
process.on('disconnect', () => process.exit(0));
process.send?.({ type: 'ready' });
