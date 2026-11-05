import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { API, ROOT, deadline, deferred, sleep, until } from '../lib/common.mjs';
import { validateArchive } from '../lib/commit.mjs';
import { createDatabase, dropDatabase, seed } from '../lib/database.mjs';
import { startServer } from '../lib/server.mjs';
import { staticServer } from '../lib/static-server.mjs';

const SONG = 'E2E race song';

function parseArgs(args) {
  let commit, runs = 1;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--commit' && commit === undefined) commit = args[++i];
    else if (args[i] === '--runs' && /^\d+$/.test(args[i + 1] ?? '')) runs = Number(args[++i]);
    else throw new Error(`Unknown or incomplete option: ${args[i]}`);
  }
  if (!commit) throw new Error('--commit <sha> is required');
  if (!Number.isSafeInteger(runs) || runs < 1) throw new Error('--runs must be a positive integer');
  return { commit, runs };
}

async function run({ sha, full }, runNumber, target) {
  const result = {
    commit: sha, commit_full: full, run: runNumber, passed: false, failure_kind: null,
    started_at: new Date().toISOString(), first_response: null, queue_list_requests: 0,
    frames_received_at: [], queue_update_received_at: null, response_released_at: null,
    display_ms: null, console_errors: [], fulfill_error: null,
    // Same fields as run_stage1: tab() appends errors and counts external requests.
    metrics: {}, blocked_external_requests: 0, errors: [], ok: false,
  };
  const cleanup = [];
  const database = `loadtest_e2e_q33_${sha}_${runNumber}`;
  let created = false, server, observer;
  try {
    await createDatabase(database); created = true;
    server = await startServer(sha, database);
    const data = await seed(database, { queue: false });
    const front = await staticServer(path.join(ROOT, '.baselines', sha, 'frontend/dist'), 15173, true);
    cleanup.push(() => front.close());
    const { launch, tab, enter } = await import('../lib/browser.mjs');
    const browser = await launch(cleanup, true);
    observer = await tab(browser, data.guest, result, cleanup, 'muted-allowed', false);

    const held = deferred(), release = deferred(), delivered = deferred(), routeFailure = deferred();
    const guarded = promise => Promise.race([promise, routeFailure.promise]);
    let intercepted = false;
    await observer.page.route(/\/queue_list(?:\?|$)/, async route => {
      try {
        if (route.request().method() !== 'GET') return await route.continue();
        result.queue_list_requests++;
        if (intercepted) return await route.continue();
        intercepted = true;
        const response = await route.fetch();
        const body = await response.text();
        result.first_response = { status: response.status(), body, received_at: Date.now() };
        const queue = JSON.parse(body);
        if (response.status() !== 200 || !Array.isArray(queue) || queue.length !== 0) {
          throw new Error('First queue_list response must be HTTP 200 with an empty array');
        }
        held.resolve();
        await release.promise;
        try {
          await route.fulfill({ response });
        } catch (error) {
          const failure = route.request().failure()?.errorText ?? '';
          result.fulfill_error = { message: error.message, request_failure: failure, t: Date.now() };
          // Cancellation is expected if the query's transport consumes AbortSignal.
          if (!/abort|cancel|invalid interception/i.test(`${failure} ${error.message}`)) throw error;
        }
        delivered.resolve();
      } catch (error) {
        routeFailure.reject(error);
        held.reject(error);
        delivered.reject(error);
        try { await route.abort(); } catch {}
      }
    });
    // Unblock routing before closing the context, including on setup failure.
    cleanup.push(async () => {
      release.resolve();
      await observer.page.unrouteAll({ behavior: 'wait' });
    });
    await enter(observer, data.room);
    await guarded(deadline(held.promise, 15000, 'first queue_list response held'));
    // A received frame proves that the guest WebSocket has opened.
    await guarded(until(() => observer.attempts.length > 0 && observer.frames.length > 0,
      15000, 'guest WebSocket open and first received frame'));

    const response = await fetch(`${API}/rooms/${data.room.room_code}/queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.host.token}` },
      body: JSON.stringify({ title: SONG, artist: 'E2E artist',
        music_url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Song addition HTTP ${response.status}: ${await response.text()}`);
    const song = await response.json();
    if (song.title !== SONG) throw new Error('Song addition returned an unexpected title');
    await guarded(until(() => observer.frames.some(frame =>
      frame.data.type === 'queue_update' && frame.data.title === SONG), 15000, 'queue_update frame'));
    result.queue_update_received_at = observer.frames.find(frame =>
      frame.data.type === 'queue_update' && frame.data.title === SONG).t;
    await sleep(100);
    result.response_released_at = Date.now();
    release.resolve();

    // Only a visibility timeout is a verdict failure. Routing/tool errors remain setup errors.
    const visible = observer.page.getByText(SONG, { exact: true }).first()
      .waitFor({ state: 'visible', timeout: 10000 })
      .then(() => ({ passed: true, at: Date.now() }), error => {
        if (error.name === 'TimeoutError') return { passed: false };
        throw error;
      });
    const [display] = await guarded(Promise.all([
      visible, deadline(delivered.promise, 15000, 'held response released'),
    ]));
    result.passed = display.passed;
    result.display_ms = display.passed ? display.at - result.response_released_at : null;
    result.failure_kind = display.passed ? null : 'assertion';
    result.ok = true;
  } catch (error) {
    result.failure_kind = 'setup';
    result.errors.push(error.stack ?? String(error));
  } finally {
    const recordCleanupError = (label, error) => {
      result.passed = false;
      result.ok = false;
      result.failure_kind = 'setup';
      result.errors.push(`${label}: ${error.stack ?? error}`);
    };
    for (const fn of cleanup.reverse()) {
      try { await fn(); } catch (error) { recordCleanupError('cleanup', error); }
    }
    try { if (server) await server.stop(); }
    catch (error) { recordCleanupError('server stop', error); }
    try { if (created) await dropDatabase(database); }
    catch (error) { recordCleanupError('DB cleanup', error); }
    if (observer) {
      result.console_errors = observer.consoleErrors;
      result.frames_received_at = observer.frames.map(frame => ({ type: frame.data.type, t: frame.t }));
    }
    result.finished_at = new Date().toISOString();
    await writeFile(target, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  }
  console.log(`${result.passed ? 'PASS' : result.failure_kind === 'setup' ? 'SETUP ERROR' : 'FAIL'} ${path.relative(ROOT, target)}`);
  return result.failure_kind === 'setup' ? 2 : result.passed ? 0 : 1;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const archive = await validateArchive(opts.commit);
  const root = path.join(ROOT, 'results/e2e/queue_update_race', archive.sha);
  const lock = path.join(ROOT, '.logs/stage1.lock');
  await mkdir(path.dirname(lock), { recursive: true });
  await writeFile(lock, `${process.pid}\n`, { flag: 'wx' });
  try {
    // Refuse the whole batch before starting if any existing result would be overwritten.
    for (let n = 1; n <= opts.runs; n++) {
      const target = path.join(root, `run-${n}.json`);
      try { await stat(target); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      throw new Error(`Result already exists; preserved: ${target}`);
    }
    await mkdir(root, { recursive: true });
    let code = 0;
    for (let n = 1; n <= opts.runs; n++) {
      const current = await run(archive, n, path.join(root, `run-${n}.json`));
      code = Math.max(code, current);
      if (current === 2) break;
    }
    return code;
  } finally { await unlink(lock); }
}

try { process.exitCode = await main(); }
catch (error) { console.error(`SETUP ERROR: ${error.stack ?? error}`); process.exitCode = 2; }
