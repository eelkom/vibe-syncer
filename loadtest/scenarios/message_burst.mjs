import { launch, tab, enter, chatReady, chatText, settleChat, scriptedUser } from '../lib/browser.mjs';
import { connectSocket } from '../lib/socket.mjs';
import { until } from '../lib/common.mjs';
import { countMarkers } from '../lib/stats.mjs';
export async function run({ cleanup, result, seed, condition, runNumber }) {
  const browser = await launch(cleanup, true);
  const observer = await tab(browser, seed.guest, result, cleanup);
  const stopUser = scriptedUser(observer, cleanup, result);
  await enter(observer, seed.room); await chatReady(observer);
  const sender = await connectSocket(seed.room, seed.sender, cleanup);
  const control = await connectSocket(seed.room, seed.host, cleanup);
  const n = Number(condition), markers = Array.from({ length: n }, (_, i) => `m-${runNumber}-${i + 1}`);
  const start = Date.now();
  // Deliberately synchronous: no await, pacing, adaptive batch size, or retry.
  for (const message of markers) sender.send(JSON.stringify({ type: 'chat', message }));
  const received = () => control.frames.filter(f => f.data.type === 'chat' && markers.includes(f.data.message));
  await until(() => new Set(received().map(f => f.data.message)).size === n || Date.now() - start >= 120000, 121000, 'control burst deadline');
  await settleChat(observer);
  await stopUser();
  const text = await chatText(observer), counts = countMarkers(text, markers);
  return { n, control_received: received().length, on_screen_unique: counts.unique,
    delivery_ratio: counts.unique / n, missing: counts.missing, duplicates: counts.duplicates,
    elapsed_ms: Date.now() - start,
    raw: { start, control_frames: control.frames, observer_frames: observer.frames, text, counts: counts.counts, clicks: observer.clicks },
  };
}
