import z from 'zod';
import { ChatMessageSchema } from './chatSchema';

export const SyncSocketMessageSchema = z.object({
  type: z.literal('sync'),
  action: z.string(),
  timestamp: z.number().optional(),
  videoId: z.string().optional(),
  user_id: z.number().int().optional(),
});

export const ChatSocketMessageSchema = ChatMessageSchema.extend({
  type: z.literal('chat'),
});

export const SystemSocketMessageSchema = z.object({
  type: z.literal('system'),
  message: z.string(),
});

export const QueueUpdateSocketMessageSchema = z.object({
  type: z.literal('queue_update'),
});

export const SocketMessageSchema = z.discriminatedUnion('type', [
  SyncSocketMessageSchema,
  ChatSocketMessageSchema,
  SystemSocketMessageSchema,
  QueueUpdateSocketMessageSchema,
]);

export type SyncSocketMessage = z.infer<typeof SyncSocketMessageSchema>;
export type ChatSocketMessage = z.infer<typeof ChatSocketMessageSchema>;
export type SystemSocketMessage = z.infer<typeof SystemSocketMessageSchema>;
export type QueueUpdateSocketMessage = z.infer<
  typeof QueueUpdateSocketMessageSchema
>;

export interface SocketMessageMap {
  sync: SyncSocketMessage;
  chat: ChatSocketMessage;
  system: SystemSocketMessage;
  queue_update: QueueUpdateSocketMessage;
}

export type SocketMessageType = keyof SocketMessageMap;
