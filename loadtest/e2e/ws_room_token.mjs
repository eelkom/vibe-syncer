import WebSocket from 'ws';
import { e2eMain } from '../lib/sync-e2e.mjs';
import { guest } from '../lib/database.mjs';
import { rest } from '../lib/common.mjs';

async function probe(room, token) {
  const url = `ws://127.0.0.1:18000/ws/${room.room_code}${token === null ? '' : `?token=${encodeURIComponent(token)}`}`;
  return new Promise(resolve => {
    const ws = new WebSocket(url);
    const row = { opened: false, opened_at: null, closed_at: null, close_code: null,
      http_status: null, error: null, timed_out: false, probe_initiated_close: false };
    const timer = setTimeout(() => { row.timed_out = true; ws.terminate(); }, 10000);
    ws.on('open', () => {
      row.opened = true; row.opened_at = Date.now();
      // This code is initiated by the probe after a successful upgrade; it must
      // not be mistaken for the server's authentication rejection code.
      row.probe_initiated_close = true;
      ws.close(1000, 'probe complete');
    });
    ws.on('unexpected-response', (_request, response) => {
      row.http_status = response.statusCode;
      response.resume();
      ws.terminate();
    });
    ws.on('error', error => { row.error = error.message; });
    ws.on('close', code => {
      clearTimeout(timer);
      row.closed_at = Date.now(); row.close_code = code;
      resolve(row);
    });
  });
}
await e2eMain('ws_room_token', async ctx => {
  const roomA = ctx.seed.room;
  const roomB = await rest('/rooms/', { name: 'Token room B', host_nickname: 'host-b' });
  const userA = await guest(roomA, 'token-user-a');
  const cases = [
    ['a_token_to_b', roomB, userA.token, false],
    ['a_token_to_a', roomA, userA.token, true],
    ['a_host_to_a', roomA, ctx.seed.host.token, true],
    ['no_token', roomA, null, false],
    ['invalid_token', roomA, 'invalid-token', false],
  ];
  const rows = [];
  for (const [name, room, token, expected] of cases) {
    const row = await probe(room, token);
    rows.push({ name, expected_open: expected, ...row, passed: !row.timed_out && row.opened === expected });
  }
  return { passed: rows.every(row => row.passed), cases: rows };
}, { browser: false });
