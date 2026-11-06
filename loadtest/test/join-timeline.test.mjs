import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JOIN_TIMES, JOIN_INTERVALS, joinTimelineStats } from '../lib/join-timeline-stats.mjs';
import { tab, joinFromLanding } from '../lib/browser.mjs';
import { joinTimelineProbe } from '../lib/join-timeline-probe.mjs';
import { run as runTimeline } from '../scenarios/join_timeline.mjs';
import { parseArgs, resultPath } from '../deploy/join_timeline_deployed.mjs';
import { FRONT, extraHosts, wake, warm, createRoom, addSong, deleteRoom } from '../deploy/late_join_deployed.mjs';
import { ROOT } from '../lib/common.mjs';
import { summarizeSync, syncMarkdown, readSyncRuns } from '../summarize_sync.mjs';

const request = (kind, sent_at, finished_at, method = 'GET') => ({
  url: `https://api.example/rooms/${kind}`, method, sent_at, finished_at,
});
const sample = (t, ct, extra = {}) => ({ t, ct, paused: false, muted: true, src: 'song', ...extra });
function measurement() {
  return { t0: 1000, end: 26000, roomCode: 'ABC', requests: [request('join', 1010, 1110, 'POST'),
    request('ABC/queue_list?cache=1', 1130, 1400), request('ABC/chats', 1140, 1500), request('ABC/', 1150, 1510)],
  events: Object.entries({ room_route: 1120, player_mount: 1450, player_ready: 1700,
    first_seek_start: 1750, first_seek_end: 1800, first_playing: 1810 }).map(([name, t]) => ({ name, t })),
  wsLog: [{ open_at: null }, { open_at: 1190 }], frames: [{ t: 1600, data: { type: 'sync' } }],
  samples: [sample(1850, 30), sample(1950, 30.1, { muted: false })], clicks: [{ kind: 'unmute', t: 1900 }],
  errors: [{ t: 15999, err: 999 }, { t: 16000, err: 10 }, { t: 25999, err: 20 }, { t: 26000, err: 999 }] };
}

test('join timeline computes click-relative markers, all intervals, queue share and 15-25s p95 without mutating raw inputs', () => {
  const input = measurement(), before = structuredClone(input);
  const actual = joinTimelineStats(input);
  assert.deepEqual(actual.times, { join_request_sent: 10, join_response: 110, room_route: 120,
    queue_request_sent: 130, queue_response: 400, chats_response: 500, room_response: 510,
    ws_open: 190, first_sync_frame: 600, player_mount: 450, player_ready: 700,
    first_seek_start: 750, first_seek_end: 800, first_playing: 810, first_progress: 950, unmuted: 950 });
  assert.deepEqual(actual.intervals, { join_api: 100, route_to_queue_response: 280,
    queue_response_to_mount: 50, mount_to_ready: 250, ready_to_seek_end: 100,
    seek_end_to_progress: 150, total_to_progress: 950, total_to_sound: 950,
    prefetch_upper_bound: 280, queue_blocking_share: 280 / 950, position_error_15_25s_p95_ms: 20 });
  assert.equal(actual.raw.t0, 1000);
  assert.equal(actual.raw.timestamps.first_progress, 1950);
  assert.deepEqual(input, before);
});

test('missing events stay null and pre-click or post-observation events never supply markers', () => {
  const input = measurement();
  input.events = [{ name: 'player_ready', t: 999 }, { name: 'player_mount', t: 26001 }];
  input.requests = []; input.samples = []; input.frames = []; input.wsLog = []; input.errors = [];
  const actual = joinTimelineStats(input);
  assert.ok(JOIN_TIMES.every(key => actual.times[key] === null));
  assert.ok(JOIN_INTERVALS.every(key => actual.intervals[key] === null));
  assert.ok(JOIN_TIMES.every(key => actual.raw.timestamps[key] === null));
  assert.deepEqual(joinTimelineStats({ roomCode: 'ABC' }).times, actual.times);
});

test('first progress rejects ad, paused, absent, seek jumps and source changes; sound requires an observed unmute click', () => {
  const input = measurement();
  input.samples = [sample(1100, 1, { ad: true }), sample(1200, 1.1, { ad: true }),
    sample(1300, 10), sample(1400, 20), sample(1500, 20.1, { paused: true }),
    sample(1600, 20.2), { t: 1700, none: true }, sample(1800, 20.3),
    sample(1900, 20.4, { src: 'other' }), sample(2000, 20.5, { src: 'other', muted: false })];
  assert.equal(joinTimelineStats(input).times.first_progress, 1000);
  assert.equal(joinTimelineStats(input).times.unmuted, 1000);
  input.clicks = [];
  assert.equal(joinTimelineStats(input).times.unmuted, null);
  input.clicks = [{ kind: 'unmute', t: 2001 }];
  assert.equal(joinTimelineStats(input).times.unmuted, null);
});

