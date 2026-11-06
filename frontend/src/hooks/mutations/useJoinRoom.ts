import { joinRoomAPI } from '@/api/roomApi';
import { useUser } from '@/contexts/UserContext';
import { queueListQueryOptions } from '@/hooks/queries/useQueueList';
import { JoinRoomResponseSchema } from '@/schemas/roomSchemas';
import { z } from 'zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';

export interface UseJoinRoomProps {
  roomCode: string;
  nickName: string;
}

const useJoinRoom = () => {
  const { login } = useUser();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ roomCode, nickName }: UseJoinRoomProps) => {
      void queryClient.prefetchQuery(queueListQueryOptions(roomCode));

      const rawData = await joinRoomAPI({ roomCode, nickName });
      const validatedData = JoinRoomResponseSchema.parse(rawData);

      // Show prefetched data immediately, but refetch on room mount because songs may have changed during joining.
      void queryClient.invalidateQueries({
        queryKey: queueListQueryOptions(roomCode).queryKey,
        refetchType: 'none',
      });

      login({
        userId: validatedData.user_id,
        nickname: nickName,
        isHost: false,
        token: validatedData.token,
      });

      return validatedData.room_code;
    },
    onError: (error) => {
      if (error instanceof z.ZodError) {
        const errorMessage = error.issues
          .map((err) => `${err.path.join('.')}: ${err.message}`)
          .join(', ');
        toast.error(`[JoinRoom] Validation failed: ${errorMessage}`);
      } else {
        toast.error(`[JoinRoom] Error: ${error}`);
      }
    },
  });
};

export default useJoinRoom;
