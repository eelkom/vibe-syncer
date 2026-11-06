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
// Explicit timestamps avoid the transaction-stable now() default tying songs.
export async function orderedSeed(database, songs) {
  if (!songs.length) throw new Error('orderedSeed requires at least one song');
  const data = await seed(database, { queue: false });
  const client = new pg.Client({ ...DB, database });
  await client.connect();
  const queue = [];
  const createdAt = Date.now();
  try {
    await client.query('BEGIN');
    for (const [i, song] of songs.entries()) {
      const row = await client.query(`INSERT INTO queue_items
        (room_id,user_id,title,artist,thumbnail_url,music_url,platform,is_played,created_at)
        VALUES ($1,$2,$3,$4,NULL,$5,$6,false,$7) RETURNING *`,
      [data.room.id, data.room.host_id, song.title, song.artist, song.musicUrl, song.platform,
        new Date(createdAt + i * 1000)]);
      queue.push(row.rows[0]);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { await client.end(); }
  return { ...data, songs, queue };
}
export async function seed(database, { queue = true, musicUrl = 'http://127.0.0.1:15174/tone.webm',
  title = 'Stage1 tone', artist = 'Local', platform = 'Local' } = {}) {
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
      VALUES ($1,$2,$4,$5,NULL,$3,$6,false)`,
    [room.id, room.host_id, musicUrl, title, artist, platform]);
  } finally { await client.end(); }
  return { room, host, guest: g, sender };
}
