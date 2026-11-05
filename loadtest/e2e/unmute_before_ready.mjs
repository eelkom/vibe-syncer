/*
 * Run loadtest/scripts/prepare_commit.sh <sha>, then:
 * node loadtest/e2e/unmute_before_ready.mjs --commit <sha> --runs 3
 * Requires the dedicated loadtest PostgreSQL at 127.0.0.1:55432.
 * Uses a real YouTube iframe; never uses Gemini or the production server.
 * Exit codes: all runs pass = 0, assertion failure = 1, setup error = 2.
 */
import { mkdir, readFile, lstat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { ROOT, DB, FRONT, deferred, deadline, sleep, until } from '../lib/common.mjs';
import { validateArchive, validateCommit } from '../lib/commit.mjs';
import { createDatabase, dropDatabase, seed } from '../lib/database.mjs';
import { startServer } from '../lib/server.mjs';
import { staticServer } from '../lib/static-server.mjs';

const VIDEO = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
const SDK = 'https://www.youtube.com/iframe_api';
const PREFIX = '__yt_sample ';
const interrupted = deferred();
let interruption = null;
const onSignal = signal => {
  interruption ??= new Error(`Interrupted by ${signal}`);
  interrupted.reject(interruption);
};
const onSigint = () => onSignal('SIGINT');
const onSigterm = () => onSignal('SIGTERM');
function step(promise) {
  return Promise.race([promise, interrupted.promise]);
}

function options(args) {
  const opts = { commit: null, runs: 1 };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!['--commit', '--runs'].includes(key) || seen.has(key)) {
      throw new Error(`Unknown or repeated argument: ${key}`);
    }
    seen.add(key);
    const value = args[++i];
    if (key === '--commit') opts.commit = validateCommit(value);
    else {
      if (!/^[1-9]\d*$/.test(value ?? '') || !Number.isSafeInteger(Number(value))) {
        throw new Error('--runs must be a positive safe integer');
      }
      opts.runs = Number(value);
    }
  }
  if (!opts.commit) throw new Error('--commit is required');
  return opts;
}

function isEmbed(url) {
  try {
    const { hostname, pathname } = new URL(url);
    return (hostname === 'youtube.com' || hostname.endsWith('.youtube.com'))
      && pathname.startsWith('/embed/');
  } catch { return false; }
}

async function launch() {
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(ROOT, '.pw-browsers');
  const { chromium } = await import('playwright');
  return chromium.launch({ headless: true, args: [
    '--autoplay-policy=document-user-activation-required',
    '--mute-audio',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE youtube.com, EXCLUDE *.youtube.com, EXCLUDE *.youtube-nocookie.com, EXCLUDE *.googlevideo.com, EXCLUDE *.ytimg.com, EXCLUDE *.ggpht.com, EXCLUDE *.gstatic.com, EXCLUDE *.google.com, EXCLUDE *.googleapis.com, EXCLUDE *.doubleclick.net, EXCLUDE *.googlesyndication.com, EXCLUDE *.googleadservices.com',
  ] });
}

async function tab(browser, user, result) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.addInitScript(user => {
    if (window === window.top) {
      sessionStorage.setItem('user', JSON.stringify(user));
      return;
    }
    if (!(location.hostname === 'youtube.com' || location.hostname.endsWith('.youtube.com'))
      || !location.pathname.startsWith('/embed/')) return;
    setInterval(() => {
      const video = document.querySelector('video');
      const t = Date.now();
      console.debug('__yt_sample ' + JSON.stringify(video ? {
        t, ct: video.currentTime, paused: video.paused, muted: video.muted,
        volume: video.volume, readyState: video.readyState,
        ad: !!document.querySelector('.html5-video-player.ad-showing'),
      } : { t, none: true }));
    }, 100);
  }, user);
  const page = await context.newPage();
  page.on('console', message => {
    const text = message.text();
    if (message.type() === 'error') {
      result.guest_console_errors.push({ t: Date.now(), text, location: message.location() });
    }
    // Init scripts can have an empty console source URL. The script itself
    // restricts sampling to YouTube embed frames; do not filter by location().
    if (message.type() !== 'debug' || !text.startsWith(PREFIX)) return;
    try {
      const sample = JSON.parse(text.slice(PREFIX.length));
      result.raw_samples.push(sample);
      result.first_sample_at ??= sample.t;
      if (result.released_at !== null && sample.t >= result.released_at
        && !sample.none && !sample.paused && !sample.ad && sample.ct >= 1) {
        result.first_playing_at ??= sample.t;
      }
    } catch (error) {
      result.errors.push(`YouTube sample: ${error.message}`);
    }
  });
  page.on('pageerror', error => {
    result.guest_console_errors.push({ t: Date.now(), text: error.message, kind: 'pageerror' });
  });
  return page;
}

