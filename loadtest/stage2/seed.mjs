import pg from 'pg';
import { DB, rest } from '../lib/common.mjs';
import { guest } from '../lib/database.mjs';
export async function seedStage2(database) {
  const room = await rest('/rooms/', { name: 'Stage2', host_nickname: 'host' });
  const host = { userId: room.host_id, nickname: 'host', isHost: true, token: room.token };
  const observer = await guest(room, 'observer');
  const client = new pg.Client({ ...DB, database }); await client.connect();
  try { await client.query(`INSERT INTO queue_items (room_id,user_id,title,artist,thumbnail_url,music_url,platform,is_played)
    VALUES ($1,$2,'Stage2 tone','Local',NULL,'http://127.0.0.1:15174/tone.webm','Local',false)`, [room.id, room.host_id]); }
  finally { await client.end(); }
  return { room, host, guest: observer };
}
