import pg from 'pg';
import { DB, rest } from './common.mjs';
function valid(name) {
  if (!/^loadtest_[a-z0-9_]+$/.test(name) || name.length > 63) throw new Error(`Unsafe DB name: ${name}`);
}
export async function adminQuery(sql, params = []) {
  const client = new pg.Client(DB);
  await client.connect();
  try { return await client.query(sql, params); } finally { await client.end(); }
}
export async function createDatabase(name) {
  valid(name);
  // Existing DB is an error; never delete another run's database on startup.
  await adminQuery(`CREATE DATABASE "${name}"`);
  await adminQuery(`ALTER DATABASE "${name}" SET timezone TO 'UTC'`);
}
export async function dropDatabase(name) {
  valid(name);
  await adminQuery(`DROP DATABASE "${name}" WITH (FORCE)`);
}
export async function guest(room, nickname) {
  const g = await rest('/rooms/join', { room_code: room.room_code, nickname });
  return { userId: g.user_id, nickname, isHost: false, token: g.token };
}
export async function seed(database, { queue = true } = {}) {
  const room = await rest('/rooms/', { name: 'Stage1', host_nickname: 'host' });
  const host = { userId: room.host_id, nickname: 'host', isHost: true, token: room.token };
  const g = await guest(room, 'observer');
  const sender = await guest(room, 'sender');
  if (!queue) return { room, host, guest: g, sender };
  const client = new pg.Client({ ...DB, database });
  await client.connect();
  try {
    // All comparison schemas: QueueResponse.platform is str/z.string(); SQL model
    // is String without enum (backend/app/models/models.py, schemas/schemas.py).
    await client.query(`INSERT INTO queue_items
      (room_id,user_id,title,artist,thumbnail_url,music_url,platform,is_played)
      VALUES ($1,$2,'Stage1 tone','Local',NULL,$3,'Local',false)`,
    [room.id, room.host_id, 'http://127.0.0.1:15174/tone.webm']);
  } finally { await client.end(); }
  return { room, host, guest: g, sender };
}
