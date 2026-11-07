// Opens WebSocket connections one by one and records how long each takes and
// whether the server stays responsive while they are all held open.
import { e2eMain } from '../lib/sync-e2e.mjs';
import { guest } from '../lib/database.mjs';
import { API } from '../lib/common.mjs';
import { connectSocket } from '../lib/socket.mjs';

const CONNECTIONS = 30;

async function ping() {
  const start = Date.now();
  try {
    await fetch(`${API}/`, { signal: AbortSignal.timeout(40000) });
    return Date.now() - start;
  } catch { return null; }
}

await e2eMain('ws_capacity', async ctx => {
  const users = [];
  for (let i = 0; i < CONNECTIONS; i++) users.push(await guest(ctx.seed.room, `capacity-${i}`));
  const rows = [];
  const sockets = [];
  for (const [index, user] of users.entries()) {
    const start = Date.now();
    try {
      sockets.push(await connectSocket(ctx.seed.room, user, ctx.cleanup));
      rows.push({ index: index + 1, opened: true, open_ms: Date.now() - start });
    } catch (error) {
      rows.push({ index: index + 1, opened: false, open_ms: Date.now() - start, error: error.message });
      break;
    }
  }
  await new Promise(resolve => setTimeout(resolve, 3000));
  const pingMs = await ping();
  const welcomes = sockets[0]?.frames.filter(frame => frame.data.type === 'chat' && frame.data.user_id === 0).length ?? 0;
  const opened = rows.filter(row => row.opened).length;
  return { passed: opened === CONNECTIONS && pingMs !== null && pingMs < 1000,
    connections_tried: CONNECTIONS, connections_opened: opened, slowest_open_ms: Math.max(...rows.map(row => row.open_ms)),
    ping_after_ms: pingMs, welcomes_seen_by_first: welcomes, rows };
}, { browser: false });