async function run({ sha, full }, runNumber) {
  const result = {
    commit: sha, commit_full: full, run: runNumber, passed: false, failure_kind: null,
    click_at: null, released_at: null, first_sample_at: null, first_playing_at: null,
    interval_start_at: null, interval_end_at: null, sample_count: 0, muted_sample_count: 0,
    guest_console_errors: [], raw_samples: [], last_samples: [], errors: [],
  };
  const database = `loadtest_unmute_${sha}_${runNumber}`;
  const release = deferred(), held = deferred();
  let created = false, server, front, browser, closing = false;
  const setupError = error => {
    result.passed = false;
    result.failure_kind = 'setup';
    result.errors.push(error.stack ?? String(error));
  };
  try {
    // Resource acquisition must finish before reacting to a signal, so its
    // handle is available to finally even when interruption happens in flight.
    await createDatabase(database); created = true;
    if (interruption) throw interruption;
    server = await startServer(sha, database);
    if (interruption) throw interruption;
    const data = await step(seed(database));
    const client = new pg.Client({ ...DB, database });
    try {
      await step(client.connect());
      const updated = await step(client.query(
        "UPDATE queue_items SET music_url=$1, platform='Youtube', title='Big Buck Bunny', artist='Blender' WHERE room_id=$2",
        [VIDEO, data.room.id],
      ));
      if (updated.rowCount !== 1) throw new Error(`Expected one seeded queue item, got ${updated.rowCount}`);
    } finally { await client.end(); }
    front = await staticServer(path.join(ROOT, '.baselines', sha, 'frontend/dist'), 15173, true);
    if (interruption) throw interruption;
    browser = await launch();
    if (interruption) throw interruption;
    const page = await step(tab(browser, data.guest, result));
    let routeError = null;
    await step(page.route('https://www.youtube.com/iframe_api*', async route => {
      try {
        // Hold the request itself: route.fetch fails on this response's large headers.
        result.iframe_api_url = route.request().url();
        held.resolve();
        await release.promise;
        if (closing) { await route.abort(); return; }
        await route.continue();
      } catch (error) {
        if (!closing) { routeError = error; held.reject(error); }
        try { await route.abort(); } catch {}
      }
    }));
    await step(page.goto(`${FRONT}/room/${data.room.room_code}`, {
      waitUntil: 'domcontentloaded', timeout: 30000,
    }));
    await step(deadline(held.promise, 15000, `request held at ${SDK}; check react-player SDK URL`));
    const button = page.getByRole('button', { name: '탭하여 소리 켜기', exact: true });
    await step(button.waitFor({ state: 'visible', timeout: 15000 }));
    const box = await step(button.boundingBox());
    if (!box || !box.width || !box.height) throw new Error('Unmute button has no visible bounding box');
    const ensureBeforeReady = () => {
      if (result.raw_samples.length || page.frames().some(frame => isEmbed(frame.url()))) {
        throw new Error('Unmute click was not before readiness: YouTube samples or embed frame already exist');
      }
    };
    ensureBeforeReady();
    result.click_at = Date.now();
    await step(page.mouse.click(box.x + box.width / 2, box.y + box.height / 2));
    ensureBeforeReady();
    await step(button.waitFor({ state: 'hidden', timeout: 5000 }));
    result.released_at = Date.now();
    release.resolve();
    await step(until(() => {
      if (routeError) throw routeError;
      return result.first_playing_at !== null;
    }, 45000, 'YouTube content playing with ct >= 1'));
    result.interval_start_at = result.first_playing_at;
    result.interval_end_at = result.interval_start_at + 5000;
    await step(sleep(Math.max(0, result.interval_end_at - Date.now())));
    if (routeError) throw routeError;
    const samples = result.raw_samples.filter(sample => sample.t > result.interval_start_at
      && sample.t <= result.interval_end_at && !sample.ad);
    result.sample_count = samples.length;
    result.muted_sample_count = samples.filter(sample => sample.muted === true).length;
    if (samples.length < 20) throw new Error(`Only ${samples.length} non-ad samples in the 5-second interval; need at least 20`);
    if (result.muted_sample_count) {
      result.failure_kind = 'assertion';
      result.errors.push(`${result.muted_sample_count}/${samples.length} interval samples were muted after the pre-ready unmute click`);
    } else if (samples.some(sample => sample.muted !== false)) {
      throw new Error('Interval contains samples without a boolean muted value');
    } else {
      result.passed = true;
    }
  } catch (error) {
    setupError(error);
  } finally {
    closing = true;
    release.resolve();
    // Keep cleaning the remaining resources even if one cleanup fails.
    for (const [label, cleanup] of [
      ['browser', () => browser?.close()],
      ['frontend', () => front?.close()],
      ['backend', () => server?.stop()],
      ['database', () => created ? dropDatabase(database) : undefined],
    ]) {
      try {
        const stopped = await cleanup();
        if (stopped?.forced) throw new Error('Backend required SIGKILL');
      } catch (error) { setupError(new Error(`${label} cleanup: ${error.message}`)); }
    }
    result.last_samples = result.raw_samples.slice(-10);
  }
  return result;
}

