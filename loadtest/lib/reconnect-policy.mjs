export const MAX_ATTEMPTS = 5;
// 1b2e6c4 frontend/src/hooks/useWebSocket.ts:33,111-123: five retries,
// increment immediately before connect; onopen resets counter to zero (line 61).
// b86324b same path:32-42,112,176-190: same counter, full jitter delay.
// b86324b also resets at effect mount (95); bot constructor starts at zero.
export function reconnectDelay(condition, attempt, random = Math.random) {
  const cap = Math.min(30000, 1000 * 2 ** attempt);
  if (condition === 'exponential') return cap;
  if (condition === 'full-jitter') return random() * cap;
  throw new Error(`Unknown reconnect policy: ${condition}`);
}
