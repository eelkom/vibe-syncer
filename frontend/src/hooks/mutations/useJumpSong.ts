import { useMutation } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { jumpSongAPI } from '@/api/playerApi';

const useJumpSong = (roomCode: string) => {
  return useMutation({
    mutationFn: async (itemId: number) => {
      const rawData = await jumpSongAPI({ roomCode, itemId });
      return rawData;
    },
    onError: (error) => {
      toast.error(`[PlayNextSong] Error: ${error}`);
    },
  });
};

export default useJumpSong;
