import { e2eMain } from '../lib/sync-e2e.mjs';
import { session, socketLog, waitOpen, delayTo } from '../lib/sync-session.mjs';
import { dropSocket, restoreSocket } from '../lib/browser.mjs';
import { sleep } from '../lib/common.mjs';
import { recoveryTime } from '../lib/sync-stats.mjs';

await e2eMain('reconnect_exhausted', async ctx => {
  const s = await session({ ...ctx, condition: 'local', smoke: false }, { prepared: true });
  const guest = await s.join(), m = s.metrics;
  await sleep(5000);
  await s.stopGuestUser();
  m.drop_at = await dropSocket(guest);
  const deadline = m.drop_at + 90000;
  let retries = [];
  while (Date.now() < deadline) {
    retries = socketLog(guest).filter(row => row.created_at >= m.drop_at);
    const last = retries.at(-1);
    if (retries.length >= 5 && last.close_at !== null && Date.now() - last.close_at >= 1000) break;
    await sleep(100);
  }
  m.retries = retries;
  m.retry_count = retries.length;
  m.retries_exhausted = retries.length === 5 && retries.at(-1).close_at !== null;
  const button = guest.page.locator('button:has-text("다시 연결")');
  m.reconnect_button_present = await button.count() > 0 && await button.first().isVisible();
  m.restore_at = null;
  m.open_at = null;
  if (m.reconnect_button_present) {
    m.restore_at = await restoreSocket(guest);
    m.button_click_at = Date.now();
    await button.first().click();
    m.open_at = await waitOpen(guest, m.restore_at, 15000);
    if (m.open_at !== null) await delayTo(m.open_at + 15000);
  }
  await s.finish();
  m.recovery_ms = m.open_at === null ? null : recoveryTime(m.raw.errors, m.open_at);
  m.passed = m.retries_exhausted && m.reconnect_button_present && m.open_at !== null && m.recovery_ms !== null;
  return m;
});
