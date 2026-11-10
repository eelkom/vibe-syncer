// 실행: node loadtest/deploy/probe_time_sync.mjs
// 배포 서버가 time_sync에 서버 시각으로 답하는지(#63 반영 여부) 확인한다. 방을 하나 만들고 지운다.
// 환영 메시지 처리(Gemini 호출)가 한 번 돈다.
import { wake, createRoom, deleteRoom } from './late_join_deployed.mjs';

const WS = 'wss://vibe-syncer.onrender.com/ws';
const result = { errors: [], warm_ms: [] };
let room, host;
try {
  await wake(result);
  ({ room, host } = await createRoom(result));
  const ws = new WebSocket(`${WS}/${room.room_code}?token=${host.token}`);
  const replies = await new Promise((resolve, reject) => {
    const got = [];
    const timer = setTimeout(() => resolve(got), 8000);
    ws.onerror = () => { clearTimeout(timer); reject(new Error('websocket error')); };
    ws.onopen = () => {
      for (let i = 0; i < 5; i++) setTimeout(() => ws.send(JSON.stringify({ type: 'time_sync', id: i, t0: Date.now() })), i * 200);
    };
    ws.onmessage = event => {
      const data = JSON.parse(event.data);
      if (data.type !== 'time_sync') return;
      got.push({ ...data, t1: Date.now() });
      if (got.length === 5) { clearTimeout(timer); resolve(got); }
    };
  });
  ws.close();
  const ok = replies.length > 0 && replies.every(r => Number.isFinite(r.server_ms));
  console.log(JSON.stringify({ deployed: ok, replies: replies.length,
    offsets_ms: replies.map(r => Math.round(r.server_ms - Date.now())), }));
  process.exitCode = ok ? 0 : 1;
} catch (error) {
  console.log(JSON.stringify({ deployed: false, error: error.message }));
  process.exitCode = 1;
} finally {
  await deleteRoom(result, room, host);
  if (result.room_deleted !== true) console.log(`room cleanup: ${result.room_deleted}`);
}
