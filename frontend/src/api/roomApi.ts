import type { UseExitRoomProps } from '@/hooks/mutations/useExitRoom';
import type { UseCreateRoomProps } from '@/hooks/mutations/useCreateRoom';
import type { UseJoinRoomProps } from '@/hooks/mutations/useJoinRoom';
import apiClient from './apiClient';
import type {
  CreateRoomResponse,
  DeleteRoomResponse,
  ExitRoomResponse,
  JoinRoomResponse,
  RoomInfosResponse,
} from '@/schemas/roomSchemas';

export const createRoomAPI = async ({
  roomName,
  hostNickName,
}: UseCreateRoomProps) => {
  const response = await apiClient.post<CreateRoomResponse>(`/rooms`, {
    name: roomName,
    host_nickname: hostNickName,
  });
  return response.data;
};

export const joinRoomAPI = async ({ roomCode, nickName }: UseJoinRoomProps) => {
  const response = await apiClient.post<JoinRoomResponse>(`/rooms/join`, {
    room_code: roomCode,
    nickname: nickName,
  });
  return response.data;
};

export const exitRoomAPI = async ({ roomCode }: UseExitRoomProps) => {
  const response = await apiClient.post<ExitRoomResponse>(
    `/rooms/leave`,
    null,
    {
      params: { room_code: roomCode },
    },
  );
  return response.data;
};

export const deleteRoomAPI = async ({ roomCode }: UseExitRoomProps) => {
  const response = await apiClient.delete<DeleteRoomResponse>(
    `/rooms/${roomCode}`,
  );
  return response.data;
};

export const fetchRoomInfosAPI = async (roomCode: string) => {
  const response = await apiClient.get<RoomInfosResponse>(`/rooms/${roomCode}`);
  return response.data;
};
