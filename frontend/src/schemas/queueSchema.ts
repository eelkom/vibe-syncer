import z from 'zod';

export const QueueResponseSchema = z.object({
  id: z.string(),
  title: z.string(),
  artist: z.string(),
  addedBy: z.string(),
  url: z.string().url(),
});

export type QueuesArrayResponse = z.infer<typeof QueueResponseSchema>[];
