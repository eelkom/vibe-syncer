import { ROOT, FRONT, sleep, until } from './common.mjs';
import path from 'node:path';
import { reconcileClicks } from './stats.mjs';
import { joinTimelineProbe } from './join-timeline-probe.mjs';
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(ROOT, '.pw-browsers');
const { chromium } = await import('playwright');
// Every inspected commit's MusicPlayer.tsx: central play/pause = button.h-14;
// needsSync = button.animate-pulse; e75a31c,08eb0e5,a086001,b86324b additionally
// expose the text button "탭하여 소리 켜기". Older versions have no unmute button.
export const browserVersions = new Set();
export const selectors = {
  play: 'button.h-14', sync: 'button.animate-pulse',
  // frontend/src/page/MusicRoom/components/ChatBoard.tsx: all four versions
  // have a card > header div > h2 "Chat", then a direct scroll div sibling.
  // e7904b9/32cdc26:46-60; 08eb0e5:45-59; b86324b:47-61.
  // Scope to that card so QueueBoard's matching scroll classes are excluded.
  input: 'input[placeholder="Message..."]',
  chat: 'div:has(> div > h2:text-is("Chat")) > div.scrollbar-hide.overflow-y-auto',
};
export const YOUTUBE_HOSTS = Object.freeze([
  'youtube.com', '*.youtube.com', '*.youtube-nocookie.com', '*.googlevideo.com', '*.ytimg.com',
  '*.ggpht.com', '*.gstatic.com', '*.google.com', '*.googleapis.com', '*.doubleclick.net',
  '*.googlesyndication.com', '*.googleadservices.com',
]);
export function hostResolverRules(allowHosts = []) {
  return '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'
    + allowHosts.map(host => `, EXCLUDE ${host}`).join('');
}
export async function launch(cleanup, activation = false, { allowHosts } = {}) {
  const browser = await chromium.launch({ headless: true, args: [
    `--autoplay-policy=${activation ? 'document-user-activation-required' : 'no-user-gesture-required'}`,
    hostResolverRules(allowHosts),
    '--mute-audio',
    '--disable-features=HardwareMediaKeyHandling',
  ] });
  browserVersions.add(browser.version());
  cleanup.push(() => browser.close());
  return browser;
}
export async function tab(browser, user, result, cleanup, playbackCondition = 'muted-allowed', captureArtifacts = true, { youtube = false, syncProbe = false, seedUser = true, joinTimeline = false } = {}) {
  if (!['muted-allowed', 'all-blocked', 'silent-blocked'].includes(playbackCondition)) throw new Error(`Unknown playback condition: ${playbackCondition}`);
  const context = await browser.newContext({ serviceWorkers: 'block' });
  cleanup.push(() => context.close());
  await context.addInitScript(({ user, playbackCondition, youtube, syncProbe, seedUser }) => {
    if (youtube && window.top !== window) {
      // Never write app credentials or instrument app controls in an iframe.
      const hostname = window.location.hostname;
      if ((hostname === 'youtube.com' || hostname.endsWith('.youtube.com')
        || hostname === 'youtube-nocookie.com' || hostname.endsWith('.youtube-nocookie.com'))
        && window.location.pathname.startsWith('/embed/')) {
        let seekedCount = 0;
        if (syncProbe) document.addEventListener('seeked', event => {
          if (event.target?.tagName === 'VIDEO') {
            seekedCount++;
            console.debug('__sync_seeked ' + JSON.stringify({ t: Date.now(), ct: event.target.currentTime }));
          }
        }, true);
        setInterval(() => {
          const el = document.querySelector('video');
          const player = document.querySelector('.html5-video-player');
          const sample = el ? { t: Date.now(), ct: el.currentTime, paused: el.paused,
            muted: el.muted, volume: el.volume, readyState: el.readyState,
            ad: !!document.querySelector('.html5-video-player.ad-showing'),
            buffering: !!document.querySelector('.html5-video-player.buffering-mode') || el.readyState < 3,
            player_state: [...(player?.classList ?? [])].find(name => /^(playing|paused|buffering|unstarted|ended)-mode$/.test(name)) ?? null }
            : { t: Date.now(), none: true };
          if (syncProbe) { sample.seeked_count = seekedCount; sample.media_url = window.location.href; }
          console.debug('__yt_sample ' + JSON.stringify(sample));
        }, 100);
      }
      return;
    }
    // All nine commits: contexts/UserContext.tsx:16-18 and types/user.ts:1-6
    // read this exact shape. Route is /room/:id in routes/routePath.ts:3.
    if (seedUser) sessionStorage.setItem('user', JSON.stringify(user));
    window.__samples = [];
    window.__userClickEvents = [];
    window.__lastPlaybackClickAt = null;
    window.__blockedPlay = 0;
    window.__wsLog = [];
    window.__wsBlocked = false;
    window.__wsLast = null;
    const probeDocument = syncProbe ? `${Date.now()}-${Math.random()}` : null;
    const reportSocket = (record, index) => {
      if (syncProbe) console.debug('__sync_ws ' + JSON.stringify({ document: probeDocument, index, record }));
    };
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = new Proxy(NativeWebSocket, {
      construct(target, args, newTarget) {
        const record = { created_at: Date.now(), open_at: null, close_at: null, code: null };
        window.__wsLog.push(record);
        const index = window.__wsLog.length - 1;
        reportSocket(record, index);
        const effectiveArgs = window.__wsBlocked ? ['ws://127.0.0.1:1/', ...args.slice(1)] : args;
        const socket = Reflect.construct(target, effectiveArgs, newTarget);
        window.__wsLast = socket;
        socket.addEventListener('open', () => { record.open_at = Date.now(); reportSocket(record, index); });
        socket.addEventListener('close', event => { record.close_at = Date.now(); record.code = event.code; reportSocket(record, index); });
        return socket;
      },
    });
    // Detect in the page: Node-side locator/evaluate calls would activate it.
    let previousButton = '';
    setInterval(() => {
      const visible = button => {
        const rect = button.getBoundingClientRect(), style = getComputedStyle(button);
        if (!rect.width || !rect.height || style.visibility === 'hidden' || style.visibility === 'collapse' || style.display === 'none') return null;
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      };
      let button = null;
      for (const el of document.querySelectorAll('button.animate-pulse')) {
        const center = visible(el);
        if (center) { button = { kind: 'sync', ...center }; break; }
      }
      if (!button) for (const el of document.querySelectorAll('button')) {
        if (el.textContent.trim() !== '탭하여 소리 켜기') continue;
        const center = visible(el);
        if (center) { button = { kind: 'unmute', ...center }; break; }
      }
      const current = JSON.stringify(button);
      if (current !== previousButton) {
        previousButton = current;
        console.debug('__stage1_button', JSON.stringify({ t: Date.now(), button }));
      }
    }, 250);
    document.addEventListener('click', event => {
      const button = event.target instanceof Element ? event.target.closest('button') : null;
      const kind = button?.classList.contains('animate-pulse') ? 'sync'
        : button?.textContent?.trim() === '탭하여 소리 켜기' ? 'unmute' : null;
      if (kind && event.isTrusted) window.__userClickEvents.push({ kind, t: Date.now() });
      if (button?.classList.contains('h-14') && event.isTrusted) window.__lastPlaybackClickAt = Date.now();
    }, true);
    let seekedCount = 0;
    if (syncProbe) document.addEventListener('seeked', event => {
      if (event.target?.matches?.('audio,video')) {
        seekedCount++;
        console.debug('__sync_seeked ' + JSON.stringify({ t: Date.now(), ct: event.target.currentTime }));
      }
    }, true);
    setInterval(() => {
      const el = document.querySelector('audio,video');
      const sample = el ? { t: Date.now(), ct: el.currentTime, paused: el.paused,
        muted: el.muted, volume: el.volume, readyState: el.readyState, act: navigator.userActivation.hasBeenActive }
        : { t: Date.now(), none: true, act: navigator.userActivation.hasBeenActive };
      if (syncProbe) {
        sample.src = el ? el.currentSrc || el.src : null;
        sample.seeked_count = seekedCount;
        console.debug('__sync_sample ' + JSON.stringify(sample));
      }
      window.__samples.push(sample);
    }, 100);
    if (playbackCondition !== 'muted-allowed') {
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function (...args) {
        if (!navigator.userActivation.hasBeenActive) {
          window.__blockedPlay++;
          if (playbackCondition === 'silent-blocked') return new Promise(() => {});
          return Promise.reject(new DOMException('Stage1 all-blocked injection', 'NotAllowedError'));
        }
        return play.apply(this, args);
      };
      // FilePlayer passes autoPlay: playing; blocking play() alone leaves
      // attribute/property autoplay available. Restore native behavior after
      // activation, without issuing a replacement play request ourselves.
      const setAttribute = Element.prototype.setAttribute;
      Element.prototype.setAttribute = function (name, ...args) {
        if (this instanceof HTMLMediaElement && String(name).toLowerCase() === 'autoplay' && !navigator.userActivation.hasBeenActive) {
          window.__blockedPlay++;
          return;
        }
        return setAttribute.call(this, name, ...args);
      };
      const autoplay = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'autoplay');
      Object.defineProperty(HTMLMediaElement.prototype, 'autoplay', {
        ...autoplay,
        set(value) {
          if (!navigator.userActivation.hasBeenActive) {
            window.__blockedPlay++;
            return;
          }
          return autoplay.set.call(this, value);
        },
      });
    }
  }, { user, playbackCondition, youtube, syncProbe, seedUser });
  if (joinTimeline) await context.addInitScript(joinTimelineProbe, { youtube });
  const page = await context.newPage();
  const state = { page, frames: [], sent: [], attempts: [], consoleErrors: [], responses: [], clicks: [], reconciledClicks: 0 };
  if (joinTimeline) Object.assign(state, { timelineEvents: [], requests: [] });
  if (syncProbe) Object.assign(state, { probeSamples: [], probeWsLog: [], seeked: [] });
  if (youtube) {
    state.ytSamples = [];
    result.external_hosts ??= {};
    result.blocked_hosts ??= {};
    result.youtube_page_errors ??= [];
    state.blockedHosts = result.blocked_hosts;
  }
  const externalRequest = url => {
    const host = new URL(url).hostname;
    if (host === '127.0.0.1') return;
    if (youtube) result.external_hosts[host] = (result.external_hosts[host] ?? 0) + 1;
    else result.blocked_external_requests++;
  };
  page.on('request', request => {
    externalRequest(request.url());
  });
  if (joinTimeline) {
    const records = new WeakMap();
    page.on('request', request => {
      const record = { url: request.url(), method: request.method(), sent_at: Date.now(), finished_at: null, status: null };
      records.set(request, record);
      state.requests.push(record);
    });
    page.on('response', response => {
      const record = records.get(response.request());
      if (record) record.status = response.status();
    });
    page.on('requestfinished', request => {
      const record = records.get(request);
      if (record) record.finished_at = Date.now();
    });
  }
  if (youtube) page.on('requestfailed', request => {
    if (request.failure()?.errorText === 'net::ERR_NAME_NOT_RESOLVED') {
      const host = new URL(request.url()).hostname;
      result.blocked_hosts[host] = (result.blocked_hosts[host] ?? 0) + 1;
    }
  });
  page.on('console', msg => {
    if (joinTimeline && msg.text().startsWith('__join_timeline ')) {
      try {
        const event = JSON.parse(msg.text().slice('__join_timeline '.length));
        state.timelineEvents.push(event);
        if (event.name === 'join_click') state.t0 ??= event.t;
      } catch (error) { result.errors.push(`join timeline: ${error.message}`); }
      return;
    }
    if (syncProbe) for (const [prefix, key] of [['__sync_sample ', 'probeSamples'], ['__sync_seeked ', 'seeked'], ['__sync_ws ', 'probeWsLog']]) {
      if (!msg.text().startsWith(prefix)) continue;
      try {
        const value = JSON.parse(msg.text().slice(prefix.length));
        if (key === 'probeWsLog') {
          const previous = state.probeWsLog.find(row => row.document === value.document && row.index === value.index);
          if (previous) Object.assign(previous.record, value.record); else state.probeWsLog.push(value);
        } else state[key].push(value);
      } catch (error) { result.errors.push(`sync probe: ${error.message}`); }
      return;
    }
    if (youtube && msg.text().startsWith('__yt_sample ')) {
      try { state.ytSamples.push(JSON.parse(msg.text().slice('__yt_sample '.length))); }
      catch (error) { result.errors.push(`YouTube sample: ${error.message}`); }
      return;
    }
    if (msg.type() === 'error') state.consoleErrors.push({ t: Date.now(), text: msg.text() });
  });
  page.on('pageerror', err => {
    if (youtube) result.youtube_page_errors.push({ t: Date.now(), text: err.message });
    else result.errors.push(`pageerror: ${err.message}`);
  });
  page.on('response', response => {
    const record = { t: Date.now(), url: response.url(), status: response.status(), finished_at: null };
    state.responses.push(record);
    response.finished().then(error => {
      if (!error) record.finished_at = Date.now();
    }).catch(() => {});
  });
  page.on('websocket', ws => {
    externalRequest(ws.url());
    state.attempts.push(Date.now());
    for (const [event, list] of [['framereceived', state.frames], ['framesent', state.sent]]) {
      ws.on(event, frame => {
        try { list.push({ t: Date.now(), data: JSON.parse(frame.payload.toString()) }); } catch {}
      });
    }
  });
  // Capture even a failed scenario's partial samples/frames before context close.
  if (captureArtifacts) cleanup.push(async () => {
    result.browser_artifacts ??= [];
    let observation = {};
    try { observation = await readObservation(state, result); } catch (error) { result.errors.push(`sample capture: ${error.message}`); }
    result.browser_artifacts.push({ role: user.nickname, ...observation, ...(youtube ? { yt_samples: state.ytSamples } : {}), frames: state.frames,
      sent: state.sent, attempts: (observation.ws_log ?? []).map(entry => entry.created_at), console_errors: state.consoleErrors,
      responses: state.responses, clicks: state.clicks, t0: state.t0 ?? null,
      ...(joinTimeline ? { timeline_events: state.timelineEvents, requests: state.requests } : {}) });
  });
  return state;
}
export async function enter(state, room, front = FRONT) {
  state.t0 = Date.now();
  await state.page.goto(`${front}/room/${room.room_code}`, { waitUntil: 'domcontentloaded' });
}
export async function joinFromLanding(state, room, nickname, front = FRONT) {
  await state.page.goto(front, { waitUntil: 'domcontentloaded' });
  await state.page.getByRole('button', { name: 'Join Existing Room', exact: true }).click();
  await state.page.locator('#roomCode').fill(room.room_code);
  await state.page.locator('#nickName').fill(nickname);
  await state.page.getByRole('button', { name: 'Join Room', exact: true }).click();
  await until(() => Number.isFinite(state.t0), 5000, 'trusted join click');
}
export async function samples(state) { return state.page.evaluate(() => window.__samples ?? []); }
// Call only after observation ends (or an aborted run reaches cleanup).
export async function readObservation(state, result) {
  const observation = await state.page.evaluate(() => ({
    samples: window.__samples ?? [], user_click_events: window.__userClickEvents ?? [],
    ws_log: window.__wsLog ?? [], blocked_play_calls: window.__blockedPlay ?? 0,
  }));
  const pending = state.clicks.slice(state.reconciledClicks);
  const checked = reconcileClicks(pending, observation.user_click_events);
  checked.forEach((click, i) => {
    Object.assign(pending[i], click);
    if (!click.ok) result.errors.push(`scripted click: no matching trusted ${click.kind} event at ${click.attempted_at}${click.input_error ? `; ${click.input_error}` : ''}`);
  });
  state.reconciledClicks = state.clicks.length;
  return observation;
}
export function scriptedUser(state, cleanup, result) {
  let stopped = false, latest = null, pending = null, timer = null, inputRunning = false;
  let inFlight = Promise.resolve();
  const schedule = () => {
    clearTimeout(timer);
    if (stopped || inputRunning || !pending || state.clicks.length >= 5) return;
    timer = setTimeout(() => {
      if (stopped || !latest || !pending) return;
      if (Date.now() < pending.firstSeen + 1000) { schedule(); return; }
      // Only actual mouse input touches the page. Coordinates arrive via
      // console text; no locator/evaluate/binding is used to detect buttons.
      const click = { kind: pending.kind, first_seen: pending.firstSeen, attempted_at: Date.now(),
        x: latest.x, y: latest.y, t: null, ok: null };
      state.clicks.push(click);
      pending = null;
      inputRunning = true;
      inFlight = (async () => {
        try { await state.page.mouse.click(click.x, click.y); }
        catch (error) { click.input_error = error.message; }
        click.input_finished_at = Date.now();
        inputRunning = false;
        if (!pending && latest) pending = { kind: latest.kind, firstSeen: Date.now() };
        schedule();
      })().catch(error => { result.errors.push(`scripted user: ${error.message}`); });
    }, Math.max(0, pending.firstSeen + 1000 - Date.now()));
  };
  const onConsole = msg => {
    const text = msg.text();
    if (!text.startsWith('__stage1_button ')) return;
    try {
      const observation = JSON.parse(text.slice('__stage1_button '.length));
      latest = observation.button;
      if (!latest) { pending = null; clearTimeout(timer); }
      else if (pending?.kind !== latest.kind) {
        pending = { kind: latest.kind, firstSeen: observation.t };
        schedule();
      }
    } catch (error) { result.errors.push(`button observation: ${error.message}`); }
  };
  state.page.on('console', onConsole);
  const stop = async () => {
    stopped = true;
    clearTimeout(timer);
    state.page.off('console', onConsole);
    await inFlight;
  };
  cleanup.push(stop);
  return stop;
}
export async function readyHost(state, room, alreadyEntered = false) {
  if (!alreadyEntered) await enter(state, room);
  await until(async () => state.page.evaluate(() => {
    const el = document.querySelector('audio,video'); return el && !el.paused && el.currentTime >= 0.2;
  }), 20000, 'host audio playback');
  await until(() => state.attempts.length && state.frames.length, 15000, 'host WebSocket receive');
  const since = Date.now();
  await state.page.locator(selectors.play).click();
  await until(() => state.sent.some(f => f.t >= since && f.data.type === 'sync' && f.data.action === 'pause'), 5000, 'host pause sync frame');
  await sleep(300);
  await state.page.locator(selectors.play).click();
  state.lastPlayClickAt = await state.page.evaluate(() => window.__lastPlaybackClickAt);
  await until(() => state.sent.some(f => f.t >= since && f.data.type === 'sync' && f.data.action === 'play'), 5000, 'host play sync frame');
}
export async function readyHostYouTube(state, room, front = FRONT, { playbackTimeout = 60000, alreadyEntered = false } = {}) {
  if (!alreadyEntered) await enter(state, room, front);
  try {
    await until(() => {
      const s = state.ytSamples.at(-1);
      return s && !s.none && !s.paused && s.ct >= 0.2 && !s.ad;
    }, playbackTimeout, 'host YouTube playback');
  } catch (error) {
    throw new Error(`${error.message}; last YouTube samples: ${JSON.stringify(state.ytSamples.slice(-10))}; blocked_hosts: ${JSON.stringify(state.blockedHosts)}`);
  }
  await until(() => state.attempts.length && state.frames.length, 15000, 'host WebSocket receive');
  const since = Date.now();
  await state.page.locator(selectors.play).click();
  await until(() => state.sent.some(f => f.t >= since && f.data.type === 'sync' && f.data.action === 'pause'), 5000, 'host pause sync frame');
  await sleep(300);
  await state.page.locator(selectors.play).click();
  state.lastPlayClickAt = await state.page.evaluate(() => window.__lastPlaybackClickAt);
  await until(() => state.sent.some(f => f.t >= since && f.data.type === 'sync' && f.data.action === 'play'), 5000, 'host play sync frame');
}
export async function chatReady(state) {
  await state.page.locator(selectors.input).waitFor({ state: 'visible' });
  await until(() => state.responses.some(r => /\/chats(?:\?|$)/.test(r.url) && r.status === 200 && r.finished_at !== null), 15000, 'initial chat response');
  // ChatBoard.tsx in every comparison renders a direct div.h-full while
  // isLoading. Wait for its removal so burst does not also test history race.
  await until(async () => (await state.page.locator(selectors.chat).locator(':scope > div.h-full').count()) === 0,
    15000, 'initial chat query rendered');
  await until(() => state.frames.length > 0, 15000, 'guest WS first receive');
}
export async function chatText(state) { return state.page.locator(selectors.chat).innerText(); }
export async function settleChat(state) {
  await state.page.locator(selectors.chat).evaluate(el => {
    window.__chatChangedAt = Date.now();
    new MutationObserver(() => { window.__chatChangedAt = Date.now(); }).observe(el, { childList: true, subtree: true, characterData: true });
  });
  await until(() => state.page.evaluate(() => Date.now() - window.__chatChangedAt >= 3000), 30000, 'chat DOM quiet for 3s');
}

// Fault injection is opt-in. Normal sockets retain their native URL and behavior.
export async function dropSocket(state) {
  return state.page.evaluate(() => {
    window.__wsBlocked = true;
    const t = Date.now();
    window.__wsLast?.close();
    return t;
  });
}
export async function restoreSocket(state) {
  return state.page.evaluate(() => { window.__wsBlocked = false; return Date.now(); });
}
