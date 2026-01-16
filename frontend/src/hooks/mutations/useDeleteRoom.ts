import { deleteRoomAPI } from '@/api/roomApi';
import { useParams } from 'react-router-dom';
import { DeleteRoomResponseSchema } from '@/schemas/roomSchemas';
import { useMutation } from '@tanstack/react-query';
import { z } from 'zod';

import { toast } from 'react-toastify';

const useDeleteRoom = () => {
  const { id: roomCode } = useParams();

  return useMutation({
    mutationFn: async () => {
      const rawData = await deleteRoomAPI({ roomCode });
      const validatedData = DeleteRoomResponseSchema.parse(rawData);

      return validatedData.message;
    },
    onError: (error) => {
      if (error instanceof z.ZodError) {
        const errorMessage = error.issues
          .map((err) => `${err.path.join('.')}: ${err.message}`)
          .join(', ');
        toast.error(`[DeleteRoom] Validation failed: ${errorMessage}`);
      } else {
        toast.error(`[DeleteRoom] Error: ${error}`);
      }
    },
  });
};

export default useDeleteRoom;
