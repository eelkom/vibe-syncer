import { createRoomAPI } from '@/api/roomApi';
import { useUser } from '@/contexts/UserContext';
import { CreateRoomResponseSchema } from '@/schemas/roomSchemas';
import { z } from 'zod';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'react-toastify';

export interface UseCreateRoomProps {
  roomName: string;
  hostNickName: string;
}

const useCreateRoom = () => {
  const { login } = useUser();

  return useMutation({
    mutationFn: async ({ roomName, hostNickName }: UseCreateRoomProps) => {
      const rawData = await createRoomAPI({ roomName, hostNickName });
      const validatedData = CreateRoomResponseSchema.parse(rawData);

      login({
        userId: validatedData.host_id,
        nickname: hostNickName,
        isHost: true,
        token: validatedData.token,
      });

      return validatedData.room_code;
    },
    onError: (error) => {
      if (error instanceof z.ZodError) {
        const errorMessage = error.issues
          .map((err) => `${err.path.join('.')}: ${err.message}`)
          .join(', ');
        toast.error(`[CreateRoom] Validation failed: ${errorMessage}`);
      } else {
        toast.error(`[CreateRoom] Error: ${error}`);
      }
    },
  });
};

export default useCreateRoom;
