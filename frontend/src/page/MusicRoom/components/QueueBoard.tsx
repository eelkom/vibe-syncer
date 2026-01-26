import Error from '@/components/ui/Error';
import Loading from '@/components/ui/Loading';
import type { QueueResponse } from '@/schemas/queueSchema';
import { useEffect, useRef } from 'react';

interface QueueBoardProps {
  queueList: QueueResponse[] | undefined;
  isLoading: boolean;
  isError: boolean;
  currentSongId: number;
  onJumpSong: (itemId: number) => void;
}

const QueueBoard = ({
  queueList,
  isLoading,
  isError,
  currentSongId,
  onJumpSong,
}: QueueBoardProps) => {
  const queueContainerRef = useRef<HTMLDivElement>(null);
  const currentSongRef = useRef<HTMLDivElement>(null);
  const previousQueueLengthRef = useRef(0);

  useEffect(() => {
    const currentLength = queueList?.length || 0;
    const hasNewSong = currentLength > previousQueueLengthRef.current;

    if (hasNewSong && currentSongRef.current) {
      currentSongRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
      });
    }

    previousQueueLengthRef.current = currentLength;
  }, [queueList?.length]);

  if (isError) return <Error />;

  return (
    <div className="flex flex-1 flex-col rounded-3xl border border-gray-200 bg-white shadow-lg transition-shadow hover:shadow-xl">
      <div className="flex flex-1 flex-col overflow-hidden rounded-3xl border border-gray-200 bg-white shadow-lg transition-shadow hover:shadow-xl">
        <div className="flex items-center gap-3 border-b border-gray-100 p-6">
          <h2 className="text-sm uppercase tracking-wide text-gray-900">
            Queue
          </h2>
          <span className="text-xs text-gray-400">
            {queueList?.length || 0}
          </span>
        </div>

        <div
          ref={queueContainerRef}
          className="scrollbar-hide flex-1 space-y-4 overflow-y-auto p-6"
        >
          {isLoading ? (
            <div className="flex h-full w-full items-center justify-center">
              <Loading />
            </div>
          ) : (
            queueList &&
            queueList.length > 0 &&
            (() => {
              return queueList.map((song, index) => {
                const isCurrentSong = song.id === currentSongId;
                return (
                  <div
                    key={song.id}
                    ref={isCurrentSong ? currentSongRef : null}
                    onClick={() => onJumpSong(song.id)}
                    className={`group cursor-pointer rounded-2xl p-4 transition-all ${
                      song.is_played
                        ? 'bg-gray-100 opacity-60'
                        : isCurrentSong
                          ? 'bg-indigo-50 ring-2 ring-indigo-500'
                          : 'hover:bg-gray-50'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <span className="mt-0.5 w-6 font-mono text-xs text-gray-400">
                        {String(index + 1).padStart(2, '0')}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p
                          className={`truncate text-sm ${
                            song.is_played ? 'text-gray-600' : 'text-gray-900'
                          }`}
                        >
                          {song.title}
                        </p>
                        <p className="mt-0.5 truncate text-xs text-gray-500">
                          {song.artist}
                        </p>
                      </div>
                    </div>
                  </div>
                );
              });
            })()
          )}
          {!isLoading && queueList?.length === 0 && (
            <div className="flex h-full w-full items-center justify-center">
              <p className="text-xs text-gray-400">Empty queue</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default QueueBoard;
