import type { ChatMessage } from '@/schemas/chatSchema';

/**
 * Dedup key for a chat message. Uses the server id; messages without an id
 * (WebSocket broadcasts don't include it) fall back to a composite key.
 */
export const getMessageId = (msg: ChatMessage) => {
  if (msg.id !== undefined) return `id:${msg.id}`;

  const messageContent = msg.message || '';
  return `live:${msg.user_id}-${msg.created_at}-${messageContent.slice(0, 20)}`;
};
