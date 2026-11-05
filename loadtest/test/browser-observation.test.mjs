import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { tab, scriptedUser } from '../lib/browser.mjs';
import { deadline } from '../lib/common.mjs';

test('scripted user waits 1000ms, uses latest console coordinates, and never evaluates the page', async () => {
  const page = new EventEmitter(), calls = [], errors = [];
  for (const method of ['evaluate', 'locator', 'getByRole', 'exposeBinding', 'exposeFunction']) {
    page[method] = () => { throw new Error(`Forbidden pre-click operation: ${method}`); };
  }
  let resolveClick;
  const clicked = new Promise(resolve => { resolveClick = resolve; });
  page.mouse = { async click(x, y) { calls.push({ x, y, t: Date.now() }); resolveClick(); } };
  const state = { page, clicks: [] };
  const stop = scriptedUser(state, [], { errors });
  const firstSeen = Date.now();
  const notify = (x, y) => page.emit('console', {
    text: () => `__stage1_button ${JSON.stringify({ t: Date.now(), button: { kind: 'sync', x, y } })}`,
  });
  notify(10, 20);
  const moved = setTimeout(() => notify(30, 40), 250);
  try { await deadline(clicked, 2500, 'scripted mouse input'); }
  finally { clearTimeout(moved); await stop(); }
  assert.equal(calls.length, 1);
  assert.deepEqual([calls[0].x, calls[0].y], [30, 40]);
  assert.ok(calls[0].t - firstSeen >= 1000);
  assert.equal(state.clicks[0].ok, null); // Judgement is deferred until observation ends.
  assert.deepEqual(errors, []);
});

async function instrumentation(condition = 'muted-allowed') {
  let init, args;
  const page = new EventEmitter();
  const context = { async addInitScript(fn, data) { init = fn; args = data; }, async newPage() { return page; } };
  await tab({ async newContext() { return context; } }, { nickname: 'observer' }, { errors: [] }, [], condition);
  const timers = [], messages = [];
  class NativeWebSocket extends EventTarget {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    constructor(...values) { super(); this.values = values; }
  }
  const window = { WebSocket: NativeWebSocket };
  const document = { addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; } };
  const navigator = { userActivation: { hasBeenActive: false } };
  class Element {
    setAttribute(name, value) { this.attributes ??= {}; this.attributes[name] = value; }
  }
  class HTMLMediaElement extends Element {
    play() { this.nativePlayCalls = (this.nativePlayCalls ?? 0) + 1; return Promise.resolve('native playback'); }
    get autoplay() { return this.autoplayValue ?? false; }
    set autoplay(value) { this.autoplayValue = value; }
  }
  const sandbox = { window, document, navigator, Element, HTMLMediaElement, DOMException, sessionStorage: { setItem() {} },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    setInterval(fn, delay) { timers.push({ fn, delay }); },
    console: { debug(...values) { messages.push(values); } } };
  vm.runInNewContext(`(${init.toString()})(${JSON.stringify(args)})`, sandbox);
  return { window, document, navigator, timers, messages, NativeWebSocket, HTMLMediaElement };
}

test('WebSocket instrumentation preserves native construction, constants and instanceof, and logs failed attempts', async () => {
  const { window, NativeWebSocket } = await instrumentation();
  const Wrapped = window.WebSocket;
  for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) assert.equal(Wrapped[key], NativeWebSocket[key]);
  const failed = new Wrapped('ws://127.0.0.1:18000/ws/test', ['test']);
  assert.ok(failed instanceof Wrapped);
  assert.ok(failed instanceof NativeWebSocket);
  assert.equal(failed.values[0], 'ws://127.0.0.1:18000/ws/test');
  assert.equal(failed.values[1][0], 'test');
  const close = new Event('close');
  Object.defineProperty(close, 'code', { value: 1006 });
  failed.dispatchEvent(close);
  assert.equal(window.__wsLog.length, 1);
  assert.equal(window.__wsLog[0].open_at, null);
  assert.equal(window.__wsLog[0].code, 1006);
  assert.ok(window.__wsLog[0].close_at >= window.__wsLog[0].created_at);
  class Child extends Wrapped {}
  const opened = new Child('ws://127.0.0.1:18000/ws/test');
  assert.ok(opened instanceof Child);
  assert.ok(opened instanceof NativeWebSocket);
  opened.dispatchEvent(new Event('open'));
  assert.ok(window.__wsLog[1].open_at >= window.__wsLog[1].created_at);
  assert.throws(() => Wrapped('ws://127.0.0.1'), /class constructor|without 'new'/i);
  assert.equal(window.__wsLog.length, 2);
});

