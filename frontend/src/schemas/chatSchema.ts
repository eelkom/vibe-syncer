import z from 'zod';

export const ChatMessageResponseSchema = z.object({
  id: z.number().int(),
  user_id: z.number().int(),
  room_id: z.number().int(),
  username: z.string(),
  message: z.string(),
  created_at: z.string(),
  type: z.string().optional(),
});

export type ChatMessageResponse = z.infer<typeof ChatMessageResponseSchema>;

// WebSocket chat broadcasts don't include `id` and `room_id`
export const ChatMessageSchema = ChatMessageResponseSchema.partial({
  id: true,
  room_id: true,
});

export type ChatMessage = z.infer<typeof ChatMessageSchema>;
