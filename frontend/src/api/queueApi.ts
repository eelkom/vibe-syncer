import apiClient from './apiClient';

export const fetchQueueListAPI = async (roomCode: string) => {
  const response = await apiClient.get(`/rooms/${roomCode}/queue_list`);
  return response.data;
};
