import WebSocket from 'ws';
import { deadline } from './common.mjs';
export const socketURL = (room, user) => `ws://127.0.0.1:18000/ws/${room.room_code}?token=${encodeURIComponent(user.token)}`;
export async function connectSocket(room, user, cleanup) {
  const ws = new WebSocket(socketURL(room, user));
  cleanup.push(async () => {
    if (ws.readyState === WebSocket.CLOSED) return;
    const closed = new Promise(resolve => ws.once('close', resolve));
    ws.terminate(); await closed;
  });
  ws.frames = [];
  ws.on('message', payload => {
    try { ws.frames.push({ t: Date.now(), data: JSON.parse(payload.toString()) }); } catch {}
  });
  ws.on('error', () => {});
  await deadline(new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); }), 15000, 'Node WS open');
  return ws;
}
