import type { QueueArrayResponse } from '@/schemas/queueSchema';

const useCurrentSongInfo = (queueList: QueueArrayResponse | undefined) => {
  const currentSong = queueList?.find((song) => !song.is_played);
  const currentSongId = currentSong?.id || 0;
  const currentSongUrl = currentSong?.music_url;

  const currentIndex =
    queueList?.findIndex((song) => song.id === currentSongId) ?? -1;
  const canPlayPrev = currentIndex > 0;
  const canPlayNext =
    currentIndex > -1 && currentIndex < (queueList?.length ?? 0) - 1;

  return {
    currentSong,
    currentSongId,
    currentSongUrl,
    canPlayPrev,
    canPlayNext,
  };
};

export default useCurrentSongInfo;
