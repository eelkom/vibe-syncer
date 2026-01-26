import z from 'zod';

export const QueueResponseSchema = z.object({
  title: z.string(),
  artist: z.string(),
  music_url: z.string(),
  thumbnail_url: z.string().nullable(),
  user_id: z.number().optional(),
  id: z.number(),
  room_id: z.number(),
  platform: z.string(),
  is_played: z.boolean(),
  created_at: z.string(),
});

export const QueueArraySchema = z.array(QueueResponseSchema);
export type QueueResponse = z.infer<typeof QueueResponseSchema>;
export type QueueArrayResponse = z.infer<typeof QueueArraySchema>;
