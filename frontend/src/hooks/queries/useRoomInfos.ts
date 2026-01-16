import { fetchRoomInfosAPI } from '@/api/roomApi';
import { RoomInfosResponseSchema } from '@/schemas/roomSchemas';
import { useQuery } from '@tanstack/react-query';

const useRoomInfos = (roomCode: string) => {
  return useQuery({
    queryKey: ['roomInfos', roomCode],
    queryFn: async () => {
      const rawData = await fetchRoomInfosAPI(roomCode);
      const validatedData = RoomInfosResponseSchema.parse(rawData);
      return validatedData;
    },
    enabled: !!roomCode,
    staleTime: 1000 * 10,
    retry: 1,
  });
};

export default useRoomInfos;
