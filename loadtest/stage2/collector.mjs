// Serialized into the page before the app. No Node evaluation is needed to
// obtain controls, checkpoints or connection status during observation.
export function installCollector({ profiling, checkpoints = [] }) {
  const s = window.__stage2 = { samples: [], memory: [], longtasks: [], raf: {}, raf_events: [], commits: [], inp: [],
    inputs: [], candidates: [], sync: [], seeks: [], sent: [], ws: [], checkpoints: [], system: 0, welcome: 0, system_events: [], welcome_events: [], vitals_ready: false };
  const rows = new Map(), nodes = new WeakMap(), touched = new Set();
  let markersReceived = 0, nextCheckpoint = 0, chat = null, lastRAF = null;
  const markerRE = /(?:^|\s)(c-[bg]\d*-\d+-\d+)(?=\s|$)/g;
  const collectText = (node, set) => {
    if (node.nodeType === 3) set.add(node);
    else { const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT); let text; while ((text = walker.nextNode())) set.add(text); }
  };
  const remove = node => { for (const marker of nodes.get(node) ?? []) { rows.get(marker).count--; touched.add(marker); } nodes.delete(node); };
  const add = node => {
    if (nodes.has(node) || !node.isConnected || !chat.contains(node)) return;
    const markers = [...node.textContent.matchAll(markerRE)].map(m => m[1]); nodes.set(node, markers);
    for (const marker of markers) {
      if (!rows.has(marker)) rows.set(marker, { first: null, count: 0, max: 0 });
      rows.get(marker).count++; touched.add(marker);
    }
  };
  const finishMutation = () => {
    const t = Date.now();
    for (const marker of touched) {
      const row = rows.get(marker);
      if (row.count > 0 && row.first === null) { row.first = t; if (/^c-b\d+-/.test(marker)) markersReceived++;
        else console.debug('__stage2_delivered', JSON.stringify({ marker, t })); }
      row.max = Math.max(row.max, row.count);
    }
    touched.clear();
    while (nextCheckpoint < checkpoints.length && markersReceived >= checkpoints[nextCheckpoint]) {
      const checkpoint = { target: checkpoints[nextCheckpoint++], received: markersReceived, t,
        heap: performance.memory?.usedJSHeapSize ?? null, dom_nodes: document.getElementsByTagName('*').length };
      s.checkpoints.push(checkpoint); console.debug('__stage2_checkpoint', JSON.stringify(checkpoint));
    }
  };
  s.displayed = () => [...rows].filter(([, r]) => r.first !== null).map(([m, r]) => [m, r.first, r.max]);
  const hook = { supportsFiber: true, renderers: new Map(),
    inject(renderer) { const id = this.renderers.size + 1; this.renderers.set(id, renderer); return id; },
    onCommitFiberRoot(id, root) { s.commits.push([Date.now(), profiling && Number.isFinite(root.current.actualDuration) ? root.current.actualDuration : null]); },
    onCommitFiberUnmount() {}, onPostCommitFiberRoot() {} };
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;
  const Native = window.WebSocket;
  window.WebSocket = new Proxy(Native, { construct(target, args, newTarget) {
    const record = { created_at: Date.now(), open_at: null, close_at: null, code: null }; s.ws.push(record);
    const socket = Reflect.construct(target, args, newTarget);
    socket.addEventListener('open', () => { record.open_at = Date.now(); console.debug('__stage2_ws', JSON.stringify({ connected: true, t: record.open_at })); });
    socket.addEventListener('close', e => { record.close_at = Date.now(); record.code = e.code; console.debug('__stage2_ws', JSON.stringify({ connected: false, t: record.close_at, code: e.code })); });
    socket.addEventListener('message', event => {
      if (typeof event.data !== 'string') return;
      if (/"type"\s*:\s*"sync"/.test(event.data)) {
        const data = JSON.parse(event.data); s.sync.push({ t: Date.now(), action: data.action, timestamp: data.timestamp });
      }
      if (/"type"\s*:\s*"system"/.test(event.data)) { s.system++; s.system_events.push(Date.now()); }
      if (/"type"\s*:\s*"chat"/.test(event.data) && /"user_id"\s*:\s*0(?:,|\s*})/.test(event.data)) { s.welcome++; s.welcome_events.push(Date.now()); }
    });
    const send = socket.send;
    socket.send = function (data) {
      if (typeof data === 'string') for (const match of data.matchAll(/c-[bg]\d*-\d+-\d+/g)) s.sent.push(match[0]);
      return send.call(this, data);
    };
    return socket;
  } });
  document.addEventListener('seeking', event => { if (event.target.matches?.('audio,video')) s.seeks.push(Date.now()); }, true);
  document.addEventListener('keydown', event => { if (event.isTrusted && event.key === 'Enter' && event.target.matches?.('input[placeholder="Message..."]')) s.inputs.push(Date.now()); }, true);
  try { new PerformanceObserver(list => { for (const e of list.getEntries()) s.longtasks.push([performance.timeOrigin + e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: true }); } catch {}
  try { new PerformanceObserver(list => { for (const e of list.getEntries()) if (e.interactionId) s.candidates.push([performance.timeOrigin + e.startTime, e.duration, e.interactionId]); }).observe({ type: 'event', buffered: true, durationThreshold: 16 }); } catch {}
  const attachVitals = () => {
    if (window.webVitals?.onINP) { s.vitals_ready = true; window.webVitals.onINP(metric => s.inp.push([Date.now(), metric.value]), { reportAllChanges: true }); }
  };
  document.addEventListener('DOMContentLoaded', attachVitals, { once: true });
  const raf = t => {
    if (lastRAF !== null) {
      const second = Math.floor(Date.now() / 1000) * 1000;
      const dropped = Math.max(0, Math.round((t - lastRAF) / 16.67) - 1);
      s.raf[second] ??= [0, 0]; s.raf[second][0]++; s.raf[second][1] += dropped; s.raf_events.push([Date.now(), dropped]);
    }
    lastRAF = t; requestAnimationFrame(raf);
  }; requestAnimationFrame(raf);
  setInterval(() => {
    const el = document.querySelector('audio,video');
    s.samples.push(el ? { t: Date.now(), ct: el.currentTime, paused: el.paused, muted: el.muted, volume: el.volume } : { t: Date.now(), none: true });
  }, 100);
  setInterval(() => s.memory.push([Date.now(), performance.memory?.usedJSHeapSize ?? null, document.getElementsByTagName('*').length]), 1000);
  let previous = '';
  const box = el => {
    if (!el) return null;
    const rect = el.getBoundingClientRect(), css = getComputedStyle(el);
    if (!rect.width || !rect.height || css.visibility === 'hidden' || css.display === 'none') return null;
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, left: rect.x, width: rect.width };
  };
  setInterval(() => {
    if (!chat) {
      const title = [...document.querySelectorAll('h2')].find(el => el.textContent.trim() === 'Chat');
      chat = title?.parentElement?.parentElement?.querySelector(':scope > div.scrollbar-hide.overflow-y-auto');
      if (chat) {
        const initial = new Set(); collectText(chat, initial); initial.forEach(add); finishMutation();
        new MutationObserver(records => {
          const removed = new Set(), added = new Set();
          for (const r of records) {
            if (r.type === 'characterData') { removed.add(r.target); added.add(r.target); }
            else { r.removedNodes.forEach(n => collectText(n, removed)); r.addedNodes.forEach(n => collectText(n, added)); }
          }
          removed.forEach(remove); added.forEach(add); finishMutation();
        }).observe(chat, { childList: true, subtree: true, characterData: true });
      }
    }
    const buttons = [...document.querySelectorAll('button')];
    const controls = { input: box(document.querySelector('input[placeholder="Message..."]')), play: box(document.querySelector('button.h-14')),
      seek: box(document.querySelector('input[type="range"]')), join_existing: box(buttons.find(b => b.textContent.trim() === 'Join Existing Room')),
      room: box(document.querySelector('#roomCode')), nickname: box(document.querySelector('#nickName')),
      join_submit: box(buttons.find(b => b.type === 'submit' && b.textContent.trim() === 'Join Room')) };
    const media = document.querySelector('audio,video');
    const payload = { controls, media: media ? { ct: media.currentTime, duration: media.duration, paused: media.paused, muted: media.muted, volume: media.volume } : null };
    const text = JSON.stringify(payload);
    if (text !== previous) { previous = text; console.debug('__stage2_controls', JSON.stringify({ ...payload, t: Date.now() })); }
  }, 250);
}
