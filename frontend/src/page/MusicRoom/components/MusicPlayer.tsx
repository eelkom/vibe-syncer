import type { QueueResponse } from '@/schemas/queueSchema';
import { Play, Pause, Loader2, SkipBack, SkipForward } from 'lucide-react';

interface MusicPlayerProps {
  currentSong: QueueResponse | undefined;
  isPlaying: boolean;
  duration: number;
  played: number;
  isReady: boolean;
  isLoadingNextSong: boolean;
  hasError: boolean;
  isHost: boolean;
  needsSync: boolean;
  canPlayNext: boolean;
  canPlayPrev: boolean;

  onPlay: () => void;
  onPause: () => void;
  onSeek: (amount: number) => void;
  onSync: () => void;
  onPlayNext: () => void;
  onPlayPrev: () => void;
}

const MusicPlayer = ({
  currentSong,
  isPlaying,
  duration,
  played,
  isReady,
  isLoadingNextSong,
  hasError,
  isHost,
  needsSync,
  canPlayNext,
  canPlayPrev,
  onPlay,
  onPause,
  onSeek,
  onSync,
  onPlayNext,
  onPlayPrev,
}: MusicPlayerProps) => {
  const currentTitle = currentSong?.title || 'No Song Selected';
  const currentArtist = currentSong?.artist || 'No Artist';

  const handlePlayPause = () => {
    if (isPlaying) {
      onPause();
    } else {
      onPlay();
    }
  };

  const handleSeekChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const amount = parseFloat(e.target.value);
    onSeek(amount);
  };

  const formatTime = (seconds: number) => {
    if (!seconds) return '00:00';
    const minutes = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${minutes}:${secs < 10 ? '0' : ''}${secs}`;
  };

  const currentTime = duration * played;

  return (
    <div className="border-white/200 w-full rounded-3xl border bg-white/10 p-6 shadow-lg backdrop-blur-md transition-all hover:bg-white/15 hover:shadow-xl">
      <div className="flex flex-col gap-4">
        <div className="text-center">
          <h3 className="text-zinc text-lg font-bold">{currentTitle}</h3>

          <p className="truncate px-4 text-sm text-zinc-400">{currentArtist}</p>
        </div>

        <div className="flex items-center gap-3 text-xs text-zinc-400">
          <span className="w-10 text-right">{formatTime(currentTime)}</span>
          <div className="relative flex-1">
            {/* Background track */}
            <div className="h-1.5 w-full rounded-full bg-zinc-700" />
            {/* Filled progress */}
            <div
              className="absolute left-0 top-0 h-1.5 rounded-full bg-gradient-to-r from-indigo-500 to-purple-500 transition-all duration-100"
              style={{ width: `${played * 100}%` }}
            />
            {/* Thumb indicator */}
            <div
              className="absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full bg-white shadow-md transition-all duration-100"
              style={{ left: `calc(${played * 100}% - 6px)` }}
            />
            {/* Invisible range input for interaction */}
            <input
              type="range"
              min={0}
              max={1}
              step="any"
              value={played}
              onChange={handleSeekChange}
              disabled={!isReady || !isHost}
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
            />
          </div>
          <span className="w-10">{formatTime(duration)}</span>
        </div>

        <div className="flex items-center justify-center gap-6">
          {/* Previous */}
          <button
            onClick={onPlayPrev}
            disabled={!isHost || !currentSong || !canPlayPrev}
            className="text-zinc-400 transition-all hover:scale-110 hover:text-white active:scale-95 disabled:opacity-30 disabled:hover:scale-100 disabled:hover:text-zinc-400"
          >
            <SkipBack className="h-6 w-6" fill="currentColor" />
          </button>

          {/* Play/Pause */}
          <button
            onClick={needsSync ? onSync : handlePlayPause}
            disabled={!currentSong || (!isHost && !needsSync)}
            className={`flex h-14 w-14 items-center justify-center rounded-full text-white transition-all hover:scale-105 active:scale-95 disabled:opacity-50 ${
              needsSync
                ? 'animate-pulse bg-emerald-600 hover:bg-emerald-500'
                : 'bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-700'
            }`}
          >
            {!currentSong && hasError ? (
              <Play fill="currentColor" className="ml-1" />
            ) : isLoadingNextSong && !isReady ? (
              <Loader2 className="animate-spin" />
            ) : isPlaying ? (
              <Pause fill="currentColor" />
            ) : (
              <Play fill="currentColor" className="ml-1" />
            )}
          </button>

          {/* Next */}
          <button
            onClick={onPlayNext}
            disabled={!isHost || !currentSong || !canPlayNext}
            className="text-zinc-400 transition-all hover:scale-110 hover:text-white active:scale-95 disabled:opacity-30 disabled:hover:scale-100 disabled:hover:text-zinc-400"
          >
            <SkipForward className="h-6 w-6" fill="currentColor" />
          </button>
        </div>
      </div>
    </div>
  );
};

export default MusicPlayer;
