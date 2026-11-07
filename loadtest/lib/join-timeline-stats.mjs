import { windowP95 } from './sync-stats.mjs';

export const JOIN_TIMES = Object.freeze(['join_request_sent', 'join_response', 'room_route',
  'queue_request_sent', 'queue_response', 'chats_response', 'room_response', 'ws_open', 'first_sync_frame',
  'player_mount', 'player_ready', 'first_seek_start', 'first_seek_end', 'first_playing', 'first_progress', 'unmuted']);
export const JOIN_INTERVALS = Object.freeze(['join_api', 'route_to_queue_response', 'queue_response_to_mount',
  'mount_to_ready', 'ready_to_seek_end', 'seek_end_to_progress', 'total_to_progress', 'total_to_sound',
  'prefetch_upper_bound', 'queue_blocking_share', 'position_error_15_25s_p95_ms']);

// All inputs are epoch milliseconds. Keep missing markers null, including
// when ready/seek events are absent despite observed playback.
export function joinTimelineStats({ t0, end = Infinity, roomCode, requests = [], events = [],
  samples = [], wsLog = [], frames = [], clicks = [], errors = [] }) {
  const valid = t => Number.isFinite(t) && Number.isFinite(t0) && t >= t0 && t <= end;
  const first = values => values.filter(valid).sort((a, b) => a - b)[0] ?? null;
  const at = Object.fromEntries(JOIN_TIMES.map(name => [name, null]));
  for (const name of JOIN_TIMES) at[name] = first(events.filter(e => e.name === name).map(e => e.t));
  const matches = (record, kind) => {
    const pathname = new URL(record.url).pathname.replace(/\/$/, '');
    const room = `/rooms/${roomCode}`;
    return kind === 'join' ? record.method === 'POST' && pathname === '/rooms/join'
      : record.method === 'GET' && pathname === (kind === 'room' ? room : `${room}/${kind}`);
  };
  for (const [kind, requestName, responseName] of [['join', 'join_request_sent', 'join_response'],
    ['queue_list', 'queue_request_sent', 'queue_response'], ['chats', null, 'chats_response'], ['room', null, 'room_response']]) {
    const request = requests.filter(r => valid(r.sent_at) && matches(r, kind)).toSorted((a, b) => a.sent_at - b.sent_at)[0];
    if (requestName) at[requestName] = request?.sent_at ?? null;
    // Never pair a retry's completion with the first request's start.
    at[responseName] = valid(request?.finished_at) ? request.finished_at : null;
  }
  at.ws_open = first(wsLog.map(r => r.open_at));
  at.first_sync_frame = first(frames.filter(f => f.data?.type === 'sync').map(f => f.t));
  let previous = null;
  for (const s of samples.filter(s => valid(s.t)).toSorted((a, b) => a.t - b.t)) {
    if (s.none || s.ad || s.paused !== false || !Number.isFinite(s.ct)) { previous = null; continue; }
    // A seek jump is not proof that the playback clock is moving. Require a
    // second playing sample, with the same source, and ordinary advancement.
    const delta = previous ? s.ct - previous.ct : null;
    if (previous && s.t > previous.t && s.src === previous.src && s.media_url === previous.media_url
      && delta > 0 && delta <= 2 * (s.t - previous.t) / 1000 + 0.05) {
      at.first_progress = s.t;
      break;
    }
    previous = s;
  }
  const unmuteClick = first(clicks.filter(c => c.kind === 'unmute').map(c => c.t));
  at.unmuted = unmuteClick === null ? null : first(samples.filter(s => s.t >= unmuteClick && !s.none && !s.ad && s.muted === false).map(s => s.t));
  const relative = Object.fromEntries(JOIN_TIMES.map(name => [name, at[name] === null ? null : at[name] - t0]));
  const diff = (from, to) => at[from] === null || at[to] === null ? null : at[to] - at[from];
  const upper = diff('room_route', 'queue_response');
  const intervals = {
    join_api: diff('join_request_sent', 'join_response'),
    route_to_queue_response: upper,
    queue_response_to_mount: diff('queue_response', 'player_mount'),
    mount_to_ready: diff('player_mount', 'player_ready'),
    ready_to_seek_end: diff('player_ready', 'first_seek_end'),
    seek_end_to_progress: diff('first_seek_end', 'first_progress'),
    total_to_progress: relative.first_progress, total_to_sound: relative.unmuted,
    prefetch_upper_bound: upper === null ? null : Math.max(0, upper),
    queue_blocking_share: null,
    position_error_15_25s_p95_ms: Number.isFinite(t0) ? windowP95(errors, t0 + 15000, Math.min(end + 1, t0 + 25000)) : null,
  };
  if (intervals.prefetch_upper_bound !== null && intervals.total_to_progress > 0) {
    intervals.queue_blocking_share = intervals.prefetch_upper_bound / intervals.total_to_progress;
  }
  return { times: relative, intervals, raw: { t0: t0 ?? null, timestamps: at } };
}
