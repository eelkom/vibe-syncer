import { fetchQueueListAPI } from '@/api/queueApi';
import { useCallback, useState } from 'react';
import { z } from 'zod';
import { logger } from '@/utils/logger';

interface Song {
  id: string;
  title: string;
  artist: string;
  addedBy: string;
  url: string;
}

const SongSchema = z.object({
  id: z.string(),
  title: z.string(),
  artist: z.string(),
  addedBy: z.string(),
  url: z.string().url(),
});

const SongsArraySchema = z.array(SongSchema);

const useQueueList = () => {
  const [queueList, setQueueList] = useState<Song[]>([]);
  const [error, setError] = useState<string | null>(null);

  const fetchQueueList = useCallback(async (roomCode: string) => {
    try {
      const rawData = await fetchQueueListAPI(roomCode);

      const validatedData = SongsArraySchema.parse(rawData);

      setQueueList(validatedData);
      setError(null);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const errorMessage = error.issues
          .map((err) => `${err.path.join('.')}: ${err.message}`)
          .join(', ');
        logger.error('[Queue] fail:', errorMessage);
        setError(`fail: ${errorMessage}`);
      } else {
        logger.error('[Queue] API error:', error);
        setError('error');
      }
    }
  }, []);

  return { queueList, fetchQueueList, error };
};

export default useQueueList;
