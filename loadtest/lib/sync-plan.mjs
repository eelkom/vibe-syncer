import { YOUTUBE_VIDEO, YOUTUBE_SECOND_VIDEO } from './youtube.mjs';
export const SYNC_CONDITIONS = Object.freeze({
  host_no_action: ['local', 'youtube'],
  song_change: ['local-next', 'local-prev', 'local-jump', 'youtube-next'],
  natural_end: ['local'],
  host_reconnect: ['local-seek', 'local-alone', 'youtube-seek'],
  host_refresh: ['local'],
  long_playback: ['youtube-natural', 'local-disturbed'],
  interval_probe: ['local-3000', 'local-5000', 'local-10000', 'local-30000'],
  server_block: ['welcome', 'dj', 'url'],
});
export function syncSongs(scenario, condition) {
  const youtube = condition.includes('youtube');
  const song = (url, i) => ({ musicUrl: url, title: `Sync song ${i + 1}`, artist: youtube ? 'YouTube' : 'Local', platform: youtube ? 'Youtube' : 'Local' });
  if (scenario === 'natural_end') return ['short.webm', 'long.webm'].map((file, i) => song(`http://127.0.0.1:15174/${file}`, i));
  if (youtube) return (scenario === 'song_change' ? [YOUTUBE_VIDEO.url, YOUTUBE_SECOND_VIDEO.url] : [YOUTUBE_VIDEO.url]).map(song);
  return (scenario === 'song_change' ? ['a', 'b'] : ['a']).map((id, i) => song(`http://127.0.0.1:15174/tone.webm?song=${id}`, i));
}
