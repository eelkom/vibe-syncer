import { fetchQueueListAPI } from '@/api/queueApi';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { QueueArraySchema } from '@/schemas/queueSchema';

export const queueListQueryOptions = (roomCode: string) =>
  queryOptions({
    queryKey: ['queueList', roomCode],
    queryFn: async () => {
      const rawData = await fetchQueueListAPI(roomCode);
      const validatedData = QueueArraySchema.parse(rawData);
      return validatedData;
    },
    staleTime: 1000 * 10,
    retry: 1,
  });

const useQueueList = (roomCode: string) => {
  return useQuery({
    ...queueListQueryOptions(roomCode),
    enabled: !!roomCode,
  });
};

export default useQueueList;
