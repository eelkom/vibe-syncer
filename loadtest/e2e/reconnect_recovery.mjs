import { e2eMain } from '../lib/sync-e2e.mjs';
import { session, waitOpen, delayTo } from '../lib/sync-session.mjs';
import { dropSocket, restoreSocket } from '../lib/browser.mjs';
import { connectSocket } from '../lib/socket.mjs';
import { API, sleep, until } from '../lib/common.mjs';

await e2eMain('reconnect_recovery', async ctx => {
  const requests = [];
  const s = await session({ ...ctx, condition: 'local', smoke: false }, { prepared: true,
    beforeGuestEnter: async state => state.page.on('request', request => {
      if (request.method() === 'GET' && /\/(queue_list|chats)(?:\?|$)/.test(request.url())) requests.push({ t: Date.now(), url: request.url() });
    }),
  });
  const guest = await s.join(), m = s.metrics;
  const sender = await connectSocket(ctx.seed.room, ctx.seed.sender, ctx.cleanup);
  await until(() => sender.frames.some(f => f.data.type === 'chat' && f.data.user_id === 0), 15000, 'sender welcome');
  await until(() => guest.responses.some(r => /\/queue_list(?:\?|$)/.test(r.url) && r.finished_at)
    && guest.responses.some(r => /\/chats(?:\?|$)/.test(r.url) && r.finished_at), 15000, 'guest initial queries');
  await sleep(2000);
  await s.stopGuestUser();
  const marker = `reconnect-chat-${Date.now()}`, title = `Reconnect song ${Date.now()}`;
  const displays = { chat: null, song: null };
  // Installed before disconnection and never evaluated during recovery. DOM
  // changes report via console, with no bringToFront, locator or focus event.
  guest.page.on('console', msg => {
    if (!msg.text().startsWith('__recovery_dom ')) return;
    const event = JSON.parse(msg.text().slice('__recovery_dom '.length));
    displays[event.kind] ??= event.t;
  });
  await guest.page.evaluate(({ marker, title }) => {
    const seen = new Set();
    const check = () => {
      const text = document.body.innerText;
      for (const [kind, value] of [['chat', marker], ['song', title]]) {
        if (!seen.has(kind) && text.includes(value)) {
          seen.add(kind);
          console.debug('__recovery_dom ' + JSON.stringify({ kind, t: Date.now() }));
        }
      }
    };
    new MutationObserver(check).observe(document.body, { subtree: true, childList: true, characterData: true });
    check();
    window.__recoveryFocusEvents = [];
    window.addEventListener('focus', () => window.__recoveryFocusEvents.push(Date.now()));
  }, { marker, title });
  m.drop_at = await dropSocket(guest);
  await until(() => guest.probeWsLog.some(row => row.record.close_at >= m.drop_at), 5000, 'guest socket closed');
  m.chat_sent_at = Date.now();
  sender.send(JSON.stringify({ type: 'chat', message: marker }));
  await until(() => sender.frames.some(f => f.data.type === 'chat' && f.data.message === marker), 10000, 'offline chat saved');
  m.song_added_at = Date.now();
  const response = await fetch(`${API}/rooms/${ctx.seed.room.room_code}/queue`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.seed.host.token}` },
    body: JSON.stringify({ title, artist: 'E2E', music_url: 'https://www.youtube.com/watch?v=eRsGyueVLvQ' }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Song addition HTTP ${response.status}: ${await response.text()}`);
  m.song = await response.json();
  m.restore_at = await restoreSocket(guest);
  // Poll Node-owned logs only. No Playwright action touches the page here.
  m.open_at = await waitOpen(guest, m.restore_at, 15000);
  const end = (m.open_at ?? m.restore_at) + 15000;
  await delayTo(end);
  m.chat_display_at = displays.chat;
  m.song_display_at = displays.song;
  for (const kind of ['chat', 'song']) {
    const t = displays[kind];
    m[`${kind}_display_ms`] = m.open_at !== null && t !== null && t <= end ? Math.max(0, t - m.open_at) : null;
    m[`${kind}_since_restore_ms`] = t !== null && t <= end ? t - m.restore_at : null;
  }
  m.raw.focus_events = await guest.page.evaluate(() => window.__recoveryFocusEvents);
  m.focus_events = m.raw.focus_events.filter(t => t >= m.drop_at && t <= end);
  const counts = start => Object.fromEntries(['queue_list', 'chats'].map(name => [name,
    requests.filter(r => r.t >= start && new RegExp(`/${name}(?:\\?|$)`).test(r.url)).length]));
  m.queue_list_requests = counts(-Infinity).queue_list;
  m.chats_requests = counts(-Infinity).chats;
  m.requests_after_restore = counts(m.restore_at);
  m.raw.query_requests = requests;
  await s.finish();
  m.passed = m.open_at !== null && m.chat_display_ms !== null && m.song_display_ms !== null && m.focus_events.length === 0;
  return m;
});