async function main() {
  const opts = options(process.argv.slice(2));
  const lock = path.join(ROOT, '.logs/stage1.lock');
  await mkdir(path.dirname(lock), { recursive: true });
  // Never remove another runner's lock, including a stale one.
  await writeFile(lock, `${process.pid}\n`, { flag: 'wx' });
  let exitCode = 0;
  try {
    const commit = await step(validateArchive(opts.commit));
    // Refuse a changed SDK endpoint rather than silently testing another race.
    const youtubeSource = await step(readFile(path.join(ROOT, '.baselines', commit.sha,
      'frontend/node_modules/react-player/lib/players/YouTube.js'), 'utf8'));
    const sdk = /\bconst SDK_URL\s*=\s*['"]([^'"]+)['"]/.exec(youtubeSource)?.[1];
    if (sdk !== SDK) throw new Error(`react-player SDK URL differs from specification: ${sdk ?? 'unrecognized source'}`);
    const directory = path.join(ROOT, 'results/e2e/unmute_before_ready', commit.sha);
    // Preflight every requested run so an existing result rejects the whole batch.
    for (let n = 1; n <= opts.runs; n++) {
      const target = path.join(directory, `run-${n}.json`);
      try { await lstat(target); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      throw new Error(`Refusing to overwrite existing result: ${target}`);
    }
    await mkdir(directory, { recursive: true });
    for (let n = 1; n <= opts.runs; n++) {
      if (interruption) throw interruption;
      console.log(`RUN unmute_before_ready ${commit.sha} #${n}`);
      const result = await run(commit, n);
      const target = path.join(directory, `run-${n}.json`);
      await writeFile(target, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
      console.log(`${result.passed ? 'PASS' : result.failure_kind.toUpperCase()} ${path.relative(ROOT, target)}`);
      if (result.errors.length) console.error(result.errors.join('\n'));
      if (result.failure_kind === 'setup') exitCode = 2;
      else if (!result.passed) exitCode = Math.max(exitCode, 1);
      if (interruption) break;
    }
  } finally { await unlink(lock); }
  return exitCode;
}

process.on('SIGINT', onSigint);
process.on('SIGTERM', onSigterm);
try {
  process.exitCode = await main();
} catch (error) {
  console.error(error.stack ?? error);
  process.exitCode = 2;
} finally {
  process.off('SIGINT', onSigint);
  process.off('SIGTERM', onSigterm);
}