test('first request and its own completion are paired, unrelated endpoints and methods are excluded', () => {
  const input = measurement();
  input.requests = [request('join', 1001, null, 'POST'), request('join', 1010, 1110, 'POST'),
    request('ABC/queue', 1020, 1030), request('ABC/queue_list', 1040, 1050, 'OPTIONS'),
    request('ABC2/queue_list', 1060, 1070), request('ABC/queue_list', 1130, 1400)];
  const actual = joinTimelineStats(input);
  assert.equal(actual.times.join_request_sent, 1);
  assert.equal(actual.times.join_response, null);
  assert.equal(actual.intervals.join_api, null);
  assert.equal(actual.times.queue_request_sent, 130);
  input.events.push({ name: 'room_route', t: 1100 }, { name: 'room_route', t: 1500 });
  assert.equal(joinTimelineStats(input).times.room_route, 100);
  input.events = [{ name: 'room_route', t: 1500 }];
  assert.equal(joinTimelineStats(input).intervals.prefetch_upper_bound, 0);
  input.samples = [];
  assert.equal(joinTimelineStats(input).intervals.queue_blocking_share, null);
});

// Real init scripts run in a VM. No browser, media implementation or network.
async function pageFixture(options = {}) {
  const scripts = [], page = new EventEmitter(), writes = [];
  const context = { addInitScript: async (fn, args) => scripts.push({ fn, args }), newPage: async () => page };
  const result = { errors: [], blocked_external_requests: 0 };
  const state = await tab({ newContext: async () => context }, { nickname: 'guest' }, result, [],
    'muted-allowed', false, { syncProbe: true, ...options });
  const sandbox = { sessionStorage: { setItem: (...args) => writes.push(args) }, setInterval() {},
    navigator: { userActivation: { hasBeenActive: false } },
    console: { debug: (...args) => page.emit('console', { text: () => args.join(' '), type: () => 'debug' }) } };
  const documentEvents = new Map(), windowEvents = new Map();
  const listen = map => (name, fn) => { if (!map.has(name)) map.set(name, []); map.get(name).push(fn); };
  const window = { WebSocket: class {}, location: new URL('https://front.example/'), addEventListener: listen(windowEvents),
    navigation: { addEventListener: listen(windowEvents) } };
  window.top = window;
  const document = { addEventListener: listen(documentEvents), querySelector: () => null, querySelectorAll: () => [] };
  let mutate;
  Object.assign(sandbox, { window, document, MutationObserver: class {
    constructor(fn) { mutate = fn; } observe() {}
  } });
  const vmContext = vm.createContext({ ...sandbox, URL, Element: class {} });
  for (const { fn, args } of scripts) vm.runInContext(`(${fn.toString()})(${JSON.stringify(args)})`, vmContext);
  return { state, result, page, writes, window, document, documentEvents, windowEvents, mutate, vmContext };
}

test('tab still seeds user by default, opt-out leaves storage untouched and captures request completion and trusted click', async () => {
  assert.equal((await pageFixture()).writes.length, 1);
  const f = await pageFixture({ seedUser: false, joinTimeline: true });
  assert.deepEqual(f.writes, []);
  const target = { closest: () => ({ form: { querySelector: () => ({}) } }) };
  for (const fn of f.documentEvents.get('click')) fn({ target, isTrusted: false });
  assert.equal(f.state.t0, undefined);
  for (const fn of f.documentEvents.get('click')) fn({ target, isTrusted: true });
  assert.ok(Number.isFinite(f.state.t0));
  const req = { url: () => 'https://api.example/rooms/join', method: () => 'POST' };
  f.page.emit('request', req);
  f.page.emit('response', { url: req.url, status: () => 200, request: () => req, finished: async () => null });
  f.page.emit('requestfinished', req);
  assert.equal(f.state.requests.length, 1);
  assert.equal(f.state.requests[0].status, 200);
  assert.ok(f.state.requests[0].finished_at >= f.state.requests[0].sent_at);
});

