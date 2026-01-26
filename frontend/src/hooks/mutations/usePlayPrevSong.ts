import { useMutation } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { playPrevSongAPI } from '@/api/playerApi';

const usePlayPrevSong = (roomCode: string) => {
  return useMutation({
    mutationFn: () => playPrevSongAPI(roomCode),
    onError: (error) => {
      toast.error(`[PlayPrevSong] Error: ${error}`);
    },
  });
};

export default usePlayPrevSong;
