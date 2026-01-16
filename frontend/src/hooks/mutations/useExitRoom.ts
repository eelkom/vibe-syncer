import { exitRoomAPI } from '@/api/roomApi';

import { useParams } from 'react-router-dom';
import { ExitRoomResponseSchema } from '@/schemas/roomSchemas';
import { z } from 'zod';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'react-toastify';

export interface UseExitRoomProps {
  roomCode?: string;
}

const useExitRoom = () => {
  const { id: roomCode } = useParams();

  return useMutation({
    mutationFn: async () => {
      const rawData = await exitRoomAPI({ roomCode });
      const validatedData = ExitRoomResponseSchema.parse(rawData);

      return validatedData.message;
    },
    onError: (error) => {
      if (error instanceof z.ZodError) {
        const errorMessage = error.issues
          .map((err) => `${err.path.join('.')}: ${err.message}`)
          .join(', ');
        toast.error(`[ExitRoom] Validation failed: ${errorMessage}`);
      } else {
        toast.error(`[ExitRoom] Error: ${error}`);
      }
    },
  });
};

export default useExitRoom;