test('top observer receives route, mount, metadata, seeks and playing without commanding media', async () => {
  const f = await pageFixture({ seedUser: false, joinTimeline: true });
  f.window.location = new URL('https://front.example/room/ABC');
  f.windowEvents.get('currententrychange')[0]();
  const media = { matches: () => true, currentTime: 30 };
  f.document.querySelector = () => media;
  f.mutate(); f.mutate();
  for (const event of ['loadedmetadata', 'seeking', 'seeked', 'playing']) {
    for (const fn of f.documentEvents.get(event)) fn({ target: media });
  }
  assert.deepEqual(f.state.timelineEvents.map(e => e.name),
    ['room_route', 'player_mount', 'player_ready', 'first_seek_start', 'first_seek_end', 'first_playing']);
});

test('YouTube ready uses top window messages with exact YouTube domains; iframe media events arrive through console', async () => {
  const f = await pageFixture({ youtube: true, seedUser: false, joinTimeline: true });
  f.document.querySelectorAll = () => [{ src: 'https://www.youtube.com/embed/video' }];
  f.mutate();
  const message = f.windowEvents.get('message')[0];
  message({ origin: 'https://youtube.com.evil.example', data: '{"event":"onReady"}' });
  message({ origin: 'https://www.youtube.com', data: 'invalid' });
  message({ origin: 'https://www.youtube.com', data: { event: 'other' } });
  message({ origin: 'https://www.youtube.com', data: '{"event":"onReady"}' });
  assert.deepEqual(f.state.timelineEvents.map(e => e.name), ['player_mount', 'player_ready']);
  f.window.top = {};
  f.window.location = new URL('https://www.youtube.com/embed/video');
  vm.runInContext(`(${joinTimelineProbe.toString()})({ youtube: true })`, f.vmContext);
  for (const name of ['seeking', 'seeked', 'playing']) {
    f.documentEvents.get(name).at(-1)({ target: { tagName: 'VIDEO', currentTime: 10 } });
  }
  assert.deepEqual(f.state.timelineEvents.slice(-3).map(e => e.name), ['first_seek_start', 'first_seek_end', 'first_playing']);
  assert.deepEqual(f.writes, []);
});

test('landing join follows the modal UI, using the trusted click timestamp supplied by the probe', async () => {
  const calls = [], state = {};
  state.page = { goto: async url => calls.push(url), getByRole: (_, options) => ({ click: async () => {
    calls.push(options.name);
    if (options.name === 'Join Room') state.t0 = 1234;
  } }), locator: selector => ({ fill: async value => calls.push([selector, value]) }) };
  await joinFromLanding(state, { room_code: 'ABC' }, 'guest', 'https://front.example');
  assert.deepEqual(calls, ['https://front.example', 'Join Existing Room', ['#roomCode', 'ABC'], ['#nickName', 'guest'], 'Join Room']);
  assert.equal(state.t0, 1234);
});

