import { launch, tab, enter, chatText, scriptedUser } from '../lib/browser.mjs';
import { connectSocket } from '../lib/socket.mjs';
import { deferred, deadline, sleep, until } from '../lib/common.mjs';
import { countMarkers } from '../lib/stats.mjs';
export async function run({ cleanup, result, seed, smoke }) {
  const browser = await launch(cleanup, true);
  const observer = await tab(browser, seed.guest, result, cleanup);
  const stopUser = scriptedUser(observer, cleanup, result);
  const sender = await connectSocket(seed.room, seed.sender, cleanup);
  const held = deferred(), sendQuery = deferred(), responseHeld = deferred(), deliver = deferred();
  let intercepted = false;
  // A GET only: preflight OPTIONS must go straight through the context guard.
  await observer.page.route(/\/chats(?:\?|$)/, async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    if (intercepted) {
      result.errors.push('Unexpected repeated history GET');
      return route.abort();
    }
    intercepted = true; held.resolve();
    try {
      await sendQuery.promise;
      const response = await route.fetch();
      if (response.status() !== 200) throw new Error(`History HTTP ${response.status()}`);
      responseHeld.resolve({ status: response.status(), body: await response.text() });
      await deliver.promise;
      await route.fulfill({ response });
    } catch (error) {
      responseHeld.reject(error);
      result.errors.push(`history interception: ${error.message}`);
      try { await route.abort(); } catch {}
    }
  });
  // Release pending interception even on a failure, before the context closes.
  cleanup.push(async () => { sendQuery.resolve(); deliver.resolve(); });
  await enter(observer, seed.room);
  await deadline(held.promise, 15000, 'history GET interception');
  await until(() => observer.attempts.length && observer.frames.length, 15000,
    'WS receive while history GET held; impossible ordering must be reported');
  const n = smoke ? 5 : 25;
  const a = Array.from({ length: n }, (_, i) => `a-${i + 1}`), b = Array.from({ length: n }, (_, i) => `b-${i + 1}`);
  const events = [{ event: 'query-held-before-server', t: Date.now() }];
  const send = async markers => {
    for (const message of markers) { sender.send(JSON.stringify({ type: 'chat', message })); await sleep(20); }
    await until(() => observer.frames.some(f => f.data.type === 'chat' && f.data.message === markers.at(-1)), 15000, 'last stage marker frame');
  };
  await send(a); events.push({ event: 'A-received', t: Date.now() });
  sendQuery.resolve();
  const snapshot = await deadline(responseHeld.promise, 15000, 'history response held');
  events.push({ event: 'query-response-held', t: Date.now() });
  const snapshotMessages = JSON.parse(snapshot.body).map(m => m.message);
  if (!a.every(m => snapshotMessages.includes(m)) || b.some(m => snapshotMessages.includes(m))) throw new Error('History snapshot does not meet A/B contract');
  await send(b); events.push({ event: 'B-received', t: Date.now() });
  deliver.resolve(); events.push({ event: 'query-response-delivered', t: Date.now() });
  await until(() => observer.responses.some(r => /\/chats(?:\?|$)/.test(r.url)), 15000, 'history response delivered');
  await sleep(smoke ? 3000 : 12000);
  await stopUser();
  const text = await chatText(observer), ca = countMarkers(text, a), cb = countMarkers(text, b);
  return { lost_a: ca.missing.length, lost_b: cb.missing.length, dup_a: ca.duplicates, dup_b: cb.duplicates,
    lost_total: ca.missing.length + cb.missing.length, dup_total: ca.duplicates + cb.duplicates,
    on_screen_total: ca.unique + cb.unique + ca.duplicates + cb.duplicates,
    injection: '지연 주입: GET /chats 서버 전송 전 및 응답 전달 전 보류',
    raw: { events, snapshot, observer_frames: observer.frames, text, counts_a: ca, counts_b: cb, clicks: observer.clicks },
  };
}
