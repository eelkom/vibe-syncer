import { fetchChatMessagesAPI } from '@/api/chatApi';
import {
  ChatMessageResponseSchema,
  type ChatMessageResponse,
} from '@/schemas/chatSchema';
import { getMessageId } from '@/utils/getMessageId';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';

const ChatMessagesArraySchema = z.array(ChatMessageResponseSchema);

const useChatMessages = (roomCode: string) => {
  return useQuery({
    queryKey: ['chatMessages', roomCode],
    queryFn: async () => {
      const rawData = await fetchChatMessagesAPI(roomCode);
      const validatedData = ChatMessagesArraySchema.parse(rawData);

      const messageMap = new Map<string, ChatMessageResponse>();
      validatedData.forEach((msg) => {
        messageMap.set(getMessageId(msg), msg);
      });
      return messageMap;
    },
    enabled: !!roomCode,
    staleTime: 1000 * 10,
    retry: 1,
  });
};

export default useChatMessages;
