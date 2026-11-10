import z from 'zod';
import { ChatMessageSchema } from './chatSchema';

export const SyncSocketMessageSchema = z.object({
  type: z.literal('sync'),
  action: z.string(),
  timestamp: z.number().optional(),
  videoId: z.string().optional(),
  user_id: z.number().int().optional(),
  snapshot: z.boolean().optional(),
  // Server time (ms) when the host read timestamp from its player
  position_at_ms: z.number().optional(),
  // Server time (ms) when the server received or built this message
  server_ms: z.number().optional(),
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

export const TimeSyncSocketMessageSchema = z.object({
  type: z.literal('time_sync'),
  id: z.number(),
  server_ms: z.number(),
});

export const SocketMessageSchema = z.discriminatedUnion('type', [
  SyncSocketMessageSchema,
  ChatSocketMessageSchema,
  SystemSocketMessageSchema,
  QueueUpdateSocketMessageSchema,
  TimeSyncSocketMessageSchema,
]);

export type SyncSocketMessage = z.infer<typeof SyncSocketMessageSchema>;
export type ChatSocketMessage = z.infer<typeof ChatSocketMessageSchema>;
export type SystemSocketMessage = z.infer<typeof SystemSocketMessageSchema>;
export type QueueUpdateSocketMessage = z.infer<
  typeof QueueUpdateSocketMessageSchema
>;
export type TimeSyncSocketMessage = z.infer<typeof TimeSyncSocketMessageSchema>;

export interface SocketMessageMap {
  sync: SyncSocketMessage;
  chat: ChatSocketMessage;
  system: SystemSocketMessage;
  queue_update: QueueUpdateSocketMessage;
  time_sync: TimeSyncSocketMessage;
}

export type SocketMessageType = keyof SocketMessageMap;
