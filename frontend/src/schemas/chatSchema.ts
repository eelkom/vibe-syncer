import z from 'zod';

export const ChatMessageResponseSchema = z.object({
  id: z.number().int(),
  user_id: z.number().int(),
  room_id: z.number().int(),
  username: z.string(),
  message: z.string(),
  created_at: z.string(),
});

export type ChatMessageResponse = z.infer<typeof ChatMessageResponseSchema>;
