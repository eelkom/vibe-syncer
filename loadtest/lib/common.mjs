import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
export { sleep };
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO = path.dirname(ROOT);
export const API = 'http://127.0.0.1:18000';
export const FRONT = 'http://127.0.0.1:15173';
export const DB = { host: '127.0.0.1', port: 55432, user: 'vibe', password: '', database: 'postgres' };
export function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  // A route may fail before the orchestrator reaches its await; retain that
  // rejection for the consumer without triggering an unhandled rejection.
  promise.catch(() => {});
  return { promise, resolve, reject };
}
export async function until(check, timeout = 15000, label = 'condition') {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(50);
  }
  throw new Error(`Timeout waiting for ${label}`);
}
export async function deadline(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timeout: ${label}`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}
export async function rest(route, data) {
  const response = await fetch(`${API}${route}`, {
    method: data ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: data ? JSON.stringify(data) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`${route}: HTTP ${response.status}: ${await response.text()}`);
  return response.json();
}