test('all-blocked still rejects immediately and blocks both autoplay paths before activation', async () => {
  const { window, navigator, HTMLMediaElement } = await instrumentation('all-blocked');
  const media = new HTMLMediaElement();
  await assert.rejects(media.play(), { name: 'NotAllowedError' });
  media.setAttribute('autoplay', ''); media.autoplay = true;
  assert.equal(media.nativePlayCalls ?? 0, 0);
  assert.equal(media.attributes?.autoplay, undefined);
  assert.equal(media.autoplay, false);
  assert.equal(window.__blockedPlay, 3);
  navigator.userActivation.hasBeenActive = true;
  assert.equal(await media.play(), 'native playback');
  media.setAttribute('autoplay', ''); media.autoplay = true;
  assert.equal(media.nativePlayCalls, 1);
  assert.equal(media.attributes.autoplay, '');
  assert.equal(media.autoplay, true);
  assert.equal(window.__blockedPlay, 3);
});
test('silent-blocked leaves play pending without starting playback and resumes native calls only after activation', async () => {
  const { window, navigator, HTMLMediaElement } = await instrumentation('silent-blocked');
  const media = new HTMLMediaElement();
  let settled = false;
  media.play().then(() => { settled = true; }, () => { settled = true; });
  media.setAttribute('autoplay', ''); media.autoplay = true;
  await Promise.resolve(); await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(media.nativePlayCalls ?? 0, 0);
  assert.equal(media.autoplay, false);
  assert.equal(media.attributes?.autoplay, undefined);
  assert.equal(window.__blockedPlay, 3);
  navigator.userActivation.hasBeenActive = true;
  await Promise.resolve();
  assert.equal(media.nativePlayCalls ?? 0, 0); // The instrument does not issue play itself.
  assert.equal(await media.play(), 'native playback');
  media.setAttribute('autoplay', ''); media.autoplay = true;
  assert.equal(media.nativePlayCalls, 1);
  assert.equal(media.autoplay, true);
  assert.equal(media.attributes.autoplay, '');
  assert.equal(settled, false);
  assert.equal(window.__blockedPlay, 3);
});
test('muted-allowed does not inject play or autoplay blocking', async () => {
  const { window, HTMLMediaElement } = await instrumentation();
  const media = new HTMLMediaElement();
  assert.equal(await media.play(), 'native playback');
  media.autoplay = true;
  assert.equal(media.autoplay, true);
  assert.equal(window.__blockedPlay, 0);
});

test('page timers emit only changed button coordinates and sample activation even without media', async () => {
  const { window, document, navigator, timers, messages } = await instrumentation();
  const detect = timers.find(timer => timer.delay === 250).fn;
  let x = 10;
  const button = { getBoundingClientRect: () => ({ x, y: 20, width: 40, height: 50 }) };
  document.querySelectorAll = selector => selector === 'button.animate-pulse' ? [button] : [];
  detect(); detect();
  assert.equal(messages.length, 1);
  assert.equal(messages[0][0], '__stage1_button');
  assert.deepEqual(JSON.parse(messages[0][1]).button, { kind: 'sync', x: 30, y: 45 });
  x = 20; detect();
  assert.equal(messages.length, 2);
  assert.equal(JSON.parse(messages[1][1]).button.x, 40);
  document.querySelectorAll = () => [];
  detect();
  assert.equal(JSON.parse(messages[2][1]).button, null);
  const sample = timers.find(timer => timer.delay === 100).fn;
  sample(); navigator.userActivation.hasBeenActive = true; sample();
  assert.equal(window.__samples[0].act, false);
  assert.equal(window.__samples[1].act, true);
});
