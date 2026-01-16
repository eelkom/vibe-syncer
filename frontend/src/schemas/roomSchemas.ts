import { z } from 'zod';

export const CreateRoomResponseSchema = z.object({
  name: z.string().min(1, 'Room name is required'),
  id: z.number().int().nonnegative(),
  room_code: z.string().min(1, 'Room code is required'),
  host_id: z.number().int().positive('Host ID must be positive'),
  host_nickname: z.string().min(1, 'Host nickname is required'),
  created_at: z.string().datetime('Invalid date format'),
  token: z.string().min(1, 'Token is required'),
});

export type CreateRoomResponse = z.infer<typeof CreateRoomResponseSchema>;

export const JoinRoomResponseSchema = z.object({
  id: z.number().int().nonnegative(),
  user_id: z.number().int().nonnegative(),
  room_id: z.number().int().nonnegative(),
  joined_at: z.string().datetime('Invalid date format'),
  room_name: z.string().min(1, 'Room name is required'),
  room_code: z.string().min(1, 'Room code is required'),
  host_nickname: z.string().min(1, 'Host nickname is required'),
  nickname: z.string().min(1, 'User nickname is required'),
  token: z.string().min(1, 'Token is required'),
});
export type JoinRoomResponse = z.infer<typeof JoinRoomResponseSchema>;

export const ExitRoomResponseSchema = z.object({
  message: z.string(),
});
export type ExitRoomResponse = z.infer<typeof ExitRoomResponseSchema>;

export const DeleteRoomResponseSchema = z.object({
  message: z.string(),
});
export type DeleteRoomResponse = z.infer<typeof DeleteRoomResponseSchema>;

export const RoomInfosResponseSchema = z.object({
  room_id: z.number().int(),
  room_code: z.string(),
  name: z.string(),
  created_at: z.string().datetime(),
  host_id: z.number().int(),
  host_nickname: z.string(),
  participants: z.array(z.any()).default([]),
});
export type RoomInfosResponse = z.infer<typeof RoomInfosResponseSchema>;
