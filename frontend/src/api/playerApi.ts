import apiClient from './apiClient';

interface JumpSongAPIProps {
  roomCode: string;
  itemId: number;
}

export const playNextSongAPI = async (roomCode: string) => {
  const response = await apiClient.post<string>(
    `/rooms/${roomCode}/player/next`,
    {},
  );
  return response.data;
};

export const playPrevSongAPI = async (roomCode: string) => {
  const response = await apiClient.post<string>(
    `/rooms/${roomCode}/player/prev`,
    {},
  );
  return response.data;
};

export const jumpSongAPI = async ({ roomCode, itemId }: JumpSongAPIProps) => {
  const response = await apiClient.post<string>(
    `/rooms/${roomCode}/player/jump/${itemId}`,
  );
  return response.data;
};
