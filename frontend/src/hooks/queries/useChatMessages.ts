import { fetchChatMessagesAPI } from '@/api/chatApi';
import { ChatMessageResponseSchema } from '@/schemas/chatSchema';
import { mergeChatMessages, type ChatMessageMap } from '@/utils/chatMessages';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';

const ChatMessagesArraySchema = z.array(ChatMessageResponseSchema);

const useChatMessages = (roomCode: string) => {
  const queryClient = useQueryClient();
  const queryKey = ['chatMessages', roomCode];

  return useQuery({
    queryKey,
    queryFn: async () => {
      const rawData = await fetchChatMessagesAPI(roomCode);
      const validatedData = ChatMessagesArraySchema.parse(rawData);

      // Read the cache after the request resolves so messages received over
      // WebSocket in the meantime are merged instead of overwritten
      const cached = queryClient.getQueryData<ChatMessageMap>(queryKey);
      return mergeChatMessages(cached, validatedData);
    },
    enabled: !!roomCode,
    staleTime: 1000 * 10,
    retry: 1,
  });
};

export default useChatMessages;
