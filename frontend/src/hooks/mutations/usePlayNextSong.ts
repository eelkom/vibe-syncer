import { useMutation } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { playNextSongAPI } from '@/api/playerApi';

const usePlayNextSong = (roomCode: string) => {
  return useMutation({
    mutationFn: () => playNextSongAPI(roomCode),
    onError: (error) => {
      toast.error(`[PlayNextSong] Error: ${error}`);
    },
  });
};

export default usePlayNextSong;
