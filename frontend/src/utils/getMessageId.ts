import type { ChatMessageResponse } from '@/schemas/chatSchema';

export const getMessageId = (msg: ChatMessageResponse) => {
  return `${msg.user_id}-${msg.created_at}-${msg.id}-${msg.message.slice(0, 20)}`;
};
