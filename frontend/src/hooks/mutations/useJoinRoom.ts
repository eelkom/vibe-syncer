import { joinRoomAPI } from '@/api/roomApi';
import { useUser } from '@/contexts/UserContext';
import { JoinRoomResponseSchema } from '@/schemas/roomSchemas';
import { z } from 'zod';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'react-toastify';

export interface UseJoinRoomProps {
  roomCode: string;
  nickName: string;
}

const useJoinRoom = () => {
  const { login } = useUser();

  return useMutation({
    mutationFn: async ({ roomCode, nickName }: UseJoinRoomProps) => {
      const rawData = await joinRoomAPI({ roomCode, nickName });
      const validatedData = JoinRoomResponseSchema.parse(rawData);

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
