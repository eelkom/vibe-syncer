import type { ChatMessageResponse } from '@/schemas/chatSchema';
import apiClient from './apiClient';

type ChatMessagesResponse = ChatMessageResponse[];

const CHAT_MESSAGE_LIMIT = 50;

export const fetchChatMessagesAPI = async (roomCode: string) => {
  const response = await apiClient.get<ChatMessagesResponse>(
    `/rooms/${roomCode}/chats`,
    {
      params: { limit: CHAT_MESSAGE_LIMIT },
    },
  );
  return response.data;
};