test('local and YouTube scenarios prepare a snapshot after no-action playback, then keep 30s/25s timing even in smoke', async () => {
  assert.equal(typeof runTimeline, 'function');
  const source = await readFile(new URL('../lib/sync-scenarios.mjs', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('export async function joinTimeline'), source.indexOf('export async function hostNoAction')).replace('export ', '');
  for (const youtube of [false, true]) for (const smoke of [false, true]) {
    const calls = [], metrics = { raw: {} }, host = { lastPlayClickAt: 3000 };
    const state = { youtube, host, metrics, guest: { t0: 35000 },
      join: async () => calls.push('join'), finish: async end => { calls.push(['finish', end]); return metrics; } };
    const run = vm.runInNewContext(`(${body})`, {
      session: async (_, options) => { assert.equal(options.joinTimeline, true); calls.push('no-action'); return state; },
      readyHost: async (_, __, entered) => { assert.equal(entered, true); calls.push('snapshot-local'); },
      readyHostYouTube: async (_, __, front, options) => {
        assert.equal(front, FRONT); assert.equal(options.alreadyEntered, true); calls.push('snapshot-youtube');
      },
      waitPlaying: async (_, options) => { assert.equal(options.since, 3000); calls.push('playing'); return 4000; },
      delayTo: async at => calls.push(['wait', at]),
    });
    assert.equal(await run({ smoke, front: FRONT, seed: { room: {} } }), metrics);
    assert.deepEqual(calls, ['no-action', youtube ? 'snapshot-youtube' : 'snapshot-local', 'playing',
      ['wait', 34000], 'join', ['wait', 60000], ['finish', 60000]]);
    assert.equal(metrics.raw.host_last_play_click_at, 3000);
  }
});

test('seed participant opt-out creates only a host and retains legacy participant creation by default', async () => {
  const source = await readFile(new URL('../lib/database.mjs', import.meta.url), 'utf8');
  const calls = [];
  const seed = vm.runInNewContext(`(${source.slice(source.indexOf('export async function seed(')).replace('export ', '')})`, {
    rest: async route => { calls.push(route); return { host_id: 1 }; },
    guest: async (_, nickname) => { calls.push(nickname); return { nickname }; },
  });
  const actual = await seed('unused', { queue: false, participants: false });
  assert.deepEqual(calls, ['/rooms/']);
  assert.equal(actual.guest.nickname, 'observer');
  assert.equal(actual.guest.token, undefined);
  assert.equal(actual.sender, null);
  calls.length = 0;
  await seed('unused', { queue: false });
  assert.deepEqual(calls, ['/rooms/', 'observer', 'sender']);
});

test('deployed runner reuses SHA validation and isolates its result path', () => {
  const opts = parseArgs(['--front-commit', 'abcdef0', '--server-commit', '1234567']);
  assert.equal(opts.runs, 5);
  assert.throws(() => parseArgs(['--front-commit', '../x']), /SHA/);
  assert.equal(resultPath(opts.frontCommit, 2), path.join(ROOT, 'results/deploy/join_timeline/abcdef0/run-2.json'));
  assert.equal(FRONT, 'https://vibe-syncer.eelkom.com');
  assert.ok(extraHosts.includes('vibe-syncer.onrender.com'));
});

test('shared deployment preparation and deletion retain API flow, including already-deleted rooms and cleanup errors', async () => {
  const originalFetch = globalThis.fetch, calls = [];
  const result = { warm_ms: [], errors: [], ok: true };
  let deleteStatus = 200;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    const status = options.method === 'DELETE' ? deleteStatus : 200;
    return { status, ok: status < 400, text: async () => JSON.stringify({ room_code: 'ABC', host_id: 1, token: 'host-token' }) };
  };
  try {
    await wake(result); await warm(result);
    const { room, host } = await createRoom(result);
    await addSong(room, host); await deleteRoom(result, room, host);
    assert.equal(result.warm_ms.length, 3);
    assert.equal(result.room_deleted, true);
    assert.deepEqual(calls.map(c => [new URL(c.url).pathname, c.options.method]),
      [['/', 'GET'], ['/', 'GET'], ['/', 'GET'], ['/', 'GET'], ['/rooms/', 'POST'], ['/rooms/ABC/queue', 'POST'], ['/rooms/ABC', 'DELETE']]);
    assert.ok(calls.every(c => new URL(c.url).origin === 'https://vibe-syncer.onrender.com'));
    assert.equal(calls.at(-1).options.headers.Authorization, 'Bearer host-token');
    deleteStatus = 404;
    await deleteRoom(result, room, host);
    assert.equal(result.room_deleted, 'already');
    globalThis.fetch = async () => { throw new Error('fixture offline'); };
    await deleteRoom(result, room, host);
    assert.equal(result.ok, false);
    assert.equal(result.room_deleted, false);
    assert.match(result.errors[0], /fixture offline/);
  } finally { globalThis.fetch = originalFetch; }
});

test('timeline summary reads deployment originals and shows round values and successful medians with missing markers', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'join-summary-'));
  try {
    const dir = path.join(root, 'deploy/join_timeline/abcdef0');
    await mkdir(dir, { recursive: true });
    const base = { ok: true, metrics: { join_timeline: { intervals: { join_api: 100, total_to_progress: null } } } };
    await writeFile(path.join(dir, 'run-1.json'), JSON.stringify({ ...base, run: 1 }));
    await writeFile(path.join(dir, 'run-2.json'), JSON.stringify({ ...base, run: 2, ok: false }));
    await writeFile(path.join(dir, 'run-1.previous.json'), 'not JSON');
    const groups = summarizeSync(await readSyncRuns(root));
    assert.equal(groups[0].key, 'deploy/join_timeline_deployed/youtube/abcdef0');
    const md = syncMarkdown(groups);
    assert.match(md, /입장부터 첫 재생까지 구간/);
    assert.match(md, /\| join_api \| 100 \| 100 \| 100 \| 0 \|/);
    assert.match(md, /\| total_to_progress \| null \| null \| null \| 1 \|/);
    assert.match(md, /run-2 FAILED/);
    assert.ok(JOIN_INTERVALS.every(name => md.includes(`| ${name} |`)));
  } finally { await rm(root, { recursive: true, force: true }); }
});
