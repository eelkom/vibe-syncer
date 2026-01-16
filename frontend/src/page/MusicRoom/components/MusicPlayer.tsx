import { Play, Pause, Loader2 } from 'lucide-react';
import { useMusicPlayer } from '@/contexts/hooks/ useMusicPlayer';

const MusicPlayer = () => {
  const {
    isPlaying,
    play,
    pause,
    duration,
    played,
    seekTo,
    isReady,
    currentUrl,
  } = useMusicPlayer();

  const handlePlayPause = () => {
    if (isPlaying) {
      pause();
    } else {
      play();
    }
  };

  const handleSeekChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const amount = parseFloat(e.target.value);
    seekTo(amount);
  };

  const formatTime = (seconds: number) => {
    if (!seconds) return '00:00';
    const minutes = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${minutes}:${secs < 10 ? '0' : ''}${secs}`;
  };

  const currentTime = duration * played;

  return (
    <div className="w-full rounded-2xl border border-zinc-800 bg-zinc-900 p-6 shadow-xl">
      <div className="flex flex-col gap-4">
        <div className="text-center">
          <h3 className="text-lg font-bold text-white">Now Playing</h3>

          <p className="truncate px-4 text-sm text-zinc-400">
            {currentUrl
              ? `Streaming from ${new URL(currentUrl).hostname}`
              : 'No URL'}
          </p>
        </div>

        <div className="flex items-center gap-3 text-xs text-zinc-400">
          <span className="w-10 text-right">{formatTime(currentTime)}</span>
          <input
            type="range"
            min={0}
            max={1}
            step="any"
            value={played}
            onChange={handleSeekChange}
            disabled={!isReady}
            className="h-1 flex-1 cursor-pointer appearance-none rounded-full bg-zinc-700 accent-indigo-500 disabled:opacity-50"
          />
          <span className="w-10">{formatTime(duration)}</span>
        </div>

        <div className="flex items-center justify-center gap-6">
          <button
            onClick={handlePlayPause}
            disabled={!isReady}
            className="flex h-14 w-14 items-center justify-center rounded-full bg-indigo-600 text-white transition-all hover:scale-105 hover:bg-indigo-500 active:scale-95 disabled:bg-zinc-700 disabled:opacity-50"
          >
            {!isReady ? (
              <Loader2 className="animate-spin" />
            ) : isPlaying ? (
              <Pause fill="currentColor" />
            ) : (
              <Play fill="currentColor" className="ml-1" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default MusicPlayer;
