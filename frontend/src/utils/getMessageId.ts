import type { ChatMessage } from '@/schemas/chatSchema';

export const getMessageId = (msg: ChatMessage) => {
  const messageContent = msg.message || '';
  return `${msg.user_id}-${msg.created_at}-${msg.id}-${messageContent.slice(0, 20)}`;
};
