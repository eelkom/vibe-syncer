import { deadline } from '../lib/common.mjs';
export function ownBrowser(server) {
  const child = server.process();
  if (!Number.isInteger(child?.pid) || child.pid <= 0) throw new Error('Owned browser process PID unavailable');
  const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve()
    : new Promise(resolve => child.once('exit', resolve));
  return { server, child, pid: child.pid, exited, browser: null, forced: false };
}
export async function closeOwnedBrowser(owner, timeout = 10000) {
  // BrowserServer.kill() uses Playwright's own spawned process group; no name
  // matching, global pkill, or unrelated process enumeration is involved.
  const expired = Symbol('close timeout'); let timer, forced = false, error;
  const graceful = Promise.all([Promise.resolve().then(() => owner.browser?.close()), Promise.resolve().then(() => owner.server.close()), owner.exited]);
  try {
    const status = await Promise.race([graceful, new Promise(resolve => { timer = setTimeout(() => resolve(expired), timeout); })]);
    forced = status === expired;
  } catch (failure) { error = failure; forced = true; }
  finally { clearTimeout(timer); }
  if (forced) {
    await deadline(Promise.all([owner.server.kill(), owner.exited]), timeout, `owned browser ${owner.pid} SIGKILL exit`);
    owner.forced = true;
  }
  if (error) throw error; // Preserve other cleanup errors after ensuring no owned process remains.
  return { forced };
}
