import useQueueList from '@/hooks/queries/useQueueList';
import { useEffect } from 'react';

interface QueueBoardProps {
  roomCode: string;
}

const QueueBoard = ({ roomCode }: QueueBoardProps) => {
  const { queueList, fetchQueueList } = useQueueList();
  useEffect(() => {
    fetchQueueList(roomCode);
  }, [roomCode, fetchQueueList]);

  return (
    <div className="flex w-80 flex-col gap-6">
      <div className="flex flex-1 flex-col rounded-3xl border border-gray-200 bg-white p-6 shadow-lg transition-shadow hover:shadow-xl">
        <div className="mb-6 flex items-center gap-3 border-b border-gray-100 pb-4">
          <h2 className="text-sm uppercase tracking-wide text-gray-900">
            Queue
          </h2>
          <span className="text-xs text-gray-400">
            {queueList?.length || 0}
          </span>
        </div>
        <div className="flex-1 space-y-2 overflow-y-auto">
          {queueList &&
            queueList.length > 0 &&
            queueList?.map((song, index) => (
              <div
                key={song.id}
                className="group cursor-pointer rounded-2xl p-4 transition-all hover:bg-gray-50"
              >
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 w-6 font-mono text-xs text-gray-400">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-gray-900">
                      {song.title}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-gray-500">
                      {song.artist}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          {queueList?.length === 0 && (
            <div className="py-20 text-center">
              <p className="text-xs text-gray-400">Empty queue</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default QueueBoard;
